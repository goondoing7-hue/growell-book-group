const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
global.crypto = webcrypto;
const vault = require('../privateCrypto.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const profile = {id:'u-reader', loginId:'reader', name:'독서회원', authUserId:'auth-reader', salt:'salt'};
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a>=0 && b>a, `source section: ${start}`);
  return source.slice(a,b);
}
const copy = value => JSON.parse(JSON.stringify(value));
async function legacy(password, text, id='legacy') {
  const iv=webcrypto.getRandomValues(new Uint8Array(12));
  const data=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},password,new TextEncoder().encode(text));
  return {id,userId:profile.id,bookId:'emotion',createdAt:1720000000,updatedAt:1720000400,
    iv:Buffer.from(iv).toString('base64'),data:Buffer.from(data).toString('base64')};
}
async function modern(password, master, text, id='modern') {
  const entry={id,userId:profile.id,bookId:'thought',createdAt:1720000500,updatedAt:1720000600};
  return {...entry,...await vault.create(entry,password,master,text)};
}
function toRow(entry) {
  return {id:entry.id,user_id:entry.userId,book_id:entry.bookId,iv:entry.iv,data:entry.data,
    created_at:entry.createdAt,updated_at:entry.updatedAt||null};
}
function inputElement() {
  return {files:[],value:'',listeners:{},addEventListener(name,fn){this.listeners[name]=fn;}};
}
async function harness({entries=[], password, beforeWrite}={}) {
  password=password||await vault.newKey();
  const remote=Object.fromEntries(entries.map(entry=>[entry.id,toRow(entry)]));
  const writes=[],calls=[],migrations=[],downloads=[],toasts=[];
  const storage=new Map();
  const resetInput=inputElement();
  const nodes={
    'private-recovery-status':{textContent:'',style:{}},
    'fp-recovery-status':{textContent:'',style:{}},
    'fp-recovery-file':resetInput
  };
  let blob;
  const context={
    console,Promise,Date,Uint8Array,TextEncoder,TextDecoder,Blob,atob,btoa,crypto:webcrypto,
    setTimeout:()=>0,clearInterval(){},
    GrowellPrivateCrypto:vault,
    STATE:{users:{[profile.id]:copy(profile)},posts:{},comments:{},privateEntries:Object.fromEntries(entries.map(entry=>[entry.id,copy(entry)])),
      worksheets:{},materialNotes:{},habits:{},readingMeta:{},readingLogs:{},bookLocks:{},announcement:{next:{},reading:{}}},
    SESSION:{userId:profile.id,name:profile.name,keyB64:await vault.exportKey(password)},
    CURRENT_KEY:null,CURRENT_KEY_OWNER:null,CURRENT_KEY_MATERIAL:null,
    location:{hash:'#/profile/edit'},authMode:'login',
    keyFromB64:vault.importKey,urlFromPhoto:()=>null,esc:value=>String(value),render(){},
    localStorage:{setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},sessionStorage:{setItem(){}},
    showToast:(message,error)=>toasts.push({message,error}),
    migratePrivateDraftKeys:async keys=>{migrations.push(Array.from(keys));return {migrated:1};},
    callEdgeFunction:(name,body)=>{calls.push({name,body});return Promise.resolve({__status:200,ok:true});},
    doLogin:()=>Promise.resolve(),
    URL:{createObjectURL:value=>{blob=value;return 'blob:mock-recovery';},revokeObjectURL(){}},
    document:{
      querySelectorAll:()=>[],querySelector:()=>null,getElementById:id=>nodes[id]||null,
      body:{appendChild(){}},
      createElement(tag){
        assert.equal(tag,'a');
        return {href:'',download:'',click(){downloads.push({name:this.download,blob});},remove(){}};
      }
    },
    sb:{from(table){
      let operation='select',payload,filters=[];
      const query={
        select(){return query;},eq(key,value){filters.push([key,value]);return query;},maybeSingle(){return query;},
        update(value){operation='update';payload=copy(value);return query;},
        insert(value){operation='insert';payload=copy(value);return query;},
        delete(){operation='delete';return query;},upsert(value){operation='upsert';payload=copy(value);return query;},
        then(resolve,reject){
          return Promise.resolve().then(()=>{
            assert.equal(table,'private_entries');
            if(operation==='select') return {data:copy(Object.values(remote).filter(row=>filters.every(([key,value])=>row[key]===value))),error:null};
            const id=filters.find(([key])=>key==='id')?.[1]||payload?.id;
            const request={table,operation,payload,filters,id};writes.push(request);
            const failure=beforeWrite&&beforeWrite(request,writes.length);
            if(failure) return {data:null,error:failure};
            if(!remote[id] || !filters.every(([key,value])=>remote[id][key]===value)) return {data:null,error:null};
            remote[id]={...remote[id],...payload};
            return {data:{id},error:null};
          }).then(resolve,reject);
        }
      };
      return query;
    }}
  };
  vm.createContext(context);
  vm.runInContext(section('function mapPrivateEntryRow(', 'function mapMaterialNoteRow('),context);
  vm.runInContext(section('function mapHabitRow(', '\nvar STATE ='),context);
  vm.runInContext(section('var saving = false;', '/* ---------------- toast'),context);
  vm.runInContext(section('function ensureKey(', '/* 비밀번호 힌트 새로 등록/변경'),context);
  vm.runInContext(section('function doForgotPassword(', '/* ---------------- content actions'),context);
  return {c:context,remote,writes,calls,migrations,downloads,toasts,resetInput,nodes,password};
}

