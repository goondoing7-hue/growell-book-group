const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const GrowellHome=require('../homeDomain.js');
const GrowellReadingTimer=require('../readingTimerDomain.js');
const source=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const homeSource=source.slice(source.indexOf('function homeUnlockedIds(){'),source.indexOf('function welcomeHomeHtml(){'));
const authorSource=source.slice(source.indexOf('function publicAuthorHtml('),source.indexOf('/* 헤더 프로필 버튼용',source.indexOf('function publicAuthorHtml(')));
const escSource=source.slice(source.indexOf('function esc(s){'),source.indexOf('function nlToBr('));
const timerSource=source.slice(source.indexOf('function readingTimerElapsedMs(){'),source.indexOf('function activeReadingStripHtml('));
const timerEventsSource=source.slice(source.indexOf('function bindReadingTimerEvents(){'),source.indexOf('function submitWorksheet('));
const cardDateSource=source.slice(source.indexOf('function fmtPostDate('),source.indexOf('function initials('));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

test('card dates use local calendar days instead of treating the previous 24 hours as today',()=>{
  const context={Date};vm.createContext(context);vm.runInContext(cardDateSource,context);
  const reference=new Date(2026,8,23,0,5).getTime();
  assert.equal(context.fmtPostDate(new Date(2026,8,23,0,1).getTime(),reference),'오늘');
  assert.equal(context.fmtPostDate(new Date(2026,8,22,23,59).getTime(),reference),'어제');
  assert.equal(context.fmtPostDate(new Date(2026,8,21,23,59).getTime(),reference),'9월 21일');
});

