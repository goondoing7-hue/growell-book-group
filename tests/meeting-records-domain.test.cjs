const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const domain=require('../meetingRecordsDomain.js');
const id=n=>'c3000000-0000-4000-8000-'+String(n).padStart(12,'0');
function record(extra={}){
  return {
    id:id(1),bookId:'emotion',round:1,date:'2026-10-11',topic:'감정을 이해하는 첫 모임',
    sections:[{id:id(2),summary:'감정은 내 마음을 알려주는 신호입니다.',detail:'첫 문단입니다.\n\n  두 번째 문단과 여백도 보존합니다.  '}],
    concepts:[{id:id(3),word:'핵심 감정',meaning:'내 마음에서 자주 되풀이되는 감정입니다.'}],
    materialIds:['mn_m12example'],status:'published',userId:'operator-profile',revision:2,
    createdAt:'2026-10-10T00:00:00+00:00',updatedAt:'2026-10-11T14:30:00.123456+09:00',...extra
  };
}

test('new drafts have distinct stable UUIDs without fabricated content or server timestamps',()=>{
  const first=domain.newRecord('emotion','operator-profile'),second=domain.newRecord('emotion','operator-profile');
  assert.notEqual(first.id,second.id);
  assert.ok(domain.isUuid(first.id));
  assert.deepEqual(first.sections,[]);
  assert.deepEqual(first.concepts,[]);
  assert.deepEqual(first.materialIds,[]);
  assert.equal(first.createdAt,null);
  assert.equal(first.updatedAt,null);
  assert.equal(first.revision,0);
  assert.equal(domain.validateRecord(first).ok,true);
  assert.equal(domain.normalizeRecord(first).id,first.id);
  assert.equal(domain.validateRecord(domain.newRecord('emotion')).ok,false,'owner must be supplied before saving');
});

test('normalization deep-clones editable data without trimming, dropping text, or changing IDs',()=>{
  const original=record({topic:'  원래 제목  ',sections:[{id:id(2),summary:'😀 요약',detail:'<script>alert(1)</script>\n\n  문자열은 렌더러가 안전하게 표시합니다.  '}]});
  const snapshot=JSON.stringify(original);
  const copy=domain.normalizeRecord(original);
  assert.deepEqual(copy,original);
  assert.notEqual(copy.sections,original.sections);
  assert.notEqual(copy.sections[0],original.sections[0]);
  copy.sections[0].summary='변경된 요약';
  copy.concepts[0].meaning='변경된 의미';
  copy.materialIds.push(id(5));
  assert.equal(JSON.stringify(original),snapshot);
  assert.equal(copy.sections[0].detail,original.sections[0].detail,'renaming a section does not disturb its body');
  assert.equal(domain.validateRecord(original).ok,true,'stored text is not rewritten as HTML');
});

test('malformed rows cannot become valid records through normalization',()=>{
  for(const value of [null,undefined,[],true,42,'record',new Date()]) assert.equal(domain.normalizeRecord(value),null);
  for(const change of [
    {id:undefined},{round:'1'},{revision:'2'},{revision:NaN},{status:'invalid'},
    {sections:'not an array'},{concepts:{}},{materialIds:null},{topic:123},{date:{}},
    {sections:[null]},{concepts:[{id:id(3),word:['bad'],meaning:'설명'}]}
  ]) assert.equal(domain.validateRecord(domain.normalizeRecord(record(change))).ok,false,JSON.stringify(change));
  assert.equal(domain.validateRecord(domain.normalizeRecord({})).ok,false);
  assert.equal(domain.validateRecord(record({revision:Number.MAX_SAFE_INTEGER})).ok,false);
  assert.equal(domain.validateRecord(Object.create(record())).ok,false,'class/prototype payloads are not records');
});

test('drafts accept incomplete content, while publishing requires each entered section and concept',()=>{
  const draft=record({status:'draft',date:null,topic:'',sections:[],concepts:[]});
  assert.equal(domain.validateRecord(draft).ok,true);
  assert.equal(domain.normalizeRecord({...draft,date:''}).date,null,'empty form date becomes the nullable server date');
  assert.equal(domain.validateRecord({...draft,status:'published'}).ok,false);
  const incomplete=record({status:'draft',sections:[{id:id(2),summary:'',detail:''}],concepts:[{id:id(3),word:'',meaning:''}]});
  assert.equal(domain.validateRecord(incomplete).ok,true);
  assert.equal(domain.validateRecord({...incomplete,status:'published'}).ok,false);
  for(const change of [
    {topic:' \n '},{date:''},{sections:[]},
    {sections:[{id:id(2),summary:'',detail:'본문'}]},
    {sections:[{id:id(2),summary:'요약',detail:'\t'}]},
    {concepts:[{id:id(3),word:'용어',meaning:''}]},
    {concepts:[{id:id(3),word:'',meaning:'설명'}]}
  ]) assert.equal(domain.validateRecord(record(change)).ok,false);
  assert.equal(domain.validateRecord(record({concepts:[],materialIds:[]})).ok,true,'concepts and linked materials are optional');
});

