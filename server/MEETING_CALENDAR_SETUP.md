# 회원별 Google 캘린더 모임 일정 연결

운영 주소는 `https://growell-book.vercel.app`, Google Cloud 프로젝트는 `growell-book-group`, Supabase 프로젝트는 `oxaeecawijnetwmvggjs`입니다. 이 문서는 구현과 운영 준비 절차이며, 설정 적용이나 실제 회원 일정 등록을 완료했다는 확인 기록이 아닙니다.

## 회원과 운영자의 사용 흐름

회원은 홈의 **이번 모임 → 내 Google 캘린더 연결·관리** 또는 **프로필 → 모임 일정 · Google 캘린더**에서 자신의 계정을 연결합니다. Google Drive 백업과 캘린더 연결은 별도 동의이며, 다른 회원을 대신 연결하지 않습니다. 연결 후 자동 반영은 기본으로 켜지고, 자신의 기본 Google 캘린더(`primary`)에 일정이 등록됩니다.

운영자는 **이번 모임 → 수정**에서 날짜·시작 시간·종료 시간·모임 회차·장소·읽을 챕터·페이지 범위를 정해 저장합니다. 종료 시간은 같은 날의 시작 시간보다 늦어야 하며, 시간대는 `Asia/Seoul`입니다. 기존 자유 입력 날짜·시간은 보존합니다. 구조화된 세 값이 모두 없으면 일정은 전송하지 않으며, 일부만 입력하거나 유효하지 않으면 저장을 거부합니다. 날짜를 추정하거나 기존 값을 임의로 채우지 않습니다.

| Google 일정 항목 | GROWELL 원본 |
| --- | --- |
| 제목 | GROWELL 독서모임 · 모임 회차 |
| 시작·종료 | 선택한 날짜·시작 시간·종료 시간 |
| 장소 | 이번 모임의 장소 |
| 설명 | 읽을 책, 챕터·페이지 범위, 추가 모임 안내 |

같은 책·회차의 수정은 서버에서 유지하는 동일 일정 ID로 갱신합니다. 책 또는 회차가 바뀌면 새 일정으로 보존합니다. 다음 모임 안내를 입력할 때 회차도 갱신해야 이전 회차의 일정을 덮어쓰지 않습니다. 새 연결은 현재 모임만 등록하며, 연결 전에 지나간 모임 전체를 일괄 등록하지 않습니다.

예약 작업은 연결한 승인 회원을 순차적으로 처리합니다. 브라우저를 닫아도 반영되지만 즉시 반영 시간을 보장하지 않습니다. 회원의 **지금 반영**은 자동 반영을 끈 상태에서도 한 번 실행할 수 있습니다. 연결 상태·계정·최근 반영 시각·대기 또는 오류 상태는 연결 팝업에서 확인합니다.

## Google Cloud 준비

1. GROWELL 전용 프로젝트에서 **Google Calendar API**를 활성화합니다.
2. 기존 Drive 백업용 웹 OAuth 클라이언트에 아래 승인된 리디렉션 URI를 **추가**합니다. 기존 Drive 콜백 URI와 로그인용 URI를 삭제하거나 대체하지 않습니다.

   `https://growell-book.vercel.app/api/meeting-calendar`

3. 동의 화면에 `openid`, `email`, `https://www.googleapis.com/auth/calendar.events.owned` 범위를 준비합니다. 기존 `drive.file` 범위도 유지합니다. 캘린더 연결 요청은 캘린더 범위만 요청하고, Drive 백업의 토큰은 갱신하거나 교체하지 않습니다.
4. `calendar.events.owned`는 회원이 소유한 캘린더의 일정 접근 권한입니다. 앱은 기본 캘린더에 GROWELL 표식을 가진 모임 일정만 생성·갱신하며, 기존 다른 일정이나 개인 기록을 전송하지 않습니다. Google이 표시하는 권한 설명과 앱의 실제 동작 제한을 구분합니다.
5. 외부 앱의 게시 상태와 필요한 검증을 확인합니다. Testing 상태의 테스트 사용자 제한이나 refresh token 만료가 적용되면 전체 회원의 지속 연결을 보장할 수 없습니다. 회원은 최초 연결 때 직접 계정을 선택하고 동의하며, 권한 만료·취소 시 재연결합니다.

## 서버 환경변수와 배포

기존 Drive 연결의 아래 환경변수를 재사용합니다. 별도 키를 만들거나 비밀값을 브라우저·저장소·채팅·로그에 복사하지 않습니다.

| 이름 | 용도 |
| --- | --- |
| `GROWELL_GOOGLE_CLIENT_ID` | 위 웹 OAuth 클라이언트 |
| `GROWELL_GOOGLE_CLIENT_SECRET` | 해당 클라이언트의 서버 전용 비밀값 |
| `SUPABASE_SERVICE_ROLE_KEY` | 지정 Supabase 프로젝트의 서버 전용 권한 |
| `GROWELL_SYNC_KEY` | 기존 32바이트 AES-GCM 키의 base64 값 |
| `CRON_SECRET` | 예약 API 호출 인증 |
| `GROWELL_SUPABASE_URL` | 기존 프로젝트 URL, 미설정 시 지정 운영 프로젝트 |
| `GROWELL_SYNC_ORIGIN` | 기존 운영 출처, 미설정 시 지정 운영 주소 |

`api/meeting-calendar.js`는 `meetingCalendarDomain.cjs`, `meetingCalendarProvider.cjs`, `meetingCalendarService.cjs`를 사용합니다. Vercel 함수에는 필요한 서버 파일이 포함되어야 하며, 실행 제한은 60초입니다. 환경변수를 변경했다면 재배포가 필요합니다.

