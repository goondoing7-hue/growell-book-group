# GROWELL 가입·관리자·프로필 운영 상태

## 2026-10-22 Google 로그인 최초 연결의 비밀번호 재입력 생략

기존 아이디 회원이 이미 로그인한 상태에서 **프로필 → 설정 → 연동 → Google 로그인 연결**을 누르면 GROWELL 비밀번호를 다시 입력하지 않고 Google 계정 선택으로 이동합니다. 현재 Auth 서버의 `getUser()` 응답과 본인의 승인된 최신 프로필을 확인하며, 기존 Auth UUID·회원 ID·login ID·프로필 salt·현재 개인 기록 키와 원문을 유지합니다. 작성 중인 내용은 먼저 저장하고, 연결 전후 기기에 보관된 같은 회원의 기록 키를 확인할 수 없으면 다른 키를 만들어 진행하지 않습니다.

초기 연결에서 키 보관함 RPC를 호출하거나 기존 보관함을 교체하지 않습니다. 다음 Google 로그인 때 기존 보관함이 없는 일반 회원은 서버가 확인한 Google·이메일 identity와 같은 회원 프로필을 확인한 뒤 현재 GROWELL 비밀번호로 인증합니다. 같은 Auth UUID·승인 상태·원래 salt를 다시 확인하고 기존 방식으로 개인 기록 키를 복원한 후, 기존 `growell_oauth_link_prepare`의 최근 비밀번호 인증 조건을 만족하여 암호문 보관함을 준비합니다. **새 기기에서 개인 기록을 처음 여는 데는 현재 GROWELL 비밀번호가 여전히 필요합니다.** 기존 소셜 신규 가입 회원의 무작위 기록 키와 v1 암호문 보관함은 기존 경로를 유지합니다.

이 변경은 클라이언트와 가이드에 한정하며 DB 스키마·Auth 제공자·후크·서버 RPC·최근 비밀번호 AMR 조건을 변경하지 않습니다. Google 로그인은 Drive 백업·캘린더 권한 동의와 별개이며, 해당 기능은 기존 연동 스위치에서 필요한 권한을 동의합니다. 아래 2026-10-21 절은 이전 배포 이력입니다. 그 절의 초기 연결 시 비밀번호 재입력 설명은 이 절로 대체하며, 보관함·복구·권한 보호 조건은 유지합니다. 배포 완료 여부와 실제 회원의 Google 선택·새 기기 로그인 확인 여부는 각각 별도로 기록합니다.

## 2026-10-21 기존 회원의 Google 로그인 연결

프로필 → 설정 → 연동 → Google 로그인 설정에서 기존 회원이 현재 GROWELL 비밀번호로 재인증한 뒤 Google identity를 같은 Auth UUID에 연결합니다. 회원 ID·login ID·프로필 salt·작성 원문과 기존 아이디 로그인은 유지합니다. 키 보관함에는 현재 개인 기록 키를 별도 salt와 현재 비밀번호로 감싼 암호문만 보관합니다. 원문 비밀번호·키를 RPC나 Google로 전송하지 않습니다. 새 기기의 Google 로그인은 현재 GROWELL 비밀번호로 개인 기록을 열며, 일반 회원의 힌트·복구 흐름을 그대로 유지합니다.

운영에는 `server/oauth-members.sql`의 `EXISTING_MEMBER_GOOGLE_LINK_HISTORY`와 `EXISTING_MEMBER_GOOGLE_LINK_FUNCTIONS` 마커 두 구간만 추가했습니다. 기존 `growell_oauth_profile`·`growell_oauth_register`의 승인 적용 버전은 교체하지 않았습니다. `growell_oauth_link_prepare`는 본인·승인·활성 Auth 세션·10분 내 비밀번호 AMR을 검증하고 최초 보관함을 덮어쓰지 않습니다. `growell_oauth_link_rotate`는 복구 성공 후 이전 암호문과 정확히 일치할 때만 교체하고 이전 암호문을 클라이언트 접근이 차단된 이력에 보관합니다. 같은 결과 재시도는 멱등이며 충돌은 실패합니다.

