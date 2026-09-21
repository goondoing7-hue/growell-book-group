const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const GrowellHome=require('../homeDomain.js');
const source=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const homeSource=source.slice(source.indexOf('function homeUnlockedIds(){'),source.indexOf('function welcomeHomeHtml(){'));
const escSource=source.slice(source.indexOf('function esc(s){'),source.indexOf('function nlToBr('));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function control(attrs){
  return {attrs,events:{},checked:false,getAttribute:key=>attrs[key],hasAttribute:key=>key in attrs,
    addEventListener(event,handler){this.events[event]=handler;}};
}
function harness(){
  const controls={},queued=[],opened=[],renders=[],createdElements=[];
  const books=[{id:'emotion',title:'감정의 책',totalPages:200},{id:'locked',title:'잠긴 책',locked:true}];
  const c={GrowellHome,Promise,Date,JSON,Array,Set,Map,encodeURIComponent,
    BOOKS:books,SESSION:{userId:'me',keyB64:'my-key'},saveSessionEpoch:1,
    STATE:{posts:{},privateEntries:{},worksheets:{},habits:{},users:{},readingMeta:{},announcement:{reading:{bookId:'emotion'},next:{}}},
    INSIGHT_QUESTIONS:[{key:'q1'},{key:'q2'},{key:'q3'}],
    bookById:id=>books.find(book=>book.id===id),isBookLocked:book=>!!book.locked,
    ymd:()=> '2026-09-21',habitWithPendingChecks:habit=>({...habit,checkedDates:habit.checkedDates||[]}),
    habitSaveIntents:{},homeMeetingOpen:false,sharedPostsLoadState:'ready',
    mineComposerOpenFor:null,mineEditingId:'old-edit',mineEditingPayload:{title:'old edit'},
    location:{hash:'#/'},render:()=>renders.push(true),refreshHomePosts:()=>{},
    sanitizeHtml:()=>{throw new Error('Raw preview content must not be parsed by the active-DOM sanitizer');},
    document:{
      querySelectorAll:selector=>controls[selector]||[],querySelector:()=>null,
      getElementById:id=>id==='note-editor'?{focus(){}}:null,
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
    memberDataStatusHtml:()=>'',currentUser:()=>({name:'회원'}),myCurrentPage:()=>0,
    svgIcon:()=>'',I_LOCK:'',I_BOOKMARK:'',isAdmin:()=>false,editingAnnouncement:false,
    loginGateHtml:message=>message,sharePostCardHtml:()=>'<article>shared</article>'};
  vm.createContext(c);vm.runInContext(escSource+homeSource,c);
  return {c,controls,queued,opened,renders,createdElements};
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
  c.SESSION=null;assert.equal(c.homeRecentPosts().length,0);
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
