const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const cryptoSource = html.slice(html.indexOf('function randomSaltHex(){'), html.indexOf('/* ---------------- icons'));
const draftSource = html.slice(html.indexOf('var composerDrafts ='), html.indexOf('/* 컴포저(작성/수정 창)'));
const composerSource = html.slice(html.indexOf('function noteComposerHtml('), html.indexOf('function noteCtaHtml('));
const photoSource = html.slice(html.indexOf('function safePhotoUrl('), html.indexOf('function photoFromUrl('));
const keyB64 = Buffer.alloc(32, 17).toString('base64');
function storage(){
  const data = new Map();
  return {data, get length(){return data.size;},key:i=>[...data.keys()][i]||null,
    getItem:k=>data.get(k)||null, setItem:(k,v)=>data.set(k,v), removeItem:k=>data.delete(k)};
}
function setup(saved=storage()){
  let active=null;
  const ctx={crypto:webcrypto, TextEncoder, TextDecoder, Uint8Array, Promise, Date, JSON, console, URL,
    bytesToB64:v=>Buffer.from(v).toString('base64'), b64ToBytes:v=>new Uint8Array(Buffer.from(v,'base64')),
    localStorage:saved, sessionStorage:storage(), SESSION:{userId:'member-a',keyB64},
    shareEditingId:null, mineEditingId:null, materialsEditingId:null,
    stripHtml:v=>v.replace(/<[^>]*>/g,''), showToast:()=>{},
    document:{querySelector:()=>active},
    NOTE_TYPES:[{key:'thought',label:'생각'}],
    esc:v=>String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'),
    checkinPickerHtml:(book,value)=>'<span data-check="'+value+'"></span>', rtToolbarHtml:()=>'',
    bgColorPickerHtml:v=>'<span data-bg="'+v+'"></span>', fontSizePickerHtml:v=>'<span data-size="'+v+'"></span>',
    insightFieldsHtml:v=>'<textarea>'+v.q1+'</textarea>', insightBgPickerHtml:()=>'', svgIcon:()=>'', I_CLOSE:'', I_IMG:'', I_COMMENT:'', I_LOCK:'',
    matComposerExtraHtml:v=>JSON.stringify(v.driveLinks||[])};
  vm.createContext(ctx); vm.runInContext(cryptoSource+draftSource+photoSource+composerSource,ctx);
  function mount(type='share',mode='standard',bookId='book-a',editId=null,fields={}){
    const attrs={'data-draft-key':ctx.composerDraftKey(type,bookId,editId,ctx.SESSION.userId),
      'data-draft-user':ctx.SESSION.userId, 'data-draft-type':type, 'data-draft-mode':mode,
      'data-book':bookId,'data-draft-edit':editId||''};
    const values=Object.assign({title:'초안 제목', html:'<b>소중한 개인 기록</b>', page:'27',
      noteType:mode==='insight'?'insight':'thought',bgColor:'cream',fontSize:'large',checkin:'sunny',
      photo:'data:image/jpeg;base64,AQID',meetingNo:'4',q1:'느낀 점',q2:'깨달음',q3:'실천',driveLinks:[]},fields);
    const fieldIds={'#note-title':'title','#note-page':'page','#insight-meeting-no':'meetingNo',
      '#mat-meeting-no':'meetingNo','#insight-q1':'q1','#insight-q2':'q2','#insight-q3':'q3'};
    const choices={'.nt-pill.is-sel':'noteType','[data-checkin-val].is-sel':'checkin',
      '.bg-swatch.is-sel':'bgColor','.font-size-btn.is-sel':'fontSize'};
    active={values,attrs,getAttribute:k=>attrs[k],querySelector:selector=>{
      if(selector==='[data-draft-status]') return {};
      if(selector==='#note-editor') return mode==='standard'?{innerHTML:values.html}:null;
      if(selector==='#photo-preview img') return mode==='standard'&&values.photo?{getAttribute:()=>values.photo}:null;
      if(selector==='#gauge-range') return null;
      if(choices[selector]) return {getAttribute:()=>values[choices[selector]]};
      if(fieldIds[selector]){
        if(mode==='insight' && ['title','page'].includes(fieldIds[selector])) return null;
        if(mode==='standard' && selector.startsWith('#insight-')) return null;
        if(type!=='materials' && selector==='#mat-meeting-no') return null;
        return {value:values[fieldIds[selector]]};
      }
      return null;
    },querySelectorAll:selector=>selector==='[data-mat-link-row]'?values.driveLinks.map(row=>({querySelector:s=>({value:s.includes('title')?row.title:row.driveUrl})})):[]};
    return active;
  }
  return {ctx,saved,mount,unmount:()=>{active=null;}};
}
async function flush(ctx){
  for(let i=0;ctx.composerDraftPending && i<200;i++) await new Promise(r=>setTimeout(r,5));
  assert.equal(ctx.composerDraftPending,0);
}

