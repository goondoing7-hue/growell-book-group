 'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const source=stripTypeScriptTypes(fs.readFileSync(path.join(__dirname,'../server/signup.ts'),'utf8'));
function handler(){let serve;vm.runInNewContext(source,{Response,Deno:{serve:value=>{serve=value;},env:{get(){assert.fail('retired signup cannot read credentials');}}},createClient(){assert.fail('retired signup cannot access the database');}});return serve;}
test('retired ID enrollment rejects valid, invalid and stale clients before reading a body or accessing any member data',async()=>{
  const serve=handler();
  for(const body of ['{}','not-json',JSON.stringify({loginId:'synthetic',name:'임시',password:'fixture-only',adminCode:'fixture-only'})]){
    const request=new Request('https://example.invalid/signup',{method:'POST',body});request.json=()=>{assert.fail('no passwords or hint answers should be read');};
    const response=await serve(request);assert.equal(response.status,403);const result=await response.json();
    assert.equal(result.error,'google_signup_required');assert.equal(result.ok,undefined);assert.doesNotMatch(JSON.stringify(result),/fixture-only/);
  }
});
test('retired signup still supports preflight and rejects unsupported methods',async()=>{
  const serve=handler();assert.equal((await serve(new Request('https://example.invalid/signup',{method:'OPTIONS'}))).status,200);
  assert.equal((await serve(new Request('https://example.invalid/signup'))).status,405);
});
