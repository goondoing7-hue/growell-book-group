# 가입 승인 요청 Gmail 알림

사용자가 지정한 **goondoing7@gmail.com** 계정으로 발신하고 같은 주소로 승인 요청을 받는다. 별도 도메인이나 Resend 계정은 필요 없다. Gmail 앱 비밀번호는 사용자가 Supabase **Edge Function Secrets**에 직접 입력한다. 이 문서와 테스트만으로 실제 발송·수신이 확인된 것은 아니다.

2026-09-28 운영 적용: 임시 데이터 ROLLBACK 검증 통과 후 SQL을 COMMIT했고, 발송 함수를 배포했다. 실제 `verify` 응답 200과 `connectionVerified:true`, 고정 테스트 메일의 Gmail `INBOX` 도착을 확인했으며 분당 예약 실행을 활성화했다. 실제 회원을 시험용으로 가입·승인하거나 기존 신청을 소급 생성하지 않았다.

## 필요한 설정

| 위치 | 이름 | 설정 |
| --- | --- | --- |
| Supabase Edge Function Secrets | `GROWELL_GMAIL_APP_PASSWORD` | 해당 Gmail 계정에서 생성한 16자리 앱 비밀번호. 표시용 공백은 제거한다. 일반 로그인 비밀번호가 아니다. |
| Supabase 기본 제공 환경 | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | 기본 제공 값을 사용하며 새 값으로 덮어쓰지 않는다. |
| Supabase Vault | `growell_signup_notification_worker_secret` | 마이그레이션이 내부에서 임의 값을 생성한다. 이미 있으면 유지한다. 직접 읽거나 채팅·도구 입력으로 옮기지 않는다. |

`GROWELL_NOTIFICATION_WORKER_SECRET`, `GROWELL_SIGNUP_FROM`, `RESEND_API_KEY`는 이 워커에 필요 없다. SMTP 설정은 `smtp.gmail.com:465`, 즉시 TLS, 인증서 검증 사용으로 고정했다. SMTP 라이브러리는 Supabase 공식 예제의 Nodemailer 9 계열에서 검토한 `npm:nodemailer@9.0.1`로 고정했다. 라이브러리를 올릴 때 오류 단계 분류도 다시 확인한다.

앱 비밀번호 생성에는 Google 2단계 인증이 필요하며 계정 정책에 따라 사용할 수 없을 수 있다. 일반 Google 비밀번호를 바꾸면 앱 비밀번호가 취소될 수 있으므로 새 앱 비밀번호를 서버에서 갱신한다. 비밀번호, 내부 워커 토큰, 서비스 키를 저장소·정적 배포 파일·브라우저 저장소·SQL 결과·로그에 넣지 않는다.

## 알림 내용과 인증

- 제목: `[GROWELL] 새 가입 승인 요청`
- 가입자 이름, 로그인 아이디, 한국 시간의 신청 시각
- 가입 신청 확인: `https://growell-book.vercel.app/#/admin/users`
- 관리자 로그인 후 직접 승인한다. 링크를 열거나 미리 본다고 승인되지 않는다.

비밀번호·힌트·사진·개인 기록은 메일에 포함하지 않는다. 요청에서 주소·SMTP 서버·제목·본문을 받지 않는다. 발신자와 SMTP envelope 수신자 모두 서버에 고정했다.

워커는 `verify_jwt=false`로 배포하지만 공개 호출을 허용하지 않는다. `x-growell-worker-secret` 길이를 먼저 검사하고, 내장 서비스 키로 **서비스 역할만 호출할 수 있는** `growell_authorize_signup_notification_worker` RPC를 실행한다. 이 RPC는 Vault 내부 값과 입력의 SHA-256 해시를 비교하여 boolean만 반환한다. 불일치는 401, 인증 DB 장애는 503이며 SMTP나 대기열 claim을 하지 않는다. Cron은 같은 Vault 값을 서버 내부에서 헤더로 넣으므로 운영자가 토큰을 복사할 필요가 없다.

## 대기열과 중복 방지

1. 기존 가입 흐름의 `growell_finalize_signup`은 필수 힌트와 알림 한 건을 같은 DB 트랜잭션에 저장한다. 같은 신청 재확정은 기존 정보를 덮어쓰거나 알림을 중복 생성하지 않는다. 가입 실패로 신규 프로필을 삭제하면 알림도 FK로 삭제한다.
2. 새 알림은 2분 뒤부터 처리한다. 워커는 1분 간격으로 최대 1건씩 처리한다. 밀린 신청이 없다면 접수 후 약 2~3분 뒤 SMTP를 시도한다. 이미 승인·거절·탈퇴 처리된 신청은 claim 전에 취소한다. claim 직후 승인한 경우 이미 진행 중인 한 건이 도착할 수 있다.
3. 첫 claim에서 `provider=gmail_smtp`, 발신자·수신자와 최초 시각을 기록한다. 이후에도 같은 스냅샷을 사용하며 다른 전송 경로로 자동 변경하지 않는다. 앱 비밀번호가 없거나 형식이 잘못되면 `notification_not_configured`만 반환하고 큐를 가져가지 않는다.
4. **SMTP에는 재전송 중복 방지 키가 없다.** DNS 실패, 실제 connect 시스템 호출 실패, DATA 이전 명령에서 명확한 4xx 응답을 받은 경우만 재시도한다. 재시도는 간격을 늘리며 최대 10회·최초 23시간으로 제한한다. 이 시간은 운영 제한이며 SMTP 중복 방지 유효기간이 아니다.
5. 일반 연결 끊김·시간 초과, DATA 이후 불명확한 결과, SMTP 응답은 받았으나 DB 결과 저장에 실패한 경우는 자동 재전송하지 않는다. 특히 Nodemailer의 `command=CONN` 오류도 DATA 이후 발생할 수 있으므로 안전한 재시도로 간주하지 않는다. `sending` 임대가 만료되면 `review / smtp_delivery_uncertain`로 이동한다. SQL도 명확한 `smtp_before_data_temporary` 이외 오류는 `retryable=true`가 와도 재시도를 차단한다.
6. `sent`는 고정 수신자와 최종 SMTP 250 응답을 확인한 상태다. 받은편지함 도착·휴대폰 알림까지 확인한 상태는 아니다. `Message-ID`는 Gmail 검색·수동 확인용이며 중복 방지 보장은 아니다.

