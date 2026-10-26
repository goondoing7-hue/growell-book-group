'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Share=require('../privateShareDomain.js');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const photoSource=html.slice(html.indexOf('function safePhotoUrl('),html.indexOf('function photoFromUrl('));
const browser={URL};vm.createContext(browser);vm.runInContext(photoSource,browser);
const escape=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const helpers={sanitizeHtml:value=>value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,''),plainTextHtml:value=>escape(value).replace(/\r\n|\r|\n/g,'<br>'),safePhotoUrl:browser.safePhotoUrl};
function payload(extra={}){return Object.assign({title:'남겨 둔 제목',html:'<p>책에서 읽은 <strong>문장</strong></p>',noteType:'quote',page:'22–23',photo:null,bgColor:'#F4EDE0',fontSize:'lg'},extra);}
function row(extra={}){return Object.assign({id:'post-fixed-intent',book_id:'emotion',user_id:'member-a',checkin:null,note_type:'quote',meeting_no:'',q1:'',q2:'',q3:'',page:'22–23',html:'<p>그대로 나눌 문장</p>',photo_url:'https://example.test/photo.jpg',bg_color:'#F4EDE0',font_size:'lg',title:'제목',created_at:1793013600000,updated_at:null},extra);}

test('copy fields keep every authored display field while leaving the encrypted source and photo untouched',()=>{
  const photo=Object.freeze({dataUrl:'data:image/png;base64,AQID',mimeType:'image/png',privateLocation:'must not cross'});
  const original=Object.freeze(payload({photo,iv:'private iv',data:'private ciphertext',id:'private-id',userId:'member-a',createdAt:123}));
  const before=JSON.stringify(original),result=Share.fields(original,helpers);
  assert.deepEqual(result,{title:original.title,html:original.html,page:'22–23',photo:{dataUrl:photo.dataUrl,mimeType:'image/png'},bgColor:'#F4EDE0',fontSize:'lg',noteType:'quote',checkin:null,meetingNo:'',q1:'',q2:'',q3:''});
  assert.notEqual(result.photo,photo);assert.equal(JSON.stringify(original),before);
  for(const key of ['iv','data','id','userId','createdAt','privateLocation'])assert.equal(Object.hasOwn(result,key),false,key);
  assert.equal(Object.hasOwn(result.photo,'privateLocation'),false);
});

test('legacy plain text is escaped with line breaks rather than interpreted as HTML',()=>{
  const original=payload({html:null,text:'<책 문장> & 생각\n둘째 줄\r\n셋째 줄',title:undefined,page:27,bgColor:undefined,fontSize:undefined});
  const before=JSON.stringify(original),result=Share.fields(original,helpers);
  assert.equal(result.html,'&lt;책 문장&gt; &amp; 생각<br>둘째 줄<br>셋째 줄');
  assert.equal(result.title,'');assert.equal(result.page,'27');assert.equal(result.bgColor,'');assert.equal(result.fontSize,'');assert.equal(JSON.stringify(original),before);
});

test('HTML uses the existing sanitizer and does not prefer an unrelated legacy text fallback',()=>{
  const original=payload({html:'<p>원래 <em>서식</em></p><script>unsafe()</script>',text:'이 내용으로 바꾸지 않음'}),before=JSON.stringify(original);
  const calls=[];const result=Share.fields(original,Object.assign({},helpers,{sanitizeHtml:value=>{calls.push(value);return helpers.sanitizeHtml(value);}}));
  assert.deepEqual(calls,[original.html]);assert.equal(result.html,'<p>원래 <em>서식</em></p>');assert.equal(JSON.stringify(original),before);
});

test('private insight and old custom categories retain their full body and map to an ordinary thought without invented answers',()=>{
  for(const noteType of ['insight','private-none','pcat_old',undefined,'unknown']){
    const original=payload({noteType,html:'<p>내가 적은 통찰 원문</p>',photo:{dataUrl:'https://example.test/original.jpg',mimeType:''},checkin:'sunny',meetingNo:'2',q1:'다른 필드',q2:'개인 정보',q3:'보내지 않을 필드'});
    const before=JSON.stringify(original),result=Share.fields(original,helpers);
    assert.equal(result.noteType,'thought');assert.equal(result.html,original.html);assert.equal(result.photo.dataUrl,original.photo.dataUrl);
    assert.equal(result.checkin,null);assert.equal(result.meetingNo,'');assert.equal(result.q1,'');assert.equal(result.q2,'');assert.equal(result.q3,'');
    assert.equal(JSON.stringify(original),before);assert.match(Share.message(noteType),/내 생각/);
  }
  for(const noteType of ['quote','thought','question','summary']){
    assert.equal(Share.fields(payload({noteType}),helpers).noteType,noteType);assert.equal(Share.message(noteType),'');
  }
});

test('photo-only notes are shareable with no invented title or body',()=>{
  const result=Share.fields({photo:{dataUrl:'data:image/jpeg;base64,AQID'},html:'',title:'',noteType:'thought'},helpers);
  assert.equal(result.title,'');assert.equal(result.html,'');assert.deepEqual(result.photo,{dataUrl:'data:image/jpeg;base64,AQID',mimeType:'image/jpeg'});
});

test('a photo that cannot be safely copied fails explicitly instead of silently publishing without it',()=>{
  for(const photo of [{dataUrl:'javascript:alert(1)',mimeType:'image/jpeg'},{dataUrl:'data:image/svg+xml;base64,AQID',mimeType:'image/svg+xml'},{dataUrl:'https://example.test/p.jpg',mimeType:'text/html'},{dataUrl:'data:image/png;base64,AQID',mimeType:'image/jpeg'},{dataUrl:42},'photo',{}]){
    assert.throws(()=>Share.fields(payload({photo}),helpers),/사진/);
  }
  assert.throws(()=>Share.fields(payload({photo:{dataUrl:'https://example.test/p.jpg'}}),Object.assign({},helpers,{safePhotoUrl:()=>null})),/사진/);
});

test('known background and font options are copied exactly while unknown style values are rejected',()=>{
  for(const bgColor of ['','#EFE6D8','#E4EEE6','#F3E1E6','#E1EAF3','#E9E2F2','#F4EDE0'])assert.equal(Share.fields(payload({bgColor}),helpers).bgColor,bgColor);
  for(const fontSize of ['','sm','lg','xl'])assert.equal(Share.fields(payload({fontSize}),helpers).fontSize,fontSize);
  for(const bgColor of ['red','#fff','url(javascript:unsafe())','#F4EDE0;position:fixed'])assert.throws(()=>Share.fields(payload({bgColor}),helpers),/배경색/);
  for(const fontSize of ['large','42px','<script>'])assert.throws(()=>Share.fields(payload({fontSize}),helpers),/글자 크기/);
});

test('empty content and malformed fields do not create an empty or reinterpreted public post',()=>{
  for(const value of [null,[],{},payload({html:'<p><br></p>'}),payload({html:'<p> &nbsp;&#160;&#xA0;\u200b </p>'}),payload({html:'<script>gone</script>'})])assert.throws(()=>Share.fields(value,helpers));
  for(const extra of [{html:42},{title:{}},{page:{}},{page:NaN},{fontSize:[]},{bgColor:{}}])assert.throws(()=>Share.fields(payload(extra),helpers));
  for(const missing of ['sanitizeHtml','plainTextHtml','safePhotoUrl'])assert.throws(()=>Share.fields(payload(),Object.assign({},helpers,{[missing]:null})),/편집 도구/);
});

test('only an explicit draft option permits empty edits without bypassing any other field validation',()=>{
  const blank=payload({title:'작성 중 제목',html:'<p><br></p>',photo:null}),before=JSON.stringify(blank);
  assert.throws(()=>Share.fields(blank,helpers),/내용이나 사진/);
  for(const allowEmpty of [false,1,'true',null,undefined])assert.throws(()=>Share.fields(blank,Object.assign({},helpers,{allowEmpty})),/내용이나 사진/);
  const draftHelpers=Object.assign({},helpers,{allowEmpty:true}),result=Share.fields(blank,draftHelpers);
  assert.equal(result.html,'<p><br></p>');assert.equal(result.title,'작성 중 제목');assert.equal(result.photo,null);assert.equal(JSON.stringify(blank),before);
  const sanitized=Share.fields(payload({html:'<script>unsafe()</script>',photo:null}),draftHelpers);assert.equal(sanitized.html,'');
  for(const extra of [{html:42},{title:{}},{page:{}},{page:NaN},{fontSize:'42px'},{bgColor:'url(javascript:unsafe())'},{photo:{dataUrl:'javascript:alert(1)',mimeType:'image/jpeg'}}])assert.throws(()=>Share.fields(payload(Object.assign({html:'',photo:null},extra)),draftHelpers));
  for(const missing of ['sanitizeHtml','plainTextHtml','safePhotoUrl'])assert.throws(()=>Share.fields(blank,Object.assign({},draftHelpers,{[missing]:null})),/편집 도구/);
});

test('a lost insert response is reconciled only against the exact intended public row',()=>{
  const expected=row(),actual=Object.assign({},expected,{server_added:'ignored',iv:'private key ignored',data:'private ciphertext ignored'});
  assert.equal(Share.matchingRow(actual,expected),true);
  const source=JSON.stringify(actual);assert.equal(Share.matchingRow(actual,Object.assign({},expected,{iv:'must not compare',data:'must not compare'})),true);assert.equal(JSON.stringify(actual),source);
  for(const key of Object.keys(expected)){
    const changed=Object.assign({},actual,{[key]:expected[key]===null?'unexpected':typeof expected[key]==='number'?expected[key]+1:expected[key]+'changed'});
    assert.equal(Share.matchingRow(changed,expected),false,key+' differs');
    const missing=Object.assign({},actual);delete missing[key];assert.equal(Share.matchingRow(missing,expected),false,key+' missing');
  }
  assert.equal(Share.matchingRow(row({id:'other-intent'}),expected),false);assert.equal(Share.matchingRow(row({user_id:'another-member'}),expected),false);assert.equal(Share.matchingRow(row({book_id:'another-book'}),expected),false);
});

test('incomplete or invalid expected identities cannot count as a successful retry',()=>{
  for(const expected of [null,[],{},row({id:''}),row({id:' padded '}),row({user_id:''}),row({book_id:''}),row({created_at:'1793013600000'}),row({created_at:NaN}),row({updated_at:undefined})])assert.equal(Share.matchingRow(expected,expected),false);
  const incomplete=row();delete incomplete.photo_url;assert.equal(Share.matchingRow(incomplete,incomplete),false);
  assert.equal(Share.matchingRow(row({updated_at:1793013600100}),row({updated_at:1793013600100})),true);
});

test('the same dependency-free module exposes the browser UMD API',()=>{
  const context={};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'..','privateShareDomain.js'),'utf8'),context);
  assert.equal(typeof context.GrowellPrivateShareDomain.fields,'function');assert.equal(typeof context.GrowellPrivateShareDomain.matchingRow,'function');assert.equal(typeof context.GrowellPrivateShareDomain.message,'function');
});