Google 제공자와 Allow manual linking은 이미 활성화되어 있어 자격 증명을 재등록하지 않았습니다. 기존 Auth Hooks가 없는 것을 확인한 뒤 Before User Created에 `public.growell_before_user_created`를 활성화했습니다. 이 후크는 Auth가 제공한 app_metadata의 Google 신규 사용자 생성만 거절하며, 기존 Google 로그인·본인 identity 연결과 일반 아이디 가입은 유지합니다. 미연결 계정으로 먼저 Google 로그인을 시도해 별도 Auth 계정이 생성되는 것을 막습니다. 클라이언트는 새 Google 계정에 GROWELL 프로필을 자동 등록하거나 이메일·별명으로 기존 회원을 합치지 않습니다.

운영 스키마에서 기존 회원 연결 전용 롤백 검증은 `ok: true`, 임시 잔여 행 0개를 확인했습니다. 실제 회원 비밀번호·힌트 답변·암호화 키나 글 본문은 검증에 사용하지 않았습니다. 일반 회원·비로그인·서비스 역할의 실행 권한과 이력 테이블 접근 차단을 별도로 확인했습니다. 보안 Advisor의 [인증 RPC 점검](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)은 본인 전용 보관함 RPC의 의도된 호출이며, 함수 내부의 소유·승인·세션·최근 비밀번호 인증 조건을 검토했습니다. 이력 테이블은 직접 접근을 허용하는 정책을 만들지 않았습니다. 실제 회원이 처음 연결하는 Google 동의·비밀번호 입력과 이후 새 기기 로그인은 회원 본인이 진행해야 합니다. 아래 2026-09-23 소셜 신규 가입 기록은 당시 구현 이력이며, 현재 공개 로그인은 기존 회원의 Google 연결용입니다.

2026-09-23 기준 운영 Supabase에서 Google·카카오 제공자를 활성화했다. 일반 아이디 가입도 유지한다. **Google 공개 게시를 완료하고 ‘프로덕션 단계’ 표시를 확인했다.** 제공자 설정, 서버 회원 연결, 실제 서비스 배포와 제공자 동의를 거친 가입 검증은 구분한다.

## 지금 연결된 기능

- 일반 회원가입: 별명·아이디·비밀번호로 기존 `signup` Edge Function을 호출한다. 아이디는 서버 Auth 이메일 `아이디@growell.internal`에 연결된다. 실제 이메일 가입·이메일 복구와는 다르다.
- 로그인: Supabase Auth 비밀번호 검증 후 연결된 `profiles` 행을 불러온다.
- 관리자: 기존 `grant-admin` Edge Function에서 운영자 코드를 검증한다. 관리자 코드·서비스 키를 클라이언트에 넣지 않는다. 화면에 관리자 메뉴를 보이는 것만으로 서버 권한이 생기지 않는다.
- 프로필 사진: 일반 가입 및 로그인 후 **프로필 수정**에서 고른다. 브라우저에서 가운데를 잘라 256px JPEG로 줄인다. 가입 후 변경은 기존 `avatars` 버킷과 `profiles.avatar_url`에 저장하며 별명·사진을 같은 저장 흐름으로 반영한다.
- 저장 전 사진 선택·삭제로 작성 중인 가입 정보와 별명이 사라지지 않는다. 업로드 도중 로그아웃·계정 전환이 발생하면 다른 회원 프로필을 수정하지 않는다.

## 연결한 제공자 설정

