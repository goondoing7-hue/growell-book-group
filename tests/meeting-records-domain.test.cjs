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
    materialIds:['mn_m12example'],nextMeeting:null,status:'published',userId:'operator-profile',revision:2,
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
  assert.equal(first.nextMeeting,null);
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

test('optional next meeting preparation preserves legacy records and exact editable text',()=>{
  const legacy=record();delete legacy.nextMeeting;
  assert.equal(domain.validateRecord(legacy).ok,true);
  assert.equal(domain.normalizeRecord(legacy).nextMeeting,null);
  const nextMeeting={date:'2026-10-24',time:'13:30',place:'추후 안내',reading:'1부 1장, 64쪽까지',sharing:'  나눔 글 1편\n\n읽으며 떠오른 생각  ',habit:'자신의 속도로 읽기'};
  const original=record({nextMeeting}),copy=domain.normalizeRecord(original);
  assert.equal(domain.validateRecord(copy).ok,true);
  assert.deepEqual(copy.nextMeeting,nextMeeting);
  copy.nextMeeting.sharing='다른 안내';
  assert.equal(original.nextMeeting.sharing,nextMeeting.sharing);
  assert.equal(domain.validateRecord(record({nextMeeting:{date:'',time:'',place:'',reading:'',sharing:'',habit:''}})).ok,true);
});

test('optional preparation end time preserves omission and rejects invalid or reversed ranges',()=>{
  const nextMeeting={date:'2026-11-07',time:'13:30',place:'모임 장소',reading:'2장',sharing:'',habit:''};
  const legacy=domain.normalizeRecord(record({nextMeeting}));
  assert.equal(Object.hasOwn(legacy.nextMeeting,'endTime'),false);
  for(const endTime of ['', '15:00','23:59']){
    const value=record({nextMeeting:{...nextMeeting,endTime}});
    assert.equal(domain.validateRecord(value).ok,true);assert.deepEqual(domain.normalizeRecord(value).nextMeeting,value.nextMeeting);
  }
  for(const endTime of ['13:30','13:29','00:00','24:00','15:60','3:00',null,15,{},undefined,'15:00\u0000']){
    assert.equal(domain.validateRecord(record({nextMeeting:{...nextMeeting,endTime}})).ok,false,String(endTime));
  }
  assert.equal(domain.validateRecord(record({nextMeeting:{...nextMeeting,time:'',endTime:'15:00'}})).ok,true);
});

test('preparation rejects invalid dates, times, shapes and oversized text without coercing or truncating',()=>{
  const good={date:'2024-02-29',time:'00:00',place:'',reading:'',sharing:'',habit:''};
  assert.equal(domain.validateRecord(record({nextMeeting:good})).ok,true);
  for(const nextMeeting of [[],42,'text']) assert.equal(domain.validateRecord(record({nextMeeting})).ok,false);
  for(const fields of [{date:'2026-02-29'},{date:'0000-01-01'},{time:'24:00'},{time:'9:30'},{time:'13:60'},
    {place:null},{reading:[]},{sharing:undefined},{habit:42},{unknown:'extra'},
    {place:'가'.repeat(1001)},{reading:'가'.repeat(4001)},{sharing:'\u0000'}]){
    const value=record({nextMeeting:{...good,...fields}});
    assert.equal(domain.validateRecord(domain.normalizeRecord(value)).ok,false,JSON.stringify(fields));
    assert.deepEqual(domain.normalizeRecord(value).nextMeeting,value.nextMeeting);
  }
  assert.equal(domain.validateRecord(record({nextMeeting:{...good,place:'😀'.repeat(1000),sharing:'😀'.repeat(4000)}})).ok,true);
});

test('optional thought questions preserve legacy omission, exact text, stable IDs and draft blanks',()=>{
  const legacy=record(),copy=domain.normalizeRecord(legacy);
  assert.equal(Object.hasOwn(copy,'thoughtQuestions'),false,'omitted legacy fields must stay omitted on saves');
  const thoughtQuestions=[{id:'question-1',text:'  감정을 어떻게 바라보는가?\n다른 생각은 무엇인가?  '},{id:'question-2',text:'😀'.repeat(1000)}];
  const source=record({thoughtQuestions}),before=JSON.stringify(source),normalized=domain.normalizeRecord(source);
  assert.equal(domain.validateRecord(normalized).ok,true);assert.deepEqual(normalized.thoughtQuestions,thoughtQuestions);
  normalized.thoughtQuestions[0].text='다른 질문';assert.equal(JSON.stringify(source),before);
  assert.deepEqual(domain.newRecord('emotion','operator').thoughtQuestions,[]);
  assert.equal(domain.validateRecord(record({status:'draft',thoughtQuestions:[{id:'question-1',text:''}]})).ok,true);
  assert.equal(domain.validateRecord(record({thoughtQuestions:[{id:'question-1',text:'  '}]})).ok,false);
});

test('thought questions reject malformed, duplicate, unknown and oversized input without shortening',()=>{
  const question={id:'question-1',text:'나의 감정은 무엇을 알려주는가?'};
  for(const thoughtQuestions of [null,{},'text',[null],[{text:'ID 없음'}],[{id:'../unsafe',text:'질문'}],
    [question,question],[{...question,text:'가'.repeat(1001)}],[{...question,text:'원문\u0000'}],
    [{...question,answer:'허용되지 않은 응답'}],Array.from({length:31},(_,i)=>({...question,id:'question-'+i}))]){
    const source=record({thoughtQuestions});assert.equal(domain.validateRecord(domain.normalizeRecord(source)).ok,false);
    assert.deepEqual(domain.normalizeRecord(source).thoughtQuestions,thoughtQuestions);
  }
});

test('topic questions are presentation-only first-line prefixes and preserve the remaining exact body',()=>{
  const detail='생각 질문: 내 감정은 무엇을 알려주는가?\n\n  원문 본문\n\n다음 문장이다.  ';
  assert.deepEqual(domain.detailParts(detail),{question:'내 감정은 무엇을 알려주는가?',body:'  원문 본문\n\n다음 문장이다.  '});
  assert.deepEqual(domain.detailParts('생각 질문: 질문이다.\r\n\r\n본문\r\n  '),{question:'질문이다.',body:'본문\r\n  '});
  assert.deepEqual(domain.detailParts('생각 질문: 단독 질문이다.'),{question:'단독 질문이다.',body:''});
  assert.deepEqual(domain.detailParts('생각 질문: <b>글자 그대로</b>\n본문'),{question:'<b>글자 그대로</b>',body:'본문'});
  for(const source of ['원문 첫 줄\n생각 질문: 질문',' 생각 질문: 질문\n본문','생각 질문: \n\n본문','생각 질문:   \n본문','생각 질문: '+ '😀'.repeat(1001)+'\n본문'])
    assert.deepEqual(domain.detailParts(source),{question:'',body:source});
  assert.equal(domain.detailParts('생각 질문: '+'😀'.repeat(1000)+'\n본문').question,'😀'.repeat(1000));
  const row=record({sections:[{id:'one',summary:'주제',detail}]}),before=JSON.stringify(row);domain.detailParts(row.sections[0].detail);
  assert.equal(JSON.stringify(row),before);
});
