# GROWELL 습관 자동 알림 연결

이 기능은 **GROWELL → Microsoft To Do → 기기의 리마인더**로 습관을 전달한다. 웹 공유창을 열지 않는다. 회원이 Microsoft 계정을 연결하고 동의한 이후에 만든 습관만 자동으로 등록한다. 기존 습관은 화면의 명시적인 추가 동작으로 가져온다.

구현 코드와 운영 설정은 별개다. 아래의 Microsoft 앱, 서버 비밀값, SQL 마이그레이션, 주기 실행 설정을 모두 마치고 실제 계정으로 검증하기 전에는 운영 연동을 완료했다고 안내하지 않는다. 필수 환경변수가 없으면 공개 설정 API는 `{ "configured": false }`만 반환하며 연결 버튼을 활성화하지 않는다. 마이그레이션을 배포하는 것만으로 기존 습관이 외부로 전송되지는 않는다.

## 1. Microsoft 앱 등록

Microsoft Entra 앱 등록에서 개인 Microsoft 계정과 조직 계정을 함께 허용하는 앱을 사용한다. 플랫폼은 **Web**이며 운영 리디렉션 URI는 다음 한 개다.

```
https://growell-book.vercel.app/api/habit-sync
```

개인 Microsoft 계정을 지원하기 위해 등록할 리디렉션 URI에는 쿼리 문자열을 붙이지 않는다. Microsoft가 추가한 `state`와 `code` 또는 `error`를 서버가 콜백 요청으로 처리한다.

위임 권한 `Tasks.ReadWrite`, `offline_access`, `openid`를 사용한다. `Tasks.ReadWrite`의 애플리케이션 권한으로는 To Do에 접근할 수 없으며 각 회원의 동의가 필요하다. 조직 계정은 관리자의 동의 정책에 따라 승인이 필요할 수 있다. `User.Read` 및 사용자 프로필 조회 권한은 요청하지 않는다. `openid`로 받은 ID 토큰의 서명·발급자·대상·만료·nonce를 검증하여 계정 구분용 해시만 저장한다.

클라이언트 비밀값을 만들고 만료일을 운영 일정에 기록한다. 비밀값은 저장소, 프런트엔드, 문서, 채팅, 로그에 붙여넣지 않고 Vercel 환경변수에 직접 저장한다.

## 2. 서버 환경변수

| 이름 | 용도 |
| --- | --- |
| `GROWELL_MS_CLIENT_ID` | Microsoft 앱의 Application (client) ID |
| `GROWELL_MS_CLIENT_SECRET` | 서버 전용 Microsoft 클라이언트 비밀값 |
| `GROWELL_SYNC_KEY` | 무작위 32바이트를 Base64로 인코딩한 AES-GCM 키 |
| `SUPABASE_SERVICE_ROLE_KEY` | GROWELL 프로젝트의 서버 전용 service-role 키 |
| `CRON_SECRET` | 주기 실행 요청 인증용 충분히 긴 무작위 비밀값 |
| `GROWELL_SUPABASE_URL` | 선택 사항. 기본값은 기존 `oxaeecawijnetwmvggjs` Supabase 프로젝트 |
| `GROWELL_SYNC_ORIGIN` | 선택 사항. 기본값 `https://growell-book.vercel.app`; 고정 HTTPS origin |

키 생성에는 암호학적 난수 발생기를 사용한다. 암호화 키를 교체할 경우 기존 연결을 일괄로 복호화·재암호화하는 별도 유지보수 절차가 없으므로 회원의 재연결이 필요하다. 다른 프로젝트의 service-role 키를 사용하지 않는다. 개발/미리보기 배포에서는 별도 테스트 Microsoft 앱과 별도 테스트 데이터베이스를 사용하며 운영 키를 복제하지 않는다.

## 3. 데이터베이스

기존 회원 승인 및 습관 종류 마이그레이션이 적용된 GROWELL 데이터베이스의 소유자 권한으로 `server/habit-sync.sql`을 실행한다. 원본 `profiles.id`, `habits.id`, `habits.user_id`는 text이며 `profiles.auth_user_id`는 UUID여야 한다. 잘못된 스키마는 실행 초기에 중단한다.

추가되는 세 테이블에는 RLS를 적용하고 `anon`, `authenticated`, `public`의 접근을 철회한다. 브라우저가 직접 RPC를 호출할 수 없다. 암호화된 refresh token과 OAuth PKCE 상태, 사용자별 목록/작업 대응표, 전송 대기열을 서버 권한으로만 읽는다.

