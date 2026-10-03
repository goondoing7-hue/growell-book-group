# 회원별 Google Drive 자동 백업

운영 앱은 `https://growell-book.vercel.app`, Supabase 프로젝트는 `oxaeecawijnetwmvggjs`입니다. 다른 앱의 Google 프로젝트나 인증정보를 사용하지 않습니다.

## 백업 내용과 동작

프로필 → **Google Drive 백업**에서 회원이 직접 자신의 Google 계정을 연결합니다. `GROWELL 백업` 폴더의 `GROWELL-backup.json`에 본인의 최신 전체 데이터를 저장합니다. 같은 계정을 다시 연결하면 기존 파일을 사용하고, 다른 Google 계정으로 연결하면 새 파일을 만듭니다. 파일은 회원의 My Drive 최상위에 만들며 공유하지 않습니다.

- `private_entries`: 암호문·IV·ID·생성/수정 시각. 이 안에 암호화된 개인 기록, 책장, 메모 및 아카이브 설정이 포함됩니다.
- `habits`: 이름·목표·장소·시간·요일·기간·독서 연결 정보와 전체 체크 날짜.
- `material_notes`, `posts`, `comments`, `worksheets`: 본인이 작성한 자료·글·댓글·활동지.
- `reading_logs`, `reading_meta`: 본인의 독서 시간·진도.
- 항목에 들어 있는 첨부 데이터와 URL은 보존합니다. URL로 연결된 외부 첨부파일 원본, 전역 영상 요약/자막 캐시, 저장 전 초안은 포함하지 않습니다.
- 비밀번호·힌트·인증 토큰·개인 기록 복구 키는 백업 파일에 포함하지 않습니다. 회원은 프로필 수정에서 **복구 파일을 별도로 보관**해야 합니다.

JSON 백업은 데이터 보관용입니다. 현재 앱에는 JSON 가져오기·자동 복원 기능이 없습니다. 복원이 필요하면 기존 ID 및 암호문을 보존하는 별도 검증 절차가 필요합니다. Drive에서 파일을 수정해도 GROWELL에는 반영되지 않습니다. GROWELL에서 항목을 삭제하면 최신 백업에서도 제외되므로, 별도로 남길 시점의 파일은 Drive에서 사본으로 보관합니다. 과거 버전의 영구 보존을 보장하지 않습니다.

변경은 같은 DB 트랜잭션에서 회원별 revision을 증가시킵니다. 예약 작업은 대기 중인 회원을 순서대로 처리합니다. 브라우저가 닫혀도 동작하며 자동 중지 중에도 변경 여부는 보존합니다. ‘지금 백업’은 자동 중지 상태에서도 한 번 실행할 수 있습니다. 작업 중 설정 변경/해제는 busy를 반환하여 진행 중 업로드 뒤 다시 시도하도록 합니다.

## Google Cloud 설정

1. GROWELL 전용 프로젝트에서 **Google Drive API**를 활성화합니다.
2. Google Auth Platform에서 앱 이름·지원 이메일·홈페이지(`https://growell-book.vercel.app`)·개인정보처리방침(`https://growell-book.vercel.app/privacy.html`)을 확인합니다.
3. 최소 범위는 `openid`, `email`, `https://www.googleapis.com/auth/drive.file`입니다. 전체 Drive 접근 범위는 요청하지 않습니다.
4. 웹 애플리케이션 OAuth 클라이언트를 만들고 승인된 리디렉션 URI에 정확히 `https://growell-book.vercel.app/api/drive-backup`을 등록합니다. 기존 Supabase 로그인 클라이언트를 수정하는 대신 백업 전용 클라이언트를 권장합니다.
5. Google Testing 모드에서는 테스트 사용자 제한과 refresh token 유효기간 제한이 적용될 수 있습니다. 모든 회원의 계속되는 백업을 운영하려면 외부 앱의 게시 상태와 필요한 검증을 마칩니다. 실제 콘솔 요구사항을 확인하며 완료 전 전체 회원 연결을 보장하지 않습니다.