test('standard and insight drafts keep every field and restore after a fresh runtime',async()=>{
  const {ctx,saved,mount}=setup();
  mount(); const standard=ctx.captureComposerDraft();
  mount('share','insight'); ctx.captureComposerDraft(); await flush(ctx);
  const raw=saved.getItem(standard.key);
  assert.ok(raw); assert.ok(!raw.includes('소중한')); assert.ok(!raw.includes('초안 제목')); assert.ok(!raw.includes('느낀 점'));
  const fresh=setup(saved);
  const draft=await fresh.ctx.loadComposerDraft('share','book-a',null);
  assert.equal(draft.variants.standard.html,'<b>소중한 개인 기록</b>');
  assert.equal(draft.variants.standard.title,'초안 제목'); assert.equal(draft.variants.standard.page,'27');
  assert.equal(draft.variants.standard.photo.dataUrl,'data:image/jpeg;base64,AQID');
  assert.equal(draft.variants.standard.checkin,'sunny'); assert.equal(draft.variants.standard.bgColor,'cream');
  assert.equal(draft.variants.standard.fontSize,'large'); assert.equal(draft.variants.insight.q3,'실천');
  assert.equal(draft.activeMode,'insight');
  const markup=fresh.ctx.noteComposerHtml({id:'book-a',accent:'emotion'},{containerId:'share-composer',selectedNoteType:'thought',withBgColor:true,withFontSize:true,withCheckin:true});
  assert.ok(markup.includes('<b>소중한 개인 기록</b>')); assert.ok(markup.includes('value="초안 제목"'));
});

test('draft identity isolates accounts, books, new notes, and edit targets',async()=>{
  const {ctx,saved,mount,unmount}=setup();
  const node=mount('mine','standard','book-a','entry-1');
  ctx.captureComposerDraft(); await flush(ctx);
  ctx.SESSION={userId:'member-b',keyB64};
  assert.equal(ctx.captureComposerDraft(),null);
  assert.equal(await ctx.loadComposerDraft('mine','book-a','entry-1'),null);
  unmount(); ctx.SESSION={userId:'member-a',keyB64};
  assert.equal(await ctx.loadComposerDraft('mine','book-b','entry-1'),null);
  assert.equal(await ctx.loadComposerDraft('mine','book-a',null),null);
  assert.equal(saved.data.size,1); assert.ok(node.attrs['data-draft-key'].includes('entry-1'));
});

test('success clears only the submitted form and ignores late encryption completions',async()=>{
  const {ctx,saved,mount,unmount}=setup();
  mount(); const token=ctx.captureComposerDraft();
  assert.equal(ctx.finishComposerDraft('share','book-a',null,'member-a',token),true);
  await flush(ctx); assert.equal(saved.getItem(token.key),null);
  unmount(); mount(); ctx.captureComposerDraft(); mount('share','insight'); const insight=ctx.captureComposerDraft();
  assert.equal(ctx.finishComposerDraft('share','book-a',null,'member-a',insight),true);
  await flush(ctx); const restored=await setup(saved).ctx.loadComposerDraft('share','book-a',null);
  assert.equal(restored.activeMode,'standard'); assert.ok(restored.variants.standard); assert.equal(restored.variants.insight,undefined);
});

