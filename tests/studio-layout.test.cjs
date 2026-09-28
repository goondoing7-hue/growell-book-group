'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const privateCategories=require('../privateCategories.js');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));};
const book={id:'emotion',accent:'emotion'};
function harness(){
  const scheduled=[],decrypted=[],renders=[];
  const c={URL,Promise,Array,Object,JSON,String,esc,stripHtml:value=>String(value).replace(/<[^>]*>/g,''),
    fmtPostDate:()=> '오늘',fmtDate:()=> '2026. 9. 23.',svgIcon:()=>'',I_BACK:'',I_LOCK:'',I_EDIT:'',I_SETTINGS:'',I_TRASH:'',
    NOTE_TYPE_INSIGHT:{key:'insight',label:'통찰 정리'},NOTE_TYPES:[],INSIGHT_QUESTIONS:[{key:'q1'},{key:'q2'},{key:'q3'}],
    noteTypeOf:key=>key==='thought'?{key,label:'내 생각'}:null,
    publicAuthorHtml:(id,name)=>'<button type="button" data-community-author="'+esc(id)+'">'+esc(name)+'</button>',
    commentsForPost:()=>[{}],SESSION:{userId:'owner',name:'독서회원',keyB64:'key-a'},saveSessionEpoch:1,
    STATE:{posts:{},privateEntries:{}},sharedPostsLoadState:'ready',shareFeedFilter:{},
    GrowellPrivateCategories:privateCategories,GrowellArchiveDomain:require('../archiveDomain.js'),
    GrowellArchive:{reflectionHtml:theme=>'<section data-archive-reflection="'+esc(theme)+'"><h3>'+esc({emotion:'감정',thought:'생각',body:'신체',action:'행동'}[theme])+'에 대한 고찰</h3></section>'},memberLoadState:{privateEntries:'ready'},
    ensureKey:()=>Promise.resolve('synthetic-key'),decryptPrivateRecord:()=>Promise.resolve(privateCategories.encode([])),
    document:{getElementById:()=>null,querySelector:()=>null},
    currentRoute:()=>({view:'book',bookId:'emotion',tab:'mine'}),render:()=>renders.push(true),
    shareComposerOpenFor:null,shareEditingId:null,shareComposerNoteType:null,shareComposerInsightMode:false,
    mineComposerOpenFor:null,mineEditingId:null,mineEditingPayload:null,
    noteComposerHtml:(b,options)=>'<form id="'+options.containerId+'"><textarea id="note-editor"></textarea></form>',
    spaceHeadingHtml:(b,type)=>'<header data-heading="'+type+'"></header>',spacePromptHtml:()=>'<div data-question></div>',
    loginGateHtml:()=>'<div data-login-gate></div>',feedToolbarHtml:()=>'<div data-filters></div>',feedSearchHtml:()=>'<input type="search">',
    sharePostCardHtml:(b,post)=>'<section data-shared-detail="'+post.id+'">'+esc(post.title)+'</section>',
    readingCardHtml:()=>'<section data-reading-timer></section>',memberDataStatusHtml:()=>'',
    setTimeout:callback=>{scheduled.push(callback);},decryptListInto:entries=>decrypted.push(...entries)};
  vm.createContext(c);
  vm.runInContext(section('function safePhotoUrl(', 'function photoFromUrl(')+
    section('var spaceComposerDialogPosition=', 'function closeStaleComposersForRoute(')+
    section('function spaceListContentHtml(', 'function spaceNoteTypeHtml(')+
    section('function shareTabHtml(', 'function loginGateHtml(')+
    section('function mineEntryDetailHtml(', '/* ---------------- render: 나의 공간 독서 진행률 카드')+
    section('var privateCategoryStates =', 'function openPrivateCategoryManager(')+
    section('function mineTabHtml(', 'function decryptListInto('),c);
  return {c,scheduled,decrypted,renders};
}
function post(id,bookId='emotion',createdAt=1){return {id,bookId,createdAt,userId:'member',userName:'모임원',title:'제목 '+id,noteType:'thought',html:'<p>본문</p>'};}
function entry(id,userId='owner',bookId='emotion',createdAt=1){return {id,userId,bookId,createdAt,iv:'encrypted-iv',data:'encrypted-record'};}
function installCategories(c,values,bookId='emotion'){
  const id=privateCategories.recordId(c.SESSION.userId,bookId);
  const settings=entry(id,c.SESSION.userId,bookId);
  settings.data='encrypted-settings-'+bookId;
  c.STATE.privateEntries[id]=settings;
  c.privateCategoryStates[id]={status:'ready',categories:privateCategories.prepare(values),data:settings.data,material:c.SESSION.keyB64,epoch:c.saveSessionEpoch};
  return id;
}

