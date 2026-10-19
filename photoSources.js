(function(root,factory){
  'use strict';var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.GrowellPhotoSources=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var CAMERA='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 5l1.5-2h5L16 5h4a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><circle cx="12" cy="12" r="4"/></svg>';
  var PHOTO='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="M3 17l5-5 4 4 3-3 6 6"/></svg>';
  function create(options){
    options=options||{};var browser=options.browser||root,document=options.document||browser.document,active=null;
    var schedule=options.setTimeout||(browser.setTimeout&&browser.setTimeout.bind(browser)),unschedule=options.clearTimeout||(browser.clearTimeout&&browser.clearTimeout.bind(browser));
    function current(state){if(active!==state||state.closed||!state.node.isConnected)return false;try{return state.config.isCurrent()===true;}catch(error){return false;}}
    function finish(state,file){
      if(!state||state.closed)return;var permitted=current(state);state.closed=true;if(active===state)active=null;
      if(state.pickerCleanup)state.pickerCleanup();if(state.timer&&unschedule)unschedule(state.timer);
      if(browser.removeEventListener)browser.removeEventListener('hashchange',state.routeListener);
      try{if(state.node.open)state.node.close();}catch(error){}state.node.remove();
      if(browser.GrowellPopupHistory)browser.GrowellPopupHistory.closed('photo-source-sheet');
      state.resolve(permitted&&file?file:null);
      if(permitted&&state.config.trigger&&state.config.trigger.isConnected){try{state.config.trigger.focus({preventScroll:true});}catch(error){}}
    }
    function close(){if(active)finish(active,null);}
    function open(config){
      close();if(!document||!config||typeof config.isCurrent!=='function'||config.isCurrent()!==true)return Promise.resolve(null);
      return new Promise(function(resolve){
        var ocr=config.mode==='ocr',node=document.createElement('dialog');node.className='photo-source-sheet';node.setAttribute('aria-labelledby','photo-source-title');
        node.innerHTML='<header><h2 id="photo-source-title">'+(ocr?'노트 작성':'작업을 선택해주세요')+'</h2><button type="button" class="photo-source-close" data-source-close aria-label="사진 선택 닫기">×</button></header><div class="photo-source-options"><button type="button" data-source-camera>'+CAMERA+'<span>'+(ocr?'카메라로 텍스트 추출':'카메라로 촬영')+'</span></button><button type="button" data-source-gallery>'+PHOTO+'<span>'+(ocr?'사진첩에서 텍스트 추출':'사진첩에서 선택')+'</span></button></div><input type="file" accept="image/*" capture="environment" data-source-camera-input hidden><input type="file" accept="image/*" data-source-gallery-input hidden>';
        var state={node:node,config:config,resolve:resolve,closed:false,pickerCleanup:null,pickerInput:null};active=state;document.body.appendChild(node);
        function pick(input){
          if(!current(state))return;if(state.pickerCleanup)state.pickerCleanup();state.pickerInput=input;input.value='';
          if(browser.GrowellPopupHistory&&browser.GrowellPopupHistory.watchFilePicker)state.pickerCleanup=browser.GrowellPopupHistory.watchFilePicker(input,{isCurrent:function(){return current(state)&&state.pickerInput===input;},onCancel:function(){finish(state,null);}});
          input.click();
        }
        var camera=node.querySelector('[data-source-camera-input]'),gallery=node.querySelector('[data-source-gallery-input]');
        node.querySelector('[data-source-camera]').addEventListener('click',function(){pick(camera);});node.querySelector('[data-source-gallery]').addEventListener('click',function(){pick(gallery);});
        [camera,gallery].forEach(function(input){input.addEventListener('change',function(){if(state.pickerInput!==input||!current(state))return;var file=input.files&&input.files[0];finish(state,file||null);});input.addEventListener('cancel',function(){if(state.pickerInput===input)finish(state,null);});});
        node.querySelector('[data-source-close]').addEventListener('click',function(){finish(state,null);});node.addEventListener('cancel',function(event){event.preventDefault();finish(state,null);});node.addEventListener('close',function(){if(active===state)finish(state,null);});
        state.routeListener=function(){if(!current(state))finish(state,null);};if(browser.addEventListener)browser.addEventListener('hashchange',state.routeListener);
        function watch(){if(active!==state)return;if(!current(state)){finish(state,null);return;}if(schedule)state.timer=schedule(watch,500);}if(schedule)state.timer=schedule(watch,500);
        try{node.showModal();if(browser.GrowellPopupHistory)browser.GrowellPopupHistory.open('photo-source-sheet',{close:function(){finish(state,null);}});node.querySelector('[data-source-camera]').focus();}catch(error){finish(state,null);}
      });
    }
    return {open:open,close:close};
  }
  var api=create();api.create=create;return api;
});
