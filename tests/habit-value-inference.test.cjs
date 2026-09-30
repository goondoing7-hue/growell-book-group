const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const habits=require('../habitSuggestions.js');

test('every picker keyword retains its explicitly assigned value',()=>{
  for(const value of habits.categories()){
    for(const {keyword} of value.examples){
      assert.equal(habits.inferValueId(keyword),value.id,keyword);
      assert.equal(habits.inferValueId('매일 '+keyword+' 하기'),value.id,keyword+' in a habit name');
    }
  }
  assert.equal(habits.inferValueId('산책'),'emotion');
  assert.equal(habits.inferValueId('걷기'),'body');
});

test('ordinary Korean habit names and spaced phrases find all seven values',()=>{
  const examples={
    faith:['감사기도','감사 기도 3분','성경 읽기','아침 예배','찬양 듣기','하나님과 대화'],
    love:['부모님안부','부모님 안부 묻기','친구에게 전화하기','가족과 식사하며 대화','감사 편지 쓰기'],
    virtue:['소비줄이기','소비 줄이기','충동구매 멈추기','약속 지키기','매일 분리수거','기부하기'],
    wisdom:['영어단어','영어 단어 10개 외우기','책 읽기','책읽기','자료 공부하기','코딩 연습','자기계발'],
    emotion:['감정일기','감정 일기 쓰기','감사일기','마음 챙김','상대의 이야기 들어 주기','기분 기록'],
    beauty:['방정리','방 정리','책상 정리하기','그림 그리기','피아노 연습','설거지','전시 관람'],
    body:['물마시기','물 마시기','수분 보충','일찍 자기','잠자리에 들기','계단 오르기','양치하기','요가 5분']
  };
  for(const [id,names] of Object.entries(examples)){
    for(const name of names)assert.equal(habits.inferValueId(name),id,name);
  }
});

test('English synonyms work without case or width sensitivity',()=>{
  const examples={
    faith:['morning prayer','Bible reading','worship','ＰＲＡＹＥＲ'],
    love:['call my parents','daily conversation','compliment a friend'],
    virtue:['volunteering','practice kindness','budgeting','recycling'],
    wisdom:['learn English','study vocabulary','READING','coding practice'],
    emotion:['write a journal','mindfulness','gratitude diary'],
    beauty:['tidy my room','listen to music','painting','photography'],
    body:['drink water','evening exercise','go running','sleep early','stretching']
  };
  for(const [id,names] of Object.entries(examples)){
    for(const name of names)assert.equal(habits.inferValueId(name),id,name);
  }
  assert.equal(habits.inferValueId('  아침\t기도  '.normalize('NFD')),'faith');
  assert.equal(habits.inferValueId(' 책\n 읽기 '),'wisdom');
});

test('strong phrases disambiguate broad signals and equal scores use stable value order',()=>{
  for(const name of ['머신러닝','머신 러닝 학습','딥러닝'])assert.equal(habits.inferValueId(name),'wisdom',name);
  assert.equal(habits.inferValueId('러닝머신'),'body');
  assert.equal(habits.inferValueId('감사 기도'),'faith');
  assert.equal(habits.inferValueId('감사 일기'),'emotion');
  for(const name of ['기도 후 공부','공부 후 기도','기도와 운동'])assert.equal(habits.inferValueId(name),'faith',name);
  assert.equal(habits.inferValueId('책 읽기와 운동'),'wisdom');
  assert.equal(habits.inferValueId('칭찬하고 위로하기'),'love');
  const names=['공부 후 기도','감사 일기','물 마시기','취미 시간'];
  const expected=names.map(name=>habits.inferValueId(name));
  for(let repeat=0;repeat<4;repeat++)assert.deepEqual(names.map(name=>habits.inferValueId(name)),expected);
});

test('unrecognized non-empty names still receive virtue while blank and non-string input remain empty',()=>{
  for(const name of ['내일 준비','작은 약속 지키기','새롭게 시작','✨','hobby time','xyz 123']){
    assert.equal(habits.inferValueId(name),'virtue',name);
  }
  // Short English signals must not match inside unrelated words.
  for(const name of ['start','earth','pruning','recall','bedrestful'])assert.equal(habits.inferValueId(name),'virtue',name);
  for(const input of ['', ' \n\t ', null, undefined, 0, 42, false, {}, [], ['기도'],new String('기도')]){
    assert.equal(habits.inferValueId(input),'');
  }
});

test('inference runs with no network or storage access and leaves guide data unchanged',()=>{
  const baseline=JSON.stringify({values:habits.categories(),guide:habits.guide()});
  const sandbox={};
  for(const name of ['fetch','XMLHttpRequest','localStorage','sessionStorage']){
    Object.defineProperty(sandbox,name,{get(){throw Error('Unexpected external access: '+name);}});
  }
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../habitSuggestions.js'),'utf8'),sandbox);
  for(const name of ['감사기도','부모님안부','소비줄이기','영어단어','감정일기','방정리','물마시기','새로운 약속']){
    assert.equal(sandbox.GrowellHabitSuggestions.inferValueId(name),habits.inferValueId(name));
  }
  const returned=habits.categories();returned[0].examples[0].keyword='걷기';
  assert.equal(habits.inferValueId('기도'),'faith');
  assert.equal(JSON.stringify({values:habits.categories(),guide:habits.guide()}),baseline);
});
