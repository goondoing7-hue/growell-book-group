'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const Share=require('../privateShareDomain.js'),Private=require('../privateCrypto.js'),Categories=require('../privateCategories.js'),Archive=require('../archiveDomain.js');
const source=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
const clone=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
function storage(){const values=new Map();return {values,getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};}
function payload(extra={}){return Object.assign({title:'공유할 원래 제목',html:'<p>원래 <strong>책 속 문장</strong></p>',noteType:'quote',page:'23',photo:{dataUrl:'data:image/png;base64,AQID',mimeType:'image/png'},bgColor:'#F4EDE0',fontSize:'lg'},extra);}
function operation(){return {postId:'p_share_operation_0001',createdAt:Date.now()-1000};}
async function harness(options={}){
  const requests=[],uploads=[],warnings=[],toasts=[],rows=new Map(),objects=new Map(),hooks={},localStorage=storage(),sessionStorage=storage();let renders=0;
  const c={Promise,Date,JSON,Uint8Array,TextEncoder,TextDecoder,URL,atob,btoa,crypto:webcrypto,console:{warn:(...args)=>warnings.push(args)},
    SESSION:{userId:'member-a',name:'시험 회원',keyB64:Buffer.alloc(32,31).toString('base64')},CURRENT_KEY:null,CURRENT_KEY_OWNER:null,CURRENT_KEY_MATERIAL:null,
    STATE:{users:{'member-a':{id:'member-a',name:'시험 회원',authUserId:'11111111-1111-4111-8111-111111111111',approvalStatus:'approved',isDeleted:false}},posts:{},comments:{},privateEntries:{},materialNotes:{},worksheets:{},readingLogs:{},habits:{},readingMeta:{},bookLocks:{},announcement:{next:{},reading:{}}},
    GrowellPrivateShareDomain:Share,GrowellPrivateCrypto:Private,GrowellPrivateCategories:Categories,GrowellArchiveDomain:Archive,
    location:{hash:'#/book/emotion/mine/post/entry-synthetic'},localStorage,sessionStorage,
    shareComposerOpenFor:null,mineComposerOpenFor:null,materialsComposerOpenFor:null,
    composerDrafts:{'unrelated-general-draft':{title:'다른 나눔 작성 중 원문',html:'<p>원문</p>'}},
    showToast:(...args)=>toasts.push(args),render:()=>{renders++;},
    sanitizeHtml:html=>String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,''),
    currentUser:()=>c.SESSION&&c.STATE.users[c.SESSION.userId],isAdmin:()=>false,
    bookById:id=>id==='emotion'?{id,order:1,checkin:{type:'gauge'}}:null,
    canEditAnnouncement:()=>false,refreshHabitValueSummary(){},
    sb:{from(table){let action='select',body=null,filters=[];const query={
      select(){return query;},eq(key,value){filters.push([key,value]);return query;},maybeSingle(){return query;},
      insert(value){action='insert';body=clone(value);return query;},update(value){action='update';body=clone(value);return query;},delete(){action='delete';return query;},upsert(value){action='upsert';body=clone(value);return query;},
      then(yes,no){return Promise.resolve().then(async()=>{
        const request={table,action,body,filters:clone(filters)};requests.push(request);
        if(hooks.request){const result=await hooks.request(request,c,rows);if(result!==undefined)return result;}
        if(table!=='posts')throw new Error('Unexpected table write or read: '+table);
        if(action==='select'){const row=rows.get(filters.find(pair=>pair[0]==='id')?.[1]);return {data:row&&filters.every(([key,value])=>row[key]===value)?clone(row):null,error:null};}
        if(action==='insert'){if(rows.has(body.id))return {error:{code:'23505'},data:null};rows.set(body.id,clone(body));return {data:null,error:null};}
        throw new Error('A copy must not update or delete any existing row');
      }).then(yes,no);}
    };return query;},storage:{from(bucket){return {upload:async(key,bytes,settings)=>{
      const request={bucket,key,bytes:Array.from(bytes),settings:clone(settings)};uploads.push(request);
      if(hooks.upload){const result=await hooks.upload(request,c,objects);if(result!==undefined)return result;}
      objects.set(key,clone(request));return {data:{path:key},error:null};
    },getPublicUrl:key=>({data:{publicUrl:'https://example.test/storage/'+bucket+'/'+key}})};}}}
  };
  vm.createContext(c);
  vm.runInContext(section('function bytesToHex(', 'function stripHtml('),c);
  vm.runInContext(section('function randomSaltHex(){','/* ---------------- icons'),c);
  vm.runInContext(section('function safePhotoUrl(', 'function readingMetaKey('),c);
  vm.runInContext(section('function mapPostRow(', 'function mapCommentRow('),c);
  vm.runInContext(section('function bookLockInfo(', 'var shareComposerOpenFor'),c);
  vm.runInContext(section('function anyComposerOpen(){','function resetShareComposer('),c);
  vm.runInContext(section('function ensureKey(){','/* 개인 기록 v2:'),c);
  vm.runInContext(section('function decryptPrivateRecord(', 'function encryptPrivateRecord('),c);
  vm.runInContext(section('var saving = false;', '/* ---------------- toast'),c);
  vm.runInContext(section('/* Private-to-community copies','/* ---------------- content actions'),c);
  c.memberLoadState.privateEntries='ready';c.saveSessionEpoch=7;
  const originalPayload=options.payload||payload(),entry={id:'entry-synthetic',bookId:'emotion',userId:'member-a',createdAt:1700000000000,updatedAt:1700000000100};
  const key=await c.keyFromB64(c.SESSION.keyB64),dataKey=await Private.newKey(),encrypted=await Private.create(entry,key,dataKey,options.raw===undefined?JSON.stringify(originalPayload):options.raw);
  Object.assign(entry,encrypted);c.STATE.privateEntries[entry.id]=entry;
  c.STATE.privateEntries['other-preserved']={id:'other-preserved',bookId:'emotion',userId:'member-a',iv:'other-iv',data:'other-encrypted-body',createdAt:123,updatedAt:456};
  localStorage.setItem('growell_draft_v33:unrelated-general-draft','UNRELATED ENCRYPTED GENERAL DRAFT');
  return {c,hooks,rows,objects,requests,uploads,warnings,toasts,localStorage,sessionStorage,entry,payload:originalPayload,get renders(){return renders;},async load(){return c.loadPrivateShare(entry.id);},async settle(){for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));}};
}