test('integrated recovery restores legacy and v2 notes with a new password, preserving IDs and timestamps',async()=>{
  const oldPassword=await vault.newKey(),newPassword=await vault.newKey(),master=await vault.newKey();
  const texts=[JSON.stringify({title:'기존 기록',html:'<p>원래 내용</p>',photo:{dataUrl:'data:image/png;base64,AAAA'}}),'새 방식 기록'];
  const entries=[await legacy(oldPassword,texts[0]),await modern(oldPassword,master,texts[1])];
  const kit=await vault.parseRecovery(JSON.stringify(await vault.recoveryFile(profile,[master],[oldPassword])));
  const {c,migrations,remote}=await harness({entries,password:newPassword});
  c.pendingPrivateRecovery=kit;c.selectedResetRecovery=kit;
  assert.equal(await c.completePendingPrivateRecovery(),true);
  assert.equal(c.pendingPrivateRecovery,null);assert.equal(c.selectedResetRecovery,null);assert.equal(c.privateRecoveryBusy,false);
  assert.equal(migrations.length,1);assert.deepEqual(migrations[0],kit.legacyKeys);
  for(let i=0;i<entries.length;i++){
    const original=entries[i],saved=c.STATE.privateEntries[original.id];
    assert.deepEqual([saved.id,saved.userId,saved.bookId,saved.createdAt,saved.updatedAt],
      [original.id,original.userId,original.bookId,original.createdAt,original.updatedAt]);
    assert.equal((await vault.read(saved,newPassword)).text,texts[i]);
    await assert.rejects(vault.read(saved,oldPassword));
    assert.equal(remote[saved.id].data,saved.data);
    assert.ok(vault.envelope(saved),'legacy record is upgraded');
  }
});

test('integrated recovery keeps its file pending after a partially failed save and succeeds on retry',async()=>{
  const oldPassword=await vault.newKey(),newPassword=await vault.newKey(),master=await vault.newKey();
  const entries=[await legacy(oldPassword,'첫째'),await modern(oldPassword,master,'둘째')];
  const kit=await vault.recoveryFile(profile,[master],[oldPassword]);
  let fail=true;
  const {c,remote,writes,migrations}=await harness({entries,password:newPassword,beforeWrite:request=>{
    if(request.id==='modern'&&fail){fail=false;return new Error('temporary network failure');}
  }});
  c.pendingPrivateRecovery=kit;
  assert.equal(await c.completePendingPrivateRecovery(),false);
  assert.equal(c.pendingPrivateRecovery,kit);assert.equal(c.privateRecoveryBusy,false);
  assert.notEqual(remote.legacy.data,entries[0].data,'first remote write was committed');
  assert.equal(c.STATE.privateEntries.legacy.data,entries[0].data,'failed batch left the local snapshot intact');
  assert.equal(migrations.length,0,'draft migration waits for successful record save');
  assert.equal(await c.completePendingPrivateRecovery(),true);
  assert.equal(writes.length,4);assert.equal(c.pendingPrivateRecovery,null);assert.equal(migrations.length,1);
  assert.equal((await vault.read(c.STATE.privateEntries.legacy,newPassword)).text,'첫째');
  assert.equal((await vault.read(c.STATE.privateEntries.modern,newPassword)).text,'둘째');
});

