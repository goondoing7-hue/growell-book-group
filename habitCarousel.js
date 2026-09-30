(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellHabitCarousel=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var states=new Map(),controllers=[],owner='',route='',restore=null,queuedRender=null;
  function normalize(value){return String(value||'').normalize('NFC').toLocaleLowerCase().trim();}
  function matches(text,query){var haystack=normalize(text);return normalize(query).split(/\s+/).filter(Boolean).every(function(word){return haystack.indexOf(word)!==-1;});}
  function beforeRender(nextOwner,nextRoute,render){
    var same=owner===nextOwner&&route===nextRoute;
    if(same&&controllers.some(function(item){return item.composing();})){queuedRender=render;return true;}
    restore=null;
    if(same)controllers.forEach(function(item){
      if(item.search.ownerDocument.activeElement===item.search)restore={scope:item.scope,start:item.search.selectionStart,end:item.search.selectionEnd};
    });
    return false;
  }
  function bindAll(root,nextOwner,nextRoute){
    controllers.forEach(function(item){item.dispose();});controllers=[];queuedRender=null;
    if(owner!==nextOwner){states.clear();restore=null;}
    owner=nextOwner;route=nextRoute;
    if(!owner)return;
    root.querySelectorAll('[data-habit-browser]').forEach(function(panel){
      var scope=panel.getAttribute('data-habit-scope');
      if(!states.has(scope))states.set(scope,{query:'',activeId:''});
      var controller=bind(panel,states.get(scope));controllers.push(controller);
      if(restore&&restore.scope===scope){controller.search.focus({preventScroll:true});try{controller.search.setSelectionRange(restore.start,restore.end);}catch(error){}}
    });
    restore=null;
  }
  function bind(panel,state){
    var scope=panel.getAttribute('data-habit-scope'),search=panel.querySelector('[data-habit-search-input]'),track=panel.querySelector('[data-habit-carousel]');
    var cards=Array.from(track.querySelectorAll('[data-habit-card]')),visible=[],index=0,composing=false,drag=null,suppressUntil=0,disposed=false;
    var previous=panel.querySelector('[data-habit-prev]'),next=panel.querySelector('[data-habit-next]'),position=panel.querySelector('[data-habit-position]');
    var count=panel.querySelector('[data-habit-result]'),empty=panel.querySelector('[data-habit-empty]'),navigation=panel.querySelector('[data-habit-navigation]');
    var win=panel.ownerDocument.defaultView,listeners=[],observer=null;
    function on(node,type,fn,options){node.addEventListener(type,fn,options);listeners.push(function(){node.removeEventListener(type,fn,options);});}
    function id(card){return card.getAttribute('data-habit-card');}
    function targetLeft(card){return card.getBoundingClientRect().left-track.getBoundingClientRect().left+track.scrollLeft;}
    function closestIndex(){
      var left=track.getBoundingClientRect().left,best=0,distance=Infinity;
      visible.forEach(function(card,i){var value=Math.abs(card.getBoundingClientRect().left-left);if(value<distance){best=i;distance=value;}});return best;
    }
    function controls(){
      previous.disabled=!visible.length||index===0;next.disabled=!visible.length||index>=visible.length-1;
      position.textContent=visible.length?(index+1)+' / '+visible.length:'0 / 0';
      navigation.hidden=visible.length<2;
      if(visible[index])state.activeId=id(visible[index]);
    }
    function go(to,smooth){
      if(!visible.length)return;
      index=Math.max(0,Math.min(visible.length-1,to));controls();
      var reduced=win.matchMedia&&win.matchMedia('(prefers-reduced-motion: reduce)').matches;
      track.scrollTo({left:targetLeft(visible[index]),behavior:smooth&&!reduced?'smooth':'instant'});
    }
    function filter(reset){
      state.query=search.value;
      cards.forEach(function(card){card.hidden=!matches(card.getAttribute('data-habit-search'),state.query);});
      visible=cards.filter(function(card){return !card.hidden;});
      visible.forEach(function(card,i){card.setAttribute('aria-label',(i+1)+' / '+visible.length+' · '+card.getAttribute('data-habit-name'));});
      index=reset?0:Math.max(0,visible.findIndex(function(card){return id(card)===state.activeId;}));
      track.hidden=!visible.length;empty.hidden=!!visible.length;
      count.textContent=(normalize(state.query)?'검색 결과 ':'내 습관 ')+visible.length+'개';
      controls();if(visible.length)go(index,false);
    }
    function finishComposition(){
      composing=false;filter(true);
      if(queuedRender){var render=queuedRender;queuedRender=null;win.setTimeout(render,0);}
    }
    search.value=state.query;
    on(search,'compositionstart',function(){composing=true;});
    on(search,'compositionend',finishComposition);
    on(search,'input',function(event){if(!composing&&!event.isComposing)filter(true);});
    on(search,'blur',function(){if(composing)finishComposition();});
    on(previous,'click',function(){go(index-1,true);});
    on(next,'click',function(){go(index+1,true);});
    on(track,'scroll',function(){if(!drag&&!disposed){index=closestIndex();controls();}},{passive:true});
    on(track,'keydown',function(event){
      if(event.target!==track||event.altKey||event.ctrlKey||event.metaKey||!visible.length)return;
      var to=event.key==='ArrowRight'?index+1:event.key==='ArrowLeft'?index-1:event.key==='Home'?0:event.key==='End'?visible.length-1:null;
      if(to!==null){event.preventDefault();go(to,true);}
    });
    on(track,'dragstart',function(event){event.preventDefault();});
    on(track,'pointerdown',function(event){
      if(event.pointerType!=='mouse'||event.button!==0||event.isPrimary===false||visible.length<2||event.target.closest('input,select,textarea,label,a,[contenteditable="true"]'))return;
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
      var ended=drag;drag=null;track.classList.remove('is-dragging');
      if(track.hasPointerCapture(event.pointerId))track.releasePointerCapture(event.pointerId);
      if(!ended.moved)return;
      suppressUntil=Date.now()+450;
      var to=closestIndex(),distance=track.scrollLeft-ended.left;
      if(!cancelled&&to===ended.index&&Math.abs(distance)>Math.min(70,track.clientWidth*.16))to+=distance>0?1:-1;
      go(to,true);
    }
    on(track,'pointerup',function(event){finishDrag(event,false);});
    on(track,'pointercancel',function(event){finishDrag(event,true);});
    on(track,'lostpointercapture',function(event){finishDrag(event,true);});
    on(track,'pointerleave',function(event){if(drag&&!drag.moved&&drag.pointerId===event.pointerId)drag=null;});
    on(track,'click',function(event){
      if(Date.now()<suppressUntil&&event.detail!==0){event.preventDefault();event.stopImmediatePropagation();}
    },true);
    filter(false);
    if(win.ResizeObserver){observer=new win.ResizeObserver(function(){if(!disposed&&!drag&&visible.length)go(index,false);});observer.observe(track);}
    return {scope:scope,search:search,composing:function(){return composing;},dispose:function(){disposed=true;listeners.forEach(function(remove){remove();});if(observer)observer.disconnect();}};
  }
  return {bindAll:bindAll,beforeRender:beforeRender,matches:matches};
});