test('direct sharing runs the real diff save and photo path while preserving every private row and unrelated draft',async()=>{
  const h=await harness(),before=JSON.stringify(h.c.STATE.privateEntries),draftBefore=JSON.stringify(h.c.composerDrafts),generalBefore=h.localStorage.getItem('growell_draft_v33:unrelated-general-draft'),op=operation();
  const loaded=await h.load(),result=await h.c.publishPrivateShare(loaded.source,loaded.fields,op);await h.settle();
  assert.equal(result.postId,op.postId);assert.equal(h.rows.size,1);assert.equal(h.uploads.length,1);assert.equal(h.uploads[0].key,'11111111-1111-4111-8111-111111111111/'+op.postId+'-'+op.createdAt+'.png');
  assert.deepEqual(h.uploads[0].bytes,[1,2,3]);assert.equal(h.uploads[0].settings.contentType,'image/png');assert.equal(h.uploads[0].settings.upsert,true);
  const row=h.rows.get(op.postId);assert.equal(row.html,h.payload.html);assert.equal(row.title,h.payload.title);assert.equal(row.page,h.payload.page);assert.equal(row.bg_color,h.payload.bgColor);assert.equal(row.font_size,h.payload.fontSize);assert.equal(row.note_type,'quote');assert.equal(row.checkin,null);assert.equal(row.created_at,op.createdAt);
  assert.equal(row.photo_url,'https://example.test/storage/post-photos/'+h.uploads[0].key);assert.equal(JSON.stringify(h.c.STATE.privateEntries),before);assert.equal(JSON.stringify(h.c.composerDrafts),draftBefore);assert.equal(h.localStorage.getItem('growell_draft_v33:unrelated-general-draft'),generalBefore);assert.equal(h.renders,0);
  assert.deepEqual(Object.keys(row).sort(),['id','book_id','user_id','checkin','note_type','meeting_no','q1','q2','q3','page','html','photo_url','bg_color','font_size','title','created_at','updated_at'].sort());
  assert.ok(h.requests.every(request=>request.table==='posts'));assert.equal(h.requests.filter(request=>request.action==='insert').length,1);
});

