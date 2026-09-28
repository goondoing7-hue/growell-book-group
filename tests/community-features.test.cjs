'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const Domain=require('../communityDomain.js');
const featureSource=fs.readFileSync(path.join(__dirname,'../communityFeatures.js'),'utf8');
const appSource=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const adapterSource=appSource.slice(appSource.indexOf('/* ---------------- community dependency adapter ---------------- */'),appSource.indexOf('/* ---------------- boot ----------------'));
const esc=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function harness(){
  const requests=[],queue=[],events={};
  const c={Promise,Array,Object,Number,Date,Set,document:{querySelectorAll:()=>[]},GrowellCommunity:Domain,
    SESSION:{userId:'member-a'},saveSessionEpoch:1,isAdmin:()=>true,svgIcon:()=>'',I_COMMENT:'',I_EDIT:'',esc,
    avatarHtml:()=>'',fmtPostDate:()=>'',homePostExcerpt:()=>'',homeUnlockedIds:()=>['emotion'],safePhotoUrl:()=>null,showToast:()=>{},
    bookById:id=>({id}),addEventListener:(name,handler)=>{events[name]=handler;},
    sb:{rpc(name,args){requests.push({name,args});return queue.shift()||Promise.resolve({data:[],error:null});}}};
  c.window=c;vm.createContext(c);vm.runInContext(featureSource,c);
  c.GrowellCommunityFeatures.configure(c);
  return {c,api:c.GrowellCommunityFeatures,requests,queue,events};
}
function popupHarness(kind){
  const h=harness(),opened=[],closed=[],nodes=[];
  function control(){return {value:'',disabled:false,events:{},isConnected:true,focus(){this.focused=true;},
    addEventListener(name,handler){this.events[name]=handler;},getAttribute(name){return this.attributes&&this.attributes[name];}};}
  const trigger=control();trigger.attributes=kind==='author'?{'data-community-author':'author'}:{'data-question-edit':'emotion'};
  h.c.STATE={users:{author:{name:'작성자'}},posts:Object.fromEntries(Array.from({length:13},(_,i)=>['post-'+i,{id:'post-'+i,userId:'author',bookId:'emotion',createdAt:i+1,title:'글 '+i}]))};
  h.c.GrowellPopupHistory={open(key,options){opened.push({key,options});},closed(key){closed.push(key);}};
  h.c.document={activeElement:trigger,querySelector:()=>null,
    querySelectorAll(selector){return selector===(kind==='author'?'[data-community-author]':'[data-question-edit]')?[trigger]:[];},
    body:{appendChild(node){node.isConnected=true;nodes.push(node);}},
    createElement(){
      const close=control(),cancel=control(),save=control(),input=control(),message=control(),count=control(),more=control(),link=control(),form=control();
      const status={set outerHTML(markup){const match=markup.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);if(match)input.value=match[1];}};
      form.querySelector=()=>save;
      const node=Object.assign(control(),{controls:{close,cancel,save,input,message,more,link,form},open:false,innerHTML:'',
        setAttribute(){},showModal(){this.open=true;},close(){this.open=false;},remove(){this.isConnected=false;},contains(){return false;},
        querySelector(selector){return {'[data-community-close]':close,'[role="status"]':status,form,textarea:input,'[data-question-count]':count,
          '[data-question-cancel]':cancel,'.community-question-message':message,'[data-author-more]':more}[selector]||null;},
        querySelectorAll(selector){return selector==='.community-author-post'?[link]:selector==='[data-community-close],[data-question-cancel]'?[close,cancel]:[];}
      });
      return node;
    }};
  return Object.assign(h,{opened,closed,nodes,trigger,click(){trigger.onclick({preventDefault(){},stopPropagation(){}});}});
}
async function flush(){await new Promise(resolve=>setImmediate(resolve));}

