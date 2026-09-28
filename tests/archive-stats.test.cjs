'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const stats=require('../archiveStats.js'),calendar=require('../archiveCalendar.js'),domain=require('../archiveDomain.js'),createPopupHistory=require('../popupHistory.js');
const source=fs.readFileSync(path.join(__dirname,'../archiveStats.js'),'utf8');
const row=(id,changes={},userId='reader')=>({entry:{id,userId},book:{title:'책 '+id,coverUrl:'',authors:['숨겨진 저자'],review:'숨겨진 감상',status:'completed',startDate:'2026-09-01',endDate:'2026-09-10',deleted:false,...changes}});
const kinds=['total','monthCompleted','reading','yearCompleted'];

function harness(){
 const nodes=[],opened=[],focused=[],listeners={},history=[{url:'https://example.test/#/archive',state:null}],pending=[];let owner='reader',ready=true,index=0;
 const browser={location:{href:history[0].url},addEventListener(type,fn){(listeners[type]||=[]).push(fn);},history:{get state(){return history[index].state;},replaceState(state,unused,url){history[index]={state,url};browser.location.href=url;},pushState(state,unused,url){history.splice(index+1);history.push({state,url});index++;browser.location.href=url;},go(step){pending.push(step);}}};
 function back(){browser.history.go(-1);let count=0;while(pending.length){assert.ok(count++<20);const next=index+pending.shift();if(next<0||next>=history.length)continue;index=next;browser.location.href=history[index].url;(listeners.popstate||[]).forEach(fn=>fn({state:history[index].state}));}}
 function control(dataset={}){return {dataset,isConnected:true,innerHTML:'',style:{setProperty(){}},focus(options){focused.push({button:this,options});},replaceWith(old){for(const node of nodes){const at=node.controls.indexOf(this);if(at>=0){node.controls[at]=old;this.isConnected=false;old.isConnected=true;return;}}}};}
 const document={body:{appendChild(node){nodes.push(node);}},createElement(tag){
  assert.equal(tag,'dialog');const events={},closeButton=control();const node={open:false,removed:false,scrollTop:0,innerHTML:'',controls:[],setAttribute(){},showModal(){this.open=true;},close(){this.open=false;},remove(){this.removed=true;this.controls.forEach(c=>c.isConnected=false);},addEventListener(type,fn){events[type]=fn;},cancel(){events.cancel({preventDefault(){}});},querySelectorAll(selector){const key=selector.match(/^\[data-([\w-]+)\]$/);if(!key)return [];const name=key[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return this.controls.filter(c=>name in c.dataset);},querySelector(selector){if(selector==='[data-stats-body]'||selector==='[data-calendar-body]')return body;if(selector==='[data-stats-close]'||selector==='[data-calendar-close]')return closeButton;const match=selector.match(/^\[data-([\w-]+)="([^"]+)"\]$/);if(!match)return null;const name=match[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return this.controls.find(c=>c.dataset[name]===match[2])||null;}};
  const body={scrollTop:0,writes:0,_html:'',get innerHTML(){return this._html;},set innerHTML(markup){this._html=markup;this.writes++;node.controls.forEach(c=>c.isConnected=false);node.controls=[...markup.matchAll(/data-(stats-book|calendar-stat|calendar-book|calendar-shift)="([^"]+)"/g)].map(m=>control({[m[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]:m[2]}));}};
  node.body=body;return node;
 }};
 const popup=createPopupHistory(browser),c={document,Date,Map,Set,JSON,Promise,GrowellArchiveDomain:domain,GrowellPopupHistory:popup};vm.createContext(c);vm.runInContext(source,c);
 let trigger=control({stat:'total'});
 function select(id,button){opened.push({id,button});const detail={open:true};opened.at(-1).detail=detail;popup.open('archive',{close(){detail.open=false;popup.closed('archive');if(button.isConnected)button.focus({preventScroll:true});}});}
 return {api:c.GrowellArchiveStats,c,nodes,opened,focused,back,popup,browser,select,control,setOwner(value){owner=value;},setReady(value){ready=value;},replaceTrigger(){trigger=control();return trigger;},options(rows,kind='total',extra={}){return {rows,kind,now:'2026-09-28',ownerId:'reader',getOwnerId:()=>owner,isCurrent:()=>ready,trigger,getTrigger:()=>trigger,onSelect:select,...extra};},open(rows,kind='total'){this.api.open(this.options(rows,kind));return nodes.at(-1);}};
}

test('each clickable statistic lists exactly the books counted by calendar summary with private, valid-date filtering',()=>{
 const rows=[row('month'),row('year',{endDate:'2026-08-20'}),row('old',{endDate:'2025-09-20'}),row('reading',{status:'reading',endDate:''}),row('undated',{endDate:''}),row('invalid',{endDate:'2026-09-31'}),row('unread',{status:'unread'}),row('deleted',{deleted:true}),row('foreign',{},'other')];
 const before=JSON.stringify(rows),summary=stats.summary(rows.concat(rows[0]),'2026-09-28','reader');
 assert.deepEqual(summary,calendar.summary(rows.filter(r=>r.entry.userId==='reader'),'2026-09-28'));assert.deepEqual(summary,{total:7,monthCompleted:1,reading:1,yearCompleted:2});
 for(const kind of kinds){assert.equal(stats.matchingRows(rows.concat(rows[0]),kind,'2026-09-28','reader').length,summary[kind]);const h=harness(),node=h.open(rows,kind);assert.equal(node.querySelectorAll('[data-stats-book]').length,summary[kind]);assert.doesNotMatch(node.body.innerHTML,/foreign|deleted|숨겨진/);h.api.reset();}
 assert.deepEqual(stats.matchingRows(rows,'unknown','2026-09-28','reader'),[]);assert.equal(JSON.stringify(rows),before);
 assert.deepEqual(stats.matchingRows([row('leap',{endDate:'2024-02-29'}),row('wrong',{endDate:'2025-02-29'})],'monthCompleted','2024-02-29','reader').map(r=>r.entry.id),['leap']);
});

test('empty statistics remain clickable and explicit close, Escape and browser Back restore the latest originating button',()=>{
 for(const method of ['close','escape','back']){const h=harness(),node=h.open([],'reading');assert.equal(node.open,true);assert.match(node.body.innerHTML,/아직 해당하는 책이 없어요/);const target=h.replaceTrigger();if(method==='close')node.querySelector('[data-stats-close]').onclick();else if(method==='escape')node.cancel();else h.back();assert.equal(node.removed,true);assert.equal(h.focused.at(-1).button,target);assert.equal(h.focused.at(-1).options.preventScroll,true);assert.match(h.browser.location.href,/#\/archive$/);}
});

test('book selection nests its existing reading record above the list and Back returns through both levels',()=>{
 const h=harness(),node=h.open([row('owned')]),button=node.querySelector('[data-stats-book="owned"]');node.scrollTop=190;button.onclick();assert.equal(h.opened[0].id,'owned');assert.equal(node.open,true);
 h.back();assert.equal(h.opened[0].detail.open,false);assert.equal(node.open,true);assert.equal(node.scrollTop,190);assert.equal(h.focused.at(-1).button,button);
 h.back();assert.equal(node.open,false);assert.match(h.browser.location.href,/#\/archive$/);
});

test('updates preserve list scroll and surviving book button identity while removing books that no longer match',()=>{
 const h=harness(),node=h.open([row('one',{status:'reading'}),row('two',{status:'reading'})],'reading'),button=node.querySelector('[data-stats-book="one"]');node.scrollTop=150;node.body.scrollTop=40;const writes=node.body.writes;
 h.api.refresh([row('one',{status:'reading',review:'new review'}),row('two',{status:'reading'})]);assert.equal(node.body.writes,writes,'unrelated updates do not repaint');
 h.api.refresh([row('one',{status:'reading',title:'새 책 제목'}),row('two',{status:'completed'})]);assert.equal(node.querySelector('[data-stats-book="one"]'),button);assert.equal(node.querySelectorAll('[data-stats-book]').length,1);assert.equal(node.scrollTop,150);assert.equal(node.body.scrollTop,40);assert.match(node.body.innerHTML,/새 책 제목/);
 button.onclick();h.back();assert.equal(h.focused.at(-1).button,button);h.api.reset();
});

test('account or ready-state invalidation closes private lists and rejects stale book callbacks',()=>{
 for(const invalidate of [h=>h.setOwner('other'),h=>h.setReady(false)]){const h=harness(),node=h.open([row('private')]),button=node.querySelector('[data-stats-book="private"]');invalidate(h);button.onclick();assert.equal(node.removed,true);assert.equal(h.opened.length,0);assert.equal(h.focused.length,0);h.open([row('private')]);assert.equal(h.nodes.length,1);}
 const h=harness(),node=h.open([row('private')]),oldButton=node.querySelector('[data-stats-book="private"]');h.api.reset();assert.equal(node.removed,true);assert.equal(h.focused.length,0);const current=h.open([row('private')]);oldButton.onclick();assert.equal(h.opened.length,0);assert.equal(current.open,true);h.api.reset();
});

test('book covers and titles are safe and the simple list excludes reading/review metadata',()=>{
 const h=harness(),node=h.open([row('unsafe',{title:'<img src=x onerror=alert(1)> "책"',coverUrl:'javascript:alert(1)'}),row('safe',{coverUrl:'https://image.yes24.com/goods/1/L'})]);
 assert.doesNotMatch(node.body.innerHTML,/<img src=x|javascript:|onerror=alert\(1\)>|숨겨진/);assert.match(node.body.innerHTML,/&lt;img/);assert.match(node.body.innerHTML,/&quot;책&quot;/);assert.match(node.body.innerHTML,/src="https:\/\/image.yes24.com\/goods\/1\/L"/);h.api.reset();
});

test('calendar statistics open lists for its displayed month/year and nested Back preserves that calendar position',()=>{
 const h=harness();vm.runInContext(fs.readFileSync(path.join(__dirname,'../archiveCalendar.js'),'utf8'),h.c);
 const rows=[row('aug',{startDate:'2025-08-01',endDate:'2025-08-15'}),row('sep',{endDate:'2026-09-10'}),row('current',{status:'reading',endDate:''})];
 h.c.GrowellArchiveCalendar.open(h.options(rows,'total',{now:'2025-09-28'}));const calendarNode=h.nodes[0];calendarNode.querySelector('[data-calendar-shift="-1"]').onclick();calendarNode.scrollTop=320;
 const button=calendarNode.querySelector('[data-calendar-stat="monthCompleted"]');button.onclick();const node=h.nodes.at(-1);assert.match(node.innerHTML,/2025년 8월 완독한 책/);assert.deepEqual(node.querySelectorAll('[data-stats-book]').map(b=>b.dataset.statsBook),['aug']);
 node.querySelector('[data-stats-book="aug"]').onclick();h.back();assert.equal(node.open,true);assert.equal(calendarNode.open,true);h.back();assert.equal(node.open,false);assert.equal(calendarNode.open,true);assert.equal(calendarNode.scrollTop,320);assert.match(calendarNode.body.innerHTML,/2025년 8월/);assert.equal(h.focused.at(-1).button,button);
 calendarNode.querySelector('[data-calendar-stat="yearCompleted"]').onclick();assert.deepEqual(h.nodes.at(-1).querySelectorAll('[data-stats-book]').map(b=>b.dataset.statsBook),['aug']);h.c.GrowellArchiveCalendar.reset();assert.equal(h.nodes.at(-1).open,false);assert.equal(calendarNode.open,false);
});
