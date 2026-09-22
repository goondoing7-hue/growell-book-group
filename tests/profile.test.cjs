'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const profile=require('../profile.js');
const html=fs.readFileSync(require('node:path').join(__dirname,'..','index.html'),'utf8');
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {resolve,promise};}

test('avatar uploads reject unsupported and excessive files before decoding',()=>{
  assert.equal(profile.validateFile({type:'image/jpeg',size:50000}), '');
  assert.match(profile.validateFile({type:'image/svg+xml',size:30}),/JPG/);
  assert.match(profile.validateFile({type:'image/jpeg',size:16*1024*1024}),/15MB/);
  assert.match(profile.validateFile({type:'image/png',size:0}),/비어/);
});
test('avatar URL accepts raster data and HTTPS, rejecting active schemes and embedded credentials',()=>{
  assert.equal(profile.safeAvatarUrl('data:image/jpeg;base64,YWJj'), 'data:image/jpeg;base64,YWJj');
  assert.equal(profile.safeAvatarUrl('https://example.test/avatar.jpg'), 'https://example.test/avatar.jpg');
  for(const value of ['javascript:alert(1)','data:image/svg+xml,<svg/>','http://example.test/a','https://user:pw@example.test/a','" onerror="alert(1)']) assert.equal(profile.safeAvatarUrl(value),'');
});
test('portrait and landscape photos are centered without stretching',()=>{
  assert.deepEqual(profile.cropBounds(600,1200),{x:0,y:300,side:600});
  assert.deepEqual(profile.cropBounds(1600,800),{x:400,y:0,side:800});
  assert.throws(()=>profile.cropBounds(0,100));
  assert.throws(()=>profile.cropBounds(10000,10000));
});
function editHarness(upload){
  const c={Promise,STATE:{users:{a:{id:'a',name:'기존',authUserId:'auth-a',avatar:'https://example.test/old.jpg'},b:{id:'b',name:'다른 회원',authUserId:'auth-b'}}},SESSION:{userId:'a',name:'기존'},saveSessionEpoch:1,
    GrowellProfile:profile,pendingProfileAvatar:'data:image/jpeg;base64,YWJj',localStorage:{setItem(){}},location:{hash:'#/profile/edit'},showToast(){},writes:[],uploadPhotoIfNeeded:upload||(()=>Promise.resolve({dataUrl:'https://example.test/new.jpg'}))};
  c.saveState=async function(mutate,options){mutate(c.STATE);c.writes.push(JSON.parse(JSON.stringify(c.STATE)));options.onSuccess();return true;};
  vm.createContext(c);vm.runInContext(section('function doEditProfile(','function ensureKey('),c);return c;
}
test('profile saves nickname and selected avatar together',async()=>{
  const c=editHarness();await c.doEditProfile('새 별명','data:image/jpeg;base64,YWJj');
  assert.equal(c.STATE.users.a.name,'새 별명');assert.equal(c.STATE.users.a.avatar,'https://example.test/new.jpg');
  assert.equal(c.SESSION.name,'새 별명');assert.equal(c.pendingProfileAvatar,undefined);
});
test('unchanged photo stays intact, while explicit removal clears it',async()=>{
  const c=editHarness(()=>{throw new Error('should not upload');});
  await c.doEditProfile('이름만 수정',undefined);assert.equal(c.STATE.users.a.avatar,'https://example.test/old.jpg');
  await c.doEditProfile('사진 삭제',null);assert.equal(c.STATE.users.a.avatar,null);
});
test('late upload cannot edit the next signed-in member or overwrite former profile',async()=>{
  const upload=deferred(),c=editHarness(()=>upload.promise);
  const save=c.doEditProfile('새 이름','data:image/jpeg;base64,YWJj');
  c.SESSION={userId:'b',name:'다른 회원'};c.saveSessionEpoch++;
  upload.resolve({dataUrl:'https://example.test/new.jpg'});await save;
  assert.equal(c.writes.length,0);assert.equal(c.STATE.users.a.name,'기존');assert.equal(c.STATE.users.b.name,'다른 회원');
});
test('selecting and removing a photo preserves the rest of the form without rendering',async()=>{
  const nodes={};
  ['pe-avatar-input','btn-pe-avatar-pick','pe-avatar-preview','btn-pe-avatar-clear','pe-avatar-status','btn-pe-save','pe-name'].forEach(id=>{
    nodes[id]={isConnected:true,value:id==='pe-name'?'수정 중인 이름':'',handlers:{},addEventListener(event,fn){this.handlers[event]=fn;}};
  });
  const c={document:{getElementById:id=>nodes[id]},SESSION:{userId:'a'},authFlowEpoch:1,GrowellProfile:profile,esc:s=>s,svgIcon:()=>'<svg/>',I_IMG:'',showToast(){},resizeAvatarDataUrl:async()=> 'data:image/jpeg;base64,YWJj'};
  vm.createContext(c);vm.runInContext(section('function bindProfilePhotoPicker(','/* 나눔/나의 공간/자료실에 첨부하는 사진:'),c);
  let value;c.bindProfilePhotoPicker('pe',v=>{value=v;});
  nodes['pe-avatar-input'].files=[{type:'image/jpeg',size:1000}];nodes['pe-avatar-input'].handlers.change();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(value,'data:image/jpeg;base64,YWJj');assert.equal(nodes['pe-name'].value,'수정 중인 이름');
  assert.equal(nodes['btn-pe-save'].disabled,false);assert.equal(nodes['btn-pe-avatar-clear'].hidden,false);
  nodes['btn-pe-avatar-clear'].handlers.click();assert.equal(value,null);assert.equal(nodes['pe-name'].value,'수정 중인 이름');
});