test('editing the separate public payload does not rewrite the private ciphertext, note type, photo or timestamps',async()=>{
  const h=await harness(),before=JSON.stringify(h.c.STATE.privateEntries),loaded=await h.load(),edited=Object.assign({},loaded.fields,{title:'공개용 수정 제목',html:'<p>공개할 문장만 수정</p>',noteType:'question',page:'31'}),op=operation();
  await h.c.publishPrivateShare(loaded.source,edited,op);const row=h.rows.get(op.postId);
  assert.equal(row.title,edited.title);assert.equal(row.html,edited.html);assert.equal(row.note_type,'question');assert.equal(row.page,'31');assert.equal(JSON.stringify(h.c.STATE.privateEntries),before);
  const reopened=await h.load();assert.equal(reopened.fields.title,h.payload.title);assert.equal(reopened.fields.html,h.payload.html);assert.equal(reopened.fields.noteType,'quote');
});

test('legacy plain text and ordinary private insight publish their own words without generating structured answers',async()=>{
  for(const options of [{raw:'昔のメモ <原文> & 思い\n둘째 줄'},{payload:payload({noteType:'insight',html:'<p>내가 적은 통찰 그대로</p>',q1:'부가 필드를 공개하지 않음',iv:'payload-private-iv',data:'payload-private-data',secret:'private-only'})}]){
    const h=await harness(options),before=JSON.stringify(h.c.STATE.privateEntries),loaded=await h.load(),op=operation();await h.c.publishPrivateShare(loaded.source,Object.assign({},loaded.fields,{userId:'foreign-owner',bookId:'foreign-book',iv:'must not leak',data:'must not leak'}),op);
    const row=h.rows.get(op.postId);assert.equal(row.user_id,'member-a');assert.equal(row.book_id,'emotion');assert.equal(row.note_type,'thought');assert.equal(row.q1,'');assert.equal(row.q2,'');assert.equal(row.q3,'');assert.equal(row.meeting_no,'');
    if(options.raw){assert.equal(row.title,'');assert.equal(row.html,'昔のメモ &lt;原文&gt; &amp; 思い\n둘째 줄');assert.equal(row.photo_url,null);}else{assert.equal(row.html,options.payload.html);assert.match(loaded.notice,/내 생각/);}
    for(const key of ['iv','data','secret','keyB64','source','entryId'])assert.equal(Object.hasOwn(row,key),false,key);assert.equal(JSON.stringify(h.c.STATE.privateEntries),before);
  }
});

test('invalid operation identities or times fail before any public query or upload',async()=>{
  for(const operationPatch of [{postId:'private-id'},{postId:'p_a'},{postId:'p_unsafe/id_0001'},{createdAt:0},{createdAt:NaN},{createdAt:'1793013600000'},{createdAt:Date.now()+120000}]){
    const h=await harness(),loaded=await h.load(),op=Object.assign(operation(),operationPatch);
    await assert.rejects(h.c.publishPrivateShare(loaded.source,loaded.fields,op),/초안/);assert.equal(h.requests.length,0);assert.equal(h.uploads.length,0);assert.equal(h.rows.size,0);
  }
});

test('load rejects foreign owners, settings/archive records, inaccessible books and unready accounts without a public read',async()=>{
  const changes=[h=>{h.entry.userId='another-member';},h=>{delete h.c.SESSION;},h=>{h.c.STATE.users['member-a'].approvalStatus='pending';},h=>{h.c.STATE.users['member-a'].isDeleted=true;},h=>{h.c.memberLoadState.privateEntries='error';},h=>{h.c.STATE.bookLocks.emotion={locked:true};},h=>{h.entry.bookId='unknown-book';},h=>{const old=h.entry.id;h.entry.id=Categories.recordId('member-a','emotion');delete h.c.STATE.privateEntries[old];h.c.STATE.privateEntries[h.entry.id]=h.entry;},h=>{const old=h.entry.id;h.entry.id=Archive.recordId('member-a','arc_personal');delete h.c.STATE.privateEntries[old];h.c.STATE.privateEntries[h.entry.id]=h.entry;},h=>{h.c.mineComposerOpenFor='emotion';}];
  for(const change of changes){const h=await harness();change(h);await assert.rejects(h.load());assert.equal(h.requests.length,0);assert.equal(h.rows.size,0);assert.equal(h.uploads.length,0);}
});

test('delayed key import or private decryption cannot cross an account, route, key, epoch or source change',async()=>{
  for(const stage of ['key','decrypt'])for(const change of [h=>{h.c.SESSION={userId:'member-b',keyB64:'different'};},h=>{h.c.location.hash='#/home';},h=>{h.c.SESSION.keyB64='different';},h=>{h.c.saveSessionEpoch++;},h=>{h.entry.data='changed-ciphertext';}]){
    const h=await harness(),gate=deferred(),original=stage==='key'?h.c.ensureKey:h.c.decryptPrivateRecord;
    if(stage==='key')h.c.ensureKey=async()=>{await gate.promise;return original();};else h.c.decryptPrivateRecord=async(...args)=>{const raw=await original(...args);await gate.promise;return raw;};
    const pending=h.load();await h.settle();change(h);gate.resolve();await assert.rejects(pending);assert.equal(h.rows.size,0);assert.equal(h.requests.length,0);
  }
});