인증코드와 PKCE, 한 번만 소비하는 서버 OAuth 상태, Secure/HttpOnly/SameSite 쿠키를 검증합니다. Google에서 확인한 계정 subject의 해시를 연결 식별자로 사용합니다. refresh token은 회원·연결 generation에 묶어 서버에서 암호화합니다. 상태 응답에는 비밀값이나 원본 토큰을 넣지 않습니다.

## DB와 예약 작업 적용

1. 별도의 임시 DB에서 먼저 `server/meeting-calendar.sql`을 검증합니다. 운영 DB 소유자 권한으로 적용하면 기존 `announcement`에 선택 항목 네 개를 추가하고, 연결·OAuth 상태·일정 이력·전송 작업 테이블과 서비스 전용 RPC·트리거를 추가합니다. 기존 날짜·시간·회원 글·습관·자료·통찰·모임 기록을 수정하거나 초기화하지 않습니다.
2. 해당 소스가 포함된 배포를 완료합니다. `/api/meeting-calendar?action=config`의 `configured:true`는 환경변수 검증 결과입니다. DB 스키마, Google 동의 설정, 실제 일정 등록 완료까지 확인했다는 뜻은 아닙니다.
3. `server/meeting-calendar-schedule.sql`을 적용합니다. 기존 Vault의 `growell_habit_sync_worker_secret`을 사용하여 별도 **growell-meeting-calendar** 작업을 매분 실행합니다. 이 값은 Vercel의 `CRON_SECRET`과 같아야 합니다. 기존 습관·Drive 예약 작업을 수정하지 않습니다.
4. 연결 상태에서 승인 회원 자신의 일정 등록을 확인합니다. 운영 원본을 테스트 목적으로 수정하지 않습니다. 새 모임 날짜·시간 등록은 운영자가 실제 안내를 저장할 때 진행하고, 기능 테스트는 합성 회원·임시 DB·가짜 Google 응답으로 수행합니다.

읽기 전용 운영 점검 예시:

```sql
select jobname, schedule, active
from cron.job where jobname = 'growell-meeting-calendar';

select count(*) as connected_members
from public.growell_meeting_calendar_connections
where token_cipher is not null;

select count(*) as pending_deliveries
from public.growell_meeting_calendar_jobs j
join public.growell_meeting_calendar_connections c
  on c.owner_id = j.owner_id and c.generation = j.generation
where c.token_cipher is not null and (c.enabled or c.manual_requested)
  and j.revision > j.synced_revision;
```

집계만 확인하며 회원 이메일·암호화 토큰·일정 본문을 로그로 출력하지 않습니다.

## 보존과 실패 처리

- 연결 테이블과 외부 전송 RPC는 service-role만 접근합니다. 모든 요청·작업은 정확한 인증 사용자와 승인 프로필의 연결을 확인합니다.
- 모임 안내와 전송 작업은 같은 DB 트랜잭션에서 캡처합니다. 전송 실패는 안내 저장이나 회원 기록을 되돌리거나 삭제하는 방식으로 처리하지 않습니다.
- 회원·Google 계정·서버 일정 ID를 바탕으로 안정된 Google 이벤트 ID를 만듭니다. 생성 응답이 유실된 뒤 재시도해도 같은 이벤트를 확인합니다. 새 OAuth generation은 같은 Google 계정의 기존 전송 이력을 이어받습니다.
- 갱신 전 Google 이벤트의 앱·소유 표식을 확인하며 ETag로 동시 변경을 보호합니다. GROWELL이 관리하는 제목·장소·설명·시간만 갱신하고 회원이 정한 알림·색 등은 유지합니다. Google에서 변경한 내용은 GROWELL로 역동기화하지 않습니다.
- Google에서 삭제한 것으로 확인된 기존 일정은 자동으로 재생성하지 않습니다. 소유 표식이 일치하지 않거나 전송 내용이 유효하지 않으면 중지하고 상태를 안내합니다. 실패한 조회를 GROWELL 원본 삭제의 근거로 사용하지 않습니다.
- 작업은 90초 lease, 연결 generation, 전송 revision으로 보호합니다. 일시 오류는 저장된 대기 작업을 재시도하고, 권한 만료는 재연결을 안내합니다. 여러 회원의 전송은 순차적으로 처리하며 실패한 회원이 전체 처리를 막지 않습니다.
- 자동 반영 중지는 앞으로의 예약 실행을 멈춥니다. 연결 해제·승인 취소·계정 교체 때 캘린더 인증정보를 제거하지만 기존 Google 일정과 GROWELL 원본 기록은 삭제하지 않습니다. 다른 Google 계정으로 바꾸면 그 계정에 현재 모임을 등록합니다.

## 실제 확인 목록

- 승인 회원만 자신의 연결 상태를 보고 연결할 수 있는지 확인합니다.
- 최초 동의 후 자신의 기본 캘린더에 날짜·시작/종료 시간·장소·읽을 범위가 맞는지 확인합니다.
- 실제 운영자가 같은 회차를 수정했을 때 같은 이벤트가 갱신되고, 새 회차는 별도 이벤트가 되는지 확인합니다.
- 자동 중지·지금 반영·재연결·해제와 오류 상태를 확인합니다. 연결 해제 확인용으로 실제 회원 연결을 임의 해제하지 않습니다.
- 테스트 통과나 공개 설정 응답만으로 전체 회원의 Google 동의·일정 반영 완료를 선언하지 않습니다.

모바일·PC 사용법은 `guide.html`의 홈과 나눔 안내에서 함께 관리하며, 수정 후 `npm.cmd run guides`로 `guide-pc.html`을 재생성합니다.
