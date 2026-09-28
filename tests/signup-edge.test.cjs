'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');

// Execute the actual Edge handler with an isolated in-memory Supabase adapter.
// No network requests, real credentials, accounts, or production rows are used.
const source=stripTypeScriptTypes(fs.readFileSync(path.join(__dirname,'../server/signup.ts'),'utf8')
  .replace(/^import\s+\{\s*createClient\s*\}\s+from\s+'npm:[^']+'\s*$/m,''));
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iHAAAAAASUVORK5CYII=';
const freshAuthId='00000000-0000-4000-8000-000000000001';
const freshProfileId='u_signup_fixture';
const valid=()=>({loginId:'New_Member',name:' 새 회원 ',password:'FixturePassword42!',salt:'a'.repeat(32),pwHint:' fixture hint ',avatarDataUrl:'data:image/png;base64,'+png,adminCode:'must-not-grant-admin'});

function harness(failure={}){
  let handler;
  const calls=[];
  const state={auth:false,avatar:false,profile:null,hint:null,notification:false,existingAccount:true};
  async function stage(name,data,apply){
    calls.push(name);
    if(failure[name]==='throw')throw new Error('synthetic network error');
    if(failure[name]==='error')return {data:null,error:{message:'synthetic backend error'}};
    if(apply)apply();
    if(failure[name]==='throw-after')throw new Error('synthetic uncertain response');
    return {data,error:null};
  }
  const client={
    rpc(name,input){
      assert.equal(name,'growell_finalize_signup');
      assert.equal(input.p_profile_id,freshProfileId);assert.equal(input.p_auth_user_id,freshAuthId);
      assert.equal(input.p_pw_hint,failure.expectedHint||'fixture hint');
      return stage('hint',{hintSaved:true,notificationQueued:true},()=>{state.hint=input.p_pw_hint;state.notification=true;});
    },
    auth:{admin:{
      createUser:input=>{assert.equal(input.email,'new_member@growell.internal');return stage('create',{user:{id:freshAuthId}},()=>{state.auth=true;});},
      deleteUser:id=>{assert.equal(id,freshAuthId,'cleanup must use only the newly created Auth ID');return stage('delete-auth',null,()=>{state.auth=false;});}
    }},
    storage:{from(bucket){assert.equal(bucket,'avatars');return {
      upload:(file,bytes,options)=>{assert.equal(file,freshAuthId+'/avatar.png');assert.equal(options.upsert,false);assert.ok(bytes.length>8);return stage('upload',null,()=>{state.avatar=true;});},
      getPublicUrl:file=>({data:{publicUrl:'https://example.invalid/avatars/'+file}}),
      remove:files=>{assert.deepEqual(Array.from(files),[freshAuthId+'/avatar.png']);return stage('delete-avatar',null,()=>{state.avatar=false;});}
    };}},
    from(table){
      let action=null,payload=null,filters=[],result;
      function execute(){
        if(result)return result;
        result=(async()=>{
          if(table==='profiles'&&action==='select'){
            assert.deepEqual(filters,[['login_id','new_member']]);
            return stage('lookup',failure.duplicate?{id:'existing-member'}:null);
          }
          if(table==='profiles'&&action==='insert'){
            assert.equal(payload.auth_user_id,freshAuthId);
            assert.equal(payload.approval_status,'pending');
            assert.equal(payload.is_admin,false);
            assert.equal(payload.name,'새 회원');
            const profile={...payload,id:freshProfileId};
            return stage('profile',profile,()=>{state.profile=profile;});
          }
          if(table==='profile_secrets'&&action==='insert'){
            assert.equal(payload.user_id,freshProfileId);assert.equal(payload.pw_hint,'fixture hint');
            return stage('hint',null,()=>{state.hint=payload.pw_hint;});
          }
          if(table==='profiles'&&action==='delete'){
            assert.deepEqual(filters,[['auth_user_id',freshAuthId]],'no existing profile cleanup is permitted');
            return stage('delete-profile',null,()=>{state.profile=null;state.notification=false;});
          }
          if(table==='profile_secrets'&&action==='delete'){
            assert.deepEqual(filters,[['user_id',freshProfileId]]);
            return stage('delete-hint',null,()=>{state.hint=null;});
          }
          assert.fail('Unexpected database action '+table+'/'+action);
        })();
        return result;
      }
      const query={
        select(){if(!action)action='select';return query;},
        insert(row){action='insert';payload=row;return query;},
        delete(){action='delete';return query;},
        eq(key,value){filters.push([key,value]);return query;},
        maybeSingle:execute,single:execute,
        then(resolve,reject){return execute().then(resolve,reject);}
      };
      return query;
    }
  };
  const context={Response,Request,Uint8Array,atob,Date,
    createClient:()=>client,
    Deno:{env:{get:()=> 'synthetic-runtime-value'},serve:fn=>{handler=fn;}}};
  vm.runInNewContext(source,context,{filename:'signup.ts'});
  async function request(body=valid(),options={}){
    const response=await handler(new Request('https://example.invalid/signup',{
      method:options.method||'POST',headers:{'Content-Type':'application/json'},
      ...(options.method==='GET'||options.method==='OPTIONS'?{}:{body:options.raw??JSON.stringify(body)})
    }));
    const raw=await response.text();
    return {status:response.status,body:raw==='ok'?raw:JSON.parse(raw)};
  }
  return {request,calls,state};
}

test('invalid signup shapes, salt, required hint and malformed attached photo fail before any backend call',async()=>{
  const cases=[null,[],3,'text',{}, {...valid(),name:{}},{...valid(),loginId:{}},
    {...valid(),password:42},{...valid(),password:'short'},{...valid(),salt:123},
    {...valid(),salt:'bad-salt'},{...valid(),pwHint:''},{...valid(),pwHint:{}},{...valid(),pwHint:'   '},
    {...valid(),avatarDataUrl:{}},{...valid(),avatarDataUrl:0},{...valid(),avatarDataUrl:false},
    {...valid(),avatarDataUrl:' '},{...valid(),avatarDataUrl:'data:text/html;base64,PGgxPkJBRDwvaDE+'},
    {...valid(),avatarDataUrl:'data:image/png;base64,YmFkLWltYWdl'}];
  for(const body of cases){
    const h=harness(),res=await h.request(body);
    assert.equal(res.status,400,JSON.stringify(body));assert.equal(res.body.ok,undefined);
    assert.deepEqual(h.calls,[]);
  }
  const h=harness();assert.equal((await h.request(null,{raw:'{'})).status,400);assert.deepEqual(h.calls,[]);
});

test('signup with a photo stores it and the required hint and returns only pending ordinary membership',async()=>{
  const h=harness(),res=await h.request();
  assert.equal(res.status,200);assert.equal(res.body.ok,true);assert.equal(res.body.pendingApproval,true);
  assert.equal(res.body.profile.approval_status,'pending');assert.equal(res.body.profile.is_admin,false);
  assert.equal(res.body.hintSaved,true);assert.equal(res.body.pwHint,undefined);assert.equal(res.body.profile.pw_hint,undefined);
  assert.deepEqual(h.calls,['lookup','create','upload','profile','hint']);
  assert.equal(h.state.auth,true);assert.equal(h.state.avatar,true);assert.equal(h.state.hint,'fixture hint');
  assert.equal(h.state.notification,true);
});

test('signup without an optional photo skips storage and still awaits approval with a hint and notice',async()=>{
  for(const avatarDataUrl of [undefined,null,'']){
    const h=harness(),res=await h.request({...valid(),avatarDataUrl});
    assert.equal(res.status,200);assert.equal(res.body.ok,true);assert.equal(res.body.pendingApproval,true);
    assert.equal(res.body.profile.avatar_url,null);assert.equal(res.body.profile.approval_status,'pending');
    assert.equal(res.body.profile.is_admin,false);assert.equal(res.body.hintSaved,true);
    assert.deepEqual(h.calls,['lookup','create','profile','hint']);
    assert.equal(h.state.avatar,false);assert.equal(h.state.hint,'fixture hint');assert.equal(h.state.notification,true);
  }
});

test('serialized hint question and answer stay a single exact hint value at the server boundary',async()=>{
  const hint=JSON.stringify({version:1,questionId:'fixture-question',answer:'임시 답변'});
  const h=harness({expectedHint:hint}),res=await h.request({...valid(),avatarDataUrl:null,pwHint:hint});
  assert.equal(res.status,200);assert.equal(h.state.hint,hint);assert.equal(res.body.hintSaved,true);
  assert.doesNotMatch(JSON.stringify(res.body),/fixture-question|임시 답변/);
});

test('duplicate IDs and pre-creation failures never clean up an existing account',async()=>{
  for(const failure of [{duplicate:true},{lookup:'error'},{lookup:'throw'},{create:'error'},{create:'throw'}]){
    const h=harness(failure),res=await h.request();
    assert.ok(res.status>=400);assert.equal(res.body.ok,undefined);
    assert.ok(!h.calls.some(name=>name.startsWith('delete-')));assert.equal(h.state.existingAccount,true);
  }
});

test('photo or profile failures clean only resources created by the failed application',async()=>{
  for(const failure of [{upload:'error'},{upload:'throw-after'},{profile:'error'},{profile:'throw-after'}]){
    const h=harness(failure),res=await h.request();
    assert.equal(res.status,500);assert.equal(res.body.ok,undefined);assert.equal(res.body.cleanupRequired,undefined);
    assert.equal(h.state.auth,false);assert.equal(h.state.avatar,false);assert.equal(h.state.profile,null);
    assert.equal(h.state.existingAccount,true);assert.ok(!h.calls.includes('hint'));
    assert.ok(h.calls.includes('delete-profile'));assert.ok(h.calls.includes('delete-auth'));
  }
});

test('hint save errors and uncertain responses cannot report signup success or leave a pending account',async()=>{
  for(const fault of ['error','throw','throw-after']){
    const h=harness({hint:fault}),res=await h.request();
    assert.equal(res.status,500);assert.equal(res.body.ok,undefined);assert.equal(res.body.hintSaved,undefined);
    assert.equal(h.state.auth,false);assert.equal(h.state.avatar,false);assert.equal(h.state.profile,null);assert.equal(h.state.hint,null);
    assert.equal(h.state.notification,false,'compensation removes any notice for the failed application');
    assert.deepEqual(h.calls.slice(-4),['delete-hint','delete-avatar','delete-profile','delete-auth']);
    assert.equal(h.state.existingAccount,true);
  }
});

test('photo-less signup failures clean only new profile, hint and Auth resources without touching storage',async()=>{
  for(const failure of [{profile:'throw-after'},{hint:'error'},{hint:'throw-after'}]){
    const h=harness(failure),res=await h.request({...valid(),avatarDataUrl:null});
    assert.equal(res.status,500);assert.equal(res.body.ok,undefined);
    assert.equal(h.state.auth,false);assert.equal(h.state.profile,null);assert.equal(h.state.hint,null);
    assert.equal(h.state.notification,false);assert.equal(h.state.existingAccount,true);
    assert.ok(!h.calls.includes('upload'));assert.ok(!h.calls.includes('delete-avatar'));
    assert.ok(h.calls.includes('delete-profile'));assert.ok(h.calls.includes('delete-auth'));
  }
});

test('cleanup continues after one cleanup operation fails and reports incomplete cleanup',async()=>{
  const h=harness({hint:'error','delete-avatar':'throw'}),res=await h.request();
  assert.equal(res.status,500);assert.equal(res.body.cleanupRequired,true);assert.equal(res.body.ok,undefined);
  assert.ok(h.calls.includes('delete-profile'));assert.ok(h.calls.includes('delete-auth'));
  assert.equal(h.state.profile,null);assert.equal(h.state.auth,false);assert.equal(h.state.existingAccount,true);
});

test('OPTIONS and unsupported methods do not inspect or mutate account data',async()=>{
  const h=harness();assert.equal((await h.request(null,{method:'OPTIONS'})).status,200);
  assert.equal((await h.request(null,{method:'GET'})).status,405);assert.deepEqual(h.calls,[]);
});