test('export creates a valid recovery file before the first private record exists',async()=>{
  const {c,password,downloads,writes}=await harness();
  const button={disabled:false};
  await c.exportPrivateRecovery(button);
  assert.equal(downloads.length,1);assert.equal(button.disabled,false);assert.equal(c.privateRecoveryBusy,false);
  assert.equal(writes.length,0);
  const kit=await vault.parseRecovery(await downloads[0].blob.text());
  vault.assertOwner(kit,profile);
  assert.equal(downloads[0].name,'growell-recovery-reader.json');
  assert.ok(kit.keys.length);assert.ok(kit.legacyKeys.includes(await vault.exportKey(password)));
  const later=await modern(password,await vault.newKey(),'이후 다른 기기의 기록','future');
  assert.equal((await vault.recover(later,kit)).text,'이후 다른 기기의 기록');
});

test('missing recovery file blocks password-reset server calls',async()=>{
  const {c,calls}=await harness();
  c.doForgotPassword('reader','hint','new-password','new-password',{});
  assert.equal(calls.length,0);assert.equal(c.pendingPrivateRecovery,null);
});

test('missing profile data blocks reset until recovery-file ownership can be verified',async()=>{
  const {c,calls}=await harness();
  c.selectedResetRecovery=await vault.parseRecovery(JSON.stringify(await vault.recoveryFile(profile,[await vault.newKey()],[])));
  c.STATE.users={};
  c.doForgotPassword('reader','hint','new-password','new-password',{});
  assert.equal(calls.length,0);assert.equal(c.pendingPrivateRecovery,null);
});

test('invalid recovery-file selection clears any prior file and blocks password reset',async()=>{
  const {c,calls,resetInput,nodes}=await harness();
  c.selectedResetRecovery=await vault.recoveryFile(profile,[await vault.newKey()],[]);
  c.bindPrivateRecovery();
  resetInput.files=[{size:8,text:async()=> 'not-json'}];
  await resetInput.listeners.change();
  assert.equal(c.selectedResetRecovery,null);assert.match(nodes['fp-recovery-status'].textContent,/복구 파일/);
  c.doForgotPassword('reader','hint','new-password','new-password',{});
  assert.equal(calls.length,0);
});

test('a well-formed recovery file from a different login or account blocks password reset',async()=>{
  for(const otherProfile of [{...profile,id:'other',loginId:'other'}, {...profile,id:'other'}, {...profile,authUserId:'other-auth'}]){
    const {c,calls}=await harness();
    c.selectedResetRecovery=await vault.parseRecovery(JSON.stringify(await vault.recoveryFile(otherProfile,[await vault.newKey()],[])));
    c.doForgotPassword('reader','hint','new-password','new-password',{});
    assert.equal(calls.length,0,JSON.stringify(otherProfile));
    assert.equal(c.pendingPrivateRecovery,null);
  }
});

test('a corrupted recovery-key fingerprint is rejected by selection before reset can contact the server',async()=>{
  const {c,calls,resetInput}=await harness();
  const kit=await vault.recoveryFile(profile,[await vault.newKey()],[]);
  kit.keys[0].id='0'.repeat(64);
  const text=JSON.stringify(kit);
  c.bindPrivateRecovery();resetInput.files=[{size:text.length,text:async()=>text}];
  await resetInput.listeners.change();
  assert.equal(c.selectedResetRecovery,null);
  c.doForgotPassword('reader','hint','new-password','new-password',{});
  assert.equal(calls.length,0);
});
