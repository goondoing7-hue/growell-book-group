# GROWELL 가입·관리자·프로필 운영 상태

2026-09-23 기준 운영 Supabase에서 Google·카카오 제공자를 활성화했다. 일반 아이디 가입도 유지한다. **Google 공개 게시를 완료하고 ‘프로덕션 단계’ 표시를 확인했다.** 제공자 설정, 서버 회원 연결, 실제 서비스 배포와 제공자 동의를 거친 가입 검증은 구분한다.

## 지금 연결된 기능

- 일반 회원가입: 별명·아이디·비밀번호로 기존 `signup` Edge Function을 호출한다. 아이디는 서버 Auth 이메일 `아이디@growell.internal`에 연결된다. 실제 이메일 가입·이메일 복구와는 다르다.
- 로그인: Supabase Auth 비밀번호 검증 후 연결된 `profiles` 행을 불러온다.
- 관리자: 기존 `grant-admin` Edge Function에서 운영자 코드를 검증한다. 관리자 코드·서비스 키를 클라이언트에 넣지 않는다. 화면에 관리자 메뉴를 보이는 것만으로 서버 권한이 생기지 않는다.
- 프로필 사진: 일반 가입 및 로그인 후 **프로필 수정**에서 고른다. 브라우저에서 가운데를 잘라 256px JPEG로 줄인다. 가입 후 변경은 기존 `avatars` 버킷과 `profiles.avatar_url`에 저장하며 별명·사진을 같은 저장 흐름으로 반영한다.
- 저장 전 사진 선택·삭제로 작성 중인 가입 정보와 별명이 사라지지 않는다. 업로드 도중 로그아웃·계정 전환이 발생하면 다른 회원 프로필을 수정하지 않는다.

## 연결한 제공자 설정

- Google Cloud 프로젝트: **GROWELL Book Group** (`growell-book-group`). 웹 OAuth 클라이언트 **GROWELL Book Web**을 생성하여 Supabase Google 제공자에 연결했다. 동의 화면에 저장한 범위는 `openid`, `userinfo.email`, `userinfo.profile` 세 가지뿐이다. 앱 공개 게시 후 ‘프로덕션 단계’ 상태를 확인했다.
- Google 브랜딩의 개인정보처리방침 주소에는 `https://growell-book.vercel.app/privacy.html`을 등록했다. 이 파일은 로그인 없이 열리는 정적 문서이며 앱 배포 파일에 포함된다. 배포 후 문서 접근 확인은 별도로 필요하다.
- Kakao Developers 앱 ID: `1586025`. 닉네임은 선택 동의이며 프로필 사진 범위는 껐다. 이메일 권한이 없는 구성으로 Supabase의 **Allow users without email**을 켰고, Kakao 제공자를 활성화했다. 소셜 프로필 사진을 자동으로 가져오지 않고 회원이 앱에서 직접 선택한다.
- 제공자 비밀 키는 Supabase 설정에만 보관한다. 소스, 프런트엔드 번들과 Git에 넣지 않는다.

등록 주소는 다음과 같다. 와일드카드로 다른 사이트의 복귀 주소를 허용하지 않는다.

| 항목 | 등록 값 |
| --- | --- |
| Google·카카오의 인증 콜백 | `https://oxaeecawijnetwmvggjs.supabase.co/auth/v1/callback` |
| Supabase Site URL | `https://growell-book.vercel.app` |
| Supabase Redirect URLs | `https://growell-book.vercel.app/` 한 개 |

앱은 Supabase의 현재 제공자 설정을 읽어 사용 가능한 버튼을 활성화한다. 설정 조회 실패 시 연결 확인을 안내하며 임의로 로그인 성공을 표시하지 않는다.

## 소셜 회원과 개인 기록 연결

`server/oauth-members.sql`을 운영 프로젝트에 적용했다. `growell_oauth_profile`과 `growell_oauth_register`는 서버의 `auth.uid()`와 Google·카카오 `auth.identities`를 확인하며 해당 Auth 사용자에게 GROWELL 프로필과 암호화 키 보관함을 연결한다. 새 회원은 일반 회원 권한으로 생성하고 관리자 권한을 자동 부여하지 않는다.

별명·이메일이 같다는 이유로 기존 아이디 회원과 소셜 회원을 합치지 않는다. 제공자가 전달한 이름은 별명 입력의 초기 제안으로만 사용한다. 이미 같은 Auth 사용자에 연결된 일반 회원 프로필이 있고 소셜 키 보관함이 없다면 기존 아이디 로그인을 안내하며 프로필·키·개인 기록을 덮어쓰지 않는다.

