'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {resolve,promise};}

function renderHarness(admin=false){
  const c={SESSION:{userId:'owner',name:'내 <별명>'},STATE:{users:{owner:{name:'내 <별명>',loginId:'member',authUserId:'auth-owner',isAdmin:admin,avatar:'https://example.test/avatar.jpg'}}},pendingProfileAvatar:undefined,
    isAdmin:()=>admin,canAccessWorksheet:()=>true,esc:escape,svgIcon:icon=>'<svg aria-hidden="true">'+icon+'</svg>',I_LOCK:'',I_SUN:'<svg data-sun></svg>',I_MOON:'<svg data-moon></svg>',
    GrowellProfile:require('../profile.js'),document:{documentElement:{getAttribute:()=> 'light'}},window:{},profilePhotoPickerHtml:()=>'<div id="photo-picker"></div>',GrowellPasswordHint:{formHtml:()=>'<div id="password-hint"></div>'},recoveryPanelHtml:()=>'<section id="recovery-panel">복구</section>'};
  vm.createContext(c);vm.runInContext(section('function themeModeLabel(','function footerHtml('),c);vm.runInContext(section('function headerAvatarHtml(','/* 색상 메뉴'),c);vm.runInContext(section('function profileEditHtml(','/* ---------------- render: checkin picker'),c);return c;
}

