'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Editor=require('../photoEditor.js'),D=Editor.domain;
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
async function flush(){for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));}
// Reuse only the inert synthetic DOM fixture, never a member page or browser.
const fixture=fs.readFileSync(path.join(__dirname,'book-photo-ocr.test.cjs'),'utf8');
const nodeStart=fixture.indexOf('class Node{'),nodeEnd=fixture.indexOf('\nfunction harness(',nodeStart);
const scope={};vm.runInNewContext(fixture.slice(nodeStart,nodeEnd)+'\nthis.FixtureNode=Node;',scope);const BaseNode=scope.FixtureNode;
class Node extends BaseNode{
  constructor(tag,attrs){super(tag,attrs);this.width=0;this.height=0;this.draws=[];}
  set innerHTML(value){super.innerHTML=value;for(const node of this.querySelectorAll('canvas')){node.width=300;node.height=150;node.draws=[];node.getContext=()=>context(node.draws);node.getBoundingClientRect=()=>({left:20,top:30,width:300,height:200});node.setPointerCapture=()=>{};node.releasePointerCapture=()=>{};}for(const node of this.querySelectorAll('input'))if(node.getAttribute('value'))node.value=node.getAttribute('value');for(const node of this.querySelectorAll('select')){const choices=node.querySelectorAll('option');node.value=choices.find(option=>option.getAttribute('selected')!==null)?.getAttribute('value')||choices.find(option=>option.getAttribute('selected')!==null)?.textContent||choices[0]?.getAttribute('value')||choices[0]?.textContent||'';}}
  get innerHTML(){return super.innerHTML;}
  getContext(){return context(this.draws);}
  toBlob(callback,type,quality){this.exported={type,quality,width:this.width,height:this.height};if(this.pendingExport)this.pendingExport(callback);else callback(new Blob(['synthetic-edited-image'],{type}));}
}
function context(calls){const result={save(){calls.push(['save']);},restore(){calls.push(['restore']);},drawImage(...args){calls.push(['image',...args]);},fillRect(...args){calls.push(['fillRect',...args]);},strokeRect(...args){calls.push(['strokeRect',...args]);},beginPath(){},arc(...args){calls.push(['arc',...args]);},fill(){calls.push(['fill']);},moveTo(){},lineTo(){},stroke(){calls.push(['stroke',this.globalAlpha,this.lineWidth,this.strokeStyle]);},setLineDash(){},measureText(text){return {width:Array.from(text).length*Number((this.font||'20px').match(/([0-9.]+)px/)[1])*.55};},fillText(...args){calls.push(['text',...args,this.font,this.fillStyle]);}};return result;}
function harness(options={}){
  const body=new Node('body'),trigger=new Node('button');body.appendChild(trigger);const timers=new Map(),history=[];let id=0,current=true;
  const canvases=[],document={body,createElement:tag=>{const node=new Node(tag);if(tag==='canvas')canvases.push(node);return node;}};const browser={document,addEventListener(){},removeEventListener(){},GrowellPopupHistory:{open:(key,value)=>history.push({key,value}),closed:key=>history.push({closed:key})}};
  const base=new Node('canvas');base.width=600;base.height=400;const api=Editor.create({browser,document,decode:options.decode||(async()=>base),setTimeout:(callback,delay)=>{const token=++id;timers.set(token,{callback,delay});return token;},clearTimeout:token=>timers.delete(token)});
  const result=api.edit({type:'image/jpeg',size:2048,...options.file},{isCurrent:()=>current,trigger,...options.settings});
  const dialog=body.querySelector('dialog');return {api,result,dialog,base,trigger,timers,history,document,canvases,setCurrent:value=>{current=value;},q:selector=>dialog.querySelector(selector)};
}
function pointer(canvas,type,x,y,id=1){canvas.dispatchEvent({type,pointerId:id,isPrimary:true,button:0,clientX:x,clientY:y,preventDefault(){}});}
function button(h,attribute,value){return h.dialog.querySelectorAll('['+attribute+']').find(node=>node.getAttribute(attribute)===value);}
function lastText(h,text){for(const frame of [...h.canvases].reverse()){const draw=frame.draws?.findLast(value=>value[0]==='text'&&(!text||value[1]===text));if(draw)return draw;}return null;}
function input(node,value){node.value=value;node.dispatchEvent({type:'input'});}

