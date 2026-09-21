'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DEPLOY_FILES } = require('./files.cjs');
const PROJECT_ROOT = path.resolve(__dirname, '..');

function assertRegularFile(root, relative) {
  const canonicalRoot = fs.realpathSync(root);
  const filename = path.resolve(root, relative);
  const local = path.relative(canonicalRoot, fs.realpathSync(filename));
  if (local.startsWith('..' + path.sep) || local === '..' || path.isAbsolute(local)) {
    throw new Error('프로젝트 밖의 파일은 사용할 수 없습니다: ' + relative);
  }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('일반 파일만 사용할 수 있습니다: ' + relative);
  }
  return filename;
}

function verifySource(root = PROJECT_ROOT) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 이상이 필요합니다.');
  for (const relative of DEPLOY_FILES) assertRegularFile(root, relative);
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const html = source.replace(/<!--[\s\S]*?-->/g, '');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  let inlineCount = 0;
  let cryptoScriptFound = false;
  for (const [, attributes, body] of scripts) {
    const src = attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (src) {
      if (src[1] === 'privateCrypto.js' || src[1] === './privateCrypto.js') cryptoScriptFound = true;
      if (!/^(?:https?:)?\/\//i.test(src[1])) {
        verifyReference(root, src[1]);
        new vm.Script(fs.readFileSync(path.join(root, src[1]), 'utf8'), { filename: src[1] });
      }
      continue;
    }
    const type = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i);
    if (type && !['text/javascript', 'application/javascript'].includes(type[1].toLowerCase())) {
      throw new Error('새 스크립트 형식은 검사 설정이 필요합니다: ' + type[1]);
    }
    new vm.Script(body, { filename: 'index.html inline script ' + (++inlineCount) });
  }
  if (!inlineCount || !cryptoScriptFound) throw new Error('앱 스크립트 또는 privateCrypto.js 연결이 없습니다.');
  new vm.Script(fs.readFileSync(path.join(root, 'privateCrypto.js'), 'utf8'), { filename: 'privateCrypto.js' });
  const staticMarkup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  for (const [, reference] of staticMarkup.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)) verifyReference(root, reference);
  }
  // These quoted URLs include the cover paths used in dynamic application HTML.
  for (const [, reference] of source.matchAll(/["'](\/?covers\/[A-Za-z0-9_./-]+)["']/g)) verifyReference(root, reference);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (!manifest.name || !Array.isArray(manifest.icons) || !manifest.icons.length) throw new Error('manifest.json의 앱 이름·아이콘을 확인해 주세요.');
  for (const icon of manifest.icons) verifyReference(root, icon.src);
  return { inlineScripts: inlineCount, files: DEPLOY_FILES.length };
}

function verifyReference(root, reference) {
  const relative = decodeURIComponent(String(reference).split(/[?#]/)[0]).replace(/^\.?\//, '');
  if (!DEPLOY_FILES.includes(relative)) throw new Error('배포 허용 목록에 없는 로컬 자산입니다: ' + reference);
  assertRegularFile(root, relative);
}

if (require.main === module) {
  try {
    const result = verifySource();
    console.log(`검사 완료: 인라인 스크립트 ${result.inlineScripts}개, 배포 파일 ${result.files}개`);
  } catch (error) { console.error('검사 실패: ' + error.message); process.exitCode = 1; }
}

module.exports = { PROJECT_ROOT, assertRegularFile, verifySource, verifyReference };