test('short card dates handle year boundaries and keep older years unambiguous',()=>{
  const context={Date};vm.createContext(context);vm.runInContext(cardDateSource,context);
  const reference=new Date(2026,0,1,9).getTime();
  assert.equal(context.fmtPostDate(new Date(2025,11,31,15).getTime(),reference),'어제');
  assert.equal(context.fmtPostDate(new Date(2025,11,30,15).getTime(),reference),'2025.12.30');
  assert.equal(context.fmtPostDate(new Date(2026,0,2,9).getTime(),reference),'1월 2일');
  assert.equal(context.fmtPostDate('invalid-date',reference),'날짜 없음');
});
function control(attrs){
  return {attrs,events:{},checked:false,getAttribute:key=>attrs[key],hasAttribute:key=>key in attrs,
    addEventListener(event,handler){this.events[event]=handler;}};
}
function harness(){
  const controls={},queued=[],opened=[],renders=[],createdElements=[],toasts=[],storage=new Map();
  const books=[{id:'emotion',title:'감정의 책',totalPages:200},{id:'thought',title:'생각의 책',totalPages:250},{id:'locked',title:'잠긴 책',locked:true}];
  const c={GrowellHome,GrowellReadingTimer,Promise,Date,JSON,Array,Set,Map,encodeURIComponent,
    BOOKS:books,SESSION:{userId:'me',keyB64:'my-key'},saveSessionEpoch:1,
    STATE:{posts:{},privateEntries:{},worksheets:{},habits:{},users:{me:{id:'me',name:'회원'}},readingMeta:{},readingLogs:{},announcement:{reading:{bookId:'emotion'},next:{}}},
    INSIGHT_QUESTIONS:[{key:'q1'},{key:'q2'},{key:'q3'}],
    bookById:id=>books.find(book=>book.id===id),isBookLocked:book=>!!book.locked,
    ymd:()=> '2026-09-21',habitWithPendingChecks:habit=>({...habit,checkedDates:habit.checkedDates||[]}),
    habitSaveIntents:{},homeMeetingOpen:false,sharedPostsLoadState:'ready',
    memberLoadState:{privateEntries:'ready',habits:'ready',readingMeta:'ready',readingLogs:'ready'},
    readingTimer:null,readingTimerRestoreOwner:'me',readingSaveAttempt:null,readingSavePanelOpen:false,readingEndPage:null,
    readingSaveBusy:false,readingSaveError:false,readingFinishKind:'finish',readingTimerIntervalId:null,
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    setInterval:()=>1,clearInterval:()=>{},tickReadingTimer:()=>{},uid:prefix=>prefix+'-ui-test',showToast:(...args)=>toasts.push(args),
    mineComposerOpenFor:null,mineEditingId:'old-edit',mineEditingPayload:{title:'old edit'},
    location:{hash:'#/'},render:()=>renders.push(true),refreshHomePosts:()=>{},
    sanitizeHtml:()=>{throw new Error('Raw preview content must not be parsed by the active-DOM sanitizer');},
    document:{
      _readingLifecycleBound:true,
      querySelectorAll:selector=>controls[selector]||[],querySelector:()=>null,
      getElementById:id=>id==='app'?{querySelectorAll:selector=>controls[selector]||[]}:id==='note-editor'?{focus(){}}:null,
      createElement(tag){
        createdElements.push(tag);assert.equal(tag,'template','preview only creates an inert template');
        let markup='';
        const template={get innerHTML(){return markup;},set innerHTML(value){markup=value;},
          content:{
            querySelectorAll(selector){
              const tags=selector.split(',').map(s=>s.trim()).join('|');
              const pattern=new RegExp('<('+tags+')\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>','gi');
              return [...markup.matchAll(pattern)].map(match=>({remove(){markup=markup.replace(match[0],'');}}));
            },
            get textContent(){return markup.replace(/<[^>]*>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');}
          }};
        return template;
      }
    },
    queueHabitCheck:(...args)=>queued.push(args),
    openComposerWithDraft:(...args)=>{opened.push(args);},
    memberDataStatusHtml:()=>'',currentUser:()=>c.SESSION && c.STATE.users[c.SESSION.userId] || null,myCurrentPage:()=>0,
    myReadingLogs:bookId=>Object.values(c.STATE.readingLogs).filter(log=>c.SESSION&&log.userId===c.SESSION.userId&&log.bookId===bookId),
    totalReadSeconds:bookId=>c.myReadingLogs(bookId).reduce((sum,log)=>sum+log.seconds,0),
    svgIcon:()=>'',avatarHtml:()=>'',I_LOCK:'',I_BOOKMARK:'',I_TIMER:'',isAdmin:()=>false,editingAnnouncement:false,
    loginGateHtml:message=>message,sharePostCardHtml:()=>'<article>shared</article>'};
  vm.createContext(c);vm.runInContext(escSource+authorSource+timerSource+timerEventsSource+homeSource,c);
  return {c,controls,queued,opened,renders,createdElements,toasts,storage};
}

test('home feed consumes public posts only and escapes shared text, names and route IDs',()=>{
  const {c}=harness();
  c.STATE.users.other={name:'<img src=x onerror=attack()>'};
  c.STATE.privateEntries.secret={id:'secret',bookId:'emotion',userId:'other',title:'PRIVATE SENTINEL',iv:'x',data:'x'};
  c.STATE.worksheets.secret={id:'worksheet',bookId:'emotion',userId:'other',data:{text:'WORKSHEET SENTINEL'}};
  c.STATE.posts.shared={id:'p/"<x>',bookId:'emotion',userId:'other',noteType:'insight',title:'<script>title</script>',q1:'<svg onload=attack()>hello',createdAt:100};
  c.STATE.posts.own={id:'own',bookId:'emotion',userId:'me',noteType:'insight',q1:'MY POST',createdAt:200};
  c.STATE.posts.locked={id:'locked',bookId:'locked',userId:'other',noteType:'insight',q1:'LOCKED',createdAt:300};
  const posts=c.homeRecentPosts(3),html=c.homePostsHtml(posts);
  assert.equal(posts.length,1);assert.equal(posts[0].id,'p/"<x>');
  assert.ok(!html.includes('PRIVATE SENTINEL'));assert.ok(!html.includes('WORKSHEET SENTINEL'));
  assert.ok(!html.includes('<script'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('<svg'));
  assert.ok(html.includes('&lt;script&gt;title&lt;/script&gt;'));
  assert.ok(html.includes('#/community/post/p%2F%22%3Cx%3E'));
  c.SESSION=null;
  const guestPosts=c.homeRecentPosts(),guestHtml=c.homePostsHtml(guestPosts);
  assert.equal(guestPosts.length,2,'guests can read valid public posts, including the former signed-in member posts');
  assert.ok(guestHtml.includes('#/community/post/p%2F%22%3Cx%3E'));
  assert.ok(!guestHtml.includes('PRIVATE SENTINEL'));assert.ok(!guestHtml.includes('WORKSHEET SENTINEL'));
  assert.ok(!guestHtml.includes('LOCKED'));
});

test('first-time guests see the dashboard with real book and login actions without personal progress or private content',()=>{
  const {c}=harness();c.SESSION=null;
  c.STATE.users.me.name='PRIVATE MEMBER NAME';
  c.STATE.privateEntries.secret={id:'secret',bookId:'emotion',userId:'me',title:'PRIVATE NOTE',html:'PRIVATE BODY',iv:'secret',data:'ciphertext'};
  c.STATE.worksheets.secret={id:'worksheet',bookId:'emotion',userId:'me',data:{text:'PRIVATE WORKSHEET'}};
  c.STATE.habits.secret={id:'secret',bookId:'emotion',userId:'me',name:'PRIVATE HABIT',checkedDates:['2026-09-21']};
  c.STATE.readingMeta.me={bookId:'emotion',userId:'me',currentPage:147,updatedAt:100};
  c.myCurrentPage=()=>147;
  const html=c.homeHtml();
  assert.ok(html.includes('home-dashboard'));
  for(const label of ['함께 읽는 책','오늘의 습관','나만 보는 기록','이번 모임','모임원의 새 글']) assert.ok(html.includes(label),label);
  assert.ok(html.includes('감정의 책'));assert.match(html,/200\s*쪽/);
  assert.match(html,/<a[^>]*href="#\/login"[^>]*>로그인하고 이어 읽기/);
  assert.ok(!html.includes('role="progressbar"'));assert.ok(!html.includes('147 / 200'));
  assert.ok(!html.includes('data-home-habit-count'));assert.ok(!html.includes('data-home-habit="'));
  assert.ok(!html.includes('data-home-write="'));assert.ok(!html.includes('PRIVATE'));
});

test('member dashboard keeps own reading progress, habit controls and private composer action',()=>{
  const {c}=harness();c.myCurrentPage=()=>147;
  c.STATE.habits.mine={id:'mine',bookId:'emotion',userId:'me',name:'나의 독서 습관',checkedDates:['2026-09-21']};
  c.STATE.habits.other={id:'other',bookId:'emotion',userId:'other',name:'OTHER PRIVATE HABIT',checkedDates:['2026-09-21']};
  const html=c.homeHtml();
  assert.ok(html.includes('회원님'));assert.ok(html.includes('147 / 200쪽'));
  assert.ok(html.includes('role="progressbar"'));assert.ok(html.includes('1 / 1 완료'));
  assert.ok(html.includes('data-home-habit="mine"'));assert.ok(html.includes('data-home-write="emotion"'));
  assert.ok(html.includes('href="#/book/emotion/mine"'));assert.ok(!html.includes('OTHER PRIVATE HABIT'));
  assert.ok(!html.includes('로그인하고 이어 읽기'));
});

test('home timer start opens the selected reading book with its saved page and persists one session',()=>{
  const {c,controls,storage}=harness();
  c.STATE.readingMeta.latest={userId:'me',bookId:'thought',currentPage:42,updatedAt:200};
  c.STATE.readingMeta.older={userId:'me',bookId:'emotion',currentPage:100,updatedAt:100};
  c.myCurrentPage=bookId=>bookId==='thought'?42:100;
  const html=c.homeHtml(),match=html.match(/data-reading-start="([^"]+)"/);
  assert.equal(match&&match[1],'thought');
  assert.ok(html.includes('42 / 250쪽'));
  const button=control({'data-reading-start':match[1]});
  controls['[data-reading-start]']=[button];c.bindReadingTimerEvents();button.events.click();
  assert.equal(c.location.hash,'#/book/thought/mine');
  assert.equal(c.readingTimer.bookId,'thought');assert.equal(c.readingTimer.userId,'me');
  assert.equal(c.readingTimer.startPage,42);assert.equal(c.readingTimer.running,true);
  const saved=JSON.parse(storage.get('growell_reading_timer_v1:me'));
  assert.equal(saved.timer.id,c.readingTimer.id);assert.equal(saved.timer.startPage,42);
});

test('home returns to the active reading book without replacing its accumulated timer',()=>{
  const {c,controls}=harness();
  c.STATE.readingMeta.latest={userId:'me',bookId:'thought',currentPage:42,updatedAt:200};
  c.readingTimer=GrowellReadingTimer.create({id:'active-reading',userId:'me',bookId:'emotion',startPage:12,running:false,elapsedMs:65000},Date.now());
  const html=c.homeHtml(),match=html.match(/data-reading-start="([^"]+)"/);
  assert.equal(match&&match[1],'emotion');assert.ok(html.includes('타이머로 돌아가기'));
  assert.match(html,/data-reading-elapsed>00:01:05/);
  const button=control({'data-reading-start':match[1]});
  controls['[data-reading-start]']=[button];c.bindReadingTimerEvents();button.events.click();
  assert.equal(c.location.hash,'#/book/emotion/mine');
  assert.equal(c.readingTimer.id,'active-reading');assert.equal(c.readingTimer.elapsedMs,65000);
  assert.equal(c.readingTimer.startPage,12);assert.equal(c.readingTimer.running,false);
});

test('guest home ignores a former member timer and reading totals and only offers login',()=>{
  const {c}=harness();c.SESSION=null;
  c.readingTimer=GrowellReadingTimer.create({id:'private-timer',userId:'me',bookId:'thought',startPage:42,running:false,elapsedMs:65000},Date.now());
  c.STATE.readingLogs.secret={id:'private-log',userId:'me',bookId:'thought',seconds:7200,createdAt:Date.now()};
  c.STATE.readingMeta.latest={userId:'me',bookId:'thought',currentPage:42,updatedAt:200};
  const html=c.homeHtml();
  assert.ok(html.includes('감정의 책'));assert.ok(!html.includes('생각의 책'));
  for(const privateMarker of ['data-reading-start','data-reading-elapsed','reading-home-stats','reading-home-active','00:01:05','타이머로 돌아가기']){
    assert.ok(!html.includes(privateMarker),privateMarker);
  }
  assert.ok(html.includes('로그인하고 이어 읽기'));
  c.startReading('thought');
  assert.equal(c.location.hash,'#/login');assert.equal(c.readingTimer.id,'private-timer');
});

test('home cannot start a timer until both reading progress and logs are loaded',()=>{
  for(const pendingKey of ['readingMeta','readingLogs']){
    const {c,toasts,storage}=harness();c.memberLoadState[pendingKey]='loading';
    assert.ok(!c.homeHtml().includes('data-reading-start='),pendingKey);
    c.startReading('emotion');
    assert.equal(c.readingTimer,null);assert.equal(c.location.hash,'#/');assert.equal(storage.size,0);
    assert.ok(toasts.some(([message])=>message.includes('불러온 뒤 시작')));
    c.memberLoadState[pendingKey]='ready';
    assert.ok(c.homeHtml().includes('data-reading-start="emotion"'));
  }
});

test('guests can browse public community lists and details but cannot expose private or locked posts',()=>{
  const {c}=harness();c.SESSION=null;
  c.STATE.posts.shared={id:'shared',bookId:'emotion',userId:'other',noteType:'insight',title:'PUBLIC NOTE',q1:'공개 글',createdAt:1};
  c.STATE.posts.locked={id:'locked',bookId:'locked',userId:'other',noteType:'insight',title:'LOCKED NOTE',q1:'잠긴 글',createdAt:2};
  c.STATE.privateEntries.secret={id:'secret',bookId:'emotion',userId:'other',title:'PRIVATE NOTE',iv:'secret',data:'ciphertext'};
  const card=c.homePostsHtml(c.homeRecentPosts());
  assert.ok(card.includes('PUBLIC NOTE'));assert.ok(card.includes('href="#/community/post/shared"'));
  const list=c.homeCommunityHtml({});
  assert.ok(list.includes('PUBLIC NOTE'));assert.ok(!list.includes('LOCKED NOTE'));assert.ok(!list.includes('PRIVATE NOTE'));
  const community=c.homeCommunityHtml({postId:'shared'});
  assert.ok(community.includes('<article>shared</article>'));
  for(const blockedId of ['locked','secret']){
    const detail=c.homeCommunityHtml({postId:blockedId});
    assert.ok(!detail.includes('<article>shared</article>'));assert.ok(!detail.includes('LOCKED NOTE'));assert.ok(!detail.includes('PRIVATE NOTE'));
  }
});

test('HTML snippets use the inert template path and omit script/style text',()=>{
  const {c,createdElements}=harness();
  const post={id:'test',bookId:'emotion',userId:'other',createdAt:1,
    html:'<p>첫 문장</p><script>PRIVATE SCRIPT CODE</script><style>body{display:none}</style><img src="https://invalid.test/pixel" onerror="attack()"><p>&lt;안전한 글&gt;</p>'};
  const html=c.homePostsHtml([post]);
  assert.deepEqual(createdElements,['template']);
  assert.ok(html.includes('첫 문장'));assert.ok(html.includes('&lt;안전한 글&gt;'));
  assert.ok(!html.includes('PRIVATE SCRIPT CODE'));assert.ok(!html.includes('display:none'));assert.ok(!html.includes('invalid.test'));
});

test('home checkbox forwards every rapid intent to the existing save queue and rejects other owners',()=>{
  const {c,controls,queued}=harness();
  c.STATE.habits.h1={id:'h1',bookId:'emotion',userId:'me',name:'읽기',checkedDates:[]};
  const input=control({'data-home-habit':'h1'});controls['[data-home-habit]']=[input];c.bindHomeEvents();
  for(const checked of [true,false,true]){input.checked=checked;input.events.change();}
  assert.deepEqual(queued,[['h1','2026-09-21',true],['h1','2026-09-21',false],['h1','2026-09-21',true]]);
  c.SESSION={userId:'other'};input.events.change();assert.equal(queued.length,3);
  c.SESSION=null;input.events.change();assert.equal(queued.length,3);
});

test('home private-write opens the draft on its target route and ignores late callbacks after navigation or account switch',()=>{
  const h=harness(),button=control({'data-home-write':'emotion'});
  h.controls['[data-home-write]']=[button];h.c.bindHomeEvents();button.events.click();
  assert.equal(h.c.location.hash,'#/book/emotion/mine');
  assert.equal(h.opened.length,1);assert.equal(h.opened[0][0],'mine');assert.equal(h.opened[0][2],null);
  h.opened[0][3]();assert.equal(h.c.mineComposerOpenFor,'emotion');assert.equal(h.c.mineEditingPayload,null);
  const rendered=h.renders.length;
  button.events.click();h.c.location.hash='#/community';h.opened[1][3]();assert.equal(h.renders.length,rendered);
  button.events.click();h.c.SESSION={userId:'other'};h.opened[2][3]();assert.equal(h.renders.length,rendered);
});

test('shared feed loading response from the previous account cannot replace current posts',async()=>{
  const {c}=harness(),fetch=deferred(),original={safe:{id:'safe'}};c.STATE.posts=original;
  c.sb={from:()=>({select:()=>fetch.promise})};
  c.mapPostRow=row=>row;
  const pending=c.refreshHomePosts();
  c.SESSION={userId:'other'};c.saveSessionEpoch++;
  fetch.resolve({data:[{id:'old-account-response'}],error:null});await pending;
  assert.equal(c.STATE.posts,original);
});

test('guests can retry a failed public post load without a login session',async()=>{
  const {c}=harness();c.SESSION=null;c.sharedPostsLoadState='error';let reads=0;
  const post={id:'retried',bookId:'emotion',userId:'other',noteType:'insight',title:'다시 불러온 공개 글',q1:'나눔',createdAt:1};
  c.sb={from:table=>{assert.equal(table,'posts');return {select:()=>{reads++;return Promise.resolve({data:[post],error:null});}};}};
  c.mapPostRow=row=>row;
  await c.refreshHomePosts();
  assert.equal(reads,1);assert.equal(c.sharedPostsLoadState,'ready');
  assert.equal(c.STATE.posts.retried.title,'다시 불러온 공개 글');
});
