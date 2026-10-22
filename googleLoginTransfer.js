(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellGoogleLoginTransfer=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var STORAGE_KEY='growell_google_login_transfer_v1',MAX_AGE=30*60*1000;
  var STAGES=['proof','confirmed','unlinking','relink','target','source','unknown','target-mismatch','target-rollback'];
  var UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,HEX=/^[a-f0-9]{64}$/;
  var messages={
    state:'연결 진행 상태를 확인할 수 없어요. 기존 계정과 기록은 그대로 유지돼요.',
    busy:'연결 확인이 진행 중이에요. 잠시 기다려주세요.',
    native_changed:'기존 아이디의 로그인 상태나 개인 기록 열쇠가 바뀌었어요. 기존 아이디로 다시 로그인해주세요.',
    proof_unavailable:'Google 본인 확인 상태를 불러오지 못했어요. 기존 연결은 임의로 변경하지 않아요.',
    source_ineligible:'이 Google 계정은 안전하게 다시 연결할 수 있는 상태가 아니에요. 기존 아이디로 이용하고 관리자에게 문의해주세요.',
    source_changed:'확인한 Google 계정의 연결 상태가 달라졌어요. 임의로 연결을 해제하지 않아요.',
    expired:'본인 확인 시간이 지났어요. 기존 연결로 되돌린 뒤 다시 진행해주세요.',
    callback:'연결 결과를 확인할 수 없어요. 기존 계정과 기록은 그대로 유지돼요.',
    storage:'연결 복구 상태를 안전하게 저장하지 못해 작업을 중단했어요.',
    oauth:'Google 연결 화면을 열지 못했어요. 기존 연결 상태를 확인한 뒤 다시 시도해주세요.',
    unlink_failed:'기존 Google 연결을 해제하지 못했어요. 확인된 상태에서만 다시 진행할 수 있어요.',
    unknown:'연결 변경 결과를 확인하지 못했어요. 기존 연결로 되돌리기에서 상태를 다시 확인해주세요.',
    target_mismatch:'다른 Google 계정이 선택됐어요. 기존 연결로 되돌리기를 눌러 원래 계정으로 복구해주세요.',
    rollback_failed:'잘못 선택한 Google 연결의 복구를 완료하지 못했어요. 다른 연결은 변경하지 않아요.',
    cleanup:'연결은 확인됐지만 본인 확인용 로그인을 정리하지 못했어요. 다시 확인해주세요.'
  };
  function fail(code){var error=new Error(messages[code]||messages.state);error.code='transfer_'+code;return error;}
  function text(value,max){return typeof value==='string'&&value.length>0&&value.length<=(max||512);}
  function email(value){if(!text(value,320)||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value))throw fail('source_ineligible');return value.toLowerCase();}
  function missingSession(error){return !!(error&&(['session_not_found','refresh_token_not_found','session_expired'].indexOf(error.code)>=0||error.name==='AuthSessionMissingError'));}
  function expiredToken(error){return !!(error&&(error.status===401||error.code==='jwt_expired'));}
  function auth(client){return client&&client.auth||client;}
  function context(value){
    if(!value||!UUID.test(value.authUserId||'')||!text(value.profileId,128)||!/^[a-f0-9]{32}$/i.test(value.profileSalt||'')||!HEX.test(value.keyDigest||''))throw fail('native_changed');
    return {authUserId:value.authUserId.toLowerCase(),profileId:value.profileId,profileSalt:value.profileSalt,keyDigest:value.keyDigest};
  }
  function googleIdentities(user){
    if(!user||!UUID.test(user.id||'')||!Array.isArray(user.identities))throw fail('source_changed');
    return user.identities.filter(function(i){return i&&i.provider==='google';});
  }
  function google(identity,user){
    var d=identity&&identity.identity_data;
    // Auth returns identity_id as its row UUID and id as the provider subject.
    // The SDK's unlinkIdentity uses identity_id, never the provider's id.
    if(!identity||!UUID.test(identity.identity_id||'')||!d||!text(d.sub)||identity.id!==d.sub||d.email_verified!==true||(identity.provider_id!==undefined&&identity.provider_id!==d.sub)||(identity.user_id!==undefined&&identity.user_id.toLowerCase()!==user.id.toLowerCase()))throw fail('source_changed');
    return {id:identity.identity_id.toLowerCase(),sub:d.sub,email:email(d.email),identity:identity};
  }
  async function hash(value){var data=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(data),function(b){return b.toString(16).padStart(2,'0');}).join('');}
  function nonce(){return Array.from(crypto.getRandomValues(new Uint8Array(16)),function(b){return b.toString(16).padStart(2,'0');}).join('');}
  function create(options){
    options=options||{};var nativeClient=options.nativeClient,storage=options.storage,clock=options.now||Date.now,busy=false,proofClient=null,proofNonce=null;
    if(!nativeClient||typeof options.createProofClient!=='function'||typeof options.getNativeContext!=='function'||typeof options.buildRedirectUrl!=='function'||!storage||typeof storage.getItem!=='function'||typeof storage.setItem!=='function'||typeof storage.removeItem!=='function')throw fail('state');
    function load(){
      var raw,s;try{raw=storage.getItem(STORAGE_KEY);if(raw===null||raw===undefined)return null;s=JSON.parse(raw);}catch(e){throw fail('state');}
      if(!s||s.version!==1||STAGES.indexOf(s.stage)<0||!/^[a-f0-9]{32}$/.test(s.nonce||'')||!Number.isFinite(s.createdAt)||s.createdAt>clock()+60000||s.targetInitiallyUnlinked!==true)throw fail('state');
      context(s);
      if(s.stage!=='proof'&&(!UUID.test(s.sourceAuthUserId||'')||!UUID.test(s.identityId||'')||!HEX.test(s.subjectHash||'')||!HEX.test(s.emailHash||'')||s.sourceAuthUserId===s.authUserId))throw fail('state');
      if((s.stage==='target-mismatch'||s.stage==='target-rollback')&&(!UUID.test(s.unexpectedIdentityId||'')||!HEX.test(s.unexpectedSubjectHash||'')))throw fail('state');
      return s;
    }
    function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
    function guard(s){if(!same(load(),s))throw fail('state');}
    function save(next,previous){
      guard(previous);try{storage.setItem(STORAGE_KEY,JSON.stringify(next));}catch(e){throw fail('storage');}
      if(!same(load(),next))throw fail('storage');return next;
    }
    function stage(s,name,extra){return save(Object.assign({},s,extra||{},{stage:name}),s);}
    function clear(s){guard(s);try{storage.removeItem(STORAGE_KEY);}catch(e){throw fail('storage');}if(load()!==null)throw fail('storage');}
    function expired(s){return clock()-s.createdAt>MAX_AGE;}
    function fresh(s){if(expired(s))throw fail('expired');}
    async function run(fn){if(busy)throw fail('busy');busy=true;try{return await fn();}finally{busy=false;}}
    async function client(s){
      if(!proofClient||proofNonce!==s.nonce){proofClient=await options.createProofClient({nonce:s.nonce});proofNonce=s.nonce;}
      if(!proofClient||proofClient===nativeClient||auth(proofClient)===auth(nativeClient))throw fail('state');return proofClient;
    }
    async function user(c,code){var r,error;try{r=await auth(c).getUser();error=r&&r.error;}catch(e){error=e;}
      // The isolated proof client has no background refresh. Recover an expired
      // token once through the SDK; network failures never discard its session.
      if(code==='proof_unavailable'&&expiredToken(error)&&typeof auth(c).refreshSession==='function'){
        try{var refreshed=await auth(c).refreshSession();if(!refreshed||refreshed.error)throw fail(code);r=await auth(c).getUser();}catch(e){throw fail(code);}
      }
      if(!r||r.error||!r.data||!r.data.user||!UUID.test(r.data.user.id||'')||!Array.isArray(r.data.user.identities))throw fail(code);return r.data.user;
    }
    async function native(s,noGoogle){
      var u=await user(nativeClient,'native_changed'),c;try{c=context(await options.getNativeContext());}catch(e){throw fail('native_changed');}
      if(u.id.toLowerCase()!==c.authUserId||(s&&['authUserId','profileId','profileSalt','keyDigest'].some(function(k){return c[k]!==s[k];})))throw fail('native_changed');
      if(noGoogle&&googleIdentities(u).length)throw fail('native_changed');if(s)guard(s);return {user:u,context:c};
    }
    async function source(s,allowAbsent){
      var c=await client(s),u=await user(c,'proof_unavailable'),id=u.id.toLowerCase(),gs=googleIdentities(u),es=u.identities.filter(function(i){return i&&i.provider==='email';});
      if(id===s.authUserId||gs.length>1||es.length!==1||!u.email_confirmed_at||!Number.isFinite(Date.parse(u.email_confirmed_at)))throw fail('source_ineligible');
      var primary=email(u.email),ed=es[0].identity_data;
      if(!ed||ed.email_verified!==true||email(ed.email)!==primary||(es[0].user_id!==undefined&&es[0].user_id.toLowerCase()!==id))throw fail('source_ineligible');
      var eh=await hash(primary),g=gs.length?google(gs[0],u):null,sh=g?await hash(g.sub):null;
      if(g&&g.email!==primary)throw fail('source_ineligible');
      if(s.sourceAuthUserId&&(id!==s.sourceAuthUserId||eh!==s.emailHash||(g&&((s.stage!=='source'&&g.id!==s.identityId)||sh!==s.subjectHash))))throw fail('source_changed');
      if(!g&&!allowAbsent)throw fail('source_changed');
      if(g){var r;try{r=await c.rpc('growell_oauth_profile');}catch(e){throw fail('source_ineligible');}
        if(!r||r.error||!r.data||r.data.status!=='new'||r.data.profile!==null||r.data.envelope!==null)throw fail('source_ineligible');}
      guard(s);return {client:c,user:u,email:primary,emailHash:eh,google:g,subjectHash:sh};
    }
    function view(s,p,extra){return Object.assign({stage:s?s.stage:'idle',nonce:s?s.nonce:null,expired:s?expired(s):false,sourceEmail:p?p.email:null,canConfirm:!!(s&&s.stage==='confirmed'&&!expired(s)),canResume:!!(s&&['relink','target'].indexOf(s.stage)>=0&&!expired(s)),canRestore:!!(s&&['relink','target','source','unknown','unlinking','target-mismatch','target-rollback'].indexOf(s.stage)>=0),needsRecovery:!!(s&&['proof','confirmed'].indexOf(s.stage)<0)},extra||{});}
    async function exchange(c,code){if(!text(code,8192))throw fail('callback');var r;try{r=await auth(c).exchangeCodeForSession(code);}catch(e){throw fail('callback');}if(!r||r.error)throw fail('callback');}
    function redirect(s,step){var url=options.buildRedirectUrl({nonce:s.nonce,step:step});if(!text(url,4096))throw fail('state');return url;}
    async function oauth(c,s,step,link,hint){
      var params={provider:'google',options:{redirectTo:redirect(s,step),skipBrowserRedirect:true,queryParams:{prompt:'select_account'}}};
      if(hint)params.options.queryParams.login_hint=hint;var r;
      try{r=await auth(c)[link?'linkIdentity':'signInWithOAuth'](params);}catch(e){throw fail('oauth');}
      if(!r||r.error||!r.data||!text(r.data.url,16384))throw fail('oauth');guard(s);return {url:r.data.url,nonce:s.nonce,stage:s.stage};
    }
    async function cleanup(s){
      await native(s,false);var c=await client(s),r,error;try{r=await auth(c).signOut({scope:'local'});error=r&&r.error;}catch(e){error=e;}if(error&&!missingSession(error))throw fail('cleanup');clear(s);proofClient=null;proofNonce=null;return {stage:'complete',nonce:s.nonce};
    }
    async function inspectInternal(){
      var s=load();if(!s)return view(null);var initial=await native(s,false),initialGs=googleIdentities(initial.user);
      if(s.stage==='proof')return view(s);
      if(['relink','target','target-mismatch','target-rollback'].indexOf(s.stage)>=0&&initialGs.length===1&&await hash(google(initialGs[0],initial.user).sub)===s.subjectHash){guard(s);return view(s,null,{canComplete:true,canRestore:false,canResume:false});}
      var p;try{p=await source(s,true);}catch(e){if(s.stage==='unlinking')s=stage(s,'unknown');throw e;}
      if(['unlinking','unknown'].indexOf(s.stage)>=0)s=stage(s,p.google?'confirmed':'relink');
      if(s.stage==='confirmed'&&!p.google)throw fail('source_changed');
      if(['relink','target','target-mismatch','target-rollback'].indexOf(s.stage)>=0&&p.google)throw fail('source_changed');
      var n=await native(s,false),gs=googleIdentities(n.user),canComplete=false;
      if(gs.length===1)canComplete=(await hash(google(gs[0],n.user).sub))===s.subjectHash;
      if(s.stage==='target-mismatch'||s.stage==='target-rollback'){
        if(gs.length>1)throw fail('source_changed');
        if(gs.length){var unexpected=google(gs[0],n.user);if(unexpected.id!==s.unexpectedIdentityId||await hash(unexpected.sub)!==s.unexpectedSubjectHash)throw fail('source_changed');}
      }
      guard(s);return view(s,p,{canComplete:canComplete});
    }
    async function startProof(){return run(async function(){
      var existing=load();if(existing){if(existing.stage!=='proof')throw fail('state');fresh(existing);await native(existing,true);return oauth(await client(existing),existing,'proof',false);}
      var n=await native(null,true),s=Object.assign({version:1,nonce:nonce(),createdAt:clock(),stage:'proof',targetInitiallyUnlinked:true},n.context);save(s,null);return oauth(await client(s),s,'proof',false);
    });}
    async function finishProof(code,value){return run(async function(){var s=load();if(!s||s.stage!=='proof'||value!==s.nonce)throw fail('callback');fresh(s);await native(s,true);await exchange(await client(s),code);await native(s,true);var p=await source(s,false);s=stage(s,'confirmed',{sourceAuthUserId:p.user.id.toLowerCase(),identityId:p.google.id,subjectHash:p.subjectHash,emailHash:p.emailHash});return view(s,p);});}
    async function inspect(){return run(inspectInternal);}
    async function confirmTransfer(){return run(async function(){
      var s=load();if(!s||s.stage!=='confirmed')throw fail('state');fresh(s);await native(s,true);var p=await source(s,false);await native(s,true);s=stage(s,'unlinking');
      var failed=false;try{var r=await auth(p.client).unlinkIdentity(p.google.identity);failed=!!(r&&r.error);}catch(e){failed=true;}
      var checked;try{checked=await source(s,true);}catch(e){stage(s,'unknown');throw fail('unknown');}
      await native(s,false);
      if(checked.google){s=stage(s,'confirmed');throw fail(failed?'unlink_failed':'source_changed');}
      s=stage(s,'relink');return view(s,checked);
    });}
    async function resumeLink(){return run(async function(){var s=load();if(!s||['relink','target'].indexOf(s.stage)<0)throw fail('state');fresh(s);await native(s,true);var p=await source(s,true);if(p.google)throw fail('source_changed');s=stage(s,'target');return oauth(nativeClient,s,'target',true,p.email);});}
    async function rollbackUnexpected(s){
      await native(s,false);var n=await native(s,false),gs=googleIdentities(n.user);
      if(!n.user.identities.some(function(i){return i&&i.provider==='email';})||gs.length>1)throw fail('source_changed');
      if(gs.length){var g=google(gs[0],n.user);if(g.id!==s.unexpectedIdentityId||await hash(g.sub)!==s.unexpectedSubjectHash)throw fail('source_changed');
        s=stage(s,'target-rollback');try{await auth(nativeClient).unlinkIdentity(g.identity);}catch(e){}
        var checked;try{checked=await native(s,false);}catch(e){throw fail('unknown');}
        var left=googleIdentities(checked.user);if(left.length){if(left.length!==1)throw fail('source_changed');var l=google(left[0],checked.user);if(l.id!==s.unexpectedIdentityId||await hash(l.sub)!==s.unexpectedSubjectHash)throw fail('source_changed');s=stage(s,'target-mismatch');throw fail('rollback_failed');}
      }
      return stage(s,'relink');
    }
    async function restoreSource(){return run(async function(){
      var s=load();if(!s||['unlinking','unknown','relink','target','source','target-mismatch','target-rollback'].indexOf(s.stage)<0)throw fail('state');await native(s,false);var p=await source(s,true);
      if(p.google){if(s.stage==='source')return cleanup(s);if(s.stage==='unlinking'||s.stage==='unknown'){s=stage(s,'confirmed');return view(s,p,{restored:true,needsRecovery:false});}throw fail('source_changed');}
      if(s.stage==='target-mismatch'||s.stage==='target-rollback')s=await rollbackUnexpected(s);
      await native(s,true);s=stage(s,'source');return oauth(p.client,s,'source',true,p.email);
    });}
    async function completeNativeLink(code,value,step){return run(async function(){
      var s=load();step=step||'target';if(!s||s.nonce!==value||(step!=='target'&&step!=='source')||(step==='target'&&['relink','target','target-mismatch','target-rollback'].indexOf(s.stage)<0)||(step==='source'&&s.stage!=='source'))throw fail('callback');
      if(step==='target'){
        await native(s,false);
        if(code!==undefined&&code!==null&&s.stage!=='target')throw fail('callback');
        if(code!==undefined&&code!==null)await exchange(nativeClient,code);var n=await native(s,false),gs=googleIdentities(n.user);
        if(gs.length!==1)throw fail('source_changed');var g=google(gs[0],n.user),gh=await hash(g.sub);
        if(gh!==s.subjectHash){if(s.stage!=='target'||!n.user.identities.some(function(i){return i&&i.provider==='email';}))throw fail('source_changed');s=stage(s,'target-mismatch',{unexpectedIdentityId:g.id,unexpectedSubjectHash:gh});throw fail('target_mismatch');}
        // A provider subject is globally unique. Its verified presence on this
        // exact native owner proves it is no longer on the old proof account.
        // Do not strand a completed link because that old session was revoked.
        await native(s,false);return cleanup(s);
      }
      await native(s,true);if(code!==undefined&&code!==null)await exchange(await client(s),code);var restored=await source(s,false);await native(s,true);return cleanup(s);
    });}
    async function cancel(){return run(async function(){var s=load();if(!s)return {stage:'idle'};if(['proof','confirmed'].indexOf(s.stage)<0)return view(s,null,{needsRecovery:true});var c=await client(s),r;try{r=await auth(c).signOut({scope:'local'});}catch(e){throw fail('cleanup');}if(r&&r.error)throw fail('cleanup');clear(s);proofClient=null;proofNonce=null;return {stage:'cancelled',nonce:s.nonce};});}
    return {startProof:startProof,finishProof:finishProof,inspect:inspect,confirmTransfer:confirmTransfer,resumeLink:resumeLink,restoreSource:restoreSource,completeNativeLink:completeNativeLink,cancel:cancel};
  }
  return {create:create,STORAGE_KEY:STORAGE_KEY,MAX_AGE:MAX_AGE};
});
