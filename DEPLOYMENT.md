# GROWELL 배포

## 대상

- GitHub: `https://github.com/goondoing7-hue/growell-book-group`
- Vercel: 기존 `growell_book_group` 프로젝트 (`prj_1bSFk5VGEVZnpwmPUPL0ssLcptyA`)
- 운영 주소: `https://growell-book.vercel.app`

이 구성은 위 저장소와 기존 프로젝트를 사용합니다. 다른 앱의 저장소나 Vercel 프로젝트로 게시하지 않습니다.

## Vercel 연결 설정

2026-09-21에 기존 Vercel 프로젝트를 `goondoing7-hue/growell-book-group`에 연결했으며 Production Branch는 `main`입니다. 프로젝트 루트는 앱 파일이 있는 저장소 루트입니다. 새 기기에서도 같은 저장소를 복제해 게시 명령을 사용할 수 있습니다.

| 항목 | 값 |
| --- | --- |
| Framework Preset | Other |
| Node.js Version | 22.x 이상 |
| Root Directory | 저장소 루트 |
| Build Command | `npm run build` |
| Output Directory | `dist` |

`vercel.json`에 빌드 명령과 출력 폴더를 저장했습니다. 기존 프로젝트 설정에 상충하는 별도 재정의가 있으면 위 값에 맞춥니다. Git 연결 배포를 사용하므로 GitHub Actions에 Vercel 토큰을 등록할 필요가 없습니다.

## 로컬 확인

