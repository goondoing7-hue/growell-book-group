'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const backup=require('../driveBackup.js');
const origin='https://growell-book.vercel.app';
const response=(data={configured:true,connected:false},extra={})=>({ok:true,status:200,json:async()=>data,...extra});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(extra={}){
  let current=true,tokenReads=0;const calls=[];
  const client=backup.createClient({isCurrent:()=>current,getAccessToken:()=>{tokenReads++;return Promise.resolve('SYNTHETIC_BEARER_TOKEN');},
    fetch:async(url,options)=>{calls.push({url,options});return response();},...extra});
  return {client,calls,setCurrent:value=>{current=value;},get tokenReads(){return tokenReads;}};
}
const rejectsCode=(promise,code)=>assert.rejects(promise,error=>error.code===code);

test('Drive config is a public same-origin read and status requires the current access token',async()=>{
  const box=harness();await box.client.request('config',{owner:'PRIVATE_OWNER'});
  assert.equal(box.tokenReads,0);assert.equal(box.calls[0].url,'/api/drive-backup?action=config');
  assert.deepEqual(box.calls[0].options.headers,{Accept:'application/json'});
  await box.client.request('status',{owner:'PRIVATE_OWNER'});
  assert.equal(box.tokenReads,1);assert.equal(box.calls[1].url,'/api/drive-backup?action=status');
  assert.deepEqual(box.calls[1].options.headers,{Accept:'application/json',Authorization:'Bearer SYNTHETIC_BEARER_TOKEN'});
  for(const {url,options} of box.calls){
    assert.equal(options.method,'GET');assert.equal(options.body,undefined);
    assert.equal(options.mode,'same-origin');assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
    assert.ok(options.signal instanceof AbortSignal);assert.doesNotMatch(url,/TOKEN|OWNER/);
  }
});

test('Drive changes cannot send record contents, recovery keys, OAuth tokens or arbitrary owner IDs',async()=>{
  const box=harness();const fields={userId:'PRIVATE_OWNER',keyB64:'PRIVATE_KEY',legacyKeys:['PRIVATE_LEGACY'],records:'PRIVATE_RECORDS',token:'PRIVATE_REFRESH',folderId:'PRIVATE_FOLDER',enabled:true};
  for(const action of ['connect','sync','configure','disconnect']){
    await box.client.request(action,fields);const {options}=box.calls.at(-1);
    assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),action==='configure'?{enabled:true}:{});
    assert.doesNotMatch(options.body,/PRIVATE_|keyB64|token|userId|records|folderId/);
  }
  await box.client.request('configure',{...fields,enabled:false});assert.deepEqual(JSON.parse(box.calls.at(-1).options.body),{enabled:false});
});

test('unsupported actions and malformed settings never reach auth or network',async()=>{
  const box=harness();
  for(const action of ['worker','callback','status&owner=x','constructor','__proto__','toString',null,undefined])await rejectsCode(box.client.request(action),'invalid_action');
  for(const payload of [null,undefined,{}, {enabled:'true'}, {enabled:1}, {enabled:0}])await rejectsCode(box.client.request('configure',payload),'invalid_settings');
  assert.equal(box.tokenReads,0);assert.deepEqual(box.calls,[]);
});

test('logged-out or switched users cannot send requests with a previous identity',async()=>{
  const token=deferred(),box=harness({getAccessToken:()=>token.promise});
  const pending=box.client.request('sync');await flush();box.setCurrent(false);token.resolve('PREVIOUS_USER_TOKEN');
  await rejectsCode(pending,'session_changed');assert.deepEqual(box.calls,[]);
  await rejectsCode(box.client.request('status'),'session_changed');
});

test('late responses cannot update a different member session',async()=>{
  const answer=deferred(),box=harness({fetch:()=>answer.promise});
  const pending=box.client.request('status');await flush();box.setCurrent(false);answer.resolve(response({configured:true,connected:true,accountEmail:'previous@example.invalid'}));
  await rejectsCode(pending,'session_changed');
});