## 기존 설치 업그레이드

기존 Resend용 SQL이 설치되어 있으므로 아래 순서를 지킨다. 회원 정보·힌트·승인 상태는 유지하며 기존 신청을 소급 생성하지 않는다.

1. 기존 알림 Cron이 있다면 중단한다. Gmail 마이그레이션은 `provider` 열과 인증 RPC, `growell_claim_signup_notification_v2`를 추가한다. 기존 claim RPC는 업그레이드 필요 오류만 내도록 교체하여 옛 워커의 오발송을 막는다.
2. `signup-notifications.sql`의 마지막 `COMMIT`을 빼고 `signup-notifications-verification.sql`을 이어 실행한다. 임시 프로필 하나로 원자적 가입 확정, 권한, Vault 인증, 고정 주소, 제공자 스냅샷, 정상 완료, 안전한 재시도, 만료된 SMTP 임대·불명확한 결과의 재발송 차단, 승인 후 취소·보상 삭제를 확인하고 **ROLLBACK**한다. 검증 과정은 외부 메일을 보내지 않고 토큰을 출력하지 않는다.
3. 통과 후 원본 마이그레이션을 COMMIT한다. 여러 번 적용해도 내부 토큰을 다시 만들거나 기존 Gmail 시도를 초기화하지 않는다. 예전 `attempts>0` 행은 `legacy_resend`로 표시한다. 그중 `pending/sending`은 발송 여부를 추정할 수 없으므로 `provider_migration_review`로 보관한다. 이미 `sent/cancelled`인 상태는 유지한다.
4. `signup-notification-worker.ts`를 동일 이름의 Supabase Edge Function으로 배포한다. 앱 비밀번호는 사용자가 Secrets 화면에서 직접 저장한다. 기존 `signup` 함수는 다시 바꿀 필요가 없다.
5. 아래 `verify` 호출로 TLS·인증을 확인한다. 이후 같은 방식으로 `action`만 `test`로 바꾸어 고정된 자기 자신에게 연결 테스트 메일 한 건을 보낼 수 있다. `test`는 명시적으로 한 번만 실행하고 불명확한 응답을 자동 재시도하지 않는다. 테스트 발송은 실제 가입·승인 처리나 큐 생성 없이 진행된다.
6. 수신을 확인한 뒤 `signup-notifications-schedule.sql`로 분당 작업을 등록·재개한다. 사용자는 Gmail 앱에서 해당 계정 알림을 켠다. 카카오톡 직접 알림 기능은 아니다.

다음은 DB 소유자가 실행하는 연결 확인 예시다. 토큰은 DB 안에서만 사용하고 결과로 반환하지 않는다. `pg_net` 확장이 필요하다.

```sql
select net.http_post(
  url:='https://oxaeecawijnetwmvggjs.supabase.co/functions/v1/signup-notification-worker',
  headers:=jsonb_build_object('Content-Type','application/json',
    'x-growell-worker-secret',(select decrypted_secret from vault.decrypted_secrets
      where name='growell_signup_notification_worker_secret')),
  body:='{"action":"verify"}'::jsonb,
  timeout_milliseconds:=45000
);
```

`verify`는 `{ok:true,connectionVerified:true}`, `test`의 SMTP 접수 성공은 `{ok:true,accepted:true}`를 반환한다. 두 모드 모두 회원 알림 큐를 처리하지 않는다. 기본 `{}` 또는 `{"action":"process"}`는 정상 대기열 처리이므로 테스트 대신 무심코 실행하지 않는다. 응답에는 제공자 원문·비밀번호·토큰이 포함되지 않는다.

## 운영 확인

- `pending`: 대기 또는 안전한 재시도, `sending`: 2분 임대, `sent`: SMTP 접수, `cancelled`: 이미 처리된 가입, `review`: 운영 확인 필요.
- `review`는 Gmail의 받은편지함·보낸편지함에서 해당 신청과 `rfc822msgid:growell-signup-v1-알림UUID@gmail.com`을 확인한다. 전송 여부가 불명확하면 다시 보내지 않는다. 임의로 `pending`으로 돌리거나 새 UUID를 생성해 우회하지 않는다.
- `smtp_auth_failed`는 앱 비밀번호·계정 설정을, `smtp_rejected`는 Gmail 제한을 확인한다. 큐의 오류에는 민감한 원문 대신 고정 코드만 저장한다.
- 알림을 멈추려면 Cron만 중단한다. 큐·회원·개인 기록을 삭제하지 않는다. 메일 장애로 정상 접수된 가입을 삭제하거나 자동 승인하지 않는다.

공식 자료: [Supabase SMTP 예제](https://github.com/supabase/supabase/blob/master/examples/edge-functions/supabase/functions/send-email-smtp/index.ts), [Nodemailer SMTP 설정](https://nodemailer.com/smtp), [오류 구조](https://nodemailer.com/errors), [Google 앱 비밀번호](https://support.google.com/mail/answer/185833?hl=ko), [Supabase Vault](https://supabase.com/docs/guides/database/vault), [Supabase 예약 함수](https://supabase.com/docs/guides/functions/schedule-functions).
