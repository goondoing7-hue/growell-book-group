'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
const helper=section('function reportProfileReadFailure(','function scheduleMemberSessionRestore(');
function harness(consoleValue){const logs=[],context={JSON,Number,console:consoleValue===undefined?{warn:(...args)=>logs.push(args)}:consoleValue};vm.createContext(context);vm.runInContext(helper,context);return{context,logs};}
test('profile diagnostics report only fixed stage, validated error code and numeric HTTP status',()=>{
  const h=harness(),source={status:401,statusText:'PRIVATE STATUS',data:{id:'PRIVATE MEMBER'},error:{code:'PGRST301',message:'PRIVATE JWT',details:'PRIVATE TOKEN',hint:'PRIVATE EMAIL'},headers:{Authorization:'PRIVATE SECRET'}};
  const before=JSON.stringify(source);h.context.reportProfileReadFailure('restore',source);
  assert.equal(h.logs.length,1);assert.equal(h.logs[0][0],'growell: profile-read');assert.deepEqual(JSON.parse(h.logs[0][1]),{stage:'restore',code:'PGRST301',status:401});
  assert.equal(JSON.stringify(h.logs).includes('PRIVATE'),false);assert.equal(JSON.stringify(source),before);
  h.context.reportProfileReadFailure('login',{status:403,error:{code:'42501'}});assert.deepEqual(JSON.parse(h.logs[1][1]),{stage:'login',code:'42501',status:403});
});
test('arbitrary values and thrown logging getters cannot disclose data or change the login result',()=>{
  const h=harness();
  for(const source of [null,undefined,{status:'401',error:{code:'PRIVATE TOKEN'}},{status:999,error:{code:'PGRST301 PRIVATE'}},{status:NaN,error:{code:{secret:'PRIVATE'}}}])h.context.reportProfileReadFailure('login',source);
  for(const log of h.logs)assert.deepEqual(JSON.parse(log[1]),{stage:'login',code:null,status:null});
  const count=h.logs.length;h.context.reportProfileReadFailure('PRIVATE STAGE',{status:401,error:{code:'PGRST301'}});assert.equal(h.logs.length,count);
  assert.doesNotThrow(()=>h.context.reportProfileReadFailure('login',{get error(){throw new Error('PRIVATE');}}));
  assert.doesNotThrow(()=>harness({warn(){throw new Error('PRIVATE');}}).context.reportProfileReadFailure('restore',{status:401,error:{code:'PGRST301'}}));
  assert.equal(JSON.stringify(h.logs).includes('PRIVATE'),false);
});
test('both profile failure paths keep original control flow and invoke only the safe helper',()=>{
  const restore=section('function restoreMemberSession(','function retryMemberSession('),login=section('function doLogin(','function doLogout(');
  assert.match(restore,/reportProfileReadFailure\('restore',profileResult\);\s*throw memberSessionFailure\(null,false\);/);
  assert.match(login,/reportProfileReadFailure\('login',profRes\);\s*throw new Error\('profile-not-found'\);/);
  assert.doesNotMatch(helper,/localStorage|sessionStorage|fetch\(|signOut\(|SESSION\s*=|\.message|\.details|\.hint|\.data|Authorization/);
});
