(function(root,factory){
  'use strict';var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.GrowellPhotoEditor=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var MAX_BYTES=20*1024*1024,MAX_EDGE=2200,MAX_COMMANDS=100;
  var COLORS=['#253a31','#ffffff','#d63b3b','#f4ca38','#3c7960','#2e6bb5','#8a4db0'];
  function error(code){var result=new Error(code);result.code=code;return result;}
  function finite(value){return typeof value==='number'&&Number.isFinite(value);}
  function size(width,height){if(!finite(width)||!finite(height)||width<1||height<1||width*height>100000000)throw error('photo-decode');var scale=Math.min(1,MAX_EDGE/Math.max(width,height));return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};}
  function point(clientX,clientY,bounds,width,height){
    if(!bounds||![clientX,clientY,bounds.left,bounds.top,bounds.width,bounds.height,width,height].every(finite)||bounds.width<=0||bounds.height<=0||width<=0||height<=0)throw error('photo-coordinate');
    return {x:Math.max(0,Math.min(width,(clientX-bounds.left)*width/bounds.width)),y:Math.max(0,Math.min(height,(clientY-bounds.top)*height/bounds.height))};
  }
  function cropRectangle(a,b,width,height){
    if(!a||!b||![a.x,a.y,b.x,b.y,width,height].every(finite)||width<1||height<1)throw error('photo-coordinate');
    var left=Math.max(0,Math.min(width,Math.floor(Math.min(a.x,b.x)))),top=Math.max(0,Math.min(height,Math.floor(Math.min(a.y,b.y))));
    var right=Math.max(left,Math.min(width,Math.ceil(Math.max(a.x,b.x)))),bottom=Math.max(top,Math.min(height,Math.ceil(Math.max(a.y,b.y))));
    return {x:left,y:top,width:right-left,height:bottom-top};
  }
  function cropHandles(rect){var middleX=rect.x+rect.width/2,middleY=rect.y+rect.height/2,right=rect.x+rect.width,bottom=rect.y+rect.height;return [{key:'nw',x:rect.x,y:rect.y},{key:'n',x:middleX,y:rect.y},{key:'ne',x:right,y:rect.y},{key:'e',x:right,y:middleY},{key:'se',x:right,y:bottom},{key:'s',x:middleX,y:bottom},{key:'sw',x:rect.x,y:bottom},{key:'w',x:rect.x,y:middleY}];}
  function cropHandleAt(p,rect,width,height,scaleX,scaleY){
    var hitWidth=Math.min(width,28*scaleX),hitHeight=Math.min(height,28*scaleY),candidates=[];
    cropHandles(rect).forEach(function(handle){var left=Math.max(0,Math.min(width-hitWidth,handle.x-hitWidth/2)),top=Math.max(0,Math.min(height-hitHeight,handle.y-hitHeight/2));if(p.x>=left&&p.x<=left+hitWidth&&p.y>=top&&p.y<=top+hitHeight)candidates.push({key:handle.key,distance:Math.pow((p.x-handle.x)/scaleX,2)+Math.pow((p.y-handle.y)/scaleY,2)});});
    candidates.sort(function(a,b){return a.distance-b.distance;});return candidates.length?candidates[0].key:null;
  }
  function resizeCrop(rect,handle,p,width,height){
    if(!rect||!p||['nw','n','ne','e','se','s','sw','w'].indexOf(handle)<0)throw error('photo-coordinate');
    var left=rect.x,top=rect.y,right=left+rect.width,bottom=top+rect.height;
    if(handle.indexOf('w')>=0)left=Math.max(0,Math.min(right-8,Math.round(p.x)));
    if(handle.indexOf('e')>=0)right=Math.min(width,Math.max(left+8,Math.round(p.x)));
    if(handle.indexOf('n')>=0)top=Math.max(0,Math.min(bottom-8,Math.round(p.y)));
    if(handle.indexOf('s')>=0)bottom=Math.min(height,Math.max(top+8,Math.round(p.y)));
    return {x:left,y:top,width:right-left,height:bottom-top};
  }
  function moveCrop(rect,dx,dy,width,height){return {x:Math.max(0,Math.min(width-rect.width,Math.round(rect.x+dx))),y:Math.max(0,Math.min(height-rect.height,Math.round(rect.y+dy))),width:rect.width,height:rect.height};}
  function dimensions(model){var width=model.baseWidth,height=model.baseHeight;model.commands.forEach(function(command){if(command.type==='crop'){width=command.width;height=command.height;}});return {width:width,height:height};}
  function newModel(width,height){if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>MAX_EDGE||height>MAX_EDGE)throw error('photo-size');return {baseWidth:width,baseHeight:height,commands:[],history:[]};}
  function normalizedCommand(model,command){
    var view=dimensions(model);if(!command||typeof command!=='object')throw error('photo-command');
    if(command.type==='crop'){
      if(![command.x,command.y,command.width,command.height].every(Number.isInteger)||command.x<0||command.y<0||command.width<8||command.height<8||command.x+command.width>view.width||command.y+command.height>view.height)throw error('photo-crop');
      return {type:'crop',x:command.x,y:command.y,width:command.width,height:command.height};
    }
    if(COLORS.indexOf(command.color)<0)throw error('photo-color');
    if(command.type==='stroke'){
      if(!Array.isArray(command.points)||!command.points.length||command.points.length>5000||!finite(command.width)||command.width<2||command.width>60||['pen','highlight'].indexOf(command.tool)<0)throw error('photo-stroke');
      return {type:'stroke',tool:command.tool,color:command.color,width:command.width,points:command.points.map(function(p){if(!p||!finite(p.x)||!finite(p.y)||p.x<0||p.y<0||p.x>view.width||p.y>view.height)throw error('photo-coordinate');return {x:p.x,y:p.y};})};
    }
    if(command.type==='text'){
      var text=typeof command.text==='string'?command.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/\r\n?/g,'\n').trim():'';
      if(!text||Array.from(text).length>200||!finite(command.x)||!finite(command.y)||command.x<0||command.y<0||command.x>view.width||command.y>view.height||[24,36,48,64,96].indexOf(command.size)<0)throw error('photo-text');
      return {type:'text',x:command.x,y:command.y,text:text,color:command.color,size:command.size};
    }
    throw error('photo-command');
  }
  function replace(model,commands){return {baseWidth:model.baseWidth,baseHeight:model.baseHeight,commands:commands,history:model.history.concat([model.commands]).slice(-MAX_COMMANDS)};}
  function apply(model,command){if(model.commands.length>=MAX_COMMANDS)throw error('photo-limit');return replace(model,model.commands.concat([normalizedCommand(model,command)]));}
  function undo(model){if(!model.history.length)return model;return {baseWidth:model.baseWidth,baseHeight:model.baseHeight,commands:model.history[model.history.length-1],history:model.history.slice(0,-1)};}
  function reset(model){return model.commands.length?replace(model,[]):model;}
  function makeCanvas(document,width,height){var canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;}
  function paint(context,command,width,height){
    context.save();context.globalCompositeOperation='source-over';context.globalAlpha=1;
    if(command.type==='stroke'){
      context.strokeStyle=command.color;context.fillStyle=command.color;context.lineWidth=command.width;context.lineCap='round';context.lineJoin='round';context.globalAlpha=command.tool==='highlight'?0.32:1;
      var points=command.points;context.beginPath();
      if(points.length===1){context.arc(points[0].x,points[0].y,command.width/2,0,Math.PI*2);context.fill();}
      else{context.moveTo(points[0].x,points[0].y);for(var i=1;i<points.length;i++)context.lineTo(points[i].x,points[i].y);context.stroke();}
    }else if(command.type==='text'){
      context.fillStyle=command.color;context.font='600 '+command.size+'px Pretendard, sans-serif';context.textBaseline='top';
      var x=Math.min(command.x,Math.max(0,width-command.size)),y=Math.min(command.y,Math.max(0,height-command.size)),lineHeight=command.size*1.3;
      command.text.split('\n').forEach(function(paragraph){var line='';Array.from(paragraph).forEach(function(character){if(line&&context.measureText(line+character).width>Math.max(command.size,width-x)){context.fillText(line,x,y);y+=lineHeight;line='';}line+=character;});context.fillText(line,x,y);y+=lineHeight;});
    }
    context.restore();
  }
  function renderModel(document,base,model){
    var canvas=makeCanvas(document,model.baseWidth,model.baseHeight),context=canvas.getContext('2d',{alpha:false});if(!context)throw error('photo-decode');context.drawImage(base,0,0);
    model.commands.forEach(function(command){
      if(command.type==='crop'){
        var cropped=makeCanvas(document,command.width,command.height),next=cropped.getContext('2d',{alpha:false});if(!next)throw error('photo-decode');next.drawImage(canvas,command.x,command.y,command.width,command.height,0,0,command.width,command.height);canvas.width=0;canvas.height=0;canvas=cropped;context=next;
      }else paint(context,command,canvas.width,canvas.height);
    });return canvas;
  }
  async function decode(file,browser,document){
    var bitmap=null,url=null,canvas=null;
    try{
      if(typeof browser.createImageBitmap==='function'){try{bitmap=await browser.createImageBitmap(file,{imageOrientation:'from-image'});}catch(e){bitmap=null;}}
      if(!bitmap){if(!browser.URL||!browser.Image)throw error('photo-decode');url=browser.URL.createObjectURL(file);bitmap=await new Promise(function(resolve,reject){var image=new browser.Image();image.onload=function(){resolve(image);};image.onerror=function(){reject(error('photo-decode'));};image.src=url;});}
      var target=size(bitmap.width||bitmap.naturalWidth,bitmap.height||bitmap.naturalHeight);canvas=makeCanvas(document,target.width,target.height);
      var context=canvas.getContext('2d',{alpha:false});if(!context)throw error('photo-decode');context.fillStyle='#ffffff';context.fillRect(0,0,target.width,target.height);context.drawImage(bitmap,0,0,target.width,target.height);return canvas;
    }catch(e){if(canvas){canvas.width=0;canvas.height=0;}throw error('photo-decode');}
    finally{if(bitmap&&typeof bitmap.close==='function')bitmap.close();if(url)browser.URL.revokeObjectURL(url);}
  }
  function create(options){
    options=options||{};var browser=options.browser||root,document=options.document||browser.document,active=null;
    var schedule=options.setTimeout||(browser.setTimeout&&browser.setTimeout.bind(browser)),unschedule=options.clearTimeout||(browser.clearTimeout&&browser.clearTimeout.bind(browser));
    function current(state){if(active!==state||state.closed||!state.node.isConnected)return false;try{return state.options.isCurrent()===true;}catch(e){return false;}}
    function release(canvas){if(canvas){canvas.width=0;canvas.height=0;}}
    function finish(state,blob){
      if(!state||state.closed)return;var permitted=current(state);state.closed=true;if(active===state)active=null;
      if(state.timer)unschedule(state.timer);if(state.observer)state.observer.disconnect();
      if(browser.removeEventListener){browser.removeEventListener('hashchange',state.routeListener);browser.removeEventListener('pagehide',state.pageListener);}
      try{if(state.node.open)state.node.close();}catch(e){}state.node.remove();release(state.frame);release(state.base);release(state.canvas);
      if(browser.GrowellPopupHistory)browser.GrowellPopupHistory.closed('photo-editor');
      state.resolve(permitted&&blob?blob:null);
      if(permitted&&state.options.trigger&&state.options.trigger.isConnected){try{state.options.trigger.focus({preventScroll:true});}catch(e){}}
    }
    function say(state,text,bad){state.status.textContent=text;state.status.classList.toggle('is-error',!!bad);}
    function redraw(state){
      if(!current(state)||!state.frame)return;var canvas=state.canvas;
      if(canvas.width!==state.frame.width)canvas.width=state.frame.width;if(canvas.height!==state.frame.height)canvas.height=state.frame.height;
      var context=canvas.getContext('2d',{alpha:false});context.drawImage(state.frame,0,0);
      if(state.pendingStroke)paint(context,state.pendingStroke,canvas.width,canvas.height);
      var crop=state.crop;if(crop&&crop.width>0&&crop.height>0){context.save();context.fillStyle='rgba(0,0,0,.48)';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(state.frame,crop.x,crop.y,crop.width,crop.height,crop.x,crop.y,crop.width,crop.height);context.strokeStyle='#ffffff';context.lineWidth=Math.max(2,canvas.width/400);context.setLineDash([canvas.width/80,canvas.width/100]);context.strokeRect(crop.x,crop.y,crop.width,crop.height);context.setLineDash([]);
        if(state.cropMode==='frame'){var bounds=canvas.getBoundingClientRect(),sx=bounds.width?canvas.width/bounds.width:1,sy=bounds.height?canvas.height/bounds.height:1;context.fillStyle='#ffffff';context.strokeStyle='#3e6551';cropHandles(crop).forEach(function(handle){var w=12*sx,h=12*sy,x=Math.max(0,Math.min(canvas.width-w,handle.x-w/2)),y=Math.max(0,Math.min(canvas.height-h,handle.y-h/2));context.fillRect(x,y,w,h);context.strokeRect(x,y,w,h);});}context.restore();}
      state.cropApply.disabled=!crop||crop.width<8||crop.height<8;state.cropApply.hidden=state.tool!=='crop'||state.options.cropOnly===true;state.fullCrop.hidden=state.tool!=='crop';
      state.undo.disabled=!state.model.history.length&&!state.cropHistory.length;state.reset.disabled=!state.model.commands.length;state.reset.hidden=state.options.cropOnly===true;
    }
    function rebuild(state){var frame=renderModel(document,state.base,state.model);release(state.frame);state.frame=frame;redraw(state);}
    function command(state,value){
      if(!current(state)||state.busy||!state.model)return false;
      try{var next=apply(state.model,value);var frame=renderModel(document,state.base,next);release(state.frame);state.model=next;state.frame=frame;state.crop=state.tool==='crop'?{x:0,y:0,width:frame.width,height:frame.height}:null;state.cropHistory=[];state.pendingStroke=null;redraw(state);say(state,'편집을 적용했어요. 되돌리기로 한 단계 취소할 수 있어요.');return true;}
      catch(e){say(state,e.code==='photo-limit'?'표시가 많아요. 되돌리거나 완료한 뒤 다시 편집해주세요.':'선택 영역이나 입력 내용을 확인해주세요.',true);return false;}
    }
    function setTool(state,tool){
      if(!current(state)||state.busy||state.options.cropOnly===true&&tool!=='crop')return;
      if(state.tool==='crop'&&tool!=='crop'&&state.crop&&state.frame&&(state.crop.x||state.crop.y||state.crop.width!==state.frame.width||state.crop.height!==state.frame.height)&&!command(state,Object.assign({type:'crop'},state.crop)))return;
      state.tool=tool;state.crop=tool==='crop'&&state.frame?{x:0,y:0,width:state.frame.width,height:state.frame.height}:null;state.cropHistory=[];state.pendingStroke=null;state.pointer=null;
      state.node.querySelectorAll('[data-photo-tool]').forEach(function(button){var target=button.getAttribute('data-photo-tool');button.setAttribute('aria-pressed',String(target===tool||target==='mark'&&(tool==='pen'||tool==='highlight')));});state.textFields.hidden=tool!=='text';
      state.markTools.hidden=tool!=='pen'&&tool!=='highlight';state.settings.hidden=tool==='crop';state.widthSettings.hidden=tool==='text';state.cropTools.hidden=tool!=='crop'||state.options.cropOnly===true;
      state.node.querySelectorAll('[data-photo-mark]').forEach(function(button){button.setAttribute('aria-pressed',String(button.getAttribute('data-photo-mark')===tool));});
      if(tool==='highlight'){if(Number(state.width.value)<20)state.width.value='32';if(state.color.value==='#253a31')state.color.value='#f4ca38';}
      else if(tool==='pen'){if(Number(state.width.value)>20)state.width.value='10';if(state.color.value==='#f4ca38')state.color.value='#253a31';}state.widthLabel.textContent=state.width.value;
      say(state,{crop:state.cropMode==='frame'?'사각형의 모서리나 변을 끌어 남길 영역을 맞추세요. 끝나면 아래 완료 버튼을 누르세요.':'사진 위를 드래그해 남길 부분을 선택하세요.',pen:'사진 위를 손가락이나 마우스로 그려 표시해주세요.',highlight:'강조할 부분 위를 손가락이나 마우스로 그어주세요.',text:'넣을 글자를 입력한 뒤 사진에서 원하는 위치를 눌러주세요.'}[tool]);redraw(state);
    }
    function edit(file,settings){
      if(active)finish(active,null);settings=settings||{};
      var permitted=false;try{permitted=!!document&&typeof settings.isCurrent==='function'&&settings.isCurrent()===true;}catch(e){}
      if(!permitted)return Promise.resolve(null);
      return new Promise(function(resolve){
        var node=document.createElement('dialog');node.className='photo-editor';node.setAttribute('aria-labelledby','photo-editor-title');
        node.innerHTML='<header class="photo-editor-head"><div><h2 id="photo-editor-title" data-photo-title>사진 편집</h2><p data-photo-description>자르거나 표시하고, 원하는 글자를 넣어보세요.</p></div><button type="button" class="icon-btn" data-photo-close aria-label="사진 편집 닫기">×</button></header>'+
          '<div class="photo-editor-tools" data-photo-tools role="group" aria-label="사진 편집 도구"><button type="button" class="btn btn-sm" data-photo-tool="crop" aria-pressed="true">자르기</button><button type="button" class="btn btn-sm" data-photo-tool="mark" aria-pressed="false">표시</button><button type="button" class="btn btn-sm" data-photo-tool="text" aria-pressed="false">글자</button></div>'+
          '<div class="photo-editor-subtools" data-photo-crop-settings><button type="button" class="btn btn-sm" data-photo-crop-mode="frame" aria-pressed="true">전체 자르기</button><button type="button" class="btn btn-sm" data-photo-crop-mode="partial" aria-pressed="false">부분 자르기</button></div>'+
          '<div class="photo-editor-subtools" data-photo-mark-tools hidden><button type="button" class="btn btn-sm" data-photo-mark="pen" aria-pressed="true">펜</button><button type="button" class="btn btn-sm" data-photo-mark="highlight" aria-pressed="false">형광펜</button></div>'+
          '<div class="photo-editor-settings" data-photo-settings hidden><label>색 <select data-photo-color aria-label="표시 색">'+COLORS.map(function(color,index){return '<option value="'+color+'">'+['먹색','흰색','빨강','노랑','초록','파랑','보라'][index]+'</option>';}).join('')+'</select></label><label class="photo-editor-width" data-photo-width-settings>굵기 <input type="range" min="2" max="60" step="1" value="10" data-photo-width aria-label="펜과 형광펜 굵기"><output data-photo-width-value>10</output></label></div>'+
          '<div class="photo-editor-text-fields" data-photo-text-fields hidden><label>넣을 글자 <input type="text" maxlength="200" data-photo-text placeholder="글자를 입력하고 사진을 눌러주세요"></label><label>글자 크기 <select data-photo-font><option>24</option><option>36</option><option selected>48</option><option>64</option><option>96</option></select></label></div>'+
          '<p class="photo-editor-status" data-photo-status role="status" aria-live="polite">사진을 준비하고 있어요.</p><div class="photo-editor-stage"><canvas data-photo-canvas aria-label="편집할 사진. 도구를 고르고 사진 위에서 표시해주세요."></canvas></div>'+
          '<div class="photo-editor-secondary"><button type="button" class="btn btn-sm" data-photo-crop-apply disabled>자르기 적용</button><button type="button" class="btn btn-sm" data-photo-full>전체 선택</button><button type="button" class="btn btn-sm" data-photo-undo disabled>되돌리기</button><button type="button" class="btn btn-sm" data-photo-reset disabled>원본으로</button></div>'+
          '<footer class="photo-editor-actions"><p>이 기기에서만 편집해요. 완료 전에는 원래 사진과 글이 바뀌지 않아요.</p><div><button type="button" class="btn" data-photo-close>취소</button><button type="button" class="btn btn-primary" data-photo-done disabled>이 사진 사용</button></div></footer>';
        function q(selector){return node.querySelector(selector);}
        var state={node:node,options:settings,resolve:resolve,closed:false,base:null,frame:null,model:null,busy:false,tool:'crop',cropMode:'frame',cropHistory:[],crop:null,pointer:null,pendingStroke:null,canvas:q('[data-photo-canvas]'),status:q('[data-photo-status]'),width:q('[data-photo-width]'),widthLabel:q('[data-photo-width-value]'),color:q('[data-photo-color]'),text:q('[data-photo-text]'),font:q('[data-photo-font]'),textFields:q('[data-photo-text-fields]'),markTools:q('[data-photo-mark-tools]'),settings:q('[data-photo-settings]'),widthSettings:q('[data-photo-width-settings]'),cropTools:q('[data-photo-crop-settings]'),cropApply:q('[data-photo-crop-apply]'),fullCrop:q('[data-photo-full]'),undo:q('[data-photo-undo]'),reset:q('[data-photo-reset]'),done:q('[data-photo-done]')};
        if(settings.cropOnly===true){q('[data-photo-tools]').hidden=true;state.cropTools.hidden=true;q('[data-photo-title]').textContent='책 사진 자르기';q('[data-photo-description]').textContent='사진의 사각형 틀을 맞추면 바로 글자를 읽어요.';}
        if(typeof settings.confirmLabel==='string'&&settings.confirmLabel.trim())state.done.textContent=settings.confirmLabel.trim().slice(0,40);
        document.body.appendChild(node);active=state;
        node.querySelectorAll('[data-photo-close]').forEach(function(button){button.addEventListener('click',function(){finish(state,null);});});
        node.addEventListener('cancel',function(event){event.preventDefault();finish(state,null);});node.addEventListener('close',function(){finish(state,null);});
        node.querySelectorAll('[data-photo-tool]').forEach(function(button){button.addEventListener('click',function(){var tool=button.getAttribute('data-photo-tool');setTool(state,tool==='mark'?'pen':tool);});});
        node.querySelectorAll('[data-photo-mark]').forEach(function(button){button.addEventListener('click',function(){setTool(state,button.getAttribute('data-photo-mark'));});});
        node.querySelectorAll('[data-photo-crop-mode]').forEach(function(button){button.addEventListener('click',function(){if(!current(state)||state.busy||settings.cropOnly===true)return;state.cropMode=button.getAttribute('data-photo-crop-mode');setTool(state,'crop');if(state.cropMode==='partial')state.crop=null;node.querySelectorAll('[data-photo-crop-mode]').forEach(function(item){item.setAttribute('aria-pressed',String(item===button));});redraw(state);});});
        state.width.addEventListener('input',function(){state.widthLabel.textContent=state.width.value;});
        state.cropApply.addEventListener('click',function(){if(state.crop)command(state,Object.assign({type:'crop'},state.crop));});
        state.fullCrop.addEventListener('click',function(){if(!current(state)||state.busy||!state.frame)return;var full={x:0,y:0,width:state.frame.width,height:state.frame.height};if(JSON.stringify(state.crop)!==JSON.stringify(full))state.cropHistory.push(state.crop&&Object.assign({},state.crop));state.crop=full;redraw(state);});
        state.undo.addEventListener('click',function(){if(!current(state)||state.busy||!state.model)return;if(state.cropHistory.length)state.crop=state.cropHistory.pop();else{state.model=undo(state.model);var view=dimensions(state.model);state.crop=state.tool==='crop'?{x:0,y:0,width:view.width,height:view.height}:null;state.pendingStroke=null;rebuild(state);}redraw(state);say(state,'한 단계 되돌렸어요.');});
        state.reset.addEventListener('click',function(){if(!current(state)||state.busy||!state.model)return;state.model=reset(state.model);var view=dimensions(state.model);state.crop=state.tool==='crop'?{x:0,y:0,width:view.width,height:view.height}:null;state.cropHistory=[];state.pendingStroke=null;rebuild(state);say(state,'이 사진에서 한 편집을 되돌렸어요.');});
        function canvasPoint(event){return point(event.clientX,event.clientY,state.canvas.getBoundingClientRect(),state.canvas.width,state.canvas.height);}
        state.canvas.addEventListener('pointerdown',function(event){
          if(!current(state)||state.busy||!state.frame||state.pointer!==null||event.isPrimary===false||event.button>0)return;event.preventDefault();var p=canvasPoint(event);
          if(state.tool==='text'){if(!state.text.value.trim()){say(state,'먼저 넣을 글자를 입력해주세요.',true);state.text.focus();return;}command(state,{type:'text',x:p.x,y:p.y,text:state.text.value,color:state.color.value,size:Number(state.font.value)});return;}
          state.pointer=event.pointerId;state.start=p;state.previousCrop=state.crop&&Object.assign({},state.crop);try{state.canvas.setPointerCapture(event.pointerId);}catch(e){}
          if(state.tool==='crop'){
            if(state.cropMode==='frame'){var bounds=state.canvas.getBoundingClientRect(),handle=cropHandleAt(p,state.crop,state.frame.width,state.frame.height,state.canvas.width/bounds.width,state.canvas.height/bounds.height);state.drag=handle?{kind:'handle',handle:handle,rect:Object.assign({},state.crop)}:{kind:'move',rect:Object.assign({},state.crop)};}
            else state.crop=cropRectangle(p,p,state.frame.width,state.frame.height);state.pendingStroke=null;
          }
          else{state.crop=null;state.pendingStroke={type:'stroke',tool:state.tool,color:state.color.value,width:Number(state.width.value),points:[p]};}redraw(state);
        });
        state.canvas.addEventListener('pointermove',function(event){if(!current(state)||state.pointer!==event.pointerId)return;event.preventDefault();var p=canvasPoint(event);
          if(state.tool==='crop'){
            if(state.cropMode==='frame'&&state.drag)state.crop=state.drag.kind==='handle'?resizeCrop(state.drag.rect,state.drag.handle,p,state.frame.width,state.frame.height):moveCrop(state.drag.rect,p.x-state.start.x,p.y-state.start.y,state.frame.width,state.frame.height);
            else state.crop=cropRectangle(state.start,p,state.frame.width,state.frame.height);
          }else if(state.pendingStroke&&state.pendingStroke.points.length<5000)state.pendingStroke.points.push(p);redraw(state);});
        function endPointer(event,cancelled){if(state.pointer!==event.pointerId)return;state.pointer=null;try{state.canvas.releasePointerCapture(event.pointerId);}catch(e){}if(cancelled){state.pendingStroke=null;state.crop=state.previousCrop;state.drag=null;redraw(state);return;}
          if(state.pendingStroke){var stroke=state.pendingStroke;state.pendingStroke=null;command(state,stroke);}else{if(JSON.stringify(state.previousCrop)!==JSON.stringify(state.crop))state.cropHistory.push(state.previousCrop);state.drag=null;redraw(state);}}
        state.canvas.addEventListener('pointerup',function(event){endPointer(event,false);});state.canvas.addEventListener('pointercancel',function(event){endPointer(event,true);});
        state.done.addEventListener('click',function(){
          if(!current(state)||state.busy||!state.frame||state.pointer!==null)return;
          if(state.crop&&(state.crop.x||state.crop.y||state.crop.width!==state.frame.width||state.crop.height!==state.frame.height)&&!command(state,Object.assign({type:'crop'},state.crop)))return;
          state.busy=true;state.done.disabled=true;say(state,'편집한 사진을 준비하고 있어요.');
          try{state.frame.toBlob(function(blob){if(!current(state)){finish(state,null);return;}if(!blob){state.busy=false;state.done.disabled=false;say(state,'사진을 만들지 못했어요. 다시 시도해주세요.',true);return;}finish(state,blob);},'image/jpeg',.93);}catch(e){state.busy=false;state.done.disabled=false;say(state,'사진을 만들지 못했어요. 다시 시도해주세요.',true);}
        });
        if(browser.addEventListener){state.routeListener=function(){if(!current(state))finish(state,null);};state.pageListener=function(){finish(state,null);};browser.addEventListener('hashchange',state.routeListener);browser.addEventListener('pagehide',state.pageListener);}
        if(browser.MutationObserver){state.observer=new browser.MutationObserver(function(){if(!current(state))finish(state,null);});state.observer.observe(document.body,{childList:true,subtree:true});}
        function watch(){if(state.closed)return;if(!current(state)){finish(state,null);return;}if(schedule)state.timer=schedule(watch,500);}if(schedule)state.timer=schedule(watch,500);
        try{node.showModal();if(browser.GrowellPopupHistory)browser.GrowellPopupHistory.open('photo-editor',{close:function(){finish(state,null);}});}catch(e){finish(state,null);return;}
        Promise.resolve().then(function(){
          if(!file||typeof file.type!=='string'||!/^image\//i.test(file.type))throw error('photo-required');if(!finite(file.size)||file.size<=0||file.size>MAX_BYTES)throw error('photo-size');
          return options.decode?options.decode(file):decode(file,browser,document);
        }).then(function(base){if(!current(state)){release(base);finish(state,null);return;}state.base=base;state.model=newModel(base.width,base.height);rebuild(state);state.done.disabled=false;setTool(state,'crop');
        }).catch(function(e){if(current(state))say(state,{'photo-required':'사진 파일을 선택해주세요.','photo-size':'사진은 20MB 이하로 선택해주세요.','photo-decode':'사진을 열지 못했어요. JPG 또는 PNG 사진으로 다시 선택해주세요.'}[e&&e.code]||'사진을 준비하지 못했어요. 다시 선택해주세요.',true);});
      });
    }
    return {edit:edit,close:function(){if(active)finish(active,null);}};
  }
  var api=create();api.create=create;api.domain=Object.freeze({size:size,point:point,cropRectangle:cropRectangle,cropHandles:cropHandles,cropHandleAt:cropHandleAt,resizeCrop:resizeCrop,moveCrop:moveCrop,newModel:newModel,dimensions:dimensions,apply:apply,undo:undo,reset:reset,paint:paint,renderModel:renderModel,colors:COLORS.slice(),MAX_BYTES:MAX_BYTES});return api;
});
