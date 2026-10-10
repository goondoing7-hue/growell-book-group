(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellInsightRounds=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var PAGE_SIZE=3,controllers=new Map();
  function text(value){return value==null?'':String(value);}
  function esc(value){return text(value).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];});}
  function normalize(value){return text(value).normalize('NFC').toLocaleLowerCase().trim();}
  function roundOf(value){
    var raw=text(value).normalize('NFKC').trim();
    if(!/^\d+$/.test(raw))return '';
    var number=Number(raw);return Number.isSafeInteger(number)&&number>0?String(number):'';
  }
  function matches(value,query){var haystack=normalize(value);return normalize(query).split(/\s+/).filter(Boolean).every(function(word){return haystack.indexOf(word)!==-1;});}
  // Group only the display list: keep original object references and every occurrence.
  function group(posts){
    var result=[],rounds=new Map();
    (Array.isArray(posts)?posts:[]).forEach(function(post){
      if(!post||post.noteType!=='insight'){result.push({kind:'post',post:post});return;}
      var round=roundOf(post.meetingNo),key=JSON.stringify([text(post.bookId),round]);
      if(!rounds.has(key)){var entry={kind:'round',key:key,round:round,posts:[]};rounds.set(key,entry);result.push(entry);}
      rounds.get(key).posts.push(post);
    });
    return result;
  }
  function preview(post){
    var choices=[['q2','새로운 깨달음'],['q1','모임 소감'],['q3','실천할 배움']];
    for(var i=0;i<choices.length;i++)if(text(post[choices[i][0]]).trim())return {label:choices[i][1],answer:text(post[choices[i][0]])};
    return {label:'통찰 정리',answer:'아직 작성된 답변이 없어요.'};
  }
  function roundLabel(round){return round?round+'번째 모임':'회차 미지정 모임';}
  function pageMarkup(rows,index){return '<div class="insight-round-page" data-insight-page="'+index+'"'+(index?' inert aria-hidden="true"':' aria-hidden="false"')+'>'+rows.join('')+'</div>';}
  function renderGroup(book,entry,opts){
    opts=opts||{};var posts=entry.posts||[],round=roundOf(entry.round),label=roundLabel(round),pages=[];
    var latestDate=posts.length&&opts.dateText?opts.dateText(posts[0].createdAt):'';
    var rows=posts.map(function(post){
      var answer=preview(post),href='#/book/'+encodeURIComponent(text(book.id))+'/share/post/'+encodeURIComponent(text(post.id));
      var name=text(post.userName)||'작성자',date=opts.dateText?opts.dateText(post.createdAt):'';
      var author=opts.authorHtml?opts.authorHtml(post):'<span class="insight-round-author-name">'+esc(name)+'</span>';
      var count=opts.comments?Number(opts.comments(post.id)):0;count=Number.isFinite(count)&&count>0?Math.floor(count):0;
      var search=[post.q1,post.q2,post.q3,post.title,post.userName,post.meetingNo,round,label,'통찰 정리'].map(text).join(' ');
      return '<article class="insight-round-row'+(post.id===opts.selectedId?' is-selected':'')+'" data-insight-row="'+esc(post.id)+'" data-insight-search="'+esc(search)+'"'+(post.id===opts.selectedId?' data-insight-selected="true"':'')+'>'+
        '<div class="insight-round-author">'+author+'<span class="insight-round-date">'+esc(date)+'</span></div>'+
        '<a class="insight-round-answer" href="'+esc(href)+'" aria-label="'+esc(name+'님의 '+label+' 통찰 정리 답변 전체 보기')+'">'+
        '<span class="insight-round-answer-label">'+esc(answer.label)+'</span><p class="insight-round-answer-text">'+esc(answer.answer)+'</p>'+
        '<span class="insight-round-row-footer"><span>댓글 '+count+'</span><span class="insight-round-read">답변 전체 보기 <span aria-hidden="true">→</span></span></span></a></article>';
    });
    for(var i=0;i<rows.length;i+=PAGE_SIZE)pages.push(pageMarkup(rows.slice(i,i+PAGE_SIZE),i/PAGE_SIZE));
    return '<section class="insight-round" data-insight-round="'+esc(entry.key)+'" data-insight-visible-rows="'+Math.max(1,Math.min(PAGE_SIZE,posts.length))+'" aria-label="'+esc(label+' 통찰 정리')+'">'+
      '<header class="insight-round-header"><span class="insight-round-number" aria-hidden="true">'+esc(round?round.padStart(2,'0'):'—')+'</span><div class="insight-round-header-copy"><span class="insight-round-eyebrow">함께 나눈 통찰</span><h3>'+esc(label)+'</h3><div class="insight-round-header-meta">'+
      (latestDate?'<span class="insight-round-header-date">최근 기록 '+esc(latestDate)+'</span>':'')+'<span class="insight-round-count" data-insight-count>'+posts.length+'개의 기록</span></div></div></header>'+
      '<div class="insight-round-track" data-insight-track tabindex="0" role="region" aria-roledescription="캐러셀" aria-label="'+esc(label)+' 통찰 목록. 좌우로 넘겨 다른 기록을 읽을 수 있어요.">'+pages.join('')+'</div>'+
      '<div class="insight-round-navigation" data-insight-navigation><button type="button" data-insight-prev aria-label="'+esc(label)+' 이전 기록 3개" disabled><span aria-hidden="true">‹</span></button>'+
      '<span class="insight-round-position" data-insight-position aria-live="polite" aria-atomic="true">'+(posts.length?'1–'+Math.min(PAGE_SIZE,posts.length)+' / '+posts.length:'0 / 0')+'</span>'+
      '<button type="button" data-insight-next aria-label="'+esc(label)+' 다음 기록 3개"'+(posts.length<=PAGE_SIZE?' disabled':'')+'><span aria-hidden="true">›</span></button></div></section>';
  }
  function panels(root){
    var result=Array.from(root.querySelectorAll('[data-insight-round]'));
    if(root.matches&&root.matches('[data-insight-round]'))result.unshift(root);
    return result;
  }
  function bind(root){
    var current=panels(root);
    controllers.forEach(function(controller,panel){if(panel.isConnected===false&&current.indexOf(panel)===-1){controller.dispose();controllers.delete(panel);}});
    current.forEach(function(panel){if(!controllers.has(panel))controllers.set(panel,bindPanel(panel));});
  }
  function filter(root,query){
    bind(root);return panels(root).reduce(function(count,panel){return count+controllers.get(panel).filter(query);},0);
  }
  function bindPanel(panel){
    var track=panel.querySelector('[data-insight-track]'),rows=Array.from(track.querySelectorAll('[data-insight-row]'));
    var pages=Array.from(track.querySelectorAll('[data-insight-page]')),visible=rows.slice(),index=0,pendingIndex=null,drag=null,suppressUntil=0,disposed=false,query=null;
    var previous=panel.querySelector('[data-insight-prev]'),next=panel.querySelector('[data-insight-next]'),position=panel.querySelector('[data-insight-position]'),count=panel.querySelector('[data-insight-count]');
    var document=panel.ownerDocument,win=document.defaultView,listeners=[],observer=null;
    function on(node,type,fn,options){node.addEventListener(type,fn,options);listeners.push(function(){node.removeEventListener(type,fn,options);});}
    function targetLeft(page){return page.getBoundingClientRect().left-track.getBoundingClientRect().left+track.scrollLeft;}
    function closestIndex(){
      var left=track.getBoundingClientRect().left,best=0,distance=Infinity;
      pages.forEach(function(page,i){var current=Math.abs(page.getBoundingClientRect().left-left);if(current<distance){best=i;distance=current;}});return best;
    }
    function controls(){
      previous.disabled=!pages.length||index===0;next.disabled=!pages.length||index>=pages.length-1;
      position.textContent=visible.length?(index*PAGE_SIZE+1)+'–'+Math.min((index+1)*PAGE_SIZE,visible.length)+' / '+visible.length:'0 / 0';
      count.textContent=visible.length+'개의 기록';
      panel.setAttribute('data-insight-visible-rows',String(Math.max(1,Math.min(PAGE_SIZE,visible.length))));
      pages.forEach(function(page,i){
        var inactive=i!==index;
        if(inactive&&page.contains(document.activeElement))track.focus({preventScroll:true});
        page.inert=inactive;if(inactive)page.setAttribute('inert','');else page.removeAttribute('inert');page.setAttribute('aria-hidden',inactive?'true':'false');
        // Also protect keyboard focus in browsers without inert support.
        page.querySelectorAll('a,button,input,select,textarea,[tabindex]').forEach(function(node){
          if(inactive){
            if(!node.hasAttribute('data-insight-tabindex'))node.setAttribute('data-insight-tabindex',node.hasAttribute('tabindex')?node.getAttribute('tabindex'):'none');
            node.setAttribute('tabindex','-1');
          }else if(node.hasAttribute('data-insight-tabindex')){
            var original=node.getAttribute('data-insight-tabindex');
            if(original==='none')node.removeAttribute('tabindex');else node.setAttribute('tabindex',original);
            node.removeAttribute('data-insight-tabindex');
          }
        });
      });
    }
    function go(to,smooth){
      index=Math.max(0,Math.min(pages.length-1,to));pendingIndex=null;controls();if(!pages.length)return;
      var reduced=win.matchMedia&&win.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var left=targetLeft(pages[index]),animate=smooth&&!reduced;
      if(animate&&Math.abs(track.scrollLeft-left)>1)pendingIndex=index;
      track.scrollTo({left:left,behavior:animate?'smooth':'instant'});
    }
    function interruptScroll(){
      if(pendingIndex===null)return;
      pendingIndex=null;track.scrollTo({left:track.scrollLeft,behavior:'instant'});index=closestIndex();controls();
    }
    function cancelDrag(){
      if(!drag)return;var pointerId=drag.pointerId;drag=null;track.classList.remove('is-dragging');
      if(track.hasPointerCapture&&track.hasPointerCapture(pointerId))track.releasePointerCapture(pointerId);
    }
    function applyFilter(value){
      var nextQuery=normalize(value);if(query===nextQuery)return visible.length;
      query=nextQuery;cancelDrag();visible=rows.filter(function(row){return matches(row.getAttribute('data-insight-search'),query);});
      pages=[];
      for(var i=0;i<visible.length;i+=PAGE_SIZE){
        var page=document.createElement('div');page.className='insight-round-page';page.setAttribute('data-insight-page',String(pages.length));
        visible.slice(i,i+PAGE_SIZE).forEach(function(row){page.appendChild(row);});pages.push(page);
      }
      track.replaceChildren.apply(track,pages);panel.hidden=!visible.length;index=0;go(0,false);return visible.length;
    }
    on(previous,'click',function(){go(index-1,true);});on(next,'click',function(){go(index+1,true);});
    on(track,'scroll',function(){
      if(drag||disposed)return;
      // Keep successive button presses based on the requested page while animation passes earlier pages.
      if(pendingIndex!==null&&pages[pendingIndex]&&Math.abs(track.scrollLeft-targetLeft(pages[pendingIndex]))>1)return;
      pendingIndex=null;index=closestIndex();controls();
    },{passive:true});
    on(track,'scrollend',function(){
      if(drag||disposed)return;
      if(pendingIndex!==null&&pages[pendingIndex]&&Math.abs(track.scrollLeft-targetLeft(pages[pendingIndex]))>1)return;
      pendingIndex=null;index=closestIndex();controls();
    },{passive:true});
    on(track,'wheel',interruptScroll,{passive:true});
    on(track,'keydown',function(event){
      if(event.target!==track||event.altKey||event.ctrlKey||event.metaKey||!pages.length)return;
      var to=event.key==='ArrowRight'?index+1:event.key==='ArrowLeft'?index-1:event.key==='Home'?0:event.key==='End'?pages.length-1:null;
      if(to!==null){event.preventDefault();go(to,true);}
    });
    on(track,'dragstart',function(event){event.preventDefault();});
    on(track,'pointerdown',function(event){
      interruptScroll();
      if(event.pointerType!=='mouse'||event.button!==0||event.isPrimary===false||pages.length<2||event.target.closest('input,select,textarea,[contenteditable="true"]'))return;
      drag={pointerId:event.pointerId,x:event.clientX,y:event.clientY,left:track.scrollLeft,index:index,moved:false};
    });
    on(track,'pointermove',function(event){
      if(!drag||drag.pointerId!==event.pointerId)return;
      var dx=event.clientX-drag.x,dy=event.clientY-drag.y;
      if(!drag.moved){
        if(Math.abs(dy)>Math.abs(dx)&&Math.abs(dy)>7){drag=null;return;}
        if(Math.abs(dx)<7)return;
        drag.moved=true;track.classList.add('is-dragging');track.setPointerCapture(event.pointerId);
      }
      event.preventDefault();track.scrollLeft=drag.left-dx;
    });
    function finishDrag(event,cancelled){
      if(!drag||drag.pointerId!==event.pointerId)return;
      var ended=drag,distance=track.scrollLeft-ended.left;cancelDrag();if(!ended.moved)return;
      suppressUntil=Date.now()+450;var to=closestIndex();
      if(!cancelled&&to===ended.index&&Math.abs(distance)>Math.min(70,track.clientWidth*.16))to+=distance>0?1:-1;
      go(to,true);
    }
    on(track,'pointerup',function(event){finishDrag(event,false);});
    on(track,'pointercancel',function(event){finishDrag(event,true);});
    on(track,'lostpointercapture',function(event){finishDrag(event,true);});
    on(track,'pointerleave',function(event){if(drag&&!drag.moved&&drag.pointerId===event.pointerId)drag=null;});
    on(track,'click',function(event){if(Date.now()<suppressUntil&&event.detail!==0){event.preventDefault();event.stopImmediatePropagation();}},true);
    var selected=rows.findIndex(function(row){return row.getAttribute('data-insight-selected')==='true';});
    query='';panel.hidden=!visible.length;go(selected<0?0:Math.floor(selected/PAGE_SIZE),false);
    if(win.ResizeObserver){observer=new win.ResizeObserver(function(){if(!disposed&&!drag&&pages.length)go(index,false);});observer.observe(track);}
    else on(win,'resize',function(){if(!disposed&&!drag&&pages.length)go(index,false);});
    return {filter:applyFilter,dispose:function(){disposed=true;cancelDrag();listeners.forEach(function(remove){remove();});if(observer)observer.disconnect();}};
  }
  return {group:group,renderGroup:renderGroup,bind:bind,filter:filter,matches:matches};
});