새 소셜 회원은 별명과 **개인 기록 비밀번호**를 설정한다. 브라우저에서 만든 개인공간 키를 그 비밀번호로 암호화하여 서버에 보관하고, 평문 비밀번호와 평문 키는 등록 RPC로 보내지 않는다. 재로그인과 다른 기기에서는 서버에서 받은 보관함을 같은 비밀번호로 연다. 자세한 계약은 [server/oauth-interface.md](server/oauth-interface.md)에 있다.

소셜 회원에게는 개인 기록 **복구 파일 저장**을 제공한다. 현재 소셜 개인 기록 비밀번호의 변경·분실 재설정 화면과 보관함 교체 RPC는 제공하지 않는다. 일반 계정의 비밀번호 힌트·재설정 흐름으로 소셜 키를 바꾸거나 기존 보관함을 초기화하지 않는다. 소셜 탈퇴는 운영자 `goondoing7@gmail.com`으로 문의하도록 안내한다.

## 적용 및 검증 기록

- `server/oauth-members.sql`: 운영 적용 성공. Google·카카오 첫 등록/재조회, 재시도, 계정 분리, 기존 일반 회원 보존, 익명·이메일 전용 사용자 거부와 키 보관함 권한을 `server/oauth-verification.sql`의 임시 데이터로 검증했다. 결과는 `ok: true`, 롤백 후 `synthetic_rows_remaining: 0`이다.
- `server/recovery-owner.sql`: 운영 적용 성공. 비로그인 일반 회원의 복구 파일과 계정 식별 정보가 정확히 일치하는지 Boolean으로만 확인한다. 비밀번호 재설정 권한을 부여하거나 기록·키·힌트 등을 반환하지 않는다. 기존 `reset-password` Edge Function의 힌트 검증은 별도로 유지한다. `server/recovery-owner-verification.sql` 검증 결과는 `ok: true`, 롤백 후 `synthetic_rows_remaining: 0`이다.
- `server/habit-kind.sql`: 2026-09-23 운영 적용 성공. `habits.behavior_type`은 `text`, `NOT NULL`, 기본값 `do`이며 제약 검증은 `validated: true`, 잘못된 값은 `invalid_rows: 0`으로 확인했다. 임시 데이터 화면에서 하지 않는 습관 선택·수정·목표 저장과 기존 실천 체크 1회 보존도 확인했다.
- 위 SQL 결과는 서버 계약 검증이다. Google 공개 게시 상태는 제공자 화면에서 별도로 확인했으며, 실제 제공자 동의 화면을 거친 가입·재로그인과 운영 사이트 배포 완료까지 SQL 검증만으로 확정하지 않는다.
- 기존 `signup`, `grant-admin`, `reset-password`, `delete-account` Edge Function 원본은 이 저장소에 없으므로 원본까지 검토했다고 안내하지 않는다.

## 회원 전용 공개 범위

프런트엔드는 회원 가입·로그인 후 나눔 공간, 나의 공간, 활동지, 자료실과 습관을 이용하도록 안내한다. 프런트엔드의 로그인 차단과 데이터베이스 보안은 별도다. 개인 기록은 기존 암호화 및 회원별 저장 구조를 유지한다.

`server/member-read-policy.sql`은 **2026-09-23 운영 적용을 완료했다.** 9개 테이블의 조회에 로그인한 활성 회원을 확인하는 `RESTRICTIVE` 조건을 추가하고, `profiles` 직접 등록 시 관리자·탈퇴 상태를 지정하지 못하도록 `INSERT` 조건을 추가했다. 본인 프로필 조회는 가입·로그인 확인을 위해 허용한다. 기존 `PERMISSIVE` 정책과 회원 소유권·관리자 조건을 대체하지 않는다.

실제 `anon`·`authenticated` 역할로 임시 데이터 기반 조회·등록 권한과 기존 정책·권한 보존을 검증했다. 결과는 `ok: true`, 롤백 후 `synthetic_rows_remaining: 0`이며 최종 SQL 적용 성공을 확인했다. 재적용 전에도 현재 운영 정책을 내보내 비교하고 검증한다. 기존 정책 스냅샷과 QA 자료는 공개 배포나 Git 게시에 포함하지 않는다.

공개 Storage URL, 별도 뷰, RPC, Edge Function 접근은 이 SQL의 범위가 아니다. 프로필·공유 첨부의 기존 공개 이미지 주소를 이 정책만으로 비공개로 만들었다고 안내하지 않는다.

개인정보 안내는 [privacy.html](privacy.html)에 있다. 실제 탈퇴 함수의 삭제 범위, 이전 첨부 이미지 삭제 처리와 서버 백업 보관 정책은 운영자가 별도로 확인·관리해야 한다.

공식 설정 문서: [Google](https://supabase.com/docs/guides/auth/social-login/auth-google), [Kakao](https://supabase.com/docs/guides/auth/social-login/auth-kakao), [리디렉션 URL](https://supabase.com/docs/guides/auth/redirect-urls).
