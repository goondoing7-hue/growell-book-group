'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const calendar=require('../archiveCalendar.js'),domain=require('../archiveDomain.js');
const source=fs.readFileSync(path.join(__dirname,'../archiveCalendar.js'),'utf8');
const row=(id,changes={})=>({entry:{id,userId:'reader'},book:{title:'테스트 '+id,coverUrl:'',status:'completed',startDate:'2026-09-01',endDate:'2026-09-10',deleted:false,...changes}});
const copy=value=>JSON.parse(JSON.stringify(value));
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('summary counts only registered nondeleted books and explicitly dated completions in the requested month/year',()=>{
 const rows=[row('this'),row('earlier',{startDate:'2026-08-01',endDate:'2026-08-10'}),row('last-year',{startDate:'2025-09-01',endDate:'2025-09-20'}),
  row('current',{status:'reading',endDate:''}),row('undated',{startDate:'',endDate:''}),row('invalid',{endDate:'2026-09-31'}),row('planned',{status:'unread',endDate:'2026-09-10'}),row('deleted',{deleted:true})];
 const before=copy(rows);assert.deepEqual(calendar.summary(rows,'2026-09-28'),{total:7,monthCompleted:1,reading:1,yearCompleted:2});
 assert.deepEqual(calendar.summary(rows,'2025-09-01'),{total:7,monthCompleted:1,reading:1,yearCompleted:1});
 assert.deepEqual(calendar.summary(rows.concat(rows[0]),'2026-08-01'),{total:7,monthCompleted:1,reading:1,yearCompleted:2});
 assert.deepEqual(rows,before);
});

test('reading periods split across Monday weeks with inclusive start/end and distinct overlapping lanes',()=>{
 const rows=[row('long',{startDate:'2026-08-28',endDate:'2026-09-09'}),row('overlap',{startDate:'2026-09-02',endDate:'2026-09-05'}),row('after',{startDate:'2026-09-06',endDate:'2026-09-06'}),row('outside',{startDate:'2026-10-01',endDate:'2026-10-03'})];
 const model=calendar.layoutMonth(rows,2026,9,'2026-09-28');
 assert.equal(model.weeks.length,6);assert.equal(model.weeks[0].days[0].date,'2026-08-31');assert.equal(model.weeks[0].days[1].date,'2026-09-01');
 const first=model.weeks[0].segments;assert.equal(first.length,3);
 assert.deepEqual(first.map(s=>[s.id,s.startCol,s.endCol,s.lane]),[['long',1,6,0],['overlap',2,5,1],['after',6,6,1]]);
 assert.equal(first[0].continuesBefore,true);assert.equal(first[0].continuesAfter,true);
 const next=model.weeks[1].segments[0];assert.equal(next.id,'long');assert.equal(next.startCol,0);assert.equal(next.endCol,2);assert.equal(next.continuesAfter,false);
 assert.equal(model.weeks.flatMap(w=>w.segments).some(s=>s.id==='outside'),false);
 for(const week of model.weeks)for(const segment of week.segments)for(const other of week.segments){if(segment===other||segment.lane!==other.lane)continue;assert.ok(segment.endCol<other.startCol||other.endCol<segment.startCol);}
});

test('ongoing reading extends visually only through today and absent dates are never inferred or stored',()=>{
 const rows=[row('reading',{status:'reading',startDate:'2026-09-10',endDate:''}),row('start-only',{startDate:'2026-09-12',endDate:''}),row('end-only',{startDate:'',endDate:'2026-09-20'}),row('none',{startDate:'',endDate:''}),row('wrong',{startDate:'2026-09-18',endDate:'2026-09-01'})];
 const before=copy(rows),model=calendar.layoutMonth(rows,2026,9,'2026-09-15'),segments=model.weeks.flatMap(w=>w.segments);
 const reading=segments.filter(s=>s.id==='reading');assert.equal(reading.length,2);assert.equal(reading[0].span.openEnd,true);assert.equal(new Date(reading[0].span.end*86400000).toISOString().slice(0,10),'2026-09-15');
 for(const id of ['start-only','end-only']){const marker=segments.filter(s=>s.id===id);assert.equal(marker.length,1);assert.equal(marker[0].startCol,marker[0].endCol);assert.equal(marker[0].span.partial,true);}
 assert.equal(model.undated,2);assert.deepEqual(rows,before);assert.equal(model.summary.monthCompleted,2,'completion count uses explicit valid end dates even when start is corrupt');
});

