# GROWELL 독서모임

GROWELL 독서모임의 웹 앱입니다. 앱 소스와 검증 코드를 GitHub에서 관리하고, 연결된 Vercel 프로젝트가 검사·테스트를 통과한 정적 파일만 배포하도록 구성했습니다.

## 파일 구성

- `index.html`: 화면, 로그인, 독서 기록, 습관, 임시 저장 등 앱 코드
- `privateCrypto.js`: 개인 기록 암호화와 복구 파일 처리
- `covers/`, `manifest.json`: 책 표지, 아이콘, 설치용 앱 정보
- `tests/`: 실제 회원 데이터 없이 실행하는 회귀 검사
- `scripts/`: 소스 검사, 테스트, 빌드, 제한된 Git 게시 명령
- `dist/`: 빌드 때 생성하는 공개 배포 파일. Git에는 올리지 않습니다.

## 검증과 빌드

Node.js 22 이상과 Git이 필요합니다. Windows PowerShell에서는 `npm.cmd`를 사용합니다. 이 프로젝트에는 설치해야 할 npm 외부 의존성이 없습니다.

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run build
```

빌드는 스크립트 문법·로컬 이미지 연결을 검사하고, 모든 등록된 테스트를 실행한 뒤 공개 파일만 `dist/`로 복사합니다. 검사에 실패하면 배포 파일을 새로 만들지 않습니다.

각 단계만 따로 실행할 수도 있습니다.

```powershell
npm.cmd run check
npm.cmd test
```

## 수정한 내용 게시

`goondoing7-hue/growell-book-group` 저장소의 루트에서 실행합니다.

```powershell
npm.cmd run publish -- "독서 기록 저장 개선"
```

이 명령은 원격 변경을 확인하고 검증·빌드한 뒤 허용된 소스 파일만 커밋하여 현재 브랜치에 푸시합니다. `main`은 운영 배포, 다른 브랜치는 Vercel Preview에 사용합니다. 프로젝트 연결과 확인 순서는 [DEPLOYMENT.md](DEPLOYMENT.md)를 참고하세요.

## 개인 기록 복구 파일

앱에서 내려받은 `growell-recovery-*.json`에는 개인 기록을 복구하는 데 필요한 비밀 정보가 있습니다. 소스 폴더에 두지 않고 개인 보관 장소에 저장합니다. 복구 파일, `.env`, 테스트 데이터, 브라우저에서 추출한 회원 데이터를 Git 또는 배포 파일에 넣지 않습니다. 공개 Supabase 클라이언트 설정과 비공개 서버 키는 용도가 다르며, 서버의 service role 키를 프런트엔드에 넣어서는 안 됩니다.