저장소 루트에서 Node.js 22 이상으로 실행합니다.

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run build
```

순서는 스크립트 문법과 자산 연결 검사 → 임시 데이터 테스트 → `dist/` 생성입니다. `dist/`에는 `index.html`, `privateCrypto.js`, `homeDomain.js`, `home.css`, `manifest.json`, 지정한 `covers/` 파일만 들어갑니다. 코드가 참조하는 새 이미지나 자산을 추가하면 `scripts/files.cjs`의 공개 파일 목록에도 정확한 파일 경로를 추가합니다. 새 테스트는 같은 파일의 `TEST_FILES`에 등록합니다.

## 미리 보기와 운영 반영

변경을 미리 확인할 때는 작업 브랜치에서 게시합니다.

```powershell
git switch -c codex/reading-improvement
npm.cmd run publish -- "독서 기록 작성 개선"
```

연결된 Vercel의 해당 Preview 주소에서 PC·모바일 화면, 로그인, 기록 저장, 새로고침 후 상태를 확인합니다. 실제 회원 데이터 대신 별도 테스트 계정을 사용합니다. 확인한 작업 브랜치를 GitHub PR로 `main`에 통합하면 운영 배포가 실행됩니다.

운영 반영이 이미 승인된 변경은 최신 `main`에서 같은 명령으로 게시할 수 있습니다.

```powershell
npm.cmd run publish -- "저장 오류 수정"
```

현재 브랜치가 `main`인지 먼저 확인하세요. 게시 명령이 성공한 것과 Vercel 배포가 완료된 것은 서로 다른 단계입니다. Vercel Deployments에서 해당 커밋이 `Ready`인지 확인한 후 운영 주소에서 변경을 확인합니다.

## 게시 명령의 동작

1. 현재 폴더가 저장소 루트인지, `origin`의 읽기·쓰기 주소가 지정한 GROWELL 저장소 하나인지 확인합니다.
2. 충돌이나 기존 스테이징 변경이 있으면 중단합니다. 사용자 변경을 자동으로 되돌리지 않습니다.
3. 원격 `main`을 가져와 이전에 확인한 값과 비교합니다. 원격이 바뀌었거나 현재 브랜치에 원격 변경이 포함되지 않았으면 비교·통합을 위해 중단합니다. 작업 브랜치에도 원격에 추가 변경이 있으면 중단합니다.
4. 아직 게시되지 않은 커밋과 새로 스테이징할 경로를 허용 목록과 비교합니다. 새로 발견한 목록 밖 파일은 올리지 않습니다. 기존 미게시 커밋에 목록 밖 파일이 들어 있으면 중단합니다.
5. 검사·테스트·빌드가 통과하면 허용 경로만 커밋하고 현재 브랜치를 일반 푸시합니다. 강제 푸시나 자동 병합을 하지 않습니다.

원격 변경 때문에 중단되면 `git diff HEAD origin/main` 등으로 차이를 확인하고 직접 통합한 뒤 다시 게시합니다. 인증 오류가 발생하면 GitHub 로그인을 복구한 뒤 다시 실행합니다. 토큰을 원격 URL에 넣거나 파일에 저장하지 않습니다.

## GitHub 검사

`.github/workflows/verify.yml`은 PR과 `main` 푸시에서 Node.js 22로 `npm run build`를 실행합니다. 권한은 저장소 내용 읽기로 제한합니다. Vercel 빌드 자체도 같은 검사를 실행하므로 테스트 실패 배포가 새 운영 버전으로 준비되지 않습니다.

## 이전 버전으로 복구

운영 배포에 문제가 있으면 Vercel의 기존 성공 배포를 확인해 이전 배포로 되돌립니다. 그다음 원인 변경을 수정하거나 GitHub에서 해당 변경의 되돌리기 PR을 만들어 `main`과 운영 내용을 맞춥니다. 데이터베이스·회원 기록은 정적 파일 롤백으로 되돌아가지 않습니다.

v33에서 저장·변환한 개인 기록은 v2 암호화 형식입니다. v32 화면은 이 형식을 읽지 못하므로, 회원이 v33으로 기록을 저장한 이후에는 v2 읽기를 지원하는 버전으로만 롤백해야 합니다. 본문·ID·생성 시각은 변환 중 보존합니다. 변환 전 운영 배포 ID는 `dpl_DTCrYuqdTY4yT4pbA9ADgSnjL9CZ`이며, 데이터 변환 후에는 이 배포로 단순 롤백하지 않습니다.

## v33 기록 보호 변경

- 글 종류별 초안은 계정·책·작성/수정 대상별로 분리해 해당 기기에 암호화하여 임시 저장합니다. 다른 기기와 자동 동기화하는 초안은 아닙니다.
- 로그인 시 개인 기록과 습관을 함께 읽습니다. 실패한 조회는 빈 목록으로 숨기지 않고 다시 불러오기를 제공합니다.
- 연속 습관 체크는 순서대로 저장합니다. 실패 항목은 재시도할 수 있으며, 로그아웃한 계정의 대기 작업은 취소합니다.
- 개인 기록의 본문 키와 로그인 비밀번호를 분리했습니다. 프로필의 **복구 파일 저장**을 먼저 이용한 뒤, 비밀번호 찾기에서 그 파일을 선택합니다. 파일은 서버로 전송하지 않습니다. 복구 과정은 본인 인증 후 같은 기록 ID의 암호문만 갱신하며, 다른 기기에서 수정된 기록은 IV 비교로 보호합니다.
- 복구 파일은 첫 기록 전에도 만들 수 있습니다. 비밀번호를 재설정하면 파일의 안정된 기록 키로 기존 기록을 정리하여 다음 기기·다음 재설정에서도 이용할 수 있게 합니다. 비밀번호 변경 후 복구 파일을 다시 저장해 두면 해당 비밀번호로 작성한 로컬 초안 복구에도 도움이 됩니다.
- 이미 비밀번호와 복구 수단을 모두 잃어버린 과거 기록을 소급해서 해독할 수는 없습니다. 복구가 실패한 기록이나 초안은 삭제하지 않습니다.
- 제공된 GitHub 저장소에는 서버 함수 원본이 없었습니다. 기존 Supabase `signup`, `reset-password` 등의 함수와 RLS는 수정하지 않았습니다. 앱은 기존 테이블과 API를 이용하므로 새 SQL 마이그레이션이나 서버 비밀키가 필요하지 않습니다.

암호화 API 동작은 [MDN AES-GCM 매개변수](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams)와 [키 감싸기 설명](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/wrapKey)을 참고했습니다. 실제 운영 데이터에 쓰기 테스트를 하지는 않습니다.
