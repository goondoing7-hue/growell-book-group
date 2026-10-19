(function(root,factory){
  'use strict';
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellBookPhotoOcr=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var MAX_BYTES=20*1024*1024,MAX_EDGE=2200,MAX_TEXT=200000;
  var ASSETS=Object.freeze({script:'/vendor/tesseract/tesseract.min.js',worker:'/vendor/tesseract/worker.min.js',core:'/vendor/tesseract/core',lang:'/vendor/tesseract/lang'});
  function fail(code){var error=new Error(code);error.code=code;return error;}
  function validateFile(file){
    if(!file||typeof file.type!=='string'||!/^image\/[a-z0-9.+-]+$/i.test(file.type))throw fail('image-required');
    if(!Number.isFinite(file.size)||file.size<=0||file.size>MAX_BYTES)throw fail('image-size');
    return file;
  }
  function imageSize(width,height){
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<1||height<1||width*height>100000000)throw fail('image-decode');
    var scale=Math.min(1,MAX_EDGE/Math.max(width,height));
    return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};
  }
  function normalizeText(text){return typeof text==='string'?text.replace(/\r\n?/g,'\n').replace(/\u0000/g,'').trim():'';}
  async function prepareImage(file,browser,document){
    var bitmap=null,url=null,canvas=null;
    try{
      if(typeof browser.createImageBitmap==='function'){
        try{bitmap=await browser.createImageBitmap(file,{imageOrientation:'from-image'});}catch(error){bitmap=null;}
      }
      if(!bitmap){
        if(!browser.URL||!browser.Image)throw fail('image-decode');
        url=browser.URL.createObjectURL(file);
        bitmap=await new Promise(function(resolve,reject){var image=new browser.Image();image.onload=function(){resolve(image);};image.onerror=function(){reject(fail('image-decode'));};image.src=url;});
      }
      var size=imageSize(bitmap.width||bitmap.naturalWidth,bitmap.height||bitmap.naturalHeight);
      canvas=document.createElement('canvas');canvas.width=size.width;canvas.height=size.height;
      var context=canvas.getContext('2d',{alpha:false});if(!context)throw fail('image-decode');
      context.fillStyle='#ffffff';context.fillRect(0,0,size.width,size.height);context.drawImage(bitmap,0,0,size.width,size.height);
      var released=false;
      return {image:canvas,release:function(){if(released)return;released=true;canvas.width=0;canvas.height=0;}};
    }catch(error){if(canvas){canvas.width=0;canvas.height=0;}throw fail('image-decode');}
    finally{if(bitmap&&typeof bitmap.close==='function')bitmap.close();if(url)browser.URL.revokeObjectURL(url);}
  }
  function appendText(editor,text,document){
    var value=normalizeText(text);if(!value||value.length>MAX_TEXT)throw fail('text-empty');
    // Build every imported line as a text node. OCR text is never HTML, even if
    // a photographed page happens to contain tags or event-handler examples.
    var fragment=document.createDocumentFragment(),lines=value.split('\n');
    lines.forEach(function(line){var paragraph=document.createElement('p');if(line)paragraph.textContent=line;else paragraph.appendChild(document.createElement('br'));fragment.appendChild(paragraph);});
    editor.appendChild(fragment);
  }
  function create(options){
    options=options||{};
    var browser=options.browser||root,document=options.document||browser.document;
    var active=null,binding=null,enginePromise=null,sourceSequence=0;
    var sourcePicker=browser.GrowellPhotoSources&&(browser.GrowellPhotoSources.create?browser.GrowellPhotoSources.create({browser:browser,document:document,setTimeout:options.setTimeout,clearTimeout:options.clearTimeout}):browser.GrowellPhotoSources);
    var schedule=options.setTimeout||(browser.setTimeout&&browser.setTimeout.bind(browser));
    var unschedule=options.clearTimeout||(browser.clearTimeout&&browser.clearTimeout.bind(browser));
    function engine(){
      if(options.loadEngine)return Promise.resolve().then(options.loadEngine);
      if(browser.Tesseract&&typeof browser.Tesseract.createWorker==='function')return Promise.resolve(browser.Tesseract);
      if(enginePromise)return enginePromise;
      var current;
      current=new Promise(function(resolve,reject){
        var script=document.createElement('script'),done=false,timer;
        function finish(error){if(done)return;done=true;if(timer)unschedule(timer);script.onload=null;script.onerror=null;
          if(error){script.remove();reject(fail('engine-unavailable'));}else resolve(browser.Tesseract);}
        script.src=ASSETS.script;script.async=true;
        script.onload=function(){finish(!(browser.Tesseract&&typeof browser.Tesseract.createWorker==='function'));};
        script.onerror=function(){finish(true);};
        if(schedule)timer=schedule(function(){finish(true);},60000);
        (document.head||document.body).appendChild(script);
      });
      enginePromise=current;current.catch(function(){if(enginePromise===current)enginePromise=null;});return current;
    }
    function isCurrent(state){
      if(!state||active!==state||state.closed||!state.node.isConnected||!state.config.editor.isConnected||!state.config.composer.isConnected)return false;
      try{return state.config.isCurrent(state.context)===true;}catch(error){return false;}
    }
    function terminate(run){
      if(!run||run.terminated)return;run.cancelled=true;
      if(run.timer){unschedule(run.timer);run.timer=null;}
      if(run.resource){run.resource.release();run.resource=null;}
      if(run.worker){run.terminated=true;try{Promise.resolve(run.worker.terminate()).catch(function(){});}catch(error){/* Already stopped. */}run.worker=null;}
    }
    function stop(state){if(state&&state.run){terminate(state.run);state.run=null;}}
    function close(){
      sourceSequence++;if(sourcePicker)sourcePicker.close();
      var state=active;if(!state)return;active=null;state.closed=true;stop(state);
      if(state.pickerCleanup)state.pickerCleanup();state.pickerCleanup=null;state.pickerInput=null;
      if(state.observer)state.observer.disconnect();
      if(state.routeListener&&browser.removeEventListener)browser.removeEventListener('hashchange',state.routeListener);
      if(state.pageListener&&browser.removeEventListener)browser.removeEventListener('pagehide',state.pageListener);
      if(state.identityTimer)unschedule(state.identityTimer);
      state.text.value='';state.camera.value='';state.gallery.value='';
      try{if(state.node.open)state.node.close();}catch(error){/* Removal also closes native dialogs. */}
      state.node.remove();
      if(browser.GrowellPopupHistory)browser.GrowellPopupHistory.closed('book-photo-ocr');
      try{if(state.config.button&&state.config.button.isConnected&&state.config.isCurrent(state.context))state.config.button.focus({preventScroll:true});}catch(error){/* A replaced composer cannot receive focus. */}
    }
    function message(state,text,error){state.status.textContent=text;state.status.classList.toggle('is-error',!!error);}
    function busy(state,on){
      state.cameraButton.disabled=on;state.galleryButton.disabled=on;state.cancel.hidden=!on;
      state.progress.hidden=!on;state.text.disabled=on;state.append.disabled=on||!normalizeText(state.text.value);
    }
    function errorMessage(error){return {'image-required':'사진 파일을 선택해주세요.','image-size':'사진은 20MB 이하로 선택해주세요.','image-decode':'사진을 열지 못했어요. JPG 또는 PNG 사진으로 다시 선택해주세요.','engine-unavailable':'글자 인식 도구를 준비하지 못했어요. 연결을 확인하고 다시 시도해주세요.','ocr-timeout':'인식 시간이 오래 걸려 중지했어요. 글자가 잘 보이도록 가까이 촬영해 다시 시도해주세요.','text-empty':'읽을 수 있는 글자를 찾지 못했어요. 밝고 선명한 사진으로 다시 시도해주세요.'}[error&&error.code]||'글자를 가져오지 못했어요. 사진을 다시 선택해주세요.';}
    async function recognize(state,file){
      if(!isCurrent(state))return;
      try{validateFile(file);}catch(error){message(state,errorMessage(error),true);return;}
      stop(state);state.text.value='';state.review.hidden=true;state.progress.value=0;busy(state,true);message(state,'사진을 준비하고 있어요.');
      var run={cancelled:false,terminated:false,resource:null,worker:null,timer:null};state.run=run;
      function current(){return isCurrent(state)&&state.run===run&&!run.cancelled;}
      try{
        var editPhoto=options.editPhoto || (browser.GrowellPhotoEditor && browser.GrowellPhotoEditor.edit);
        if(typeof editPhoto==='function'){
          message(state,'사각 틀로 책의 문장 범위를 맞춘 뒤 글자 인식을 시작해주세요.');
          file=await editPhoto(file,{isCurrent:current,trigger:state.config.button,cropOnly:true,confirmLabel:'자르고 글자 인식',onCancel:function(){if(current())close();}});
          if(!current())return;
          if(!file){close();return;}
        }
        if(!state.node.open&&(!state.show||state.show()===false))return;
        if(schedule)run.timer=schedule(function(){if(!current())return;terminate(run);state.run=null;busy(state,false);message(state,errorMessage(fail('ocr-timeout')),true);},180000);
        run.resource=await (options.prepareImage?options.prepareImage(file):prepareImage(file,browser,document));
        if(!current()){if(run.resource){run.resource.release();run.resource=null;}return;}
        message(state,'처음에는 글자 인식 도구를 준비하는 데 시간이 걸릴 수 있어요.');
        var library=await engine();if(!current())return;
        var worker=await library.createWorker(['kor','eng'],1,{workerPath:ASSETS.worker,corePath:ASSETS.core,langPath:ASSETS.lang,
          workerBlobURL:false,gzip:true,legacyCore:false,legacyLang:false,
          errorHandler:function(){},logger:function(event){
            if(!current())return;
            var progress=event&&event.progress;if(typeof progress==='number'&&Number.isFinite(progress))state.progress.value=Math.max(0,Math.min(1,progress));
            message(state,event&&event.status==='recognizing text'?'사진 속 글자를 읽고 있어요.':'기기에서 글자 인식 도구를 준비하고 있어요.');
          }});
        run.worker=worker;if(!current()){terminate(run);return;}
        message(state,'사진 속 글자를 읽고 있어요.');
        var result=await worker.recognize(run.resource.image);
        if(!current())return;
        var text=normalizeText(result&&result.data&&result.data.text);if(!text||text.length>MAX_TEXT)throw fail('text-empty');
        state.text.value=text;state.review.hidden=false;busy(state,false);message(state,'인식한 문장을 확인하고 고쳐주세요. 추가하기 전에는 원래 글이 바뀌지 않아요.');
      }catch(error){if(current()){busy(state,false);message(state,errorMessage(error),true);}}
      finally{terminate(run);if(state.run===run)state.run=null;}
    }
    function open(config,initialFile){
      close();if(!document||!config||!config.editor||!config.composer||typeof config.getContext!=='function'||typeof config.isCurrent!=='function')return null;
      var context=config.getContext();if(!context||!config.editor.isConnected||!config.composer.isConnected||config.isCurrent(context)!==true)return null;
      var node=document.createElement('dialog');node.className='book-photo-ocr';node.setAttribute('aria-labelledby','book-photo-ocr-title');
      node.innerHTML='<div class="book-photo-ocr-head"><h2 id="book-photo-ocr-title">사진에서 글자 가져오기</h2><button type="button" class="icon-btn" data-ocr-close aria-label="사진 글자 인식 닫기">×</button></div>'+
        '<div class="book-photo-ocr-body"><p class="book-photo-ocr-description">책의 문장을 촬영하거나 사진을 골라주세요. 사진은 이 기기에서만 처리하며 서버나 외부 AI로 보내지 않아요.</p>'+
        '<div class="book-photo-ocr-picks"><button type="button" class="btn" data-ocr-camera>사진 촬영</button><button type="button" class="btn" data-ocr-gallery>사진 선택</button></div>'+
        '<input type="file" accept="image/*" capture="environment" data-ocr-camera-input hidden><input type="file" accept="image/*" data-ocr-gallery-input hidden>'+
        '<p class="book-photo-ocr-hint">사진을 고르면 사각 틀의 모서리나 변을 움직여 글자가 있는 범위를 맞춰요. 자르기를 마치면 바로 글자를 인식해요. 한 번에 한 쪽씩, 선명한 사진을 20MB까지 선택해주세요.</p>'+
        '<div class="book-photo-ocr-state"><p data-ocr-status role="status" aria-live="polite">사진을 선택하면 한국어와 영어 문장을 읽어요.</p><progress max="1" value="0" data-ocr-progress hidden aria-label="글자 인식 진행"></progress><button type="button" class="btn btn-sm" data-ocr-cancel hidden>인식 중지</button></div>'+
        '<div data-ocr-review hidden><label class="field-label" for="book-photo-ocr-text">인식한 문장 · 수정할 수 있어요</label><textarea id="book-photo-ocr-text" data-ocr-text maxlength="200000" spellcheck="false"></textarea><p class="book-photo-ocr-hint">오탈자와 줄바꿈을 확인해주세요. 기존 본문과 첨부 사진은 그대로 유지해요.</p></div></div>'+
        '<div class="book-photo-ocr-actions"><button type="button" class="btn" data-ocr-close>닫기</button><button type="button" class="btn btn-primary" data-ocr-append disabled>글 끝에 추가</button></div>';
      var state={node:node,config:config,context:context,closed:false,run:null};
      function q(selector){return node.querySelector(selector);}
      Object.assign(state,{text:q('[data-ocr-text]'),review:q('[data-ocr-review]'),status:q('[data-ocr-status]'),progress:q('[data-ocr-progress]'),camera:q('[data-ocr-camera-input]'),gallery:q('[data-ocr-gallery-input]'),cameraButton:q('[data-ocr-camera]'),galleryButton:q('[data-ocr-gallery]'),cancel:q('[data-ocr-cancel]'),append:q('[data-ocr-append]')});
      document.body.appendChild(node);active=state;
      if(initialFile){var picks=node.querySelector('.book-photo-ocr-picks');if(picks)picks.hidden=true;}
      node.querySelectorAll('[data-ocr-close]').forEach(function(button){button.addEventListener('click',close);});
      function pick(input){
        if(!isCurrent(state))return;if(state.pickerCleanup)state.pickerCleanup();state.pickerInput=input;
        if(browser.GrowellPopupHistory&&browser.GrowellPopupHistory.watchFilePicker)state.pickerCleanup=browser.GrowellPopupHistory.watchFilePicker(input,{isCurrent:function(){return state.pickerInput===input&&isCurrent(state);},onCancel:close});
        input.click();
      }
      state.cameraButton.addEventListener('click',function(){pick(state.camera);});
      state.galleryButton.addEventListener('click',function(){pick(state.gallery);});
      [state.camera,state.gallery].forEach(function(input){
        input.addEventListener('change',function(){var file=input.files&&input.files[0],picking=state.pickerInput===input;if(state.pickerCleanup)state.pickerCleanup();state.pickerCleanup=null;state.pickerInput=null;input.value='';if(file)recognize(state,file);else if(picking&&isCurrent(state))close();});
        input.addEventListener('cancel',function(){if(state.pickerInput===input&&isCurrent(state))close();});
      });
      state.cancel.addEventListener('click',function(){if(!isCurrent(state))return;stop(state);busy(state,false);message(state,'글자 인식을 중지했어요. 사진을 다시 선택할 수 있어요.');});
      state.text.addEventListener('input',function(){state.append.disabled=!isCurrent(state)||!!state.run||!normalizeText(state.text.value);});
      state.append.addEventListener('click',function(){
        if(!isCurrent(state)||state.run||state.append.disabled)return;
        try{appendText(config.editor,state.text.value,document);}catch(error){message(state,errorMessage(error),true);return;}
        state.append.disabled=true;
        try{config.editor.dispatchEvent(new browser.Event('input',{bubbles:true}));if(typeof config.onAppend==='function')config.onAppend();}finally{close();}
      });
      node.addEventListener('cancel',function(event){event.preventDefault();close();});node.addEventListener('close',function(){if(active===state)close();});
      if(browser.addEventListener){state.routeListener=function(){if(!isCurrent(state))close();};browser.addEventListener('hashchange',state.routeListener);state.pageListener=close;browser.addEventListener('pagehide',state.pageListener);}
      if(browser.MutationObserver){state.observer=new browser.MutationObserver(function(){if(!isCurrent(state))close();});state.observer.observe(document.body,{childList:true,subtree:true});}
      function identityWatch(){if(active!==state)return;if(!isCurrent(state)){close();return;}if(schedule)state.identityTimer=schedule(identityWatch,500);}
      if(schedule)state.identityTimer=schedule(identityWatch,500);
      state.show=function(){if(!isCurrent(state))return false;try{node.showModal();if(browser.GrowellPopupHistory)browser.GrowellPopupHistory.open('book-photo-ocr',{close:close});if(!initialFile)state.cameraButton.focus();return true;}catch(error){close();return false;}};
      if(initialFile)recognize(state,initialFile);else if(!state.show())return null;
      return state;
    }
    function chooseSource(config){
      if(!sourcePicker)return open(config);
      close();if(!config||!config.editor||!config.composer||typeof config.getContext!=='function'||typeof config.isCurrent!=='function')return Promise.resolve(null);
      var context=config.getContext(),sequence=sourceSequence;
      function current(){try{return sequence===sourceSequence&&config.editor.isConnected&&config.composer.isConnected&&config.isCurrent(context)===true;}catch(error){return false;}}
      if(!current())return Promise.resolve(null);
      return sourcePicker.open({mode:'ocr',trigger:config.button,isCurrent:current}).then(function(file){if(!file||!current())return null;return open(config,file);});
    }
    function bind(config){
      if(binding){binding.button.removeEventListener('click',binding.listener);binding=null;}close();
      if(!config||!config.button||!config.editor||!config.composer)return function(){};
      var listener=function(){chooseSource(config);};config.button.addEventListener('click',listener);binding={button:config.button,listener:listener};
      return function(){if(binding&&binding.listener===listener){config.button.removeEventListener('click',listener);binding=null;close();}};
    }
    return {bind:bind,open:chooseSource,close:close};
  }
  var api=create();api.create=create;api.validateFile=validateFile;api.imageSize=imageSize;api.normalizeText=normalizeText;api.appendText=appendText;api.assets=ASSETS;api.MAX_BYTES=MAX_BYTES;
  return api;
});