- 습관의 이름·목표·장소·시간·기간 등 메타데이터가 바뀌면 같은 데이터베이스 트랜잭션에서 대기열을 갱신한다.
- 성공 날짜 변경만으로는 대기열을 생성하지 않는다.
- 신규 습관 자동 전송은 연결 시점 이후에 생성된 행만 대상으로 한다. 기존 습관은 명시적으로 가져온 경우만 추적한다.
- 일시 중지 중에는 외부 호출이 없다. 이미 연결한 습관의 변경은 대기열에 보관하고, 중지 중에 새로 만든 습관을 재개 시 일괄 전송하지 않는다.
- 회원의 승인 취소, 탈퇴 처리(`is_deleted=true`), Auth 사용자 교체 시 연결 비밀값·대기열·OAuth 상태를 제거한다. Microsoft에 이미 저장한 알림은 남는다.

로컬 PostgreSQL 호환 테스트는 `tests/habit-sync-sql.test.cjs`, API/Graph 모의 테스트는 `tests/habit-sync-server.test.cjs`다. 테스트에는 합성 회원 및 합성 습관만 사용한다. 운영 데이터로 회귀 테스트를 실행하지 않는다.

## 4. 브라우저가 닫혀 있어도 처리하기

다음 URL을 최소 1분 간격으로 호출하는 서버 스케줄러가 필요하다.

```
GET https://growell-book.vercel.app/api/habit-sync?action=worker
Authorization: Bearer <CRON_SECRET>
```