function composerDialogHarness(type='mine'){
  let dialog=null;
  const events=[],popups=new Map(),bodyClasses=new Set();
  const trigger={id:'btn-open-'+type+'-composer',focus:options=>events.push(['trigger-focus',options])};
  const document={activeElement:null,body:{classList:{add:name=>bodyClasses.add(name),remove:name=>bodyClasses.delete(name)}},
    getElementById(id){if(id==='space-composer-dialog')return dialog;if(id===trigger.id)return trigger;return dialog&&dialog.fields[id]||null;}};
  const c={SESSION:{userId:'owner'},location:{hash:'#/book/emotion/'+type+'/post/original'},document,
    readingNoteReturn:null,mineComposerOpenFor:type==='mine'?'emotion':null,shareComposerOpenFor:type==='share'?'emotion':null,
    captureComposerDraft(){events.push(['capture']);},
    resetMineComposer(){events.push(['reset','mine']);c.mineComposerOpenFor=null;},
    resetShareComposer(){events.push(['reset','share']);c.shareComposerOpenFor=null;},
    returnToReadingTimer(){events.push(['timer-return']);},
    render(){events.push(['render']);if(!c.mineComposerOpenFor&&!c.shareComposerOpenFor)dialog=null;},
    GrowellPopupHistory:{open:(key,options)=>popups.set(key,options),closed:key=>{events.push(['history-close',key]);popups.delete(key);}}};
  vm.createContext(c);vm.runInContext(section('var spaceComposerDialogPosition=', 'function closeStaleComposersForRoute('),c);
  function mount(key='owner:emotion:'+type+':original'){
    const fields={},handlers={};
    for(const id of ['note-title','insight-q1'])fields[id]={id,selectionStart:2,selectionEnd:5,
      focus(options){document.activeElement=this;events.push(['field-focus',id,options]);},
      setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}};
    const draft={getAttribute:name=>name==='data-draft-key'?key:null};
    dialog={open:false,scrollTop:0,fields,getAttribute:name=>name==='data-composer-type'?type:null,
      querySelector:selector=>selector==='[data-draft-key]'?draft:fields[selector.slice(1)]||null,
      contains:node=>Object.values(fields).includes(node),
      showModal(){this.open=true;events.push(['show']);},close(){this.open=false;events.push(['close']);},
      addEventListener(name,handler){handlers[name]=handler;},
      cancel(){let prevented=false;handlers.cancel({preventDefault(){prevented=true;}});return prevented;}};
    return dialog;
  }
  return {c,mount,events,popups,bodyClasses,document,clear:()=>{dialog=null;}};
}

test('composer X, Escape and Back preserve the original detail route and capture before closing',()=>{
  for(const type of ['mine','share'])for(const way of ['x','escape','back']){
    const h=composerDialogHarness(type),node=h.mount(),route=h.c.location.hash;
    h.c.showSpaceComposerDialog();assert.equal(node.open,true);assert.equal(h.popups.size,1);
    assert.equal(h.bodyClasses.has('space-composer-open'),true);
    if(way==='escape')assert.equal(node.cancel(),true);
    else if(way==='back')h.popups.get('space-composer').close();
    else h.c.closeSpaceComposerDialog();
    assert.equal(node.open,false);assert.equal(h.c.location.hash,route);assert.equal(h.popups.size,0);
    assert.equal(h.bodyClasses.has('space-composer-open'),false);
    assert.equal(h.c[type==='mine'?'mineComposerOpenFor':'shareComposerOpenFor'],null);
    assert.equal(h.events.filter(e=>e[0]==='capture').length,1);
    assert.ok(h.events.findIndex(e=>e[0]==='capture')<h.events.findIndex(e=>e[0]==='reset'));
    assert.equal(h.events.filter(e=>e[0]==='render').length,1);
    assert.equal(h.events.filter(e=>e[0]==='timer-return').length,0);
    assert.equal(h.events.find(e=>e[0]==='trigger-focus')[1].preventScroll,true);
  }
});

test('rerendering a composer preserves matching scroll and text selection without adding history layers',()=>{
  const h=composerDialogHarness('share'),first=h.mount();h.c.showSpaceComposerDialog();
  first.scrollTop=260;h.document.activeElement=first.fields['insight-q1'];
  first.fields['insight-q1'].selectionStart=3;first.fields['insight-q1'].selectionEnd=9;
  h.c.captureSpaceComposerDialogPosition();
  const replacement=h.mount();h.c.showSpaceComposerDialog();
  assert.equal(replacement.scrollTop,260);assert.equal(h.document.activeElement,replacement.fields['insight-q1']);
  assert.equal(replacement.fields['insight-q1'].selectionStart,3);assert.equal(replacement.fields['insight-q1'].selectionEnd,9);
  assert.equal(h.popups.size,1);
  const other=h.mount('owner:emotion:share:new-target');h.c.showSpaceComposerDialog();
  assert.equal(other.scrollTop,0);assert.equal(h.document.activeElement,other.fields['note-title']);
  assert.equal(h.popups.size,1);
});