test('new input during a pending server save is not cleared by its success callback',async()=>{
  const {ctx,saved,mount}=setup(); const node=mount();
  const token=ctx.captureComposerDraft(); node.values.title='저장 도중 추가한 제목'; ctx.captureComposerDraft();
  assert.equal(ctx.finishComposerDraft('share','book-a',null,'member-a',token),false);
  await flush(ctx); const restored=await setup(saved).ctx.loadComposerDraft('share','book-a',null);
  assert.equal(restored.variants.standard.title,'저장 도중 추가한 제목');
});

test('storage failure retains memory and unreadable drafts are never replaced on open',async()=>{
  const {ctx,saved,mount}=setup(); mount('mine'); ctx.captureComposerDraft(); await flush(ctx);
  const before=[...saved.data.values()][0]; const fresh=setup(saved);
  fresh.ctx.SESSION.keyB64=Buffer.alloc(32,99).toString('base64');
  let opened=false; await fresh.ctx.openComposerWithDraft('mine','book-a',null,()=>{opened=true;});
  assert.equal(opened,false); assert.equal([...saved.data.values()][0],before);
  const broken=setup(); broken.saved.setItem=()=>{throw new Error('quota');}; broken.mount('mine');
  const token=broken.ctx.captureComposerDraft(); await flush(broken.ctx);
  assert.equal(broken.ctx.composerDrafts[token.key].unsaved,true);
  assert.ok(broken.ctx.composerDrafts[token.key].variants.standard.html.includes('개인 기록'));
});

test('material draft includes all Drive links',async()=>{
  const {ctx,saved,mount}=setup(); mount('materials','standard','book-a','material-1',{driveLinks:[{title:'첫 자료',driveUrl:'https://drive.google.com/example'}]});
  ctx.captureComposerDraft(); await flush(ctx);
  const draft=await setup(saved).ctx.loadComposerDraft('materials','book-a','material-1');
  assert.equal(draft.variants.standard.driveLinks[0].title,'첫 자료');
  assert.equal(draft.variants.standard.meetingNo,'4');
});

test('password recovery re-encrypts this member drafts and retains other member storage',async()=>{
  const {ctx,saved,mount,unmount}=setup();mount('mine');const first=ctx.captureComposerDraft();await flush(ctx);
  unmount();ctx.SESSION={userId:'member-b',keyB64};mount();const second=ctx.captureComposerDraft();await flush(ctx);
  const otherRaw=saved.getItem(second.key),original=saved.getItem(first.key);
  const fresh=setup(saved);fresh.ctx.SESSION.keyB64=Buffer.alloc(32,42).toString('base64');
  const counts=await fresh.ctx.migratePrivateDraftKeys([keyB64]);
  assert.equal(counts.migrated,1);assert.equal(counts.unreadable,0);
  assert.notEqual(saved.getItem(first.key),original);assert.equal(saved.getItem(second.key),otherRaw);
  const reloaded=setup(saved);reloaded.ctx.SESSION.keyB64=fresh.ctx.SESSION.keyB64;
  const restored=await reloaded.ctx.loadComposerDraft('mine','book-a',null);
  assert.equal(restored.variants.standard.title,'초안 제목');
  const currentRaw=saved.getItem(first.key),again=await reloaded.ctx.migratePrivateDraftKeys([keyB64]);
  assert.equal(again.migrated,0);assert.equal(again.unreadable,0);assert.equal(saved.getItem(first.key),currentRaw);
});

test('draft recovery without a matching legacy key leaves encrypted storage untouched',async()=>{
  const {ctx,saved,mount}=setup();mount('mine');const token=ctx.captureComposerDraft();await flush(ctx);
  const original=saved.getItem(token.key),fresh=setup(saved);fresh.ctx.SESSION.keyB64=Buffer.alloc(32,42).toString('base64');
  const result=await fresh.ctx.migratePrivateDraftKeys([]);
  assert.equal(result.migrated,0);assert.equal(result.unreadable,1);assert.equal(saved.getItem(token.key),original);
});

test('success clears the saved draft without closing a different active composer',async()=>{
  const {ctx,saved,mount}=setup();mount();const token=ctx.captureComposerDraft();
  mount('mine','standard','book-b');const other=ctx.captureComposerDraft();
  assert.equal(ctx.finishComposerDraft('share','book-a',null,'member-a',token),false);
  await flush(ctx);assert.equal(saved.getItem(token.key),null);assert.ok(saved.getItem(other.key));
});
