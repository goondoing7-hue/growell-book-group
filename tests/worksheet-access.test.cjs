'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
const book={id:'emotion',accent:'emotion',area:'감정',title:'감정의 책',subtitle:'책 설명',cover:'covers/emotion.jpg',
  worksheet:{activities:[{key:'reflection',label:'관리자 활동 제목',desc:'관리자 활동 설명'}]}};
function harness(admin=false){
  const queued=[],toasts=[];
  const c={Date,Promise,esc,svgIcon:()=>'<svg data-lock-icon></svg>',I_LOCK:'',
    SESSION:{userId:'owner',name:'관리자'},saveSessionEpoch:3,
    STATE:{users:{owner:{id:'owner',isAdmin:admin,approvalStatus:'approved'}},worksheets:{
      existing:{id:'existing',bookId:'emotion',activityKey:'reflection',userId:'owner',createdAt:1,data:{answer:'기존 기록'}}}},
    worksheetOpenFor:{reflection:true},
    currentUser(){return c.SESSION&&c.STATE.users[c.SESSION.userId]||null;},
    myWorksheet:()=>({data:{answer:'나의 관리자 기록'}}),
    othersWorksheets:()=>[{userId:'other',userName:'다른 관리자',updatedAt:2,data:{answer:'다른 관리자 기록'}}],
    avatarHtml:()=>'',headerAvatarHtml:()=>'',headerThemeHtml:()=>'',fmtDate:()=> '오늘',worksheetSummary:(_,data)=>data.answer,
    readingChevronHtml:()=>'',worksheetFieldHtml:()=>'<textarea data-admin-field>나의 관리자 기록</textarea>',
    showToast:(message,error)=>toasts.push({message,error}),uid:()=> 'w-new',
    saveState:(mutate,options)=>{queued.push({mutate,options});},
    isBookLocked:()=>false,adminLockPanelHtml:()=>'',lockedBookGateHtml:()=>'',
    GrowellBookDetails:{coverHtml:()=>'',hintHtml:()=>''},readingDataReady:()=>false,
    mineTabHtml:()=>'',materialsTabHtml:()=>'',habitTabHtml:()=>'',shareTabHtml:()=>'',
    sb:{rpc:async()=>({data:[{book_id:'emotion',locked:false,revision:1},{book_id:'thought',locked:true,revision:1}]})}};
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../memberAccess.js'),'utf8'),c);
  vm.runInContext(section('function isAdmin()', 'function bookLockInfo(')+
    section('function worksheetTabHtml(', '/* ---------------- render: materials tab')+
    section('function submitWorksheet(', '/* ---------------- render: shell')+
    section('function headerHtml(', 'function footerHtml(')+
    section('function bookPageHtml(', '/* ---------------- master render'),c);
  c.GrowellMemberAccess.configure(c);
  return {c,queued,toasts};
}

test('guests and members of a locked worksheet cannot read its activity or response data',()=>{
  for(const guest of [false,true]){
    const {c}=harness(false);if(guest)c.SESSION=null;
    const unreadable={get worksheet(){assert.fail('restricted worksheet definitions must not be read');}};
    const html=c.worksheetTabHtml(unreadable);
    assert.match(html,/관리자가 잠근 활동지/);
    assert.doesNotMatch(html,/textarea|data-ws-submit|ws-roster|관리자 활동 제목|관리자 기록/);
  }
});

test('direct worksheet URLs retain a selectable locked main menu link and never disclose worksheet contents to guests or members',()=>{
  for(const guest of [false,true]){
    const {c}=harness(false);if(guest)c.SESSION=null;
    const html=c.bookPageHtml(book,'worksheet'),header=c.headerHtml({view:'book',bookId:'emotion',tab:'worksheet'});
    const link=header.match(/<a\b[^>]*href="#\/book\/emotion\/worksheet"[^>]*>[\s\S]*?<\/a>/)[0];
    assert.match(link,/data-lock-icon/);assert.match(link,/aria-label="활동지 · 잠김"/);
    assert.match(link,/title="관리자가 잠근 활동지예요\."/);assert.match(link,/aria-current="page"/);
    assert.doesNotMatch(link,/disabled/);
    assert.match(html,/관리자가 잠근 활동지/);assert.doesNotMatch(html,/data-book-tab=/);
    assert.doesNotMatch(html,/data-admin-field|관리자 활동 제목|관리자 활동 설명|다른 관리자 기록/);
  }
});

