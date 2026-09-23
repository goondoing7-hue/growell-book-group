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
  var authorId=null,authorLimit=12,questionSaving=false;
  function member(){return app.SESSION&&app.SESSION.userId;}
  function current(expected){return member()===expected.owner&&app.saveSessionEpoch===expected.epoch;}
  function reset(){
    requestId++;close(false);rows=Object.create(null);drafts=Object.create(null);owner=null;epoch=null;status='idle';lastQuestionBook=null;
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
    return '<div class="space-prompt">'+app.svgIcon(app.I_COMMENT)+'<div><small>이번 책으로 함께 생각해요</small><strong data-community-question="'+app.esc(book.id)+'">'+app.esc(root.GrowellCommunity.questionFor(book,rows))+'</strong></div><div class="space-prompt-actions"><button class="btn btn-ghost" type="button" data-space-prompt="'+app.esc(book.id)+'">내 생각 남기기 →</button>'+(app.isAdmin()?'<button class="community-question-edit" type="button" data-question-edit="'+app.esc(book.id)+'" aria-haspopup="dialog">'+app.svgIcon(app.I_EDIT)+' 질문 수정</button>':'')+'</div></div>';
  }
  function close(restore){
    if(!dialog)return;
    var node=dialog,target=returnFocus;
    dialog=null;dialogKind=null;returnFocus=null;authorId=null;questionSaving=false;
    if(node.open)node.close();node.remove();
    if(restore!==false&&target&&target.isConnected)target.focus({preventScroll:true});
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
    node.querySelector('[data-community-close]').onclick=function(){close();};node.showModal();
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
    makeDialog('author',trigger);authorId=id;authorLimit=12;authorBody();if(dialog)dialog.showModal();
  }
  function bind(){
    ensureOwner();if(!member())return;
    var prompt=document.querySelector('[data-community-question]'),bookId=prompt&&prompt.getAttribute('data-community-question');
    var changedBook=bookId&&bookId!==lastQuestionBook;lastQuestionBook=bookId;
    if(status==='idle'||changedBook)load(!!changedBook);else syncPrompt();
    document.querySelectorAll('[data-question-edit]').forEach(function(button){button.onclick=function(event){event.preventDefault();event.stopPropagation();openQuestion(button.getAttribute('data-question-edit'),button);};});
    document.querySelectorAll('[data-community-author]').forEach(function(button){button.onclick=function(event){event.preventDefault();event.stopPropagation();openAuthor(button.getAttribute('data-community-author'),button);};});
    if(dialogKind==='author')authorBody();
  }
  root.addEventListener('hashchange',function(){close(false);});
  root.GrowellCommunityFeatures={configure:configure,bind:bind,reset:reset,promptHtml:promptHtml,load:load};
})(typeof window!=='undefined'?window:globalThis);