test('calendar dates reject rollover dates and accept Gregorian leap days',()=>{
  for(const date of ['2024-02-29','2000-02-29','2026-12-31','0001-01-01']) assert.equal(domain.validateRecord(record({date})).ok,true,date);
  for(const date of ['2026-02-29','1900-02-29','2026-04-31','2026-13-01','0000-01-01','2026-1-01','2026-01-00','2026-10-11T00:00:00Z']) assert.equal(domain.validateRecord(record({date})).ok,false,date);
  for(const updatedAt of ['2026-02-30T00:00:00Z','2026-10-11T24:00:00Z','2026-10-11T10:61:00Z','2026-10-11','not-a-date',12]) assert.equal(domain.validateRecord(record({updatedAt})).ok,false);
});

test('text size limits match PostgreSQL character counts and preserve Unicode',()=>{
  const fields=[['topic',160],['summary',120],['detail',10000],['word',80],['meaning',4000]];
  for(const [field,max] of fields){
    function withText(text){
      const row=record();
      if(field==='topic') row.topic=text;
      else if(field==='summary'||field==='detail') row.sections[0][field]=text;
      else row.concepts[0][field]=text;
      return row;
    }
    assert.equal(domain.validateRecord(withText('😀'.repeat(max))).ok,true,field+' exact limit');
    assert.equal(domain.validateRecord(withText('가'.repeat(max+1))).ok,false,field+' beyond limit');
    assert.equal(domain.validateRecord(withText('문장\u0000')).ok,false,field+' NUL cannot be stored');
  }
});

test('collection limits, duplicate IDs and required stable node IDs are validated',()=>{
  const sections=Array.from({length:20},(_,i)=>({id:id(100+i),summary:'요약',detail:'본문'}));
  const concepts=Array.from({length:30},(_,i)=>({id:id(200+i),word:'개념',meaning:'의미'}));
  const materialIds=Array.from({length:30},(_,i)=>id(300+i));
  assert.equal(domain.validateRecord(record({sections,concepts,materialIds})).ok,true);
  assert.equal(domain.validateRecord(record({sections:[...sections,{id:id(999),summary:'추가',detail:'내용'}]})).ok,false);
  assert.equal(domain.validateRecord(record({concepts:[...concepts,{id:id(999),word:'추가',meaning:'내용'}]})).ok,false);
  assert.equal(domain.validateRecord(record({materialIds:[...materialIds,id(999)]})).ok,false);
  for(const change of [
    {sections:[sections[0],{...sections[0]}]},
    {concepts:[concepts[0],{...concepts[0]}]},
    {materialIds:['mn_m12example','mn_m12example']},
    {sections:[{summary:'ID가 없는 요약',detail:'내용'}]},
    {concepts:[{id:'unsafe/id',word:'개념',meaning:'의미'}]},
    {materialIds:['https://example.com/private']}
  ]) assert.equal(domain.validateRecord(record(change)).ok,false);
});

test('existing material IDs remain compatible and malformed payload shapes are rejected',()=>{
  assert.equal(domain.validateRecord(record({
    sections:[{id:'section_1',summary:'요약',detail:'본문'}],
    concepts:[{id:'concept-1',word:'개념',meaning:'의미'}],
    materialIds:['mn_m2g59a1abc',id(123),'A'.repeat(120)]
  })).ok,true);
  for(const change of [
    {materialIds:['A'.repeat(121)]},
    {materialIds:['한글 ID']},
    {sections:[{id:'a'.repeat(81),summary:'요약',detail:'본문'}]},
    {sections:[{id:'section_1',summary:'요약',detail:'본문',privateData:'not part of a public record'}]},
    {sections:new Array(1)},
    {materialIds:new Array(1)},
    {unknownField:'unexpected'}
  ]) assert.equal(domain.validateRecord(record(change)).ok,false);
});

test('book, author, round and revision checks reject malformed write identity',()=>{
  for(const bookId of ['emotion','thought','body','action']) assert.equal(domain.validateRecord(record({bookId})).ok,true);
  for(const round of [1,9999]) assert.equal(domain.validateRecord(record({round})).ok,true);
  for(const change of [{bookId:'private'},{round:0},{round:10000},{round:1.5},{userId:''},{userId:null},{userId:'\u0000'},{revision:-1},{revision:1.1}]) assert.equal(domain.validateRecord(record(change)).ok,false);
});

test('browser export produces secure UUIDs with the crypto fallback and no Math.random fallback',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../meetingRecordsDomain.js'),'utf8');
  const context=vm.createContext({crypto:{getRandomValues(bytes){ for(let i=0;i<bytes.length;i++) bytes[i]=i; return bytes; }}});
  vm.runInContext(source,context);
  assert.equal(context.GrowellMeetingRecordsDomain.newId(),'00010203-0405-4607-8809-0a0b0c0d0e0f');
  assert.equal(context.GrowellMeetingRecordsDomain.validateRecord(record()).ok,true,'cross-realm plain objects are supported');
  const unavailable=vm.createContext({});
  vm.runInContext(source,unavailable);
  assert.throws(()=>unavailable.GrowellMeetingRecordsDomain.newId(),/안전한 ID/);
});
