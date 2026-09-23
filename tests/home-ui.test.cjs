const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const GrowellHome=require('../homeDomain.js');
const GrowellHabits=require('../habitDomain.js');
const GrowellReadingTimer=require('../readingTimerDomain.js');
const GrowellDailyVerse=require('../dailyVerseDomain.js');
const source=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const homeSource=source.slice(source.indexOf('function homeUnlockedIds(){'),source.indexOf('function welcomeHomeHtml(){'));
const announcementSource=source.slice(source.indexOf('function canEditAnnouncement(){'),source.indexOf('function announceEditHtml(){'));
const authorSource=source.slice(source.indexOf('function publicAuthorHtml('),source.indexOf('/* 헤더 프로필 버튼용',source.indexOf('function publicAuthorHtml(')));
const escSource=source.slice(source.indexOf('function esc(s){'),source.indexOf('function nlToBr('));
const timerSource=source.slice(source.indexOf('function readingTimerElapsedMs(){'),source.indexOf('function activeReadingStripHtml('));
const closeNoteSource=source.slice(source.indexOf('function closeReadingNoteDialog(){'),source.indexOf('function openReadingNote('));
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
  const c={GrowellHome,GrowellHabits,GrowellReadingTimer,GrowellDailyVerse,GrowellDailyVerses:[{reference:'검증 출처',text:'검증용 말씀 <본문>'}],Promise,Date,JSON,Array,Set,Map,encodeURIComponent,
    BOOKS:books,SESSION:{userId:'me',keyB64:'my-key'},saveSessionEpoch:1,
    STATE:{posts:{},privateEntries:{},worksheets:{},habits:{},users:{me:{id:'me',name:'회원'}},readingMeta:{},readingLogs:{},announcement:{reading:{bookId:'emotion'},next:{}}},
    INSIGHT_QUESTIONS:[{key:'q1'},{key:'q2'},{key:'q3'}],
    bookById:id=>books.find(book=>book.id===id),isBookLocked:book=>!!book.locked,
    ymd:()=> '2026-09-21',habitWithPendingChecks:habit=>({...habit,checkedDates:habit.checkedDates||[]}),
    habitSaveIntents:{},sharedPostsLoadState:'ready',
    memberLoadState:{privateEntries:'ready',habits:'ready',readingMeta:'ready',readingLogs:'ready'},
    readingTimer:null,readingTimerRestoreOwner:'me',readingSaveAttempt:null,readingSavePanelOpen:false,readingEndPage:null,
    readingTimerStorageOwner:null,readingTimerStorageSnapshot:null,readingTimerStorageWritable:true,
    readingSaveBusy:false,readingSaveError:false,readingFinishKind:'finish',readingTimerIntervalId:null,
    readingNoteReturn:null,readingHomeReturn:false,readingHomeDialogFor:null,readingHomeDialogPosition:null,
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
    svgIcon:()=>'',avatarHtml:()=>'',I_LOCK:'',I_BOOKMARK:'',I_TIMER:'',isAdmin:()=>false,editingAnnouncement:false,announcementSaveBusy:false,announcementEditDraft:null,
    loginGateHtml:message=>message,sharePostCardHtml:()=>'<article>shared</article>'};
  vm.createContext(c);vm.runInContext(escSource+authorSource+timerSource+closeNoteSource+timerEventsSource+announcementSource+homeSource,c);
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
  assert.ok(html.includes('오늘의 말씀'));assert.ok(html.includes('147 / 200쪽'));
  assert.ok(html.includes('role="progressbar"'));assert.ok(html.includes('1 / 1 완료'));
  assert.ok(html.includes('data-home-habit="mine"'));assert.ok(html.includes('data-home-write="emotion"'));
  assert.ok(html.includes('href="#/book/emotion/mine"'));assert.ok(!html.includes('OTHER PRIVATE HABIT'));
  assert.ok(!html.includes('로그인하고 이어 읽기'));
});
test('home meeting presents only date, time, place and reading range without preparation panels',()=>{
  const {c}=harness();
  c.STATE.announcement={next:{date:'9월 28일',time:'19:30',place:'모임 공간 <2층>',note:'숨겨야 할 추가 안내'},reading:{bookId:'thought',chapter:'3장',range:'80~120쪽',note:'숨겨야 할 읽기 메모',concept:'숨겨야 할 개념'}};
  c.homeMeetingOpen=true;
  const html=c.homeHtml(),meeting=html.match(/<section class="home-card home-meeting">([\s\S]*?)<\/section>/)[1];
  assert.match(meeting,/<dt>날짜<\/dt><dd>9월 28일<\/dd>/);
  assert.match(meeting,/<dt>시간<\/dt><dd>19:30<\/dd>/);
  assert.match(meeting,/<dt>장소<\/dt><dd>모임 공간 &lt;2층&gt;<\/dd>/);
  assert.match(meeting,/<dt>읽을 범위<\/dt><dd>3장 · 80~120쪽<\/dd>/);
  assert.doesNotMatch(meeting,/button|생각의 책|숨겨야/);
  assert.doesNotMatch(html,/준비 보기|data-home-meeting|home-meeting-details|모임 안내 · 전체 독서 여정|숨겨야/);
});

