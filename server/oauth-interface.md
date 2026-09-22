# OAuth 회원 연결 계약

`oauth-members.sql`은 2026-09-23 확인한 실제 `profiles` 스키마에 맞춘다. 적용 여부는 배포 담당자가 별도로 확인한다. 기존 회원이나 개인 기록을 마이그레이션하지 않는다.

## RPC와 클라이언트 순서

1. Supabase OAuth 세션 확보 후 `growell_oauth_profile()`을 호출한다.
2. 반환 JSON은 `{status, profile, envelope}`다. `status`는 `new`, `legacy`, `ready` 중 하나다.
3. `new`: 별명과 개인 기록 비밀번호(8자 이상, 확인 포함)를 받는다. `salt=GrowellOAuth.newSalt()`와 `made=await GrowellOAuth.createVault(password,salt,authUserId)`를 만든다. `growell_oauth_register({p_name:name,p_salt:salt,p_envelope:made.envelope})` 호출. 평문 비밀번호와 `made.keyB64`는 서버로 보내지 않는다.
4. `ready`: **항상 서버가 반환한 envelope**를 `GrowellOAuth.unlockVault(password,envelope,authUserId)`로 열어 `SESSION.keyB64`에 설정한다. 동시 가입·네트워크 재시도일 때 처음 생성한 envelope가 반환되므로 방금 클라이언트에서 만든 키를 무조건 사용하면 안 된다. 잘못된 비밀번호·형식·계정일 때는 기록을 변경하지 않고 잠금 해제 실패만 표시한다.
5. `profile`은 기존 `mapProfileRow`로 매핑할 수 있는 `id, auth_user_id, login_id, name, is_admin, avatar_url, pbkdf2_salt, created_at, is_deleted` 필드를 제공한다.
6. `legacy`: 일반 회원이 이미 같은 Auth 사용자에 연결되어 있지만 소셜 전용 vault가 없는 상태다. 기존 아이디 로그인으로 안내한다. 일반 계정의 비밀번호·salt·개인 기록을 변경하거나 새로운 vault로 덮어쓰지 않는다.

## 키와 개인정보

소셜 가입은 Google/Kakao의 서버 검증된 `auth.identities`만 허용한다. `user_metadata`나 표시 이름/이메일로 권한을 판단하거나 계정을 합치지 않는다. 관리자는 자동 부여되지 않는다. `growell_oauth_vaults`는 일반 API 역할의 직접 읽기·쓰기 권한이 없으며, 해당 세션 소유자의 RPC로만 암호문을 반환한다.

개인 기록 비밀번호는 PBKDF2(SHA-256, 150000회, 16바이트 무작위 salt)로 AES-GCM 포장 키를 만든다. 무작위 32바이트 개인공간 키는 Auth 사용자 UUID를 AAD에 포함해 암호화한다. 이 개인공간 키를 기존 `privateCrypto.js`의 passwordKey 자리에 사용하므로 v2 개인 기록 형식·ID·생성 시각을 유지한다. 키를 외부 OAuth 토큰으로 만들지 않는다.

## 비밀번호 변경과 복구 범위

일반 계정의 `reset-password` 및 비밀번호 힌트 흐름은 소셜 회원의 개인 기록 비밀번호에 사용하지 않는다. 소셜 회원에게 기존 힌트 변경 UI나 일반 계정 비밀번호 찾기를 연결하지 않는다. 같은 비밀번호를 입력해 잠금을 해제하면 다른 기기에서도 같은 키를 얻는다.

복구 파일 내 `legacyKeys`에는 현재 개인공간 키가 포함되므로 기존 v2 기록을 읽는 데 사용할 수 있다. 비밀번호 변경/분실 복구 UI를 추가할 때는 확인된 키를 새 비밀번호로 다시 포장하고 현재 envelope와 비교하는 원자적 CAS RPC로 교체해야 한다. `createVault(newPassword,newSalt,authUserId,existingKeyB64)`는 이를 위한 키 재포장을 지원한다. **현재 등록 RPC는 비밀번호 재설정이나 기존 vault 교체를 제공하지 않는다.** 복구 파일을 갖고 있지 않다는 이유로 기존 vault를 초기화하거나 새 키로 기록을 덮어쓰면 안 된다.

## 원격 검증

프로비저닝 RPC·RLS는 테스트 프로젝트 또는 트랜잭션 롤백이 보장된 검증 과정에서 확인해야 한다. Node 테스트는 잘못된 비밀번호/다른 계정/변조 거부와 기존 암호화 기록 호환을 확인하며, 실제 데이터베이스 권한 검증을 대체하지 않는다.
