'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DEPLOY_FILES, isAllowedRemote, selectPublishPaths } = require('../scripts/files.cjs');
const { copyDeployFiles } = require('../scripts/build.cjs');

test('publishing accepts only the exact GROWELL GitHub repository', () => {
  for (const url of ['https://github.com/goondoing7-hue/growell-book-group.git', 'git@github.com:goondoing7-hue/growell-book-group.git', 'ssh://git@github.com/goondoing7-hue/growell-book-group.git']) assert.equal(isAllowedRemote(url), true);
  for (const url of ['https://github.com/goondoing7-hue/workboard.git', 'https://github.com/another/growell-book-group.git', 'https://github.com.evil.test/goondoing7-hue/growell-book-group.git', 'https://token@github.com/goondoing7-hue/growell-book-group.git']) assert.equal(isAllowedRemote(url), false);
});

test('publishing does not stage recovery files, secret files, fixtures or unknown paths', () => {
  assert.deepEqual(selectPublishPaths(['index.html', 'privateCrypto.js', '.env', 'growell-recovery-reader.json', 'covers/growell-recovery-reader.json', 'tests/review-mock.js', 'private-notes.json', 'dist/index.html', 'covers/action.jpg']), ['covers/action.jpg', 'index.html', 'privateCrypto.js']);
});

test('build output contains only deployable files and replaces obsolete output', t => {
  const taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'growell-build-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(taskRoot);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('growell-build-test-'));
    fs.rmSync(resolved, { recursive: true });
  });
  for (const relative of DEPLOY_FILES) {
    const target = path.join(taskRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'public sample');
  }
  for (const relative of ['growell-recovery-reader.json', '.env', 'tests/fixture.json', 'covers/private-key.json', 'dist/old-secret.json']) {
    const target = path.join(taskRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'must not publish');
  }
  const output = copyDeployFiles(taskRoot);
  const list = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? list(path.join(directory, entry.name)) : [path.relative(output, path.join(directory, entry.name)).replace(/\\/g, '/')]);
  assert.deepEqual(list(output).sort(), [...DEPLOY_FILES].sort());
  assert.equal(fs.readFileSync(path.join(taskRoot, '.env'), 'utf8'), 'must not publish');
});