test('retiring the composer on route or owner change cannot resume a reading handoff',()=>{
  for(const change of [c=>{c.location.hash='#/book/emotion/habit';},c=>{c.SESSION={userId:'other'};},c=>{c.SESSION=null;}]){
    const h=composerDialogHarness(),node=h.mount();h.c.showSpaceComposerDialog();h.c.readingNoteReturn={type:'mine',bookId:'emotion'};
    change(h.c);h.c.closeSpaceComposerDialog();
    assert.equal(node.open,false);assert.equal(h.events.filter(e=>e[0]==='timer-return').length,0);
    assert.equal(h.c.readingNoteReturn.type,'mine');assert.equal(h.popups.size,0);
  }
  const h=composerDialogHarness();h.mount();h.c.showSpaceComposerDialog();h.clear();h.c.showSpaceComposerDialog();
  assert.equal(h.popups.size,0);assert.equal(h.bodyClasses.has('space-composer-open'),false);
  assert.equal(h.c.spaceComposerDialogRoute,null);assert.equal(h.c.spaceComposerDialogOwner,null);
});

test('studio rows validate and escape photo URLs while text-only and unsafe-photo rows remain readable',()=>{
  const {c}=harness();
  for(const url of ['https://example.org/photo.jpg?a=1&b=2','data:image/jpeg;base64,AQID']){
    const markup=c.spaceListContentHtml({title:'<제목>',photo:{dataUrl:url}},1,'나에게만 공개');
    assert.ok(markup.includes('src="'+esc(url)+'"'));assert.ok(markup.includes('&lt;제목&gt;'));
    assert.equal((markup.match(/<img\b/g)||[]).length,1);
  }
  for(const url of [undefined,'javascript:attack()','data:image/svg+xml;base64,AQID','https://example.org/x" onerror="attack()']){
    const markup=c.spaceListContentHtml({title:'사진 없이도 읽는 제목',photo:{dataUrl:url}},1,'나에게만 공개');
    assert.doesNotMatch(markup,/<img\b|space-list-thumbnail|onerror=/);
    assert.ok(markup.includes('사진 없이도 읽는 제목'));
  }
});

test('shared row keeps author popup buttons outside the record link',()=>{
  const {c}=harness(),markup=c.spaceShareRowHtml(book,post('visible'),'visible');
  const links=[...markup.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)];
  assert.equal(links.length,1);assert.doesNotMatch(links[0][0],/<button\b/);
  assert.ok(markup.includes('data-community-author="member"'));
  assert.ok(markup.includes('aria-current="true"'));
  assert.ok(markup.includes('#/book/emotion/share/post/visible'));
});

test('shared preview honors its filter but highlights only explicitly opened posts and reports missing IDs',()=>{
  const {c}=harness();
  c.STATE.posts={older:post('older','emotion',1),newer:post('newer','emotion',2),foreign:post('foreign','thought',3)};
  c.STATE.posts.newer.noteType='quote';c.shareFeedFilter.emotion='thought';
  const initial=c.shareTabHtml(book);
  assert.match(initial,/data-shared-detail="older"/);
  assert.doesNotMatch(initial,/space-list-item is-selected|aria-current="true"/,'the initial preview does not mark a row as selected');
  const opened=c.shareTabHtml(book,'older');
  assert.match(opened,/space-list-item is-selected/);assert.match(opened,/aria-current="true"/);
  assert.match(c.shareTabHtml(book,'newer'),/data-shared-detail="newer"/,'direct links remain available outside the current type filter');
  for(const id of ['foreign','missing']){
    const markup=c.shareTabHtml(book,id);
    assert.ok(markup.includes('글을 찾을 수 없어요.'));
    assert.doesNotMatch(markup,/data-shared-detail=/);
    assert.ok(!markup.includes('제목 foreign'));
  }
});

