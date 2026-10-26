(function(root,factory){
  'use strict';var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.GrowellPrivateShare=api;
})(typeof window!=='undefined'?window:globalThis,function(root){
  'use strict';
  function create(options){
    options=options||{};
    var browser=options.browser||root,document=options.document||browser.document,app=null,active=null,epoch=0,opening=0,unbind=null,drain=Promise.resolve();
    var historyKey='private-share',schedule=options.setTimeout||(browser.setTimeout&&browser.setTimeout.bind(browser)),cancelTimer=options.clearTimeout||(browser.clearTimeout&&browser.clearTimeout.bind(browser));
    function copy(value){return JSON.parse(JSON.stringify(value));}
    function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
    function href(){return browser.location?String(browser.location.href):'';}
    function toast(message,error){try{if(app)app.toast(message,!!error);}catch(_){} }
    function valid(state){try{return !!(app&&state&&state.epoch===epoch&&state.url===href()&&app.current(state.source)===true);}catch(_){return false;}}
    function draftValid(state,adapter){try{return !!(app&&app===adapter&&(typeof adapter.draftCurrent==='function'?adapter.draftCurrent(state.source)===true:valid(state)));}catch(_){return false;}}
    function live(state){return active===state&&!state.closed&&state.node.isConnected&&valid(state);}
    function snapshot(state){return {v:1,fields:copy(state.fields),operation:copy(state.operation),attempted:!!state.attempted};}
    function goodDraft(value){return !!(value&&value.v===1&&value.fields&&typeof value.fields==='object'&&!Array.isArray(value.fields)&&value.operation&&typeof value.operation.postId==='string'&&value.operation.postId&&Number.isFinite(value.operation.createdAt)&&typeof value.attempted==='boolean');}
    function status(state,message,error){if(!live(state))return;var target=state.node.querySelector('[data-ps-status]');if(target){target.textContent=message;target.setAttribute('data-error',error?'true':'false');}}
    function persist(state){
      var value=snapshot(state),adapter=app;
      var job=state.queue.catch(function(){}).then(async function(){
        if(!draftValid(state,adapter))throw new Error('stale-private-share');
        await adapter.writeDraft(state.source,value);
        if(!draftValid(state,adapter))throw new Error('stale-private-share');
        state.saved=value;state.saveError=null;
        if(live(state)&&!state.busy)status(state,'나눔용 수정 내용이 임시 저장됐어요.',false);
      });
      state.queue=job;drain=Promise.allSettled([drain,job]);
      job.catch(function(error){state.saveError=error;if(live(state)&&!state.busy)status(state,'임시 저장하지 못했어요. 다시 시도해주세요.',true);});
      return job;
    }
    function readFields(state){
      if(!live(state)||state.phase!=='edit'||state.attempted||state.busy)return;
      var n=state.node,editor=n.querySelector('[data-ps-editor]');
      state.fields.title=n.querySelector('[data-ps-title]').value;
      var page=n.querySelector('[data-ps-page]').value;if(page!==String(state.fields.page==null?'':state.fields.page))state.fields.page=page;
      state.fields.noteType=n.querySelector('[data-ps-category]').value;
      state.fields.html=app.sanitizeHtml?app.sanitizeHtml(editor.innerHTML):esc(editor.textContent);
      if(app.plainText)state.fields.text=app.plainText(state.fields.html);
    }
    function changed(state){if(!live(state)||state.attempted||state.busy)return;readFields(state);persist(state);}
    function cleanupEditor(state){if(state.editorCleanup){try{state.editorCleanup();}catch(_){}state.editorCleanup=null;}}
    function close(state,restore){
      if(!state||state.closed)return;
      if(live(state)&&state.phase==='edit'&&!state.attempted&&!state.busy){readFields(state);persist(state);}
      var focus=state.trigger,canFocus=valid(state);state.closed=true;if(active===state)active=null;
      cleanupEditor(state);if(state.timer&&cancelTimer)cancelTimer(state.timer);
      if(browser.removeEventListener)browser.removeEventListener('hashchange',state.route);
      try{if(state.node.open)state.node.close();}catch(_){}state.node.remove();
      if(browser.GrowellPopupHistory)browser.GrowellPopupHistory.closed(historyKey);
      if(restore!==false&&canFocus&&focus&&focus.isConnected&&focus.focus){try{focus.focus({preventScroll:true});}catch(_){} }
    }
    function lock(state,locked){
      state.node.querySelectorAll('[data-ps-mutable]').forEach(function(node){node.disabled=locked;});
      ['close','cancel'].forEach(function(key){var button=state.node.querySelector('[data-ps-'+key+']');if(button)button.disabled=locked;});
      var toolbar=state.node.querySelector('.rt-controls');if(toolbar)toolbar.querySelectorAll('button').forEach(function(node){node.disabled=locked;});
      var editor=state.node.querySelector('[data-ps-editor]');if(editor)editor.setAttribute('contenteditable',locked?'false':'true');
      var action=state.node.querySelector('[data-ps-publish]');if(action)action.disabled=locked;
    }
    function preview(state){var html=app.previewHtml(copy(state.fields));return typeof html==='string'?html:'';}
    function render(state){
      if(!live(state))return;cleanupEditor(state);
      var n=state.node,edit=state.phase==='edit'&&!state.attempted;
      n.className='private-share-dialog'+(edit?' is-editing':'');
      var notice=state.notice?'<p class="ps-notice">'+esc(state.notice)+'</p>':'';
      var body='<p class="ps-description">나눔에 올리면 모임원이 볼 수 있어요. 나의 공간 원문은 그대로 남아요.</p>'+notice;
      if(!edit&&!state.attempted)body+='<p class="ps-confirm-question">나누기 전에 글을 수정할까요?</p>';
      if(edit){
        var types=[['quote','책 속 문장'],['thought','내 생각'],['question','의문점']];
        if(!types.some(function(t){return t[0]===state.fields.noteType;}))types.push([state.fields.noteType||'thought',state.fields.noteType==='insight'?'통찰 정리':'기존 분류']);
        body+='<div class="ps-edit-form"><label class="ps-field"><span>제목</span><input type="text" maxlength="300" data-ps-title data-ps-mutable></label><div class="ps-meta"><label class="ps-field"><span>분류</span><select data-ps-category data-ps-mutable>'+types.map(function(t){return '<option value="'+esc(t[0])+'">'+esc(t[1])+'</option>';}).join('')+'</select></label><label class="ps-field ps-page"><span>페이지</span><input type="text" inputmode="numeric" placeholder="—" data-ps-page data-ps-mutable></label></div><div class="ps-rich-editor">'+(app.toolbarHtml?app.toolbarHtml():'')+'<div class="note-editor" data-ps-editor contenteditable="true" role="textbox" aria-label="나눔할 글 내용" aria-multiline="true"></div></div>';
        if(state.fields.photo)body+='<div class="ps-photo"><div data-ps-photo-preview></div><button type="button" class="ps-text-button" data-ps-remove-photo data-ps-mutable>사진 삭제</button></div>';
        body+='</div>';
      }else body+='<div class="ps-preview" data-ps-preview>'+preview(state)+'</div>';
      var buttons=state.attempted?'<button type="button" class="btn btn-primary" data-ps-publish>다시 확인하고 나누기</button>':edit?'<button type="button" class="btn btn-secondary" data-ps-return data-ps-mutable>미리보기</button><button type="button" class="btn btn-primary" data-ps-publish>수정한 글 나누기</button>':'<button type="button" class="btn btn-secondary" data-ps-edit data-ps-mutable>수정하고 나누기</button><button type="button" class="btn btn-primary" data-ps-publish>그대로 나누기</button>';
      n.innerHTML='<header class="ps-header"><h2 id="private-share-title">나눔으로 공유</h2><button type="button" class="ps-close" data-ps-close aria-label="공유 닫기">×</button></header><div class="ps-body">'+body+'</div><footer class="ps-footer"><p class="ps-status" data-ps-status role="status"></p><div class="ps-actions"><button type="button" class="ps-text-button" data-ps-cancel>취소</button>'+buttons+'</div></footer>';
      n.querySelector('[data-ps-close]').addEventListener('click',function(){if(!state.busy)close(state);});n.querySelector('[data-ps-cancel]').addEventListener('click',function(){if(!state.busy)close(state);});
      n.querySelector('[data-ps-publish]').addEventListener('click',function(){publish(state);});
      var editButton=n.querySelector('[data-ps-edit]');if(editButton)editButton.addEventListener('click',function(){if(live(state)&&!state.busy&&!state.attempted){state.phase='edit';render(state);}});
      var back=n.querySelector('[data-ps-return]');if(back)back.addEventListener('click',function(){if(!live(state)||state.busy)return;readFields(state);persist(state);state.phase='confirm';render(state);});
      if(edit){
        n.querySelector('[data-ps-title]').value=state.fields.title||'';n.querySelector('[data-ps-category]').value=state.fields.noteType||'thought';n.querySelector('[data-ps-page]').value=state.fields.page==null?'':String(state.fields.page);
        var editor=n.querySelector('[data-ps-editor]');editor.innerHTML=app.sanitizeHtml?app.sanitizeHtml(state.fields.html||''):esc(state.fields.text||'');
        ['title','page','category'].forEach(function(key){n.querySelector('[data-ps-'+key+']').addEventListener(key==='category'?'change':'input',function(){changed(state);});});
        editor.addEventListener('input',function(){changed(state);});
        if(app.bindEditor)state.editorCleanup=app.bindEditor(n,function(){changed(state);});
        var remove=n.querySelector('[data-ps-remove-photo]');if(remove){
          var photoFields=copy(state.fields);photoFields.title='';photoFields.html='';photoFields.text='';n.querySelector('[data-ps-photo-preview]').innerHTML=app.previewHtml(photoFields);
          remove.addEventListener('click',function(){if(!live(state)||state.attempted||state.busy)return;readFields(state);state.fields.photo=null;persist(state);render(state);});
        }
      }
      if(state.attempted)status(state,'이전에 나누기를 시도한 글이에요. 같은 글을 확인해 중복 없이 이어서 나눠요.',false);
      else if(state.restored)status(state,'이전에 준비하던 나눔글을 불러왔어요.',false);
      try{n.querySelector(edit?'[data-ps-title]':'[data-ps-publish]').focus({preventScroll:true});}catch(_){} }
    async function publish(state){
      if(!live(state)||state.busy||state.success)return;
      readFields(state);
      if(!state.attempted&&app.validateFields){
        try{var prepared=app.validateFields(copy(state.fields));if(!prepared||typeof prepared!=='object'||Array.isArray(prepared))throw new Error('private-share-invalid-fields');state.fields=copy(prepared);}
        catch(error){status(state,'나눔할 내용을 확인해주세요. 글이나 사진을 남겨야 나눌 수 있어요.',true);return;}
      }
      state.busy=true;lock(state,true);status(state,'나눔에 올리고 있어요.',false);
      try{
        if(!state.attempted){state.operation=copy(app.newOperation());state.attempted=true;if(!goodDraft(snapshot(state)))throw new Error('private-share-invalid-operation');}
        // Persist the exact fields and operation before the first remote write.
        // A response lost after insertion can only retry this same operation.
        await persist(state);if(!live(state))return;
        var frozen=snapshot(state),result=await app.publish(state.source,copy(frozen.fields),copy(frozen.operation));if(!live(state))return;
        if(!result||result.postId!==frozen.operation.postId)throw new Error('private-share-unconfirmed');
        state.success=true;
        try{await app.clearDraft(state.source,frozen);}catch(_){/* A confirmed publication stays successful even if local cleanup fails. */}
        if(!live(state))return;
        var adapter=app;close(state,false);if(valid(state)){toast('나눔에 올렸어요.',false);if(adapter.done)adapter.done(result);}
      }catch(error){
        if(!live(state))return;
        state.phase='confirm';render(state);status(state,state.saveError?'공유할 내용을 임시 저장하지 못했어요. 다시 시도해주세요.':'나눔 결과를 확인하지 못했어요. 같은 글로 다시 확인해주세요.',true);
      }finally{state.busy=false;if(live(state)&&!state.success)lock(state,false);}
    }
    async function open(entryId,trigger){
      if(!app||!document||typeof entryId!=='string'||!entryId)return false;
      var ticket=++opening,adapter=app,old=active,requestUrl=href(),requestEpoch=epoch;if(old)close(old,false);
      try{
        await drain;if(ticket!==opening||adapter!==app||requestEpoch!==epoch||requestUrl!==href())return false;
        var loaded=await adapter.load(entryId);if(ticket!==opening||adapter!==app||requestEpoch!==epoch||requestUrl!==href()||!loaded||!loaded.source||!loaded.fields||adapter.current(loaded.source)!==true)return false;
        var state={source:loaded.source,fields:copy(loaded.fields),notice:loaded.notice||'',operation:null,attempted:false,restored:false,phase:'confirm',closed:false,busy:false,success:false,queue:Promise.resolve(),epoch:requestEpoch,url:requestUrl,trigger:trigger||document.activeElement};
        var draft=await adapter.readDraft(state.source);if(ticket!==opening||!valid(state))return false;
        if(draft!=null){if(!goodDraft(draft))throw new Error('private-share-invalid-draft');state.fields=copy(draft.fields);state.operation=copy(draft.operation);state.attempted=draft.attempted;state.restored=true;}
        else state.operation=copy(adapter.newOperation());
        if(!goodDraft(snapshot(state)))throw new Error('private-share-invalid-operation');
        var node=document.createElement('dialog');state.node=node;node.className='private-share-dialog';node.setAttribute('aria-labelledby','private-share-title');document.body.appendChild(node);active=state;render(state);
        node.addEventListener('cancel',function(event){event.preventDefault();if(!state.busy)close(state);});node.addEventListener('close',function(){if(!state.closed)close(state);});
        state.route=function(){if(!valid(state))close(state,false);};if(browser.addEventListener)browser.addEventListener('hashchange',state.route);
        function watch(){if(active!==state)return;if(!valid(state)){close(state,false);return;}if(schedule)state.timer=schedule(watch,600);}if(schedule)state.timer=schedule(watch,600);
        try{node.showModal();if(browser.GrowellPopupHistory)browser.GrowellPopupHistory.open(historyKey,{close:function(){if(!state.busy)close(state);},canClose:function(){return !state.busy;}});}catch(error){close(state,false);throw error;}
        return true;
      }catch(error){if(state&&active===state)close(state,false);if(ticket===opening&&adapter===app)toast('글을 불러오지 못했어요. 원문은 그대로 남아 있어요.',true);return false;}
    }
    function reset(){opening++;epoch++;if(active)close(active,false);}
    function configure(adapter){
      ['load','current','publish','newOperation','readDraft','writeDraft','clearDraft','previewHtml','toast'].forEach(function(key){if(!adapter||typeof adapter[key]!=='function')throw new TypeError('Missing private share adapter: '+key);});reset();app=adapter;
    }
    function bind(){
      if(unbind)unbind();if(!document||!document.addEventListener)return function(){};
      var listener=function(event){var target=event.target&&event.target.closest?event.target.closest('[data-private-share]'):null;if(!target||target.disabled)return;event.preventDefault();event.stopPropagation();open(target.getAttribute('data-private-share'),target);};
      document.addEventListener('click',listener);unbind=function(){document.removeEventListener('click',listener);unbind=null;};return unbind;
    }
    return {configure:configure,open:open,bind:bind,reset:reset};
  }
  var api=create();api.create=create;return api;
});
