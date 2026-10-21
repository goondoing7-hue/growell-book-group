'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
if(!global.crypto)Object.defineProperty(global,'crypto',{value:require('node:crypto').webcrypto});
const oauth=require('../oauthDomain.js'),privateCrypto=require('../privateCrypto.js');
const owner='11111111-2222-3333-4444-555555555555',other='99999999-2222-3333-4444-555555555555';
const password='temporary-password-가나다',salt='0123456789abcdef0123456789abcdef';
test('new OAuth vault unlocks the same private key across fresh calls',async()=>{
  const made=await oauth.createVault(password,salt,owner);
  assert.equal(await oauth.unlockVault(password,JSON.parse(JSON.stringify(made.envelope)),owner),made.keyB64);
  assert.equal(Buffer.from(made.keyB64,'base64').length,32);
  assert.ok(!JSON.stringify(made.envelope).includes(made.keyB64));
  assert.ok(!JSON.stringify(made.envelope).includes(password));
});
test('wrong password or a tampered envelope never replaces the original key',async()=>{
  const made=await oauth.createVault(password,salt,owner),before=JSON.stringify(made.envelope);
  await assert.rejects(oauth.unlockVault('wrong-password',made.envelope,owner),/기록은 그대로/);
  const changed=JSON.parse(before);changed.data=(changed.data[0]==='A'?'B':'A')+changed.data.slice(1);
  await assert.rejects(oauth.unlockVault(password,changed,owner));
  assert.equal(JSON.stringify(made.envelope),before);
});
test('changing owner even with a valid envelope and password cannot open another member vault',async()=>{
  const made=await oauth.createVault(password,salt,owner);
  await assert.rejects(oauth.unlockVault(password,made.envelope,other));
  const forged={...made.envelope,owner:other};
  await assert.rejects(oauth.unlockVault(password,forged,other));
});
test('invalid salt, weak password, enormous ciphertext and unsupported KDF fail before use',async()=>{
  await assert.rejects(oauth.createVault('short',salt,owner));
  await assert.rejects(oauth.createVault(password,'not-hex',owner));
  const made=await oauth.createVault(password,salt,owner);
  assert.throws(()=>oauth.validateEnvelope({...made.envelope,data:'A'.repeat(5000)},owner));
  assert.throws(()=>oauth.validateEnvelope({...made.envelope,kdf:{...made.envelope.kdf,iterations:1}},owner));
});
test('OAuth private key works with existing v2 notes and recovery files without changing note identity',async()=>{
  const made=await oauth.createVault(password,salt,owner),key=await privateCrypto.importKey(made.keyB64),dataKey=await privateCrypto.newKey();
  const identity={id:'private-note-1',userId:'u-social-test',bookId:'emotion',createdAt:1770000000000};
  const entry={...identity,...await privateCrypto.create(identity,key,dataKey,'개인적인 독서 기록')};
  const before=JSON.stringify(entry),reopened=await privateCrypto.importKey(await oauth.unlockVault(password,made.envelope,owner));
  assert.equal((await privateCrypto.read(entry,reopened)).text,'개인적인 독서 기록');
  const kit=await privateCrypto.recoveryFile({id:identity.userId,loginId:'social-test',authUserId:owner},[dataKey],[key]);
  assert.equal((await privateCrypto.recover(entry,kit)).text,'개인적인 독서 기록');
  assert.equal(JSON.stringify(entry),before);
});
test('rewrapping a supplied private key changes only the password envelope',async()=>{
  const made=await oauth.createVault(password,salt,owner);
  const updated=await oauth.createVault('another-password',oauth.newSalt(),owner,made.keyB64);
  assert.equal(updated.keyB64,made.keyB64);
  assert.notEqual(updated.envelope.data,made.envelope.data);
  assert.equal(await oauth.unlockVault('another-password',updated.envelope,owner),made.keyB64);
});
async function nativeKey(passwordValue,saltValue){
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(passwordValue),'PBKDF2',false,['deriveBits']);
  return Buffer.from(await crypto.subtle.deriveBits({name:'PBKDF2',salt:Buffer.from(saltValue,'hex'),iterations:150000,hash:'SHA-256'},base,256)).toString('base64');
}
test('existing password member linking preserves the exact key with an independent wrapping salt',async()=>{
  const existingKey=await nativeKey(password,salt),made=await oauth.createLinkedVault(password,salt,owner,existingKey);
  assert.equal(made.keyB64,existingKey);assert.notEqual(made.envelope.kdf.salt,salt);
  assert.equal(await oauth.unlockVault(password,made.envelope,owner),existingKey);
  assert.equal(await oauth.verifyLinkedKey(password,salt,owner,existingKey),true);
  assert.ok(!JSON.stringify(made.envelope).includes(existingKey));
});
test('linking refuses mismatched password or original key instead of generating a replacement',async()=>{
  const existingKey=await nativeKey(password,salt);
  await assert.rejects(oauth.createLinkedVault('another-current-password',salt,owner,existingKey),/열쇠가 일치/);
  await assert.rejects(oauth.createLinkedVault(password,salt,owner,Buffer.alloc(32,7).toString('base64')),/열쇠가 일치/);
  await assert.rejects(oauth.createLinkedVault(password,salt,owner,Buffer.alloc(16).toString('base64')),/기존 개인 기록/);
});
