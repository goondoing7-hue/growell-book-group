'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Editor=require('../photoEditor.js'),D=Editor.domain;
const clone=value=>JSON.parse(JSON.stringify(value));
function context(draws=[]){return {font:'',save(){},restore(){},drawImage(...args){draws.push(['image',...args]);},fillRect(){},strokeRect(){},beginPath(){},arc(){},fill(){},moveTo(){},lineTo(){},stroke(){},setLineDash(){},measureText(text){const size=Number(/([\d.]+)px/.exec(this.font)?.[1]||20);return {width:Array.from(text).length*size/2};},fillText(text,x,y){draws.push(['text',text,x,y,this.font,this.fillStyle]);}};}
function text(id,x,y,extra={}){return {type:'text',id,x,y,text:'가나다라마바사',size:24,boxWidth:140,color:'#253a31',...extra};}
function cropped(){let model=D.newModel(800,600);model=D.apply(model,text('first',620,420));model=D.apply(model,{type:'crop',x:500,y:300,width:250,height:250});model=D.apply(model,text('second',100,120,{text:'두 번째',size:20,boxWidth:100}));model=D.apply(model,{type:'crop',x:50,y:70,width:150,height:150});return model;}

test('editing earlier text uses its original coordinate system while every later crop and other text stay unchanged',()=>{
  const model=cropped(),before=clone(model),edited=D.changeText(model,'first',{text:'원문 수정',size:57.5,boxWidth:120,color:'#2e6bb5'});
  assert.equal(edited.commands[0].x,620);assert.equal(edited.commands[0].y,420);assert.equal(edited.commands[0].size,57.5);assert.equal(edited.commands[0].id,'first');
  assert.deepEqual(edited.commands.slice(1),model.commands.slice(1));assert.deepEqual(model,before);assert.deepEqual(D.dimensions(edited),{width:150,height:150});
  assert.deepEqual(D.undo(edited),model);assert.throws(()=>D.changeText(model,'missing',{text:'잘못된 대상'}));
});

test('text hit regions project through every subsequent crop and an edit to one ID never replaces a neighboring text',()=>{
  const model=cropped(),items=D.textItems(model,context()),first=items.find(item=>item.id==='first'),second=items.find(item=>item.id==='second');
  assert.ok(first);assert.ok(second);assert.equal(first.offsetX,550);assert.equal(first.offsetY,370);assert.equal(first.rect.x,70);assert.equal(first.rect.y,50);
  assert.equal(second.offsetX,50);assert.equal(second.offsetY,70);assert.equal(second.rect.x,50);assert.equal(second.rect.y,50);
  const moved=D.changeText(model,'first',{x:625,y:427}),projected=D.textItems(moved,context()).find(item=>item.id==='first');
  assert.equal(projected.rect.x,75);assert.equal(projected.rect.y,57);assert.deepEqual(moved.commands[2],model.commands[2]);
});

test('fully cropped-out text cannot be selected while a partially visible text box is clipped to the remaining pixels',()=>{
  let model=D.apply(D.newModel(600,400),text('hidden',10,10,{text:'제외',size:20,boxWidth:40}));model=D.apply(model,text('partial',80,70,{text:'일부분만 보여요',size:20,boxWidth:160}));model=D.apply(model,{type:'crop',x:100,y:80,width:200,height:200});
  const items=D.textItems(model,context());assert.equal(items.some(item=>item.id==='hidden'),false);const partial=items.find(item=>item.id==='partial');assert.ok(partial);assert.equal(partial.rect.x,0);assert.equal(partial.rect.y,0);assert.ok(partial.rect.width>0&&partial.rect.width<=200);assert.ok(partial.rect.height>0&&partial.rect.height<=200);
  assert.equal(model.commands[0].text,'제외');assert.equal(model.commands[1].x,80);
});

test('wrapping and painting share one layout and treat markup-looking text as plain characters',()=>{
  const value=text('safe',12,18,{text:'가나다라마\n<script>',size:20,boxWidth:25}),ctx=context(),layout=D.textLayout(ctx,value,600,400),draws=[];
  assert.deepEqual(layout.lines.slice(0,3),['가나','다라','마']);assert.equal(layout.lineHeight,26);D.paint(context(draws),value,600,400);
  assert.deepEqual(draws.filter(call=>call[0]==='text').map(call=>call[1]),layout.lines);assert.deepEqual(draws.filter(call=>call[0]==='text').map(call=>call[3]),layout.lines.map((_,index)=>18+index*26));
  assert.equal(layout.lines.slice(3).join(''),'<script>');assert.equal(value.text,'가나다라마\n<script>');
});

test('text resizing remains independently undoable and cannot alter strokes, crop coordinates or the original model',()=>{
  let model=D.apply(D.newModel(600,400),text('resize',70,80));model=D.apply(model,{type:'stroke',tool:'highlight',color:'#f4ca38',width:30,points:[{x:60,y:110},{x:240,y:110}]});model=D.apply(model,{type:'crop',x:30,y:30,width:350,height:300});
  const before=clone(model),first=D.changeText(model,'resize',{size:72.25,boxWidth:260}),second=D.changeText(first,'resize',{text:'바꾼 문장',color:'#d63b3b'});
  assert.deepEqual(second.commands.slice(1),model.commands.slice(1));assert.deepEqual(D.undo(second),first);assert.deepEqual(D.undo(D.undo(second)),model);assert.deepEqual(model,before);
  assert.equal(D.changeText(model,'resize',{}),model,'an unchanged edit creates no hidden undo step');
  for(const patch of [{size:Infinity},{size:0},{boxWidth:NaN},{boxWidth:1},{color:'url(https://external.example)'},{x:-1},{text:''}])assert.throws(()=>D.changeText(model,'resize',patch));
});

test('rendering text changes and following crops creates a new frame without modifying the decoded original',()=>{
  const canvases=[],document={createElement(){const canvas={width:0,height:0,draws:[],getContext(){return this.ctx||(this.ctx=context(this.draws));}};canvases.push(canvas);return canvas;}},base={width:800,height:600};
  const model=cropped(),changed=D.changeText(model,'first',{text:'원본과 별도 편집',size:36}),rendered=D.renderModel(document,base,changed);
  assert.equal(rendered.width,150);assert.equal(rendered.height,150);assert.deepEqual(base,{width:800,height:600});
  assert.ok(canvases.flatMap(canvas=>canvas.draws).some(call=>call[0]==='text'&&String(call[1]).includes('원본')));assert.equal(model.commands[0].text,'가나다라마바사');
  const crops=canvases.flatMap(canvas=>canvas.draws).filter(call=>call[0]==='image'&&call.length===10);assert.deepEqual(crops.map(call=>call.slice(2)),[[500,300,250,250,0,0,250,250],[50,70,150,150,0,0,150,150]]);
});
