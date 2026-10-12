# 모임 기록 PDF 이메일

기존 통합 Google 연결 뒤 운영자가 공개한 모임 기록을 연결된 Google 이메일로 보낸다. Google Drive·Calendar 권한을 재사용해 수신 계정을 검증하며, Gmail 읽기·발송 권한은 회원에게 요청하지 않는다. 발신은 기존 Supabase의 운영자 Gmail SMTP 설정을 사용한다.

1. `meeting-mail.sql`의 서비스 전용 테이블·RPC·공개 전환 감지 기능을 추가한다. 기존 작성 내용과 연결을 변경하지 않는다.
2. Vercel API `/api/meeting-record-mail?action=pdf`와 서버 글꼴을 배포한다. 공개 웹 빌드에는 글꼴·서버 파일을 포함하지 않는다.
3. `meeting-record-email-worker.ts`를 Supabase `meeting-record-email`로 배포한다. 기존 `GROWELL_GMAIL_APP_PASSWORD`를 사용한다. 기본 legacy JWT 검증을 유지하고, 예약 호출은 앱의 기존 공개 anon JWT를 Authorization에 포함한다. 추가로 서버 전용 Vault 비밀값을 RPC에서 검증한다. 공개 anon 키만으로 발송할 수 없다.
4. Vault의 기존 `growell_habit_sync_worker_secret`을 HTTP 헤더에 넣어 `{"action":"verify"}`를 요청한다. SMTP 연결·인증만 확인하며 메일은 보내지 않는다. 비밀값은 조회 결과나 로그에 출력하지 않는다.
5. 준비가 끝난 뒤 `meeting-mail-activate.sql`로 기존 승인 회원의 동일 Google 연결을 등록한다. 최신 공개 기록만 한 번 예약하며 이전 기록을 일괄 발송하지 않는다. 기존 OFF 설정을 보존한다.
6. `meeting-mail-schedule.sql`로 독립 예약 작업을 활성화한다. Drive·Calendar·습관·가입 알림의 기존 작업은 유지한다.

최초 연결/다시 켜기는 최신 접근 가능 기록 한 번, 이후 새 공개 기록마다 한 번이다. 일반 수정은 재발송하지 않는다. 본문은 운영자가 정리한 핵심 요약·개념·모임 내용·다음 준비·관련 자료 제목과 같은 책·해당 회차의 회원 공개 통찰이다. 개인 공간의 비공개 기록은 PDF에 넣지 않는다.

수신 계정·승인 상태·책 접근·기록 버전과 공개 통찰을 포함한 내용 해시를 발송 직전에 다시 검증한다. 동일 기록/Google 계정/이메일의 접수 기록을 보존한다. PDF 준비 전 실패만 제한적으로 재시도하며 SMTP 발송 후 불확실한 상태는 검토 대상으로 남긴다. 자동 재발송하지 않는다. SMTP 접수 성공은 받은편지함 도착 확인과 구분한다.

각 회원은 프로필 → Google 연동에서 PDF 이메일을 독립적으로 끌 수 있다. 습관 알림은 별도 Microsoft 계정 연결이며 같은 프로필 화면에서 이어서 설정한다.
