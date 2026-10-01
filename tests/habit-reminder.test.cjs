'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const reminder=require('../habitReminder.js');

const publicUrl='https://growell-book.vercel.app/#/book/emotion/habit';
const habit=(extra={})=>({name:'독서',behaviorType:'do',goal:'하루 10쪽',time:'저녁 9시',place:'집',bookTitle:'테스트 책',startDate:'2026-10-02',endDate:'2026-10-31',url:publicUrl,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};};
const error=name=>Object.assign(new Error('test failure'),{name});
function harness(nav={},extra={}){
  let current=habit();const events=[],results=[],previews=[];
  const actions=reminder.createActions({navigator:nav,secure:true,getHabit:()=>current,
    onPreview:data=>{previews.push(data);events.push('preview');},
    onBusy:value=>events.push('busy:'+value),onInvalid:()=>events.push('invalid'),
    onResult:(state,target,data)=>{results.push({state,target,data});events.push(state);},...extra});
  return {actions,events,results,previews,setCurrent:value=>{current=value;}};
}

test('reminder payload contains only visible habit details and leaves the private source unchanged',()=>{
  const input=Object.freeze(habit({name:'  독서\n 습관\t',behaviorType:'avoid',goal:' 하루\r\n 10쪽 ',time:'\u0000저녁\u007f 9시',
    id:'PRIVATE_HABIT_ID',userId:'PRIVATE_OWNER',password:'PRIVATE_PASSWORD',token:'PRIVATE_TOKEN',
    privateNotes:'PRIVATE_NOTE',checks:Object.freeze({'2026-10-01':true}),readingGoal:Object.freeze({bookId:'PRIVATE_BOOK_ID'})}));
  const before=JSON.stringify(input),data=reminder.buildShareData(input);
  assert.deepEqual(data,{title:'독서 습관',text:'독서 습관\n절제할 습관\n목표: 하루 10쪽\n시간: 저녁 9시\n장소: 집\n읽을 책: 테스트 책\n시작일: 2026-10-02\n목표일: 2026-10-31',url:publicUrl});
  assert.doesNotMatch(JSON.stringify(data),/PRIVATE_|checks|readingGoal/);
  assert.equal(JSON.stringify(input),before);
});

test('missing names reject export while optional fields accept only bounded strings',()=>{
  for(const input of [null,undefined,{},habit({name:''}),habit({name:' \n\t '}),habit({name:123})])assert.equal(reminder.buildShareData(input),null);
  const data=reminder.buildShareData(habit({name:'가'.repeat(220),goal:'나'.repeat(520),time:42,place:{secret:'private'},bookTitle:['private'],startDate:'today',endDate:'2026/10/31',url:''}));
  assert.equal(data.title.length,200);assert.equal(data.text.split('\n')[2],'목표: '+'나'.repeat(500));
  assert.equal(data.text.split('\n').length,3);assert.deepEqual(Object.keys(data),['title','text']);
  assert.match(reminder.buildShareData(habit({behaviorType:'unknown'})).text,/\n실천할 습관\n/);
});

test('only clean public habit routes are attached as URLs',()=>{
  const allowed=[publicUrl,'https://growell-book.vercel.app/#/book/thought/habit','https://growell-book.vercel.app/#/book/body/habit','https://growell-book.vercel.app/#/book/action/habit',
    'http://localhost:8681/#/book/emotion/habit','http://127.0.0.1:8681/#/book/emotion/habit','http://[::1]:8681/#/book/emotion/habit'];
  for(const url of allowed)assert.equal(reminder.buildShareData(habit({url})).url,url,url);
  const rejected=[null,'','not a URL','/','#/book/emotion/habit',
    'https://growell-book.vercel.app/?token=PRIVATE_TOKEN#/book/emotion/habit',
    'https://PRIVATE_OWNER:PRIVATE_PASSWORD@growell-book.vercel.app/#/book/emotion/habit',
    'https://growell-book.vercel.app/private/PRIVATE_ID#/book/emotion/habit',
    'https://growell-book.vercel.app/#/book/emotion/habit/PRIVATE_ID',
    'https://growell-book.vercel.app/#/book/emotion/habit?token=PRIVATE_TOKEN',
    'https://growell-book.vercel.app/#/book/emotion/mine',
    'https://growell-book.vercel.app/#/book/private/habit',
    'https://growell-book.vercel.app/#/book/emotion/habit\nPRIVATE_NOTE',
    'http://growell-book.vercel.app/#/book/emotion/habit',
    'http://localhost.example.com/#/book/emotion/habit',
    'file:///private/#/book/emotion/habit','javascript:alert(1)','data:text/plain,private'];
  for(const url of rejected){const data=reminder.buildShareData(habit({url}));assert.equal(data.url,undefined,String(url));assert.doesNotMatch(data.text,/PRIVATE_/);}
});

