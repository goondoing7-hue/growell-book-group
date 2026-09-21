'use strict';

const { spawnSync } = require('node:child_process');
const { PROJECT_ROOT, assertRegularFile } = require('./check.cjs');
const { TEST_FILES } = require('./files.cjs');

function runTests(root = PROJECT_ROOT) {
  for (const relative of TEST_FILES) assertRegularFile(root, relative);
  const result = spawnSync(process.execPath, ['--test', ...TEST_FILES], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('테스트가 실패했습니다.');
}

if (require.main === module) {
  try { runTests(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { runTests };
