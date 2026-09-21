const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const ensureSource=source.slice(source.indexOf('function ensureKey(){'),source.indexOf('/* 개인 기록 v2:'));
const guardSource=source.slice(source.indexOf('function privateSessionGuard('),source.indexOf('function ownPrivateEntries('));
const editStart=source.indexOf("  app.querySelectorAll('[data-edit-mine]')");
const editSource=source.slice(editStart,source.indexOf('  /* feed note-type filter pills */',editStart));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function flush(){for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));}

test('a delayed previous-session import cannot replace the current member key',async()=>{
  const old=deferred();
  const c={SESSION:{userId:'a',keyB64:'key-a'},CURRENT_KEY:null,CURRENT_KEY_OWNER:null,CURRENT_KEY_MATERIAL:null,
    Promise,Error,keyFromB64:material=>material==='key-a'?old.promise:Promise.resolve('crypto-b')};
  vm.createContext(c);vm.runInContext(ensureSource,c);
  const pending=c.ensureKey();const rejected=assert.rejects(pending,/로그인 정보/);
  c.SESSION={userId:'b',keyB64:'key-b'};
  assert.equal(await c.ensureKey(),'crypto-b');
  old.resolve('crypto-a');await rejected;
  assert.equal(c.CURRENT_KEY,'crypto-b');assert.equal(c.CURRENT_KEY_OWNER,'b');
  assert.equal(await c.ensureKey(),'crypto-b');
});

test('changing password material invalidates a cached key even for the same user',async()=>{
  const c={SESSION:{userId:'a',keyB64:'new'},CURRENT_KEY:'old-crypto',CURRENT_KEY_OWNER:'a',CURRENT_KEY_MATERIAL:'old',
    Promise,Error,keyFromB64:material=>Promise.resolve('crypto-'+material)};
  vm.createContext(c);vm.runInContext(ensureSource,c);
  assert.equal(await c.ensureKey(),'crypto-new');
});

function editHarness(){
  const decryption=deferred(),draftOpen=deferred();let handler,openCount=0;
  const button={getAttribute:()=> 'entry-a',addEventListener:(event,fn)=>{handler=fn;}};
  const c={SESSION:{userId:'a',keyB64:'key-a'},STATE:{privateEntries:{'entry-a':{id:'entry-a',bookId:'book',userId:'a'}}},
    app:{querySelectorAll:()=>[button]},route:{},location:{hash:''},Promise,Error,JSON,
    ensureKey:()=>Promise.resolve('crypto-a'),decryptPrivateRecord:()=>decryption.promise,
    openComposerWithDraft:(type,book,id,open)=>{openCount++;return draftOpen.promise.then(open);},
    showToast:()=>{},render:()=>{},mineEditingPayload:null,mineEditingId:null,mineComposerOpenFor:null};
  vm.createContext(c);vm.runInContext(guardSource+editSource,c);
  return {c,decryption,draftOpen,click:()=>handler(),opens:()=>openCount};
}

test('private edit decrypted after account switch never opens the previous member content',async()=>{
  const h=editHarness();h.click();await flush();
  h.c.SESSION={userId:'b',keyB64:'key-b'};
  h.decryption.resolve(JSON.stringify({title:'member a secret',html:'private'}));await flush();
  assert.equal(h.opens(),0);assert.equal(h.c.mineEditingPayload,null);
});

test('account switch while loading the edit draft cannot expose old decrypted content',async()=>{
  const h=editHarness();h.click();h.decryption.resolve(JSON.stringify({title:'member a secret'}));await flush();
  assert.equal(h.opens(),1);h.c.SESSION={userId:'b',keyB64:'key-b'};h.draftOpen.resolve(null);await flush();
  assert.equal(h.c.mineEditingPayload,null);assert.equal(h.c.mineEditingId,null);
});