test('copy text contains the sanitized details and only an approved URL',()=>{
  const data=reminder.buildShareData(habit());assert.equal(reminder.copyText(data),data.text+'\n\n'+publicUrl);
  const noUrl=reminder.buildShareData(habit({url:'https://growell-book.vercel.app/?token=PRIVATE_TOKEN'}));
  assert.equal(reminder.copyText(noUrl),noUrl.text);assert.doesNotMatch(reminder.copyText(noUrl),/PRIVATE_TOKEN/);
});

test('sharing invokes the native API immediately and takes a new snapshot for each click',async()=>{
  const sent=[];let insideClick=false,box;
  box=harness({canShare:data=>{assert.equal(insideClick,true);assert.equal(data.title,sent.length?'산책':'독서');return true;},share:data=>{
    assert.equal(insideClick,true);box.events.push('native-share');sent.push(data);return Promise.resolve();
  }});
  insideClick=true;const first=box.actions.share('samsung');insideClick=false;
  assert.equal(sent.length,1);assert.deepEqual(box.events,['preview','busy:true','native-share']);await first;
  assert.equal(box.results[0].state,'handed-off');assert.equal(box.results[0].target,'samsung');assert.equal(box.events.at(-1),'busy:false');
  box.setCurrent(habit({name:'산책',goal:'10분 걷기'}));insideClick=true;const second=box.actions.share('apple');insideClick=false;await second;
  assert.equal(sent[1].title,'산책');assert.match(sent[1].text,/목표: 10분 걷기/);assert.equal(box.results[1].target,'apple');assert.notEqual(sent[0],sent[1]);
});

test('unsupported, insecure and rejected share data expose the manual fallback without invoking native share',async()=>{
  let nativeCalls=0;
  for(const setup of [()=>harness(),()=>harness({share:()=>nativeCalls++},{secure:false}),()=>harness({canShare:()=>false,share:()=>nativeCalls++}),()=>harness({canShare:()=>{throw error('TypeError');},share:()=>nativeCalls++})]){
    const box=setup();await box.actions.share('apple');assert.equal(box.results.length,1);assert.equal(box.results[0].state,'unavailable');assert.equal(box.results[0].target,'apple');assert.equal(box.previews.length,1);
  }
  assert.equal(nativeCalls,0);
});

test('unknown app targets do not preview or export a habit',async()=>{
  let reads=0,calls=0;const box=harness({share:()=>calls++},{getHabit:()=>{reads++;return habit();}});
  for(const target of ['',null,undefined,'mail','APPLE','__proto__'])await box.actions.share(target);
  assert.equal(reads,0);assert.equal(calls,0);assert.deepEqual(box.events,[]);
});

test('native cancellation is distinct from synchronous and asynchronous share errors',async()=>{
  for(const [name,expected] of [['AbortError','cancelled'],['NotAllowedError','unavailable'],['TypeError','unavailable'],['DataError','unavailable']]){
    for(const synchronous of [true,false]){
      const box=harness({share:()=>{if(synchronous)throw error(name);return Promise.reject(error(name));}});
      await box.actions.share('samsung');assert.equal(box.results.length,1);assert.equal(box.results[0].state,expected);assert.equal(box.events.filter(event=>event.startsWith('busy:')).at(-1),'busy:false');
    }
  }
});

test('copy uses a fresh snapshot and reports completion only after the clipboard resolves',async()=>{
  const pending=deferred(),writes=[];const box=harness({clipboard:{writeText:text=>{writes.push(text);return pending.promise;}}});
  box.setCurrent(habit({name:'기도',goal:'감사 한 가지'}));const copy=box.actions.copy();
  assert.equal(writes.length,1);assert.match(writes[0],/^기도\n/);assert.match(writes[0],/목표: 감사 한 가지/);assert.deepEqual(box.events,['preview','busy:true']);
  pending.resolve();await copy;assert.equal(box.results[0].state,'copied');assert.equal(box.results[0].target,'');assert.equal(box.events.at(-1),'busy:false');
});

