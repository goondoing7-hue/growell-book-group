(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.GrowellPrivateCrypto = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  var encoder = new TextEncoder(), decoder = new TextDecoder();
  function b64(bytes){ var s=''; for(var i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]); return btoa(s); }
  function bytes(s){ if(typeof s!=='string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('Invalid encoded data'); var raw=atob(s), out=new Uint8Array(raw.length); for(var i=0;i<raw.length;i++) out[i]=raw.charCodeAt(i); return out; }
  function importKey(s){ var raw=bytes(s); if(raw.length!==32) throw new Error('Invalid key'); return crypto.subtle.importKey('raw',raw,'AES-GCM',true,['encrypt','decrypt']); }
  function exportKey(key){ return crypto.subtle.exportKey('raw',key).then(function(raw){return b64(new Uint8Array(raw));}); }
  function newKey(){return crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);}
  function fingerprint(key){return crypto.subtle.exportKey('raw',key).then(function(raw){return crypto.subtle.digest('SHA-256',raw);}).then(function(raw){return Array.from(new Uint8Array(raw),function(x){return x.toString(16).padStart(2,'0');}).join('');});}
  function context(kind, owner, id){return encoder.encode('growell/private/v2/'+kind+'/'+owner+'/'+id);}
  function seal(key, value, aad){
    var iv=crypto.getRandomValues(new Uint8Array(12));
    var params={name:'AES-GCM',iv:iv,tagLength:128}; if(aad) params.additionalData=aad;
    return crypto.subtle.encrypt(params,key,encoder.encode(value)).then(function(raw){return {iv:b64(iv),data:b64(new Uint8Array(raw))};});
  }
  function open(key, box, aad){
    var iv=bytes(box.iv); if(iv.length!==12) return Promise.reject(new Error('Invalid IV'));
    var params={name:'AES-GCM',iv:iv,tagLength:128}; if(aad) params.additionalData=aad;
    return crypto.subtle.decrypt(params,key,bytes(box.data)).then(function(raw){return decoder.decode(raw);});
  }
  function envelope(entry){
    var value;
    try{value=JSON.parse(decoder.decode(bytes(entry.data)));}catch(e){return null;}
    if(!value || value.format!=='growell-private-v2') throw new Error('Unknown private record format');
    if(value.owner!==entry.userId || value.id!==entry.id || !value.body || !value.wrappedKey || !/^[a-f0-9]{64}$/.test(value.keyId)) throw new Error('Private record identity mismatch');
    return value;
  }
  function encoded(value){return {iv:value.wrappedKey.iv,data:b64(encoder.encode(JSON.stringify(value)))};}
  async function create(entry, passwordKey, dataKey, text){
    var id=entry.id, owner=entry.userId;
    if(!id || !owner) throw new Error('Private record identity required');
    var keyId=await fingerprint(dataKey);
    var body=await seal(dataKey,text,context('body',owner,id));
    var wrappedKey=await seal(passwordKey,await exportKey(dataKey),context('key',owner,id));
    return encoded({format:'growell-private-v2',owner:owner,id:id,keyId:keyId,body:body,wrappedKey:wrappedKey});
  }
  async function read(entry,passwordKey){
    var box=envelope(entry);
    if(!box) return {text:await open(passwordKey,entry),dataKey:null};
    var dataKey=await importKey(await open(passwordKey,box.wrappedKey,context('key',entry.userId,entry.id)));
    if(await fingerprint(dataKey)!==box.keyId) throw new Error('Private key mismatch');
    return {text:await open(dataKey,box.body,context('body',entry.userId,entry.id)),dataKey:dataKey};
  }
  async function rewrap(entry,passwordKey,dataKey){
    var box=envelope(entry); if(!box) throw new Error('Legacy record must be migrated first');
    if(await fingerprint(dataKey)!==box.keyId) throw new Error('Recovery key mismatch');
    await open(dataKey,box.body,context('body',entry.userId,entry.id));
    box.wrappedKey=await seal(passwordKey,await exportKey(dataKey),context('key',entry.userId,entry.id));
    return encoded(box);
  }
  async function recoveryFile(profile,dataKeys,legacyKeys){
    var keys=[], seen={};
    for(var key of dataKeys){var id=await fingerprint(key);if(!seen[id]){seen[id]=true;keys.push({id:id,key:await exportKey(key)});}}
    return {format:'growell-private-recovery',version:1,userId:profile.id,authUserId:profile.authUserId||'',loginId:profile.loginId,createdAt:new Date().toISOString(),keys:keys,legacyKeys:await Promise.all((legacyKeys||[]).map(exportKey))};
  }
  async function parseRecovery(text){
    if(typeof text!=='string' || text.length>262144) throw new Error('복구 파일의 크기나 형식이 올바르지 않아요.');
    var file;try{file=JSON.parse(text);}catch(e){throw new Error('GROWELL 복구 파일을 선택해주세요.');}
    if(!file || file.format!=='growell-private-recovery' || file.version!==1 || typeof file.userId!=='string' || !file.userId || typeof file.loginId!=='string' || !Array.isArray(file.keys) || !file.keys.length || file.keys.length>100 || !Array.isArray(file.legacyKeys) || file.legacyKeys.length>100) throw new Error('GROWELL 복구 파일의 형식이 올바르지 않아요.');
    for(var item of file.keys){var key=await importKey(item.key);if(await fingerprint(key)!==item.id) throw new Error('복구 파일이 손상되었어요.');}
    for(var raw of file.legacyKeys) await importKey(raw);
    return file;
  }
  function assertOwner(file,profile){
    if(file.userId!==profile.id || file.loginId!==profile.loginId || (file.authUserId && profile.authUserId && file.authUserId!==profile.authUserId)) throw new Error('이 계정의 복구 파일이 아니에요.');
  }
  async function recover(entry,file){
    if(entry.userId!==file.userId) throw new Error('Recovery owner mismatch');
    var box=envelope(entry);
    if(box){
      var item=file.keys.find(function(k){return k.id===box.keyId;});
      if(item){
        var dataKey=await importKey(item.key);
        return {text:await open(dataKey,box.body,context('body',entry.userId,entry.id)),dataKey:dataKey};
      }
      // A file saved before the first note or on another device can still unwrap
      // records written under that password. After reset the app normalizes every
      // recovered record to the file's stable key for subsequent devices/resets.
      for(var legacy of file.legacyKeys){try{return await read(entry,await importKey(legacy));}catch(e){}}
      throw new Error('이 기록을 열 수 있는 키가 복구 파일에 없어요. 최근 복구 파일을 선택해주세요.');
    }
    for(var raw of file.legacyKeys){try{return {text:await open(await importKey(raw),entry),dataKey:null};}catch(e){}}
    throw new Error('이전 기록을 열 수 없어요. 해당 기록을 작성할 때 저장한 복구 파일이 필요해요.');
  }
  return {newKey:newKey,importKey:importKey,exportKey:exportKey,fingerprint:fingerprint,envelope:envelope,create:create,read:read,rewrap:rewrap,recoveryFile:recoveryFile,parseRecovery:parseRecovery,assertOwner:assertOwner,recover:recover};
});
