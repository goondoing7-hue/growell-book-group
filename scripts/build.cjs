'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEPLOY_FILES } = require('./files.cjs');
const { PROJECT_ROOT, assertRegularFile, verifySource } = require('./check.cjs');
const { runTests } = require('./test.cjs');

function copyDeployFiles(root = PROJECT_ROOT) {
  const sourceRoot = fs.realpathSync(root);
  const destination = path.resolve(sourceRoot, 'dist');
  if (path.dirname(destination) !== sourceRoot || path.basename(destination) !== 'dist') {
    throw new Error('빌드 출력 경로가 프로젝트 내부 dist가 아닙니다.');
  }
  // Validate source files and the final deletion target before changing dist.
  for (const relative of DEPLOY_FILES) assertRegularFile(sourceRoot, relative);
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(destination) !== destination) {
      throw new Error('dist가 일반 프로젝트 폴더가 아닙니다. 경로를 확인해 주세요.');
    }
    fs.rmSync(destination, { recursive: true });
  }
  fs.mkdirSync(destination);
  for (const relative of DEPLOY_FILES) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relative), target);
  }
  return destination;
}

function build() {
  const result = verifySource();
  console.log(`소스 검사 완료 (${result.files}개 배포 파일)`);
  runTests();
  const destination = copyDeployFiles();
  console.log('빌드 완료: ' + destination);
}

if (require.main === module) {
  try { build(); } catch (error) { console.error('빌드 실패: ' + error.message); process.exitCode = 1; }
}
module.exports = { build, copyDeployFiles };
