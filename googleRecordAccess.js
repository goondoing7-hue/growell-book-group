(function(root,factory){
  'use strict';var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.GrowellGoogleRecordAccess=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  function fail(code){var error=new Error(code);error.code=code;throw error;}
  function keyBytes(value){
    if(typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(value))fail('record-access-invalid-key');
    var raw;try{raw=root.atob(value);}catch(_){fail('record-access-invalid-key');}
    if(raw.length!==32||root.btoa(raw)!==value)fail('record-access-invalid-key');
    return Uint8Array.from(raw,function(c){return c.charCodeAt(0);});
  }
  async function digest(value){var hash=await root.crypto.subtle.digest('SHA-256',keyBytes(value));return Array.from(new Uint8Array(hash),function(b){return b.toString(16).padStart(2,'0');}).join('');}
  function profile(value){
    if(!value||typeof value.id!=='string'||!value.id)fail('record-access-profile');
    var result={id:value.id,authUserId:value.auth_user_id||value.authUserId,salt:value.pbkdf2_salt||value.salt,loginId:value.login_id||value.loginId,
      approval:value.approval_status||value.approvalStatus,deleted:value.is_deleted===true||value.isDeleted===true};
    if(typeof result.authUserId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.authUserId)||typeof result.salt!=='string'||!/^[a-f0-9]{32}$/i.test(result.salt))fail('record-access-profile');
    return result;
  }
  function matches(left,right){return left.id===right.id&&left.authUserId===right.authUserId&&left.salt===right.salt&&left.loginId===right.loginId&&!left.deleted&&!right.deleted;}
  function draftContext(value,hash){var p=profile(value);return {format:'growell-draft-key-recovery',version:1,owner:p.id,authUserId:p.authUserId,salt:p.salt,keyDigest:hash};}
  function encoded(raw){return root.btoa(String.fromCharCode.apply(null,new Uint8Array(raw)));}
  async function protectDraftKeys(owner,material,keys){
    var items=Array.from(new Set(keys));if(!items.length||items.length>16)fail('record-access-drafts');items.forEach(keyBytes);
    var context=draftContext(owner,await digest(material)),iv=root.crypto.getRandomValues(new Uint8Array(12));
    var key=await root.crypto.subtle.importKey('raw',keyBytes(material),'AES-GCM',false,['encrypt']);
    var data=await root.crypto.subtle.encrypt({name:'AES-GCM',iv:iv,additionalData:new TextEncoder().encode(JSON.stringify(context))},key,new TextEncoder().encode(JSON.stringify({keys:items})));
    return Object.assign(context,{iv:encoded(iv),data:encoded(data)});
  }
  async function openDraftKeys(owner,material,box){
    var context=draftContext(owner,await digest(material));
    if(!box||Object.keys(context).some(function(name){return box[name]!==context[name];})||typeof box.iv!=='string'||typeof box.data!=='string'||box.data.length>4096)fail('record-access-drafts');
    var iv,data;try{iv=Uint8Array.from(root.atob(box.iv),function(c){return c.charCodeAt(0);});data=Uint8Array.from(root.atob(box.data),function(c){return c.charCodeAt(0);});}catch(_){fail('record-access-drafts');}
    if(iv.length!==12||encoded(iv)!==box.iv||encoded(data)!==box.data)fail('record-access-drafts');
    var key=await root.crypto.subtle.importKey('raw',keyBytes(material),'AES-GCM',false,['decrypt']),value;
    try{value=JSON.parse(new TextDecoder().decode(await root.crypto.subtle.decrypt({name:'AES-GCM',iv:iv,additionalData:new TextEncoder().encode(JSON.stringify(context))},key,data)));}catch(_){fail('record-access-drafts');}
    if(!value||!Array.isArray(value.keys)||!value.keys.length||value.keys.length>16||new Set(value.keys).size!==value.keys.length)fail('record-access-drafts');value.keys.forEach(keyBytes);return value.keys;
  }
  function create(a){
    if(!a||!a.sb||!a.sb.auth||!a.privateCrypto)fail('record-access-unavailable');
    function guard(ctx){
      if(!ctx||typeof ctx.current!=='function'||ctx.current()!==true||(a.isBlocked&&a.isBlocked()))fail('record-access-stale');
    }
    async function user(ctx){
      guard(ctx);var result=await a.sb.auth.getUser();guard(ctx);var account=result&&result.data&&result.data.user;
      if(!result||result.error||!account||account.id!==ctx.authUserId||!Array.isArray(account.identities)||!account.identities.some(function(i){return i&&i.provider==='google';}))fail('record-access-identity');
      return account;
    }
    async function verified(ctx){
      await user(ctx);guard(ctx);
      var read=await a.sb.from('profiles').select('*').eq('auth_user_id',ctx.authUserId).maybeSingle();guard(ctx);
      if(!read||read.error||!read.data)fail('record-access-profile');
      var actual=profile(read.data),expected=profile(ctx.profile);
      if(!matches(actual,expected)||actual.approval!=='approved'||actual.authUserId!==ctx.authUserId)fail('record-access-profile');
      return read.data;
    }
    async function rpc(ctx,name,args){
      guard(ctx);var result=await a.sb.rpc(name,args||{});guard(ctx);
      if(!result||result.error||!result.data){
        if(result&&result.error&&result.error.code==='40001')fail('record-access-conflict');
        fail('record-access-unavailable');
      }
      return result.data;
    }
    async function checked(ctx,value,expected){
      guard(ctx);
      if(!value||value.version!==1||['ready','missing'].indexOf(value.status)<0||!matches(profile(value.profile),profile(expected))||profile(value.profile).approval!=='approved')fail('record-access-response');
      if(value.status==='missing'){
        if(value.keyB64!==null||value.keyDigest!==null||value.accessId!==null)fail('record-access-response');
      }else{
        if(typeof value.accessId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.accessId))fail('record-access-response');
        if(typeof value.keyDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.keyDigest)||await digest(value.keyB64)!==value.keyDigest)fail('record-access-response');guard(ctx);
      }
      return value;
    }
    async function prove(ctx,material){
      guard(ctx);keyBytes(material);var key=await a.privateCrypto.importKey(material);guard(ctx);
      var seen=new Set(),size=200,total=null;
      for(var start=0;start<20000;start+=size){
        var result=await a.sb.from('private_entries').select('id,user_id,iv,data',{count:'exact'}).eq('user_id',profile(ctx.profile).id).order('id',{ascending:true}).range(start,start+size-1);guard(ctx);
        if(!result||result.error||!Array.isArray(result.data)||result.data.length>size||!Number.isSafeInteger(result.count)||result.count<0||result.count>20000)fail('record-access-records');
        if(total===null)total=result.count;else if(total!==result.count)fail('record-access-records');
        for(var row of result.data){
          if(!row||row.user_id!==profile(ctx.profile).id||typeof row.id!=='string'||seen.has(row.id)||typeof row.iv!=='string'||typeof row.data!=='string')fail('record-access-records');
          seen.add(row.id);
          try{await a.privateCrypto.read({id:row.id,userId:row.user_id,iv:row.iv,data:row.data},key);}catch(_){fail('record-access-key-mismatch');}guard(ctx);
        }
        if(seen.size===total)return true;
        if(result.data.length<size||seen.size>total)fail('record-access-records');
      }
      fail('record-access-records');
    }
    async function stable(ctx,value,before){
      // A concurrent successful recovery can change the Vault generation while
      // the records are being proved. Never adopt a superseded key generation.
      var latest=await checked(ctx,await rpc(ctx,'growell_google_record_access_get'),before);guard(ctx);
      if(latest.status!==value.status||latest.accessId!==value.accessId||latest.keyDigest!==value.keyDigest||latest.keyB64!==value.keyB64)fail('record-access-conflict');
      await verified(ctx);guard(ctx);return value;
    }
    async function get(ctx){
      var before=await verified(ctx);guard(ctx);var value=await checked(ctx,await rpc(ctx,'growell_google_record_access_get'),before);guard(ctx);
      if(value.status==='ready'){await prove(ctx,value.keyB64);guard(ctx);return stable(ctx,value,before);}
      await verified(ctx);guard(ctx);return value;
    }
    async function prepare(ctx){
      var before=await verified(ctx);guard(ctx);await prove(ctx,ctx.keyB64);guard(ctx);var hash=await digest(ctx.keyB64);guard(ctx);
      var value=await checked(ctx,await rpc(ctx,'growell_google_record_access_prepare',{p_profile_id:before.id,p_salt:before.pbkdf2_salt,p_key_b64:ctx.keyB64,p_key_digest:hash}),before);guard(ctx);
      if(value.status!=='ready'||value.keyB64!==ctx.keyB64||value.keyDigest!==hash)fail('record-access-conflict');
      return stable(ctx,value,before);
    }
    async function rotate(ctx){
      var before=await verified(ctx);guard(ctx);await prove(ctx,ctx.keyB64);guard(ctx);
      var previous=await checked(ctx,await rpc(ctx,'growell_google_record_access_get'),before);guard(ctx);
      if(previous.status==='missing')return prepare(ctx);
      var hash=await digest(ctx.keyB64);guard(ctx);
      var value=await checked(ctx,await rpc(ctx,'growell_google_record_access_rotate',{p_profile_id:before.id,p_salt:before.pbkdf2_salt,p_expected_digest:previous.keyDigest,p_key_b64:ctx.keyB64,p_key_digest:hash,p_expected_access_id:previous.accessId}),before);guard(ctx);
      if(value.status!=='ready'||value.keyB64!==ctx.keyB64||value.keyDigest!==hash)fail('record-access-conflict');return stable(ctx,value,before);
    }
    async function register(ctx,name){
      await user(ctx);guard(ctx);name=typeof name==='string'?name.trim():'';
      if(!name||Array.from(name).length>30)fail('record-access-name');
      var existing=await rpc(ctx,'growell_oauth_profile');guard(ctx);
      if(existing.profile){
        var original=profile(existing.profile);if(original.authUserId!==ctx.authUserId||original.deleted)fail('record-access-profile');
        if(original.approval!=='approved')return {status:'approval-required',profile:existing.profile,keyB64:null,keyDigest:null,accessId:null,version:1};
        return get(Object.assign({},ctx,{profile:existing.profile}));
      }
      if(existing.status!=='new')fail('record-access-profile');
      var salt=Array.from(root.crypto.getRandomValues(new Uint8Array(16)),function(b){return b.toString(16).padStart(2,'0');}).join('');
      var generated=await a.privateCrypto.newKey();guard(ctx);
      var material=await a.privateCrypto.exportKey(generated);guard(ctx);
      var value=await rpc(ctx,'growell_google_register',{p_name:name,p_salt:salt,p_key_b64:material});guard(ctx);await user(ctx);guard(ctx);
      if(!value||value.version!==1||!value.profile||profile(value.profile).authUserId!==ctx.authUserId)fail('record-access-response');
      if(value.status==='approval-required'){
        if(value.keyB64!==null||value.keyDigest!==null||value.accessId!==null||value.profile.is_deleted)fail('record-access-response');return value;
      }
      // A concurrent registration may have won. Never use the just-generated
      // candidate for an existing member; retrieve and prove the stored key.
      return get(Object.assign({},ctx,{profile:value.profile}));
    }
    return Object.freeze({get:get,prepare:prepare,rotate:rotate,register:register,prove:prove});
  }
  return Object.freeze({create:create,keyBytes:keyBytes,digest:digest,protectDraftKeys:protectDraftKeys,openDraftKeys:openDraftKeys});
});
