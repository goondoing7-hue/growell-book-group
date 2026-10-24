'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
const Access=require('../googleRecordAccess.js'),Private=require('../privateCrypto.js');
const authId='11111111-2222-4333-8444-555555555555';
const member={id:'u-existing',auth_user_id:authId,login_id:'existing',name:'독서회원',pbkdf2_salt:'0123456789abcdef0123456789abcdef',approval_status:'approved',is_deleted:false,is_admin:false};
const google={id:authId,identities:[{provider:'google'},{provider:'email'}]};
const clone=value=>JSON.parse(JSON.stringify(value));
async function fixture(options={}){
  const material=options.material||await Private.exportKey(await Private.newKey()),key=await Private.importKey(material),dataKey=await Private.newKey();
  const identity={id:'entry-0001',userId:member.id,bookId:'emotion',createdAt:1760000000000,updatedAt:1760000000042};
  const modern={...identity,...await Private.create(identity,key,dataKey,'기존 회원의 비공개 기록')};
  const iv=webcrypto.getRandomValues(new Uint8Array(12)),cipher=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode('기존 v1 기록'));
  const legacy={id:'entry-0002',userId:member.id,bookId:'emotion',createdAt:1760000000001,iv:Buffer.from(iv).toString('base64'),data:Buffer.from(cipher).toString('base64')};
  const records=options.records||[modern,legacy],rows=records.map(r=>({id:r.id,user_id:r.userId,iv:r.iv,data:r.data,created_at:r.createdAt,updated_at:r.updatedAt||null}));
  const calls=[];let active=true,blocked=false,actual=clone(member),account=clone(google),newKeys=0;
  const privateCrypto={...Private,newKey:async()=>{newKeys++;return Private.newKey();}};
  const ready=async value=>({status:'ready',profile:clone(actual),keyB64:value,keyDigest:await Access.digest(value),accessId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',version:1});
  const missing=()=>({status:'missing',profile:clone(actual),keyB64:null,keyDigest:null,accessId:null,version:1});
  const sb={auth:{getUser:async()=>{calls.push(['user']);if(options.onUser)await options.onUser();return {data:{user:account},error:null};}},from(table){
    const query={select(columns,opts){calls.push(['select',table,columns,opts]);return query;},eq(column,value){calls.push(['eq',table,column,value]);return query;},order(column,opts){calls.push(['order',column,opts]);return query;},
      maybeSingle:async()=>{if(options.onProfile)await options.onProfile();return {data:clone(actual),error:null};},
      range:async(start,end)=>{calls.push(['range',start,end]);if(options.page)return options.page({start,end,rows,calls});return {data:clone(rows.slice(start,end+1)),count:rows.length,error:null};}};return query;},
    rpc:async(name,args)=>{calls.push(['rpc',name,clone(args||{})]);if(options.rpc)return options.rpc(name,args,{ready,missing,material});return {data:name==='growell_google_record_access_get'?await ready(material):await ready(args.p_key_b64),error:null};}};
  const ctx={authUserId:authId,profile:clone(member),keyB64:material,current:()=>active};
  return {engine:Access.create({sb,privateCrypto,isBlocked:()=>blocked}),ctx,sb,calls,material,records,rows,ready,missing,
    stop(){active=false;},block(){blocked=true;},profile(value){actual=value;},user(value){account=value;},newKeys:()=>newKeys};
}
test('key format is canonical 32 bytes and its digest hashes raw key bytes',async()=>{
  const raw=Buffer.alloc(32,7),key=raw.toString('base64');assert.equal(Access.keyBytes(key).length,32);
  assert.equal(await Access.digest(key),require('node:crypto').createHash('sha256').update(raw).digest('hex'));
  for(const value of ['',Buffer.alloc(31).toString('base64'),key.slice(0,-1),key.slice(0,42)+'B=',null])assert.throws(()=>Access.keyBytes(value));
});
test('local draft-key protection encrypts the old key and binds owner, Auth UUID and salt',async()=>{
  const h=await fixture(),old=await Private.exportKey(await Private.newKey()),box=await Access.protectDraftKeys(member,h.material,[old]);
  assert.ok(!JSON.stringify(box).includes(old));assert.deepEqual(await Access.openDraftKeys(member,h.material,box),[old]);
  for(const changed of [{...member,id:'other'},{...member,auth_user_id:'99999999-2222-4333-8444-555555555555'},{...member,pbkdf2_salt:'ffffffffffffffffffffffffffffffff'}])await assert.rejects(Access.openDraftKeys(changed,h.material,box));
  await assert.rejects(Access.openDraftKeys(member,old,box));await assert.rejects(Access.openDraftKeys(member,h.material,{...box,data:box.data.slice(0,-4)+'AAAA'}));
});
test('prepare proves every existing v1 and v2 record, preserves their bytes and registers the original key only',async()=>{
  const h=await fixture(),before=JSON.stringify(h.records),result=await h.engine.prepare(h.ctx);
  assert.equal(result.keyB64,h.material);assert.equal(JSON.stringify(h.records),before);assert.equal(h.newKeys(),0);
  const calls=h.calls.filter(c=>c[0]==='rpc');assert.deepEqual(calls.map(c=>c[1]),['growell_google_record_access_prepare','growell_google_record_access_get']);
  assert.deepEqual(calls[0][2],{p_profile_id:member.id,p_salt:member.pbkdf2_salt,p_key_b64:h.material,p_key_digest:await Access.digest(h.material)});
  assert.equal(h.calls.find(c=>c[0]==='select'&&c[1]==='private_entries')[3].count,'exact');
  assert.ok(h.calls.filter(c=>c[0]==='user').length>=2);
});
test('get proves the stored key before returning it, while missing never creates a key',async()=>{
  const h=await fixture();assert.equal((await h.engine.get(h.ctx)).keyB64,h.material);assert.equal(h.newKeys(),0);
  const absent=await fixture({rpc:async(name,args,{missing})=>({data:missing()})});
  assert.equal((await absent.engine.get(absent.ctx)).status,'missing');assert.equal(absent.newKeys(),0);
  assert.ok(!absent.calls.some(c=>c[0]==='range'||c[0]==='rpc'&&c[1]!=='growell_google_record_access_get'));
});
test('wrong or corrupted key material cannot provision or rotate existing records',async()=>{
  for(const corrupt of [false,true]){
    const h=await fixture();if(corrupt)h.rows[1].data='broken';else h.ctx.keyB64=await Private.exportKey(await Private.newKey());
    await assert.rejects(h.engine.prepare(h.ctx),/record-access-key-mismatch/);
    assert.ok(!h.calls.some(c=>c[0]==='rpc'));assert.equal(h.newKeys(),0);
  }
});
test('exact-count proof fails closed for errors, missing counts and truncated pages',async()=>{
  for(const page of [({rows})=>({data:rows,error:{code:'503'},count:rows.length}),({rows})=>({data:rows}),({rows})=>({data:rows.slice(0,1),count:rows.length}),()=>({data:[],count:1}),()=>({data:[],count:-1}),()=>({data:[],count:20001})]){
    const h=await fixture({page});await assert.rejects(h.engine.prepare(h.ctx),/record-access-records/);assert.ok(!h.calls.some(c=>c[0]==='rpc'));
  }
});
test('a later private-record page must match the exact total and contain no duplicates or foreign owners',async()=>{
  for(const failure of ['count','duplicate','owner']){
    const h=await fixture();const item=h.rows[0];h.rows.splice(0,h.rows.length,...Array.from({length:201},(_,i)=>({...item,id:'entry-'+String(i).padStart(4,'0')})));
    const engine=Access.create({sb:h.sb,privateCrypto:{importKey:async()=>({}),read:async()=>({text:'synthetic'})}});
    h.sb.from=table=>{const q={select:()=>q,eq:()=>q,order:()=>q,maybeSingle:async()=>({data:member}),range:async(start,end)=>({data:h.rows.slice(start,end+1).map((r,i)=>start&&failure==='duplicate'?{...r,id:h.rows[0].id}:start&&failure==='owner'?{...r,user_id:'other'}:r),count:start&&failure==='count'?202:201})};return q;};
    await assert.rejects(engine.prepare(h.ctx),/record-access-records/);assert.ok(!h.calls.some(c=>c[0]==='rpc'));
  }
});
test('complete multi-page proof reads all rows without fetching or modifying other members',async()=>{
  const h=await fixture();const item=h.rows[0];h.rows.splice(0,h.rows.length,...Array.from({length:201},(_,i)=>({...item,id:'entry-'+String(i).padStart(4,'0')})));
  let reads=0;const engine=Access.create({sb:h.sb,privateCrypto:{importKey:async()=>({}),read:async()=>{reads++;return {text:'synthetic'};}}});
  await engine.prepare(h.ctx);assert.equal(reads,201);assert.deepEqual(h.calls.filter(c=>c[0]==='range').map(c=>c.slice(1)),[[0,199],[200,399]]);
  assert.ok(h.calls.filter(c=>c[0]==='eq'&&c[1]==='private_entries').every(c=>c[2]==='user_id'&&c[3]===member.id));
});
test('actual Google identity and approved exact owner/salt are required before any key RPC',async()=>{
  for(const alteration of [h=>h.user({...google,id:'99999999-2222-4333-8444-555555555555'}),h=>h.user({...google,identities:[{provider:'email'}]}),h=>h.profile({...member,approval_status:'pending'}),h=>h.profile({...member,is_deleted:true}),h=>h.profile({...member,id:'other'}),h=>h.profile({...member,pbkdf2_salt:'ffffffffffffffffffffffffffffffff'})]){
    const h=await fixture();alteration(h);await assert.rejects(h.engine.get(h.ctx));assert.ok(!h.calls.some(c=>c[0]==='rpc'));
  }
});
test('blocked recovery and stale epochs prevent both proof and key RPCs',async()=>{
  for(const alter of [h=>h.block(),h=>h.stop()]){const h=await fixture();alter(h);await assert.rejects(h.engine.prepare(h.ctx),/record-access-stale/);assert.equal(h.calls.length,0);}
  let h;h=await fixture({onProfile:async()=>h.stop()});await assert.rejects(h.engine.get(h.ctx),/record-access-stale/);assert.ok(!h.calls.some(c=>c[0]==='rpc'));
});
test('a changed profile after proof cannot authorize a completed result',async()=>{
  let h;h=await fixture({rpc:async(name,args,{ready,material})=>{const response=await ready(name==='growell_google_record_access_get'?material:args.p_key_b64);h.profile({...member,pbkdf2_salt:'ffffffffffffffffffffffffffffffff'});return {data:response};}});
  await assert.rejects(h.engine.prepare(h.ctx),/record-access-(?:profile|response)/);
});
test('get and prepare reject a changed key generation even when its key bytes return to the same value',async()=>{
  for(const operation of ['get','prepare']){
    let count=0;const h=await fixture({rpc:async(name,args,{ready,material})=>{const value=await ready(material);if(++count>1)value.accessId='bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';return {data:value};}});
    await assert.rejects(h.engine[operation](h.ctx),/record-access-conflict/);assert.ok(!h.calls.some(c=>c[0]==='rpc'&&c[1].includes('rotate')));
  }
});
test('key conflicts and malformed server results never invoke automatic rotation',async()=>{
  for(const kind of ['conflict','different-key','digest','owner']){
    const h=await fixture({rpc:async(name,args,{ready,material})=>{
      if(kind==='conflict')return {error:{code:'40001',message:'must not surface server details'}};
      const result=await ready(kind==='different-key'?await Private.exportKey(await Private.newKey()):material);
      if(kind==='digest')result.keyDigest='0'.repeat(64);if(kind==='owner')result.profile.id='other';return {data:result};}});
    await assert.rejects(h.engine.prepare(h.ctx),/record-access-(?:conflict|response)/);assert.ok(!h.calls.some(c=>c[0]==='rpc'&&c[1].includes('rotate')));
  }
});
test('formal rotation proves the recovered key and uses the prior digest as compare-and-swap evidence',async()=>{
  const old=await Private.exportKey(await Private.newKey());
  let rotated=false;const h=await fixture({rpc:async(name,args,{ready,material})=>{if(name==='growell_google_record_access_rotate')rotated=true;return {data:await ready(name==='growell_google_record_access_get'?(rotated?material:old):args.p_key_b64)};}});
  const before=JSON.stringify(h.records);await h.engine.rotate(h.ctx);assert.equal(JSON.stringify(h.records),before);
  const args=h.calls.find(c=>c[0]==='rpc'&&c[1]==='growell_google_record_access_rotate')[2];
  assert.equal(args.p_expected_digest,await Access.digest(old));assert.equal(args.p_key_b64,h.material);assert.equal(args.p_key_digest,await Access.digest(h.material));assert.equal(args.p_expected_access_id,'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
});
test('a truly new Google signup sends nickname, random salt and random key atomically without a password',async()=>{
  let registered;
  const h=await fixture({rpc:async(name,args)=>{if(name==='growell_oauth_profile')return {data:{status:'new',profile:null}};registered=clone(args);return {data:{status:'approval-required',profile:{...member,approval_status:'pending'},keyB64:null,keyDigest:null,accessId:null,version:1}};}});
  const result=await h.engine.register({authUserId:authId,current:()=>true},'  새별명  ');
  assert.equal(result.status,'approval-required');assert.equal(h.newKeys(),1);assert.equal(registered.p_name,'새별명');assert.match(registered.p_salt,/^[a-f0-9]{32}$/);assert.equal(Access.keyBytes(registered.p_key_b64).length,32);
  assert.deepEqual(Object.keys(registered).sort(),['p_key_b64','p_name','p_salt']);assert.ok(!h.calls.some(c=>c[0]==='range'));
});
test('existing and simultaneous Google registrations always use the original stored key',async()=>{
  for(const raced of [false,true]){
    const h=await fixture({rpc:async(name,args,{ready})=>({data:name==='growell_oauth_profile'?(raced?{status:'new',profile:null}:{status:'legacy',profile:member}):await ready(h.material)})});
    const result=await h.engine.register({authUserId:authId,current:()=>true},'별명');assert.equal(result.keyB64,h.material);assert.equal(h.newKeys(),raced?1:0);
    assert.ok(!h.calls.some(c=>c[0]==='rpc'&&['growell_google_record_access_prepare','growell_google_record_access_rotate'].includes(c[1])));
  }
});
test('pending existing members and invalid nicknames never create an additional key',async()=>{
  const h=await fixture({rpc:async()=>({data:{status:'legacy',profile:{...member,approval_status:'pending'}}})});
  assert.equal((await h.engine.register({authUserId:authId,current:()=>true},'별명')).status,'approval-required');assert.equal(h.newKeys(),0);
  for(const name of ['', 'x'.repeat(31)])await assert.rejects(h.engine.register({authUserId:authId,current:()=>true},name),/record-access-name/);
});
