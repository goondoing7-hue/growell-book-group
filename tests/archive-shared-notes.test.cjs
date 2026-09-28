'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const domain=require('../archiveDomain.js'),categories=require('../privateCategories.js');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('var archiveSharedNoteCache=null;'),html.indexOf('async function openArchiveSharedNote('));
const photoSource=html.slice(html.indexOf('function safePhotoUrl('),html.indexOf('function photoFromUrl('));
const popupSource=html.slice(html.indexOf('async function openArchiveSharedNote('),html.indexOf('function archiveSharedCatalog('));
const openComposerSource=html.slice(html.indexOf('function openComposerWithDraft('),html.indexOf('/* Recovery also rewraps'));
async function flush(){for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));}
function harness(){
 const entries=[],reads=[];let renders=0;
 const c={URL,SESSION:{userId:'owner',keyB64:'key'},saveSessionEpoch:1,memberLoadState:{privateEntries:'ready'},
  ownPrivateEntries:()=>entries,bookById:id=>['emotion','thought','body','action'].includes(id)?{id,title:id,cover:'/covers/'+id+'.jpg'}:null,
  GrowellArchiveDomain:domain,GrowellPrivateCategories:categories,ensureKey:async()=>({}),
  decryptPrivateRecord:async entry=>{reads.push(entry.id);return entry.raw;},sanitizeHtml:html=>html.replace(/<script>[\s\S]*?<\/script>/gi,''),stripHtml:html=>html.replace(/<[^>]*>/g,''),render:()=>renders++,
  document:{getElementById:()=>null}};
 vm.createContext(c);vm.runInContext(photoSource+source,c);return {c,entries,reads,get renders(){return renders;}};
}
const row=(id,bookId='emotion',userId='owner')=>({id,bookId,userId,data:'encrypted-'+id,iv:'iv',createdAt:123,raw:JSON.stringify({title:'기억',html:'<p>소중한 문장</p>'})});
test('all-book notes decrypt only owned ordinary notes and keep book identity and plain previews',async()=>{
 const h=harness();h.entries.push(row('mine'),row('foreign','emotion','other'),row('settings'),row(domain.recordId('owner','arc_book'),domain.STORAGE_BOOK_ID),row('unknown','unknown'));
 h.entries[2].id=categories.recordId('owner','emotion');
 assert.equal(h.c.archiveSharedNotes().length,0);await flush();
 const notes=h.c.archiveSharedNotes();assert.deepEqual(h.reads,['mine']);assert.equal(notes.length,1);assert.equal(notes[0].text,'소중한 문장');assert.equal(notes[0].coverUrl,'/covers/emotion.jpg');assert.equal(notes[0].userId,'owner');
 h.c.archiveSharedNotes();await flush();assert.equal(h.renders,1,'unchanged render does not schedule another decryption');
});

test('shared note archive adapter exposes only explicit fixed category IDs without rewriting legacy payloads',async()=>{
 const h=harness();
 for(const type of ['quote','thought','question','insight','pcat_journal','private-none']){
  const note=row(type);note.raw=JSON.stringify({noteType:type,title:'원래 제목',html:'<p>원래 본문</p>'});h.entries.push(note);
 }
 const before=JSON.stringify(h.entries);h.c.archiveSharedNotes();await flush();
 const notes=h.c.archiveSharedNotes();
 for(const note of notes)assert.equal(note.categoryId,['quote','thought','question','insight'].includes(note.id)?note.id:'');
 assert.equal(JSON.stringify(h.entries),before);assert.equal(notes.length,6);
});