test('shared writing opens one dialog while retaining the selected record and background list',()=>{
  const {c}=harness();c.STATE.posts={visible:post('visible')};c.shareComposerOpenFor='emotion';
  const selected=c.shareTabHtml(book,'visible');
  assert.match(selected,/data-shared-detail="visible"/);
  assert.match(selected,/<dialog[^>]*id="space-composer-dialog"[^>]*data-composer-type="share"/);
  assert.equal((selected.match(/id="share-composer"/g)||[]).length,1);
  assert.doesNotMatch(selected,/space-workspace[^"\n]*is-writing/);
  const writing=c.shareTabHtml(book);
  assert.equal((writing.match(/id="share-composer"/g)||[]).length,1);
  assert.match(writing,/data-shared-detail="visible"/);assert.match(writing,/space-record-list/);
  const dialog=writing.match(/<dialog\b[\s\S]*?<\/dialog>/)[0];
  assert.match(dialog,/id="note-editor"/);assert.doesNotMatch(dialog,/data-shared-detail=|space-record-list/);
});

test('personal workspace renders and schedules decryption only for the signed-in owner and requested book',()=>{
  const {c,scheduled,decrypted}=harness();
  c.STATE.privateEntries={mine:entry('mine'),foreignOwner:entry('foreign-owner','another'),foreignBook:entry('foreign-book','owner','thought')};
  const markup=c.mineTabHtml(book);
  assert.ok(markup.includes('data-mine-entry="mine"'));assert.ok(markup.includes('data-mine-tile="mine"'));
  assert.doesNotMatch(markup,/space-list-item is-selected|aria-current="true"/);
  assert.doesNotMatch(markup,/foreign-owner|foreign-book|encrypted-record/);
  assert.equal((markup.match(/data-reading-timer/g)||[]).length,1);
  scheduled.forEach(run=>run());assert.deepEqual(decrypted.map(e=>e.id),['mine']);
  const opened=c.mineTabHtml(book,'mine');
  assert.match(opened,/space-list-item is-selected/);assert.match(opened,/aria-current="true"/);
  for(const id of ['foreign-owner','foreign-book','missing']){
    const missing=c.mineTabHtml(book,id);
    assert.ok(missing.includes('기록을 찾을 수 없어요.'));assert.doesNotMatch(missing,/data-mine-entry=/);
  }
});

test('personal reading timer remains present during loading, writing and selected-record views without duplicate editors',()=>{
  const {c}=harness();c.STATE.privateEntries={mine:entry('mine')};c.mineComposerOpenFor='emotion';
  const writing=c.mineTabHtml(book);
  assert.equal((writing.match(/id="mine-composer"/g)||[]).length,1);
  assert.equal((writing.match(/data-reading-timer/g)||[]).length,1);assert.match(writing,/data-mine-entry="mine"/);
  assert.match(writing,/<dialog[^>]*data-composer-type="mine"/);assert.doesNotMatch(writing,/space-workspace[^"\n]*is-writing/);
  const selected=c.mineTabHtml(book,'mine');
  assert.ok(selected.includes('data-mine-entry="mine"'));assert.equal((selected.match(/id="mine-composer"/g)||[]).length,1);
  assert.equal((selected.match(/data-reading-timer/g)||[]).length,1);
  c.memberDataStatusHtml=()=>'<div data-loading></div>';
  const loading=c.mineTabHtml(book,'mine');assert.ok(loading.includes('data-loading'));assert.ok(loading.includes('data-reading-timer'));
});

test('personal workspace mounts the current theme reflection once below reading in every view',()=>{
  const {c}=harness();
  let recordCalls=0;
  c.GrowellArchive.reflectionHtml=(...args)=>{
    assert.deepEqual(args,['emotion'],'personal reflections use the current meeting book theme');
    assert.equal(c.SESSION.userId,'owner');recordCalls++;
    return '<section data-archive-reflection="emotion"><h3>감정에 대한 고찰</h3></section>';
  };
  installCategories(c,[{id:'pcat_journal',label:'일기'}]);
  c.STATE.privateEntries.mine=entry('mine');
  for(const state of ['list','writing','detail','loading']){
    c.mineComposerOpenFor=state==='writing'?'emotion':null;
    c.memberDataStatusHtml=()=>state==='loading'?'<div data-loading></div>':'';
    const markup=c.mineTabHtml(book,state==='detail'?'mine':undefined);
    assert.equal((markup.match(/data-archive-reflection/g)||[]).length,1);
    assert.ok(markup.indexOf('data-archive-reflection')>markup.indexOf('data-reading-timer'));
    if(state!=='loading')assert.ok(markup.indexOf('data-archive-reflection')<markup.indexOf('data-private-category-filter'));
  }
  assert.equal(recordCalls,4);
  c.SESSION=null;
  const guest=c.mineTabHtml(book);
  assert.match(guest,/data-login-gate/);assert.doesNotMatch(guest,/data-archive-reflection/);assert.equal(recordCalls,4);
});

test('each private space supplies its own theme to archive reflections instead of mixing all books',()=>{
  const {c}=harness(),seen=[];c.GrowellArchive.reflectionHtml=theme=>{seen.push(theme);return '<section data-archive-reflection="'+theme+'"></section>';};
  for(const id of ['emotion','thought','body','action']){
    installCategories(c,[],id);
    const markup=c.mineTabHtml({id,accent:id});
    assert.equal((markup.match(/data-archive-reflection=/g)||[]).length,1);
    assert.ok(markup.includes('data-archive-reflection="'+id+'"'));
  }
  assert.deepEqual(seen,['emotion','thought','body','action']);
});

test('private filters are fixed note types and retired filters fall back to all without changing existing records',()=>{
  const {c,scheduled,decrypted}=harness(),id=installCategories(c,[{id:'pcat_journal',label:'일기'}]);
  c.STATE.privateEntries.mine=entry('mine');
  const controls=c.privateCategoryControlsHtml(book.id),filters=[...controls.matchAll(/data-private-category-filter="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(filters,['all','quote','thought','question','insight']);
  assert.doesNotMatch(controls,/data-private-category-manage|data-private-category-retry|카테고리 설정|pcat_journal/);
  const before=JSON.stringify(c.STATE.privateEntries);
  c.privateCategoryFilters[id]='private-archive';assert.equal(c.privateCategoryFilter(book.id),'all');
  const markup=c.mineTabHtml(book);
  assert.match(markup,/data-private-category-filter="all"[^>]*aria-pressed="true"/);
  assert.equal((markup.match(/data-archive-reflection="emotion"/g)||[]).length,1);
  assert.ok(markup.indexOf('data-private-category-filter')>markup.indexOf('data-reading-timer'));
  assert.ok(markup.indexOf('data-archive-reflection')<markup.indexOf('data-private-category-filter'));
  assert.match(markup,/data-mine-tile="mine"/);
  scheduled.forEach(run=>run());assert.deepEqual(decrypted.map(row=>row.id),['mine']);
  assert.equal(JSON.stringify(c.STATE.privateEntries),before);
  assert.ok(c.STATE.privateEntries.mine);
});

test('archive filtering preserves explicit private-note links and the writing flow',()=>{
  const {c}=harness(),id=installCategories(c,[]);c.STATE.privateEntries.mine=entry('mine');c.privateCategoryFilters[id]='private-archive';
  const detail=c.mineTabHtml(book,'mine');assert.match(detail,/data-mine-entry="mine"/);assert.doesNotMatch(detail,/기록을 찾을 수 없어요/);
  c.mineComposerOpenFor='emotion';const writing=c.mineTabHtml(book);assert.equal((writing.match(/id="mine-composer"/g)||[]).length,1);assert.equal((writing.match(/data-archive-reflection="emotion"/g)||[]).length,1);
});

test('fixed private filters select only matching decrypted types and keep legacy notes available in all',()=>{
  const {c}=harness(),id=installCategories(c,[{id:'pcat_journal',label:'일기'}]);
  for(const [name,type] of [['old','pcat_journal'],['quote-note','quote'],['thought-note','thought']]){
    c.STATE.privateEntries[name]=entry(name);c.privateEntryCategoryKeys[name]={data:'encrypted-record',noteType:type};
  }
  const before=JSON.stringify(c.STATE.privateEntries);
  c.privateCategoryFilters[id]='quote';
  const filtered=c.mineTabHtml(book);assert.match(filtered,/나의 기록 1개/);assert.match(filtered,/data-mine-entry="quote-note"/);
  const linked=c.mineTabHtml(book,'old');assert.match(linked,/data-mine-entry="old"/,'explicit links continue to open a legacy note');
  c.privateCategoryFilters[id]='all';const all=c.mineTabHtml(book);assert.match(all,/나의 기록 3개/);assert.match(all,/data-mine-tile="old"/);
  assert.equal(JSON.stringify(c.STATE.privateEntries),before);
});

test('book category entry defaults to My Space while explicit sharing links and lock gates remain unchanged',()=>{
  const {c}=harness();c.location={hash:''};
  vm.runInContext(section('function currentRoute(){',"window.addEventListener('hashchange'"),c);
  for(const id of ['emotion','thought','body','action']){
    c.location.hash='#/book/'+id;assert.equal(c.currentRoute().tab,'mine');
    c.location.hash='#/book/'+id+'/share/post/public-note';assert.equal(c.currentRoute().tab,'share');assert.equal(c.currentRoute().postId,'public-note');
  }
  Object.assign(c,{isBookLocked:()=>false,isAdmin:()=>false,canAccessWorksheet:()=>true,readingDataReady:()=>false,
    GrowellBookDetails:{coverHtml:()=>'<div data-cover></div>'},mineTabHtml:()=>'<section data-private-space></section>',shareTabHtml:()=>'<section data-sharing-space></section>',
    worksheetTabHtml:()=>'',materialsTabHtml:()=>'',habitTabHtml:()=>'',lockedBookGateHtml:()=>'<section data-locked></section>'});
  vm.runInContext(section('function bookPageHtml(', '/* ---------------- master render'),c);
  const entry=c.bookPageHtml({...book,area:'감정',title:'모임 책'});
  assert.ok(entry.indexOf('data-book-tab="mine"')<entry.indexOf('data-book-tab="share"'));
  assert.match(entry,/data-private-space/);assert.doesNotMatch(entry,/data-sharing-space/);
  assert.match(c.bookPageHtml(book,'share'),/data-sharing-space/);
  c.isBookLocked=()=>true;const locked=c.bookPageHtml(book);assert.match(locked,/data-locked/);assert.doesNotMatch(locked,/data-private-space|data-sharing-space/);
});

test('private thumbnail and detail appear only after guarded decryption and are never written back to encrypted STATE',async()=>{
  for(const change of [null,c=>{c.SESSION={userId:'another',keyB64:'key-b'};},c=>{c.SESSION.keyB64='key-b';},c=>{c.saveSessionEpoch++;}]){
    const {c}=harness(),pending=deferred(),writes=[];
    const media={set innerHTML(value){writes.push(['thumbnail',value]);}};
    const tile={querySelector:selector=>selector==='[data-mine-tile-media]'?media:null,classList:{add(){}},setAttribute:(key,value)=>writes.push([key,value])};
    const detail={set innerHTML(value){writes.push(['detail',value]);}};
    c.STATE.privateEntries={mine:entry('mine')};const before=JSON.stringify(c.STATE);
    c.document={querySelector:selector=>selector==='[data-mine-tile="mine"]'?tile:selector==='[data-mine-body="mine"]'?detail:null};
    c.ensureKey=()=>Promise.resolve('synthetic-key');c.decryptPrivateRecord=()=>pending.promise;
    c.noteBodyHtml=()=>({mediaHtml:'<p>복호화된 본문</p>',bodyHtml:'',badgesHtml:''});
    c.applyFeedSearch=()=>{};c.enhanceLinkPreviews=()=>{};
    c.localStorage={setItem(){assert.fail('private plaintext must not be persisted');}};
    vm.runInContext(section('function decryptListInto(', '/* ---------------- render: worksheet tab'),c);
    c.decryptListInto([c.STATE.privateEntries.mine]);await flush();assert.equal(writes.length,0);
    if(change)change(c);
    pending.resolve(JSON.stringify({title:'개인 제목',html:'<p>개인 본문</p>',photo:{dataUrl:'data:image/png;base64,AQID'}}));await flush();
    if(change)assert.equal(writes.length,0,'stale member/key/epoch cannot reveal a private thumbnail');
    else{
      assert.ok(writes.some(([key,value])=>key==='thumbnail'&&value.includes('개인 제목')&&value.includes('<img ')));
      assert.ok(writes.some(([key])=>key==='detail'));
    }
    assert.equal(JSON.stringify(c.STATE),before);
  }
});

test('private settings rows are excluded from record lists, counts, direct links and note decryption',()=>{
  const {c,scheduled,decrypted}=harness();
  const id=installCategories(c,[{id:'pcat_journal',label:'일기'}]);
  c.STATE.privateEntries.mine=entry('mine');
  const markup=c.mineTabHtml(book);
  assert.match(markup,/나의 기록 1개/);
  assert.ok(!markup.includes('data-mine-tile="'+id+'"'));
  assert.ok(!markup.includes('data-mine-entry="'+id+'"'));
  scheduled.forEach(run=>run());
  assert.deepEqual(decrypted.map(e=>e.id),['mine']);
  const direct=c.mineTabHtml(book,id);
  assert.match(direct,/기록을 찾을 수 없어요/);
  assert.ok(!direct.includes('data-mine-entry="'+id+'"'));
  delete c.STATE.privateEntries.mine;
  const empty=c.mineTabHtml(book);
  assert.match(empty,/나의 기록 0개/);assert.match(empty,/아직 나의 공간에 남긴 기록이 없어요/);
  assert.ok(!empty.includes('data-mine-tile='));
});

test('encrypted archive rows stay out of personal note counts, direct links and decryption',async()=>{
  const {c,scheduled,decrypted}=harness(),archive=c.GrowellArchiveDomain;
  const id=archive.recordId('owner','arc_read_book');
  c.STATE.privateEntries={mine:entry('mine'),[id]:entry(id)};
  const markup=c.mineTabHtml(book);
  assert.match(markup,/나의 기록 1개/);
  assert.ok(!markup.includes(id),'archive metadata is not a personal note tile');
  scheduled.forEach(run=>run());assert.deepEqual(decrypted.map(e=>e.id),['mine']);
  assert.match(c.mineTabHtml(book,id),/기록을 찾을 수 없어요/);
  let decryptCalls=0;
  c.decryptPrivateRecord=()=>{decryptCalls++;return Promise.resolve('{}');};
  c.document.querySelector=()=>({innerHTML:'',querySelector:()=>null});c.enhanceLinkPreviews=()=>{};
  vm.runInContext(section('function decryptListInto(', '/* ---------------- render: worksheet tab'),c);
  c.decryptListInto([c.STATE.privateEntries[id]]);await flush();assert.equal(decryptCalls,0);
});

test('fixed category labels and composing preserve legacy note contents and original category until explicitly changed',()=>{
  const {c}=harness(),label='<b>"내 생각" & 일기</b>';
  installCategories(c,[{id:'pcat_journal',label}]);
  const controls=c.privateCategoryControlsHtml(book.id);
  assert.ok(!controls.includes(label));assert.ok(!controls.includes(esc(label)));
  assert.doesNotMatch(controls,/data-private-category-filter="private-none"|분류 없음/);
  for(const noteType of ['summary','pcat_journal','pcat_deleted']){
    const resolved=c.privateCategoryLabel(book.id,noteType);
    assert.equal(resolved,'');
    const row=c.spaceListContentHtml({title:'기존 글',noteType},1,'나에게만 공개',resolved);
    assert.doesNotMatch(row,/분류 없음|책 속 문장|내용 요약|의문점|space-list-meta"> ·/);
  }
  const row=c.spaceListContentHtml({title:'내 글',noteType:'pcat_journal'},1,'나에게만 공개',c.privateCategoryLabel(book.id,'pcat_journal'));
  assert.ok(!row.includes(esc(label)));assert.ok(!row.includes(label));
  for(const type of privateCategories.fixedOptions())assert.equal(c.privateCategoryLabel(book.id,type.key),type.label);
  c.composerDrafts={};c.composerEditId=()=>null;c.composerDraftKey=()=> 'synthetic-draft';
  c.rtToolbarHtml=()=>'';c.I_IMG='';c.I_CLOSE='';c.I_COMMENT='';
  vm.runInContext(section('function noteComposerHtml(', 'function noteCtaHtml('),c);
  for(const noteType of ['thought','insight','pcat_journal','pcat_deleted']){
    const original={noteType,title:'보존할 제목',html:'<p>원래 기록</p>'};
    const html=c.noteComposerHtml(book,{containerId:'mine-composer',editingPost:original});
    assert.match(html,/원래 기록/);assert.match(html,/보존할 제목/);
    assert.ok(!html.includes(label));
    assert.deepEqual([...html.matchAll(/data-nt="([^"]+)"/g)].map(match=>match[1]),['quote','thought','question','insight']);
    assert.ok(html.includes('data-original-note-type="'+noteType+'"'));
    if(privateCategories.fixedKey(noteType))assert.ok(html.includes('is-sel" data-nt="'+noteType+'"'));
    else assert.doesNotMatch(html,/nt-pill[^>]*is-sel/);
    assert.equal(original.noteType,noteType,'rendering never rewrites the saved legacy category');
  }
});

test('deleted private categories resolve to unclassified and stale active filters reset without deleting records',()=>{
  const {c}=harness(),id=installCategories(c,[{id:'pcat_keep',label:'일기'},{id:'pcat_removed',label:'지울 분류'}]);
  c.STATE.privateEntries.mine=entry('mine');
  c.privateEntryCategoryKeys.mine={data:c.STATE.privateEntries.mine.data,noteType:'pcat_removed'};
  c.privateCategoryFilters[id]='pcat_removed';
  assert.equal(c.privateCategoryFilter(book.id),'all');
  const before=JSON.stringify(c.STATE.privateEntries.mine);
  c.privateCategoryStates[id].categories=[{id:'pcat_keep',label:'일기'}];
  assert.equal(c.privateCategoryFilter(book.id),'all');
  assert.equal(c.privateCategoryLabel(book.id,'pcat_removed'),'');
  c.privateCategoryFilters[id]='private-none';
  assert.equal(c.privateCategoryFilter(book.id),'all');
  const html=c.mineTabHtml(book);
  assert.match(html,/나의 기록 1개/);assert.match(html,/data-mine-entry="mine"/);
  assert.equal(JSON.stringify(c.STATE.privateEntries.mine),before);
  assert.equal(c.privateEntryCategoryKeys.mine.noteType,'pcat_removed');
});

test('category decryption ignores stale owner, key, epoch, replacement and logout contexts',async()=>{
  const scenarios=[null,c=>{c.SESSION={userId:'another',keyB64:'key-b'};},c=>{c.SESSION.keyB64='key-b';},
    c=>{c.saveSessionEpoch++;},(c,id)=>{c.privateCategoryStates[id]={status:'ready',categories:[]};},c=>{c.clearPrivateCategoryState();}];
  for(const change of scenarios){
    const {c,renders}=harness(),pending=deferred();
    const id=privateCategories.recordId('owner','emotion');
    c.STATE.privateEntries[id]=entry(id);
    c.decryptPrivateRecord=()=>pending.promise;
    const before=JSON.stringify(c.STATE),state=c.privateCategoryContext('emotion');
    assert.equal(state.status,'loading');await flush();
    if(change)change(c,id);
    pending.resolve(privateCategories.encode([{id:'pcat_private',label:'비공개 분류'}]));await flush();
    if(change){assert.equal(state.status,'loading');assert.equal(state.categories.length,0);assert.equal(renders.length,0);}
    else{assert.equal(state.status,'ready');assert.equal(state.categories[0].label,'비공개 분류');assert.equal(renders.length,1);}
    assert.equal(JSON.stringify(c.STATE),before,'plaintext category settings never enter encrypted state');
  }
});

test('category loading fails closed for foreign identities and corrupt encrypted settings',async()=>{
  for(const wrong of [{userId:'another'},{bookId:'thought'}]){
    const {c}=harness(),id=privateCategories.recordId('owner','emotion');
    c.STATE.privateEntries[id]={...entry(id),...wrong};
    c.decryptPrivateRecord=()=>assert.fail('foreign category rows must not be decrypted');
    assert.equal(c.privateCategoryContext('emotion').status,'error');
  }
  const {c}=harness(),id=privateCategories.recordId('owner','emotion');
  c.STATE.privateEntries[id]=entry(id);const before=JSON.stringify(c.STATE);
  c.decryptPrivateRecord=()=>Promise.resolve('{corrupt settings');
  const state=c.privateCategoryContext('emotion');await flush();
  assert.equal(state.status,'error');assert.match(c.privateCategoryControlsHtml('emotion'),/책 속 문장/);
  assert.doesNotMatch(c.privateCategoryControlsHtml('emotion'),/data-private-category-manage/);
  c.mineComposerOpenFor='emotion';assert.match(c.mineTabHtml(book),/id="mine-composer"/,'fixed categories do not depend on obsolete category-setting decryption');
  assert.equal(JSON.stringify(c.STATE),before);
  c.STATE.privateEntries[id].data='new-encrypted-settings';
  c.decryptPrivateRecord=()=>Promise.resolve(privateCategories.encode([{id:'pcat_recovered',label:'복구한 분류'}]));
  const recovered=c.privateCategoryContext('emotion');await flush();
  assert.equal(recovered.status,'ready');assert.equal(recovered.categories[0].label,'복구한 분류');
});

test('private category and search filters intersect and update the visible record count',()=>{
  const {c}=harness();
  const tile=(category,text)=>({style:{},getAttribute:name=>name==='data-private-note-category'?category:name==='data-search-text'?text:null});
  const items=[tile('pcat_journal','오늘의 일기'),tile('pcat_journal','어제의 기록'),tile('private-none','오늘 남긴 기록')];
  let selected='pcat_journal';
  const grid={style:{},getAttribute:()=>selected,hasAttribute:()=>true,querySelectorAll:()=>items};
  const input={value:'오늘'},count={textContent:''},empty={style:{}};
  c.document={getElementById:id=>id==='mine-grid-emotion'?grid:id==='empty-mine-grid-emotion'?empty:null,
    querySelector:selector=>selector==='[data-private-count]'?count:input};
  vm.runInContext(section('function applyFeedSearch(', 'function feedToolbarHtml('),c);
  c.applyFeedSearch('mine-grid-emotion');
  assert.deepEqual(items.map(item=>item.style.display),['','none','none']);assert.match(count.textContent,/1개/);
  selected='private-none';c.applyFeedSearch('mine-grid-emotion');
  assert.deepEqual(items.map(item=>item.style.display),['none','none','']);assert.match(count.textContent,/1개/);
  input.value='없는 문장';c.applyFeedSearch('mine-grid-emotion');
  assert.equal(grid.style.display,'none');assert.equal(empty.style.display,'');assert.match(count.textContent,/0개/);
  input.value='';selected='all';c.applyFeedSearch('mine-grid-emotion');
  assert.equal(grid.style.display,'');assert.equal(empty.style.display,'none');assert.match(count.textContent,/3개/);
});