function replyHarness(){
  const h=harness(),opened=[],closed=[],nodes=[];
  let serial=0;h.c.crypto={randomUUID:()=> 'reply-'+(++serial)};h.c.STATE={users:{}};
  const unesc=value=>String(value).replace(/&quot;/g,'"').replace(/&gt;/g,'>').replace(/&lt;/g,'<').replace(/&amp;/g,'&');
  const control=(attrs={})=>({value:'',disabled:false,events:{},isConnected:true,attributes:attrs,focus(options){this.focused=true;this.focusOptions=options;},addEventListener(name,handler){this.events[name]=handler;},getAttribute(name){return this.attributes[name]??null;},closest(selector){return this.matches(selector)?this:null;},matches(selector){return selector==='[data-reply-action]'?!!this.attributes['data-reply-action']:selector==='[data-reply-edit-input]'?'data-reply-edit-input' in this.attributes:false;},remove(){this.isConnected=false;}});
  const trigger=Object.assign(control(),{getAttribute:()=> 'emotion'});
  h.c.GrowellPopupHistory={open(key,options){opened.push({key,options});},closed(key){closed.push(key);}};
  h.c.document={activeElement:trigger,querySelector:()=>null,querySelectorAll:s=>s==='[data-space-prompt]'?[trigger]:[],body:{appendChild(node){nodes.push(node);}},createElement(tag){
    if(tag==='button')return control();
    const close=control(),save=control(),input=control(),message=control(),count=control(),form=control(),more=control(),list=Object.assign(control(),{rows:[],empty:''}),content={};
    function buttons(markup){return [...markup.matchAll(/<button[^>]*data-reply-action="([^"]+)"[^>]*data-reply-id="([^"]+)"[^>]*>/g)].map(match=>control({'data-reply-action':match[1],'data-reply-id':unesc(match[2])}));}
    function row(markup){
      const id=unesc(markup.match(/data-question-reply="([^"]+)"/)[1]),actions=control(),panel={markup:'',buttons:[],input:null},item=Object.assign(control({'data-question-reply':id}),{markup,actions,buttons:buttons(markup),panel});
      Object.defineProperty(panel,'innerHTML',{get(){return this.markup;},set(value){this.markup=value;this.buttons=buttons(value);const match=value.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);this.input=match?Object.assign(control({'data-reply-edit-input':'','data-reply-id':id}),{value:unesc(match[1])}):null;}});
      panel.querySelector=function(selector){return selector==='textarea'?this.input:this.buttons.find(b=>'[data-reply-action="'+b.attributes['data-reply-action']+'"]'===selector)||null;};
      item.querySelector=function(selector){return selector==='[data-reply-editor]'?panel:selector==='.community-reply-actions'?actions:item.buttons.find(b=>'[data-reply-action="'+b.attributes['data-reply-action']+'"]'===selector)||null;};
      item.remove=function(){list.rows=list.rows.filter(r=>r!==item);};
      Object.defineProperty(item,'outerHTML',{set(value){list.rows[list.rows.indexOf(item)]=row(value);}});
      return item;
    }
    function parse(markup){return [...markup.matchAll(/<article class="community-reply"[\s\S]*?<\/article>/g)].map(match=>row(match[0]));}
    Object.defineProperty(list,'html',{get(){return this.rows.map(r=>r.markup).join('')+this.empty;}});
    Object.defineProperty(list,'innerHTML',{set(markup){this.rows=parse(markup);this.empty=this.rows.length?'':markup;}});
    list.querySelector=function(selector){return selector==='.community-reply-empty'&&this.empty?{remove:()=>{list.empty='';}}:null;};
    list.querySelectorAll=function(selector){return selector==='[data-question-reply]'?this.rows:this.rows.flatMap(r=>r.buttons.concat(r.panel.buttons,r.panel.input?[r.panel.input]:[]));};
    list.contains=target=>list.querySelectorAll('controls').includes(target);
    list.insertAdjacentHTML=function(position,markup){const added=parse(markup);this.rows=position==='afterbegin'?added.concat(this.rows):this.rows.concat(added);};
    form.querySelector=()=>save;message.appendChild=function(child){this.child=child;};
    Object.defineProperty(content,'innerHTML',{set(markup){this.markup=markup;const match=markup.match(/<textarea id="community-reply-input"[^>]*>([\s\S]*?)<\/textarea>/);if(match)input.value=unesc(match[1]);const replies=markup.match(/<div data-reply-list>([\s\S]*?)<\/div><\/section>/);if(replies)list.innerHTML=replies[1];}});
    const node=Object.assign(control(),{controls:{close,save,input,message,count,form,list,content,more},open:false,scrollTop:240,scrollHeight:800,setAttribute(){},showModal(){this.open=true;},close(){this.open=false;},remove(){this.isConnected=false;},querySelector(s){return {'[data-community-close]':close,'[data-reply-content]':content,'[data-reply-message]':message,'[data-reply-count]':count,'[data-reply-list]':list,'[data-reply-more]':content.markup&&content.markup.includes('data-reply-more')?more:null,form,textarea:input}[s]||null;},row(id){return list.rows.find(r=>r.attributes['data-question-reply']===id);},click(id,action){const button=list.querySelectorAll('controls').find(b=>b.attributes['data-reply-id']===id&&b.attributes['data-reply-action']===action);assert.ok(button,'missing '+action+' control');if(!button.disabled)list.events.click({target:button,preventDefault(){},stopPropagation(){}});},edit(id,value){const field=this.row(id).panel.input;field.value=value;list.events.input({target:field});}});
    return node;
  }};
  function thread(revision=0,replies=[],hasMore=false){return {data:{book_id:'emotion',question:Domain.defaults.emotion,revision,replies,has_more:hasMore}};}
  function saved(body,id='reply-1',replyRevision=0,userId='member-a'){return {data:{id,book_id:'emotion',question_revision:0,user_id:userId,user_name:'검증 회원',body,created_at:'2026-09-28T10:00:00Z',reply_revision:replyRevision,updated_at:replyRevision?'2026-09-28T11:00:00Z':null}};}
  function deleted(id='reply-1',replyRevision=1){return {data:{id,book_id:'emotion',question_revision:0,user_id:'member-a',reply_revision:replyRevision,deleted:true}};}
  return Object.assign(h,{opened,closed,nodes,trigger,thread,saved,deleted,async open(response){await h.api.load();h.api.bind();h.queue.push(Promise.resolve(response||thread()));trigger.onclick({preventDefault(){},stopPropagation(){}});await flush();return nodes[nodes.length-1];}});
}