test('shared note previews retain safe attached photos and valid page numbers',async()=>{
 const h=harness(),image='data:image/png;base64,aGVsbG8=';
 const cases=[
  {photo:{dataUrl:image},page:'103',expectedPhoto:image,expectedPage:103},
  {photo:{dataUrl:'https://example.com/note.jpg'},page:0,expectedPhoto:'https://example.com/note.jpg',expectedPage:0},
  {photo:{dataUrl:'javascript:alert(1)'},page:'',expectedPhoto:'',expectedPage:null},
  {photo:{dataUrl:'data:image/svg+xml;base64,PHN2Zz4='},page:-1,expectedPhoto:'',expectedPage:null},
  {page:'abc',expectedPhoto:'',expectedPage:null},
  {page:3.5,expectedPhoto:'',expectedPage:null},
  {page:100001,expectedPhoto:'',expectedPage:null},
  {page:[42],expectedPhoto:'',expectedPage:null},
  {page:' ',expectedPhoto:'',expectedPage:null}
 ];
 cases.forEach((payload,i)=>h.entries.push({...row('preview-'+i),raw:JSON.stringify(payload)}));
 const before=JSON.stringify(h.entries);h.c.archiveSharedNotes();await flush();
 const notes=h.c.archiveSharedNotes();assert.equal(notes.length,cases.length);
 cases.forEach((expected,i)=>{assert.equal(notes[i].photo,expected.expectedPhoto);assert.equal(notes[i].page,expected.expectedPage);});
 assert.equal(JSON.stringify(h.entries),before);
});
test('late decryptions cannot reveal previous-account plaintext and changed ciphertext refreshes the cache',async()=>{
 const h=harness();h.entries.push(row('mine'));let release;
 h.c.decryptPrivateRecord=()=>new Promise(resolve=>release=resolve);
 h.c.archiveSharedNotes();await flush();h.c.SESSION={userId:'other',keyB64:'other'};release(JSON.stringify({text:'previous owner'}));await flush();
 assert.equal(h.c.archiveSharedNotes().length,0);await flush();assert.equal(h.c.archiveSharedNotes().length,0);
 h.c.SESSION={userId:'owner',keyB64:'new'};h.c.decryptPrivateRecord=async e=>e.raw;h.c.archiveSharedNotes();await flush();
 assert.equal(h.c.archiveSharedNotes()[0].text,'소중한 문장');
 h.entries[0]={...h.entries[0],data:'new-cipher',raw:JSON.stringify({text:'수정한 기록'})};h.c.archiveSharedNotes();await flush();assert.equal(h.c.archiveSharedNotes()[0].text,'수정한 기록');
});
test('locked or corrupt notes never replace persisted records and session clearing removes cached plaintext',async()=>{
 const h=harness();h.entries.push(row('bad'),{...row('legacy'),raw:'예전 기록'});h.c.decryptPrivateRecord=async e=>{if(e.id==='bad')throw Error('locked');return e.raw;};
 h.c.archiveSharedNotes();await flush();assert.equal(h.c.archiveSharedNotes().length,1);assert.equal(h.c.archiveSharedNotes()[0].text,'예전 기록');assert.equal(h.entries.length,2);
 h.c.clearArchiveSharedNotes();assert.equal(h.c.archiveSharedNoteCache,null);
 h.c.memberLoadState.privateEntries='loading';assert.equal(h.c.archiveSharedNotes().length,0);
});

function popupHarness(){
 const h=harness(),{c}=h,nodes=[],events=[],popups=new Map(),triggers=[];
 const note=row('mine');h.entries.push(note);
 const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
 Object.assign(c,{STATE:{privateEntries:{mine:note}},location:{hash:'#/archive'},readingHistoryRouteVersion:1,
  esc,svgIcon:path=>'<svg>'+path+'</svg>',I_CLOSE:'close',fmtPostDate:()=> '오늘',showToast:message=>events.push(['toast',message]),
  noteBodyHtml:payload=>({mediaHtml:'',bodyHtml:payload.html?c.sanitizeHtml(payload.html):esc(payload.text||'')}),
  captureComposerDraft:()=>null,loadComposerDraft:async()=>null,mineEditingId:null,mineEditingPayload:null,mineComposerOpenFor:null,
  GrowellPopupHistory:{open:(key,options)=>{popups.set(key,options);events.push(['open',key]);},closed:key=>{popups.delete(key);events.push(['closed',key]);}},
  GrowellArchive:{openBookRecord:(...args)=>{assert.equal(nodes.filter(n=>n.isConnected).length,0);assert.equal(popups.has('archive-shared-note'),false);events.push(['book',...args]);}},
  document:{getElementById:id=>nodes.find(node=>node.id===id&&node.isConnected)||null,
   querySelectorAll:selector=>selector==='[data-shared-read-note]'?triggers.filter(trigger=>trigger.isConnected):[],
   body:{appendChild(node){node.isConnected=true;nodes.push(node);}},createElement(){
    const controls={},handlers={};
    return {open:false,isConnected:false,innerHTML:'',querySelector:selector=>controls[selector]||=( {} ),
     addEventListener:(name,handler)=>{handlers[name]=handler;},showModal(){this.open=true;},close(){this.open=false;},remove(){this.isConnected=false;},
     cancel(){let prevented=false;handlers.cancel({preventDefault(){prevented=true;}});return prevented;}};
   }}});
 vm.runInContext(openComposerSource+popupSource,c);
 function trigger(id='mine',bookId='emotion'){
  const result={isConnected:true,dataset:{sharedReadNote:id,sharedNoteBook:bookId},focus:options=>events.push(['focus',result,options])};triggers.push(result);return result;
 }
 return {...h,c,nodes,events,popups,trigger,current:()=>nodes.findLast(node=>node.isConnected)};
}