test('missing or failing clipboard support falls back to selecting text manually',async()=>{
  for(const nav of [{},{clipboard:{}},{clipboard:{writeText:()=>{throw error('NotAllowedError');}}},{clipboard:{writeText:()=>Promise.reject(error('NotAllowedError'))}}]){
    const box=harness(nav);await box.actions.copy();assert.equal(box.results.length,1);assert.equal(box.results[0].state,'copy-manually');assert.equal(box.previews.length,1);assert.equal(box.results[0].data.title,'독서');
  }
});

test('an outstanding share blocks duplicate sharing and copying until it finishes',async()=>{
  const pending=deferred();let shares=0,copies=0;const box=harness({share:()=>{shares++;return pending.promise;},clipboard:{writeText:()=>{copies++;return Promise.resolve();}}});
  const first=box.actions.share('apple');await box.actions.share('apple');await box.actions.share('samsung');await box.actions.copy();
  assert.equal(shares,1);assert.equal(copies,0);assert.equal(box.previews.length,1);
  pending.resolve();await first;await box.actions.copy();assert.equal(copies,1);assert.equal(box.results.at(-1).state,'copied');
});

test('an outstanding copy also blocks sharing and copying, and failure releases the lock',async()=>{
  const pending=deferred();let shares=0,copies=0;const box=harness({share:()=>{shares++;return Promise.resolve();},clipboard:{writeText:()=>{copies++;return pending.promise;}}});
  const first=box.actions.copy();await box.actions.copy();await box.actions.share('samsung');assert.equal(copies,1);assert.equal(shares,0);
  pending.reject(error('NotAllowedError'));await first;await box.actions.share('apple');assert.equal(shares,1);assert.deepEqual(box.results.map(result=>result.state),['copy-manually','handed-off']);
});

test('invalid or inaccessible current habits invalidate actions before any export',async()=>{
  for(const getHabit of [()=>null,()=>habit({name:' '}),()=>{throw error('InvalidStateError');}]){
    let exports=0;const box=harness({share:()=>exports++,clipboard:{writeText:()=>exports++}},{getHabit});
    await box.actions.share('apple');await box.actions.copy();assert.equal(box.actions.snapshot(),null);assert.equal(exports,0);assert.deepEqual(box.events,['invalid']);
  }
});

test('disposing an outstanding action suppresses late success, errors, previews and busy callbacks',async()=>{
  for(const action of ['share','copy'])for(const outcome of ['resolve','reject']){
    const pending=deferred();let exports=0,reads=0;
    const box=harness({share:()=>{exports++;return pending.promise;},clipboard:{writeText:()=>{exports++;return pending.promise;}}},{getHabit:()=>{reads++;return habit();}});
    const request=action==='share'?box.actions.share('apple'):box.actions.copy();assert.equal(reads,1);box.actions.dispose();const before=[...box.events];
    if(outcome==='resolve')pending.resolve();else pending.reject(error('NotAllowedError'));await request;
    await box.actions.share('samsung');await box.actions.copy();assert.equal(box.actions.snapshot(),null);
    assert.deepEqual(box.events,before);assert.equal(box.results.length,0);assert.equal(exports,1);assert.equal(reads,1);
  }
});

test('loss of the owner-checked snapshot prevents late results from reaching a different session',async()=>{
  for(const action of ['share','copy'])for(const outcome of ['resolve','reject']){
    const pending=deferred();let exports=0;const box=harness({share:()=>{exports++;return pending.promise;},clipboard:{writeText:()=>{exports++;return pending.promise;}}});
    const request=action==='share'?box.actions.share('apple'):box.actions.copy();box.setCurrent(null);
    if(outcome==='resolve')pending.resolve();else pending.reject(error('NotAllowedError'));await request;
    assert.deepEqual(box.events,['preview','busy:true','invalid']);assert.equal(box.results.length,0);
    box.setCurrent(habit({name:'다른 회원의 습관'}));await box.actions.share('samsung');await box.actions.copy();
    assert.equal(exports,1);assert.deepEqual(box.events,['preview','busy:true','invalid']);assert.equal(box.actions.snapshot(),null);
  }
});