test('only active administrators see home meeting editing controls with escaped current values',()=>{
  const {c}=harness();
  assert.doesNotMatch(c.homeMeetingHtml(),/btn-edit-announcement/);
  c.STATE.users.me.isAdmin=true;
  assert.match(c.homeMeetingHtml(),/aria-label="이번 모임 수정"/);
  c.editingAnnouncement=true;c.STATE.announcement.next.place='2층 "모임방" <안내>';
  const html=c.homeMeetingHtml();
  assert.match(html,/value="2층 &quot;모임방&quot; &lt;안내&gt;"/);
  for(const id of ['an-date','an-time','an-place','an-chapter','an-range'])assert.match(html,new RegExp('id="'+id+'"'));
  assert.doesNotMatch(html,/an-next-note|an-book|an-meeting-no|an-reading-note/);
  c.announcementEditDraft=JSON.parse(JSON.stringify(c.STATE.announcement));c.announcementEditDraft.next.place='화면 갱신 중인 입력';
  assert.match(c.homeMeetingHtml(),/value="화면 갱신 중인 입력"/,'rerender uses the editing draft');
  c.STATE.users.me.isDeleted=true;assert.doesNotMatch(c.homeMeetingHtml(),/btn-save-announcement|btn-edit-announcement/);
  c.SESSION=null;assert.doesNotMatch(c.homeMeetingHtml(),/btn-save-announcement|btn-edit-announcement/);
});

test('home meeting save patches visible fields while preserving the shared book and hidden announcement fields',async()=>{
  const {c,renders}=harness();c.STATE.users.me.isAdmin=true;c.editingAnnouncement=true;
  c.STATE.announcement={next:{date:'이전 날짜',time:'18:00',place:'이전 장소',note:'준비물 유지'},reading:{bookId:'thought',meetingNo:'3',chapter:'2장',range:'30~60쪽',concept:'개념 유지',note:'메모 유지'}};
  const button={},inputs={'an-date':{value:' 10월 1일 '},'an-time':{value:'19:00'},'an-place':{value:'새 모임방'},'an-chapter':{value:'3장'},'an-range':{value:'60~90쪽'},'btn-save-announcement':button};
  c.document.getElementById=id=>inputs[id]||null;
  let pending;c.saveState=(mutate,opts)=>{pending={mutate,opts};return Promise.resolve(true);};
  const saved=c.saveAnnouncementEdit(button);
  assert.equal(c.editingAnnouncement,true);assert.equal(c.announcementSaveBusy,true);
  assert.equal(await c.saveAnnouncementEdit(button),false,'double submission is ignored');
  const next=JSON.parse(JSON.stringify(c.STATE));pending.mutate(next);c.STATE=next;
  assert.equal(next.announcement.next.date,'10월 1일');assert.equal(next.announcement.reading.range,'60~90쪽');
  assert.equal(next.announcement.next.note,'준비물 유지');assert.equal(next.announcement.reading.bookId,'thought');
  assert.equal(next.announcement.reading.meetingNo,'3');assert.equal(next.announcement.reading.concept,'개념 유지');assert.equal(next.announcement.reading.note,'메모 유지');
  pending.opts.onSuccess();await saved;
  assert.equal(c.editingAnnouncement,false);assert.equal(renders.length,1);assert.match(c.homeMeetingHtml(),/10월 1일/);
});

