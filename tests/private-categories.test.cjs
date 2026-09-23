'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const categories=require('../privateCategories.js');
const sample=[{id:'pcat_journal',label:'나의 일기'},{id:'pcat_ideas-2',label:'읽고 떠오른 생각'}];

test('private category settings identify the exact owner and book record only',()=>{
  assert.equal(categories.recordId('owner-a','emotion'),'private_categories_emotion_owner-a');
  const entry={id:categories.recordId('owner-a','emotion'),userId:'owner-a',bookId:'emotion'};
  assert.equal(categories.isSettingsEntry(entry),true);
  for(const other of [null,[],{}, {...entry,userId:'owner-b'}, {...entry,bookId:'thought'},
    {...entry,id:entry.id+'_extra'}, {...entry,id:'note_private_categories_emotion_owner-a'},
    {...entry,userId:''}, {...entry,bookId:undefined}]) assert.equal(categories.isSettingsEntry(other),false);
  assert.notEqual(categories.recordId('owner-a','emotion'),categories.recordId('owner-b','emotion'));
  assert.notEqual(categories.recordId('owner-a','emotion'),categories.recordId('owner-a','thought'));
  for(const invalid of ['',null,undefined,3,' owner-a ']){
    assert.throws(()=>categories.recordId(invalid,'emotion'));
    assert.throws(()=>categories.recordId('owner-a',invalid));
  }
});

test('category names are trimmed without changing user text, order or input objects',()=>{
  const input=Object.freeze([Object.freeze({id:'pcat_korean',label:'  감정 일기  ',extra:'discard'}),
    Object.freeze({id:'pcat_html',label:'<b>글감</b>'})]);
  const prepared=categories.prepare(input);
  assert.deepEqual(prepared,[{id:'pcat_korean',label:'감정 일기'},{id:'pcat_html',label:'<b>글감</b>'}]);
  assert.equal(input[0].label,'  감정 일기  ');
  prepared[0].label='변경';
  assert.equal(input[0].label,'  감정 일기  ');
  assert.deepEqual(categories.prepare([]),[]);
});

test('invalid IDs, malformed categories, duplicate IDs and case-normalized duplicate names fail',()=>{
  for(const input of [null,undefined,{},'list',Array(1),[null],[[]],[{}],
    [{id:'pcat_',label:'일기'}],[{id:'quote',label:'문장'}],[{id:'pcat_한글',label:'일기'}],
    [{id:'pcat_has space',label:'일기'}],[{id:' pcat_a',label:'일기'}],
    [{id:'pcat_a',label:3}],[{id:'pcat_a',label:' \n '}],
    [{id:'pcat_a',label:'첫째'},{id:'pcat_a',label:'둘째'}],
    [{id:'pcat_a',label:'생각'},{id:'pcat_b',label:' 생각 '}],
    [{id:'pcat_a',label:'Diary'},{id:'pcat_b',label:'dIARY'}],
    [{id:'pcat_a',label:'가'},{id:'pcat_b',label:'\u1100\u1161'}]]){
    assert.throws(()=>categories.prepare(input));
  }
});

test('category limits permit twenty categories and thirty Unicode characters',()=>{
  const twenty=Array.from({length:20},(_,i)=>({id:'pcat_'+i,label:'분류 '+i}));
  assert.equal(categories.prepare(twenty).length,20);
  assert.throws(()=>categories.prepare(twenty.concat({id:'pcat_20',label:'분류 20'})));
  for(const char of ['가','A','🌱']){
    assert.equal(categories.prepare([{id:'pcat_limit',label:char.repeat(30)}])[0].label,char.repeat(30));
    assert.throws(()=>categories.prepare([{id:'pcat_limit',label:char.repeat(31)}]));
  }
});

test('encoded settings round-trip with a version and reject corrupt or unsupported data',()=>{
  const encoded=categories.encode(sample);
  assert.deepEqual(JSON.parse(encoded),{format:'growell-private-categories-v1',categories:sample});
  assert.deepEqual(categories.decode(encoded),sample);
  assert.deepEqual(categories.decode(categories.encode([])),[]);
  for(const text of [undefined,null,{},'', '{bad json','null','[]',JSON.stringify(sample),
    JSON.stringify({format:'growell-private-categories-v2',categories:sample}),
    JSON.stringify({format:'growell-private-categories-v1'}),
    JSON.stringify({format:'growell-private-categories-v1',categories:[{id:'quote',label:'문장'}]})]){
    assert.throws(()=>categories.decode(text));
  }
  assert.throws(()=>categories.encode([{id:'pcat_a',label:''}]));
});

test('only known private categories resolve; legacy, default and deleted types stay unclassified',()=>{
  assert.deepEqual(categories.options(sample),[
    {key:'private-none',label:'분류 없음'},
    {key:'pcat_journal',label:'나의 일기'},
    {key:'pcat_ideas-2',label:'읽고 떠오른 생각'}]);
  assert.equal(categories.key('pcat_journal',sample),'pcat_journal');
  assert.equal(categories.label('pcat_journal',sample),'나의 일기');
  for(const type of [undefined,null,'','private-none','quote','summary','thought','question','insight','pcat_deleted']){
    assert.equal(categories.key(type,sample),'private-none');
    assert.equal(categories.label(type,sample),'분류 없음');
  }
  assert.equal(categories.key('pcat_journal',sample.slice(1)),'private-none');
  assert.equal(categories.label('pcat_journal',sample.slice(1)),'분류 없음');
  assert.deepEqual(categories.options([]),[{key:'private-none',label:'분류 없음'}]);
  assert.deepEqual(sample,[{id:'pcat_journal',label:'나의 일기'},{id:'pcat_ideas-2',label:'읽고 떠오른 생각'}]);
});

test('category resolvers reject corrupt settings instead of silently manufacturing categories',()=>{
  for(const method of ['options','key','label']){
    assert.throws(()=>method==='options'?categories[method](null):categories[method]('quote',null));
  }
});

test('browser UMD exposes the same private category API without CommonJS',()=>{
  const browser={};
  vm.createContext(browser);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../privateCategories.js'),'utf8'),browser);
  assert.deepEqual(Object.keys(browser.GrowellPrivateCategories).sort(),Object.keys(categories).sort());
  assert.equal(browser.GrowellPrivateCategories.encode(sample),categories.encode(sample));
});
