(function(root,factory){
  'use strict';
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellInsightViewer=api;
})(typeof window!=='undefined'?window:globalThis,function(root){
  'use strict';
  var app=null,dialog=null,view=null,returnFocus=null,cleanups=[],gesture=null;
  var document=root.document,historyKey='insight-viewer';
  function text(value){return typeof value==='string'?value:'';}
  function round(value){
    var raw=String(value==null?'':value).normalize('NFKC').trim();
    if(!/^\d+$/.test(raw))return '';
    var number=Number(raw);return Number.isSafeInteger(number)&&number>0?String(number):'';
  }
  function href(){return root.location?String(root.location.href):'';}
  function notice(message){try{if(app)app.showToast(message,true);}catch(_){}}
  function on(node,type,handler,options){
    node.addEventListener(type,handler,options);
    cleanups.push(function(){node.removeEventListener(type,handler,options);});
  }
  function sameIdentity(snapshot){
    try{return !!(app&&snapshot&&snapshot.owner&&snapshot.owner===app.sessionUserId()&&snapshot.epoch===app.sessionEpoch()
      &&snapshot.url===href()&&app.canReadBook(snapshot.bookId)
      &&(!snapshot.parent||(snapshot.parent.open===true&&snapshot.parent.isConnected!==false)));}catch(_){return false;}
  }
  function safeAvatar(value){
    if(typeof value!=='string'||!value||/[\u0000-\u0020<>"'`\\]/.test(value))return '';
    if(/^data:image\/(?:jpeg|png|webp|gif);base64,[a-z0-9+/]+={0,2}$/i.test(value))return value;
    try{
      var parsed=new root.URL(value,href());
      return /^https?:$/.test(parsed.protocol)&&parsed.hostname&&!parsed.username&&!parsed.password?parsed.href:'';
    }catch(_){return '';}
  }
  function hasSelection(){
    try{var selection=root.getSelection&&root.getSelection();return !!(selection&&(selection.isCollapsed===false||String(selection).length));}catch(_){return false;}
  }
  function interactive(target){
    return !!(target&&typeof target.closest==='function'&&target.closest('a,button,input,textarea,select,[contenteditable="true"]'));
  }
  function group(snapshot){
    if(!sameIdentity(snapshot))throw new Error('stale-viewer');
    var posts=app.getPosts(snapshot.bookId,snapshot.source,snapshot.mode);
    if(!Array.isArray(posts)||!sameIdentity(snapshot))throw new Error('unavailable-posts');
    var byId=new Map(),ordered=[];
    posts.forEach(function(post){
      if(!post||typeof post.id!=='string'||post.bookId!==snapshot.bookId||(snapshot.mode==='post'?snapshot.noteTypes.indexOf(post.noteType)<0:post.noteType!=='insight')
          ||post.private===true||post.isPrivate===true||post.is_private===true||post.visible===false
          ||post.isDeleted===true||post.is_deleted===true||post.deletedAt!=null||post.deleted_at!=null
          ||(typeof post.visibility==='string'&&post.visibility!=='public'))return;
      if(byId.has(post.id))throw new Error('ambiguous-post');
      byId.set(post.id,post);ordered.push(post.id);
    });
    var current=byId.get(snapshot.postId);
    if(!current||(snapshot.mode!=='post'&&snapshot.round!==undefined&&round(current.meetingNo)!==snapshot.round))throw new Error('missing-post');
    var selectedRound=snapshot.round===undefined?round(current.meetingNo):snapshot.round;
    var ids=snapshot.postIds||ordered;
    var result=ids.map(function(id){return byId.get(id);}).filter(function(post){return post&&(snapshot.mode==='post'||round(post.meetingNo)===selectedRound);});
    if(!result.some(function(post){return post.id===snapshot.postId;}))throw new Error('missing-selected-post');
    return result;
  }
  function close(restoreFocus){
    var node=dialog,target=returnFocus;
    dialog=null;view=null;returnFocus=null;gesture=null;
    cleanups.splice(0).forEach(function(remove){remove();});
    if(node){
      if(node.open&&typeof node.close==='function')node.close();
      node.remove();
      if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed(historyKey);
    }
    if(restoreFocus!==false&&target&&target.isConnected&&typeof target.focus==='function')target.focus({preventScroll:true});
    return !!node;
  }
  function reset(){close(false);}
  function configure(adapter){
    ['sessionUserId','sessionEpoch','canReadBook','getPosts','getAuthor','renderPostHtml','dateText','showToast'].forEach(function(name){
      if(!adapter||typeof adapter[name]!=='function')throw new Error('Missing insight viewer adapter: '+name);
    });
    reset();app=adapter;
  }
  function render(posts,resetScroll){
    var snapshot=view,node=dialog;
    if(!node||!sameIdentity(snapshot))throw new Error('stale-viewer');
    var index=posts.findIndex(function(post){return post.id===snapshot.postId;}),post=posts[index];
    if(!post)throw new Error('missing-post');
    var author=app.getAuthor(post)||{},name=text(author.name)||text(post.userName)||'회원',html=app.renderPostHtml(post);
    if(typeof html!=='string'||!sameIdentity(snapshot)||dialog!==node||view!==snapshot)throw new Error('invalid-content');
    node.querySelector('[data-iv-title]').textContent=name+(snapshot.mode==='post'?'님의 나눔':'님의 통찰');
    node.querySelector('[data-iv-name]').textContent=name;
    node.querySelector('[data-iv-date]').textContent=String(app.dateText(post.createdAt)||'');
    var avatar=node.querySelector('[data-iv-avatar]'),image=safeAvatar(author.avatar);
    avatar.replaceChildren();
    var visual=document.createElement(image?'img':'span');
    if(image){visual.setAttribute('src',image);visual.setAttribute('alt','');}
    else{visual.textContent=Array.from(name)[0]||'회';visual.setAttribute('aria-hidden','true');}
    avatar.appendChild(visual);
    var body=node.querySelector('[data-iv-body]');
    // The host supplies the existing sanitized, read-only full-post renderer.
    // Do not rebuild, truncate, persist, or interpret individual member fields.
    if(snapshot.renderedHtml!==html){body.innerHTML=html;snapshot.renderedHtml=html;}
    if(snapshot.mode==='post'){
      var links=typeof app.getPostLinks==='function'?app.getPostLinks(post):[],detailHref='#/book/'+encodeURIComponent(snapshot.bookId)+'/share/post/'+encodeURIComponent(post.id);
      if(!Array.isArray(links)||!sameIdentity(snapshot))throw new Error('invalid-post-links');
      var target=node.querySelector('[data-iv-links]'),signature=JSON.stringify(links);
      if(snapshot.renderedLinks!==signature){
        target.replaceChildren();links.forEach(function(item){
          if(!item||typeof item.label!=='string'||!item.label||item.href!==detailHref)return;
          var link=document.createElement('a');link.className='iv-detail-link';link.setAttribute('href',detailHref);link.textContent=item.label;target.appendChild(link);
        });snapshot.renderedLinks=signature;
      }
      target.hidden=!target.children.length;
    }
    if(resetScroll)body.scrollTop=0;
    node.querySelector('[data-iv-prev]').disabled=index===0;
    node.querySelector('[data-iv-next]').disabled=index===posts.length-1;
    node.querySelector('[data-iv-position]').textContent=(index+1)+' / '+posts.length;
  }
  function reconcile(){
    if(!dialog||!view)return false;
    if(dialog.isConnected===false||!dialog.open||!sameIdentity(view)){close(false);return false;}
    try{render(group(view),false);return true;}
    catch(_){var label=view&&view.mode==='post'?'나눔 글':'통찰';close(false);notice('지금 볼 수 있는 '+label+'을 다시 확인해주세요.');return false;}
  }
  function move(direction){
    if(!dialog||!view)return false;
    try{
      var posts=group(view),index=posts.findIndex(function(post){return post.id===view.postId;}),next=index+direction;
      if(next<0||next>=posts.length){render(posts,false);return false;}
      view.postId=posts[next].id;render(posts,true);return true;
    }catch(_){var label=view&&view.mode==='post'?'나눔 글':'통찰';close(false);notice('지금 볼 수 있는 '+label+'을 다시 확인해주세요.');return false;}
  }
  function open(bookId,postId,options){
    options=options||{};close(false);
    if(!app||!document||typeof bookId!=='string'||typeof postId!=='string'||!postId)return false;
    var source=options.source===undefined?'share':options.source;
    if(source!=='share'&&source!=='meeting')return false;
    var mode=options.mode===undefined?'insight':options.mode;
    if(mode!=='insight'&&mode!=='post'||mode==='post'&&source!=='share')return false;
    var noteTypes=['quote','thought','question'];
    if(options.noteTypes!==undefined){
      if(mode!=='post'||!Array.isArray(options.noteTypes)||!options.noteTypes.length||options.noteTypes.some(function(kind){return noteTypes.indexOf(kind)<0;})||new Set(options.noteTypes).size!==options.noteTypes.length)return false;
      noteTypes=options.noteTypes.slice();
    }
    var ids=null;
    if(options.postIds!==undefined){
      if(!Array.isArray(options.postIds)||options.postIds.some(function(id){return typeof id!=='string'||!id;})||new Set(options.postIds).size!==options.postIds.length)return false;
      ids=options.postIds.slice();
    }
    var snapshot={owner:app.sessionUserId(),epoch:app.sessionEpoch(),url:href(),bookId:bookId,postId:postId,source:source,mode:mode,noteTypes:noteTypes,parent:options.parent||null,postIds:ids};
    if(!sameIdentity(snapshot))return false;
    var posts;
    try{posts=group(snapshot);if(mode==='insight')snapshot.round=round(posts.find(function(post){return post.id===postId;}).meetingNo);snapshot.postIds=posts.map(function(post){return post.id;});}
    catch(_){notice((mode==='post'?'나눔 글':'통찰')+'을 찾을 수 없어요. 목록을 다시 확인해주세요.');return false;}
    var node=document.createElement('dialog');dialog=node;view=snapshot;returnFocus=options.trigger||document.activeElement;
    var postMode=mode==='post';node.className='insight-viewer-dialog'+(postMode?' is-share-post':'');node.setAttribute('aria-labelledby','insight-viewer-title');
    node.innerHTML='<header class="iv-header"><div class="iv-heading"><span class="iv-eyebrow">'+(postMode?'함께 나눈 글':'함께 나눈 통찰')+'</span><h2 id="insight-viewer-title" data-iv-title></h2></div><button type="button" class="iv-close" data-iv-close aria-label="'+(postMode?'나눔 글':'통찰')+' 닫기">×</button></header>'+
      '<div class="iv-author"><span class="iv-avatar" data-iv-avatar></span><div><strong data-iv-name></strong><time data-iv-date></time></div></div>'+
      '<div class="iv-body" data-iv-body tabindex="0" aria-label="'+(postMode?'나눔 글':'통찰')+' 원문"></div>'+(postMode?'<div class="iv-links" data-iv-links hidden></div>':'')+
      '<nav class="iv-navigation" aria-label="'+(postMode?'나눔 글 넘기기':'모임원의 통찰 넘기기')+'"><button type="button" data-iv-prev aria-label="'+(postMode?'이전 나눔 글':'이전 사람의 통찰')+'">‹ <span>이전</span></button><span class="iv-position" data-iv-position role="status" aria-live="polite" aria-atomic="true"></span><button type="button" data-iv-next aria-label="'+(postMode?'다음 나눔 글':'다음 사람의 통찰')+'"><span>다음</span> ›</button></nav>';
    document.body.appendChild(node);
    on(node.querySelector('[data-iv-close]'),'click',function(){close();});
    on(node.querySelector('[data-iv-prev]'),'click',function(){move(-1);});
    on(node.querySelector('[data-iv-next]'),'click',function(){move(1);});
    if(postMode)on(node.querySelector('[data-iv-links]'),'click',function(event){
      var link=event.target&&event.target.closest&&event.target.closest('.iv-detail-link');
      if(!link||event.defaultPrevented||event.button>0||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
      if(dialog!==node||view!==snapshot)return;
      try{
        group(snapshot);
        var destination=link.getAttribute('href'),expected='#/book/'+encodeURIComponent(snapshot.bookId)+'/share/post/'+encodeURIComponent(snapshot.postId);
        if(destination!==expected)throw new Error('invalid-post-link');
        // The selected detail may already be behind this popup. In that case
        // native navigation emits no hashchange, so reveal it directly.
        if(root.location&&root.location.hash===destination){event.preventDefault();close();}
        // Different destinations retain native link/history behavior; the
        // existing route listener retires this popup after navigation.
      }catch(_){event.preventDefault();close(false);notice('지금 볼 수 있는 나눔 글을 다시 확인해주세요.');}
    });
    on(node,'cancel',function(event){event.preventDefault();close();});
    on(node,'close',function(){if(dialog===node)close();});
    on(node,'click',function(event){
      if(event.target!==node)return;
      var rect=node.getBoundingClientRect();
      if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();
    });
    on(node,'keydown',function(event){
      if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||interactive(event.target)||hasSelection())return;
      if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();move(event.key==='ArrowRight'?1:-1);}
    });
    var body=node.querySelector('[data-iv-body]');
    on(body,'touchstart',function(event){
      gesture=null;
      if(event.touches.length!==1||interactive(event.target)||hasSelection())return;
      var touch=event.touches[0];
      if(touch.clientX<18||(root.innerWidth&&touch.clientX>root.innerWidth-18))return;
      gesture={id:touch.identifier,x:touch.clientX,y:touch.clientY,started:Date.now()};
    },{passive:true});
    on(body,'touchend',function(event){
      var start=gesture;gesture=null;
      if(!start||hasSelection()||Date.now()-start.started>900)return;
      var touch=Array.from(event.changedTouches).find(function(item){return item.identifier===start.id;});if(!touch)return;
      var dx=touch.clientX-start.x,dy=touch.clientY-start.y;
      if(Math.abs(dx)>=50&&Math.abs(dx)>Math.abs(dy)*1.6)move(dx<0?1:-1);
    },{passive:true});
    on(body,'touchcancel',function(){gesture=null;},{passive:true});
    function routeChanged(){if(view===snapshot&&snapshot.url!==href())close(false);}
    on(root,'hashchange',routeChanged);on(root,'popstate',routeChanged);on(root,'pagehide',function(){close(false);});
    on(root,'focus',reconcile);
    if(snapshot.parent&&typeof snapshot.parent.addEventListener==='function')on(snapshot.parent,'close',function(){if(view===snapshot)close(false);});
    try{
      render(posts,true);node.showModal();
      if(root.GrowellPopupHistory)root.GrowellPopupHistory.open(historyKey,{close:function(){if(dialog===node)close();}});
      return true;
    }catch(_){close(false);notice((postMode?'나눔 글':'통찰')+'을 열지 못했어요. 다시 시도해주세요.');return false;}
  }
  return Object.freeze({configure:configure,open:open,close:close,reset:reset,reconcile:reconcile});
});
