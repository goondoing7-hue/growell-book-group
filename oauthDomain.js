(function(root,factory){
  var api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.GrowellOAuth=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var FORMAT='growell-oauth-vault-v1',ITERATIONS=150000;
  var enc=new TextEncoder(),dec=new TextDecoder();
  function bytes(value){
    if(typeof value!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw new Error('개인 기록 열쇠의 형식을 확인할 수 없어요.');
    var raw=atob(value),out=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;
  }
  function b64(value){var text='';for(var i=0;i<value.length;i++)text+=String.fromCharCode(value[i]);return btoa(text);}
  function owner(value){if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw new Error('로그인한 계정을 확인할 수 없어요.');return value.toLowerCase();}
  function saltBytes(value){
    if(typeof value!=='string'||!/^[a-f0-9]{32}$/i.test(value))throw new Error('개인 기록 열쇠의 설정을 확인할 수 없어요.');
    return Uint8Array.from(value.match(/../g),function(x){return parseInt(x,16);});
  }
  function newSalt(){return Array.from(crypto.getRandomValues(new Uint8Array(16)),function(x){return x.toString(16).padStart(2,'0');}).join('');}
  function checkPassword(password){if(typeof password!=='string'||password.length<8||password.length>1024)throw new Error('개인 기록 비밀번호는 8자 이상으로 입력해주세요.');}
  function aad(id){return enc.encode(FORMAT+'/'+owner(id));}
  async function passwordKey(password,salt,extractable){
    checkPassword(password);
    var base=await crypto.subtle.importKey('raw',enc.encode(password),{name:'PBKDF2'},false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',salt:saltBytes(salt),iterations:ITERATIONS,hash:'SHA-256'},base,{name:'AES-GCM',length:256},extractable===true,['encrypt','decrypt']);
  }
  function validateEnvelope(envelope,authUserId){
    var id=owner(authUserId);
    if(!envelope||envelope.format!==FORMAT||envelope.version!==1||envelope.owner!==id||!envelope.kdf||envelope.kdf.name!=='PBKDF2'||envelope.kdf.hash!=='SHA-256'||envelope.kdf.iterations!==ITERATIONS)throw new Error('이 계정의 개인 기록 열쇠가 아니거나 지원하지 않는 형식이에요.');
    saltBytes(envelope.kdf.salt);
    if(typeof envelope.data!=='string'||envelope.data.length>4096||bytes(envelope.iv).length!==12||bytes(envelope.data).length<17)throw new Error('개인 기록 열쇠가 손상되었어요.');
    return envelope;
  }
  async function createVault(password,salt,authUserId,existingKeyB64){
    var id=owner(authUserId),key=await passwordKey(password,salt);
    var raw=existingKeyB64===undefined?crypto.getRandomValues(new Uint8Array(32)):bytes(existingKeyB64);
    if(raw.length!==32)throw new Error('개인 기록 열쇠의 길이가 올바르지 않아요.');
    var keyB64=b64(raw),iv=crypto.getRandomValues(new Uint8Array(12));
    var plaintext=JSON.stringify({format:FORMAT,owner:id,key:keyB64});
    var data=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv,additionalData:aad(id),tagLength:128},key,enc.encode(plaintext));
    return {keyB64:keyB64,envelope:{format:FORMAT,version:1,owner:id,kdf:{name:'PBKDF2',hash:'SHA-256',iterations:ITERATIONS,salt:salt.toLowerCase()},iv:b64(iv),data:b64(new Uint8Array(data))}};
  }
  async function unlockVault(password,envelope,authUserId){
    validateEnvelope(envelope,authUserId);
    var key=await passwordKey(password,envelope.kdf.salt),opened;
    try{opened=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(envelope.iv),additionalData:aad(authUserId),tagLength:128},key,bytes(envelope.data));}
    catch(e){throw new Error('개인 기록 비밀번호가 다르거나 열쇠가 손상되었어요. 기록은 그대로 보관돼요.');}
    var value;try{value=JSON.parse(dec.decode(opened));}catch(e){throw new Error('개인 기록 열쇠의 내용을 확인할 수 없어요.');}
    if(!value||value.format!==FORMAT||value.owner!==owner(authUserId)||bytes(value.key).length!==32)throw new Error('개인 기록 열쇠가 이 계정과 일치하지 않아요.');
    return value.key;
  }
  async function verifyLinkedKey(password,salt,authUserId,existingKeyB64){
    // A linked password member keeps the exact original record key. Never mint a
    // random replacement when their password/key relationship is unavailable.
    owner(authUserId);var expected=bytes(existingKeyB64);
    if(expected.length!==32)throw new Error('기존 개인 기록 열쇠를 확인할 수 없어요.');
    var derived=new Uint8Array(await crypto.subtle.exportKey('raw',await passwordKey(password,salt,true)));
    var difference=0;for(var i=0;i<32;i++)difference|=derived[i]^expected[i];
    if(difference)throw new Error('현재 비밀번호와 개인 기록 열쇠가 일치하지 않아요. 기존 아이디로 다시 로그인해주세요.');
    return true;
  }
  async function createLinkedVault(password,salt,authUserId,existingKeyB64){
    await verifyLinkedKey(password,salt,authUserId,existingKeyB64);
    return createVault(password,newSalt(),authUserId,existingKeyB64);
  }
  return {newSalt:newSalt,createVault:createVault,createLinkedVault:createLinkedVault,verifyLinkedKey:verifyLinkedKey,unlockVault:unlockVault,validateEnvelope:validateEnvelope};
});
