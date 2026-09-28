(function(root){
  'use strict';
  // The main application lives inside an IIFE. Its helpers/state must be passed
  // explicitly; they are not window properties, even when declared with var.
  var app=null;
  function configure(adapter){
    ['avatarHtml','bookById','esc','fmtPostDate','homePostExcerpt','homeUnlockedIds','isAdmin','safePhotoUrl','showToast','svgIcon'].forEach(function(name){
      if(!adapter||typeof adapter[name]!=='function')throw new Error('Missing community adapter: '+name);
    });
    if(!adapter.sb||typeof adapter.sb.rpc!=='function')throw new Error('Missing community RPC adapter');
    reset();app=adapter;
  }
  var rows=Object.create(null),owner=null,epoch=null,status='idle',requestId=0,lastQuestionBook=null;
  var dialog=null,dialogKind=null,returnFocus=null,drafts=Object.create(null);
  var authorId=null,authorLimit=12,questionSaving=false,replyDrafts=Object.create(null),replyAttempts=Object.create(null),replyEditDrafts=Object.create(null);
  function member(){return app.SESSION&&app.SESSION.userId;}
  function current(expected){return member()===expected.owner&&app.saveSessionEpoch===expected.epoch;}
  function reset(){
    requestId++;close(false);rows=Object.create(null);drafts=Object.create(null);replyDrafts=Object.create(null);replyAttempts=Object.create(null);replyEditDrafts=Object.create(null);owner=null;epoch=null;status='idle';lastQuestionBook=null;
  }
  function ensureOwner(){if(owner!==member()||epoch!==app.saveSessionEpoch){reset();owner=member();epoch=app.saveSessionEpoch;}}
  function syncPrompt(){
    document.querySelectorAll('[data-community-question]').forEach(function(node){var book=app.bookById(node.getAttribute('data-community-question'));if(book)node.textContent=root.GrowellCommunity.questionFor(book,rows);});
    document.querySelectorAll('[data-question-edit]').forEach(function(button){button.disabled=status==='loading';button.title=status==='error'?'질문을 다시 불러온 뒤 수정해요':'이 책의 질문 수정';});
  }
  function load(force){
    ensureOwner();if(!owner||status==='loading'||(!force&&status==='ready'))return Promise.resolve(false);
    var expected={owner:owner,epoch:epoch},id=++requestId;status='loading';syncPrompt();
    return Promise.resolve().then(function(){if(!current(expected)||id!==requestId)return null;return app.sb.rpc('growell_get_book_questions');}).then(function(result){
      if(!current(expected)||id!==requestId)return false;
      if(!result||result.error)throw result&&result.error||new Error('question-load-failed');
      rows=root.GrowellCommunity.questionRows(result.data);status='ready';syncPrompt();return true;
    }).catch(function(){if(current(expected)&&id===requestId){status='error';syncPrompt();}return false;});
  }
  function promptHtml(book){
    ensureOwner();
    return '<div class="space-prompt">'+app.svgIcon(app.I_COMMENT)+'<div><small>함께 고민하고 생각해요.</small><strong data-community-question="'+app.esc(book.id)+'">'+app.esc(root.GrowellCommunity.questionFor(book,rows))+'</strong></div><div class="space-prompt-actions"><button class="btn btn-ghost" type="button" data-space-prompt="'+app.esc(book.id)+'" aria-haspopup="dialog">내 생각 남기기 →</button>'+(app.isAdmin()?'<button class="community-question-edit" type="button" data-question-edit="'+app.esc(book.id)+'" aria-haspopup="dialog">'+app.svgIcon(app.I_EDIT)+' 질문 수정</button>':'')+'</div></div>';
  }
  function close(restore){
    if(!dialog)return;
    var node=dialog,target=returnFocus,key='community-'+dialogKind;
    dialog=null;dialogKind=null;returnFocus=null;authorId=null;questionSaving=false;
    if(node.open)node.close();node.remove();
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed(key);
    if(restore!==false&&target&&target.isConnected)target.focus({preventScroll:true});
  }
  function trackDialog(node,kind){
    if(!root.GrowellPopupHistory)return;
    root.GrowellPopupHistory.open('community-'+kind,{
      close:function(){if(dialog===node)close();},
      canClose:function(){return dialog!==node||!questionSaving;}
    });
  }
  function makeDialog(kind,trigger){
    close(false);dialogKind=kind;returnFocus=trigger||document.activeElement;
    dialog=document.createElement('dialog');dialog.className='community-dialog community-dialog--'+kind;
    dialog.setAttribute('aria-labelledby','community-dialog-title');document.body.appendChild(dialog);
    dialog.addEventListener('cancel',function(event){event.preventDefault();if(!questionSaving)close();});
    dialog.addEventListener('click',function(event){if(event.target===dialog&&!questionSaving){var rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();}});
    return dialog;
  }
  function openQuestion(bookId,trigger){
    if(!member()||!app.isAdmin())return;
    var book=app.bookById(bookId);if(!book)return;
    var node=makeDialog('question',trigger),expected={owner:member(),epoch:app.saveSessionEpoch};
    node.innerHTML='<div class="community-dialog-head"><h2 id="community-dialog-title">함께 생각할 질문</h2><button type="button" class="icon-btn" data-community-close aria-label="질문 수정 닫기">'+app.svgIcon(app.I_CLOSE)+'</button></div><p class="community-dialog-intro">'+app.esc(book.title)+'<br>저장하면 모임원 모두에게 이 질문이 보여요.</p><p role="status">질문을 불러오는 중이에요…</p>';
    node.querySelector('[data-community-close]').onclick=function(){close();};node.showModal();trackDialog(node,'question');
    load(true).then(function(ok){
      if(dialog!==node||!current(expected)||!app.isAdmin())return;
      if(!ok){node.querySelector('[role="status"]').outerHTML='<p class="community-question-message" role="alert">질문을 불러오지 못했어요. 닫은 뒤 다시 시도해주세요. 저장된 질문은 바뀌지 않았어요.</p>';return;}
      var revision=rows[bookId]?rows[bookId].revision:0;
      var draft=Object.prototype.hasOwnProperty.call(drafts,bookId)?drafts[bookId]:root.GrowellCommunity.questionFor(book,rows);
      node.querySelector('[role="status"]').outerHTML='<form class="community-question-form"><label for="community-question-input">모임원에게 건넬 질문</label><textarea id="community-question-input" rows="4" maxlength="480" required>'+app.esc(draft)+'</textarea><div class="community-question-meta"><span>최대 240자</span><span data-question-count></span></div><p class="community-question-message" role="status" aria-live="polite"></p><div class="community-dialog-actions"><button class="btn btn-secondary" type="button" data-question-cancel>닫기</button><button class="btn btn-primary" type="submit">질문 저장</button></div></form>';
      var form=node.querySelector('form'),input=node.querySelector('textarea'),save=form.querySelector('[type="submit"]'),message=node.querySelector('.community-question-message');
      function capture(){drafts[bookId]=input.value;node.querySelector('[data-question-count]').textContent=Array.from(input.value.trim()).length+' / 240';}
      input.addEventListener('input',capture);capture();input.focus();
      node.querySelector('[data-question-cancel]').onclick=function(){close();};
      form.addEventListener('submit',function(event){
        event.preventDefault();if(questionSaving||!current(expected)||!app.isAdmin())return;
        var text=root.GrowellCommunity.question(input.value);capture();
        if(!root.GrowellCommunity.validQuestion(text)){message.textContent='질문을 1자 이상, 240자 이내로 적어주세요.';input.focus();return;}
        questionSaving=true;save.disabled=true;save.textContent='저장 중…';input.disabled=true;node.querySelectorAll('[data-community-close],[data-question-cancel]').forEach(function(b){b.disabled=true;});message.textContent='';
        Promise.resolve().then(function(){if(!current(expected)||dialog!==node||!app.isAdmin())return null;return app.sb.rpc('growell_save_book_question',{p_book_id:bookId,p_question:text,p_expected_revision:revision});}).then(function(result){
          if(!current(expected)||dialog!==node)return;
          if(!result||result.error)throw result&&result.error||new Error('question-save-failed');
          var saved=root.GrowellCommunity.questionRows([result.data]);
          if(!saved[bookId]||saved[bookId].question!==text||saved[bookId].revision<=revision)throw new Error('question-save-invalid');
          requestId++;rows[bookId]=saved[bookId];status='ready';delete drafts[bookId];questionSaving=false;syncPrompt();close();app.showToast('함께 생각할 질문을 저장했어요.');
        }).catch(function(error){
          if(!current(expected)||dialog!==node)return;
          message.textContent=error&&error.code==='40001'?'다른 곳에서 질문이 수정되었어요. 최신 질문을 확인한 뒤 다시 저장해주세요.':'저장하지 못했어요. 작성한 질문은 유지되니 다시 시도해주세요.';
          if(error&&error.code==='40001'){
            var refresh=document.createElement('button');refresh.type='button';refresh.className='btn btn-secondary';refresh.textContent='최신 질문 확인';message.appendChild(document.createElement('br'));message.appendChild(refresh);
            refresh.onclick=function(){
              refresh.disabled=true;
              load(true).then(function(loaded){
                if(dialog!==node||!current(expected))return;
                if(!loaded){refresh.disabled=false;return;}
                revision=rows[bookId]?rows[bookId].revision:0;
                message.textContent='현재 저장된 질문: '+root.GrowellCommunity.questionFor(book,rows)+'\n작성 중인 내용은 그대로 두었어요. 확인 후 질문 저장을 누르면 내 내용으로 바뀌어요.';
              });
            };
          }
        }).finally(function(){if(dialog===node&&current(expected)){questionSaving=false;save.disabled=false;save.textContent='질문 저장';input.disabled=false;node.querySelectorAll('[data-community-close],[data-question-cancel]').forEach(function(b){b.disabled=false;});}});
      });
    });
  }
  function replyHtml(reply){
    var own=reply.userId===member(),id=app.esc(reply.id);
    return '<article class="community-reply" data-question-reply="'+id+'"><div class="community-reply-heading">'+app.avatarHtml(reply.userId,reply.name,'emotion')+'<div><strong>'+app.esc(reply.name)+'</strong><time>'+app.esc(app.fmtPostDate(reply.createdAt))+(reply.updatedAt?' · 수정됨':'')+'</time></div>'+(own?'<span class="community-reply-mine">내 답변</span>':'')+'</div><p>'+app.esc(reply.body)+'</p>'+(own?'<div class="community-reply-actions"><button type="button" data-reply-action="edit" data-reply-id="'+id+'">수정</button><button type="button" data-reply-action="delete" data-reply-id="'+id+'">삭제</button></div><div data-reply-editor></div>':'')+'</article>';
  }
  function openReplies(bookId,trigger){
    if(!member()||app.homeUnlockedIds().indexOf(bookId)<0)return;
    var book=app.bookById(bookId);if(!book)return;
    var node=makeDialog('replies',trigger),expected={owner:member(),epoch:app.saveSessionEpoch},thread=null,key=null,editors=Object.create(null),mutationVersion=0,threadVersion=0,threadLoading=false,pageCursor=null;
    function live(){return dialog===node&&current(expected);}
    node.innerHTML='<div class="community-dialog-head"><div><small class="community-reply-book">'+app.esc(book.title)+'</small><h2 id="community-dialog-title">함께 고민하고 생각해요.</h2></div><button type="button" class="icon-btn" data-community-close aria-label="질문과 답변 닫기">'+app.svgIcon(app.I_CLOSE)+'</button></div><div data-reply-content><p class="community-question-message" role="status">질문과 답변을 불러오는 중이에요…</p></div>';
    node.querySelector('[data-community-close]').onclick=function(){if(!questionSaving)close();};node.showModal();trackDialog(node,'replies');
    function loadThread(keepDraft){
      var version=++threadVersion;threadLoading=true;
      return Promise.resolve().then(function(){if(!live())return null;return app.sb.rpc('growell_get_question_replies',{p_book_id:bookId,p_before_id:null});}).then(function(result){
        if(!live()||version!==threadVersion)return;
        if(!result||result.error)throw result&&result.error||new Error('reply-load-failed');
        var previousKey=key,next=root.GrowellCommunity.replyThread(result.data,bookId);
        thread=next;key=bookId+':'+thread.revision;editors=Object.create(null);pageCursor=thread.replies.length?thread.replies[0].id:null;
        if(keepDraft&&previousKey&&replyDrafts[previousKey])replyDrafts[key]=replyDrafts[previousKey];
        if(thread.revision>0)rows[bookId]={question:thread.question,revision:thread.revision};else delete rows[bookId];syncPrompt();
        renderThread();
      }).catch(function(){
        if(!live()||version!==threadVersion)return;
        var content=node.querySelector('[data-reply-content]');
        if(thread){node.querySelector('[data-reply-message]').textContent='답변을 불러오지 못했어요. 작성 중인 내용은 그대로 있어요.';return;}
        content.innerHTML='<p class="community-question-message" role="alert">질문과 답변을 불러오지 못했어요. 잠시 후 다시 시도해주세요.</p><button type="button" class="btn btn-secondary" data-reply-retry>다시 불러오기</button>';
        content.querySelector('[data-reply-retry]').onclick=function(){this.disabled=true;loadThread(false);};
      }).finally(function(){if(live()&&version===threadVersion)threadLoading=false;});
    }
    function renderThread(){
      if(!live())return;
      node.querySelector('[data-reply-content]').innerHTML='<blockquote class="community-reply-question">'+app.esc(thread.question)+'</blockquote><section class="community-replies" aria-label="이 질문에 대한 답변">'+(thread.hasMore?'<button class="btn btn-ghost community-reply-more" type="button" data-reply-more>이전 답변 더 보기</button>':'')+'<div data-reply-list>'+(thread.replies.map(replyHtml).join('')||'<p class="community-reply-empty">아직 답변이 없어요. 첫 생각을 들려주세요.</p>')+'</div></section><form class="community-question-form community-reply-form"><label for="community-reply-input">이 질문에 대한 내 생각</label><textarea id="community-reply-input" rows="3" maxlength="4000" placeholder="편하게 생각을 나눠주세요." required>'+app.esc(replyDrafts[key]||'')+'</textarea><div class="community-question-meta"><span>모임원과 함께 보는 답변이에요.</span><span data-reply-count></span></div><p class="community-question-message" data-reply-message role="status" aria-live="polite"></p><div class="community-dialog-actions"><button class="btn btn-primary" type="submit">답변 남기기</button></div></form>';
      var form=node.querySelector('form'),input=node.querySelector('textarea'),save=form.querySelector('[type="submit"]'),message=node.querySelector('[data-reply-message]'),list=node.querySelector('[data-reply-list]');
      function rowNode(id){return Array.from(list.querySelectorAll('[data-question-reply]')).find(function(row){return row.getAttribute('data-question-reply')===id;});}
      function ownReply(id){return thread.replies.find(function(reply){return reply.id===id&&reply.userId===expected.owner;});}
      function editKey(id){return key+':'+id;}
      function syncBusy(){
        input.disabled=questionSaving;save.disabled=questionSaving;node.querySelector('[data-community-close]').disabled=questionSaving;
        list.querySelectorAll('[data-reply-action], [data-reply-edit-input]').forEach(function(control){var state=editors[control.getAttribute('data-reply-id')];control.disabled=questionSaving||!!(state&&state.conflict&&['save','confirm-delete'].indexOf(control.getAttribute('data-reply-action'))>=0);});
      }
      function showEditor(id,focus){
        var row=rowNode(id),state=editors[id],scroll=node.scrollTop;if(!row)return;
        var panel=row.querySelector('[data-reply-editor]');if(!panel)return;
        var actionsNode=row.querySelector('.community-reply-actions');if(actionsNode)actionsNode.hidden=!!state;
        if(!state){panel.innerHTML='';node.scrollTop=scroll;return;}
        var safeId=app.esc(id),actions='<div class="community-reply-edit-actions"><button class="btn btn-secondary" type="button" data-reply-action="cancel" data-reply-id="'+safeId+'">취소</button><button class="btn '+(state.mode==='delete'?'community-reply-delete-confirm':'btn-primary')+'" type="button" data-reply-action="'+(state.mode==='delete'?'confirm-delete':'save')+'" data-reply-id="'+safeId+'">'+(state.mode==='delete'?'삭제':'저장')+'</button></div>';
        panel.innerHTML='<div class="community-reply-editor">'+(state.mode==='delete'?'<p>이 답변을 삭제할까요?</p>':'<label>내 답변 수정<textarea rows="3" maxlength="4000" data-reply-edit-input data-reply-id="'+safeId+'">'+app.esc(state.draft)+'</textarea></label>'+(state.restored?'<p class="community-reply-draft-note">이전에 작성하던 내용이에요. 현재 답변을 확인한 뒤 저장해주세요.</p>':''))+'<p class="community-question-message" role="status" aria-live="polite" data-reply-edit-message>'+app.esc(state.error||'')+'</p>'+actions+'</div>';
        syncBusy();node.scrollTop=scroll;if(focus){var target=panel.querySelector(state.mode==='delete'?'[data-reply-action="cancel"]':'textarea');if(target)target.focus({preventScroll:true});}
      }
      function finishEditor(id){
        var row=rowNode(id),scroll=node.scrollTop;delete editors[id];showEditor(id,false);node.scrollTop=scroll;
        if(row){var edit=row.querySelector('[data-reply-action="edit"]');if(edit)edit.focus({preventScroll:true});}
      }
      function mutateReply(id,remove){
        var previous=ownReply(id),state=editors[id];if(!previous||!state||state.conflict||questionSaving||threadLoading||!live())return;
        var body=root.GrowellCommunity.replyText(state.draft);
        if(!remove&&!root.GrowellCommunity.validReply(body)){state.error='답변을 1자 이상, 2,000자 이내로 적어주세요.';showEditor(id,true);return;}
        if(!remove&&body===previous.body){delete replyEditDrafts[editKey(id)];finishEditor(id);message.textContent='변경된 내용이 없어요.';return;}
        // Keep this row/revision/body unchanged after an uncertain response; retry is idempotent.
        var args={p_id:id,p_expected_reply_revision:previous.replyRevision};if(!remove)args.p_body=body;
        questionSaving=true;mutationVersion++;state.error='';syncBusy();var revision=threadVersion;
        Promise.resolve().then(function(){if(!live())return null;return app.sb.rpc(remove?'growell_delete_question_reply':'growell_update_question_reply',args);}).then(function(result){
          if(!live()||revision!==threadVersion)return;if(!result||result.error)throw result&&result.error||new Error('reply-change-failed');
          var row=rowNode(id),scroll=node.scrollTop;
          if(remove){root.GrowellCommunity.deletedReply(result.data,previous);thread.replies=thread.replies.filter(function(reply){return reply.id!==id;});if(row)row.remove();if(!thread.replies.length)list.innerHTML='<p class="community-reply-empty">아직 답변이 없어요. 첫 생각을 들려주세요.</p>';}
          else{var updated=root.GrowellCommunity.editedReply(result.data,previous,body);thread.replies=thread.replies.map(function(reply){return reply.id===id?updated:reply;});if(row)row.outerHTML=replyHtml(updated);}
          delete replyEditDrafts[editKey(id)];delete editors[id];node.scrollTop=scroll;message.textContent=remove?'답변을 삭제했어요.':'답변을 수정했어요.';
          var savedRow=rowNode(id),target=remove?input:savedRow&&savedRow.querySelector('[data-reply-action="edit"]');if(target)target.focus({preventScroll:true});
        }).catch(function(error){
          if(!live()||revision!==threadVersion)return;
          state.conflict=!!(error&&error.code==='40001');state.error=state.conflict?'다른 곳에서 답변이 변경되었어요. 작성한 내용은 유지했어요. 팝업을 닫고 다시 열어 최신 답변을 확인해주세요.':(remove?'삭제를 확인하지 못했어요. 답변은 그대로 표시되니 다시 눌러주세요.':'수정을 확인하지 못했어요. 작성한 내용은 그대로 있으니 다시 눌러주세요.');showEditor(id,false);
        }).finally(function(){if(live()&&revision===threadVersion){questionSaving=false;syncBusy();}});
      }
      list.addEventListener('input',function(event){
        var control=event.target;if(!control.matches('[data-reply-edit-input]')||!live()||questionSaving)return;
        var id=control.getAttribute('data-reply-id'),state=editors[id];if(state&&state.mode==='edit'){state.draft=control.value;replyEditDrafts[editKey(id)]=control.value;}
      });
      list.addEventListener('click',function(event){
        var button=event.target.closest('[data-reply-action]');if(!button||!list.contains(button)||!live()||questionSaving||threadLoading)return;
        event.preventDefault();event.stopPropagation();var id=button.getAttribute('data-reply-id'),reply=ownReply(id),action=button.getAttribute('data-reply-action');if(!reply)return;
        if(action==='edit'){var savedDraft=replyEditDrafts[editKey(id)];editors[id]={mode:'edit',draft:savedDraft===undefined?reply.body:savedDraft,restored:savedDraft!==undefined&&savedDraft!==reply.body};showEditor(id,true);}
        else if(action==='delete'){editors[id]={mode:'delete'};showEditor(id,true);}
        else if(action==='cancel'){delete replyEditDrafts[editKey(id)];finishEditor(id);}
        else if(action==='save')mutateReply(id,false);
        else if(action==='confirm-delete')mutateReply(id,true);
      });
      function capture(){replyDrafts[key]=input.value;node.querySelector('[data-reply-count]').textContent=Array.from(input.value.trim()).length+' / 2,000';}
      input.addEventListener('input',capture);capture();
      var more=node.querySelector('[data-reply-more]');
      if(more)more.onclick=function(){
        if(more.disabled||questionSaving||threadLoading||!pageCursor)return;more.disabled=true;var previousHeight=node.scrollHeight,previousScroll=node.scrollTop,version=mutationVersion,currentThread=threadVersion;
        app.sb.rpc('growell_get_question_replies',{p_book_id:bookId,p_before_id:pageCursor}).then(function(result){
          if(!live())return;if(result.error)throw result.error;
          if(currentThread!==threadVersion)return;
          if(version!==mutationVersion){more.disabled=false;return;}
          var older=root.GrowellCommunity.replyThread(result.data,bookId);
          if(older.revision!==thread.revision)throw new Error('question-changed');
          var known=new Set(thread.replies.map(function(reply){return reply.id;}));
          var incoming=older.replies.filter(function(reply){return !known.has(reply.id);});
          thread.replies=incoming.concat(thread.replies);thread.hasMore=older.hasMore;if(older.replies.length)pageCursor=older.replies[0].id;
          var empty=list.querySelector('.community-reply-empty');if(incoming.length&&empty)empty.remove();
          node.querySelector('[data-reply-list]').insertAdjacentHTML('afterbegin',incoming.map(replyHtml).join(''));
          if(!thread.hasMore)more.remove();else more.disabled=false;
          node.scrollTop=previousScroll+(node.scrollHeight-previousHeight);
        }).catch(function(){if(live()&&currentThread===threadVersion){more.disabled=false;if(version===mutationVersion)message.textContent='이전 답변을 불러오지 못했어요. 다시 눌러주세요.';}});
      };
      form.addEventListener('submit',function(event){
        event.preventDefault();if(questionSaving||threadLoading||!live())return;
        var text=root.GrowellCommunity.replyText(input.value);capture();
        if(!root.GrowellCommunity.validReply(text)){message.textContent='답변을 1자 이상, 2,000자 이내로 적어주세요.';input.focus();return;}
        if(!replyAttempts[key]||replyAttempts[key].body!==text)replyAttempts[key]={id:root.crypto.randomUUID(),body:text};
        var attempt=replyAttempts[key];questionSaving=true;mutationVersion++;syncBusy();save.textContent='남기는 중…';message.textContent='';
        Promise.resolve().then(function(){if(!live())return null;return app.sb.rpc('growell_add_question_reply',{p_id:attempt.id,p_book_id:bookId,p_expected_revision:thread.revision,p_body:attempt.body});}).then(function(result){
          if(!live())return;if(!result||result.error)throw result&&result.error||new Error('reply-save-failed');
          var reply=root.GrowellCommunity.replyRow(result.data,bookId,thread.revision);
          if(reply.id!==attempt.id||reply.userId!==expected.owner||reply.body!==attempt.body)throw new Error('reply-save-invalid');
          if(!thread.replies.some(function(row){return row.id===reply.id;})){
            thread.replies.push(reply);var list=node.querySelector('[data-reply-list]'),empty=list.querySelector('.community-reply-empty');if(empty)empty.remove();list.insertAdjacentHTML('beforeend',replyHtml(reply));
          }
          delete replyAttempts[key];delete replyDrafts[key];input.value='';capture();message.textContent='답변을 남겼어요.';
        }).catch(function(error){
          if(!live())return;
          message.textContent=error&&error.code==='40001'?'질문이 바뀌었어요. 새 질문을 확인하고 답변 내용을 다시 살펴주세요.':'답변 저장을 확인하지 못했어요. 작성한 내용은 그대로 있으니 다시 눌러주세요.';
          if(error&&error.code==='40001'){
            var refresh=document.createElement('button');refresh.type='button';refresh.className='btn btn-secondary community-reply-refresh';refresh.textContent='새 질문 확인';message.appendChild(refresh);
            refresh.onclick=function(){if(questionSaving||threadLoading||!live())return;refresh.disabled=true;loadThread(true);};
          }
        }).finally(function(){if(live()){questionSaving=false;syncBusy();save.textContent='답변 남기기';}});
      });
    }
    loadThread(false);
  }
  function authorBody(){
    if(!dialog||dialogKind!=='author')return;
    if(!member()){close(false);return;}
    var active=document.activeElement,restore=dialog.contains(active),activeHref=restore&&active.getAttribute('href');
    var user=app.STATE.users[authorId]||{},posts=root.GrowellCommunity.authorPosts(app.STATE.posts,authorId,app.homeUnlockedIds(),true);
    var name=user.name||(posts[0]&&posts[0].userName)||'모임원';
    var items=posts.slice(0,authorLimit).map(function(post){
      var book=app.bookById(post.bookId),excerpt=app.homePostExcerpt(post),title=String(post.title||'').trim()||'함께 나눈 기록';
      var photo=app.safePhotoUrl(post.photo&&post.photo.dataUrl),href='#/book/'+encodeURIComponent(post.bookId)+'/share/post/'+encodeURIComponent(post.id);
      return '<a class="community-author-post" href="'+app.esc(href)+'">'+(photo?'<img src="'+app.esc(photo)+'" alt="" loading="lazy">':'')+'<div><span class="community-author-post-meta">'+app.esc(book.area)+' · '+app.esc(app.fmtPostDate(post.createdAt))+'</span><h3>'+app.esc(title)+'</h3>'+(excerpt?'<p>'+app.esc(excerpt.slice(0,180))+'</p>':'')+'<span class="community-author-post-book">'+app.esc(book.title)+'</span></div></a>';
    }).join('');
    dialog.innerHTML='<div class="community-dialog-head"><div class="community-author-heading">'+app.avatarHtml(authorId,name,'emotion')+'<div><h2 id="community-dialog-title">'+app.esc(name)+'님의 글</h2><p>나눔 공간에 남긴 이야기 '+posts.length+'개</p></div></div><button type="button" class="icon-btn" data-community-close aria-label="작성자 글 목록 닫기">'+app.svgIcon(app.I_CLOSE)+'</button></div><p class="community-dialog-intro">현재 열려 있는 책의 나눔 글을 모았어요.</p><div class="community-author-posts">'+(items||'<div class="empty">아직 이곳에서 볼 수 있는 나눔 글이 없어요.</div>')+'</div>'+(posts.length>authorLimit?'<button class="btn btn-secondary community-author-more" type="button" data-author-more>글 더 보기</button>':'');
    dialog.querySelector('[data-community-close]').onclick=function(){close();};
    dialog.querySelectorAll('.community-author-post').forEach(function(link){link.addEventListener('click',function(){close(false);});});
    var more=dialog.querySelector('[data-author-more]');if(more)more.onclick=function(){var scroll=dialog.scrollTop;authorLimit+=12;authorBody();dialog.scrollTop=scroll;var next=dialog.querySelectorAll('.community-author-post')[authorLimit-12];if(next)next.focus({preventScroll:true});};
    if(restore){var focus=Array.from(dialog.querySelectorAll('a')).find(function(link){return link.getAttribute('href')===activeHref;})||dialog.querySelector('[data-community-close]');focus.focus({preventScroll:true});}
  }
  function openAuthor(id,trigger){
    if(!member()||!id)return;
    makeDialog('author',trigger);authorId=id;authorLimit=12;authorBody();if(dialog){dialog.showModal();trackDialog(dialog,'author');}
  }
  function bind(){
    ensureOwner();if(!member())return;
    var prompt=document.querySelector('[data-community-question]'),bookId=prompt&&prompt.getAttribute('data-community-question');
    var changedBook=bookId&&bookId!==lastQuestionBook;lastQuestionBook=bookId;
    if(status==='idle'||changedBook)load(!!changedBook);else syncPrompt();
    document.querySelectorAll('[data-question-edit]').forEach(function(button){button.onclick=function(event){event.preventDefault();event.stopPropagation();openQuestion(button.getAttribute('data-question-edit'),button);};});
    document.querySelectorAll('[data-space-prompt]').forEach(function(button){button.onclick=function(event){event.preventDefault();event.stopPropagation();openReplies(button.getAttribute('data-space-prompt'),button);};});
    document.querySelectorAll('[data-community-author]').forEach(function(button){button.onclick=function(event){event.preventDefault();event.stopPropagation();openAuthor(button.getAttribute('data-community-author'),button);};});
    if(dialogKind==='author')authorBody();
  }
  root.addEventListener('hashchange',function(){close(false);});
  root.GrowellCommunityFeatures={configure:configure,bind:bind,reset:reset,promptHtml:promptHtml,load:load};
})(typeof window!=='undefined'?window:globalThis);