test('failed meeting save preserves editing and input; queued saves recheck administrator access',async()=>{
  const {c,renders}=harness();c.STATE.users.me.isAdmin=true;c.editingAnnouncement=true;
  const input={value:'수정 중인 장소'};c.document.getElementById=id=>id==='an-place'?input:null;
  let pending;c.saveState=(mutate,opts)=>{pending={mutate,opts};return Promise.resolve(false);};
  const saved=c.saveAnnouncementEdit({});pending.opts.onFailure();await saved;
  assert.equal(c.editingAnnouncement,true);assert.equal(input.value,'수정 중인 장소');assert.equal(renders.length,0);
  c.STATE.users.me.isAdmin=false;
  assert.throws(()=>pending.mutate(JSON.parse(JSON.stringify(c.STATE))),/관리자만/);
  assert.equal(await c.saveAnnouncementEdit({}),false);
});
test('today habit keeps the name and goal with compact escaped time and place without inventing defaults',()=>{
  const {c}=harness();
  const habit={id:'mine',name:'책 읽기',goal:'15분 <집중>',time:'21:00',place:'거실 & 소파',checkedDates:[]};
  const html=c.homeHabitRowsHtml([habit]);
  assert.match(html,/home-habit-name">책 읽기/);assert.match(html,/<b>목표<\/b> <span>15분 &lt;집중&gt;/);
  assert.match(html,/<b>시간<\/b> <span>21:00/);assert.match(html,/<b>장소<\/b> <span>거실 &amp; 소파/);
  const unset=c.homeHabitRowsHtml([{...habit,time:'',place:''}]);
  assert.match(unset,/<b>시간<\/b> <span>미설정/);assert.match(unset,/<b>장소<\/b> <span>미설정/);
});
test('home shows the complete escaped daily verse and reference in place of the old greeting',()=>{
  const {c}=harness();c.GrowellDailyVerses=[{reference:'긴 말씀',text:'긴 문장은 모바일 표시 목록에서 제외합니다. '.repeat(4)},{reference:'출처 <1:1>',text:'짧은 말씀 <원문>을 그대로 표시합니다.'}];
  const html=c.homeHtml();
  assert.match(html,/오늘의 말씀/);assert.match(html,/짧은 말씀 &lt;원문&gt;을 그대로 표시합니다\./);assert.doesNotMatch(html,/긴 문장은/);
  assert.match(html,/출처 &lt;1:1&gt;/);assert.doesNotMatch(html,/오늘은 여기서 이어가요|님, 독서와 작은 습관/);
});
test('the Korean midnight update refreshes only the verse, preserves other content and avoids duplicate lifecycle listeners',()=>{
  const {c,renders}=harness();let now=Date.parse('2026-09-23T23:59:50+09:00'),writes=0,visible=true;
  let verse={dateKey:'2026-09-23',text:'오늘 원문',reference:'오늘 출처'};
  c.Date=class extends Date{static now(){return now;}};c.GrowellDailyVerse={getCompact:()=>verse};
  const attributes={'data-verse-date':'2026-09-23'},panel={getAttribute:key=>attributes[key],setAttribute:(key,value)=>{attributes[key]=value;},set innerHTML(value){writes++;this.content=value;}};
  const pending=[],cleared=[],listeners={};
  c.document.querySelector=()=>visible?panel:null;c.document.addEventListener=(name,handler)=>{assert.equal(listeners[name],undefined);listeners[name]=handler;};
  c.window={addEventListener:(name,handler)=>{assert.equal(listeners[name],undefined);listeners[name]=handler;}};
  c.setTimeout=(handler,delay)=>{pending.push({handler,delay});return pending.length;};c.clearTimeout=id=>cleared.push(id);
  c.bindHomeDailyVerse();assert.equal(pending[0].delay,10025);assert.equal(writes,0);
  c.bindHomeDailyVerse();assert.equal(cleared.length,1);assert.deepEqual(Object.keys(listeners).sort(),['pageshow','visibilitychange']);
  now=Date.parse('2026-09-24T00:00:00.025+09:00');verse={dateKey:'2026-09-24',text:'다음 날 원문',reference:'다음 출처'};
  pending.at(-1).handler();assert.equal(writes,1);assert.match(panel.content,/다음 날 원문/);assert.equal(renders.length,0);
  listeners.visibilitychange();assert.equal(writes,1);assert.equal(renders.length,0);
  visible=false;const scheduled=pending.length;c.bindHomeDailyVerse();assert.equal(pending.length,scheduled);assert.equal(c.document._homeDailyVerseTimer,null);
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
  assert.equal(c.location.hash,'#/');assert.equal(c.readingHomeDialogFor,c.readingTimer.id);assert.equal(c.readingHomeReturn,true);
  assert.equal(c.readingTimer.bookId,'thought');assert.equal(c.readingTimer.userId,'me');
  assert.equal(c.readingTimer.startPage,42);assert.equal(c.readingTimer.running,true);
  const saved=JSON.parse(storage.get('growell_reading_timer_v2:me'));
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
  assert.equal(c.location.hash,'#/');assert.equal(c.readingHomeDialogFor,'active-reading');
  assert.equal(c.readingTimer.id,'active-reading');assert.equal(c.readingTimer.elapsedMs,65000);
  assert.equal(c.readingTimer.startPage,12);assert.equal(c.readingTimer.running,false);
});

test('home note-choice close retires only its popup and preserves the reading session',()=>{
  const {c}=harness(),closed=[],opened=[];
  c.readingTimer=GrowellReadingTimer.create({id:'active-reading',userId:'me',bookId:'emotion',startPage:12,running:false,elapsedMs:65000},Date.now());
  c.readingHomeDialogFor='active-reading';
  const timer=c.readingTimer,button=control({}),dialog={open:true,events:{},close(){this.open=false;},addEventListener(name,fn){this.events[name]=fn;}};
  const homeDialog={open:true,addEventListener(){}};
  const getElementById=c.document.getElementById;
  c.document.getElementById=id=>id==='reading-note-dialog'?dialog:id==='reading-home-dialog'?homeDialog:id==='btn-reading-note-close'?button:getElementById(id);
  c.GrowellPopupHistory={open:key=>opened.push(key),closed:key=>closed.push(key)};
  c.bindReadingTimerEvents();button.events.click();
  assert.equal(dialog.open,false);assert.equal(homeDialog.open,true);assert.deepEqual(opened,['reading-home']);assert.deepEqual(closed,['reading-note']);
  assert.equal(c.readingTimer,timer);assert.equal(c.readingHomeDialogFor,'active-reading');assert.equal(c.location.hash,'#/');
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