test('leap February and December boundaries use exact calendar dates with stable six-week geometry',()=>{
 const leap=calendar.layoutMonth([row('leap',{startDate:'2024-02-29',endDate:'2024-03-02'})],2024,2,'2024-02-29');
 assert.equal(leap.weeks.flatMap(w=>w.days).filter(d=>d.inMonth).length,29);assert.equal(leap.weeks.flatMap(w=>w.days).find(d=>d.today).date,'2024-02-29');
 assert.equal(leap.weeks.flatMap(w=>w.segments)[0].continuesAfter,true);
 const ordinary=calendar.layoutMonth([],2025,2,'2025-02-10');assert.equal(ordinary.weeks.flatMap(w=>w.days).filter(d=>d.inMonth).length,28);
 assert.equal(calendar.layoutMonth([],2026,12,'2026-12-31').weeks.length,6);
 for(const params of [[2026,0],[2026,13],[0,9],[2026.5,9]])assert.throws(()=>calendar.layoutMonth([],params[0],params[1]));
});

test('dominant cover colors ignore transparent/paper pixels and muted fallbacks are stable',()=>{
 const pixels=[];for(let i=0;i<10;i++)pixels.push(230,60,65,255);for(let i=0;i<50;i++)pixels.push(255,255,255,255);for(let i=0;i<50;i++)pixels.push(0,0,0,0);
 const color=calendar.colorFromPixels(pixels);assert.match(color,/^#[0-9a-f]{6}$/);assert.ok(parseInt(color.slice(1,3),16)>parseInt(color.slice(3,5),16));
 assert.equal(calendar.colorFromPixels([255,255,255,255]),null);
 assert.equal(calendar.fallbackColor('book-key'),calendar.fallbackColor('book-key'));assert.match(calendar.fallbackColor('book-key'),/^#[0-9a-f]{6}$/);
});

function harness(extra={}){
 const nodes=[],popups=new Map(),focus=[],opened=[];let owner='reader',allowed=true;
 function control(dataset){return {dataset,isConnected:true,style:{values:{},setProperty(key,value){this.values[key]=value;}},focus:options=>focus.push(options)};}
 const document={body:{appendChild(node){nodes.push(node);}},createElement(tag){
  assert.equal(tag,'dialog');const events={},closeButton=control({});let shifts=[],books=[];
  const body={_html:'',set innerHTML(value){this._html=value;shifts=[...value.matchAll(/data-calendar-shift="(-?\d+)"/g)].map(m=>control({calendarShift:m[1]}));books=[...value.matchAll(/data-calendar-book="([^"]+)"/g)].map(m=>control({calendarBook:m[1]}));},get innerHTML(){return this._html;}};
  return {open:false,removed:false,scrollTop:0,innerHTML:'',setAttribute(){},querySelector(selector){if(selector==='[data-calendar-body]')return body;if(selector==='[data-calendar-close]')return closeButton;const match=selector.match(/data-calendar-shift="(-?\d+)"/);return match?shifts.find(b=>b.dataset.calendarShift===match[1]):null;},querySelectorAll(selector){return selector==='[data-calendar-shift]'?shifts:selector==='[data-calendar-book]'?books:[];},addEventListener:(name,handler)=>events[name]=handler,showModal(){this.open=true;},close(){this.open=false;},remove(){this.removed=true;},cancel(){events.cancel({preventDefault(){}});},get body(){return body;}};
 }};
 const c={document,Date,Map,Set,Promise,setTimeout,clearTimeout,GrowellArchiveDomain:domain,GrowellPopupHistory:{open:(key,options)=>popups.set(key,options),closed:key=>popups.delete(key)},...extra};vm.createContext(c);vm.runInContext(source,c);
 return {api:c.GrowellArchiveCalendar,nodes,popups,focus,opened,c,open(rows){this.api.open({rows,ownerId:'reader',getOwnerId:()=>owner,isCurrent:()=>allowed,now:'2026-09-28',onSelect:(id,trigger)=>opened.push({id,trigger}),trigger:control({})});},setOwner:value=>owner=value,setAllowed:value=>allowed=value};
}

test('calendar popup keeps selected month/scroll on refresh and book clicks open their reading record',async()=>{
 const h=harness();h.open([row('owned'),{...row('foreign'),entry:{id:'foreign',userId:'other'}}]);const node=h.nodes[0];
 assert.equal(node.open,true);assert.match(node.body.innerHTML,/2026년 9월/);assert.doesNotMatch(node.body.innerHTML,/foreign/);
 node.querySelectorAll('[data-calendar-book]')[0].onclick();assert.equal(h.opened[0].id,'owned');assert.equal(node.open,true);
 node.scrollTop=123;node.querySelector('[data-calendar-shift="-1"]').onclick();assert.match(node.body.innerHTML,/2026년 8월/);assert.equal(node.scrollTop,123);assert.equal(h.focus.at(-1).preventScroll,true);
 h.api.refresh([row('owned',{startDate:'2026-08-01',endDate:'2026-08-20'})]);assert.match(node.body.innerHTML,/2026년 8월/);assert.match(node.body.innerHTML,/data-calendar-book="owned"/);assert.equal(node.scrollTop,123);
 h.popups.get('archive-calendar').close();assert.equal(node.open,false);assert.equal(node.removed,true);assert.equal(h.focus.at(-1).preventScroll,true);assert.equal(h.popups.has('archive-calendar'),false);
});

test('owner/key invalidation closes the calendar and stale book callbacks cannot open former-owner data',()=>{
 for(const invalidate of [h=>h.setOwner('other'),h=>h.setAllowed(false)]){
  const h=harness();h.open([row('private')]);const node=h.nodes[0],button=node.querySelectorAll('[data-calendar-book]')[0];invalidate(h);button.onclick();
  assert.equal(node.open,false);assert.equal(node.removed,true);assert.equal(h.opened.length,0);assert.equal(h.focus.length,0);
 }
 const h=harness();h.open([row('private')]);h.api.reset();assert.equal(h.nodes[0].removed,true);h.open([row('another')]);h.nodes[1].cancel();assert.equal(h.nodes[1].open,false);
});

test('cover CORS errors leave a stable muted line and never prevent calendar interaction',async()=>{
 class Image {set src(value){this.url=value;queueMicrotask(()=>this.onerror&&this.onerror());}}
 const h=harness({Image});h.open([row('remote',{coverUrl:'https://image.yes24.com/goods/1/L'})]);await flush();
 const buttons=h.nodes[0].querySelectorAll('[data-calendar-book]');assert.ok(buttons.length);
 for(const button of buttons)assert.equal(button.style.values['--calendar-book-color'],calendar.fallbackColor('remote|테스트 remote'));
 buttons[0].onclick();assert.equal(h.opened[0].id,'remote');h.api.reset();
});

test('a CORS-readable cover paints its extracted dominant color without changing the selected month or scroll',async()=>{
 const images=[],pixels=new Uint8ClampedArray([30,140,90,255,32,142,92,255,255,255,255,255]);
 class Image {constructor(){images.push(this);}set src(value){this.url=value;queueMicrotask(()=>this.onload&&this.onload());}}
 const h=harness({Image}),create=h.c.document.createElement;
 h.c.document.createElement=tag=>tag==='canvas'?{getContext:()=>({drawImage(){},getImageData:()=>({data:pixels})})}:create(tag);
 h.open([row('green',{coverUrl:'https://image.yes24.com/goods/2/L'})]);const node=h.nodes[0];node.scrollTop=81;await flush();
 assert.equal(images[0].crossOrigin,'anonymous');assert.equal(images[0].referrerPolicy,'no-referrer');
 for(const button of node.querySelectorAll('[data-calendar-book]'))assert.equal(button.style.values['--calendar-book-color'],calendar.colorFromPixels(pixels));
 assert.match(node.body.innerHTML,/2026년 9월/);assert.equal(node.scrollTop,81);h.api.reset();
});

test('book labels are escaped in calendar markup while actual IDs remain actionable',()=>{
 const h=harness();h.open([row('safe',{title:'<img src=x onerror=alert(1)> "책"'})]);
 const markup=h.nodes[0].body.innerHTML;assert.doesNotMatch(markup,/<img/);assert.match(markup,/&lt;img/);assert.match(markup,/&quot;책&quot;/);
 h.api.reset();
});
