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
    STATE:{users:{owner:{id:'owner',isAdmin:admin}},worksheets:{
      existing:{id:'existing',bookId:'emotion',activityKey:'reflection',userId:'owner',createdAt:1,data:{answer:'기존 기록'}}}},
    worksheetOpenFor:{reflection:true},
    currentUser(){return c.SESSION&&c.STATE.users[c.SESSION.userId]||null;},
    myWorksheet:()=>({data:{answer:'나의 관리자 기록'}}),
    othersWorksheets:()=>[{userId:'other',userName:'다른 관리자',updatedAt:2,data:{answer:'다른 관리자 기록'}}],
    avatarHtml:()=>'',fmtDate:()=> '오늘',worksheetSummary:(_,data)=>data.answer,
    readingChevronHtml:()=>'',worksheetFieldHtml:()=>'<textarea data-admin-field>나의 관리자 기록</textarea>',
    showToast:(message,error)=>toasts.push({message,error}),uid:()=> 'w-new',
    saveState:(mutate,options)=>{queued.push({mutate,options});},
    isBookLocked:()=>false,adminLockPanelHtml:()=>'',lockedBookGateHtml:()=>'',
    mineTabHtml:()=>'',materialsTabHtml:()=>'',habitTabHtml:()=>'',shareTabHtml:()=>''};
  vm.createContext(c);
  vm.runInContext(section('function isAdmin()', 'function bookLockInfo(')+
    section('function worksheetTabHtml(', '/* ---------------- render: materials tab')+
    section('function submitWorksheet(', '/* ---------------- render: shell')+
    section('function bookPageHtml(', '/* ---------------- master render'),c);
  return {c,queued,toasts};
}

test('guest and member worksheet views show only the admin gate without reading activity or response data',()=>{
  for(const guest of [false,true]){
    const {c}=harness(false);if(guest)c.SESSION=null;
    const unreadable={get worksheet(){assert.fail('restricted worksheet definitions must not be read');}};
    const html=c.worksheetTabHtml(unreadable);
    assert.match(html,/활동지는 관리자만 열 수 있어요\./);
    assert.doesNotMatch(html,/textarea|data-ws-submit|ws-roster|관리자 활동 제목|관리자 기록/);
  }
});

test('direct worksheet URLs retain a selectable locked tab and never disclose worksheet contents to members',()=>{
  const {c}=harness(false),html=c.bookPageHtml(book,'worksheet');
  const tab=html.match(/<button\b[^>]*data-book-tab="worksheet"[^>]*>[\s\S]*?<\/button>/)[0];
  assert.match(tab,/book-tab-lock/);assert.match(tab,/aria-label="활동지 · 관리자 전용"/);
  assert.match(tab,/title="활동지는 관리자만 열 수 있어요\."/);
  assert.doesNotMatch(tab,/disabled/);
  assert.match(html,/활동지는 관리자만 열 수 있어요\./);
  assert.doesNotMatch(html,/data-admin-field|관리자 활동 제목|관리자 활동 설명|다른 관리자 기록/);
});

test('administrators keep the existing worksheet fields, submitted records and normal tab behavior',()=>{
  const {c}=harness(true),html=c.bookPageHtml(book,'worksheet');
  assert.match(html,/관리자 활동 제목/);assert.match(html,/관리자 활동 설명/);
  assert.match(html,/나의 관리자 기록/);assert.match(html,/다른 관리자 기록/);
  assert.match(html,/data-ws-submit="reflection"/);
  const tab=html.match(/<button\b[^>]*data-book-tab="worksheet"[^>]*>[\s\S]*?<\/button>/)[0];
  assert.doesNotMatch(tab,/book-tab-lock|disabled|관리자 전용/);
});

test('guest and member direct submit calls never enqueue writes or alter existing worksheets',()=>{
  for(const guest of [false,true]){
    const {c,queued,toasts}=harness(false);if(guest)c.SESSION=null;
    const before=clone(c.STATE.worksheets);
    c.submitWorksheet('emotion','reflection',{answer:'금지된 변경'},{});
    assert.equal(queued.length,0);assert.deepEqual(clone(c.STATE.worksheets),before);
    assert.match(toasts[0].message,/관리자만/);
  }
});

test('queued worksheet writes recheck administrator role, account and session epoch',()=>{
  const changes=[c=>{c.STATE.users.owner.isAdmin=false;},c=>{c.SESSION=null;},
    c=>{c.STATE.users.other={id:'other',isAdmin:true};c.SESSION={userId:'other',name:'다른 관리자'};},c=>{c.saveSessionEpoch++;}];
  for(const change of changes){
    const {c,queued}=harness(true);
    c.submitWorksheet('emotion','reflection',{answer:'변경할 기록'},{});
    assert.equal(queued.length,1);change(c);
    const next=clone(c.STATE),before=clone(next.worksheets);
    assert.throws(()=>queued[0].mutate(next),/관리자만/);
    assert.deepEqual(next.worksheets,before);
  }
});

test('authorized worksheet updates preserve the original record identity and creation date',()=>{
  const {c,queued}=harness(true);
  c.submitWorksheet('emotion','reflection',{answer:'새 관리자 기록'},{});
  const next=clone(c.STATE);queued[0].mutate(next);
  assert.equal(next.worksheets.existing.id,'existing');assert.equal(next.worksheets.existing.createdAt,1);
  assert.equal(next.worksheets.existing.userId,'owner');assert.equal(next.worksheets.existing.data.answer,'새 관리자 기록');
  assert.deepEqual(c.STATE.worksheets.existing.data,{answer:'기존 기록'});
});
