# 자료실 영상 재생과 자동 요약

자료글의 본문과 첨부 링크에서 YouTube 영상 ID를 확인하고, 상세 화면에 개인정보 보호 모드 플레이어를 표시합니다. 영상은 자동 재생하지 않습니다. 저장된 자료글에 실제로 포함된 영상만 서버에서 요약할 수 있습니다.

## 운영 준비

1. 같은 Supabase 프로젝트에 `server/material-video-summary.sql`을 실행합니다. 재실행할 수 있는 신규 캐시 표·사용량 표·RPC이며 기존 자료글을 바꾸지 않습니다.
2. 기존 `SUPABASE_SERVICE_ROLE_KEY`를 서버에서 사용합니다. 기본 프로젝트는 `oxaeecawijnetwmvggjs`이고 운영 요청 출처는 `https://growell-book.vercel.app`입니다.
3. 기본 AI 연결은 배포 서버의 Vercel OIDC 인증과 AI Gateway입니다. 해당 팀의 Gateway 사용 가능 여부와 잔액이 필요합니다. 별도 키가 있으면 서버 환경변수 `AI_GATEWAY_API_KEY` 또는 `GEMINI_API_KEY`를 사용할 수 있습니다. 키는 브라우저·Git·응답·로그에 넣지 않습니다.
4. 기본 모델은 무료 AI Gateway 크레딧 대상인 `google/gemini-2.5-flash`입니다. 2026-10-03 공식 모델 페이지의 Google 공급자 행에서 무료 대상 여부를 확인했습니다. 3.8 Flash는 무료 대상이 아니므로 기본으로 사용하지 않습니다. `GROWELL_VIDEO_MODEL`로 바꿀 수 있으며 Gateway는 `google/gemini-…`, Google 직접 연결은 `gemini-…` 형식입니다. 영상 URL 입력과 해당 계정의 사용 권한을 지원하는 모델을 사용합니다. 2.5 모델은 `thinkingBudget:0`, 3.x 모델은 `thinkingLevel:low`를 전달합니다.
5. 배포 뒤 승인 회원으로 실제 영상이 포함된 자료글을 열어 재생과 요약 생성을 확인합니다. 로컬 합성 응답·테스트 통과는 운영 AI 연결 성공을 뜻하지 않습니다.

## 데이터와 동작

- 요청은 회원 인증 토큰, 자료글 ID와 영상 ID만 받습니다. 서버에서 승인 상태와 해당 글의 RLS 접근 권한, 저장된 영상 링크를 다시 검증합니다.
- AI 서비스에는 정규화한 공개 YouTube URL과 고정된 요약 지시만 보냅니다. 회원 정보·자료글 본문·개인 메모는 보내지 않습니다.
- 한 번 만든 영상 요약은 서버에 보관하여 재사용합니다. 원문 자막을 보관하지 않습니다. 캐시 표와 RPC는 `service_role`만 접근합니다.
- 동시 요청은 90초 생성 임대로 중복 처리를 막습니다. 새 생성은 한국 날짜 기준 전체 50회/일, 회원 10회/일까지 허용합니다. 기존 요약을 읽는 것은 생성 횟수에 포함하지 않습니다.
- 생성은 최대 40초, 서버 요청은 최대 50초로 제한합니다. 영상 확인 불가·설정 누락·한도·일시 오류는 구분하여 안내하며 임의로 요약을 만들어내지 않습니다. 오류 종류에 따라 5분~24시간 뒤 재시도할 수 있습니다.
- 영상 자체가 비공개·삭제·연령 제한·외부 재생 제한이면 YouTube 정책에 따라 재생이나 요약이 불가능할 수 있습니다.

## 확인

`npm.cmd run build`는 영상 ID 검증, 요약 출력 검증, 인증·접근권한, 취소·시간 제한, PostgreSQL의 동시 생성 임대·사용량 제한·RLS, 화면 표시를 검증합니다. 실제 회원 글을 생성하거나 변경하지 않는 별도 로컬 합성 화면으로 UI를 확인합니다.

참고: [무료 크레딧·영상 입력을 지원하는 기본 모델](https://vercel.com/ai-gateway/models/gemini-2.5-flash), [Google 영상 입력](https://ai.google.dev/gemini-api/docs/video-understanding), [Gateway 영상 입력](https://vercel.com/docs/ai-gateway/inputs-and-tools/video-input), [Gateway OIDC](https://vercel.com/docs/ai-gateway/authentication-and-byok/oidc).
