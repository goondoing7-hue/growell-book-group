(function(root,factory){
  var api=factory(root);
  if(typeof module==='object' && module.exports)module.exports=api;
  else root.GrowellMaterialsVideo=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var active=[],readyCache=new Map(),cacheOwner=null;
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];});}
  function validId(id){return typeof id==='string' && /^[A-Za-z0-9_-]{11}$/.test(id);}
  function summaryHtml(summary){
    if(!summary || typeof summary.overview!=='string' || !summary.overview.trim() || !Array.isArray(summary.points))return null;
    var points=summary.points.filter(function(point){return typeof point==='string' && point.trim();}).slice(0,5);
    if(!points.length)return null;
    return '<p class="mat-video-overview">'+esc(summary.overview.slice(0,3000))+'</p><ul class="mat-video-points">'+
      points.map(function(point){return '<li>'+esc(point.slice(0,1500))+'</li>';}).join('')+'</ul>';
  }
  function videoHtml(postId,videos){
    return (Array.isArray(videos)?videos:[]).filter(function(video){return validId(video.id);}).map(function(video){
      return '<section class="mat-video" data-material-video="'+esc(video.id)+'" data-material-post="'+esc(postId)+'">'+
        '<div class="mat-video-player"><iframe src="https://www.youtube-nocookie.com/embed/'+video.id+'?playsinline=1" title="'+esc(video.title || '유튜브 영상')+' 재생" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>'+
        '<div class="mat-video-summary"><div class="mat-video-summary-head"><h3>영상 핵심 요약</h3><span>AI 요약</span></div>'+
        '<div data-material-video-summary aria-live="polite" aria-busy="true"><p class="mat-video-status">영상 내용을 요약하고 있어요.</p></div></div>'+
        (root.GrowellMaterialTranscript?root.GrowellMaterialTranscript.html(postId,video):'')+
        '<a class="mat-video-original" href="https://www.youtube.com/watch?v='+video.id+'" target="_blank" rel="noopener noreferrer">YouTube에서 보기 ↗</a></section>';
    }).join('');
  }
  function unavailableHtml(reason){
    var messages={
      video_unavailable:'이 영상은 내용을 확인할 수 없어 자동으로 요약하지 못했어요. 영상은 위에서 확인해주세요.',
      not_configured:'영상 요약 기능을 준비하고 있어요. 영상은 바로 재생할 수 있어요.',
      rate_limited:'지금은 요청이 많아요. 잠시 후 다시 시도해주세요.',
      auth_required:'로그인 상태를 확인한 뒤 다시 시도해주세요.',
      forbidden:'이 자료의 요약을 볼 수 없어요.',
      not_found:'자료가 삭제되었거나 영상 링크가 변경되었어요.',
      temporary_error:'요약을 불러오지 못했어요. 잠시 후 다시 시도해주세요.'
    };
    return '<p class="mat-video-status">'+esc(messages[reason] || messages.temporary_error)+'</p>'+
      (reason==='forbidden' || reason==='not_found'?'':'<button type="button" class="mat-video-retry" data-material-video-retry>요약 다시 시도</button>');
  }
  function createController(options){
    var stopped=false,timer=null,controller=null,attempts=0,busy=false;
    var setTimer=options.setTimeout || root.setTimeout.bind(root),clearTimer=options.clearTimeout || root.clearTimeout.bind(root);
    var Abort=options.AbortController || root.AbortController;
    function current(){return !stopped && options.isCurrent();}
    function write(html,isBusy){if(current())options.render(html,isBusy);}
    function fail(reason){busy=false;write(unavailableHtml(reason),false);}
    async function request(){
      if(!current() || busy)return;
      busy=true;attempts++;
      controller=Abort?new Abort():null;
      var requestController=controller;
      var timeout=setTimer(function(){if(requestController)requestController.abort();},55000);
      try {
        var token=await options.getAccessToken();
        if(!current())return;
        if(!token){fail('auth_required');return;}
        var response=await options.fetch('/api/material-video-summary',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
          body:JSON.stringify({postId:options.postId,videoId:options.videoId}),signal:requestController && requestController.signal});
        if(!current())return;
        if(!response.ok){fail(response.status===401?'auth_required':response.status===403?'forbidden':response.status===404?'not_found':response.status===429?'rate_limited':'temporary_error');return;}
        var data=await response.json();
        if(!current())return;
        if(data && data.status==='ready' && data.videoId===options.videoId){
          var html=summaryHtml(data.summary);
          if(!html){fail('temporary_error');return;}
          busy=false;if(options.onReady)options.onReady(html);write(html,false);return;
        }
        if(data && data.status==='pending' && attempts<5){
          busy=false;
          var delay=Math.max(2,Math.min(10,Number(data.retryAfter)||3))*1000;
          timer=setTimer(function(){timer=null;request();},delay);return;
        }
        fail(data && data.status==='unavailable'?data.reason:'temporary_error');
      } catch(error){if(current())fail(error && error.message==='auth_required'?'auth_required':'temporary_error');}
      finally {clearTimer(timeout);busy=false;}
    }
    function start(){
      if(!current() || busy)return;
      if(timer!==null){clearTimer(timer);timer=null;}
      attempts=0;write('<p class="mat-video-status">영상 내용을 요약하고 있어요.</p>',true);request();
    }
    return {start:start,dispose:function(){stopped=true;if(timer!==null)clearTimer(timer);if(controller)controller.abort();}};
  }
  function dispose(){active.forEach(function(binding){binding.dispose();});active=[];}
  function bind(options){
    dispose();
    if(cacheOwner!==options.owner){readyCache.clear();cacheOwner=options.owner;}
    if(!options.owner)return;
    options.container.querySelectorAll('[data-material-video]').forEach(function(node){
      var postId=node.getAttribute('data-material-post'),videoId=node.getAttribute('data-material-video');
      if(!validId(videoId))return;
      var content=node.querySelector('[data-material-video-summary]');
      if(!content)return;
      var key=options.owner+'|'+postId+'|'+videoId;
      function current(){return node.isConnected && options.isCurrent(postId,videoId);}
      function render(html,busy){
        if(!current())return;
        content.innerHTML=html;content.setAttribute('aria-busy',busy?'true':'false');
        var retry=content.querySelector('[data-material-video-retry]');
        if(retry)retry.onclick=function(){if(current())binding.start();};
      }
      var binding=createController({postId:postId,videoId:videoId,isCurrent:current,getAccessToken:options.getAccessToken,fetch:options.fetch,render:render,
        onReady:function(html){if(current()){if(readyCache.size>=40)readyCache.delete(readyCache.keys().next().value);readyCache.set(key,html);}}});
      active.push(binding);
      if(readyCache.has(key))render(readyCache.get(key),false);else binding.start();
    });
  }
  return {html:videoHtml,summaryHtml:summaryHtml,unavailableHtml:unavailableHtml,createController:createController,bind:bind,dispose:dispose};
});
