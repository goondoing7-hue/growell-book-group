'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const domain=require('../archiveDomain.js'),categories=require('../privateCategories.js');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('var archiveSharedNoteCache=null;'),html.indexOf('async function openArchiveSharedNote('));
const photoSource=html.slice(html.indexOf('function safePhotoUrl('),html.indexOf('function photoFromUrl('));
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
