'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash}=require('node:crypto');
const hints=require('../passwordHint.js');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
const answer={questionId:'first_school',answer:'  한글 학교  '};

test('the five stable question identifiers are included in the bounded hint digest',async()=>{
  assert.deepEqual(hints.questions.map(q=>q.id),['first_school','childhood_place','childhood_nickname','memorable_book','favorite_place']);
  const encoded=await Promise.all(hints.questions.map(q=>hints.encode({questionId:q.id,answer:answer.answer})));
  assert.equal(new Set(encoded).size,5,'the same answer to a different question must not match');
  encoded.forEach(value=>{assert.match(value,/^gwq1:[a-f0-9]{64}$/);assert.equal(Buffer.byteLength(value),69);});
  assert.equal(encoded[0],'gwq1:'+createHash('sha256').update(JSON.stringify(['first_school','한글 학교'])).digest('hex'));
  assert.notEqual(encoded[0],await hints.encode({questionId:'first_school',answer:'다른 학교'}));
});

test('modern answers normalize Korean composition, spacing and English case before hashing',async()=>{
  const expected=await hints.encode({questionId:'memorable_book',answer:'한글 Book'});
  assert.equal(await hints.encode({questionId:'memorable_book',answer:'  '+ '한글'.normalize('NFD')+'   BOOK  '}),expected);
  assert.equal(await hints.encode({questionId:'memorable_book',answer:'한글\nBook'}),expected);
});

test('no raw, missing, unknown or implicit legacy answer can become a new recovery hint',async()=>{
  for(const value of [null,'old hint',[],{answer:'학교'},{questionId:'',answer:'학교'},{questionId:'unknown',answer:'학교'},
    {questionId:'first_school',answer:''},{questionId:'first_school',answer:'   '},{questionId:'first_school',answer:'가'.repeat(201)},
    {questionId:'legacy',answer:'old hint'}])await assert.rejects(hints.encode(value));
  await assert.rejects(hints.encode('old hint',{legacy:true}));
  await assert.rejects(hints.encode({questionId:'',answer:'old hint'},{legacy:true}));
  assert.equal(await hints.encode({questionId:'legacy',answer:'  OLD  Hint  '},{legacy:true}),'OLD  Hint','legacy keeps the old server comparison semantics');
});

test('signup, forgot and profile present the same required unselected question list; only forgot offers legacy',()=>{
  for(const prefix of ['su','fp','pe']){
    const html=hints.formHtml(prefix,prefix==='fp'?{legacy:true}:undefined);
    assert.match(html,new RegExp('id="'+prefix+'-hint-question"[^>]*required'));
    assert.match(html,/<option value="">질문을 선택해주세요<\/option>/);
    assert.doesNotMatch(html,/<option[^>]+selected/);
    hints.questions.forEach(question=>assert.ok(html.includes('<option value="'+question.id+'">'+question.label+'</option>')));
    assert.equal(html.includes('<option value="legacy">기존 힌트로 확인</option>'),prefix==='fp');
    const nodes={[prefix+'-hint-question']:{value:'favorite_place'},[prefix+'-hint']:{value:'여행지'}};
    assert.deepEqual(hints.readForm({getElementById:id=>nodes[id]},prefix),{questionId:'favorite_place',answer:'여행지'});
  }
});

function profileHarness(getSession){
  const calls=[],messages=[],nodes={'pe-hint':{value:answer.answer},'pe-hint-question':{value:answer.questionId}};
  const c={Promise,GrowellPasswordHint:hints,SESSION:{userId:'member',keyB64:'existing-private-key'},saveSessionEpoch:4,
    CURRENT_KEY:{original:true},CURRENT_KEY_MATERIAL:'original-key-material',
    document:{getElementById:id=>nodes[id]},showToast:(message,error)=>messages.push({message,error}),
    sb:{auth:{getSession:getSession||(()=>Promise.resolve({data:{session:{access_token:'member-token'}}}))}},
    callEdgeFunction:async(name,body,token)=>{calls.push({name,body:{...body},token});return {__status:200,ok:true};}};
  vm.createContext(c);vm.runInContext(section('function doUpdateHint(','/* 비밀번호 찾기'),c);
  return {c,calls,messages,nodes};
}

test('profile updates only the encoded question hint and clears the form without changing keys or password',async()=>{
  const {c,calls,nodes}=profileHarness(),session=c.SESSION,key=c.CURRENT_KEY,button={};
  await c.doUpdateHint(answer,button);
  assert.deepEqual(calls,[{name:'update-hint',body:{pwHint:await hints.encode(answer)},token:'member-token'}]);
  assert.equal(c.SESSION,session);assert.equal(c.CURRENT_KEY,key);assert.equal(c.CURRENT_KEY_MATERIAL,'original-key-material');
  assert.equal(nodes['pe-hint'].value,'');assert.equal(nodes['pe-hint-question'].value,'');assert.equal(button.disabled,false);
});

test('profile rejects blank or legacy questions, missing authentication and a changed owner before sending',async()=>{
  for(const value of ['old hint',{questionId:'',answer:'old hint'},{questionId:'legacy',answer:'old hint'}]){
    const {c,calls}=profileHarness();await c.doUpdateHint(value,{});assert.equal(calls.length,0);
  }
  const missing=profileHarness(()=>Promise.resolve({data:{session:null}}));
  await missing.c.doUpdateHint(answer,{});assert.equal(missing.calls.length,0);
  let release,entered;
  const pending=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const {c,calls}=profileHarness(()=>{entered();return pending;});
  const work=c.doUpdateHint(answer,{});await started;
  c.SESSION={userId:'other',keyB64:'other-key'};c.saveSessionEpoch++;
  release({data:{session:{access_token:'other-token'}}});await work;
  assert.equal(calls.length,0);assert.equal(c.SESSION.keyB64,'other-key');
});