test('a changed original during the actual photo upload is fenced before insert by performSave',async()=>{
  const h=await harness(),loaded=await h.load(),op=operation();h.hooks.upload=async()=>{h.entry.iv='new-source-iv';};
  await assert.rejects(h.c.publishPrivateShare(loaded.source,loaded.fields,op));assert.equal(h.rows.size,0);assert.equal(h.requests.filter(request=>request.action==='insert').length,0);assert.equal(h.c.STATE.posts[op.postId],undefined);assert.equal(h.entry.iv,'new-source-iv');
});

test('an insert that committed but lost both responses is reconciled on retry with the same ID, time and photo URL',async()=>{
  const h=await harness(),loaded=await h.load(),op=operation();let lostInsert=false,failLookup=false;
  h.hooks.request=(request,c,rows)=>{
    if(request.action==='insert'&&!lostInsert){lostInsert=true;failLookup=true;rows.set(request.body.id,clone(request.body));return {error:{code:'PGRST000'},data:null};}
    if(request.action==='select'&&failLookup){failLookup=false;return {error:{code:'PGRST000'},data:null};}
  };
  await assert.rejects(h.c.publishPrivateShare(loaded.source,loaded.fields,op));assert.equal(h.rows.size,1);assert.equal(h.c.STATE.posts[op.postId],undefined);const committed=clone(h.rows.get(op.postId));
  const result=await h.c.publishPrivateShare(loaded.source,loaded.fields,op);await h.settle();assert.equal(result.postId,op.postId);assert.equal(h.rows.size,1);assert.equal(h.requests.filter(request=>request.action==='insert').length,1);assert.equal(h.uploads.length,1);assert.deepEqual(h.rows.get(op.postId),committed);assert.equal(h.c.STATE.posts[op.postId].photo.dataUrl,committed.photo_url);
});

test('a failed uncommitted insert retries using exactly the same deterministic upload object and publication timestamp',async()=>{
  const h=await harness(),loaded=await h.load(),op=operation();let first=true;
  h.hooks.request=request=>{if(request.action==='insert'&&first){first=false;return {error:{code:'PGRST000'},data:null};}};
  await assert.rejects(h.c.publishPrivateShare(loaded.source,loaded.fields,op));assert.equal(h.rows.size,0);await h.c.publishPrivateShare(loaded.source,loaded.fields,op);
  assert.equal(h.rows.size,1);assert.equal(h.uploads.length,2);assert.equal(h.uploads[0].key,h.uploads[1].key);assert.equal(h.objects.size,1);assert.deepEqual(h.uploads[0].bytes,h.uploads[1].bytes);assert.equal(h.rows.get(op.postId).created_at,op.createdAt);
});

test('immediate insert-response loss succeeds only after the exact-row reconciliation, never by replacing a conflicting public row',async()=>{
  const h=await harness(),loaded=await h.load(),op=operation();h.hooks.request=(request,c,rows)=>{if(request.action==='insert'){rows.set(request.body.id,clone(request.body));return {error:{code:'PGRST000'},data:null};}};
  await h.c.publishPrivateShare(loaded.source,loaded.fields,op);assert.equal(h.rows.size,1);assert.ok(h.c.STATE.posts[op.postId]);
  h.rows.get(op.postId).html='<p>이미 저장된 다른 원문</p>';const conflicting=clone(h.rows.get(op.postId));await assert.rejects(h.c.publishPrivateShare(loaded.source,loaded.fields,op),/달라요/);assert.deepEqual(h.rows.get(op.postId),conflicting);assert.equal(h.requests.filter(request=>request.action==='insert').length,1);
});