test('question reply popup uses its own thread and Back restores the page and draft',async()=>{
  const h=replyHarness(),node=await h.open();
  assert.equal(h.opened[0].key,'community-replies');
  assert.equal(h.requests.at(-1).name,'growell_get_question_replies');
  assert.equal(h.requests.at(-1).args.p_book_id,'emotion');
  node.controls.input.value='질문에 답하는 생각';node.controls.input.events.input();h.opened[0].options.close();
  assert.equal(node.open,false);assert.equal(h.trigger.focused,true);
  const reopened=await h.open();assert.equal(reopened.controls.input.value,'질문에 답하는 생각');
  assert.deepEqual(h.closed,['community-replies']);
});

test('uncertain answer save retains draft and request identity; confirmed retry creates one comment',async()=>{
  const h=replyHarness(),node=await h.open();node.controls.input.value='내 답변';node.controls.input.events.input();
  const pending=deferred();h.queue.push(pending.promise);node.controls.form.events.submit({preventDefault(){}});await flush();
  assert.equal(h.opened[0].options.canClose(),false);assert.equal(node.controls.save.disabled,true);
  pending.resolve({error:{code:'network'}});await flush();
  assert.equal(node.controls.input.value,'내 답변');assert.equal(node.open,true);assert.equal(h.opened[0].options.canClose(),true);
  const first=h.requests.at(-1);h.queue.push(Promise.resolve(h.saved('내 답변')));node.controls.form.events.submit({preventDefault(){}});await flush();
  assert.deepEqual(h.requests.at(-1),first);assert.equal(node.controls.input.value,'');
  assert.equal((node.controls.list.html.match(/data-question-reply/g)||[]).length,1);assert.equal(node.open,true);
});