test('shared note opens the matching archive book record only after retiring its own dialog',async()=>{
 const h=popupHarness(),trigger=h.trigger(),before=JSON.stringify(h.c.STATE.privateEntries);
 await h.c.openArchiveSharedNote('mine','emotion',trigger);const node=h.current();
 assert.match(node.innerHTML,/archive-note-view-actions[\s\S]*archive-note-book-link[\s\S]*이 책의 독서 기록/);
 assert.match(node.innerHTML,/소중한 문장/);node.querySelector('[data-book-record]').onclick();
 assert.equal(h.current(),undefined);assert.equal(h.c.location.hash,'#/archive');
 const target=h.events.find(event=>event[0]==='book');assert.deepEqual(target.slice(1),[null,'emotion',trigger]);
 assert.equal(JSON.stringify(h.c.STATE.privateEntries),before);
});

test('shared note X, Escape and Back return focus without scrolling, including a replaced carousel button',async()=>{
 for(const way of ['x','escape','back']){
  const h=popupHarness(),original=h.trigger();await h.c.openArchiveSharedNote('mine','emotion',original);const node=h.current();
  original.isConnected=false;h.trigger();const replacement=h.trigger();replacement.closest=()=>({open:true});
  if(way==='x')node.querySelector('[data-close]').onclick();
  else if(way==='escape')assert.equal(node.cancel(),true);
  else h.popups.get('archive-shared-note').close();
  assert.equal(h.current(),undefined);assert.equal(h.c.location.hash,'#/archive');
  const focused=h.events.filter(event=>event[0]==='focus');assert.equal(focused.length,1);assert.equal(focused[0][1],replacement);assert.equal(focused[0][2].preventScroll,true);
 }
});

test('late shared note decryption cannot open after navigation, a departed-and-returned route, or member cleanup',async()=>{
 for(const change of [h=>{h.c.location.hash='#/book/thought/mine';},h=>{h.c.readingHistoryRouteVersion+=2;},h=>h.c.clearArchiveSharedNotes()]){
  const h=popupHarness();let release;h.c.decryptPrivateRecord=()=>new Promise(resolve=>{release=resolve;});
  const pending=h.c.openArchiveSharedNote('mine','emotion',h.trigger());await flush();change(h);release(h.entries[0].raw);await pending;
  assert.equal(h.current(),undefined);assert.equal(h.popups.size,0);
 }
});

test('only the newest shared note request can open and an old close callback cannot dismiss its replacement',async()=>{
 const h=popupHarness(),other=row('newest','thought');h.c.STATE.privateEntries.newest=other;
 let release;h.c.decryptPrivateRecord=entry=>entry.id==='mine'?new Promise(resolve=>{release=resolve;}):Promise.resolve(entry.raw);
 const old=h.c.openArchiveSharedNote('mine','emotion',h.trigger());await flush();
 await h.c.openArchiveSharedNote('newest','thought',h.trigger('newest','thought'));const newest=h.current();
 release(h.entries[0].raw);await old;assert.equal(h.current(),newest);assert.equal(h.nodes.filter(node=>node.isConnected).length,1);
 const staleClose=h.popups.get('archive-shared-note').close;
 await h.c.openArchiveSharedNote('newest','thought',h.trigger('newest','thought'));const replacement=h.current();
 staleClose();assert.equal(h.current(),replacement);assert.equal(replacement.open,true);assert.equal(h.popups.size,1);
});

test('shared popup remains owner-scoped and clearing membership closes it without returning focus to private content',async()=>{
 const h=popupHarness(),trigger=h.trigger();await h.c.openArchiveSharedNote('mine','emotion',trigger);
 h.c.clearArchiveSharedNotes();assert.equal(h.current(),undefined);assert.equal(h.popups.size,0);assert.equal(h.events.filter(event=>event[0]==='focus').length,0);
 h.c.SESSION={userId:'other',keyB64:'other'};
 await assert.rejects(h.c.openArchiveSharedNote('mine','emotion',trigger),/기록을 다시 불러/);assert.equal(h.current(),undefined);
});

test('shared popup still opens its original private editor on My Space without losing the note payload',async()=>{
 const h=popupHarness();await h.c.openArchiveSharedNote('mine','emotion',h.trigger());
 h.current().querySelector('[data-original]').onclick();await flush();
 assert.equal(h.current(),undefined);assert.equal(h.c.location.hash,'#/book/emotion/mine');assert.equal(h.c.mineEditingId,'mine');assert.equal(h.c.mineComposerOpenFor,'emotion');
 assert.deepEqual(JSON.parse(JSON.stringify(h.c.mineEditingPayload)),JSON.parse(h.entries[0].raw));assert.equal(h.events.some(event=>event[0]==='book'),false);
});