test('closing the modal aborts in-flight requests and blocks future reads',async()=>{
  let signal;const box=harness({fetch:(url,options)=>new Promise((resolve,reject)=>{
    signal=options.signal;signal.addEventListener('abort',()=>reject(Object.assign(new Error('PRIVATE_FAILURE'),{name:'AbortError'})));
  })});
  const pending=box.client.request('status');await flush();box.client.dispose();
  assert.equal(signal.aborted,true);await rejectsCode(pending,'session_changed');await rejectsCode(box.client.request('config'),'session_changed');
});

test('concurrent backup mutations do not duplicate jobs',async()=>{
  const answer=deferred(),box=harness({fetch:()=>answer.promise});
  const pending=box.client.request('sync');await flush();await rejectsCode(box.client.request('disconnect'),'busy');
  answer.resolve(response({queued:true}));await pending;
});

test('missing tokens and unsafe error content do not leak into UI',async()=>{
  for(const token of ['',null,undefined,3,{}]){
    const box=harness({getAccessToken:async()=>token});await rejectsCode(box.client.request('status'),'auth_required');assert.deepEqual(box.calls,[]);
  }
  const box=harness({fetch:async()=>response({error:'Bearer PRIVATE_SECRET <script>'},{ok:false,status:500})});
  await rejectsCode(box.client.request('status'),'unavailable');
  for(const error of [new Error('PRIVATE_SECRET'),{code:'PRIVATE_SECRET'}, {code:'reconnect_required',message:'PRIVATE_SECRET'}, null])assert.doesNotMatch(backup.message(error),/PRIVATE|<script>|Bearer/);
});

test('malformed bodies and transport failures remain recoverable errors',async()=>{
  for(const value of [null,undefined,[],true,'connected']){
    const box=harness({fetch:async()=>response(null,{json:async()=>value})});await rejectsCode(box.client.request('status'),'unavailable');
  }
  const box=harness({fetch:async()=>{throw Object.assign(new Error('transport'),{name:'AbortError'});}});await rejectsCode(box.client.request('status'),'timeout');
});

test('OAuth navigation only accepts Google authorize with this app’s exact callback',()=>{
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');url.searchParams.set('redirect_uri',origin+'/api/drive-backup');url.searchParams.set('state','synthetic');
  assert.equal(backup.authorizationUrl(url.href,origin),url.href);
  for(const invalid of [url.href.replace('https:','http:'),url.href.replace('accounts.google.com','accounts.google.com.evil.invalid'),url.href.replace('accounts.google.com','x:y@accounts.google.com'),url.href.replace('accounts.google.com','accounts.google.com:8443'),url.href+'#fragment',url.href.replace('/auth?','/token?'),'javascript:alert(1)','/relative'])assert.equal(backup.authorizationUrl(invalid,origin),'');
  for(const redirect of ['https://evil.invalid/callback',origin+'/api/drive-backup?action=callback',origin+'/api/drive-backup#fragment']){
    const invalid=new URL(url);invalid.searchParams.set('redirect_uri',redirect);assert.equal(backup.authorizationUrl(invalid.href,origin),'');
  }
  const duplicate=new URL(url);duplicate.searchParams.append('redirect_uri',origin+'/api/drive-backup');assert.equal(backup.authorizationUrl(duplicate.href,origin),'');
});

test('Drive folder links cannot open arbitrary domains or script URLs',()=>{
  const valid='https://drive.google.com/drive/folders/Synthetic_123-abc';assert.equal(backup.folderUrl(valid),valid);
  for(const candidate of [valid.replace('https:','http:'),valid.replace('drive.google.com','drive.google.com.evil.invalid'),valid.replace('drive.google.com','user@drive.google.com'),valid+'?token=secret',valid+'#fragment','javascript:alert(1)','https://drive.google.com/drive/folders/','https://drive.google.com/file/d/synthetic'])assert.equal(backup.folderUrl(candidate),'');
});

