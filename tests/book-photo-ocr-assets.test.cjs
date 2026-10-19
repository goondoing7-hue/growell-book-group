'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const root=path.resolve(__dirname,'..'),manifest=require('../vendor/tesseract/manifest.json'),files=require('../scripts/files.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');

test('all pinned local OCR assets and their licenses are preserved by the publish allowlist',()=>{
  assert.equal(manifest.engineMode,'LSTM_ONLY');
  for(const item of manifest.files){
    const relative='vendor/tesseract/'+item.path,bytes=fs.readFileSync(path.join(root,relative));
    assert.ok(files.DEPLOY_FILES.includes(relative),relative);assert.ok(files.PUBLISH_FILES.includes(relative),relative);
    assert.equal(bytes.length,item.bytes,relative);assert.equal(hash(bytes),item.sha256,relative);
  }
  assert.ok(manifest.files.some(item=>/license/i.test(item.path)));assert.ok(manifest.files.some(item=>/notice/i.test(item.path)));
  assert.equal(manifest.packages.find(item=>item.name==='tesseract.js').version,'7.0.0');
});

test('Korean and English LSTM models decompress to the recorded, unmodified training data',()=>{
  assert.deepEqual(manifest.models.map(item=>item.language).sort(),['eng','kor']);
  for(const item of manifest.models){
    const bytes=zlib.gunzipSync(fs.readFileSync(path.join(root,'vendor/tesseract',item.path)));
    assert.equal(bytes.length,item.decompressedBytes);assert.equal(hash(bytes),item.decompressedSha256);
  }
});

test('all three browser WebAssembly choices and every configured OCR URL are deployed locally',()=>{
  assert.deepEqual(manifest.coreBinaries.map(item=>item.path).sort(),[
    'core/tesseract-core-lstm.wasm.js','core/tesseract-core-relaxedsimd-lstm.wasm.js','core/tesseract-core-simd-lstm.wasm.js'
  ]);
  for(const url of [manifest.runtime.script,manifest.runtime.workerPath])assert.ok(files.DEPLOY_FILES.includes(url.slice(1)));
  for(const directory of [manifest.runtime.corePath,manifest.runtime.langPath])assert.ok(directory.startsWith('/vendor/tesseract/'));
  assert.equal(manifest.runtime.legacyCore,false);assert.equal(manifest.runtime.legacyLang,false);assert.equal(manifest.runtime.oem,1);
});
