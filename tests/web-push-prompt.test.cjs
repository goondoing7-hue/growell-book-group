'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../webPushPrompt.js'),'utf8');
const pushSource=fs.readFileSync(path.join(__dirname,'../webPush.js'),'utf8');
const origin='https://growell-book.vercel.app';
const key=Buffer.concat([Buffer.from([4]),Buffer.alloc(64,9)]).toString('base64url');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.open=false;this.removed=false;this.disabled=false;this.textContent='';this.events={};this.attributes={};this.nodes={};this.classList={toggle(){}};this.isConnected=true;}
  set innerHTML(html){this.html=html;for(const [,tag,attributes] of html.matchAll(/<([a-z]+)\b([^>]*)>/g))for(const [,attr] of attributes.matchAll(/\b(data-[a-z-]+)(?:="[^"]*")?/g))this.nodes['['+attr+']']=new Element(tag);}
  get innerHTML(){return this.html;}
  querySelector(selector){assert.ok(this.nodes[selector],'fixture selector '+selector);return this.nodes[selector];}
  setAttribute(name,value){this.attributes[name]=value;}
  addEventListener(name,fn){this.events[name]=fn;}
  focus(){this.focused=true;}
  showModal(){this.open=true;}
  close(){this.open=false;}
  remove(){this.removed=true;this.isConnected=false;}
  getBoundingClientRect(){return {left:0,right:400,top:0,bottom:400};}
}
function harness(options={}){
  const storage=options.storage||new Map(),dialogs=[],events={},calls={prompts:0,requests:[],subscribe:0,history:[]};
  let current=true,present=options.canPresent!==false,active=!!options.subscribed,clock=Date.parse('2026-10-17T00:00:00Z');
  const subscription={endpoint:'https://push.example.invalid/PRIVATE_DEVICE',toJSON(){return {endpoint:this.endpoint,keys:{p256dh:'PRIVATE_KEY',auth:'PRIVATE_AUTH'}};}};
  let native=options.existing||active?subscription:null;
  const reg={scope:origin+'/',active:{state:'activated',scriptURL:origin+'/timer-alert-sw.js'},showNotification:async()=>{},pushManager:{getSubscription:async()=>native,subscribe:async()=>{calls.subscribe++;native=subscription;return subscription;}}};
  const permission={permission:options.permission||'default',requestPermission(){calls.prompts++;permission.permission=options.answer||'granted';return Promise.resolve(permission.permission);}};
  const document={activeElement:new Element('button'),body:{appendChild(node){dialogs.push(node);}},createElement:tag=>new Element(tag),querySelector(){return options.otherModal||dialogs.find(dialog=>dialog.open&&!dialog.removed)||null;}};
  const timers=[],c={document,URL,Promise,Date,Math,JSON,Object,Array,Number,Set,Uint8Array,AbortController,setTimeout:options.manualArrival?(fn,delay)=>{if(delay===800){timers.push(fn);return -timers.length;}return setTimeout(fn,delay);}:(fn,delay)=>setTimeout(fn,delay===800?0:delay),clearTimeout:id=>{if(id<0)timers[-id-1]=null;else clearTimeout(id);},isSecureContext:!options.insecure,
    atob:value=>Buffer.from(value,'base64').toString('binary'),location:{origin},PushManager:options.unsupported?undefined:function(){},Notification:options.unsupported?undefined:permission,
    matchMedia:()=>({matches:!!options.standalone}),navigator:{userAgent:options.ios?'iPhone':'Windows',standalone:!!options.standalone,serviceWorker:{getRegistration:async()=>reg,register:async()=>reg}},
    crypto:require('node:crypto').webcrypto,localStorage:{get length(){if(options.storageBlocked)throw Error('blocked');return storage.size;},key:index=>[...storage.keys()][index]??null,getItem(name){if(options.storageBlocked)throw Error('blocked');return storage.get(name)||null;},setItem(name,value){if(options.storageBlocked)throw Error('blocked');storage.set(name,value);},removeItem:name=>storage.delete(name)},
    addEventListener(name,fn){(events[name]||=[]).push(fn);},removeEventListener(name,fn){events[name]=(events[name]||[]).filter(value=>value!==fn);},
    GrowellPopupHistory:{open(name,settings){calls.history.push(['open',name]);calls.historyClose=settings.close;},closed(name){calls.history.push(['close',name]);}},
    fetch:async(url,settings)=>{
      const body=JSON.parse(settings.body);calls.requests.push({url,body,settings});
      if(options.delayed&&body.action===options.delayedAction)return options.delayed;
      if(options.networkError)throw Error('PRIVATE_FETCH_ERROR');
      let value=body.action==='config'?{configured:options.configured!==false,publicKey:key}:body.action==='status'?{configured:true,subscription:active?{active:true,preferences:{posts:true,dailyVerse:true}}:null}:{ok:true};
      if(body.action==='subscribe')active=true;
      return {ok:true,json:async()=>value};
    }};
  vm.createContext(c);vm.runInContext(pushSource,c);vm.runInContext(source,c);
  const manager=c.GrowellWebPushPrompt.create({now:()=>clock}),adapter={memberKey:'PRIVATE_MEMBER_ID',isCurrent:()=>current,getAccessToken:async()=> 'PRIVATE_MEMBER_TOKEN',canPresent:()=>present};
  return {c,manager,adapter,dialogs,calls,storage,events,permission,reg,timers,setCurrent(value){current=value;},setPresent(value){present=value;},setSubscribed(value){active=value;},setNow(value){clock=value;},get node(){return dialogs.at(-1);},q(selector){return this.node.querySelector(selector);}};
}
test('an eligible returning member sees a single explanation without automatic permission or subscription',async()=>{
  const h=harness();assert.equal(await h.manager.maybeShow(h.adapter),true);assert.equal(h.dialogs.length,1);assert.equal(h.node.open,true);
  assert.match(h.node.html,/새로운 나눔/);assert.match(h.node.html,/매일 오전 9시 말씀/);assert.match(h.node.html,/프로필 → 설정 → 알림/);assert.doesNotMatch(h.node.html,/프로필 → 연동/);assert.equal(h.calls.prompts,0);assert.equal(h.calls.subscribe,0);
  assert.equal(await h.manager.maybeShow(h.adapter),false);assert.equal(h.dialogs.length,1);assert.doesNotMatch(h.node.html,/PRIVATE_MEMBER|PRIVATE_DEVICE|PRIVATE_KEY/);h.manager.destroy();
});
test('the explicit enable button preserves the synchronous permission gesture and then closes on confirmed connection',async()=>{
  const h=harness();await h.manager.maybeShow(h.adapter);h.q('[data-push-prompt-enable]').onclick();assert.equal(h.calls.prompts,1);assert.equal(h.calls.subscribe,0);
  await flush();assert.equal(h.calls.subscribe,1);assert.equal(h.node.removed,true);assert.equal(h.storage.size,0);
  const subscribe=h.calls.requests.find(call=>call.body.action==='subscribe');assert.deepEqual(subscribe.body.preferences,{posts:true,dailyVerse:true});h.manager.destroy();
});
test('granted browser permission without this member subscription still requires an explicit connect button',async()=>{
  const h=harness({permission:'granted',existing:true});await h.manager.maybeShow(h.adapter);assert.equal(h.calls.subscribe,0);assert.equal(h.calls.requests.some(call=>call.body.action==='subscribe'),false);
  h.q('[data-push-prompt-enable]').onclick();await flush();assert.equal(h.calls.prompts,0);assert.equal(h.calls.requests.filter(call=>call.body.action==='subscribe').length,1);h.manager.destroy();
});
test('connected, denied, unsupported, insecure and unconfigured devices do not get an automatic prompt',async()=>{
  for(const options of [{subscribed:true},{permission:'denied'},{unsupported:true},{insecure:true},{configured:false},{networkError:true}]){
    const h=harness(options);assert.equal(await h.manager.maybeShow(h.adapter),false);assert.equal(h.dialogs.length,0);assert.equal(h.calls.prompts,0);assert.equal(h.calls.subscribe,0);h.manager.destroy();
  }
});
test('iOS outside the home screen receives installation guidance without any permission or server request',async()=>{
  const h=harness({ios:true,unsupported:true});assert.equal(await h.manager.maybeShow(h.adapter),true);assert.match(h.node.html,/Safari.*홈 화면에 추가/s);assert.match(h.node.html,/프로필 → 설정 → 알림/);
  assert.equal('[data-push-prompt-enable]' in h.node.nodes,false);assert.equal(h.calls.prompts,0);assert.equal(h.calls.requests.length,0);h.manager.destroy();
});
test('later, close, Escape and browser Back snooze for seven days with only hashed key and timestamp stored',async()=>{
  for(const action of ['later','close','escape','back']){
    const h=harness();await h.manager.maybeShow(h.adapter);
    if(action==='escape'){let prevented=false;h.node.events.cancel({preventDefault(){prevented=true;}});assert.equal(prevented,true);}
    else if(action==='back')h.calls.historyClose();else h.q('[data-push-prompt-'+action+']').onclick();
    assert.equal(h.node.removed,true);assert.equal(h.storage.size,1);const [name,value]=[...h.storage][0];assert.match(name,/^growell_push_prompt_v1:[a-f0-9]+-[a-f0-9]+$/);
    assert.deepEqual(Object.keys(JSON.parse(value)),['until']);assert.equal(JSON.parse(value).until,Date.parse('2026-10-24T00:00:00Z'));assert.doesNotMatch(name+value,/PRIVATE_|TOKEN|DEVICE|email|endpoint/);
    const next=harness({storage:h.storage});assert.equal(await next.manager.maybeShow(next.adapter),false);next.manager.destroy();h.manager.destroy();
  }
});
test('snooze expires after seven days and a different member does not inherit it',async()=>{
  const h=harness();await h.manager.maybeShow(h.adapter);h.q('[data-push-prompt-later]').onclick();h.manager.destroy();
  const later=harness({storage:h.storage});later.setNow(Date.parse('2026-10-24T00:00:01Z'));assert.equal(await later.manager.maybeShow(later.adapter),true);later.manager.destroy();
  const other=harness({storage:h.storage});other.adapter.memberKey='ANOTHER_PRIVATE_MEMBER';assert.equal(await other.manager.maybeShow(other.adapter),true);other.manager.destroy();
});
test('blocked storage and malformed stored values cannot break the prompt or force permission requests',async()=>{
  const h=harness({storageBlocked:true});await h.manager.maybeShow(h.adapter);h.q('[data-push-prompt-later]').onclick();assert.equal(await h.manager.maybeShow(h.adapter),false);assert.equal(h.calls.prompts,0);h.manager.destroy();
  const storage=new Map();const first=harness({storage});await first.manager.maybeShow(first.adapter);first.q('[data-push-prompt-later]').onclick();first.manager.destroy();const key=[...storage.keys()][0];storage.set(key,'{"until":"FOREVER","token":"DO_NOT_USE"}');
  const next=harness({storage});assert.equal(await next.manager.maybeShow(next.adapter),true);next.manager.destroy();
});
test('writing and existing dialogs defer presentation without consuming the page opportunity',async()=>{
  const h=harness({canPresent:false});assert.equal(await h.manager.maybeShow(h.adapter),false);assert.equal(h.calls.requests.length,0);h.setPresent(true);assert.equal(await h.manager.maybeShow(h.adapter),true);h.manager.destroy();
  const modal=harness({otherModal:{open:true}});assert.equal(await modal.manager.maybeShow(modal.adapter),false);assert.equal(modal.calls.requests.length,0);modal.manager.destroy();
});
test('a dialog opened while subscription status is pending wins over the automatic prompt',async()=>{
  const answer=deferred(),h=harness({delayed:answer.promise,delayedAction:'status'});const pending=h.manager.maybeShow(h.adapter);await flush();h.setPresent(false);
  answer.resolve({ok:true,json:async()=>({configured:true,subscription:null})});assert.equal(await pending,false);assert.equal(h.dialogs.length,0);h.setPresent(true);assert.equal(await h.manager.maybeShow(h.adapter),true);h.manager.destroy();
});
test('repeated render hooks coalesce and session reset aborts stale status before displaying anything',async()=>{
  const answer=deferred(),h=harness({delayed:answer.promise,delayedAction:'status'});const first=h.manager.maybeShow(h.adapter),second=h.manager.maybeShow(h.adapter);assert.equal(first,second);await flush();
  const status=h.calls.requests.find(call=>call.body.action==='status');h.manager.reset();assert.equal(status.settings.signal.aborted,true);answer.resolve({ok:true,json:async()=>({configured:true,subscription:null})});assert.equal(await first,false);assert.equal(h.dialogs.length,0);assert.equal(h.storage.size,0);h.manager.destroy();
});
test('changing accounts closes and disposes an existing explanation without recording a refusal',async()=>{
  const h=harness();await h.manager.maybeShow(h.adapter);h.setCurrent(false);h.events.hashchange[0]();assert.equal(h.node.removed,true);assert.equal(h.storage.size,0);assert.equal(h.calls.prompts,0);h.manager.destroy();
});
test('a permission prompt rejected by the member stays a clear local explanation without subscribing',async()=>{
  const h=harness({answer:'denied'});await h.manager.maybeShow(h.adapter);h.q('[data-push-prompt-enable]').onclick();await flush();assert.equal(h.calls.subscribe,0);assert.equal(h.q('[data-push-prompt-enable]').disabled,true);assert.match(h.q('[data-push-prompt-status]').textContent,/브라우저 설정/);h.manager.destroy();
});
test('destroying a manager removes observers and never changes member source records',async()=>{
  const h=harness(),records={post:{body:'작성한 원문',id:'unchanged'}};const before=JSON.stringify(records);await h.manager.maybeShow(h.adapter);h.manager.destroy();
  assert.equal(h.events.hashchange.length,0);assert.equal(h.events.pagehide.length,0);assert.equal(await h.manager.maybeShow(h.adapter),false);assert.equal(JSON.stringify(records),before);assert.equal(h.storage.size,0);
});
test('network failures have a bounded 45 second cooldown instead of repeating on every render',async()=>{
  const h=harness({networkError:true});assert.equal(await h.manager.maybeShow(h.adapter),false);const before=h.calls.requests.length;
  for(let i=0;i<10;i++)assert.equal(await h.manager.maybeShow(h.adapter),false);assert.equal(h.calls.requests.length,before);
  h.setNow(Date.parse('2026-10-17T00:00:46Z'));assert.equal(await h.manager.maybeShow(h.adapter),false);assert.equal(h.calls.requests.length,before+1);h.manager.destroy();
});
test('connected or denied device checks are skipped for this session and reset allows a later login to recheck',async()=>{
  for(const options of [{subscribed:true,permission:'granted'},{permission:'denied'}]){
    const h=harness(options);await h.manager.maybeShow(h.adapter);const before=h.calls.requests.length;
    for(let i=0;i<10;i++)await h.manager.maybeShow(h.adapter);assert.equal(h.calls.requests.length,before);
    h.manager.reset();h.setSubscribed(false);h.permission.permission='granted';assert.equal(await h.manager.maybeShow(h.adapter),true);h.manager.destroy();
  }
});
test('session reset clears shown state without permanent success dismissal or snoozing a different member',async()=>{
  const h=harness();assert.equal(await h.manager.maybeShow(h.adapter),true);h.manager.reset();assert.equal(h.node.removed,true);assert.equal(h.storage.size,0);
  h.adapter.memberKey='ANOTHER_PRIVATE_MEMBER';assert.equal(await h.manager.maybeShow(h.adapter),true);assert.equal(h.dialogs.length,2);h.manager.destroy();
});
test('the 800 ms arrival pause checks writing again and pending timers are cancelled on logout',async()=>{
  const h=harness({manualArrival:true});const first=h.manager.maybeShow(h.adapter);await flush();assert.equal(h.timers.length,1);assert.equal(h.dialogs.length,0);
  h.setPresent(false);h.timers[0]();assert.equal(await first,false);assert.equal(h.dialogs.length,0);
  h.setPresent(true);const second=h.manager.maybeShow(h.adapter);await flush();assert.equal(h.timers.length,2);h.manager.reset();assert.equal(h.timers[1],null);assert.equal(await second,false);assert.equal(h.dialogs.length,0);h.manager.destroy();
});
