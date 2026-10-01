const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const readingHabits=require('../readingHabit.js');
const habitSuggestions=require('../habitSuggestions.js');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');

test('seven values retain the requested keywords, reading exclusion and isolated guide data',()=>{
  const expected={faith:['기도','묵상','필사','통독'],love:['대화','연락','칭찬'],virtue:['인사','양보','봉사','절제'],wisdom:['독서','공부','복습','자격증','자기개발'],emotion:['일기','경청','산책','위로'],beauty:['청소','음악','예술'],body:['운동','달리기','호흡','식단','수면','걷기','스트레칭']};
  const categories=habitSuggestions.categories(),guide=habitSuggestions.guide(),baseline=JSON.stringify({categories,guide});
  assert.deepEqual(categories.map(item=>item.id),Object.keys(expected));assert.deepEqual(categories.map(item=>item.label+item.hanja),['성聖','애愛','덕德','지智','정情','미美','체體']);
  for(const value of categories){
    assert.deepEqual(habitSuggestions.suggestions('do',value.id),expected[value.id]);assert.deepEqual(habitSuggestions.suggestions('avoid',value.id),expected[value.id].filter(keyword=>keyword!=='독서'));assert.deepEqual(value.examples.map(example=>example.keyword),expected[value.id]);
    for(const key of ['title','summary','description','why','reflection','headline','lead','question'])assert.ok(typeof value[key]==='string'&&value[key].trim().length>5,key+' explains '+value.id);assert.ok(value.meaning.length>=2);for(const example of value.examples)assert.ok(example.action.length>10);
  }
  assert.equal(categories.flatMap(value=>habitSuggestions.suggestions('do',value.id)).length,30);assert.equal(categories.flatMap(value=>habitSuggestions.suggestions('avoid',value.id)).length,29);
  for(const args of [['unknown','faith'],['do','thought'],['avoid','invalid'],['do','__proto__'],['do',null]])assert.deepEqual(habitSuggestions.suggestions(...args),[]);
  assert.match(categories[0].description,/거룩/);assert.match(categories[0].description,/은혜/);assert.match(guide.intro,/성·애·덕·지·정·미·체/);assert.match(guide.lead,/가치/);assert.equal(guide.why,guide.whyBody);assert.equal(guide.whyBody.split('\n\n').length,3);for(const meaning of ['하나님','영성','감성','지성','육체','인격과 실력','골고루','균형'])assert.ok(guide.whyBody.includes(meaning));assert.match(guide.connection,/서로 이어/);assert.equal(guide.steps.length,3);assert.match(guide.steps.map(step=>step.text).join(' '),/언제, 어디서, 얼마나/);assert.match(guide.closing,/체크의 개수로 나의 가치를 평가하지/);assert.doesNotMatch(baseline,/큐인|학교|상담복지센터/);
  categories[0].title='changed';categories[0].examples[0].keyword='changed';categories[0].examples.push({keyword:'extra',action:'extra'});categories.pop();guide.steps[0].text='changed';guide.steps.push({title:'extra',text:'extra'});guide.intro='changed';const suggestions=habitSuggestions.suggestions('do','faith');suggestions[0]='changed';suggestions.push('extra');
  assert.equal(JSON.stringify({categories:habitSuggestions.categories(),guide:habitSuggestions.guide()}),baseline);assert.deepEqual(habitSuggestions.suggestions('do','faith'),expected.faith);
});

test('habit names infer all picker keywords and classify custom names without external selection',()=>{
  for(const value of habitSuggestions.categories()){
    for(const example of value.examples){
      assert.equal(habitSuggestions.inferValueId(example.keyword),value.id);
      assert.equal(habitSuggestions.inferValueId('매일 '+example.keyword+' 하기'),value.id);
    }
  }
  for(const name of ['책 읽기','책읽기','  책  읽기  ','독서 후 복습','자기개발 10분'])assert.equal(habitSuggestions.inferValueId(name),'wisdom');
  assert.equal(habitSuggestions.inferValueId('감사일기'),'emotion');
  assert.equal(habitSuggestions.inferValueId('아침 기도'.normalize('NFD')),'faith');
  for(const name of ['', '  ',null,undefined,42,{},[],['기도']])assert.equal(habitSuggestions.inferValueId(name),'');
  for(const [name,value] of Object.entries({'내일 준비':'virtue','편지 쓰기':'love','그림 그리기':'beauty','기도 후 공부':'faith','책 읽기와 운동':'wisdom','칭찬하고 위로하기':'love'}))assert.equal(habitSuggestions.inferValueId(name),value);
});

function harness(){
  const original={id:'h1',userId:'owner',bookId:'emotion',name:'이전 이름',place:'집',time:'밤',goal:'10분',startDate:'2026-09-01',endDate:'2026-09-30',checkedDates:['2026-09-01'],createdAt:123,compatibilityField:'preserved'};
  let mutation,saves=0;const toasts=[];
  const c={Date,GrowellHabits:require('../habitDomain.js'),GrowellReadingHabits:readingHabits,GrowellHabitSuggestions:habitSuggestions,SESSION:{userId:'owner'},STATE:{habits:{h1:original}},memberLoadState:{habits:'ready'},ymd:()=> '2026-09-22',showToast:(...args)=>toasts.push(args),saveState:fn=>{mutation=fn;saves++;},uid:()=> 'new-id',render(){}};
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('function validateHabitPeriod('),source.indexOf('function deleteHabit(')),c);
  return {c,original,toasts,apply:state=>mutation(state),saves:()=>saves};
}
const payload={name:'새 습관',place:'독서 의자',time:'21:00',goal:'매일 15분',startDate:'2026-09-10',endDate:'2026-10-09'};
test('editing uses latest queued checks and preserves ID, creation timestamp and existing fields',()=>{
  const h=harness();h.c.editHabit('h1',payload,null);
  const latest=structuredClone(h.c.STATE);latest.habits.h1.checkedDates.push('2026-09-22');h.apply(latest);
  assert.deepEqual(Array.from(latest.habits.h1.checkedDates),['2026-09-01','2026-09-22']);
  assert.equal(latest.habits.h1.id,'h1');assert.equal(latest.habits.h1.createdAt,123);assert.equal(latest.habits.h1.compatibilityField,'preserved');
  assert.equal(latest.habits.h1.name,'새 습관');assert.equal(latest.habits.h1.place,'독서 의자');assert.equal(latest.habits.h1.endDate,'2026-10-09');assert.equal(h.original.name,'이전 이름');
});
test('failed or pending loading prevents edits and creation from overwriting saved records',()=>{
  const h=harness();h.c.memberLoadState.habits='error';h.c.editHabit('h1',payload,null);h.c.submitHabit('emotion',payload,null);
  assert.equal(h.saves(),0);assert.equal(h.toasts.length,2);assert.equal(h.original.name,'이전 이름');
});
test('editing a different owner and invalid dates never enqueue a save',()=>{
  const h=harness();h.c.SESSION.userId='someone-else';h.c.editHabit('h1',payload,null);assert.equal(h.saves(),0);
  h.c.SESSION.userId='owner';h.c.editHabit('h1',{...payload,endDate:'2026-02-30'},null);assert.equal(h.saves(),0);
});
test('new habit writes only the existing compatible habit fields',()=>{
  const h=harness();h.c.submitHabit('emotion',payload,null);const next={habits:{}};h.apply(next);
  assert.equal(next.habits['new-id'].userId,'owner');assert.equal(next.habits['new-id'].startDate,payload.startDate);assert.equal(next.habits['new-id'].time,'21:00');assert.equal(next.habits['new-id'].checkedDates.length,0);
  assert.equal(next.habits['new-id'].behaviorType,'do');
});

test('avoiding kind is created and edited without changing existing check records',()=>{
  const h=harness();h.c.submitHabit('emotion',{...payload,behaviorType:'avoid'},null);const next={habits:{}};h.apply(next);
  assert.equal(next.habits['new-id'].behaviorType,'avoid');
  h.c.editHabit('h1',{...payload,behaviorType:'avoid'},null);const latest=structuredClone(h.c.STATE);latest.habits.h1.checkedDates.push('2026-09-22');h.apply(latest);
  assert.equal(latest.habits.h1.behaviorType,'avoid');assert.deepEqual(Array.from(latest.habits.h1.checkedDates),['2026-09-01','2026-09-22']);
});
test('a legacy edit without kind does not reset a newer queued kind change',()=>{
  const h=harness();h.c.editHabit('h1',payload,null);const latest=structuredClone(h.c.STATE);latest.habits.h1.behaviorType='avoid';h.apply(latest);
  assert.equal(latest.habits.h1.behaviorType,'avoid');
});
test('habit server round trip retains kind and reads older rows as doing',()=>{
  const c={};vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('function mapHabitRow('),source.indexOf('\nvar STATE =')),c);
  vm.runInContext(source.slice(source.indexOf('var GENERIC_COLLECTIONS ='),source.indexOf('function diffDict(')),c);
  const old={id:'h1',book_id:'emotion',user_id:'owner',checked_dates:['2026-09-22']};
  assert.equal(c.mapHabitRow(old).behaviorType,'do');
  const mapped=c.mapHabitRow({...old,behavior_type:'avoid'}),row=c.GENERIC_COLLECTIONS.habits.toRow(mapped);
  assert.equal(row.behavior_type,'avoid');assert.equal(row.id,'h1');assert.deepEqual(Array.from(row.checked_dates),['2026-09-22']);
});

const readingGoal=(extra={})=>({bookId:'archive-one',linkedBookId:'',targetPages:10,...extra});
const archiveRow=(extra={})=>({entry:{id:'archive-one',userId:'owner'},book:{title:'읽는 책',linkedBookId:'',deleted:false,readingSessions:[]},...extra});
function connectArchive(h,snapshot={status:'ready',rows:[archiveRow()]}){
  h.c.GrowellReadingHabits=readingHabits;h.c.habitArchiveSnapshot=()=>snapshot;return snapshot;
}

test('habit database mapper and serializer round trip reading goals without changing checks or legacy goal text',()=>{
  const c={GrowellReadingHabits:readingHabits};vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('function mapHabitRow('),source.indexOf('\nvar STATE =')),c);
  vm.runInContext(source.slice(source.indexOf('var GENERIC_COLLECTIONS ='),source.indexOf('function diffDict(')),c);
  const raw={id:'h1',book_id:'emotion',user_id:'owner',name:'읽기',goal:'  기존 목표\n매일 읽기  ',behavior_type:'avoid',checked_dates:['2026-09-01','2026-09-22'],created_at:123,updated_at:456};
  const plain=c.mapHabitRow(raw),legacyRow=c.GENERIC_COLLECTIONS.habits.toRow(plain);
  assert.equal(plain.readingGoal,null);assert.equal(legacyRow.goal,raw.goal);
  plain.readingGoal=readingGoal();const saved=c.GENERIC_COLLECTIONS.habits.toRow(plain);
  assert.equal(typeof saved.goal,'string');assert.notEqual(saved.goal,raw.goal);assert.equal(saved.readingGoal,undefined);
  const restored=c.mapHabitRow(saved);
  assert.deepEqual({...restored.readingGoal},readingGoal());assert.equal(restored.goal,raw.goal);
  for(const key of ['id','bookId','userId','name','behaviorType','createdAt','updatedAt'])assert.equal(restored[key],plain[key]);
  assert.deepEqual(Array.from(restored.checkedDates),raw.checked_dates);
  assert.equal(c.GENERIC_COLLECTIONS.habits.toRow({...restored,readingGoal:null}).goal,raw.goal);
});