test('signed-in header orders theme, archive and profile, and puts logout last inside the dropdown',()=>{
  for(const admin of [false,true]){
    const c=renderHarness(admin),html=c.headerHtml({view:'archive'}),top=html.slice(html.indexOf('<div class="header-actions">'),html.indexOf('<div class="header-inner header-nav-row">'));
    const beforeMenu=top.slice(0,top.indexOf('<div class="profile-dropdown"'));
    assert.ok(beforeMenu.indexOf('id="btn-theme"')<beforeMenu.indexOf('header-archive-link'));assert.ok(beforeMenu.indexOf('header-archive-link')<beforeMenu.indexOf('id="btn-profile-toggle"'));
    assert.match(beforeMenu,/<a class="icon-btn header-archive-link is-active" href="#\/archive" aria-label="아카이브" title="아카이브" aria-current="page">/);assert.match(beforeMenu,/id="btn-profile-toggle"[^>]+aria-controls="profile-dropdown"/);assert.match(beforeMenu,/avatar.jpg/);assert.doesNotMatch(beforeMenu,/로그아웃|btn-logout|btn-delete-account/);
    const menu=top.slice(top.indexOf('<div class="profile-dropdown"'));assert.match(menu,/id="profile-dropdown" hidden/);assert.match(menu,/href="#\/archive" id="btn-profile-archive">아카이브/);assert.match(menu,/href="#\/profile\/edit"/);assert.doesNotMatch(menu,/계정 삭제|btn-delete-account/);assert.match(menu,/내 &lt;별명&gt;/);
    const items=[...menu.matchAll(/<(?:a|button) class="profile-dropdown-item[^>]*>([^<]*)<\/(?:a|button)>/g)].map(match=>match[1]);assert.equal(items.at(-1),'로그아웃');assert.equal((html.match(/id="btn-logout"/g)||[]).length,1);assert.ok(items.includes(admin?'가입자 목록':'운영자 코드 입력'));
  }
});

test('signed-out header retains theme and login without exposing account actions',()=>{
  const c=renderHarness();c.SESSION=null;const html=c.headerHtml({view:'home'});assert.match(html,/id="btn-theme"/);assert.match(html,/id="btn-login-open"/);assert.doesNotMatch(html,/btn-logout|profile-dropdown|btn-delete-account/);
});

test('profile places collapsed account deletion after recovery with a masked password confirmation',()=>{
  const c=renderHarness(),html=c.profileEditHtml();assert.ok(html.indexOf('id="profile-delete-settings"')>html.indexOf('id="recovery-panel"'));
  assert.match(html,/<details class="profile-delete-settings" id="profile-delete-settings"><summary>계정 삭제<\/summary>/);assert.match(html,/<input type="password" id="profile-delete-password" autocomplete="current-password" aria-describedby="profile-delete-note" required>/);assert.match(html,/<button[^>]+id="btn-delete-account" type="submit">비밀번호 확인 후 삭제/);assert.match(html,/되돌릴 수 없어요/);assert.match(html,/공유한 나눔 글은 남아요/);assert.match(html,/id="btn-pe-save"/);assert.match(html,/id="btn-pe-hint-save"/);
  c.SESSION.authKind='oauth';const oauth=c.profileEditHtml();assert.match(oauth,/탈퇴는 관리자에게 요청/);assert.doesNotMatch(oauth,/id="profile-delete-password"|id="btn-delete-account"/);
});

function deleteHarness(options={}){
  const calls=[],toasts=[],c={Promise,SESSION:{userId:'owner',name:'회원'},saveSessionEpoch:3,STATE:{users:{owner:{id:'owner',loginId:'member',authUserId:'auth-owner'},other:{id:'other',name:'다른 회원'}}},location:{hash:'#/profile/edit'},
    confirm:()=>{calls.push(['confirm']);return options.confirm!==false;},window:{prompt:()=>{calls.push(['prompt']);return options.prompt??null;}},loginEmailFor:id=>id+'@growell.internal',showToast:(...args)=>toasts.push(args),render:()=>calls.push(['render'])};
  c.sb={auth:{signInWithPassword:async credentials=>{calls.push(['verify',{...credentials}]);return options.verify?options.verify(credentials):{data:{user:{id:'auth-owner'}},error:null};},getSession:async()=>{calls.push(['session']);return options.session?options.session():{data:{session:{access_token:'synthetic-token',user:{id:'auth-owner'}}},error:null};}}};
  c.callEdgeFunction=async(...args)=>{calls.push(['edge',...args]);return options.edge?options.edge():{__status:200,ok:true};};
  c.doLogout=()=>{calls.push(['logout']);c.SESSION=null;c.saveSessionEpoch++;};
  vm.createContext(c);vm.runInContext(section('function doDeleteAccount(','/* 프로필 수정 —'),c);return {c,calls,toasts};
}

test('self deletion calls the mocked API only after current-password verification for the same auth identity',async()=>{
  const h=deleteHarness(),button={disabled:false,isConnected:true,textContent:'비밀번호 확인 후 삭제'};await h.c.doDeleteAccount(null,'synthetic-password',button);
  assert.deepEqual(h.calls.map(call=>call[0]),['confirm','verify','session','edge','logout','render']);assert.deepEqual(h.calls.find(call=>call[0]==='verify')[1],{email:'member@growell.internal',password:'synthetic-password'});
  const edge=h.calls.find(call=>call[0]==='edge');assert.equal(edge[1],'delete-account');assert.equal(JSON.stringify(edge[2]),'{}');assert.equal(edge[3],'synthetic-token');assert.equal(h.c.STATE.users.owner,undefined);assert.equal(h.c.STATE.users.other.name,'다른 회원');assert.equal(button.disabled,false);assert.equal(h.c.location.hash,'#/');
});

test('cancelled, blank, wrong and incomplete password verification never call deletion or alter stored members',async()=>{
  const cases=[{password:'',options:{}},{password:null,options:{}},{password:'synthetic-password',options:{confirm:false}},{password:'synthetic-password',options:{verify:()=>({error:{message:'wrong'}})}},{password:'synthetic-password',options:{verify:()=>null}},{password:'synthetic-password',options:{verify:()=>({data:{user:{id:'auth-other'}},error:null})}},{password:'synthetic-password',options:{session:()=>({data:{session:null}})}},{password:'synthetic-password',options:{session:()=>({data:{session:{access_token:'synthetic-token',user:{id:'auth-other'}}}})}}];
  for(const {password,options} of cases){const h=deleteHarness(options),before=JSON.stringify(h.c.STATE);await h.c.doDeleteAccount(null,password);assert.equal(h.calls.some(call=>call[0]==='edge'),false);assert.equal(h.calls.some(call=>call[0]==='logout'),false);assert.equal(JSON.stringify(h.c.STATE),before);}
  const wrong=deleteHarness({verify:()=>({error:{}})});await wrong.c.doDeleteAccount(null,'synthetic-wrong');assert.match(wrong.toasts[0][0],/비밀번호가 올바르지/);
});

test('missing profile identity and OAuth self-deletion cannot fall through to the API',async()=>{
  for(const scenario of ['signed-out','missing-profile','missing-auth-id','oauth']){const h=deleteHarness();if(scenario==='signed-out')h.c.SESSION=null;else if(scenario==='missing-profile')delete h.c.STATE.users.owner;else if(scenario==='missing-auth-id')delete h.c.STATE.users.owner.authUserId;else h.c.SESSION.authKind='oauth';await h.c.doDeleteAccount(null,'synthetic-password');assert.equal(h.calls.length,0);}
});

test('session or epoch changes during password checking or token loading prevent deletion',async()=>{
  for(const phase of ['verify','session'])for(const change of ['owner','epoch']){
    const pending=deferred(),h=deleteHarness({[phase]:()=>pending.promise}),before=JSON.stringify(h.c.STATE),work=h.c.doDeleteAccount(null,'synthetic-password');await new Promise(resolve=>setImmediate(resolve));
    if(change==='owner')h.c.SESSION={userId:'other'};else h.c.saveSessionEpoch++;
    pending.resolve(phase==='verify'?{data:{user:{id:'auth-owner'}},error:null}:{data:{session:{access_token:'synthetic-token',user:{id:'auth-owner'}}},error:null});await work;
    assert.equal(h.calls.some(call=>call[0]==='edge'),false);assert.equal(h.calls.some(call=>call[0]==='logout'),false);assert.equal(JSON.stringify(h.c.STATE),before);
  }
});

test('repeated confirmation during verification cannot queue another delete request',async()=>{
  const pending=deferred(),h=deleteHarness({verify:()=>pending.promise}),button={disabled:false,isConnected:true};
  const work=h.c.doDeleteAccount(null,'synthetic-password',button);assert.equal(button.disabled,true);await h.c.doDeleteAccount(null,'synthetic-password',button);pending.resolve({data:{user:{id:'auth-owner'}},error:null});await work;
  assert.equal(h.calls.filter(call=>call[0]==='verify').length,1);assert.equal(h.calls.filter(call=>call[0]==='edge').length,1);assert.equal(button.disabled,false);
});

test('the existing administrator action retains its explicit target and never removes the signed-in profile',async()=>{
  const h=deleteHarness();await h.c.doDeleteAccount('other');assert.equal(h.calls.some(call=>call[0]==='verify'||call[0]==='prompt'||call[0]==='logout'),false);const edge=h.calls.find(call=>call[0]==='edge');assert.equal(edge[1],'delete-account');assert.equal(edge[2].targetUserId,'other');assert.ok(h.c.STATE.users.owner);assert.equal(h.c.STATE.users.other.isDeleted,true);assert.equal(h.c.SESSION.userId,'owner');
});

test('failed deletion leaves the account intact and a late success never logs out a newer member',async()=>{
  const failure=deleteHarness({edge:()=>({__status:403,ok:false})}),before=JSON.stringify(failure.c.STATE);await failure.c.doDeleteAccount(null,'synthetic-password');assert.equal(JSON.stringify(failure.c.STATE),before);assert.equal(failure.calls.some(call=>call[0]==='logout'),false);assert.match(failure.toasts[0][0],/실패/);
  const pending=deferred(),late=deleteHarness({edge:()=>pending.promise}),work=late.c.doDeleteAccount(null,'synthetic-password');await new Promise(resolve=>setImmediate(resolve));late.c.SESSION={userId:'other'};late.c.saveSessionEpoch++;pending.resolve({__status:200,ok:true});await work;assert.equal(late.c.SESSION.userId,'other');assert.ok(late.c.STATE.users.owner);assert.equal(late.calls.some(call=>call[0]==='logout'),false);
});

test('profile deletion form clears secrets on submission or collapse and blocks repeat or stale submissions',()=>{
  const h=deleteHarness(),nodes={};for(const id of ['profile-delete-form','profile-delete-settings','profile-delete-password','btn-delete-account'])nodes[id]={value:'',open:false,disabled:false,listeners:{},addEventListener(event,fn){this.listeners[event]=fn;},focus(){h.c.document.activeElement=this;}};
  h.c.document={getElementById:id=>nodes[id],activeElement:null};const submitted=[];h.c.doDeleteAccount=(...args)=>submitted.push(args);h.c.bindAccountDeletion();
  const form=nodes['profile-delete-form'],details=nodes['profile-delete-settings'],input=nodes['profile-delete-password'],button=nodes['btn-delete-account'],event={preventDefault(){}};
  form.listeners.submit(event);assert.equal(submitted.length,0);assert.equal(h.c.document.activeElement,input);details.open=true;details.listeners.toggle();assert.equal(h.c.document.activeElement,input);
  input.value='synthetic-password';form.listeners.submit(event);assert.equal(input.value,'');assert.equal(submitted.length,1);assert.equal(submitted[0][0],null);assert.equal(submitted[0][1],'synthetic-password');assert.equal(submitted[0][2],button);
  input.value='synthetic-password';details.open=false;details.listeners.toggle();assert.equal(input.value,'');input.value='synthetic-password';button.disabled=true;form.listeners.submit(event);assert.equal(submitted.length,1);button.disabled=false;h.c.saveSessionEpoch++;form.listeners.submit(event);assert.equal(submitted.length,1);h.c.SESSION={userId:'other'};form.listeners.submit(event);assert.equal(submitted.length,1);
});

test('dropdown logout and profile form deletion remain bound to their separate actions',()=>{
  const handlers={},c={document:{getElementById:id=>id==='btn-logout'?{addEventListener:(name,fn)=>{handlers[name]=fn;}}:null},doLogout:()=>{c.loggedOut=true;},bindAccountDeletion:()=>{c.boundDeletion=true;},app:{querySelectorAll:()=>[]}};vm.createContext(c);vm.runInContext(section('  var logoutBtn =','  app.querySelectorAll(\'[data-auth-tab]\')'),c);assert.equal(c.boundDeletion,true);handlers.click();assert.equal(c.loggedOut,true);
});
