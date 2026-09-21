const test=require('node:test');
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
global.crypto=webcrypto;
const vault=require('../privateCrypto.js');
const profile={id:'u-test',authUserId:'auth-test',loginId:'reader'};
const identity={id:'e-test',userId:profile.id,bookId:'emotion',createdAt:1720000000};
async function legacy(key,text,id='e-legacy'){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(text));
  return {...identity,id,iv:Buffer.from(iv).toString('base64'),data:Buffer.from(data).toString('base64')};
}
async function record(password,key,text,id=identity.id){const meta={...identity,id};return {...meta,...await vault.create(meta,password,key,text)};}
test('legacy notes and photos are readable without modifying the original ciphertext',async()=>{
  const password=await vault.newKey(), text=JSON.stringify({title:'기존 기록',html:'<p>안녕</p>',photo:{dataUrl:'data:image/png;base64,AAAA'}});
  const entry=await legacy(password,text), copy=JSON.stringify(entry);
  assert.equal((await vault.read(entry,password)).text,text);assert.equal(JSON.stringify(entry),copy);
});
test('password rewrap changes the revision IV while preserving encrypted body and record identity',async()=>{
  const oldPassword=await vault.newKey(),newPassword=await vault.newKey(),master=await vault.newKey();
  const original=await record(oldPassword,master,'개인적인 기록');
  const changed={...original,...await vault.rewrap(original,newPassword,master)};
  assert.equal((await vault.read(changed,newPassword)).text,'개인적인 기록');
  await assert.rejects(vault.read(changed,oldPassword));
  assert.deepEqual(vault.envelope(changed).body,vault.envelope(original).body);
  assert.notEqual(changed.iv,original.iv);assert.equal(changed.id,original.id);assert.equal(changed.createdAt,original.createdAt);
});
test('a recovery file survives future entries, other initial devices and repeated password resets',async()=>{
  const firstPassword=await vault.newKey(),secondPassword=await vault.newKey(),thirdPassword=await vault.newKey();
  const fileMaster=await vault.newKey(),otherDeviceMaster=await vault.newKey();
  const kit=await vault.parseRecovery(JSON.stringify(await vault.recoveryFile(profile,[fileMaster],[firstPassword])));
  // File can be exported before there are any notes, including on a different device.
  const later=await record(firstPassword,otherDeviceMaster,'나중에 작성한 기록');
  const recovered=await vault.recover(later,kit);assert.equal(recovered.text,'나중에 작성한 기록');
  const normalized=await record(secondPassword,fileMaster,recovered.text);
  const future=await record(secondPassword,fileMaster,'다른 기기에서 이후 작성','e-future');
  for(const entry of [normalized,future]){
    const again=await vault.recover(entry,kit);
    const next={...entry,...await vault.create(entry,thirdPassword,fileMaster,again.text)};
    assert.equal((await vault.read(next,thirdPassword)).text,again.text);
  }
});
test('one recovery file restores legacy and v2 records without old login password',async()=>{
  const password=await vault.newKey(),master=await vault.newKey();
  const kit=await vault.recoveryFile(profile,[master],[password]);
  assert.equal((await vault.recover(await legacy(password,'이전 방식'),kit)).text,'이전 방식');
  assert.equal((await vault.recover(await record(password,master,'새 방식'),kit)).text,'새 방식');
});
test('record user/id swaps, ciphertext tampering and the wrong recovery owner are rejected',async()=>{
  const password=await vault.newKey(),master=await vault.newKey(),entry=await record(password,master,'내용');
  await assert.rejects(vault.read({...entry,userId:'other'},password));
  await assert.rejects(vault.read({...entry,id:'e-other'},password));
  const box=vault.envelope(entry);box.body.data='AAAA'+box.body.data.slice(4);
  await assert.rejects(vault.read({...entry,data:Buffer.from(JSON.stringify(box)).toString('base64')},password));
  const kit=await vault.recoveryFile(profile,[master],[password]);
  assert.throws(()=>vault.assertOwner(kit,{...profile,id:'different'}));
  await assert.rejects(vault.recover({...entry,userId:'other'},kit));
});
test('malformed/oversized recovery files and mismatched key fingerprints are rejected',async()=>{
  await assert.rejects(vault.parseRecovery('not json'));
  await assert.rejects(vault.parseRecovery(' '.repeat(262145)));
  const kit=await vault.recoveryFile(profile,[await vault.newKey()],[]);
  kit.keys[0].id='0'.repeat(64);await assert.rejects(vault.parseRecovery(JSON.stringify(kit)));
});
test('server envelope contains no plaintext note or raw recovery key',async()=>{
  const password=await vault.newKey(),master=await vault.newKey(),text='고유한 비공개 기록 12345';
  const entry=await record(password,master,text),json=JSON.stringify(vault.envelope(entry));
  assert.ok(!json.includes(text));assert.ok(!json.includes(await vault.exportKey(master)));
});