test('habit values round trip through the existing goal field without inferring a value from a legacy name',()=>{
  const c={GrowellReadingHabits:readingHabits};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function mapHabitRow('),source.indexOf('\nvar STATE =')),c);vm.runInContext(source.slice(source.indexOf('var GENERIC_COLLECTIONS ='),source.indexOf('function diffDict(')),c);
  const raw={id:'value-habit',book_id:'emotion',user_id:'owner',name:'기도',goal:'  나의 목표\n그대로 보존  ',checked_dates:['2026-09-20','2026-09-22'],created_at:123};
  const old=c.mapHabitRow(raw);assert.equal(old.valueId,'');assert.equal(c.GENERIC_COLLECTIONS.habits.toRow(old).goal,raw.goal);
  for(const valueId of ['faith','love','virtue','wisdom','emotion','beauty','body'])for(const goal of [null,readingGoal()]){
    const row=c.GENERIC_COLLECTIONS.habits.toRow({...old,valueId,readingGoal:goal}),restored=c.mapHabitRow(row);
    assert.equal(row.valueId,undefined);assert.equal(row.value_id,undefined);assert.equal(restored.valueId,valueId);assert.equal(restored.goal,raw.goal);assert.deepEqual(restored.readingGoal?{...restored.readingGoal}:null,goal);assert.deepEqual(Array.from(restored.checkedDates),raw.checked_dates);assert.equal(restored.bookId,'emotion');assert.equal(restored.id,'value-habit');
  }
});

test('creating and changing a value preserve checks and older edits do not reset a newer value choice',()=>{
  const h=harness();h.c.submitHabit('emotion',{...payload,valueId:'beauty'},null);const created={habits:{}};h.apply(created);assert.equal(created.habits['new-id'].valueId,'beauty');assert.equal(created.habits['new-id'].bookId,'emotion');
  h.original.valueId='faith';h.c.editHabit('h1',{...payload,valueId:'love'},null);const latest=structuredClone(h.c.STATE);latest.habits.h1.checkedDates.push('2026-09-22');h.apply(latest);
  assert.equal(latest.habits.h1.valueId,'love');assert.deepEqual(Array.from(latest.habits.h1.checkedDates),['2026-09-01','2026-09-22']);assert.equal(latest.habits.h1.createdAt,123);assert.equal(latest.habits.h1.compatibilityField,'preserved');assert.equal(latest.habits.h1.bookId,'emotion');
  h.c.editHabit('h1',payload,null);latest.habits.h1.valueId='body';h.apply(latest);assert.equal(latest.habits.h1.valueId,'body');assert.deepEqual(Array.from(latest.habits.h1.checkedDates),['2026-09-01','2026-09-22']);
});

test('reading habit creation accepts only a ready exact owned and current book connection',()=>{
  const valid=harness();connectArchive(valid);valid.c.submitHabit('emotion',{...payload,readingGoal:readingGoal()},null);
  const saved={habits:{}};valid.apply(saved);assert.deepEqual({...saved.habits['new-id'].readingGoal},readingGoal());
  const cases=[
    {status:'loading',rows:[archiveRow()]},{status:'error',rows:[archiveRow()]},
    {status:'ready',rows:[]},
    {status:'ready',rows:[archiveRow({entry:{id:'archive-one',userId:'foreign'}})]},
    {status:'ready',rows:[archiveRow({book:{title:'지운 책',deleted:true,linkedBookId:''}})]},
    {status:'ready',rows:[archiveRow({book:{title:'연결이 바뀐 책',linkedBookId:'thought'}})]}
  ];
  for(const snapshot of cases){
    const h=harness();connectArchive(h,snapshot);
    h.c.submitHabit('emotion',{...payload,readingGoal:readingGoal()},null);h.c.editHabit('h1',{...payload,readingGoal:readingGoal()},null);
    assert.equal(h.saves(),0,JSON.stringify(snapshot));assert.equal(h.toasts.length,2);assert.equal(h.original.name,'이전 이름');
  }
  for(const targetPages of [0,1.5,100001]){
    const h=harness();connectArchive(h);h.c.submitHabit('emotion',{...payload,readingGoal:readingGoal({targetPages})},null);assert.equal(h.saves(),0);
  }
});

test('the actual reading-goal validator safely rejects malformed rows and duplicate owned identities',()=>{
  const malformed=[null,undefined,{},[],{entry:null,book:{}},{entry:{id:'archive-one',userId:'owner'},book:null}];
  const invalidRows=[undefined,null,{},'not a list',malformed,[archiveRow(),archiveRow()],[archiveRow(),archiveRow({book:{linkedBookId:'other'}})]];
  for(const rows of invalidRows){
    const h=harness();connectArchive(h,{status:'ready',rows});const before=JSON.stringify(h.c.STATE),input={...payload,readingGoal:readingGoal()};
    const result=h.c.validateHabitReadingGoal(input);assert.equal(result.ok,false);assert.match(result.msg,/다시 선택/);
    h.c.submitHabit('emotion',input,null);h.c.editHabit('h1',input,null);assert.equal(h.saves(),0);assert.equal(h.toasts.length,2);assert.equal(JSON.stringify(h.c.STATE),before);
  }
  const h=harness();connectArchive(h,{status:'ready',rows:[...malformed,archiveRow({entry:{id:'archive-one',userId:'foreign'}}),archiveRow({book:{deleted:true}}),archiveRow()]});
  const input={...payload,readingGoal:readingGoal()},before=JSON.stringify(input),result=h.c.validateHabitReadingGoal(input);
  assert.equal(result.ok,true);assert.deepEqual({...result.goal},readingGoal());assert.equal(JSON.stringify(input),before);
  h.c.submitHabit('emotion',input,null);assert.equal(h.saves(),1);const saved={habits:{}};h.apply(saved);assert.deepEqual({...saved.habits['new-id'].readingGoal},readingGoal());
});

test('avoiding habits reject a reading goal even with a valid book, but can remove an existing connection',()=>{
  const h=harness();connectArchive(h);h.original.readingGoal=readingGoal();
  const avoid={...payload,behaviorType:'avoid',readingGoal:readingGoal()};
  h.c.submitHabit('emotion',avoid,null);h.c.editHabit('h1',avoid,null);
  assert.equal(h.saves(),0);assert.equal(h.toasts.length,2);
  h.c.editHabit('h1',{...avoid,readingGoal:null},null);
  assert.equal(h.saves(),1);const latest=structuredClone(h.c.STATE);latest.habits.h1.checkedDates.push('2026-09-22');h.apply(latest);
  assert.equal(latest.habits.h1.behaviorType,'avoid');assert.equal(latest.habits.h1.readingGoal,null);
  assert.deepEqual(Array.from(latest.habits.h1.checkedDates),['2026-09-01','2026-09-22']);
});

test('editing the selected reading book or target preserves latest checks; explicit null disables only the connection',()=>{
  const h=harness();h.original.readingGoal=readingGoal();
  connectArchive(h,{status:'ready',rows:[archiveRow({entry:{id:'archive-two',userId:'owner'},book:{title:'다음 책',linkedBookId:'thought',deleted:false}})]});
  const nextGoal=readingGoal({bookId:'archive-two',linkedBookId:'thought',targetPages:25});
  h.c.editHabit('h1',{...payload,readingGoal:nextGoal},null);
  const latest=structuredClone(h.c.STATE);latest.habits.h1.checkedDates.push('2026-09-22');h.apply(latest);
  assert.deepEqual({...latest.habits.h1.readingGoal},nextGoal);assert.deepEqual(Array.from(latest.habits.h1.checkedDates),['2026-09-01','2026-09-22']);
  assert.equal(latest.habits.h1.createdAt,123);assert.equal(latest.habits.h1.bookId,'emotion');assert.equal(latest.habits.h1.compatibilityField,'preserved');
  h.c.STATE=latest;h.c.editHabit('h1',{...payload,readingGoal:null},null);const disabled=structuredClone(latest);h.apply(disabled);
  assert.equal(disabled.habits.h1.readingGoal,null);assert.equal(disabled.habits.h1.goal,payload.goal);assert.deepEqual(Array.from(disabled.habits.h1.checkedDates),['2026-09-01','2026-09-22']);
  h.c.editHabit('h1',payload,null);const queued=structuredClone(latest);queued.habits.h1.readingGoal={...nextGoal,targetPages:30};h.apply(queued);
  assert.equal(queued.habits.h1.readingGoal.targetPages,30,'older edits without the reading field keep the latest goal');
});

function cardHarness(){
  class Today extends Date{constructor(...args){super(...(args.length?args:[2026,8,22,12]));}}
  const c={Date:Today,GrowellHabits:require('../habitDomain.js'),GrowellReadingHabits:readingHabits,GrowellHabitSuggestions:habitSuggestions,habitValueSummaryDialog:null,habitSaveIntents:{},habitHistoryView:'progress',habitHistoryMonth:null,
    I_CAL:'',I_BACK:'',I_EDIT:'',I_CHECK:'',I_TRASH:'',I_CLOSE:'',svgIcon:()=>'<svg></svg>',
    esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
  vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function pad2('),source.indexOf('function habitFormHtml(')),c);
  return c;
}
function overviewCheckbox(html,id,date){
  const input=Array.from(html.matchAll(/<input\b[^>]*>/g),match=>match[0]).find(tag=>tag.includes('data-habit-overview-day="'+id+'|'+date+'"'));
  assert.ok(input,'the overview uses a native checkbox for '+id);assert.match(input,/type="checkbox"/);assert.match(input,/class="habit-overview-toggle/);assert.doesNotMatch(input,/aria-pressed=/);return input;
}
test('habit card shows successes against the whole target period rather than elapsed days',()=>{
  const c=cardHarness(),h={id:'h1',name:'책 읽기',startDate:'2026-09-20',endDate:'2026-09-29',checkedDates:['2026-09-20','2026-09-21'],behaviorType:'do'};
  const html=c.habitCardHtml(h);
  assert.match(html,/성공 <strong>2일<\/strong> \/ 10일/);assert.match(html,/aria-valuenow="20"/);
  assert.match(html,/data-habit-today data-habit-day="h1\|2026-09-22" aria-pressed="false"/);
  assert.match(html,/<span data-habit-today-label>성공<\/span>/);
  assert.match(html,/data-habit-record="h1" data-habit-record-view="week" aria-haspopup="dialog"/);
  assert.match(html,/data-habit-record="h1" data-habit-record-view="month" aria-haspopup="dialog"/);
  assert.match(html,/habit-detail-arrow" data-habit-history="h1"/);
  assert.doesNotMatch(html,/<details|data-habit-view=|habit-week-grid|habit-hist-grid/);
  assert.deepEqual(h.checkedDates,['2026-09-20','2026-09-21']);
});

test('saved reading ranges display goal achievement without marking a habit successful until its manual check',()=>{
  const c=cardHarness(),habit={id:'h1',userId:'owner',name:'매일 읽기',startDate:'2026-09-20',endDate:'2026-09-29',checkedDates:['2026-09-21'],readingGoal:readingGoal()};
  const rows=[archiveRow({book:{title:'<오늘의 책>',readingSessions:[
    {id:'morning',startPage:20,endPage:26,createdAt:new Date(2026,8,22,9).getTime()},
    {id:'evening',startPage:26,endPage:31,createdAt:new Date(2026,8,22,11).getTime()}
  ]}})],snapshot={status:'ready',rows};
  Object.assign(c,{SESSION:{userId:'owner'},GrowellReadingHabits:readingHabits,GrowellArchive:{readingSnapshot:()=>snapshot},readingDataReady:()=>true,memberLoadState:{readingLogs:'ready',readingMeta:'ready'}});
  const before=JSON.stringify({habit,rows});let html=c.habitCardHtml(habit);
  assert.match(html,/habit-reading-progress is-achieved/);assert.match(html,/목표 달성/);assert.match(html,/11 \/ 10쪽 · 성공은 직접 체크해주세요/);
  assert.match(html,/aria-valuenow="10" aria-valuetext="11쪽 읽음 · 목표 10쪽"/);assert.match(html,/&lt;오늘의 책&gt;/);
  assert.match(html,/data-habit-day="h1\|2026-09-22" aria-pressed="false"/);assert.equal(JSON.stringify({habit,rows}),before);
  habit.checkedDates.push('2026-09-22');html=c.habitCardHtml(habit);assert.match(html,/data-habit-day="h1\|2026-09-22" aria-pressed="true"/);
  assert.match(html,/목표 달성/);assert.equal(JSON.stringify(rows),JSON.stringify(JSON.parse(before).rows));
});

test('reading summary never reports success from a stale load, unavailable owner or deleted book',()=>{
  const c=cardHarness(),habit={id:'h1',readingGoal:readingGoal()},snapshot={status:'ready',rows:[archiveRow()]};
  Object.assign(c,{SESSION:{userId:'owner'},GrowellReadingHabits:readingHabits,GrowellArchive:{readingSnapshot:()=>snapshot},readingDataReady:()=>false,memberLoadState:{readingLogs:'loading',readingMeta:'ready'}});
  assert.match(c.habitReadingProgressHtml(habit),/불러오는 중/);assert.doesNotMatch(c.habitReadingProgressHtml(habit),/목표 달성|progressbar/);
  c.memberLoadState.readingLogs='error';assert.match(c.habitReadingProgressHtml(habit),/불러오지 못/);
  c.readingDataReady=()=>true;c.SESSION={userId:'other'};assert.match(c.habitReadingProgressHtml(habit),/연결된 책이 책장에 없어요/);
  c.SESSION={userId:'owner'};snapshot.rows[0].book.deleted=true;assert.match(c.habitReadingProgressHtml(habit),/연결된 책이 책장에 없어요/);
  c.SESSION=null;assert.match(c.habitReadingProgressHtml(habit),/불러오는 중/);
});
test('ongoing habits do not invent a goal percentage and ended or future habits cannot check today',()=>{
  const c=cardHarness(),ongoing={id:'h1',name:'계속 읽기',startDate:'2026-09-20',checkedDates:['2026-09-21']};
  assert.doesNotMatch(c.habitCardHtml(ongoing),/role="progressbar"/);
  assert.match(c.habitCardHtml(ongoing),/지금까지 <strong>1일 성공/);
  assert.equal(c.habitTodayState({...ongoing,startDate:'2026-10-01'},'2026-09-22').canCheck,false);
  assert.equal(c.habitTodayState({...ongoing,startDate:'2026-10-01'},'2026-09-22').label,'시작 전');
  assert.equal(c.habitTodayState({...ongoing,endDate:'2026-09-21'},'2026-09-22').canCheck,false);
  assert.match(c.habitCardHtml({...ongoing,endDate:'2026-09-21'}),/기간 종료" disabled/);
});
test('today success remains reversible for avoiding habits alongside their own record buttons',()=>{
  const c=cardHarness(),h={id:'h1',name:'<화면 쉬기>',behaviorType:'avoid',startDate:'2026-09-20',endDate:'2026-09-29',checkedDates:['2026-09-21','2026-09-22']};
  const html=c.habitCardHtml(h);
  assert.match(html,/절제할 습관/);assert.match(html,/&lt;화면 쉬기&gt;/);assert.match(html,/aria-pressed="true"[^>]+다시 누르면 취소/);
  assert.match(html,/<strong>2일<\/strong> 연속 절제/);assert.equal(c.habitTodayState(h,'2026-09-22').canCheck,true);
  assert.match(html,/data-habit-record="h1" data-habit-record-view="month"/);
  assert.match(c.habitCardHtml({...h,id:'h2'}),/data-habit-record="h2" data-habit-record-view="week"/);
});
test('overview includes only the current owner across books and immediately reflects unsaved check intentions',()=>{
  const c=cardHarness();c.SESSION={userId:'owner'};c.memberLoadState={habits:'ready'};
  c.STATE={habits:{
    mine:{id:'mine',userId:'owner',bookId:'emotion',name:'내 습관',goal:'15분 <집중>',time:'21:00 "밤"',place:'거실 & 소파',startDate:'2026-09-22',checkedDates:[]},
    otherBook:{id:'otherBook',userId:'owner',bookId:'action',name:'다른 책 습관',startDate:'2026-09-22',checkedDates:[]},
    stranger:{id:'stranger',userId:'someone-else',bookId:'emotion',name:'타인 습관',startDate:'2026-09-22',checkedDates:['2026-09-22']}
  }};
  c.bookById=id=>({title:id==='action'?'행동 책':'감정 책'});
  c.habitSaveIntents={mine:{'2026-09-22':{checked:true,status:'saving'}}};
  vm.runInContext(source.slice(source.indexOf('function habitWithPendingChecks('),source.indexOf('function habitSaveStatusHtml(')),c);
  const html=c.habitOverviewBodyHtml();
  assert.match(html,/오늘 완료<\/span><strong>1<small> \/ 2/);assert.match(html,/남은 습관<\/span><strong>1<small>개/);assert.match(html,/오늘 실천율<\/span><strong>50<small>%/);
  assert.match(html,/다른 책 습관/);assert.match(html,/data-habit-overview-open="otherBook"/);assert.doesNotMatch(html,/타인 습관/);assert.match(html,/체크 저장 중/);
  const input=overviewCheckbox(html,'mine','2026-09-22');assert.match(input,/\schecked(?:\s|>)/);assert.match(input,/aria-label="[^\"]*다시 누르면 취소/);
  assert.doesNotMatch(overviewCheckbox(html,'otherBook','2026-09-22'),/\schecked(?:\s|>)/);
  assert.match(html,/class="habit-overview-item home-habit"/);assert.match(html,/class="habit-overview-open home-habit-heading"/);assert.match(html,/home-habit-name">내 습관/);assert.doesNotMatch(html,/home-habit-book/);
  assert.match(html,/<b>목표<\/b> <span>15분 &lt;집중&gt;/);assert.match(html,/<b>시간<\/b> <span>21:00 &quot;밤&quot;/);assert.match(html,/<b>장소<\/b> <span>거실 &amp; 소파/);
  assert.match(html,/<b>목표<\/b> <span>하루 한 번 실천하기/);assert.match(html,/<b>시간<\/b> <span>미설정/);assert.match(html,/<b>장소<\/b> <span>미설정/);
  assert.doesNotMatch(html,/<a class="habit-overview-item"/);
  assert.deepEqual(c.STATE.habits.mine.checkedDates,[]);
  c.habitSaveIntents.mine['2026-09-22'].status='error';assert.match(c.habitOverviewBodyHtml(),/저장하지 못한 체크/);
});
test('overview book titles follow reading habits and never reveal foreign, deleted or unavailable archive books',()=>{
  const c=cardHarness(),snapshot={status:'ready',rows:[archiveRow({book:{title:'<선택한 책> & 기록',deleted:false,readingSessions:[]}})]};
  Object.assign(c,{SESSION:{userId:'owner'},memberLoadState:{habits:'ready'},habitWithPendingChecks:habit=>habit,habitArchiveSnapshot:()=>snapshot,GrowellReadingHabits:readingHabits,bookById:()=>({title:'모임 책 <제목>'})});
  const habit={id:'one',userId:'owner',bookId:'emotion',name:'독서',startDate:'2026-09-01',checkedDates:[]};
  function render(extra={}){c.STATE={habits:{one:{...habit,...extra}}};return c.habitOverviewBodyHtml();}
  assert.match(render(),/home-habit-book[^>]*>모임 책 &lt;제목&gt;/);assert.doesNotMatch(render({name:'산책'}),/home-habit-book/);
  const avoid=render({behaviorType:'avoid',readingGoal:readingGoal()});assert.doesNotMatch(avoid,/home-habit-book/);assert.match(avoid,/<b>목표<\/b> <span>하루 한 번 절제하기/);
  assert.match(render({name:'매일 읽기',readingGoal:readingGoal()}),/home-habit-book[^>]*>&lt;선택한 책&gt; &amp; 기록/);
  snapshot.rows[0].entry.userId='someone-else';assert.doesNotMatch(render({readingGoal:readingGoal()}),/home-habit-book|선택한 책|모임 책/);
  snapshot.rows[0].entry.userId='owner';snapshot.rows[0].book.deleted=true;assert.doesNotMatch(render({readingGoal:readingGoal()}),/home-habit-book|선택한 책|모임 책/);
  snapshot.rows[0].book.deleted=false;for(const status of ['loading','error']){snapshot.status=status;assert.doesNotMatch(render({readingGoal:readingGoal()}),/home-habit-book|선택한 책|모임 책/);}
});

test('overview loading failures never turn stale habits into a current-state summary',()=>{
  const c=cardHarness();c.SESSION={userId:'owner'};c.memberLoadState={habits:'error'};c.memberDataStatusHtml=()=>'<p>연결을 확인해주세요.</p>';
  c.STATE={habits:{stale:{userId:'owner',name:'오래된 습관'}}};
  const html=c.habitOverviewBodyHtml();assert.match(html,/전체 습관 한눈에/);assert.match(html,/연결을 확인/);assert.doesNotMatch(html,/오늘 성공|오래된 습관|오늘 남음/);
  c.memberLoadState.habits='loading';assert.equal(c.myHabitOverviewItems().length,0);
});
test('overview keeps habit order and its save-status slot through rapid undo, recheck and asynchronous saves',async()=>{
  const c=cardHarness(),today='2026-09-22',saves=[];
  const habit=(id,createdAt,extra={})=>({id,createdAt,userId:'owner',bookId:'emotion',name:id,startDate:'2026-09-01',checkedDates:[],...extra});
  Object.assign(c,{SESSION:{userId:'owner'},memberLoadState:{habits:'ready'},habitSaveVersion:0,saveSessionEpoch:0,
    bookById:()=>({title:'테스트 책'}),STATE:{habits:{
      upcoming:habit('upcoming',1,{startDate:'2026-10-01'}),
      second:habit('second',20),
      ended:habit('ended',0,{endDate:'2026-09-20'}),
      first:habit('first',10,{checkedDates:[today]}),
      stranger:habit('stranger',2,{userId:'someone-else'})
    }},
    saveState(mutate,options){return new Promise(resolve=>saves.push({mutate,options,resolve}));}
  });
  const begin=source.indexOf('function habitWithPendingChecks(');
  vm.runInContext(source.slice(begin,source.indexOf('/* ---------------- 나의 공간: 독서 진행률',begin)),c);
  const panel={innerHTML:c.habitOverviewBodyHtml()};
  c.document={activeElement:null,querySelectorAll:selector=>selector==='[data-habit-overview]'?[panel]:[]};
  function verify(firstChecked,secondChecked,status){
    const html=panel.innerHTML;
    assert.deepEqual(Array.from(html.matchAll(/data-habit-overview-id="([^"]+)"/g),match=>match[1]),['first','second','upcoming','ended']);
    assert.equal(/\schecked(?:\s|>)/.test(overviewCheckbox(html,'first',today)),firstChecked);
    assert.equal(/\schecked(?:\s|>)/.test(overviewCheckbox(html,'second',today)),secondChecked);
    assert.match(overviewCheckbox(html,'upcoming',today),/\sdisabled(?:\s|>)/);assert.match(overviewCheckbox(html,'ended',today),/\sdisabled(?:\s|>)/);
    const saveSlot=html.match(/<p class="habit-overview-save"[^>]*>([\s\S]*?)<\/p>/);
    assert.ok(saveSlot,'idle, pending and completed views retain the same save-status slot');
    if(status==='saving')assert.match(saveSlot[1],/체크 저장 중/);
    else if(status==='error')assert.match(saveSlot[1],/저장하지 못한 체크/);
    else assert.doesNotMatch(saveSlot[1],/체크 저장 중|저장하지 못한 체크/);
  }
  function finish(index,ok=true){
    const saved=saves[index];
    if(ok){saved.mutate(c.STATE);saved.options.onSuccess();}else saved.options.onFailure();
    saved.resolve(ok);
  }
  verify(true,false,'idle');
  const undo=c.queueHabitCheck('first',today,false);verify(false,false,'saving');
  const recheck=c.queueHabitCheck('first',today,true);verify(true,false,'saving');
  finish(0);await undo;verify(true,false,'saving');
  finish(1);await recheck;verify(true,false,'idle');
  const checkSecond=c.queueHabitCheck('second',today,true);verify(true,true,'saving');
  finish(2);await checkSecond;verify(true,true,'idle');
  const undoSecond=c.queueHabitCheck('second',today,false);verify(true,false,'saving');
  finish(3,false);await undoSecond;verify(true,false,'error');
  const retry=c.retryHabitChecks('second');verify(true,false,'saving');
  finish(4);await retry;verify(true,false,'idle');
  assert.deepEqual(Array.from(c.STATE.habits.first.checkedDates),[today]);
  assert.deepEqual(Array.from(c.STATE.habits.second.checkedDates),[]);
});

test('each record button opens its own habit and selected popup without bubbling into progress details',()=>{
  const opened=[],buttons=['h1','h2'].flatMap(id=>['week','month'].map(view=>({
    getAttribute:attr=>attr==='data-habit-record'?id:view,addEventListener(type,fn){this.click=fn;}
  })));
  const card={addEventListener(type,fn){this.click=fn;},getAttribute:()=> 'h2'};
  const c={app:{querySelectorAll:selector=>selector==='[data-habit-record]'?buttons:[card]},openHabitProgress:(...args)=>opened.push(args)};
  vm.createContext(c);
  const begin=source.indexOf("  app.querySelectorAll('[data-habit-record]').forEach");
  vm.runInContext(source.slice(begin,source.indexOf('  var openHabitBtn',begin)),c);
  for(const button of buttons){
    const event={stopped:false,stopPropagation(){this.stopped=true;},target:{closest:()=>button}};
    button.click(event);if(!event.stopped)card.click(event);assert.equal(event.stopped,true);
  }
  card.click({target:{closest:()=>null}});
  card.click({target:{closest:()=>buttons[0]}});
  assert.deepEqual(opened,[['h1','card','week'],['h1','card','month'],['h2','card','week'],['h2','card','month'],['h2']]);
});

test('checking and undoing a replaced popup day icon stops propagation and binds only once',()=>{
  let dayClick,checks=0,bindings=0;
  const button={getAttribute:key=>key==='data-habit-day'?'h2|2026-09-22':null,hasAttribute:()=>false,addEventListener(type,fn){dayClick=fn;bindings++;}};
  const c={app:{querySelectorAll:()=>[button]},toggleHabitDate(id,date){assert.equal(id,'h2');assert.equal(date,'2026-09-22');checks++;}};
  vm.createContext(c);
  const begin=source.indexOf('function bindHabitDayEvents(');
  vm.runInContext(source.slice(begin,source.indexOf('function openHabitProgress(',begin)),c);
  c.bindHabitDayEvents(c.app);c.bindHabitDayEvents(c.app);
  for(let attempt=0;attempt<2;attempt++){
    const event={stopped:false,target:{closest:()=>null},stopPropagation(){this.stopped=true;}};
    dayClick(event);assert.equal(event.stopped,true);
  }
  assert.equal(checks,2);assert.equal(bindings,1);
});

test('overview delegation keeps success reversible after rows refresh and routes other clicks to details',()=>{
  const c=cardHarness(),events=[],bindings=[];
  const panel={_habitOverviewBound:false,contains:()=>true,addEventListener(type,fn){bindings.push(fn);}};
  c.toggleHabitDate=(id,date)=>events.push(['toggle',id,date]);c.openHabitProgress=(...args)=>events.push(['detail',...args]);
  const root={querySelectorAll:()=>[panel]};c.bindHabitOverviewEvents(root);c.bindHabitOverviewEvents(root);
  assert.equal(bindings.length,1);
  const eventFor=(kind,disabled=false)=>({stopped:false,stopPropagation(){this.stopped=true;},target:{closest(selector){
    if(selector==='[data-habit-overview-day]'&&kind==='day')return {disabled,getAttribute:()=> 'h1|2026-09-22'};
    if(selector==='[data-habit-overview-open]'&&kind==='detail')return {getAttribute:()=> 'other-book'};
    if(selector==='[data-habit-overview-id]'&&kind==='space')return {getAttribute:()=> 'other-book'};
    return null;
  }}});
  bindings[0](eventFor('day'));bindings[0](eventFor('day'));bindings[0](eventFor('day',true));
  bindings[0](eventFor('detail'));bindings[0](eventFor('space'));
  assert.deepEqual(events,[['toggle','h1','2026-09-22'],['toggle','h1','2026-09-22'],['detail','other-book','overview'],['detail','other-book','overview']]);
});

test('overview detail opens another book habit without exposing another member records',()=>{
  const c=cardHarness();c.SESSION={userId:'owner'};c.memberLoadState={habits:'ready'};c.habitEditingId=null;c.habitFormOpenFor=null;c.habitHistoryOpenFor='other-book';
  c.myHabits=()=>[];c.myHabitOverviewItems=()=>[{id:'other-book',userId:'owner',bookId:'action',name:'다른 책 습관'}];
  c.habitOverviewHtml=()=>'';c.habitHistoryModalHtml=habit=>'<dialog>'+habit.name+'</dialog>';
  const begin=source.indexOf('function habitsSectionHtml(');
  vm.runInContext(source.slice(begin,source.indexOf('function habitTabHtml(',begin)),c);
  assert.match(c.habitsSectionHtml({id:'emotion'}),/<dialog>다른 책 습관<\/dialog>/);
  c.habitHistoryOpenFor='stranger';assert.doesNotMatch(c.habitsSectionHtml({id:'emotion'}),/<dialog>/);assert.equal(c.habitHistoryOpenFor,null);
});

function popupHarness(){
  const c=cardHarness();
  Object.assign(c,{SESSION:{userId:'owner'},habitHistoryOpenFor:null,habitProgressReturnTarget:null,habitProgressReturnPosition:null,
    STATE:{habits:{
      h1:{id:'h1',userId:'owner',name:'책 읽기',startDate:'2026-09-01',checkedDates:['2026-09-21']},
      h2:{id:'h2',userId:'owner',name:'화면 쉬기',behaviorType:'avoid',startDate:'2026-09-01',checkedDates:[]},
      stranger:{id:'stranger',userId:'someone-else',name:'다른 회원 기록',startDate:'2026-09-01',checkedDates:[]}
    }}});
  vm.runInContext(source.slice(source.indexOf('function habitWithPendingChecks('),source.indexOf('function queueHabitCheck(')),c);
  vm.runInContext(source.slice(source.indexOf('function parseYmd('),source.indexOf('/* ---------------- 습관 완료 카드 이미지 생성')),c);
  const listeners={},entries=[{url:'https://example.test/#/book/emotion/mine',state:null}],pending=[];
  let index=0;
  const emit=(type,event)=>(listeners[type]||[]).slice().forEach(fn=>fn(event));
  const browser={location:{href:entries[0].url},scrollX:0,scrollY:0,
    addEventListener(type,fn){(listeners[type]||=[]).push(fn);},
    scrollTo(position){this.scrollX=position.left;this.scrollY=position.top;},
    history:{
      get state(){return entries[index].state;},
      replaceState(state,unused,url){entries[index]={state,url};browser.location.href=url;},
      pushState(state,unused,url){entries.splice(index+1);entries.push({state,url});index++;browser.location.href=url;},
      go(delta){pending.push(delta);}
    }
  };
  c.window=browser;c.location=browser.location;c.document={activeElement:null};
  c.GrowellPopupHistory=require('../popupHistory.js')(browser);
  function navigate(hash){
    browser.history.pushState(null,'','https://example.test/'+hash);
    emit('popstate',{state:null});emit('hashchange',{});
  }
  function back(){
    browser.history.go(-1);let traversals=0;
    while(pending.length){
      assert.ok(++traversals<20,'history traversal must settle');
      const next=index+pending.shift();if(next<0||next>=entries.length)continue;
      const previous=browser.location.href;index=next;browser.location.href=entries[index].url;
      emit('popstate',{state:entries[index].state});if(previous!==browser.location.href)emit('hashchange',{});
    }
  }
  const buttons=['h1','h2'].flatMap(id=>['week','month'].map(view=>({
    getAttribute:attr=>attr==='data-habit-record'?id:attr==='data-habit-record-view'?view:null,
    hasAttribute:attr=>attr==='data-habit-record',
    focus(options){assert.equal(options.preventScroll,true);c.document.activeElement=this;}
  })));
  const modal={focus(options){assert.equal(options.preventScroll,true);c.document.activeElement=this;}};
  let html='',renders=0;
  c.app={querySelector:selector=>selector==='.habit-hist-modal'&&c.habitHistoryOpenFor?modal:null,
    querySelectorAll:selector=>selector==='[data-habit-record]'?buttons:[]};
  const bindingStart=source.indexOf("  if(typeof GrowellPopupHistory!=='undefined'){",source.indexOf('  var histNext ='));
  const binding=source.slice(bindingStart,source.indexOf('  /* 나의 공간 독서 진행률',bindingStart));
  c.render=()=>{
    renders++;html=c.habitHistoryOpenFor?c.habitHistoryModalHtml(c.habitWithPendingChecks(c.STATE.habits[c.habitHistoryOpenFor])):'';
    vm.runInContext(binding,c);
  };
  navigate('#/book/emotion/habit');
  return {c,browser,buttons,modal,entries,back,navigate,get html(){return html;},get renders(){return renders;}};
}

function composerHarness(){
  const h=popupHarness(),c=h.c,dialogs=[],saves=[],toasts=[];
  Object.assign(c,{habitComposerDialog:null,habitNameDialog:null,habitBookDialog:null,habitValueGuideDialog:null,habitValueSummaryDialog:null,habitFormOpenFor:null,habitEditingId:null,saveSessionEpoch:1,memberLoadState:{habits:'ready',readingLogs:'ready',readingMeta:'ready'},
    GrowellReadingHabits:readingHabits,GrowellArchiveDomain:require('../archiveDomain.js'),GrowellHabitSuggestions:require('../habitSuggestions.js'),GrowellArchive:{readingSnapshot:()=>({status:'ready',rows:[archiveRow()]})},readingDataReady:()=>true,
    bookById:id=>({id,title:'모임 책'}),showToast:(...args)=>toasts.push(args),uid:()=> 'new-habit',saveState:(mutate,options)=>saves.push({mutate,options})});
  c.document.body={appendChild:node=>{node.isConnected=true;dialogs.push(node);}};
  c.document.querySelector=()=>null;c.document.querySelectorAll=()=>[];c.document.getElementById=()=>null;
  c.document.createElement=tag=>{
    assert.equal(tag,'dialog');const fields={},listeners={};let nodes=[],html='';
    const decode=value=>String(value).replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
    function matches(node,selector){
      if(selector.includes(' ')){const parts=selector.split(/\s+/),last=parts.pop();if(!matches(node,last))return false;for(let parent=node.parentNode;parent;parent=parent.parentNode)if(matches(parent,parts.join(' ')))return true;return false;}
      if(selector.endsWith(':checked'))return node.checked&&matches(node,selector.slice(0,-8));
      if(selector.startsWith('#'))return node.attrs.id===selector.slice(1);
      if(selector.startsWith('.'))return (node.attrs.class||'').split(/\s+/).includes(selector.slice(1));
      const attrs=Array.from(selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g));
      if(attrs.length)return attrs.every(([,key,value])=>Object.hasOwn(node.attrs,key)&&(value===undefined||node.attrs[key]===value));
      return node.tagName===selector.toUpperCase();
    }
    const node={fields,listeners,isConnected:false,open:false,setAttribute(){},
      querySelector:selector=>nodes.find(item=>matches(item,selector))||null,
      querySelectorAll:selector=>nodes.filter(item=>matches(item,selector)),addEventListener:(event,callback)=>{listeners[event]=callback;},removeEventListener:(event,callback)=>{if(listeners[event]===callback)delete listeners[event];},contains:item=>nodes.includes(item),
      showModal(){this.open=true;c.document.activeElement=this;},close(){this.open=false;},remove(){this.isConnected=false;}};
    function parse(value){
      const parsed=[],scopes=[],stack=[],ends=new Map();
      for(const token of value.matchAll(/<(\/)?([a-z][a-z0-9-]*)\b[^>]*>/gi)){
        const tag=token[2].toLowerCase();
        if(token[1]){for(let i=stack.length-1;i>=0;i--)if(stack[i].tag===tag){ends.set(stack[i].start,token.index);stack.length=i;break;}}
        else if(!['input','img','br','hr','meta','link','source','area','base','col','embed','param','track','wbr','path'].includes(tag)&&!token[0].endsWith('/>'))stack.push({tag,start:token.index});
      }
      for(const match of value.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)){
        const [,name,raw]=match;
        const attrs={};for(const [,key,v1,v2] of raw.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g))attrs[key]=decode(v1??v2??'');
        const item={attrs,tagName:name.toUpperCase(),value:attrs.value||'',checked:Object.hasOwn(attrs,'checked'),hidden:Object.hasOwn(attrs,'hidden'),disabled:Object.hasOwn(attrs,'disabled'),readOnly:Object.hasOwn(attrs,'readonly'),innerHTML:'',textContent:'',
          getAttribute:key=>Object.hasOwn(attrs,key)?attrs[key]:null,setAttribute(key,val){attrs[key]=String(val);},hasAttribute:key=>Object.hasOwn(attrs,key),removeAttribute(key){delete attrs[key];},
          focus(){if(this.isConnected)c.document.activeElement=this;},select(){this.selected=true;},addEventListener(event,fn){this['on'+event]=fn;},insertAdjacentHTML(where,value){this.innerHTML+=value;},
          click(){if(this.disabled)return;const event={target:this,preventDefault(){}};if(this.attrs.type==='radio'){nodes.filter(other=>other.attrs.name===this.attrs.name).forEach(other=>{other.checked=false;});this.checked=true;if(this.onchange)this.onchange(event);}else if(this.onclick)this.onclick(event);if(listeners.click)listeners.click(event);}};
        item.dataset=Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
        Object.defineProperty(item,'placeholder',{get:()=>attrs.placeholder||'',set:value=>{attrs.placeholder=String(value);}});
        let content='',contentNodes=[];
        Object.defineProperty(item,'isConnected',{get:()=>node.isConnected&&nodes.includes(item)});
        item.querySelector=selector=>contentNodes.find(child=>matches(child,selector))||null;item.querySelectorAll=selector=>contentNodes.filter(child=>matches(child,selector));
        Object.defineProperty(item,'innerHTML',{get:()=>content,set:value=>{
          content=value;const old=new Set(contentNodes);nodes=nodes.filter(item=>!old.has(item));
          contentNodes=parse(value);nodes.push(...contentNodes);
        }});
        if(name.toLowerCase()==='select'){
          const fragment=value.slice(match.index+match[0].length,value.indexOf('</select>',match.index)),options=Array.from(fragment.matchAll(/<option\b([^>]*)>/gi)),selected=options.find(option=>/\bselected(?:\s|$)/.test(option[1]))||options[0],optionValue=selected&&selected[1].match(/\bvalue=(?:"([^"]*)"|'([^']*)')/);
          item.value=optionValue?decode(optionValue[1]??optionValue[2]):'';
        }
        if(ends.has(match.index)){const end=ends.get(match.index);content=value.slice(match.index+match[0].length,end);scopes.push({item,start:match.index,end,attach:children=>{contentNodes=children;}});}
        item._markupOffset=match.index;
        parsed.push(item);if(attrs.id)fields['#'+attrs.id]=item;
      }
      for(const scope of scopes)scope.attach(parsed.filter(item=>item._markupOffset>scope.start&&item._markupOffset<scope.end));
      for(const item of parsed){const scope=scopes.filter(scope=>item._markupOffset>scope.start&&item._markupOffset<scope.end).at(-1);item.parentNode=scope?scope.item:null;}
      return parsed;
    }
    Object.defineProperty(node,'innerHTML',{get:()=>html,set:value=>{
      html=value;for(const key of Object.keys(fields))delete fields[key];nodes=parse(value);
    }});
    return node;
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../habitGuide.js'),'utf8'),c);
  vm.runInContext(source.slice(source.indexOf('function habitFormHtml('),source.indexOf('function habitsSectionHtml(')),c);
  vm.runInContext(source.slice(source.indexOf('function validateHabitPeriod('),source.indexOf('function deleteHabit(')),c);
  const trigger={isConnected:true,focus(options){assert.equal(options.preventScroll,true);c.document.activeElement=this;}};
  return {...h,c,dialogs,saves,toasts,trigger};
}

function openComposerGuide(h){
  h.c.habitComposerDialog.querySelector('#habit-name-picker').click();
  const picker=h.c.habitNameDialog,trigger=picker.querySelector('#habit-name-guide-open');trigger.click();
  return {guide:h.c.habitValueGuideDialog,picker,trigger};
}

test('native composer Back and its back button close only the dialog and restore the trigger and page position',()=>{
  for(const closing of ['browser','button']){
    const h=composerHarness(),c=h.c;h.browser.scrollY=825;c.document.activeElement=h.trigger;
    c.openHabitComposer('emotion',null,h.trigger);const dialog=c.habitComposerDialog,before=JSON.stringify(c.STATE);
    assert.equal(dialog.open,true);assert.match(dialog.querySelector('#habit-form-title').innerHTML,/새 습관 만들기/);
    assert.equal(dialog.querySelector('#habit-value-guide-open'),null);assert.equal(dialog.querySelector('[data-habit-reading-fields]').hidden,true);assert.equal(dialog.querySelector('#habit-is-reading').getAttribute('aria-controls'),'habit-reading-fields');assert.equal(dialog.querySelector('#habit-reading-fields'),dialog.querySelector('[data-habit-reading-fields]'));assert.equal(dialog.querySelector('[data-habit-reading-status]').textContent,'');
    dialog.fields['#habit-name'].value='작성 중';if(closing==='browser')h.back();else dialog.querySelector('#habit-compose-back').click();
    assert.equal(c.habitComposerDialog,null);assert.equal(dialog.open,false);assert.equal(dialog.isConnected,false);
    assert.equal(c.document.activeElement,h.trigger);assert.equal(h.browser.scrollY,825);assert.match(h.browser.location.href,/#\/book\/emotion\/habit$/);
    assert.equal(h.saves.length,0,'closing does not submit the incomplete habit');assert.equal(JSON.stringify(c.STATE),before);
    h.back();assert.match(h.browser.location.href,/#\/book\/emotion\/mine$/);
  }
});

test('changing the habit kind updates examples without replacing inputs or overwriting the typed draft',()=>{
  const h=composerHarness(),c=h.c;c.openHabitComposer('emotion',null,h.trigger);const dialog=c.habitComposerDialog,before=JSON.stringify(c.STATE);
  const draft={name:'나만의 약속',place:'내 방',time:'저녁 8시',goal:'주중 15분','start-date':'2026-09-21','end-date':'2026-10-20'};
  const fields=Object.fromEntries(Object.keys(draft).map(key=>[key,dialog.querySelector('#habit-'+key)]));
  for(const [key,value] of Object.entries(draft))fields[key].value=value;
  const doingPlaceholders=Object.fromEntries(['name','place','time','goal'].map(key=>[key,fields[key].placeholder]));
  for(const kind of ['avoid','do','avoid','do']){
    const radio=dialog.querySelector('[name="habit-behavior-type"][value="'+kind+'"]');radio.focus();radio.click();
    assert.equal(c.habitComposerDialog,dialog);assert.equal(c.document.activeElement,radio);
    for(const [key,value] of Object.entries(draft)){assert.equal(dialog.querySelector('#habit-'+key),fields[key]);assert.equal(fields[key].value,value);}
    if(kind==='avoid'){
      assert.match(fields.name.placeholder,/게임/);assert.match(fields.goal.placeholder,/게임/);
      assert.notEqual(fields.name.placeholder,doingPlaceholders.name);assert.notEqual(fields.goal.placeholder,doingPlaceholders.goal);
    }else for(const key of ['name','place','time','goal'])assert.equal(fields[key].placeholder,doingPlaceholders[key]);
    assert.equal(h.saves.length,0);assert.equal(JSON.stringify(c.STATE),before);
  }
});

test('switching away from doing hides and clears reading controls instead of saving a stale reading connection',()=>{
  const h=composerHarness(),c=h.c;c.openHabitComposer('emotion',null,h.trigger);
  const dialog=c.habitComposerDialog,reading=dialog.querySelector('#habit-is-reading'),name=dialog.querySelector('#habit-name');
  name.value='아침 산책';reading.checked=true;reading.onchange();
  assert.equal(name.value,'독서');assert.equal(name.readOnly,false);
  assert.equal(dialog.querySelector('[data-habit-reading-fields]').hidden,false);assert.equal(dialog.querySelector('[data-habit-text-goal]').hidden,true);
  dialog.querySelector('#habit-reading-book').value='archive-one';
  dialog.querySelector('[name="habit-behavior-type"][value="avoid"]').click();
  assert.equal(reading.checked,false);assert.equal(reading.disabled,true);assert.equal(dialog.querySelector('.habit-reading-settings').hidden,true);
  assert.equal(dialog.querySelector('[data-habit-reading-fields]').hidden,true);assert.equal(dialog.querySelector('[data-habit-text-goal]').hidden,false);
  assert.notEqual(name.value,'독서');dialog.querySelector('#habit-goal').value='잠들기 전 화면 안 보기';
  dialog.querySelector('#btn-habit-submit').click();assert.equal(h.saves.length,1);
  const state={habits:{}};h.saves[0].mutate(state);assert.equal(state.habits['new-habit'].behaviorType,'avoid');assert.equal(state.habits['new-habit'].readingGoal,null);assert.equal(state.habits['new-habit'].goal,'잠들기 전 화면 안 보기');
  dialog.querySelector('[name="habit-behavior-type"][value="do"]').click();
  assert.equal(reading.disabled,false);assert.equal(reading.checked,false);assert.equal(dialog.querySelector('.habit-reading-settings').hidden,false);
});

test('reading composer saves the automatic name, selected book and slider target rather than hidden free-text goal',()=>{
  const h=composerHarness(),c=h.c;c.openHabitComposer('emotion',null,h.trigger);const dialog=c.habitComposerDialog;
  const reading=dialog.querySelector('#habit-is-reading');dialog.querySelector('#habit-name').value='다른 이름';reading.checked=true;reading.onchange();
  const select=dialog.querySelector('#habit-reading-book'),slider=dialog.querySelector('#habit-reading-pages');select.value='archive-one';select.onchange();slider.value='23';slider.oninput();
  assert.equal(dialog.querySelector('#habit-reading-pages-value').textContent,'23쪽');assert.equal(dialog.querySelector('#habit-name').value,'독서');
  dialog.querySelector('#habit-goal').value='이전 일반 목표';dialog.querySelector('#btn-habit-submit').click();assert.equal(h.saves.length,1);
  const state={habits:{}};h.saves[0].mutate(state);const saved=state.habits['new-habit'];assert.equal(saved.name,'독서');assert.equal(saved.behaviorType,'do');assert.equal(saved.goal,'하루 23쪽 읽기');assert.deepEqual({...saved.readingGoal},readingGoal({targetPages:23}));
  slider.value='0';dialog.querySelector('#btn-habit-submit').click();assert.equal(h.saves.length,1);
  c.GrowellArchive.readingSnapshot=()=>({status:'ready',rows:[]});slider.value='20';dialog.querySelector('#btn-habit-submit').click();assert.equal(h.saves.length,1);assert.equal(c.document.activeElement,dialog.querySelector('#habit-reading-book-open'));
});

test('editing an old avoiding habit never preselects its incompatible stored reading goal',()=>{
  const h=composerHarness(),c=h.c;c.STATE.habits.h2.readingGoal=readingGoal();c.openHabitComposer('emotion','h2',h.trigger);
  const dialog=c.habitComposerDialog,reading=dialog.querySelector('#habit-is-reading');
  assert.equal(reading.checked,false);assert.equal(reading.disabled,true);assert.equal(dialog.querySelector('.habit-reading-settings').hidden,true);assert.equal(dialog.querySelector('#habit-name').value,'화면 쉬기');
  dialog.querySelector('#btn-habit-submit').click();assert.equal(h.saves.length,1);h.saves[0].mutate(c.STATE);
  assert.equal(c.STATE.habits.h2.behaviorType,'avoid');assert.equal(c.STATE.habits.h2.readingGoal,null);assert.equal(c.STATE.habits.h2.name,'화면 쉬기');
});

test('habit name picker offers seven values independently of the book area and preserves the draft when applying a keyword',()=>{
  for(const kind of ['do','avoid']){
    const h=composerHarness(),c=h.c;c.openHabitComposer('thought',null,h.trigger);const parent=c.habitComposerDialog;
    const fields={goal:'미리 쓴 작은 목표',place:'집',time:'오후 8시','start-date':'2026-09-21','end-date':'2026-10-20'};for(const [key,value] of Object.entries(fields))parent.querySelector('#habit-'+key).value=value;
    parent.querySelector('[name="habit-behavior-type"][value="'+kind+'"]').click();parent.querySelector('#habit-name-picker').click();const picker=c.habitNameDialog;
    assert.equal(picker.open,true);assert.equal(parent.open,true);assert.equal(picker.querySelector('[data-habit-name-category="faith"]').getAttribute('aria-pressed'),'true');
    assert.deepEqual(picker.querySelectorAll('[data-habit-name-category]').map(button=>button.getAttribute('data-habit-name-category')),['faith','love','virtue','wisdom','emotion','beauty','body']);
    const customInput=picker.querySelector('#habit-name-custom-input');assert.ok(customInput);assert.equal(customInput.hidden,false);assert.ok(picker.querySelector('#habit-name-custom-apply'));
    for(const category of ['faith','love','virtue','wisdom','emotion','beauty','body']){
      picker.querySelector('[data-habit-name-category="'+category+'"]').click();
      assert.equal(picker.querySelectorAll('[data-habit-name-option]').length,c.GrowellHabitSuggestions.suggestions(kind,category).length);
      assert.equal(picker.querySelector('#habit-name-custom-input'),customInput,'value tabs leave direct input mounted');
    }
    picker.querySelector('[data-habit-name-category="body"]').click();picker.querySelector('[data-habit-name-option="2"]').click();
    const expected=c.GrowellHabitSuggestions.suggestions(kind,'body')[2];
    assert.equal(c.habitNameDialog,null);assert.equal(picker.isConnected,false);assert.equal(parent.open,true);assert.equal(parent.querySelector('#habit-name').value,expected);assert.equal(parent.querySelector('#habit-name').readOnly,false);assert.equal(parent.querySelector('#habit-value-select').value,'body');assert.equal(h.saves.length,0);for(const [key,value] of Object.entries(fields))assert.equal(parent.querySelector('#habit-'+key).value,value);
    parent.querySelector('#habit-name-picker').click();assert.equal(c.habitNameDialog.querySelector('[data-habit-name-category="body"]').getAttribute('aria-pressed'),'true');c.closeHabitNamePicker();
    parent.querySelector('#btn-habit-submit').click();assert.equal(h.saves.length,1);const state={habits:{}};h.saves[0].mutate(state);assert.equal(state.habits['new-habit'].name,expected);assert.equal(state.habits['new-habit'].behaviorType,kind);assert.equal(state.habits['new-habit'].readingGoal,null);assert.equal(state.habits['new-habit'].bookId,'thought');assert.equal(state.habits['new-habit'].goal,fields.goal);assert.equal(state.habits['new-habit'].valueId,'body');
  }
});

test('choosing the wisdom reading keyword activates reading settings while typing that name remains a plain habit',()=>{
  for(const mode of ['keyword','custom']){
    const h=composerHarness(),c=h.c;c.openHabitComposer('body',null,h.trigger);const parent=c.habitComposerDialog;
    parent.querySelector('#habit-goal').value='기존 수기 목표';parent.querySelector('#habit-place').value='책상';parent.querySelector('#habit-name-picker').click();const picker=c.habitNameDialog;
    if(mode==='keyword'){
      picker.querySelector('[data-habit-name-category="wisdom"]').click();const index=c.GrowellHabitSuggestions.suggestions('do','wisdom').indexOf('독서');assert.ok(index>=0);picker.querySelector('[data-habit-name-option="'+index+'"]').click();
    }else{
      const input=picker.querySelector('#habit-name-custom-input');input.value='독서';input.oninput();picker.querySelector('#habit-name-custom-apply').click();
    }
    assert.equal(c.habitNameDialog,null);assert.equal(parent.querySelector('#habit-name').value,'독서');assert.equal(parent.querySelector('#habit-is-reading').checked,mode==='keyword');assert.equal(parent.querySelector('#habit-name').readOnly,false);assert.equal(parent.querySelector('[data-habit-reading-fields]').hidden,mode!=='keyword');assert.equal(parent.querySelector('[data-habit-text-goal]').hidden,mode==='keyword');assert.equal(parent.querySelector('#habit-goal').value,'기존 수기 목표');assert.equal(parent.querySelector('#habit-place').value,'책상');assert.equal(parent.querySelector('#habit-value-guide-open'),null);assert.equal(h.saves.length,0);
    if(mode==='keyword'){parent.querySelector('#btn-habit-submit').click();assert.equal(h.saves.length,0,'a reading keyword still requires an owned book');const select=parent.querySelector('#habit-reading-book'),slider=parent.querySelector('#habit-reading-pages');select.value='archive-one';select.onchange();slider.value='17';slider.oninput();}
    parent.querySelector('#btn-habit-submit').click();assert.equal(h.saves.length,1);const state={habits:{}};h.saves[0].mutate(state);const saved=state.habits['new-habit'];assert.equal(saved.name,'독서');assert.equal(saved.bookId,'body');assert.equal(saved.valueId,'wisdom');assert.equal(saved.goal,mode==='keyword'?'하루 17쪽 읽기':'기존 수기 목표');assert.deepEqual(saved.readingGoal?{...saved.readingGoal}:null,mode==='keyword'?readingGoal({targetPages:17}):null);
  }
});

test('custom habit names preserve their draft across value tabs, reject empty input and wait for Korean composition',()=>{
  const h=composerHarness(),c=h.c;c.openHabitComposer('emotion',null,h.trigger);const parent=c.habitComposerDialog;
  parent.querySelector('#habit-name').value='이전 이름';parent.querySelector('#habit-name-picker').click();const picker=c.habitNameDialog;
  assert.equal(picker.querySelectorAll('[data-habit-custom-value]').length,0);
  let input=picker.querySelector('#habit-name-custom-input');assert.equal(input.value,'이전 이름');input.value='  ';input.oninput();picker.querySelector('#habit-name-custom-apply').click();
  assert.equal(c.habitNameDialog,picker);assert.match(picker.querySelector('[data-habit-name-error]').textContent,/입력해주세요/);assert.equal(parent.querySelector('#habit-name').value,'이전 이름');
  input.value='  나만의 좋은 습관  ';input.oninput();const originalInput=input;picker.querySelector('[data-habit-name-category="body"]').click();picker.querySelector('[data-habit-name-category="faith"]').click();picker.querySelector('[data-habit-name-category="body"]').click();input=picker.querySelector('#habit-name-custom-input');assert.equal(input,originalInput);assert.equal(input.value,'  나만의 좋은 습관  ');assert.equal(picker.querySelectorAll('[data-habit-custom-value]').length,0);
  for(const event of [{key:'Enter',isComposing:true},{key:'Enter',keyCode:229}]){input.onkeydown({...event,preventDefault(){assert.fail('composition must continue');}});assert.equal(c.habitNameDialog,picker);}
  input.onkeydown({key:'Enter',isComposing:false,preventDefault(){}});assert.equal(c.habitNameDialog,null);assert.equal(parent.querySelector('#habit-name').value,'나만의 좋은 습관');assert.equal(c.document.activeElement,parent.querySelector('#habit-name'));
  parent.querySelector('#btn-habit-submit').click();const state={habits:{}};h.saves[0].mutate(state);assert.equal(state.habits['new-habit'].name,'나만의 좋은 습관');assert.equal(state.habits['new-habit'].valueId,'virtue');
});

test('custom names automatically receive a value and preserve the existing goal and latest saved checks',()=>{
  const h=composerHarness(),c=h.c;c.STATE.habits.h1.name='이전 습관';c.openHabitComposer('emotion','h1',h.trigger);const parent=c.habitComposerDialog;
  const value=parent.querySelector('#habit-value-select');assert.equal(value.value,'virtue');assert.equal(value.tagName,'INPUT');assert.equal(value.getAttribute('type'),'hidden');assert.equal(value.onchange,undefined);assert.equal(parent.querySelector('select'),null);assert.equal(parent.querySelector('[data-habit-selected-value]'),null);assert.doesNotMatch(parent.innerHTML,/습관의 가치/);
  parent.querySelector('#habit-goal').value='기존 목표';parent.querySelector('#habit-name-picker').click();const picker=c.habitNameDialog;picker.querySelector('[data-habit-name-category="faith"]').click();assert.equal(picker.querySelectorAll('[data-habit-custom-value]').length,0);
  const input=picker.querySelector('#habit-name-custom-input');input.value='새로운 내 습관';input.oninput();picker.querySelector('#habit-name-custom-apply').click();assert.equal(c.habitNameDialog,null);assert.equal(value.value,'virtue');assert.equal(parent.querySelector('#habit-name').value,'새로운 내 습관');assert.equal(parent.querySelector('#habit-goal').value,'기존 목표');
  parent.querySelector('#btn-habit-submit').click();assert.equal(h.saves.length,1);c.STATE.habits.h1.checkedDates.push('2026-09-22');h.saves[0].mutate(c.STATE);assert.equal(c.STATE.habits.h1.valueId,'virtue');assert.equal(c.STATE.habits.h1.goal,'기존 목표');assert.deepEqual(Array.from(c.STATE.habits.h1.checkedDates),['2026-09-21','2026-09-22']);
});

test('name editing waits for Korean composition and retains saved values only while the name is unchanged',()=>{
  const h=composerHarness(),c=h.c;c.openHabitComposer('emotion',null,h.trigger);const parent=c.habitComposerDialog,name=parent.querySelector('#habit-name'),value=parent.querySelector('#habit-value-select');
  name.value='아침 기도';name.oninput({isComposing:false});assert.equal(value.value,'faith');
  name.value='걷기';name.oninput({isComposing:true});assert.equal(value.value,'faith');name.oncompositionend();assert.equal(value.value,'body');
  name.value='기도와 운동';name.oninput({isComposing:false});assert.equal(value.value,'faith');
  name.value='공부';name.oninput({isComposing:false});assert.equal(value.value,'wisdom');name.value='내일 준비';name.oninput({isComposing:false});assert.equal(value.value,'virtue');assert.equal(h.saves.length,0);
  c.closeHabitComposer(false);c.STATE.habits.h1.name='기도';c.openHabitComposer('emotion','h1',h.trigger);assert.equal(c.habitComposerDialog.querySelector('#habit-value-select').value,'faith');assert.equal(c.STATE.habits.h1.valueId,undefined,'inference while opening never mutates the record');
  c.closeHabitComposer(false);c.STATE.habits.h1.valueId='love';c.openHabitComposer('emotion','h1',h.trigger);const savedName=c.habitComposerDialog.querySelector('#habit-name'),savedValue=c.habitComposerDialog.querySelector('#habit-value-select');assert.equal(savedValue.value,'love');savedName.oninput({isComposing:false});assert.equal(savedValue.value,'love');savedName.value='운동';savedName.oninput({isComposing:false});assert.equal(savedValue.value,'body');assert.equal(c.STATE.habits.h1.valueId,'love');assert.deepEqual(c.STATE.habits.h1.checkedDates,['2026-09-21']);
});

test('reading always uses wisdom and turning it off reclassifies the restored ordinary name',()=>{
  for(const [initial,expected] of [['',''],['기도','faith'],['걷기','body']]){
    const h=composerHarness(),c=h.c;c.openHabitComposer('emotion',null,h.trigger);const parent=c.habitComposerDialog,value=parent.querySelector('#habit-value-select'),name=parent.querySelector('#habit-name');name.value=initial;name.oninput({isComposing:false});const reading=parent.querySelector('#habit-is-reading');reading.checked=true;reading.onchange();assert.equal(value.value,'wisdom');assert.equal(name.value,'독서');reading.checked=false;reading.onchange();assert.equal(name.value,initial);assert.equal(value.value,expected);
    reading.checked=true;reading.onchange();name.value='마음 돌보기';name.oninput({isComposing:false});assert.equal(value.value,'wisdom');assert.equal(name.readOnly,false);reading.checked=false;reading.onchange();assert.equal(name.value,'마음 돌보기');assert.equal(value.value,'emotion');assert.equal(h.saves.length,0);
  }
});

function readingBookPickerHarness(editing=false){
  const h=composerHarness(),c=h.c;
  const row=(id,title,book={},entry={})=>({entry:{id,userId:'owner',...entry},book:{title,authors:['김하나'],totalPages:180,coverUrl:'',linkedBookId:'',deleted:false,readingSessions:[],...book}});
  const snapshot={status:'ready',rows:[
    row('archive-one','마음 <읽기> & 기록',{coverUrl:'https://example.test/cover.jpg?a=1&b=2'}),
    row('archive-two','오늘의 습관',{authors:['박곰희'],coverUrl:'javascript:alert(1)',totalPages:240}),
    row('foreign','다른 회원의 비밀',{}, {userId:'foreign'}),
    row('deleted','휴지통 책',{deleted:true}),{entry:null,book:null}
  ]};
  c.GrowellArchive.readingSnapshot=()=>snapshot;
  if(editing)c.STATE.habits.h1={...c.STATE.habits.h1,bookId:'emotion',readingGoal:readingGoal(),valueId:'faith'};
  c.openHabitComposer('emotion',editing?'h1':null,h.trigger);
  const parent=c.habitComposerDialog,reading=parent.querySelector('#habit-is-reading');if(!reading.checked){reading.checked=true;reading.onchange();}
  const open=()=>{parent.querySelector('#habit-reading-book-open').click();return c.habitBookDialog;};
  return {...h,parent,snapshot,row,open};
}

test('book picker shows safe covers and owned active books, then saves the chosen book with the draft intact',()=>{
  const h=readingBookPickerHarness(),{c,parent}=h,before=JSON.stringify(c.STATE);parent.querySelector('#habit-place').value='내 책상';parent.querySelector('#habit-time').value='저녁 8시';parent.querySelector('#habit-goal').value='보관할 수기 목표';
  const picker=h.open(),list=picker.querySelector('[data-habit-book-list]');
  assert.equal(picker.open,true);assert.equal(parent.open,true);assert.equal(parent.querySelector('#habit-reading-book').getAttribute('type'),'hidden');assert.equal(parent.querySelector('#habit-reading-book-open').getAttribute('aria-haspopup'),'dialog');
  assert.equal(picker.querySelectorAll('[data-habit-book-option]').length,2);assert.match(list.innerHTML,/마음 &lt;읽기&gt; &amp; 기록/);assert.match(list.innerHTML,/박곰희/);assert.doesNotMatch(list.innerHTML,/다른 회원|휴지통|javascript:|alert\(1\)/);assert.match(list.innerHTML,/src="https:\/\/example.test\/cover.jpg\?a=1&amp;b=2"/);assert.equal(picker.querySelectorAll('img').length,1);assert.equal(picker.querySelectorAll('.habit-book-cover').length,2);
  const image=picker.querySelector('img');assert.equal(image.getAttribute('alt'),'');assert.equal(image.getAttribute('referrerpolicy'),'no-referrer');image.onerror();assert.equal(image.hidden,true,'failed images leave the book icon visible');
  picker.querySelector('[data-habit-book-option="1"]').click();assert.equal(c.habitBookDialog,null);assert.equal(picker.isConnected,false);assert.equal(parent.querySelector('#habit-reading-book').value,'archive-two');assert.match(parent.querySelector('#habit-reading-book-open').innerHTML,/오늘의 습관/);assert.equal(c.document.activeElement,parent.querySelector('#habit-reading-book-open'));assert.equal(parent.querySelector('#habit-reading-pages').max,'240');
  assert.equal(parent.querySelector('#habit-place').value,'내 책상');assert.equal(parent.querySelector('#habit-time').value,'저녁 8시');assert.equal(parent.querySelector('#habit-goal').value,'보관할 수기 목표');assert.equal(JSON.stringify(c.STATE),before);assert.equal(h.saves.length,0);
  parent.querySelector('#habit-reading-pages').value='21';parent.querySelector('#btn-habit-submit').click();assert.equal(h.saves.length,1);h.saves[0].mutate(c.STATE);assert.equal(c.STATE.habits['new-habit'].valueId,'wisdom');assert.equal(c.STATE.habits['new-habit'].readingGoal.bookId,'archive-two');assert.equal(c.STATE.habits['new-habit'].readingGoal.targetPages,21);assert.equal(c.STATE.habits['new-habit'].place,'내 책상');
});

test('book search filters titles and authors while preserving the Korean composition input and focus',()=>{
  const h=readingBookPickerHarness(),picker=h.open(),search=picker.querySelector('#habit-book-search'),list=picker.querySelector('[data-habit-book-list]');search.focus();const initial=list.innerHTML;
  search.value='박';search.oninput({isComposing:true});assert.equal(list.innerHTML,initial);assert.equal(picker.querySelector('#habit-book-search'),search);assert.equal(h.c.document.activeElement,search);
  search.value='박곰희'.normalize('NFD');search.oncompositionend();assert.equal(picker.querySelectorAll('[data-habit-book-option]').length,1);assert.match(list.innerHTML,/오늘의 습관/);assert.doesNotMatch(list.innerHTML,/마음 &lt;읽기&gt;/);assert.equal(search.value,'박곰희'.normalize('NFD'));assert.equal(h.c.document.activeElement,search);
  search.value='마음';search.oninput({isComposing:false});assert.equal(picker.querySelectorAll('[data-habit-book-option]').length,1);assert.match(list.innerHTML,/마음 &lt;읽기&gt;/);
  search.value='없는 책';search.oninput({isComposing:false});assert.equal(picker.querySelectorAll('[data-habit-book-option]').length,0);assert.equal(picker.querySelector('[data-habit-book-result]').textContent,'찾는 책이 없어요.');
  search.value='';search.oninput({isComposing:false});assert.equal(picker.querySelectorAll('[data-habit-book-option]').length,2);assert.equal(h.saves.length,0);
});

test('closing or going Back from the book picker preserves the selection, draft and underlying scroll',()=>{
  for(const close of ['button','cancel','back']){
    const h=readingBookPickerHarness(true),{c,parent}=h;h.browser.scrollY=760;parent.scrollTop=190;parent.querySelector('#habit-reading-pages').value='32';parent.querySelector('#habit-place').value='보관할 장소';const before=JSON.stringify(c.STATE),picker=h.open();
    assert.equal(picker.querySelector('[data-habit-book-option="0"]').getAttribute('aria-pressed'),'true');picker.querySelector('#habit-book-search').value='작성 중인 검색';
    if(close==='button')picker.querySelector('#habit-book-close').click();else if(close==='cancel')picker.listeners.cancel({preventDefault(){}});else h.back();
    assert.equal(c.habitBookDialog,null);assert.equal(picker.isConnected,false);assert.equal(c.habitComposerDialog,parent);assert.equal(parent.open,true);assert.equal(parent.querySelector('#habit-reading-book').value,'archive-one');assert.equal(parent.querySelector('#habit-reading-pages').value,'32');assert.equal(parent.querySelector('#habit-place').value,'보관할 장소');assert.equal(parent.scrollTop,190);assert.equal(h.browser.scrollY,760);assert.equal(c.document.activeElement,parent.querySelector('#habit-reading-book-open'));assert.equal(JSON.stringify(c.STATE),before);assert.equal(h.saves.length,0);
    h.back();assert.equal(c.habitComposerDialog,null);assert.equal(h.browser.scrollY,760);assert.equal(c.document.activeElement,h.trigger);assert.match(h.browser.location.href,/#\/book\/emotion\/habit$/);
  }
});

test('book choice rechecks fresh loading state, ownership, deletion and identity before changing the draft',()=>{
  for(const change of ['loading','error','owner','deleted','removed','duplicate']){
    const h=readingBookPickerHarness(true),{c,parent,snapshot}=h,picker=h.open(),stale=picker.querySelector('[data-habit-book-option="1"]'),before=JSON.stringify(c.STATE);
    if(change==='loading'||change==='error')snapshot.status=change;else if(change==='owner')snapshot.rows[1].entry.userId='foreign';else if(change==='deleted')snapshot.rows[1].book.deleted=true;else if(change==='removed')snapshot.rows.splice(1,1);else snapshot.rows.push(structuredClone(snapshot.rows[1]));
    stale.click();assert.equal(parent.querySelector('#habit-reading-book').value,'archive-one');assert.equal(c.habitBookDialog,picker);assert.equal(JSON.stringify(c.STATE),before);assert.equal(h.saves.length,0);
    if(change==='loading'||change==='error')assert.equal(picker.querySelectorAll('[data-habit-book-option]').length,0);else if(change!=='duplicate')assert.doesNotMatch(picker.querySelector('[data-habit-book-list]').innerHTML,/오늘의 습관/);
  }
});

test('stale book controls cannot change a draft after session, epoch, route or habit-kind changes',()=>{
  for(const change of ['owner','epoch','route','reading','kind','composer']){
    const h=readingBookPickerHarness(true),{c,parent}=h,picker=h.open(),stale=picker.querySelector('[data-habit-book-option="1"]'),before=JSON.stringify(c.STATE),focus={};
    if(change==='owner')c.SESSION={userId:'other'};else if(change==='epoch')c.saveSessionEpoch++;else if(change==='route')h.navigate('#/archive');else if(change==='reading'){parent.querySelector('#habit-is-reading').checked=false;parent.querySelector('#habit-is-reading').onchange();}else if(change==='kind')parent.querySelector('[name="habit-behavior-type"][value="avoid"]').click();else c.closeHabitComposer(false);
    c.document.activeElement=focus;stale.click();assert.equal(c.habitBookDialog,null);assert.equal(picker.isConnected,false);assert.equal(parent.querySelector('#habit-reading-book').value,'archive-one');assert.equal(c.document.activeElement,focus);assert.equal(JSON.stringify(c.STATE),before);assert.equal(h.saves.length,0);
  }
});

test('archive refresh keeps the active book search and blocks unavailable books until ready',()=>{
  const h=readingBookPickerHarness(),{c,parent,snapshot}=h,picker=h.open(),search=picker.querySelector('#habit-book-search');search.value='박곰희';search.oninput({isComposing:false});search.focus();
  snapshot.status='error';c.refreshHabitComposerBooks();assert.equal(c.habitBookDialog,picker);assert.equal(picker.querySelectorAll('[data-habit-book-option]').length,0);assert.match(picker.querySelector('[data-habit-book-result]').textContent,/불러오지 못/);assert.equal(parent.querySelector('#habit-reading-book-open').disabled,true);assert.equal(search.value,'박곰희');assert.equal(c.document.activeElement,search);
  snapshot.status='ready';snapshot.rows[1].book.title='새로 바뀐 책 제목';c.refreshHabitComposerBooks();assert.equal(parent.querySelector('#habit-reading-book-open').disabled,false);assert.equal(picker.querySelectorAll('[data-habit-book-option]').length,1);assert.match(picker.querySelector('[data-habit-book-list]').innerHTML,/새로 바뀐 책 제목/);assert.equal(picker.querySelector('#habit-book-search'),search);assert.equal(c.document.activeElement,search);assert.equal(h.saves.length,0);
});

test('deleting a newly picked book never silently restores the previously saved linked book',()=>{
  const h=readingBookPickerHarness(true),{c,parent,snapshot}=h;c.STATE.habits.h1.readingGoal.linkedBookId='emotion';snapshot.rows[0].book.linkedBookId='emotion';
  const before=JSON.stringify(c.STATE),picker=h.open();picker.querySelector('[data-habit-book-option="1"]').click();assert.equal(parent.querySelector('#habit-reading-book').value,'archive-two');snapshot.rows[1].book.deleted=true;c.refreshHabitComposerBooks();
  assert.equal(parent.querySelector('#habit-reading-book').value,'archive-two');assert.match(parent.querySelector('#habit-reading-book-open').innerHTML,/책장에 없는 책/);parent.querySelector('#btn-habit-submit').click();assert.equal(h.saves.length,0);assert.equal(JSON.stringify(c.STATE),before);assert.equal(c.document.activeElement,parent.querySelector('#habit-reading-book-open'));
  snapshot.rows[1].book.deleted=false;const again=h.open();again.querySelector('[data-habit-book-option="1"]').click();parent.querySelector('#btn-habit-submit').click();assert.equal(h.saves.length,1);c.STATE.habits.h1.checkedDates.push('2026-09-22');h.saves[0].mutate(c.STATE);assert.equal(c.STATE.habits.h1.readingGoal.bookId,'archive-two');assert.deepEqual(Array.from(c.STATE.habits.h1.checkedDates),['2026-09-21','2026-09-22']);
});

test('an original legacy shared-book reference may migrate only to its unique owned replacement',()=>{
  for(const ambiguous of [false,true]){
    const h=readingBookPickerHarness(true),{c,snapshot}=h;c.closeHabitComposer(false);const legacyId='private_archive_owner_arc_shared_emotion';c.STATE.habits.h1.readingGoal={bookId:legacyId,linkedBookId:'emotion',targetPages:10};snapshot.rows[0].book.linkedBookId='emotion';snapshot.rows[2].book.linkedBookId='emotion';if(ambiguous)snapshot.rows[1].book.linkedBookId='emotion';
    const before=JSON.stringify(c.STATE);c.openHabitComposer('emotion','h1',h.trigger);const parent=c.habitComposerDialog;
    assert.equal(parent.querySelector('#habit-reading-book').value,ambiguous?legacyId:'archive-one');assert.equal(parent.querySelector('#habit-value-select').value,'wisdom');assert.equal(JSON.stringify(c.STATE),before);assert.equal(h.saves.length,0);
  }
});

function valueSummaryHarness(){
  const h=composerHarness(),base={userId:'owner',bookId:'emotion',startDate:'2026-09-01',checkedDates:[],valueId:'faith'};
  const habit=(id,extra={})=>({id,name:id,...base,...extra});
  h.c.STATE.habits={done:habit('done',{name:'완료한 <기도>',checkedDates:['2026-09-21','2026-09-22']}),pending:habit('pending',{name:'오늘 할 절제',behaviorType:'avoid'}),future:habit('future',{name:'다음 달 습관',startDate:'2026-10-01'}),ended:habit('ended',{name:'마친 습관',endDate:'2026-09-20',checkedDates:['2026-09-20']}),love:habit('love',{name:'애 가치 습관',valueId:'love'}),legacy:habit('legacy',{name:'기도',valueId:''}),stranger:habit('stranger',{name:'다른 회원 비밀',userId:'foreign'})};
  return h;
}

test('value overview badges and summaries use explicit values and group only this owner habits by todays state',()=>{
  const h=valueSummaryHarness(),c=h.c,overview=c.habitOverviewBodyHtml();
  assert.deepEqual(Array.from(overview.matchAll(/data-habit-value-overview="([^"]+)"/g),match=>match[1]),['all']);assert.equal(c.habitValueBadgeHtml({name:'기도',valueId:''}),'');assert.equal(c.habitValueBadgeHtml({valueId:'invalid'}),'');assert.match(c.habitCardHtml(c.STATE.habits.done),/class="habit-value-badge" data-value="faith"/);
  c.openHabitValueSummary('all',h.trigger);const popup=c.habitValueSummaryDialog,content=()=>popup.querySelector('[data-habit-values-content]').innerHTML;
  assert.deepEqual(popup.querySelectorAll('[data-habit-value-summary]').map(button=>button.getAttribute('data-habit-value-summary')),['all','faith','love','virtue','wisdom','emotion','beauty','body']);assert.match(content(),/만든 습관 6개 · 오늘 완료 1개/);assert.doesNotMatch(content(),/다른 회원 비밀/);popup.querySelector('[data-habit-value-summary="faith"]').click();
  assert.equal(popup.open,true);assert.match(content(),/만든 습관 4개 · 오늘 완료 1개/);assert.match(content(),/완료한 &lt;기도&gt;/);assert.match(content(),/오늘 할 절제/);assert.match(content(),/다음 달 습관/);assert.match(content(),/마친 습관/);assert.match(content(),/누적 2회/);assert.doesNotMatch(content(),/다른 회원 비밀|애 가치 습관/);assert.equal(popup.querySelectorAll('input').length,0);assert.equal(popup.querySelectorAll('[data-habit-day]').length,0);assert.equal(popup.querySelectorAll('[data-habit-overview-day]').length,0);
  popup.querySelector('[data-habit-value-summary="love"]').click();assert.match(content(),/만든 습관 1개 · 오늘 완료 0개/);assert.match(content(),/애 가치 습관/);assert.doesNotMatch(content(),/완료한|오늘 할 절제|다른 회원/);popup.querySelector('[data-habit-value-summary="body"]').click();assert.match(content(),/아직 체 가치로 만든 습관이 없어요/);assert.equal(h.saves.length,0);
});

test('value summary refresh follows queued checks and the new day while keeping the original cumulative check dates',()=>{
  const h=valueSummaryHarness(),c=h.c;c.openHabitValueSummary('faith',h.trigger);const popup=c.habitValueSummaryDialog;
  c.habitSaveIntents.pending={'2026-09-22':{checked:true,status:'saving'}};c.refreshHabitSaveUI('pending');assert.equal(c.habitValueSummaryDialog,popup);assert.match(popup.querySelector('[data-habit-values-content]').innerHTML,/만든 습관 4개 · 오늘 완료 2개/);assert.deepEqual(c.STATE.habits.pending.checkedDates,[]);
  c.STATE.habits.pending.checkedDates.push('2026-09-22');delete c.habitSaveIntents.pending;c.refreshHabitSaveUI('pending');assert.match(popup.querySelector('[data-habit-values-content]').innerHTML,/오늘 완료 2개/);
  const dates=JSON.stringify(Object.fromEntries(Object.entries(c.STATE.habits).map(([id,habit])=>[id,habit.checkedDates])));c.Date=class extends Date{constructor(...args){super(...(args.length?args:[2026,8,23,0,1]));}};c.refreshHabitValueSummary();assert.equal(c.habitValueSummaryDialog,popup);assert.match(popup.querySelector('[data-habit-values-content]').innerHTML,/만든 습관 4개 · 오늘 완료 0개/);assert.match(popup.querySelector('[data-habit-values-content]').innerHTML,/오늘 할 습관 <small>2/);assert.equal(JSON.stringify(Object.fromEntries(Object.entries(c.STATE.habits).map(([id,habit])=>[id,habit.checkedDates]))),dates);assert.equal(h.saves.length,0);
});

test('summary guide opens without a composer and Back returns through the same value popup to its trigger',()=>{
  const h=valueSummaryHarness(),c=h.c;h.browser.scrollY=470;c.openHabitValueSummary('faith',h.trigger);const popup=c.habitValueSummaryDialog;popup.scrollTop=180;const guideTrigger=popup.querySelector('[data-habit-values-guide]');guideTrigger.click();const guide=c.habitValueGuideDialog;
  assert.equal(c.habitComposerDialog,null);assert.equal(guide.open,true);assert.equal(guide.querySelector('[data-habit-value-page="faith"]').getAttribute('aria-selected'),'true');assert.equal(popup.open,true);h.back();assert.equal(c.habitValueGuideDialog,null);assert.equal(c.habitValueSummaryDialog,popup);assert.equal(c.document.activeElement,guideTrigger);assert.equal(popup.scrollTop,180);assert.equal(h.browser.scrollY,470);h.back();assert.equal(c.habitValueSummaryDialog,null);assert.equal(c.document.activeElement,h.trigger);assert.match(h.browser.location.href,/#\/book\/emotion\/habit$/);assert.equal(h.saves.length,0);
});

test('value popups close safely on account, epoch, route or loading changes and cannot reopen stale habit details',()=>{
  for(const change of ['owner','epoch','route','loading','error']){
    const h=valueSummaryHarness(),c=h.c;c.openHabitValueSummary('faith',h.trigger);const popup=c.habitValueSummaryDialog,guideTrigger=popup.querySelector('[data-habit-values-guide]'),focus={};
    if(change==='owner')c.SESSION={userId:'foreign'};else if(change==='epoch')c.saveSessionEpoch++;else if(change==='route')h.browser.location.href='https://example.test/#/';else c.memberLoadState.habits=change;c.document.activeElement=focus;c.refreshHabitValueSummary();assert.equal(c.habitValueSummaryDialog,null);assert.equal(popup.isConnected,false);assert.equal(c.document.activeElement,focus);guideTrigger.click();assert.equal(c.habitValueGuideDialog,null);assert.equal(h.saves.length,0);
  }
  const h=valueSummaryHarness(),c=h.c;for(const status of ['loading','error']){c.memberLoadState.habits=status;c.openHabitValueSummary('faith',h.trigger);assert.equal(c.habitValueSummaryDialog,null);}c.memberLoadState.habits='ready';c.openHabitValueSummary('invalid',h.trigger);assert.equal(c.habitValueSummaryDialog,null);c.SESSION=null;c.openHabitValueSummary('faith',h.trigger);c.openHabitValueGuide(null,h.trigger,'faith');assert.equal(c.habitValueSummaryDialog,null);assert.equal(c.habitValueGuideDialog,null);
});

test('the value picker guide browses every value without changing the composer draft',()=>{
  const h=composerHarness(),c=h.c;c.openHabitComposer('emotion',null,h.trigger);const parent=c.habitComposerDialog;parent.querySelector('#habit-name').value='작성 중인 습관';
  parent.querySelector('#habit-reading-book').value='archive-one';parent.querySelector('#habit-reading-pages').value='19';parent.querySelector('#habit-place').value='작성 중인 장소';parent.querySelector('#habit-goal').value='보관할 수기 목표';
  const before=JSON.stringify(c.STATE),{guide,trigger}=openComposerGuide(h);assert.equal(parent.querySelector('#habit-value-guide-open'),null);assert.equal(guide.open,true);assert.equal(parent.open,true);assert.match(guide.querySelector('[data-habit-value-guide-content]').innerHTML,/좋은 습관은[\s\S]*좋은 방향에서/);
  assert.deepEqual([...new Set(guide.querySelectorAll('[data-habit-value-jump]').map(button=>button.getAttribute('data-habit-value-jump')))],['faith','love','virtue','wisdom','emotion','beauty','body']);
  for(const value of c.GrowellHabitSuggestions.categories()){
    const intro=guide.querySelector('[data-habit-value-page="intro"]');if(intro)intro.click();guide.querySelector('[data-habit-value-jump="'+value.id+'"]').click();const content=guide.querySelector('[data-habit-value-guide-content]').innerHTML;assert.ok(content.includes(value.headline));assert.ok(content.includes(value.lead));assert.ok(content.includes(value.question));assert.equal(guide.querySelector('[data-habit-value-page="'+value.id+'"]').getAttribute('aria-selected'),'true');assert.equal(c.document.activeElement,guide.querySelector('[data-hg-heading]'));
    const options=guide.querySelectorAll('[data-habit-guide-practice]');assert.equal(options.length,value.examples.length);assert.ok(guide.querySelector('#habit-guide-action').innerHTML.includes(value.examples[0].action));assert.ok(!guide.querySelector('#habit-guide-action').innerHTML.includes(value.examples[1].action));options.at(-1).click();assert.ok(guide.querySelector('#habit-guide-action').innerHTML.includes(value.examples.at(-1).action));assert.ok(!guide.querySelector('#habit-guide-action').innerHTML.includes(value.examples[0].action));
  }
  guide.querySelector('#habit-value-guide-close').click();assert.equal(c.habitValueGuideDialog,null);assert.equal(guide.isConnected,false);assert.equal(c.habitComposerDialog,parent);assert.equal(c.document.activeElement,trigger);assert.equal(parent.querySelector('#habit-is-reading').checked,false);assert.equal(parent.querySelector('#habit-name').value,'작성 중인 습관');assert.equal(parent.querySelector('#habit-reading-book').value,'archive-one');assert.equal(parent.querySelector('#habit-reading-pages').value,'19');assert.equal(parent.querySelector('#habit-place').value,'작성 중인 장소');assert.equal(parent.querySelector('#habit-goal').value,'보관할 수기 목표');assert.equal(JSON.stringify(c.STATE),before);assert.equal(h.saves.length,0);
});

test('guide focus fallback remains safe without the removed composer guide button',()=>{
  const h=composerHarness(),c=h.c;c.openHabitComposer('emotion',null,h.trigger);const parent=c.habitComposerDialog,{guide,picker}=openComposerGuide(h);
  guide._trigger={isConnected:false};guide.querySelector('#habit-value-guide-close').click();assert.equal(c.habitValueGuideDialog,null);assert.equal(c.document.activeElement,picker.querySelector('#habit-name-guide-open'));assert.equal(c.habitNameDialog,picker);
  c.closeHabitNamePicker();c.openHabitValueGuide(parent,{isConnected:false},'faith');c.habitValueGuideDialog.querySelector('#habit-value-guide-close').click();assert.equal(c.document.activeElement,parent.querySelector('#habit-name'));assert.equal(c.habitComposerDialog,parent);assert.equal(c.habitValueGuideDialog,null);assert.equal(h.saves.length,0);
});

test('choosing a guide practice fills only the composer name and value while preserving its goal and draft',()=>{
  const h=composerHarness(),c=h.c;c.openHabitComposer('emotion',null,h.trigger);const parent=c.habitComposerDialog;
  const fields={name:'작성 중인 습관',goal:'내가 정한 목표',place:'나의 장소',time:'저녁 8시','start-date':'2026-09-21','end-date':'2026-10-20'};for(const [key,value] of Object.entries(fields))parent.querySelector('#habit-'+key).value=value;
  const {guide}=openComposerGuide(h);guide.querySelector('[data-habit-value-jump="beauty"]').click();guide.querySelector('[data-habit-guide-practice="1"]').click();guide.querySelector('[data-habit-guide-choose]').click();
  assert.equal(c.habitValueGuideDialog,null);assert.equal(c.habitComposerDialog,parent);assert.equal(parent.querySelector('#habit-name').value,'음악');assert.equal(parent.querySelector('#habit-value-select').value,'beauty');assert.equal(parent._valueName,'음악');assert.equal(parent.querySelector('#habit-is-reading').checked,false);assert.equal(c.document.activeElement,parent.querySelector('#habit-name'));
  for(const [key,value] of Object.entries(fields))if(key!=='name')assert.equal(parent.querySelector('#habit-'+key).value,value);assert.equal(h.saves.length,0);
});

test('a guide opened from the overview starts a fresh composer without saving or reviving the previous popups',()=>{
  const h=valueSummaryHarness(),c=h.c,before=JSON.stringify(c.STATE);h.browser.scrollY=380;c.openHabitValueSummary('all',h.trigger);const popup=c.habitValueSummaryDialog;popup.querySelector('[data-habit-values-guide]').click();const guide=c.habitValueGuideDialog;
  guide.querySelector('[data-habit-value-jump="faith"]').click();guide.querySelector('[data-habit-guide-practice="2"]').click();guide.querySelector('[data-habit-guide-choose]').click();
  const parent=c.habitComposerDialog;assert.ok(parent);assert.equal(parent.open,true);assert.equal(c.habitValueGuideDialog,null);assert.equal(c.habitValueSummaryDialog,null);assert.equal(popup.isConnected,false);assert.equal(guide.isConnected,false);assert.equal(parent.querySelector('#habit-name').value,'필사');assert.equal(parent.querySelector('#habit-value-select').value,'faith');assert.equal(parent.querySelector('#habit-goal').value,'');assert.equal(h.saves.length,0);assert.equal(JSON.stringify(c.STATE),before);h.back();assert.equal(c.habitComposerDialog,null);assert.equal(c.habitValueSummaryDialog,null);assert.equal(c.habitValueGuideDialog,null);assert.equal(h.browser.scrollY,380);assert.match(h.browser.location.href,/#\/book\/emotion\/habit$/);
});

test('choosing reading in the guide retains the manual goal and an edited reading name survives saving and reopening',()=>{
  const h=composerHarness(),c=h.c;c.openHabitComposer('emotion',null,h.trigger);const parent=c.habitComposerDialog;parent.querySelector('#habit-goal').value='나중에 다시 쓸 목표';
  const {guide}=openComposerGuide(h);guide.querySelector('[data-habit-value-jump="wisdom"]').click();guide.querySelector('[data-habit-guide-choose]').click();
  assert.equal(parent.querySelector('#habit-is-reading').checked,true);assert.equal(parent.querySelector('#habit-name').readOnly,false);assert.equal(parent.querySelector('#habit-goal').value,'나중에 다시 쓸 목표');assert.equal(h.saves.length,0);
  const name=parent.querySelector('#habit-name'),book=parent.querySelector('#habit-reading-book'),pages=parent.querySelector('#habit-reading-pages');name.value='저녁 책 읽기';name.oninput({isComposing:false});book.value='archive-one';book.onchange();pages.value='17';pages.oninput();parent.querySelector('#btn-habit-submit').click();assert.equal(h.saves.length,1);
  h.saves[0].mutate(c.STATE);const saved=c.STATE.habits['new-habit'];assert.equal(saved.name,'저녁 책 읽기');assert.equal(saved.valueId,'wisdom');assert.equal(saved.goal,'하루 17쪽 읽기');assert.deepEqual({...saved.readingGoal},readingGoal({targetPages:17}));c.closeHabitComposer(false);c.openHabitComposer('emotion','new-habit',h.trigger);assert.equal(c.habitComposerDialog.querySelector('#habit-name').value,'저녁 책 읽기');assert.equal(c.habitComposerDialog.querySelector('#habit-name').readOnly,false);
});

test('Back unwinds guide, value picker and composer one at a time while retaining their draft and selected value',()=>{
  const h=composerHarness(),c=h.c;h.browser.scrollY=620;c.openHabitComposer('thought',null,h.trigger);const parent=c.habitComposerDialog;parent.querySelector('#habit-name').value='작성 중인 습관';parent.querySelector('#habit-goal').value='매일 5분';parent.querySelector('#habit-name-picker').click();const picker=c.habitNameDialog;
  picker.querySelector('[data-habit-name-category="beauty"]').click();const trigger=picker.querySelector('#habit-name-guide-open');trigger.click();const guide=c.habitValueGuideDialog;guide.querySelector('[data-habit-value-jump="beauty"]').click();assert.equal(guide.querySelector('[data-habit-value-page="beauty"]').getAttribute('aria-selected'),'true');assert.equal(parent.open,true);assert.equal(picker.open,true);h.back();
  assert.equal(c.habitValueGuideDialog,null);assert.equal(guide.isConnected,false);assert.equal(c.habitNameDialog,picker);assert.equal(c.habitComposerDialog,parent);assert.equal(picker.querySelector('[data-habit-name-category="beauty"]').getAttribute('aria-pressed'),'true');assert.equal(c.document.activeElement,trigger);assert.equal(parent.querySelector('#habit-name').value,'작성 중인 습관');assert.equal(parent.querySelector('#habit-goal').value,'매일 5분');assert.equal(h.browser.scrollY,620);assert.equal(h.saves.length,0);
  picker.querySelector('#habit-name-guide-open').click();assert.ok(c.habitValueGuideDialog.querySelector('[data-habit-value-jump="faith"]'));c.habitValueGuideDialog.querySelector('#habit-value-guide-close').click();assert.equal(c.habitNameDialog,picker);h.back();assert.equal(c.habitNameDialog,null);assert.equal(c.habitComposerDialog,parent);assert.equal(parent.querySelector('#habit-goal').value,'매일 5분');h.back();assert.equal(c.habitComposerDialog,null);assert.equal(c.document.activeElement,h.trigger);assert.match(h.browser.location.href,/#\/book\/emotion\/habit$/);assert.equal(h.saves.length,0);
});

test('closing a picker or composer closes its nested guide and stale guide controls cannot act after session or route changes',()=>{
  for(const closing of ['picker','composer']){
    const h=composerHarness(),c=h.c;c.openHabitComposer('emotion',null,h.trigger);const parent=c.habitComposerDialog;parent.querySelector('#habit-name-picker').click();c.habitNameDialog.querySelector('#habit-name-guide-open').click();const guide=c.habitValueGuideDialog;
    if(closing==='picker')c.closeHabitNamePicker();else c.closeHabitComposer();assert.equal(c.habitValueGuideDialog,null);assert.equal(guide.isConnected,false);assert.equal(c.habitNameDialog,null);assert.equal(c.habitComposerDialog,closing==='picker'?parent:null);assert.equal(h.saves.length,0);
  }
  for(const change of ['owner','epoch','route']){
    const h=composerHarness(),c=h.c;c.openHabitComposer('emotion',null,h.trigger);const parent=c.habitComposerDialog;parent.querySelector('#habit-name').value='변경하지 않을 이름';const {guide,trigger}=openComposerGuide(h),focus={};
    if(change==='owner')c.SESSION={userId:'different'};else if(change==='epoch')c.saveSessionEpoch++;else h.browser.location.href='https://example.test/#/';c.document.activeElement=focus;
    guide.querySelector('[data-habit-value-jump="faith"]').click();assert.equal(c.habitValueGuideDialog,null);assert.equal(guide.isConnected,false);assert.equal(c.document.activeElement,focus);assert.equal(parent.querySelector('#habit-name').value,'변경하지 않을 이름');assert.equal(h.saves.length,0);trigger.click();assert.equal(c.habitValueGuideDialog,null);
  }
});

test('browser Back and the picker back button retain the composer draft and stale account choices cannot apply',()=>{
  for(const closing of ['browser','button']){
    const h=composerHarness(),c=h.c;h.browser.scrollY=430;c.openHabitComposer('emotion',null,h.trigger);const parent=c.habitComposerDialog;
    parent.querySelector('#habit-name').value='저장 전 이름';parent.querySelector('#habit-goal').value='보관할 목표';parent.querySelector('#habit-name-picker').click();const picker=c.habitNameDialog;
    const customInput=picker.querySelector('#habit-name-custom-input');customInput.value='아직 선택하지 않은 이름';customInput.oninput();
    if(closing==='browser')h.back();else picker.querySelector('#habit-name-back').click();
    assert.equal(c.habitNameDialog,null);assert.equal(picker.isConnected,false);assert.equal(c.habitComposerDialog,parent);assert.equal(parent.open,true);assert.equal(parent.querySelector('#habit-name').value,'저장 전 이름');assert.equal(parent.querySelector('#habit-goal').value,'보관할 목표');assert.equal(c.document.activeElement,parent.querySelector('#habit-name'));assert.equal(h.browser.scrollY,430);assert.equal(h.saves.length,0);
    parent.querySelector('#habit-name-picker').click();const late=c.habitNameDialog;c.SESSION={userId:'different'};c.saveSessionEpoch++;late.querySelector('[data-habit-name-option="0"]').click();assert.equal(c.habitNameDialog,null);assert.equal(parent.querySelector('#habit-name').value,'저장 전 이름');assert.equal(h.saves.length,0);c.refreshHabitComposerBooks();assert.equal(c.habitComposerDialog,null);
  }
});

test('old create and edit save completions cannot close or clear a newer habit composer',()=>{
  for(const editing of [false,true]){
    const h=composerHarness(),c=h.c;c.openHabitComposer('emotion',editing?'h1':null,h.trigger);
    const first=c.habitComposerDialog;
    if(editing)c.editHabit('h1',payload,first.fields['#btn-habit-submit']);else c.submitHabit('emotion',payload,first.fields['#btn-habit-submit']);
    assert.equal(h.saves.length,1);c.closeHabitComposer();c.openHabitComposer('thought','h2',h.trigger);
    const second=c.habitComposerDialog;second.fields['#habit-name'].value='두 번째 새 입력';
    h.saves[0].options.onSuccess();
    assert.equal(c.habitComposerDialog,second);assert.equal(second.open,true);assert.equal(second.isConnected,true);
    assert.equal(c.habitFormOpenFor,'thought');assert.equal(c.habitEditingId,'h2');assert.equal(second.fields['#habit-name'].value,'두 번째 새 입력');
    c.editHabit('h2',payload,second.fields['#btn-habit-submit']);h.saves[1].options.onSuccess();
    assert.equal(c.habitComposerDialog,null);assert.equal(second.open,false);assert.equal(c.habitFormOpenFor,null);assert.equal(c.habitEditingId,null);
  }
});

test('habit composer closes without stealing focus after account change or navigating to another space',()=>{
  for(const mode of ['owner','route']){
    const h=composerHarness(),c=h.c;c.openHabitComposer('emotion','h1',h.trigger);const dialog=c.habitComposerDialog;
    const destination={};c.document.activeElement=destination;h.browser.scrollY=70;
    if(mode==='owner'){c.SESSION={userId:'other'};c.saveSessionEpoch++;c.refreshHabitComposerBooks();}else h.navigate('#/archive');
    assert.equal(c.habitComposerDialog,null);assert.equal(dialog.isConnected,false);assert.equal(c.document.activeElement,destination);
    assert.equal(h.browser.scrollY,70);assert.equal(h.saves.length,0);
  }
});

test('week and month popups show only the selected habit and keep the progress detail available',()=>{
  const h=popupHarness(),c=h.c;
  c.habitSaveIntents.h2={'2026-09-22':{checked:true,status:'saving'}};
  c.openHabitProgress('h2','card','week');
  assert.equal(c.habitHistoryOpenFor,'h2');assert.equal(c.habitHistoryView,'week');
  assert.match(h.html,/habit-dialog-title">화면 쉬기/);assert.match(h.html,/data-habit-week-progress="h2">1\/7일 절제/);
  assert.match(h.html,/data-habit-day="h2\|2026-09-22"/);assert.match(h.html,/체크 저장 중/);
  assert.doesNotMatch(h.html,/data-habit-day="h1\||data-habit-history-calendar|data-habit-stats-panel/);
  c.closeHabitProgress();c.openHabitProgress('h1','card','month');
  assert.equal(c.habitHistoryView,'month');assert.match(h.html,/habit-dialog-title">책 읽기/);
  assert.match(h.html,/data-habit-history-calendar/);assert.match(h.html,/data-habit-day="h1\|2026-09-21"/);
  assert.doesNotMatch(h.html,/data-habit-day="h2\||habit-week-grid|data-habit-stats-panel/);
  c.closeHabitProgress();c.openHabitProgress('h1');
  assert.equal(c.habitHistoryView,'progress');assert.match(h.html,/data-habit-stats-panel="h1"/);
  assert.match(h.html,/data-habit-history-calendar/);
});

test('record popup opening rejects missing habits, other owners and signed-out access',()=>{
  const h=popupHarness(),c=h.c;
  c.openHabitProgress('stranger','card','month');c.openHabitProgress('missing','card','week');
  c.SESSION=null;c.openHabitProgress('h1','card','week');
  assert.equal(c.habitHistoryOpenFor,null);assert.equal(h.html,'');assert.equal(h.renders,0);
  assert.equal(h.entries.length,2);
});

test('browser Back closes each record popup on the same habit screen and restores its exact button and scroll',()=>{
  for(const view of ['week','month']){
    const h=popupHarness(),c=h.c,trigger=h.buttons.find(button=>button.getAttribute('data-habit-record')==='h2'&&button.getAttribute('data-habit-record-view')===view);
    h.browser.scrollX=8;h.browser.scrollY=1125;c.document.activeElement=trigger;
    c.openHabitProgress('h2','card',view);assert.equal(c.document.activeElement,h.modal);
    const historySize=h.entries.length;c.render();assert.equal(h.entries.length,historySize,'rerender must not add another Back step');
    h.browser.scrollX=0;h.browser.scrollY=100;h.back();
    assert.equal(c.habitHistoryOpenFor,null);assert.equal(h.html,'');
    assert.match(h.browser.location.href,/#\/book\/emotion\/habit$/);
    assert.equal(c.document.activeElement,trigger);assert.equal(h.browser.scrollX,8);assert.equal(h.browser.scrollY,1125);
    h.back();assert.match(h.browser.location.href,/#\/book\/emotion\/mine$/);
  }
});

test('explicit close then opening another habit keeps Back targeted at the latest popup',()=>{
  const h=popupHarness(),c=h.c;
  c.openHabitProgress('h1','card','week');c.closeHabitProgress();
  const historySize=h.entries.length;h.browser.scrollY=640;
  c.openHabitProgress('h2','card','month');assert.equal(h.entries.length,historySize);
  h.back();assert.equal(c.habitHistoryOpenFor,null);assert.equal(h.browser.scrollY,640);
  assert.equal(c.document.activeElement,h.buttons.find(button=>button.getAttribute('data-habit-record')==='h2'&&button.getAttribute('data-habit-record-view')==='month'));
  assert.match(h.browser.location.href,/#\/book\/emotion\/habit$/);
});

test('leaving the habit route closes its popup without restoring the old page scroll',()=>{
  const h=popupHarness(),c=h.c;h.browser.scrollY=850;c.openHabitProgress('h1','card','week');
  h.browser.scrollY=30;h.navigate('#/');
  assert.equal(c.habitHistoryOpenFor,null);assert.equal(h.browser.scrollY,30);assert.match(h.browser.location.href,/#\/$/);
});

test('weekly popup progress and success marks refresh for check and undo without replacing the popup',()=>{
  const h=popupHarness(),c=h.c;
  c.openHabitProgress('h2','card','week');const renders=h.renders;
  function node(attrs,classes=[]){
    const set=new Set(classes);
    return {attrs,textContent:'',innerHTML:'',getAttribute:key=>attrs[key],hasAttribute:key=>Object.hasOwn(attrs,key),
      setAttribute(key,value){attrs[key]=value;},querySelector:()=>null,
      classList:{contains:value=>set.has(value),toggle(value,enabled){if(enabled)set.add(value);else set.delete(value);}}};
  }
  const day=node({'data-habit-day':'h2|2026-09-22'});day.parentElement=node({});
  const progress=node({'data-habit-week-progress':'h2'}),otherProgress=node({'data-habit-week-progress':'h1'});
  otherProgress.textContent='leave alone';const card=node({'data-habit-card':'h2'},['card','habit-card']);
  card.classList.toggle=()=>assert.fail('checking a day must not change the parent card appearance');
  const popupStatus=node({'data-habit-popup-status':'h2'});
  const nodes={'[data-habit-card], [data-habit-stats-panel]':[card],'[data-habit-card]':[card],'[data-habit-day]':[day],
    '[data-habit-week-progress]':[progress,otherProgress],'[data-habit-popup-status]':[popupStatus]};
  c.document.querySelectorAll=selector=>nodes[selector]||[];
  for(const checked of [true,false]){
    c.habitSaveIntents.h2={'2026-09-22':{checked,status:'saving'}};c.refreshHabitSaveUI('h2');
    assert.equal(progress.textContent,(checked?'1':'0')+'/7일 절제');assert.equal(day.attrs['aria-pressed'],String(checked));
    assert.equal(day.parentElement.classList.contains('is-checked'),checked);
    assert.equal(card.classList.contains('is-today-success'),false);assert.match(popupStatus.innerHTML,/체크 저장 중/);
    assert.equal(c.habitHistoryOpenFor,'h2');assert.equal(h.renders,renders);
  }
  assert.equal(otherProgress.textContent,'leave alone');assert.deepEqual(c.STATE.habits.h2.checkedDates,[]);
  c.habitSaveIntents.h2['2026-09-22'].status='error';c.refreshHabitSaveUI('h2');
  assert.match(popupStatus.innerHTML,/data-retry-habit-save="h2"/);
});

test('changing popup months preserves dialog scroll and focused navigation while new dates remain reversible',()=>{
  const c=cardHarness(),events=[];
  c.STATE={habits:{h1:{id:'h1',userId:'owner',startDate:'2026-08-01',checkedDates:[]}}};
  c.SESSION={userId:'owner'};c.habitHistoryOpenFor='h1';c.habitHistoryMonth={y:2026,m:8};
  c.habitSaveIntents={h1:{'2026-08-15':{checked:true,status:'saving'}}};
  vm.runInContext(source.slice(source.indexOf('function habitWithPendingChecks('),source.indexOf('function habitSaveStatusHtml(')),c);
  const button={getAttribute:key=>key==='data-habit-day'?'h1|2026-08-15':null,hasAttribute:()=>false,addEventListener(type,fn){this.click=fn;}};
  const calendar={innerHTML:'old dates',querySelectorAll:()=>[button]},label={},summary={};
  const modal={scrollTop:425,querySelector:selector=>({'[data-habit-history-calendar]':calendar,'.habit-hist-month-label':label,'[data-habit-popup-summary]':summary}[selector])};
  c.app={querySelector:()=>modal};c.render=()=>assert.fail('month navigation must not replace the dialog');
  c.focusHabitDialog=()=>assert.fail('month navigation must retain focus on its existing button');
  c.habitHistoryCalendarHtml=(habit,y,m,stable)=>{assert.equal(stable,true);assert.deepEqual(Array.from(habit.checkedDates),['2026-08-15']);return `${y}-${m+1}`;};
  c.habitMonthSummaryHtml=(habit,y,m)=>`summary ${y}-${m+1}`;
  c.toggleHabitDate=(...args)=>events.push(args);
  const begin=source.indexOf('function shiftHabitHistoryMonth(');
  vm.runInContext(source.slice(begin,source.indexOf('function openHabitProgress(',begin)),c);
  c.shiftHabitHistoryMonth(-1);
  assert.equal(modal.scrollTop,425);assert.equal(label.textContent,'2026년 8월');assert.equal(calendar.innerHTML,'2026-8');assert.equal(summary.textContent,'summary 2026-8');
  const event={stopped:false,stopPropagation(){this.stopped=true;}};
  button.click(event);button.click(event);assert.equal(event.stopped,true);assert.deepEqual(events,[['h1','2026-08-15'],['h1','2026-08-15']]);
  c.shiftHabitHistoryMonth(1);assert.equal(modal.scrollTop,425);assert.equal(label.textContent,'2026년 9월');
  c.habitHistoryMonth={y:2026,m:0};c.shiftHabitHistoryMonth(-1);assert.equal(label.textContent,'2025년 12월');
  c.SESSION.userId='someone-else';c.shiftHabitHistoryMonth(1);assert.equal(label.textContent,'2025년 12월');
});

test('popup calendars keep six week rows across short and long months without adding dates',()=>{
  const c=cardHarness(),habit={id:'h1',startDate:'2026-01-01',checkedDates:[]};
  const begin=source.indexOf('function habitHistoryCalendarHtml(');
  vm.runInContext(source.slice(begin,source.indexOf('function habitGoalProgress(',begin)),c);
  for(const [year,month,days] of [[2027,1,28],[2026,7,31],[2026,8,30]]){
    const html=c.habitHistoryCalendarHtml(habit,year,month,true);
    assert.equal((html.match(/class="habit-hist-cell /g)||[]).length,42);
    assert.equal((html.match(/<span>\d+<\/span>/g)||[]).length,days);
    assert.match(html,/class="habit-hist-grid is-stable-weeks"/);
  }
  const inline=c.habitHistoryCalendarHtml(habit,2027,1);
  assert.equal((inline.match(/class="habit-hist-cell /g)||[]).length,28);
});