test('administrators keep existing worksheet fields, submitted records and an unlocked main menu link',()=>{
  const {c}=harness(true),html=c.bookPageHtml(book,'worksheet');
  assert.match(html,/관리자 활동 제목/);assert.match(html,/관리자 활동 설명/);
  assert.match(html,/나의 관리자 기록/);assert.match(html,/다른 관리자 기록/);
  assert.match(html,/data-ws-submit="reflection"/);
  const header=c.headerHtml({view:'book',bookId:'emotion',tab:'worksheet'}),link=header.match(/<a\b[^>]*href="#\/book\/emotion\/worksheet"[^>]*>[\s\S]*?<\/a>/)[0];
  assert.match(link,/aria-current="page"/);assert.doesNotMatch(link,/data-lock-icon|활동지 · 잠김|disabled|관리자 전용/);
  assert.doesNotMatch(html,/data-book-tab=/);
});

test('guest and member direct submit calls never enqueue writes or alter existing worksheets',()=>{
  for(const guest of [false,true]){
    const {c,queued,toasts}=harness(false);if(guest)c.SESSION=null;
    const before=clone(c.STATE.worksheets);
    c.submitWorksheet('emotion','reflection',{answer:'금지된 변경'},{});
    assert.equal(queued.length,0);assert.deepEqual(clone(c.STATE.worksheets),before);
    assert.match(toasts[0].message,/잠근 활동지/);
  }
});

test('queued worksheet writes recheck per-book access, account and session epoch',()=>{
  const changes=[c=>{c.STATE.users.owner.isAdmin=false;},c=>{c.SESSION=null;},
    c=>{c.STATE.users.other={id:'other',isAdmin:true,approvalStatus:'approved'};c.SESSION={userId:'other',name:'다른 관리자'};},c=>{c.saveSessionEpoch++;}];
  for(const change of changes){
    const {c,queued}=harness(true);
    c.submitWorksheet('emotion','reflection',{answer:'변경할 기록'},{});
    assert.equal(queued.length,1);change(c);
    const next=clone(c.STATE),before=clone(next.worksheets);
    assert.throws(()=>queued[0].mutate(next),/활동지가 잠겨/);
    assert.deepEqual(next.worksheets,before);
  }
});

test('an approved member can view and submit an opened book worksheet while other books stay locked',async()=>{
  const {c,queued}=harness(false);await c.GrowellMemberAccess.load();
  assert.equal(c.canAccessWorksheet('emotion'),true);assert.equal(c.canAccessWorksheet('thought'),false);
  const markup=c.bookPageHtml(book,'worksheet');assert.match(markup,/data-ws-submit="reflection"/);assert.doesNotMatch(markup,/worksheet-access-panel/);
  const link=c.headerHtml({view:'book',bookId:'emotion',tab:'worksheet'}).match(/<a\b[^>]*href="#\/book\/emotion\/worksheet"[^>]*>[\s\S]*?<\/a>/)[0];
  assert.match(link,/aria-current="page"/);assert.doesNotMatch(link,/data-lock-icon|활동지 · 잠김/);
  c.submitWorksheet('emotion','reflection',{answer:'회원 답변'},{});assert.equal(queued.length,1);
  const next=clone(c.STATE);queued[0].mutate(next);assert.equal(next.worksheets.existing.data.answer,'회원 답변');
  c.GrowellMemberAccess.reset();assert.throws(()=>queued[0].mutate(clone(c.STATE)),/활동지가 잠겨/);
});

test('authorized worksheet updates preserve the original record identity and creation date',()=>{
  const {c,queued}=harness(true);
  c.submitWorksheet('emotion','reflection',{answer:'새 관리자 기록'},{});
  const next=clone(c.STATE);queued[0].mutate(next);
  assert.equal(next.worksheets.existing.id,'existing');assert.equal(next.worksheets.existing.createdAt,1);
  assert.equal(next.worksheets.existing.userId,'owner');assert.equal(next.worksheets.existing.data.answer,'새 관리자 기록');
  assert.deepEqual(c.STATE.worksheets.existing.data,{answer:'기존 기록'});
});