Supabase Vault에 Vercel의 `CRON_SECRET`과 같은 값을 `growell_habit_sync_worker_secret`이라는 이름으로 저장한 뒤 `server/habit-sync-schedule.sql`을 실행한다. 이 파일은 기존에 사용하던 다른 작업을 변경하지 않고 `growell-habit-sync` 작업 하나만 매분 실행한다. 중지할 때는 `select cron.unschedule('growell-habit-sync');`를 실행한다. 또는 인증 헤더를 안전하게 보관할 수 있는 운영 스케줄러를 사용한다. 스케줄을 만들지 않으면 로그인한 브라우저가 습관 저장 뒤 호출하는 `run`만 동작하므로, 자동 재시도와 닫힌 브라우저에서의 처리를 보장할 수 없다. Cron 비밀값을 URL 쿼리나 공개 SQL에 넣지 않는다. [Supabase 공식 스케줄링 안내](https://supabase.com/docs/guides/functions/schedule-functions)

Vercel 함수 실행 시간은 최소 60초로 설정한다. 작업자는 한 번에 한 회원을 90초간 임대하고 최대 45초 범위에서 최대 세 건을 처리한다. 다음 회원은 마지막 시도 시각 순으로 선택하여 한 연결의 오류가 다른 회원을 계속 막지 않게 한다. 규모가 커지면 호출 빈도와 작업자 수를 늘리되 사용자별 임대 및 세대 검증을 유지한다.

## 5. 기기에서 한 번만 설정

**삼성 갤럭시:** 삼성 리마인더 설정에서 Microsoft To Do 동기화를 켜고 GROWELL에 연결한 것과 같은 Microsoft 계정으로 로그인한다. 동기화할 To Do 목록에서 `GROWELL`을 선택한다. 삼성은 선택한 한 목록을 동기화하므로 목록 선택을 확인해야 한다.

**iPhone:** 설정 → 앱 → 미리 알림 → 미리 알림 계정에서 같은 Outlook.com 또는 Exchange 계정을 추가하고 미리 알림을 켠다. 기기/iOS 버전에 따라 메뉴명이 다를 수 있다. GROWELL 목록은 Microsoft 계정에 속하며 iCloud 목록이 아니다. 조직의 기기/Exchange 정책에 따라 제한될 수 있다. Mac 연동은 이 기능의 검증 범위에 포함하지 않는다.

각 앱의 알림 권한, 집중 모드, 배터리/동기화 설정에 따라 실제 표시 시점이 달라질 수 있다. 반복 작업이 다음 회차로 넘어가는 방식은 각 앱에 따른다. 미완료 상태에서도 정해진 시각에 반드시 매일 새 알림이 울린다고 보장하지 않는다.

## 6. 동작과 보존 원칙

- 습관 생성·수정·삭제를 **GROWELL에서 Microsoft로 한 방향** 전달한다. 어느 앱의 완료 체크도 다른 앱에 반영하지 않는다.
- 습관 이름·목표·장소·알림 시간·기간만 전달한다. 암호화된 독서 기록이나 메모, 회원 ID, 습관 ID, 비밀번호, 체크 날짜는 보내지 않는다. 복구용 무작위 식별자는 `com.growell.habitSync` open extension에 보관하며 본문에는 습관 종류·목표·장소·알림만 남긴다. 기존 항목은 숨겨진 식별자 저장·조회 확인 후 본문과 해당 GROWELL linkedResource만 정리한다. 기존 항목을 재처리할 때는 동일 계정·generation의 활성 기간 tracked queue만 재대기시키고 task_id·marker·desired를 보존한다. 미연동 습관을 일괄 추가하지 않는다.
- 장소 이름은 본문에 반영된다. Graph To Do에는 위치 알림 속성이 없으므로 삼성·아이폰 앱의 별도 장소 알림은 자동 설정하지 않는다.
- 알림 시각은 각 습관의 `time`만 사용한다. 새 습관·수정 화면의 빈 시간 칸을 누르면 바로 아래에 펼쳐지는 `00:00`부터 `23:50`까지 10분 간격의 세로 목록으로 고른다. 기존의 명확한 `HH:mm`, `오전/오후 N시 [M분]`은 그대로 해석하며 저장된 시간을 임의로 반올림하지 않는다. 한국 시간(`Asia/Seoul` / Graph `Korea Standard Time`) 기준이다.
- 시간이 없거나 `잠들기 전` 등 정확하지 않은 문장은 기본 시각으로 대체하지 않는다. 항목은 목록에 남기되 알림·반복·마감·시작 일시를 해제하고 본문에 시간 미설정을 표시한다. 그 습관에서 시간을 선택하면 같은 항목에 알림을 설정한다. DB의 `default_time`은 이전 버전과의 호환을 위해 남지만 알림 계산이나 새 API 요청에는 사용하지 않는다.
- 본인 소유이고 공유되지 않은 `GROWELL` 목록만 사용한다. 기존에 저장해 둔 목록 ID도 매 실행 및 작업 변경 전에 소유·공유 상태를 확인한다. 공유된 목록이나 소유 여부가 확인되지 않는 목록은 `list-not-private`로 중단하여 습관 내용이 다른 구성원에게 전달되지 않게 한다. 동명의 목록이 여러 개면 자동으로 고르지 않고 `list-ambiguous`로 중단한다.
- 외부 작업 삭제 전에는 저장한 작업 ID와 무작위 연결 표시를 모두 확인한다. 목록 조회 실패·빈 결과만으로 작업을 삭제하지 않는다. 이동/수정되어 표시가 사라진 작업도 임의로 지우지 않는다.
- 계정 연결을 해제하면 로컬 비밀값과 대기열만 제거하며 이미 등록된 Microsoft 알림은 남긴다. 새 Microsoft 계정으로 재연결할 때 이전 계정의 작업 ID를 재사용하지 않는다.
- 연결 해제/계정 변경은 실행 중인 작업자가 있으면 `sync-busy`로 응답한다. 실행이 끝난 뒤 재시도한다. 회원 탈퇴 중 이미 Microsoft가 수락한 외부 요청은 취소할 수 없지만 이후 작업은 차단된다.

## 7. 재시도·중복 방지와 운영 점검

Graph POST 전에 대기열에 전송 중 표시를 영구 저장한다. 응답을 받지 못하면 다음 실행은 연결 표시가 같은 기존 작업을 찾아 ID를 복원하며 무조건 POST를 반복하지 않는다. 전체 페이지를 끝까지 조회하지 못한 결과는 확정된 빈 결과로 취급하지 않는다. 시간 초과·429·5xx는 지수 지연 및 `Retry-After`에 따라 재시도한다.

`task-create-uncertain` 또는 `list-create-uncertain`은 수락 여부를 확인할 수 없는 요청이다. 목록에서 표시를 찾아 복구할 수 없으면 계속 조회만 하며 중복 생성 위험을 감수해 다시 만들지 않는다. 자동으로 해결된 것처럼 안내하지 않는다. 운영자가 Microsoft 측 상태를 확인한 뒤 안전한 재시도 여부를 결정해야 한다. `task-ambiguous`는 같은 표시가 여러 활성 작업에 존재하는 상태다. 자동 삭제/선택 없이 검토한다.

`reconnect-required`이면 동기화를 일시 중지하고 재연결을 안내한다. `remote-missing`은 Microsoft에서 작업/목록을 이동하거나 삭제한 경우일 수 있다. 회원의 외부 삭제를 무조건 복원하지 않는다. 수동 복구 시 무작위 표시·계정·목록 대응을 확인하며 기존 작업을 일괄 삭제하지 않는다.

`list-not-private`이면 Microsoft To Do에서 GROWELL 목록의 공유 상태와 소유자를 확인한다. 코드가 임의로 공유를 해제하거나 다른 구성원을 제거하지는 않는다. 회원이 개인 목록으로 설정한 후 재시도한다.

운영 확인 순서:

1. `config`가 준비 상태를 반환하는지, 비로그인/승인 대기 회원의 다른 API가 차단되는지 확인한다.
2. 합성 테스트 회원으로 OAuth 연결하고 서버/응답에 비밀값이 노출되지 않는지 확인한다.
3. 기존 습관은 자동 등록되지 않고 새 습관만 `GROWELL` 목록에 생기는지 확인한다.
4. 수정, 삭제, 반복·시간·목표일, 일시 중지·재개, 명시적 기존 습관 추가를 확인한다.
5. 브라우저를 닫고 스케줄러로 대기열과 재시도가 처리되는지 확인한다.
6. 삼성 리마인더와 iPhone 미리 알림에서 실제 수신, 시간 표시, 반복 완료 후 다음 회차를 각각 검증한다.
7. 연결 해제와 테스트 회원 탈퇴 후 암호화된 연결 정보가 제거되고 후속 전송이 중단되는지 확인한다.

## API 계약

모든 응답은 `Cache-Control: no-store`다. 회원용 요청에는 실제 Supabase access token을 `Authorization: Bearer …`로 전달한다. 서버는 Auth 사용자와 승인된 프로필의 연결을 직접 확인하며 클라이언트의 owner ID를 사용하지 않는다. 회원용 POST는 고정 운영 origin과 JSON을 요구한다.

| 요청 | 본문/응답 |
| --- | --- |
| `GET ?action=config` | 공개 `{configured}` |
| `GET ?action=status` | `{configured,connected,enabled,timeZone,listName,pendingCount,lastSyncedAt,errorCode}` |
| `POST ?action=connect` | `{}` → `{url}`; PKCE 상태 쿠키 설정 |
| `GET /api/habit-sync?state=…&code=…` | Microsoft 콜백. 일회용 상태와 브라우저 쿠키 검증 후 고정 앱 주소로 이동 |
| `POST ?action=settings` | `{enabled:true}` → 상태 |
| `POST ?action=import` | `{habitId?:"…"}` → `{queued}`; 생략 시 본인의 현재 습관만 명시적 가져오기 |
| `POST ?action=disconnect` | `{}` → 상태 |
| `POST ?action=run` | `{}` → `{processed}`; 본인 대기열만 |
| `GET ?action=worker` | Cron 비밀값 필요 → `{processed}` |

안전하게 공개할 수 있는 고정 오류 코드만 `{error:"…"}`로 전달한다. 공급자 응답 본문·토큰·이메일 주소를 오류에 포함하지 않는다. OAuth 성공/실패 후 이동은 `/?habit-sync=connected` 또는 `/?habit-sync=failed`와 고정 습관 화면 해시뿐이다.

## 공식 참고 자료

- [Microsoft Graph To Do 작업 생성 및 위임 권한](https://learn.microsoft.com/en-us/graph/api/todotasklist-post-tasks?view=graph-rest-1.0)
- [작업의 알림·반복 속성](https://learn.microsoft.com/en-us/graph/api/resources/todotask?view=graph-rest-1.0)
- [작업 원본의 linkedResource](https://learn.microsoft.com/en-us/graph/api/resources/linkedresource?view=graph-rest-1.0)
- [Samsung Reminder와 Microsoft To Do 동기화](https://support.microsoft.com/en-us/todo/sync-microsoft-to-do-with-the-samsung-reminder-app)
- [Apple 미리 알림 계정 추가](https://support.apple.com/en-ie/guide/iphone/iph8739025dd/ios)
- [Microsoft To Do와 Apple 미리 알림](https://support.microsoft.com/en-us/todo/using-apple-watch-with-microsoft-to-do)