인증코드+PKCE+일회용 state와 Secure/HttpOnly/SameSite 쿠키로 계정을 연결합니다. Google TLS userinfo에서 확인한 subject를 해시하여 연결 대상을 구분하고 검증된 이메일만 화면에 표시합니다. OAuth refresh token은 서버 AES-GCM으로 회원·연결 generation에 바인딩합니다.

## Vercel 환경변수

Production에 다음 두 값을 **Secret**으로 직접 저장합니다. 비밀값은 채팅·저장소·로그에 남기지 않습니다.

| 이름 | 값 |
| --- | --- |
| `GROWELL_GOOGLE_CLIENT_ID` | 백업 전용 웹 OAuth 클라이언트 ID |
| `GROWELL_GOOGLE_CLIENT_SECRET` | 해당 클라이언트의 비밀값 |

기존 `SUPABASE_SERVICE_ROLE_KEY`, `GROWELL_SYNC_KEY`, `CRON_SECRET`을 서버에서 사용합니다. 각각 기존 GROWELL 프로젝트에 속하는 값이어야 합니다. `GROWELL_SUPABASE_URL`, `GROWELL_SYNC_ORIGIN`은 기존 설정과 같습니다. 설정 후 재배포가 필요합니다. 개발 환경에는 운영 인증정보를 복제하지 않습니다.

## DB와 예약 실행

1. `server/drive-backup.sql`을 운영 DB 소유자 권한으로 적용합니다. 원본 업무/기록 데이터는 수정하지 않습니다. 백업 연결 테이블·일회용 OAuth 테이블·RPC·원본 8개 테이블의 변경 감지 트리거만 추가합니다. 모든 연결 테이블 및 외부 호출용 RPC는 service-role 전용입니다.
2. 배포 후 `/api/drive-backup?action=config`가 `{ "configured": true }`인지 확인합니다.
3. `server/drive-backup-schedule.sql`을 적용합니다. 기존 Vault의 `growell_habit_sync_worker_secret`을 사용해 별도 `growell-drive-backup` 작업을 매분 실행합니다. 기존 습관 알림 작업은 변경하지 않습니다.
4. 회원이 연결한 뒤 폴더 생성 및 마지막 백업 시각을 확인합니다. 테스트에는 합성 전용 회원을 쓰며 실제 회원 데이터를 수정하지 않습니다.

```sql
select jobname,schedule,active from cron.job where jobname='growell-drive-backup';
select count(*) as pending_members from public.growell_drive_backup_connections
where token_cipher is not null and (enabled or manual_requested) and dirty_revision>synced_revision;
```

백업 데이터나 연결 토큰을 상태 점검 로그에 출력하지 않습니다. 운영 비밀값 없이 공개 상태 확인에서 `configured:false`가 나오면 프로필에서는 준비 중으로 표시합니다.

## 실패와 보존

- 조회 실패·누락된 snapshot·다른 소유자·20MiB 초과는 업로드하지 않습니다. 데이터를 자르거나 빈 파일로 덮어쓰지 않습니다.
- 파일 ID를 네트워크 전송 전에 DB에 예약합니다. 생성 응답이 유실돼도 같은 ID를 조회·사용하여 중복 파일을 만들지 않습니다.
- 작업은 회원별 90초 lease와 generation으로 보호합니다. API는 45초 작업 예산/60초 함수 제한으로 실행하며 재시도는 DB에 보존합니다.
- 백업 폴더/파일이 공유되거나 이동·삭제·소유권 변경된 경우 전송을 멈춥니다. 휴지통에서 복원하거나 원래 비공개 폴더 위치로 돌린 뒤 다시 백업합니다. 기존 파일을 자동 삭제하거나 권한을 변경하지 않습니다.
- 연결 해제는 서버 토큰을 없애고 예약 백업을 멈춥니다. Google에 저장된 파일은 건드리지 않습니다. 회원 승인 취소/탈퇴/Auth 교체 때도 자격 증명을 제거합니다.
- 같은 회원의 연속 변경은 다음 revision으로 다시 처리합니다. 실패한 회원은 뒤로 물러나 다른 회원 처리를 막지 않습니다.

검증: `tests/drive-backup-{provider,server,sql,ui}.test.cjs`. 전체 빌드는 등록된 모든 테스트를 실행합니다.

공식 참고: [Drive 최소 권한](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [서버 OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [파일 업로드](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
