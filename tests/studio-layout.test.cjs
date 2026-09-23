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
    fmtPostDate:()=> '오늘',fmtDate:()=> '2026. 9. 23.',svgIcon:()=>'',I_BACK:'',I_LOCK:'',I_EDIT:'',I_TRASH:'',
    NOTE_TYPE_INSIGHT:{key:'insight',label:'통찰 정리'},NOTE_TYPES:[],INSIGHT_QUESTIONS:[{key:'q1'},{key:'q2'},{key:'q3'}],
    noteTypeOf:key=>key==='thought'?{key,label:'내 생각'}:null,
    publicAuthorHtml:(id,name)=>'<button type="button" data-community-author="'+esc(id)+'">'+esc(name)+'</button>',
    commentsForPost:()=>[{}],SESSION:{userId:'owner',name:'독서회원',keyB64:'key-a'},saveSessionEpoch:1,
    STATE:{posts:{},privateEntries:{}},sharedPostsLoadState:'ready',shareFeedFilter:{},
    GrowellPrivateCategories:privateCategories,memberLoadState:{privateEntries:'ready'},
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

test('shared selection is bounded to its book, honors filtered initial selection, and reports missing IDs',()=>{
  const {c}=harness();
  c.STATE.posts={older:post('older','emotion',1),newer:post('newer','emotion',2),foreign:post('foreign','thought',3)};
  c.STATE.posts.newer.noteType='quote';c.shareFeedFilter.emotion='thought';
  assert.match(c.shareTabHtml(book),/data-shared-detail="older"/);
  assert.match(c.shareTabHtml(book,'newer'),/data-shared-detail="newer"/,'direct links remain available outside the current type filter');
  for(const id of ['foreign','missing']){
    const markup=c.shareTabHtml(book,id);
    assert.ok(markup.includes('글을 찾을 수 없어요.'));
    assert.doesNotMatch(markup,/data-shared-detail=/);
    assert.ok(!markup.includes('제목 foreign'));
  }
});

test('opening a shared record while a draft exists displays that record, and opening writing renders one composer',()=>{
  const {c}=harness();c.STATE.posts={visible:post('visible')};c.shareComposerOpenFor='emotion';
  const selected=c.shareTabHtml(book,'visible');
  assert.match(selected,/data-shared-detail="visible"/);assert.doesNotMatch(selected,/id="share-composer"/);
  const writing=c.shareTabHtml(book);
  assert.equal((writing.match(/id="share-composer"/g)||[]).length,1);
  assert.doesNotMatch(writing,/data-shared-detail=/);
});

test('personal workspace renders and schedules decryption only for the signed-in owner and requested book',()=>{
  const {c,scheduled,decrypted}=harness();
  c.STATE.privateEntries={mine:entry('mine'),foreignOwner:entry('foreign-owner','another'),foreignBook:entry('foreign-book','owner','thought')};
  const markup=c.mineTabHtml(book);
  assert.ok(markup.includes('data-mine-entry="mine"'));assert.ok(markup.includes('data-mine-tile="mine"'));
  assert.doesNotMatch(markup,/foreign-owner|foreign-book|encrypted-record/);
  assert.equal((markup.match(/data-reading-timer/g)||[]).length,1);
  scheduled.forEach(run=>run());assert.deepEqual(decrypted.map(e=>e.id),['mine']);
  for(const id of ['foreign-owner','foreign-book','missing']){
    const missing=c.mineTabHtml(book,id);
    assert.ok(missing.includes('기록을 찾을 수 없어요.'));assert.doesNotMatch(missing,/data-mine-entry=/);
  }
});

test('personal reading timer remains present during loading, writing and selected-record views without duplicate editors',()=>{
  const {c}=harness();c.STATE.privateEntries={mine:entry('mine')};c.mineComposerOpenFor='emotion';
  const writing=c.mineTabHtml(book);
  assert.equal((writing.match(/id="mine-composer"/g)||[]).length,1);
  assert.equal((writing.match(/data-reading-timer/g)||[]).length,1);assert.doesNotMatch(writing,/data-mine-entry=/);
  const selected=c.mineTabHtml(book,'mine');
  assert.ok(selected.includes('data-mine-entry="mine"'));assert.doesNotMatch(selected,/id="mine-composer"/);
  assert.equal((selected.match(/data-reading-timer/g)||[]).length,1);
  c.memberDataStatusHtml=()=>'<div data-loading></div>';
  const loading=c.mineTabHtml(book,'mine');assert.ok(loading.includes('data-loading'));assert.ok(loading.includes('data-reading-timer'));
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

test('private category labels are escaped in controls, list rows and composing while legacy notes stay unclassified',()=>{
  const {c}=harness(),label='<b>"내 생각" & 일기</b>';
  installCategories(c,[{id:'pcat_journal',label}]);
  const controls=c.privateCategoryControlsHtml(book.id);
  assert.ok(controls.includes(esc(label)));assert.ok(!controls.includes(label));
  assert.doesNotMatch(controls,/data-private-category-filter="private-none"|분류 없음/);
  for(const noteType of ['thought','summary','quote','question','pcat_deleted']){
    const resolved=c.privateCategoryLabel(book.id,noteType);
    assert.equal(resolved,'');
    const row=c.spaceListContentHtml({title:'기존 글',noteType},1,'나에게만 공개',resolved);
    assert.doesNotMatch(row,/분류 없음|책 속 문장|내용 요약|의문점|space-list-meta"> ·/);
  }
  const row=c.spaceListContentHtml({title:'내 글',noteType:'pcat_journal'},1,'나에게만 공개',c.privateCategoryLabel(book.id,'pcat_journal'));
  assert.ok(row.includes(esc(label)));assert.ok(!row.includes(label));
  c.composerDrafts={};c.composerEditId=()=>null;c.composerDraftKey=()=> 'synthetic-draft';
  c.rtToolbarHtml=()=>'';c.I_IMG='';c.I_CLOSE='';c.I_COMMENT='';
  vm.runInContext(section('function noteComposerHtml(', 'function noteCtaHtml('),c);
  for(const noteType of ['thought','pcat_journal','pcat_deleted']){
    const original={noteType,title:'보존할 제목',html:'<p>원래 기록</p>'};
    const html=c.noteComposerHtml(book,{containerId:'mine-composer',editingPost:original});
    assert.match(html,/원래 기록/);assert.match(html,/보존할 제목/);
    assert.ok(html.includes(esc(label)));assert.ok(!html.includes(label));
    assert.doesNotMatch(html,/data-nt="(?:thought|quote|summary|question|insight)"/);
    const expected=noteType==='pcat_journal'?'pcat_journal':'private-none';
    assert.ok(html.includes('is-sel" data-nt="'+expected+'"'));
    assert.equal(original.noteType,noteType,'rendering never rewrites the saved legacy category');
  }
});

test('deleted private categories resolve to unclassified and stale active filters reset without deleting records',()=>{
  const {c}=harness(),id=installCategories(c,[{id:'pcat_keep',label:'일기'},{id:'pcat_removed',label:'지울 분류'}]);
  c.STATE.privateEntries.mine=entry('mine');
  c.privateEntryCategoryKeys.mine={data:c.STATE.privateEntries.mine.data,noteType:'pcat_removed'};
  c.privateCategoryFilters[id]='pcat_removed';
  assert.equal(c.privateCategoryFilter(book.id),'pcat_removed');
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
  assert.equal(state.status,'error');assert.match(c.privateCategoryControlsHtml('emotion'),/기존 설정은 유지/);
  c.mineComposerOpenFor='emotion';assert.doesNotMatch(c.mineTabHtml(book),/id="mine-composer"/);
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