- Google Cloud 프로젝트: **GROWELL Book Group** (`growell-book-group`). 웹 OAuth 클라이언트 **GROWELL Book Web**을 생성하여 Supabase Google 제공자에 연결했다. 동의 화면에 저장한 범위는 `openid`, `userinfo.email`, `userinfo.profile` 세 가지뿐이다. 앱 공개 게시 후 ‘프로덕션 단계’ 상태를 확인했다.
- Google 브랜딩의 개인정보처리방침 주소에는 `https://growell-book.vercel.app/privacy.html`을 등록했다. 이 파일은 로그인 없이 열리는 정적 문서이며 앱 배포 파일에 포함된다. 2026-09-23 운영 주소에서 로그인 없이 정상 표시되는 것을 확인했다.
- Kakao Developers 앱 ID: `1586025`. 닉네임은 선택 동의이며 프로필 사진 범위는 껐다. 이메일 권한이 없는 구성으로 Supabase의 **Allow users without email**을 켰고, Kakao 제공자를 활성화했다. 소셜 프로필 사진을 자동으로 가져오지 않고 회원이 앱에서 직접 선택한다.
- 카카오 로그인 요청은 `options.queryParams.scope = 'profile_nickname'`로 닉네임만 지정한다. `options.scopes`는 [Supabase Kakao 구현](https://github.com/supabase/auth/blob/master/internal/api/provider/kakao.go)의 기본 이메일·사진 범위에 추가되므로 대체 용도로 쓰지 않는다. [Auth JS](https://github.com/supabase/auth-js/blob/master/src/GoTrueClient.ts)는 `queryParams`를 `/authorize` 쿼리에 넣고, [Auth 서버](https://github.com/supabase/auth/blob/master/internal/api/external.go)는 `scope`를 제공자 URL 옵션으로 전달한다. [Go OAuth2](https://github.com/golang/oauth2/blob/master/oauth2.go)의 `AuthCodeURL`은 이 옵션을 기본 범위 뒤에 적용한다. 따라서 앱은 이메일·사진 동의를 추가로 요청하지 않으며, Google 요청에는 이 설정을 넣지 않는다.
- 제공자 비밀 키는 Supabase 설정에만 보관한다. 소스, 프런트엔드 번들과 Git에 넣지 않는다.

등록 주소는 다음과 같다. 와일드카드로 다른 사이트의 복귀 주소를 허용하지 않는다.

| 항목 | 등록 값 |
| --- | --- |
| Google·카카오의 인증 콜백 | `https://oxaeecawijnetwmvggjs.supabase.co/auth/v1/callback` |
| Supabase Site URL | `https://growell-book.vercel.app` |
| GROWELL의 Supabase Redirect URL | `https://growell-book.vercel.app/` (기존 다른 복귀 주소는 이번 변경에서 수정하지 않음) |

앱은 Supabase의 현재 제공자 설정을 읽어 사용 가능한 버튼을 활성화한다. 설정 조회 실패 시 연결 확인을 안내하며 임의로 로그인 성공을 표시하지 않는다.

## 소셜 회원과 개인 기록 연결

`server/oauth-members.sql`을 운영 프로젝트에 적용했다. `growell_oauth_profile`과 `growell_oauth_register`는 서버의 `auth.uid()`와 Google·카카오 `auth.identities`를 확인하며 해당 Auth 사용자에게 GROWELL 프로필과 암호화 키 보관함을 연결한다. 새 회원은 일반 회원 권한으로 생성하고 관리자 권한을 자동 부여하지 않는다.

별명·이메일이 같다는 이유로 기존 아이디 회원과 소셜 회원을 합치지 않는다. 제공자가 전달한 이름은 별명 입력의 초기 제안으로만 사용한다. 이미 같은 Auth 사용자에 연결된 일반 회원 프로필이 있고 소셜 키 보관함이 없다면 기존 아이디 로그인을 안내하며 프로필·키·개인 기록을 덮어쓰지 않는다.

새 소셜 회원은 별명과 **개인 기록 비밀번호**를 설정한다. 브라우저에서 만든 개인공간 키를 그 비밀번호로 암호화하여 서버에 보관하고, 평문 비밀번호와 평문 키는 등록 RPC로 보내지 않는다. 재로그인과 다른 기기에서는 서버에서 받은 보관함을 같은 비밀번호로 연다. 자세한 계약은 [server/oauth-interface.md](server/oauth-interface.md)에 있다.

소셜 회원에게는 개인 기록 **복구 파일 저장**을 제공한다. 현재 소셜 개인 기록 비밀번호의 변경·분실 재설정 화면과 보관함 교체 RPC는 제공하지 않는다. 일반 계정의 비밀번호 힌트·재설정 흐름으로 소셜 키를 바꾸거나 기존 보관함을 초기화하지 않는다. 소셜 탈퇴는 운영자 `goondoing7@gmail.com`으로 문의하도록 안내한다.

## 적용 및 검증 기록

- `server/oauth-members.sql`: 운영 적용 성공. Google·카카오 첫 등록/재조회, 재시도, 계정 분리, 기존 일반 회원 보존, 익명·이메일 전용 사용자 거부와 키 보관함 권한을 `server/oauth-verification.sql`의 임시 데이터로 검증했다. 결과는 `ok: true`, 롤백 후 `synthetic_rows_remaining: 0`이다.
- `server/recovery-owner.sql`: 운영 적용 성공. 비로그인 일반 회원의 복구 파일과 계정 식별 정보가 정확히 일치하는지 Boolean으로만 확인한다. 비밀번호 재설정 권한을 부여하거나 기록·키·힌트 등을 반환하지 않는다. 기존 `reset-password` Edge Function의 힌트 검증은 별도로 유지한다. `server/recovery-owner-verification.sql` 검증 결과는 `ok: true`, 롤백 후 `synthetic_rows_remaining: 0`이다.
- `server/habit-kind.sql`: 2026-09-23 운영 적용 성공. `habits.behavior_type`은 `text`, `NOT NULL`, 기본값 `do`이며 제약 검증은 `validated: true`, 잘못된 값은 `invalid_rows: 0`으로 확인했다. 임시 데이터 화면에서 절제할 습관 선택·수정·목표 저장과 기존 실천 체크 1회 보존도 확인했다. 실천할 습관은 체크 아이콘, 절제할 습관은 손바닥 아이콘으로 설정·목록·진행 상황에 표시한다. 모바일 선택 화면과 운영 배포 파일 반영을 확인했다.
- Google은 실제 제공자 인증 콜백이 성공하고 GROWELL의 신규 가입 화면(별명·개인 기록 비밀번호 설정)에 도달한 것을 확인했다. 개인 기록 비밀번호를 입력하거나 가입 완료·재로그인을 진행하지 않았으므로 이 단계까지 성공했다고 확대해 안내하지 않는다.
- 카카오는 기본 범위로 인한 `KOE205`를 닉네임 전용 요청으로 해결했다. 2026-09-23 운영 배포 후 실제 동의 화면에 닉네임만 표시되는 것과 인증 콜백 성공, GROWELL 신규 가입 화면(별명·개인 기록 비밀번호 설정) 도달을 확인했다. 개인 기록 비밀번호 입력·회원 등록 완료·재로그인은 수행하지 않았다.
- 기능 배포 `7934b81`은 회귀 테스트 189개를 통과했고, Vercel Production Ready와 `https://growell-book.vercel.app/`의 최신 습관 아이콘·카카오 요청 설정 반영을 확인했다.
- 기존 `signup`, `grant-admin`, `reset-password`, `delete-account` Edge Function 원본은 이 저장소에 없으므로 원본까지 검토했다고 안내하지 않는다.

## 회원 전용 공개 범위

프런트엔드는 회원 가입·로그인 후 나눔 공간, 나의 공간, 활동지, 자료실과 습관을 이용하도록 안내한다. 프런트엔드의 로그인 차단과 데이터베이스 보안은 별도다. 개인 기록은 기존 암호화 및 회원별 저장 구조를 유지한다.

`server/member-read-policy.sql`은 **2026-09-23 운영 적용을 완료했다.** 9개 테이블의 조회에 로그인한 활성 회원을 확인하는 `RESTRICTIVE` 조건을 추가하고, `profiles` 직접 등록 시 관리자·탈퇴 상태를 지정하지 못하도록 `INSERT` 조건을 추가했다. 본인 프로필 조회는 가입·로그인 확인을 위해 허용한다. 기존 `PERMISSIVE` 정책과 회원 소유권·관리자 조건을 대체하지 않는다.

실제 `anon`·`authenticated` 역할로 임시 데이터 기반 조회·등록 권한과 기존 정책·권한 보존을 검증했다. 결과는 `ok: true`, 롤백 후 `synthetic_rows_remaining: 0`이며 최종 SQL 적용 성공을 확인했다. 재적용 전에도 현재 운영 정책을 내보내 비교하고 검증한다. 기존 정책 스냅샷과 QA 자료는 공개 배포나 Git 게시에 포함하지 않는다.

공개 Storage URL, 별도 뷰, RPC, Edge Function 접근은 이 SQL의 범위가 아니다. 프로필·공유 첨부의 기존 공개 이미지 주소를 이 정책만으로 비공개로 만들었다고 안내하지 않는다.

개인정보 안내는 [privacy.html](privacy.html)에 있다. 실제 탈퇴 함수의 삭제 범위, 이전 첨부 이미지 삭제 처리와 서버 백업 보관 정책은 운영자가 별도로 확인·관리해야 한다.

공식 설정 문서: [Google](https://supabase.com/docs/guides/auth/social-login/auth-google), [Kakao](https://supabase.com/docs/guides/auth/social-login/auth-kakao), [리디렉션 URL](https://supabase.com/docs/guides/auth/redirect-urls).