test('image dimensions normalize to 2200 pixels and pointer coordinates account for CSS scaling and clamping',()=>{
  assert.deepEqual(D.size(4400,2200),{width:2200,height:1100});assert.deepEqual(D.size(400,800),{width:400,height:800});
  assert.deepEqual(D.point(170,130,{left:20,top:30,width:300,height:200},600,400),{x:300,y:200});
  assert.deepEqual(D.point(-100,900,{left:20,top:30,width:300,height:200},600,400),{x:0,y:400});assert.throws(()=>D.point(0,0,{left:0,top:0,width:0,height:5},600,400));
});
test('reverse dragging produces bounded integral crops and repeated crop plus undo restores exact prior dimensions',()=>{
  const rectangle=D.cropRectangle({x:510.8,y:350.8},{x:90.2,y:20.2},600,400);assert.deepEqual(rectangle,{x:90,y:20,width:421,height:331});
  const original=D.newModel(600,400),first=D.apply(original,{type:'crop',...rectangle}),second=D.apply(first,{type:'crop',x:20,y:20,width:200,height:100});
  assert.deepEqual(D.dimensions(second),{width:200,height:100});assert.deepEqual(D.dimensions(D.undo(second)),{width:421,height:331});assert.deepEqual(D.undo(D.undo(second)),original);assert.equal(original.commands.length,0);
  assert.throws(()=>D.apply(first,{type:'crop',x:400,y:0,width:40,height:50}));assert.throws(()=>D.apply(first,{type:'crop',x:0,y:0,width:1,height:1}));
});
test('full crop frame exposes eight handles with touch targets kept inside CSS-scaled image corners',()=>{
  const rect={x:0,y:0,width:600,height:400};assert.deepEqual(D.cropHandles(rect).map(value=>value.key),['nw','n','ne','e','se','s','sw','w']);
  assert.equal(D.cropHandleAt({x:54,y:54},rect,600,400,2,2),'nw','corner remains a 28 CSS pixel target inside the image');
  assert.equal(D.cropHandleAt({x:546,y:346},rect,600,400,2,2),'se');
  assert.equal(D.cropHandleAt({x:300,y:54},rect,600,400,2,2),'n');
  assert.equal(D.cropHandleAt({x:100,y:100},rect,600,400,2,2),null);
  const inside={x:100,y:80,width:400,height:240};assert.equal(D.cropHandleAt({x:128,y:108},inside,600,400,2,2),'nw');
});
test('frame corner and edge resizing preserve opposite edges, enforce a minimum and clamp movement',()=>{
  const rect={x:50,y:40,width:500,height:300};assert.deepEqual(D.resizeCrop(rect,'nw',{x:125.3,y:99.7},600,400),{x:125,y:100,width:425,height:240});
  assert.deepEqual(D.resizeCrop(rect,'n',{x:350,y:900},600,400),{x:50,y:332,width:500,height:8});
  assert.deepEqual(D.resizeCrop(rect,'se',{x:900,y:900},600,400),{x:50,y:40,width:550,height:360});
  assert.deepEqual(D.resizeCrop(rect,'w',{x:-20,y:200},600,400),{x:0,y:40,width:550,height:300});
  assert.deepEqual(D.moveCrop(rect,900,-900,600,400),{x:100,y:0,width:500,height:300});
  assert.throws(()=>D.resizeCrop(rect,'center',{x:0,y:0},600,400));assert.deepEqual(rect,{x:50,y:40,width:500,height:300});
});
test('reset is local and undoable; stroke and text payloads copy coordinates without modifying caller data',()=>{
  const original=D.newModel(600,400),stroke={type:'stroke',tool:'pen',color:'#d63b3b',width:10,points:[{x:10,y:20},{x:30,y:40}]};const marked=D.apply(original,stroke);stroke.points[0].x=999;assert.equal(marked.commands[0].points[0].x,10);
  const cleared=D.reset(marked);assert.equal(cleared.commands.length,0);assert.deepEqual(D.undo(cleared),marked);assert.equal(original.commands.length,0);
  assert.throws(()=>D.apply(original,{...stroke,color:'url(https://external.test)'}));assert.throws(()=>D.apply(original,{...stroke,points:[{x:Infinity,y:0}]}));
});
test('highlight is translucent and text is painted with fillText, never interpreted as HTML',()=>{
  const draws=[],ctx=context(draws);D.paint(ctx,{type:'stroke',tool:'highlight',color:'#f4ca38',width:32,points:[{x:5,y:5},{x:50,y:5}]},600,400);
  assert.ok(draws.some(call=>call[0]==='stroke'&&call[1]===.32));const model=D.apply(D.newModel(600,400),{type:'text',text:'<img onerror=evil()>',x:10,y:10,color:'#253a31',size:48});
  D.paint(ctx,model.commands[0],600,400);assert.ok(draws.some(call=>call[0]==='text'&&call[1]==='<img onerror=evil()>'));assert.equal(model.commands[0].text,'<img onerror=evil()>');
});
test('crop rendering copies the exact selected pixels and keeps source canvas dimensions unchanged',()=>{
  const document={createElement:tag=>new Node(tag)},base=new Node('canvas');base.width=600;base.height=400;
  const model=D.apply(D.newModel(600,400),{type:'crop',x:20,y:30,width:200,height:100}),rendered=D.renderModel(document,base,model);
  assert.equal(rendered.width,200);assert.equal(rendered.height,100);assert.equal(base.width,600);assert.equal(base.height,400);
  assert.ok(rendered.draws.some(call=>call[0]==='image'&&JSON.stringify(call.slice(2))===JSON.stringify([20,30,200,100,0,0,200,100])));
});
test('editor starts with the full eight-handle frame and exposes one row of accessible icon tools and real color swatches',async()=>{
  const h=harness();await flush();assert.deepEqual(Array.from(h.dialog.querySelectorAll('[data-photo-tool]'),node=>node.getAttribute('data-photo-tool')),['crop','partial','pen','highlight','text']);
  assert.equal(h.q('[data-photo-settings]').hidden,false);assert.equal(h.q('[data-photo-width-settings]').hidden,true);assert.equal(h.q('[data-photo-text-fields]').hidden,true);assert.equal(h.dialog.querySelectorAll('select').length,0,'fixed font sizes and named color select are removed');
  for(const tool of h.dialog.querySelectorAll('[data-photo-tool]')){assert.ok(tool.getAttribute('aria-label'));assert.ok(tool.getAttribute('title'));assert.ok(tool.querySelector('svg'));}
  assert.equal(h.dialog.querySelectorAll('[data-photo-color]').length,7);for(const swatch of h.dialog.querySelectorAll('[data-photo-color]'))assert.ok(swatch.getAttribute('style').includes(swatch.getAttribute('data-photo-color')));
  assert.ok(h.q('[data-photo-canvas]').draws.filter(call=>call[0]==='strokeRect').length>=9,'initial crop boundary and all eight frame handles are drawn');
  button(h,'data-photo-tool','pen').click();assert.equal(h.q('[data-photo-width-settings]').hidden,false);
  button(h,'data-photo-tool','highlight').click();assert.equal(h.q('[data-photo-width]').value,'32');assert.equal(button(h,'data-photo-color','#f4ca38').getAttribute('aria-pressed'),'true');
  button(h,'data-photo-tool','text').click();assert.equal(h.q('[data-photo-text-fields]').hidden,false);assert.equal(h.q('[data-photo-width-settings]').hidden,true);
  assert.equal(h.q('[data-photo-done]').disabled,false);h.q('[data-photo-done]').click();const result=await h.result;assert.ok(result instanceof Blob);assert.equal(result.type,'image/jpeg');assert.equal(h.dialog.isConnected,false);assert.equal(h.base.width,0,'decoded source is released after export');assert.ok(h.history.some(item=>item.key==='photo-editor'));assert.ok(h.history.some(item=>item.closed==='photo-editor'));
});
test('touch-equivalent crop dragging uses scaled image coordinates and undo restores the full image',async()=>{
  const h=harness();await flush();button(h,'data-photo-crop-mode','partial').click();const canvas=h.q('[data-photo-canvas]');pointer(canvas,'pointerdown',70,80);pointer(canvas,'pointermove',220,180);pointer(canvas,'pointerup',220,180);
  assert.equal(h.q('[data-photo-crop-apply]').disabled,false);h.q('[data-photo-crop-apply]').click();assert.equal(canvas.width,300);assert.equal(canvas.height,200);
  h.q('[data-photo-undo]').click();assert.equal(canvas.width,600);assert.equal(canvas.height,400);h.api.close();assert.equal(await h.result,null);
});
test('default corner and edge handles resize the full frame, selection undo and whole-image restoration remain local',async()=>{
  const h=harness();await flush();const canvas=h.q('[data-photo-canvas]');pointer(canvas,'pointerdown',20,30);pointer(canvas,'pointermove',70,80);pointer(canvas,'pointerup',70,80);
  assert.equal(h.q('[data-photo-undo]').disabled,false);h.q('[data-photo-undo]').click();h.q('[data-photo-crop-apply]').click();assert.equal(canvas.width,600);assert.equal(canvas.height,400,'selection undo restored the full frame before applying');
  pointer(canvas,'pointerdown',170,30);pointer(canvas,'pointermove',170,80);pointer(canvas,'pointerup',170,80);h.q('[data-photo-crop-apply]').click();assert.equal(canvas.width,600);assert.equal(canvas.height,300,'top edge keeps the left and right edges fixed');
  h.q('[data-photo-undo]').click();assert.equal(canvas.height,400);
  pointer(canvas,'pointerdown',20,30);pointer(canvas,'pointermove',70,80);pointer(canvas,'pointerup',70,80);h.q('[data-photo-full]').click();h.q('[data-photo-undo]').click();h.q('[data-photo-crop-apply]').click();assert.equal(canvas.width,500);assert.equal(canvas.height,300,'whole-image restore can itself be undone');
  assert.equal(h.base.width,600);assert.equal(h.base.height,400);h.api.close();assert.equal(await h.result,null);
});
test('cancelled frame drags and undo of a first partial selection never silently crop the source',async()=>{
  const h=harness();await flush();const canvas=h.q('[data-photo-canvas]');pointer(canvas,'pointerdown',20,30);pointer(canvas,'pointermove',70,80);canvas.dispatchEvent({type:'pointercancel',pointerId:1});assert.equal(h.q('[data-photo-undo]').disabled,true);
  button(h,'data-photo-crop-mode','partial').click();pointer(canvas,'pointerdown',70,80);pointer(canvas,'pointermove',220,180);pointer(canvas,'pointerup',220,180);assert.equal(h.q('[data-photo-undo]').disabled,false);h.q('[data-photo-undo]').click();assert.equal(h.q('[data-photo-crop-apply]').disabled,true,'undo restores the absence of a partial selection');
  h.q('[data-photo-done]').click();assert.ok(await h.result instanceof Blob);assert.deepEqual(h.canvases.find(node=>node.exported).exported,{type:'image/jpeg',quality:.93,width:600,height:400});
});
test('OCR crop-only mode hides drawing tools and exports the adjusted frame using the safe custom confirmation label',async()=>{
  const h=harness({settings:{cropOnly:true,confirmLabel:'자르고 글자 인식'}});await flush();assert.equal(h.q('[data-photo-tools]').hidden,true);assert.equal(h.q('[data-photo-settings]').hidden,true);assert.equal(h.q('[data-photo-text-fields]').hidden,true);assert.equal(h.q('[data-photo-reset]').hidden,true);assert.equal(h.q('[data-photo-crop-apply]').hidden,true);assert.equal(h.q('[data-photo-done]').textContent,'자르고 글자 인식');
  button(h,'data-photo-tool','pen').click();button(h,'data-photo-crop-mode','partial').click();assert.equal(h.q('[data-photo-text-fields]').hidden,true);assert.equal(h.q('[data-photo-settings]').hidden,true,'hidden controls cannot switch OCR mode');
  const canvas=h.q('[data-photo-canvas]');pointer(canvas,'pointerdown',20,30);pointer(canvas,'pointermove',70,80);pointer(canvas,'pointerup',70,80);h.q('[data-photo-done]').click();const result=await h.result;assert.ok(result instanceof Blob);assert.deepEqual(h.canvases.find(node=>node.exported).exported,{type:'image/jpeg',quality:.93,width:500,height:300});
  const label=harness({settings:{cropOnly:true,confirmLabel:'<img onerror=evil()>'}});await flush();assert.equal(label.q('[data-photo-done]').textContent,'<img onerror=evil()>');assert.equal(label.dialog.querySelectorAll('img').length,0);label.api.close();assert.equal(await label.result,null);
});
test('text placement uses edited plain text and cancelled pointer strokes do not become edits',async()=>{
  const h=harness();await flush();const tools=h.dialog.querySelectorAll('[data-photo-tool]'),canvas=h.q('[data-photo-canvas]');button(h,'data-photo-tool','pen').click();
  pointer(canvas,'pointerdown',70,80);pointer(canvas,'pointermove',100,90);canvas.dispatchEvent({type:'pointercancel',pointerId:1});assert.equal(h.q('[data-photo-undo]').disabled,true);
  tools.find(node=>node.getAttribute('data-photo-tool')==='text').click();h.q('[data-photo-text]').value='<script>안전한 글자</script>';pointer(canvas,'pointerdown',70,80);assert.equal(h.q('[data-photo-undo]').disabled,false);assert.equal(h.dialog.querySelectorAll('script').length,0);
  h.api.close();assert.equal(await h.result,null);
});
test('text boxes move, resize continuously from edges, edit and recolor with one undo step per drag and stay in the exported JPEG',async()=>{
  const h=harness();await flush();const canvas=h.q('[data-photo-canvas]');button(h,'data-photo-tool','text').click();input(h.q('[data-photo-text]'),'hello');pointer(canvas,'pointerdown',70,80);
  assert.equal(lastText(h,'hello')[2],100);assert.equal(lastText(h,'hello')[3],100);assert.match(lastText(h,'hello')[4],/48px/);
  // The center moves a selected box instead of grabbing its nearby resize handles.
  pointer(canvas,'pointerdown',103,95.6);pointer(canvas,'pointermove',113,105.6);pointer(canvas,'pointermove',133,115.6);pointer(canvas,'pointerup',133,115.6);assert.equal(lastText(h,'hello')[2],160);assert.equal(lastText(h,'hello')[3],140);
  h.q('[data-photo-undo]').click();assert.equal(lastText(h,'hello')[2],100,'one undo cancels the complete drag, not only its last pointermove');
  // Right edge expands the text without a fixed font-size menu.
  pointer(canvas,'pointerdown',136,95.6);pointer(canvas,'pointermove',176,95.6);pointer(canvas,'pointerup',176,95.6);assert.match(lastText(h,'hello')[4],/77px/);
  input(h.q('[data-photo-text]'),'changed');button(h,'data-photo-color','#d63b3b').click();assert.equal(lastText(h,'changed')[5],'#d63b3b');
  h.q('[data-photo-text-new]').click();input(h.q('[data-photo-text]'),'second');pointer(canvas,'pointerdown',220,150);assert.ok(lastText(h,'second'));assert.ok(lastText(h,'changed'));
  h.q('[data-photo-done]').click();assert.ok(await h.result instanceof Blob);const exported=h.canvases.find(node=>node.exported);assert.ok(exported.draws.some(value=>value[0]==='text'&&value[1]==='changed'));assert.ok(exported.draws.some(value=>value[0]==='text'&&value[1]==='second'));assert.equal(h.base.width,0);
});
test('text drag cancellation, tool changes and late pointer events cannot commit or target another text box',async()=>{
  const h=harness();await flush();const canvas=h.q('[data-photo-canvas]');button(h,'data-photo-tool','text').click();input(h.q('[data-photo-text]'),'hello');pointer(canvas,'pointerdown',70,80);
  pointer(canvas,'pointerdown',103,95.6);pointer(canvas,'pointermove',133,115.6);canvas.dispatchEvent({type:'pointercancel',pointerId:1});assert.equal(lastText(h,'hello')[2],100);assert.equal(lastText(h,'hello')[3],100);
  pointer(canvas,'pointerdown',103,95.6);pointer(canvas,'pointermove',133,115.6);button(h,'data-photo-tool','pen').click();pointer(canvas,'pointerup',200,150);assert.equal(lastText(h,'hello')[2],100,'switching tools discards an unfinished text drag');
  button(h,'data-photo-tool','text').click();h.q('[data-photo-text-remove]').click();h.q('[data-photo-undo]').click();assert.ok(lastText(h,'hello'),'removing a selected text box is undoable');
  h.api.close();assert.equal(await h.result,null);
});
test('user close and Back notify the optional cancel handler once; replacements, stale contexts and completed photos do not',async()=>{
  let cancelled=0;const h=harness({settings:{onCancel:()=>{cancelled++;}}});await flush();h.history.find(value=>value.key==='photo-editor').value.close();h.q('[data-photo-close]').click();assert.equal(await h.result,null);assert.equal(cancelled,1);
  const program=harness({settings:{onCancel:()=>{cancelled++;}}});await flush();program.api.close();assert.equal(await program.result,null);assert.equal(cancelled,1);
  const stale=harness({settings:{onCancel:()=>{cancelled++;}}});await flush();stale.setCurrent(false);stale.q('[data-photo-close]').click();assert.equal(await stale.result,null);assert.equal(cancelled,1);
  const accepted=harness({settings:{onCancel:()=>{cancelled++;}}});await flush();accepted.q('[data-photo-done]').click();assert.ok(await accepted.result instanceof Blob);assert.equal(cancelled,1);
});
test('cancel, Back and late decode never return a changed photo or replace a parent document',async()=>{
  const late=deferred(),h=harness({decode:()=>late.promise});h.history.find(item=>item.key==='photo-editor').value.close();assert.equal(await h.result,null);
  const decoded=new Node('canvas');decoded.width=600;decoded.height=400;late.resolve(decoded);await flush();assert.equal(decoded.width,0);assert.equal(h.trigger.isConnected,true);
  const second=harness();await flush();second.q('[data-photo-close]').click();assert.equal(await second.result,null);assert.equal(second.trigger.isConnected,true);
});
test('account or route changes before exporting or during asynchronous JPEG export discard the result',async()=>{
  const h=harness();await flush();h.setCurrent(false);h.q('[data-photo-done]').click();const check=[...h.timers.values()].find(value=>value.delay===500);check.callback();assert.equal(await h.result,null);
  const waiting=harness();await flush();let callback;
  const originalCreate=waiting.document.createElement;waiting.document.createElement=tag=>{const node=originalCreate(tag);node.pendingExport=fn=>{callback=fn;};return node;};
  // A crop replaces the rendered frame with a canvas whose export is delayed.
  button(waiting,'data-photo-crop-mode','partial').click();const canvas=waiting.q('[data-photo-canvas]');pointer(canvas,'pointerdown',70,80);pointer(canvas,'pointermove',220,180);pointer(canvas,'pointerup',220,180);waiting.q('[data-photo-crop-apply]').click();waiting.q('[data-photo-done]').click();assert.equal(typeof callback,'function');waiting.setCurrent(false);callback(new Blob(['must-discard'],{type:'image/jpeg'}));assert.equal(await waiting.result,null);
});
test('unsupported and oversized images fail inside the editor without invoking an external service',async()=>{
  let decoded=0;const h=harness({file:{size:D.MAX_BYTES+1},decode:async()=>{decoded++;return new Node('canvas');}});await flush();assert.match(h.q('[data-photo-status]').textContent,/20MB/);assert.equal(decoded,0);assert.equal(h.q('[data-photo-done]').disabled,true);h.api.close();assert.equal(await h.result,null);
});