test('backup status does not infer connection or success from missing or malformed data',()=>{
  for(const value of [null,{}, {configured:'true'},{configured:true},{configured:true,connected:'true'}])assert.throws(()=>backup.statusView(value),error=>error.code==='unavailable');
  const unavailable=backup.statusView({configured:false});assert.equal(unavailable.connected,false);assert.match(backup.stateText(unavailable),/준비 중/);
  const status=backup.statusView({configured:true,connected:true,enabled:true,lastBackedUpAt:'not a date',pending:'3',folderUrl:'javascript:alert(1)',accessToken:'PRIVATE_TOKEN',errorCode:'<script>'});
  assert.equal(status.lastBackedUpAt,'');assert.equal(status.folderUrl,'');assert.equal(status.pending,false);assert.equal(status.errorCode,'');assert.doesNotMatch(JSON.stringify(status),/PRIVATE|script/);
  assert.match(backup.stateText(status),/첫 백업 대기/);assert.doesNotMatch(backup.stateText(status),/백업 완료/);
});

test('backup status distinguishes pending, busy, paused, failed and confirmed success',()=>{
  const base={configured:true,connected:true,enabled:true,lastBackedUpAt:'2026-10-04T03:10:00Z'};
  assert.match(backup.stateText(backup.statusView(base)),/최근 백업 완료/);
  assert.match(backup.stateText(backup.statusView({...base,pending:2})),/백업할 예정/);
  assert.match(backup.stateText(backup.statusView({...base,busy:true})),/백업하고 있어요/);
  assert.match(backup.stateText(backup.statusView({...base,enabled:false})),/일시 중지/);
  assert.match(backup.stateText(backup.statusView({...base,enabled:false,pending:true})),/일시 중지/);
  assert.match(backup.stateText(backup.statusView({...base,errorCode:'reconnect_required'})),/다시 연결/);
});

test('backend backup errors describe repair without promising reconnect will recreate missing files',()=>{
  assert.match(backup.message({code:'backup-storage-full'}),/저장 공간/);
  assert.match(backup.message({code:'backup-busy'}),/이전 백업/);
  assert.match(backup.message({code:'backup-folder-unsafe'}),/공유를 해제/);
  assert.match(backup.message({code:'backup-file-unsafe'}),/공유를 해제/);
  assert.match(backup.message({code:'backup-remote-missing'}),/휴지통에서 복원/);
  assert.doesNotMatch(backup.message({code:'backup-remote-missing'}),/다시 연결/);
  assert.match(backup.message({code:'backup-too-large'}),/기존 백업은 유지/);
  assert.match(backup.message({code:'backup-permission-denied'}),/필요한 권한/);
  assert.match(backup.message({code:'backup-deferred'}),/대기 중/);
});

test('profile entry, callback and logout wire the same account-scoped dialog',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const header=html.slice(html.indexOf('function headerHtml('),html.indexOf('function headerHtml(')+6000);
  assert.ok(header.indexOf('id="btn-profile-drive-backup"')>header.indexOf('id="btn-goto-profile-edit"'));
  assert.ok(header.indexOf('id="btn-profile-drive-backup"')<header.indexOf('id="btn-logout"'));
  assert.match(html,/function openDriveBackup\(trigger\)[\s\S]*?SESSION===session&&saveSessionEpoch===epoch&&location\.href===route/);
  assert.match(html,/function clearMemberSession\(\)[\s\S]*?GrowellDriveBackup\.close\(false\)/);
  assert.match(html,/function handleDriveBackupReturn\(\)[\s\S]*?if\(!SESSION\)return;[\s\S]*?searchParams\.delete\('drive-backup'\)/);
  assert.match(html,/bindEvents\(route\);[\s\S]*?handleDriveBackupReturn\(\)/);
});