test('answers cannot mix book/revision threads; malformed responses and late session responses stay rejected',async()=>{
  const sample={id:'r',book_id:'emotion',question_revision:2,user_id:'member',user_name:'회원',body:'답변',created_at:'2026-09-28T10:00:00Z'};
  assert.throws(()=>Domain.replyRow(sample,'emotion',1));assert.throws(()=>Domain.replyRow(sample,'body',2));
  assert.throws(()=>Domain.replyThread({book_id:'emotion',question:'질문',revision:2,replies:[sample,sample],has_more:false},'emotion'));
  assert.equal(Domain.validReply('🌱'.repeat(2000)),true);assert.equal(Domain.validReply('🌱'.repeat(2001)),false);
  const h=replyHarness(),node=await h.open();node.controls.input.value='다른 계정에 보이면 안 되는 답변';
  const pending=deferred();h.queue.push(pending.promise);node.controls.form.events.submit({preventDefault(){}});await flush();
  h.api.reset();h.c.SESSION={userId:'member-b'};pending.resolve(h.saved('다른 계정에 보이면 안 되는 답변'));await flush();
  assert.equal(node.open,false);assert.ok(!node.controls.list.html.includes('다른 계정에 보이면 안 되는 답변'));
});

test('a changed question preserves the answer and requires explicit review of the new question',async()=>{
  const h=replyHarness(),node=await h.open();node.controls.input.value='보존할 답변';
  h.queue.push(Promise.resolve({error:{code:'40001'}}));node.controls.form.events.submit({preventDefault(){}});await flush();
  assert.equal(node.controls.input.value,'보존할 답변');assert.equal(node.controls.message.child.textContent,'새 질문 확인');
  h.queue.push(Promise.resolve(h.thread(1)));node.controls.message.child.onclick();await flush();
  assert.equal(node.controls.input.value,'보존할 답변');assert.equal(h.requests.at(-1).name,'growell_get_question_replies');
});
test('only the reply owner sees edit and delete; cancel leaves answer and creation draft untouched',async()=>{
  const h=replyHarness(),node=await h.open(h.thread(0,[h.saved('내 원본').data,h.saved('다른 회원 답변','other',0,'member-b').data]));
  assert.match(node.innerHTML,/함께 고민하고 생각해요\./);assert.match(h.api.promptHtml({id:'emotion'}),/함께 고민하고 생각해요\./);
  assert.equal(node.row('reply-1').buttons.length,2);assert.equal(node.row('other').buttons.length,0,'admin cannot edit another member reply');
  node.controls.input.value='새로 쓰는 답변';node.controls.input.events.input();
  const count=h.requests.length;node.click('reply-1','edit');node.edit('reply-1','취소할 수정');node.click('reply-1','cancel');
  assert.equal(node.row('reply-1').panel.markup,'');assert.match(node.row('reply-1').markup,/내 원본/);
  assert.equal(node.controls.input.value,'새로 쓰는 답변');assert.equal(node.scrollTop,240);assert.equal(h.requests.length,count);
  node.click('reply-1','delete');assert.match(node.row('reply-1').panel.markup,/이 답변을 삭제할까요/);node.click('reply-1','cancel');assert.ok(node.row('reply-1'));assert.equal(h.requests.length,count);
  node.click('reply-1','edit');node.edit('reply-1','  내 원본  ');node.click('reply-1','save');assert.equal(h.requests.length,count,'unchanged body makes no request');
});
test('uncertain reply edit keeps draft and original row; retry is identical and updates only that row',async()=>{
  const h=replyHarness(),node=await h.open(h.thread(0,[h.saved('원래 답변').data]));
  node.controls.input.value='아직 게시하지 않은 새 답변';node.controls.input.events.input();
  node.click('reply-1','edit');node.edit('reply-1','<script>수정한 답변</script>');
  const pending=deferred();h.queue.push(pending.promise);node.click('reply-1','save');await flush();
  assert.equal(h.opened[0].options.canClose(),false);assert.equal(node.controls.close.disabled,true);
  const first=h.requests.at(-1);assert.equal(first.name,'growell_update_question_reply');assert.equal(first.args.p_expected_reply_revision,0);
  pending.resolve({error:{code:'network'}});await flush();
  assert.equal(node.row('reply-1').panel.input.value,'<script>수정한 답변</script>');assert.match(node.row('reply-1').markup,/원래 답변/);assert.equal(h.opened[0].options.canClose(),true);
  h.queue.push(Promise.resolve(h.saved('<script>수정한 답변</script>','reply-1',1)));node.click('reply-1','save');await flush();
  assert.deepEqual(h.requests.at(-1),first);assert.match(node.row('reply-1').markup,/&lt;script&gt;수정한 답변&lt;\/script&gt;/);assert.ok(!node.row('reply-1').markup.includes('<script>'));
  assert.match(node.row('reply-1').markup,/수정됨/);assert.equal(node.row('reply-1').panel.markup,'');assert.equal(node.controls.input.value,'아직 게시하지 않은 새 답변');assert.equal(node.open,true);assert.equal(node.scrollTop,240);
});
test('delete requires confirmation, preserves failed row, and retries the original revision',async()=>{
  const h=replyHarness(),node=await h.open(h.thread(0,[h.saved('삭제할 내 답변','reply-1',3).data]));
  const count=h.requests.length;node.click('reply-1','delete');assert.equal(h.requests.length,count);
  const pending=deferred();h.queue.push(pending.promise);node.click('reply-1','confirm-delete');await flush();const first=h.requests.at(-1);
  assert.equal(first.args.p_expected_reply_revision,3);assert.equal(h.opened[0].options.canClose(),false);
  pending.resolve({error:{code:'network'}});await flush();assert.ok(node.row('reply-1'));assert.match(node.row('reply-1').panel.markup,/삭제를 확인하지 못했어요/);
  h.queue.push(Promise.resolve(h.deleted('reply-1',4)));node.click('reply-1','confirm-delete');await flush();
  assert.deepEqual(h.requests.at(-1),first);assert.equal(node.row('reply-1'),undefined);assert.match(node.controls.list.html,/아직 답변이 없어요/);assert.equal(node.open,true);assert.equal(h.opened[0].options.canClose(),true);
});
test('edit conflict keeps local draft and blocks further writes until latest answer is opened',async()=>{
  const h=replyHarness(),node=await h.open(h.thread(0,[h.saved('원본').data]));node.click('reply-1','edit');node.edit('reply-1','보존할 수정');
  h.queue.push(Promise.resolve({error:{code:'40001'}}));node.click('reply-1','save');await flush();
  const count=h.requests.length;node.click('reply-1','save');await flush();assert.equal(h.requests.length,count);assert.match(node.row('reply-1').panel.markup,/다른 곳에서 답변이 변경/);assert.equal(node.row('reply-1').panel.input.value,'보존할 수정');
  h.opened[0].options.close();assert.equal(node.open,false);
  const reopened=await h.open(h.thread(0,[h.saved('다른 기기에서 수정','reply-1',1).data]));reopened.click('reply-1','edit');
  assert.equal(reopened.row('reply-1').panel.input.value,'보존할 수정');assert.match(reopened.row('reply-1').panel.markup,/현재 답변을 확인/);assert.match(reopened.row('reply-1').markup,/다른 기기에서 수정/);
  h.queue.push(Promise.resolve(h.saved('보존할 수정','reply-1',2)));reopened.click('reply-1','save');await flush();assert.equal(h.requests.at(-1).args.p_expected_reply_revision,1);
});
test('late edit and delete acknowledgements cannot mutate a closed or changed-account popup',async()=>{
  for(const remove of [false,true])for(const invalidate of [h=>h.api.reset(),h=>{h.c.SESSION={userId:'member-b'};},h=>h.c.saveSessionEpoch++]){
    const h=replyHarness(),node=await h.open(h.thread(0,[h.saved('남아야 할 원본').data]));node.click('reply-1',remove?'delete':'edit');if(!remove)node.edit('reply-1','늦은 수정');
    const pending=deferred();h.queue.push(pending.promise);node.click('reply-1',remove?'confirm-delete':'save');await flush();invalidate(h);
    pending.resolve(remove?h.deleted():h.saved('늦은 수정','reply-1',1));await flush();assert.match(node.row('reply-1').markup,/남아야 할 원본/);
  }
});
test('late pagination cannot revive a deleted reply or overwrite edit; deleted cursor still loads older replies',async()=>{
  const h=replyHarness(),node=await h.open(h.thread(0,[h.saved('기존 답변').data],true)),pending=deferred();
  h.queue.push(pending.promise);node.controls.more.onclick();
  node.click('reply-1','delete');h.queue.push(Promise.resolve(h.deleted()));node.click('reply-1','confirm-delete');await flush();
  pending.resolve(h.thread(0,[h.saved('오래된 답변','older').data,h.saved('삭제된 답변').data],true));await flush();
  assert.equal(node.row('reply-1'),undefined);assert.equal(node.row('older'),undefined);assert.equal(node.controls.more.disabled,false);
  h.queue.push(Promise.resolve(h.thread(0,[h.saved('진짜 이전 답변','older').data])));node.controls.more.onclick();await flush();
  assert.equal(h.requests.at(-1).args.p_before_id,'reply-1');assert.match(node.row('older').markup,/진짜 이전 답변/);assert.ok(!node.controls.list.html.includes('아직 답변이 없어요'));
  const h2=replyHarness(),n2=await h2.open(h2.thread(0,[h2.saved('이전 본문').data],true)),late=deferred();h2.queue.push(late.promise);n2.controls.more.onclick();
  n2.click('reply-1','edit');n2.edit('reply-1','최신 수정');h2.queue.push(Promise.resolve(h2.saved('최신 수정','reply-1',1)));n2.click('reply-1','save');await flush();
  late.resolve(h2.thread(0,[h2.saved('이전 본문').data]));await flush();assert.match(n2.row('reply-1').markup,/최신 수정/);
});
test('mutation acknowledgements must match owner, reply, revision, body and creation time',()=>{
  const h=replyHarness(),previous=Domain.replyRow(h.saved('원본').data,'emotion',0),valid=h.saved('수정','reply-1',1).data;
  assert.equal(Domain.editedReply(valid,previous,'수정').replyRevision,1);
  for(const changes of [{id:'foreign'},{user_id:'member-b'},{body:'다른 내용'},{reply_revision:0},{reply_revision:2},{created_at:'2026-09-29T10:00:00Z'},{updated_at:null},{deleted:true}])assert.throws(()=>Domain.editedReply({...valid,...changes},previous,'수정'));
  assert.equal(Domain.deletedReply(h.deleted().data,previous),'reply-1');for(const changes of [{id:'foreign'},{user_id:'member-b'},{reply_revision:0},{reply_revision:2},{deleted:false},{book_id:'body'},{question_revision:1}])assert.throws(()=>Domain.deletedReply({...h.deleted().data,...changes},previous));
});
test('author popup Back restores its trigger; pagination creates no additional popup entry',async()=>{
  const h=popupHarness('author');await h.api.load();h.api.bind();h.click();
  assert.equal(h.opened.length,1);assert.equal(h.opened[0].key,'community-author');
  const node=h.nodes[0];node.controls.more.onclick();assert.equal(h.opened.length,1);
  h.opened[0].options.close();
  assert.equal(node.open,false);assert.equal(node.isConnected,false);assert.equal(h.trigger.focused,true);
  assert.deepEqual(h.closed,['community-author']);
  h.click();h.nodes[1].controls.link.events.click();
  assert.deepEqual(h.closed,['community-author','community-author'],'following a post link also releases the popup entry');
});
test('question popup Back preserves its draft and remains guarded while a save is pending',async()=>{
  const h=popupHarness('question');await h.api.load();h.api.bind();h.click();await flush();
  const first=h.nodes[0];first.controls.input.value='뒤로 가도 남아야 하는 질문';first.controls.input.events.input();
  h.opened[0].options.close();h.click();await flush();
  const node=h.nodes[1],entry=h.opened[1];
  assert.equal(node.controls.input.value,'뒤로 가도 남아야 하는 질문');
  assert.equal(entry.options.canClose(),true);
  const save=deferred();h.queue.push(save.promise);node.controls.form.events.submit({preventDefault(){}});await flush();
  assert.equal(entry.options.canClose(),false);assert.equal(node.open,true);
  save.resolve({data:{book_id:'emotion',question:'뒤로 가도 남아야 하는 질문',revision:1}});await flush();
  assert.equal(node.open,false);assert.deepEqual(h.closed,['community-question','community-question']);
});
test('account reset releases an open popup and does not restore it after a slow question load',async()=>{
  const h=popupHarness('question');await h.api.load();h.api.bind();
  const pending=deferred();h.queue.push(pending.promise);h.click();await flush();
  const node=h.nodes[0];h.api.reset();
  assert.equal(node.open,false);assert.deepEqual(h.closed,['community-question']);
  pending.resolve({data:[{book_id:'emotion',question:'stale question',revision:1}]});await flush();
  assert.equal(h.opened.length,1);assert.equal(node.controls.input.value,'');
});
test('author posts include only exact author shared posts in currently accessible books, in chronological order',()=>{
  const posts={a:{id:'a',userId:'author',bookId:'emotion',createdAt:'2026-09-21T12:00:00Z'},
    b:{id:'b',userId:'author',bookId:'thought',createdAt:Date.parse('2026-09-23T12:00:00Z')},
    hidden:{id:'hidden',userId:'author',bookId:'body',createdAt:Date.now()},
    other:{id:'other',userId:'somebody',bookId:'emotion',createdAt:Date.now()},
    malformed:{userId:'author',bookId:'emotion',createdAt:Date.now()},empty:null};
  assert.deepEqual(Domain.authorPosts(posts,'author',['emotion','thought'],true).map(p=>p.id),['b','a']);
  assert.deepEqual(Domain.authorPosts(posts,'author',['emotion'],true).map(p=>p.id),['a']);
  assert.deepEqual(Domain.authorPosts(posts,'author',['emotion'],false),[]);
  assert.deepEqual(Domain.authorPosts(posts,'', ['emotion'],true),[]);
  assert.equal(Object.keys(posts).length,6,'source collection is unchanged');
});
test('question defaults remain per-book and server rows require valid known books and revisions',()=>{
  const rows=Domain.questionRows([{book_id:'thought',question:'  새로운 질문?  ',revision:'2'}]);
  assert.equal(Domain.questionFor({id:'thought'},rows),'새로운 질문?');
  assert.equal(Domain.questionFor({id:'emotion'},rows),Domain.defaults.emotion);
  for(const row of [{book_id:'missing',question:'?',revision:1},{book_id:'emotion',question:' ',revision:1},
    {book_id:'emotion',question:'가'.repeat(241),revision:1},{book_id:'emotion',question:'?',revision:0}])assert.throws(()=>Domain.questionRows([row]));
  assert.equal(Domain.validQuestion('🌱'.repeat(240)),true);
  assert.equal(Domain.validQuestion('🌱'.repeat(241)),false);
});
test('guest question loading sends no RPC and member result renders escaped shared text',async()=>{
  const h=harness();h.c.SESSION=null;assert.equal(await h.api.load(),false);assert.equal(h.requests.length,0);
  h.c.SESSION={userId:'member-a'};
  h.queue.push(Promise.resolve({data:[{book_id:'emotion',question:'<img src=x onerror=bad()>',revision:1}]}));
  assert.equal(await h.api.load(),true);
  const markup=h.api.promptHtml({id:'emotion'});
  assert.ok(markup.includes('&lt;img'));assert.ok(!markup.includes('<img'));assert.ok(markup.includes('data-question-edit'));
  h.c.isAdmin=()=>false;assert.ok(!h.api.promptHtml({id:'emotion'}).includes('data-question-edit'));
});
test('slow question loads are ignored after logout, account change, or same-account epoch change',async()=>{
  for(const change of [h=>{h.c.SESSION=null;},h=>{h.c.SESSION={userId:'member-b'};},h=>{h.c.saveSessionEpoch++;}]){
    const h=harness(),pending=deferred();h.queue.push(pending.promise);
    const load=h.api.load();await Promise.resolve();change(h);
    pending.resolve({data:[{book_id:'emotion',question:'OLD SESSION QUESTION',revision:1}]});
    assert.equal(await load,false);
    assert.ok(!h.api.promptHtml({id:'emotion'}).includes('OLD SESSION QUESTION'));
  }
});
test('question refresh failure or malformed response preserves last confirmed shared question',async()=>{
  const h=harness();h.queue.push(Promise.resolve({data:[{book_id:'emotion',question:'마지막으로 저장한 질문',revision:3}]}));await h.api.load();
  for(const response of [{error:{code:'offline'}},{data:[{book_id:'emotion',question:'bad',revision:-1}]}]){
    h.queue.push(Promise.resolve(response));assert.equal(await h.api.load(true),false);
    assert.ok(h.api.promptHtml({id:'emotion'}).includes('마지막으로 저장한 질문'));
  }
});
test('reset invalidates an outstanding question request even before the Auth session changes',async()=>{
  const h=harness(),pending=deferred();h.queue.push(pending.promise);const load=h.api.load();await Promise.resolve();
  h.api.reset();pending.resolve({data:[{book_id:'emotion',question:'stale question',revision:1}]});
  assert.equal(await load,false);assert.ok(!h.api.promptHtml({id:'emotion'}).includes('stale question'));
});
test('the real adapter runs with application helpers and mutable session entirely inside an IIFE, not window',async()=>{
  const calls=[];
  const c={Promise,Array,Object,Number,Date,Set,document:{querySelectorAll:()=>[],querySelector:()=>null},GrowellCommunity:Domain,
    addEventListener(){},fixture:{esc,rpc:async name=>{calls.push(name);return {data:[{book_id:'emotion',question:'서버의 공유 질문',revision:1}]};}}};
  c.window=c;vm.createContext(c);vm.runInContext(featureSource,c);
  c.localApp=vm.runInContext(`(function(){
    let SESSION={userId:'inside-iife'},STATE={posts:{},users:{}},saveSessionEpoch=1;
    const sb={rpc:fixture.rpc},svgIcon=icon=>'<svg>'+icon+'</svg>',esc=fixture.esc,bookById=id=>({id,title:'테스트 책'}),isAdmin=()=>true;
    const I_CLOSE='close',I_COMMENT='comment',I_EDIT='edit';
    const avatarHtml=()=>'<span>avatar</span>',fmtPostDate=()=> '오늘',homePostExcerpt=()=> '내용',homeUnlockedIds=()=>['emotion'],safePhotoUrl=()=>null,showToast=()=>{};
    ${adapterSource}
    return {switchUser(){SESSION={userId:'new-iife-member'};saveSessionEpoch++;},prompt(){return GrowellCommunityFeatures.promptHtml(bookById('emotion'));}};
  })()`,c);
  for(const name of ['SESSION','STATE','saveSessionEpoch','sb','svgIcon','esc','bookById','isAdmin','avatarHtml','fmtPostDate','homePostExcerpt','homeUnlockedIds','safePhotoUrl','showToast'])assert.equal(c[name],undefined,name+' must remain closure-local');
  assert.ok(c.localApp.prompt().includes('<svg>comment</svg>'));
  assert.equal(await c.GrowellCommunityFeatures.load(),true);
  assert.ok(c.localApp.prompt().includes('서버의 공유 질문'));
  c.GrowellCommunityFeatures.bind();
  c.localApp.switchUser();assert.ok(!c.localApp.prompt().includes('서버의 공유 질문'));
  assert.equal(await c.GrowellCommunityFeatures.load(),true);
  assert.deepEqual(calls,['growell_get_book_questions','growell_get_book_questions']);
});