test('drafts use real AES encryption, keep their own namespace, round trip empty edits, and cannot publish them',async()=>{
  const h=await harness(),loaded=await h.load(),before=JSON.stringify(h.c.STATE.privateEntries),generalBefore=h.localStorage.getItem('growell_draft_v33:unrelated-general-draft');
  assert.equal(await h.c.readPrivateShareDraft(loaded.source),null);
  const state={v:1,fields:Object.assign({},loaded.fields,{title:'구별되는 초안 제목',html:'<p>비밀 초안 문장</p>'}),operation:operation(),attempted:false};
  await h.c.writePrivateShareDraft(loaded.source,state);const key=h.c.privateShareDraftKey(loaded.source),raw=h.localStorage.getItem(key);
  assert.ok(raw);assert.doesNotMatch(raw,/구별되는|비밀 초안|원래|data:image|postId|share_operation|member-a/);assert.deepEqual(Object.keys(JSON.parse(raw)).sort(),['data','iv','v']);
  const otherSource=(await h.load()).source,restored=await h.c.readPrivateShareDraft(otherSource);assert.deepEqual(clone(restored),clone(state));
  const blank={v:1,fields:Object.assign({},restored.fields,{html:'',photo:null}),operation:state.operation,attempted:false};await h.c.writePrivateShareDraft(otherSource,blank);const blankRead=await h.c.readPrivateShareDraft(otherSource);assert.equal(blankRead.fields.html,'');assert.equal(blankRead.fields.photo,null);
  await assert.rejects(h.c.publishPrivateShare(otherSource,blankRead.fields,blankRead.operation),/내용이나 사진/);assert.equal(h.rows.size,0);assert.equal(h.requests.length,0);assert.equal(JSON.stringify(h.c.STATE.privateEntries),before);assert.equal(h.localStorage.getItem('growell_draft_v33:unrelated-general-draft'),generalBefore);
  await h.c.clearPrivateShareDraft(otherSource,blankRead);assert.equal(h.localStorage.getItem(key),null);assert.equal(h.localStorage.getItem('growell_draft_v33:unrelated-general-draft'),generalBefore);
});

test('two tabs use compare-and-swap for draft writes and clearing so newer text remains encrypted and intact',async()=>{
  const h=await harness(),one=(await h.load()).source,two=(await h.load()).source;await h.c.readPrivateShareDraft(one);await h.c.readPrivateShareDraft(two);
  const first={v:1,fields:Share.fields(payload(),{sanitizeHtml:h.c.sanitizeHtml,plainTextHtml:h.c.nlToBr,safePhotoUrl:h.c.safePhotoUrl}),operation:operation(),attempted:false};
  await h.c.writePrivateShareDraft(one,first);const key=h.c.privateShareDraftKey(one),saved=h.localStorage.getItem(key);
  await assert.rejects(h.c.writePrivateShareDraft(two,Object.assign({},first,{fields:Object.assign({},first.fields,{title:'늦은 창의 입력'})})),/다른 창/);assert.equal(h.localStorage.getItem(key),saved);
  const three=(await h.load()).source;await h.c.readPrivateShareDraft(three);const newer=Object.assign({},first,{fields:Object.assign({},first.fields,{title:'새 창에서 보관한 최종 제목'})});await h.c.writePrivateShareDraft(three,newer);const final=h.localStorage.getItem(key);
  await assert.rejects(h.c.clearPrivateShareDraft(one,first),/보존/);assert.equal(h.localStorage.getItem(key),final);const fresh=(await h.load()).source;assert.equal((await h.c.readPrivateShareDraft(fresh)).fields.title,newer.fields.title);
});

test('encrypted draft identity and stale membership guards fail closed without deleting saved drafts',async()=>{
  const h=await harness(),loaded=await h.load(),state={v:1,fields:loaded.fields,operation:operation(),attempted:false};await h.c.readPrivateShareDraft(loaded.source);await h.c.writePrivateShareDraft(loaded.source,state);
  const key=h.c.privateShareDraftKey(loaded.source),raw=h.localStorage.getItem(key);h.c.STATE.users['member-a'].approvalStatus='pending';await assert.rejects(h.c.readPrivateShareDraft(loaded.source));await assert.rejects(h.c.writePrivateShareDraft(loaded.source,state));await assert.rejects(h.c.clearPrivateShareDraft(loaded.source,state));assert.equal(h.localStorage.getItem(key),raw);
  h.c.STATE.users['member-a'].approvalStatus='approved';const decoded=JSON.parse(await h.c.decryptText(await h.c.keyFromB64(loaded.source.keyB64),JSON.parse(raw).iv,JSON.parse(raw).data));decoded.userId='someone-else';const box=await h.c.encryptText(await h.c.keyFromB64(loaded.source.keyB64),JSON.stringify(decoded));h.localStorage.setItem(key,JSON.stringify({v:1,...box}));const invalid=h.localStorage.getItem(key);await assert.rejects(h.c.readPrivateShareDraft((await h.load()).source),/계정/);assert.equal(h.localStorage.getItem(key),invalid);
});
