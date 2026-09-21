'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { PROJECT_ROOT } = require('./check.cjs');
const { isAllowedRemote, selectPublishPaths } = require('./files.cjs');

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: options.inherit ? 'inherit' : 'pipe' });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error('git ' + args[0] + ' 실패. 인증 또는 저장소 상태를 확인해 주세요.');
  }
  const output = result.stdout || '';
  return { ok: result.status === 0, output: args.includes('-z') ? output : output.trim() };
}
function lines(output) { return output ? output.split(/\r?\n/).filter(Boolean) : []; }
function nulPaths(output) { return output ? output.split('\0').filter(Boolean) : []; }

function main() {
  const description = process.argv.slice(2).join(' ').trim();
  if (!description) throw new Error('사용법: npm.cmd run publish -- "변경 설명"');
  const repoRoot = git(['rev-parse', '--show-toplevel']).output;
  if (fs.realpathSync(repoRoot) !== fs.realpathSync(PROJECT_ROOT)) {
    throw new Error('GROWELL 저장소 루트에서 실행해 주세요. 다른 저장소 안의 하위 폴더에서는 게시할 수 없습니다.');
  }
  const fetchUrls = lines(git(['remote', 'get-url', '--all', 'origin']).output);
  const pushUrls = lines(git(['remote', 'get-url', '--push', '--all', 'origin']).output);
  if (fetchUrls.length !== 1 || pushUrls.length !== 1 || ![...fetchUrls, ...pushUrls].every(isAllowedRemote)) {
    throw new Error('origin은 goondoing7-hue/growell-book-group 저장소 하나여야 합니다.');
  }
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).output;
  if (!branch || !git(['check-ref-format', '--branch', branch], { allowFailure: true }).ok) throw new Error('정상적인 작업 브랜치가 필요합니다.');
  if (git(['diff', '--name-only', '--diff-filter=U']).output) throw new Error('충돌을 해결한 뒤 다시 실행해 주세요.');
  if (git(['diff', '--cached', '--name-only']).output) throw new Error('이미 스테이징된 변경이 있습니다. 먼저 확인하여 커밋하거나 스테이징을 해제해 주세요.');

  const knownMain = git(['rev-parse', '--verify', 'refs/remotes/origin/main'], { allowFailure: true }).output;
  git(['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main'], { inherit: true });
  const remoteMain = git(['rev-parse', 'refs/remotes/origin/main']).output;
  if (knownMain && knownMain !== remoteMain) throw new Error('원격 main이 변경되었습니다. 변경을 비교·통합한 후 다시 실행해 주세요.');
  if (!git(['merge-base', '--is-ancestor', remoteMain, 'HEAD'], { allowFailure: true }).ok) {
    throw new Error('현재 브랜치에 원격 main의 변경이 포함되지 않았습니다. 비교·통합 후 다시 실행해 주세요.');
  }
  if (branch !== 'main') {
    const remoteBranch = git(['ls-remote', '--heads', 'origin', 'refs/heads/' + branch]);
    if (remoteBranch.output) {
      git(['fetch', '--no-tags', 'origin', 'refs/heads/' + branch + ':refs/remotes/origin/' + branch], { inherit: true });
      if (!git(['merge-base', '--is-ancestor', 'refs/remotes/origin/' + branch, 'HEAD'], { allowFailure: true }).ok) {
        throw new Error('원격 작업 브랜치에 추가 변경이 있습니다. 비교·통합 후 다시 실행해 주세요.');
      }
    }
  }
  // Inspect existing unpublished commits too: a prior manual commit must not
  // bypass the same path boundary enforced for newly staged changes.
  const unpushedCommits = lines(git(['rev-list', remoteMain + '..HEAD']).output);
  const committedPaths = unpushedCommits.flatMap(commit =>
    nulPaths(git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-m', '-z', commit]).output)
  );
  const committedAllowed = new Set(selectPublishPaths(committedPaths));
  if (committedPaths.some(file => !committedAllowed.has(file))) {
    throw new Error('아직 게시되지 않은 커밋에 허용 목록 밖의 파일이 있습니다. 커밋 내용을 검토해 주세요.');
  }
  const changed = [
    ...nulPaths(git(['diff', '--name-only', '-z']).output),
    ...nulPaths(git(['ls-files', '--others', '--exclude-standard', '-z']).output)
  ];
  const selected = selectPublishPaths(changed);
  const ignoredCount = changed.filter(file => !selected.includes(file)).length;
  if (ignoredCount) console.log(`허용 목록 밖의 변경 ${ignoredCount}개는 스테이징하지 않습니다.`);

  const buildResult = spawnSync(process.execPath, [path.join(__dirname, 'build.cjs')], { cwd: PROJECT_ROOT, stdio: 'inherit' });
  if (buildResult.error) throw buildResult.error;
  if (buildResult.status !== 0) throw new Error('검증 실패로 게시를 중단했습니다.');
  if (selected.length) {
    git(['add', '--', ...selected], { inherit: true });
    git(['commit', '-m', description], { inherit: true });
  }
  git(['push', '--set-upstream', 'origin', 'HEAD:refs/heads/' + branch], { inherit: true });
  console.log(branch === 'main'
    ? 'main 푸시 완료. 연결된 Vercel 프로젝트에서 운영 배포 상태를 확인해 주세요.'
    : `${branch} 푸시 완료. 연결된 Vercel 프로젝트의 Preview에서 확인해 주세요.`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error('게시 중단: ' + error.message); process.exitCode = 1; }
}
