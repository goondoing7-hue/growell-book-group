const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const source=html.slice(html.indexOf('var RT_TEXT_COLORS ='),html.indexOf('/* 나눔 공간 / 나의 공간 글쓰기에서 텍스트 박스 배경색'));

class Element {
  constructor(tag='div',attrs={}){this.tag=tag;this.attrs=attrs;this.children=[];this.events={};this.hidden=false;this.styles={};this.classes=new Set();this.style={setProperty:(key,value)=>{this.styles[key]=value;}};this.classList={toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};}
  append(child){child.parent=this;this.children.push(child);return child;}
  contains(node){for(let current=node;current;current=current.parent)if(current===this)return true;return false;}
  getAttribute(key){return this.attrs[key]??null;}
  setAttribute(key,value){this.attrs[key]=String(value);}
  hasAttribute(key){return key in this.attrs;}
  addEventListener(type,handler){(this.events[type]||(this.events[type]=[])).push(handler);}
  removeEventListener(type,handler){this.events[type]=(this.events[type]||[]).filter(fn=>fn!==handler);}
  fire(type,extra={}){const event={target:this,preventDefault(){this.defaultPrevented=true;},...extra};for(const fn of [...this.events[type]||[]])fn(event);return event;}
  matches(selector){if(selector==='button')return this.tag==='button';const match=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);return !!match&&this.hasAttribute(match[1])&&(match[2]===undefined||this.getAttribute(match[1])===match[2]);}
  closest(selector){for(let current=this;current;current=current.parent)if(current.matches(selector))return current;return null;}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  focus(){this.focused=true;}
}
function range(node,start=0,end=start){return {startContainer:node,endContainer:node,startOffset:start,endOffset:end,get collapsed(){return this.startOffset===this.endOffset;},cloneRange(){return range(this.startContainer,this.startOffset,this.endOffset);},selectNodeContents(editor){this.startContainer=this.endContainer=editor;this.startOffset=0;this.endOffset=20;},collapse(){this.startOffset=this.endOffset;}};}
function harness(){
  const document=new Element('document'),editor=new Element('editor'),text=editor.append(new Element('text')),outside=new Element('outside');
  const selection={rangeCount:0,anchorNode:null,focusNode:null,current:null,get isCollapsed(){return !this.current||this.current.collapsed;},getRangeAt(){return this.current;},removeAllRanges(){this.rangeCount=0;this.anchorNode=this.focusNode=null;this.current=null;},addRange(value){this.current=value;this.rangeCount=1;this.anchorNode=value.startContainer;this.focusNode=value.endContainer;}};
  let controls,cssMode=false,drafts=0;
  const commands=[],toasts=[];
  editor.focus=()=>{selection.removeAllRanges();selection.addRange(range(text,20));};
  document.querySelector=selector=>selector==='.rt-controls'?controls:null;
  document.createRange=()=>range(text);
  document.queryCommandState=cmd=>cmd==='styleWithCSS'&&cssMode;
  document.execCommand=(cmd,unused,value)=>{commands.push({cmd,value,cssMode,start:selection.current?.startOffset,end:selection.current?.endOffset});if(cmd==='styleWithCSS')cssMode=value;return true;};
  const context={document,window:{getSelection:()=>selection,prompt:()=> 'https://example.org'},HL_COLORS:['#FBE28A','#B8E6C7','#F6C6D9','#BFE0F5','#DCC8F0','#F5C99A'],esc:String,svgIcon:()=>'<svg></svg>',I_UNDO:'',I_REDO:'',I_MARKER:'',I_LINK:'',I_ERASE:'',captureComposerDraft:()=>drafts++,showToast:(...args)=>toasts.push(args)};
  vm.createContext(context);vm.runInContext(source,context);
  function mount(){
    controls=new Element();
    for(const kind of ['text','highlight']){
      controls.append(new Element('button',{'data-rt-apply':kind}));
      controls.append(new Element('button',{'data-rt-palette':kind,'aria-expanded':'false'}));
      const palette=controls.append(new Element('div',{'data-rt-color-panel':kind}));palette.hidden=true;
      for(const option of context.rtColorOptions(kind))palette.append(new Element('button',{'data-rt-color-kind':kind,'data-rt-color':option.value}));
    }
    for(const cmd of ['bold','italic','underline','strike','ol','ul','quote','code','clear','undo','redo','fontsize','link'])controls.append(new Element('button',{'data-rt-cmd':cmd}));
    context.bindRichTextToolbar(editor);
    return controls;
  }
  function select(start,end){selection.removeAllRanges();selection.addRange(range(text,start,end));document.fire('selectionchange');}
  function click(selector){const target=controls.querySelector(selector);assert.ok(target,selector);controls.fire('pointerdown',{target});document.fire('pointerdown',{target});controls.fire('click',{target});return target;}
  mount();
  return {context,document,editor,selection,text,outside,commands,toasts,select,click,mount,get controls(){return controls;},get drafts(){return drafts;},get cssMode(){return cssMode;}};
}

test('choosing a color changes its remembered icon and palette only, without editing or saving the draft',()=>{
  const h=harness();h.select(4,10);
  h.click('[data-rt-palette="text"]');
  assert.equal(h.controls.querySelector('[data-rt-color-panel="text"]').hidden,false);
  h.click('[data-rt-color="#2D6694"]');
  assert.equal(h.context.RT_SELECTED_COLORS.text,'#2D6694');
  assert.equal(h.controls.querySelector('[data-rt-apply="text"]').styles['--rt-color'],'#2D6694');
  assert.equal(h.controls.querySelector('[data-rt-color="#2D6694"]').getAttribute('aria-pressed'),'true');
  assert.equal(h.controls.querySelector('[data-rt-color-panel="text"]').hidden,true);
  assert.equal(h.commands.length,0);assert.equal(h.drafts,0);
  h.mount();
  assert.equal(h.controls.querySelector('[data-rt-apply="text"]').styles['--rt-color'],'#2D6694');
});

test('main text-color button restores a blurred selection and uses CSS colors accepted by stored HTML',()=>{
  const h=harness();h.select(3,9);h.click('[data-rt-palette="text"]');h.click('[data-rt-color="#7755A0"]');
  h.selection.removeAllRanges();h.selection.addRange(range(h.outside));
  h.click('[data-rt-apply="text"]');
  const call=h.commands.find(c=>c.cmd==='foreColor');
  assert.deepEqual(call,{cmd:'foreColor',value:'#7755A0',cssMode:true,start:3,end:9});
  assert.equal(h.cssMode,false,'preserve the editor’s previous command mode');
  assert.equal(h.drafts,1,'the formatted content is handed to the existing encrypted draft flow');
  assert.equal(h.controls.querySelector('[data-rt-color-panel="text"]').hidden,true);
});

test('highlight and text colors are independent; repeated main clicks apply rather than erase the highlight',()=>{
  const h=harness();h.select(1,7);h.click('[data-rt-palette="highlight"]');h.click('[data-rt-color="#B8E6C7"]');
  assert.equal(h.commands.length,0);
  h.click('[data-rt-apply="highlight"]');h.click('[data-rt-apply="highlight"]');
  assert.deepEqual(h.commands.filter(c=>c.cmd==='hiliteColor').map(c=>c.value),['#B8E6C7','#B8E6C7']);
  assert.equal(h.context.RT_SELECTED_COLORS.text,'#262319');
  assert.equal(h.controls.querySelector('[data-rt-apply="highlight"]').styles['--rt-color'],'#B8E6C7');
});

test('color buttons with no selected text do not alter content or an encrypted draft',()=>{
  const h=harness();h.select(5,5);h.click('[data-rt-apply="text"]');
  assert.equal(h.commands.length,0);assert.equal(h.drafts,0);assert.match(h.toasts[0][0],/먼저 선택/);
});

test('outside pointer and Escape close the palette; rerender and leaving the editor remove document listeners',()=>{
  const h=harness();h.select(2,6);h.click('[data-rt-palette="highlight"]');
  h.document.fire('pointerdown',{target:h.outside});
  assert.equal(h.controls.querySelector('[data-rt-color-panel="highlight"]').hidden,true);
  h.click('[data-rt-palette="text"]');
  const event=h.document.fire('keydown',{key:'Escape'});
  assert.equal(event.defaultPrevented,true);
  assert.equal(h.controls.querySelector('[data-rt-palette="text"]').focused,true);
  assert.equal(h.controls.querySelector('[data-rt-palette="text"]').getAttribute('aria-expanded'),'false');
  h.mount();assert.equal(h.document.events.selectionchange.length,1);assert.equal(h.document.events.pointerdown.length,1);
  h.context.bindRichTextToolbar(null);
  for(const type of ['selectionchange','pointerdown','keydown'])assert.equal(h.document.events[type].length,0,type);
});

test('existing formatting, undo/redo and link commands still act on the retained range',()=>{
  const h=harness();h.select(4,8);
  for(const cmd of ['bold','italic','underline','strike','ol','ul','quote','code','clear','undo','redo','fontsize','link'])h.click('[data-rt-cmd="'+cmd+'"]');
  assert.deepEqual(h.commands.map(c=>c.cmd),['bold','italic','underline','strikeThrough','insertOrderedList','insertUnorderedList','formatBlock','formatBlock','removeFormat','undo','redo','fontSize','createLink']);
  assert.ok(h.commands.every(c=>c.start===4&&c.end===8));
});

test('generated toolbar has distinct apply/palette buttons and keeps all existing formatting controls',()=>{
  const h=harness(),markup=h.context.rtToolbarHtml();
  for(const kind of ['text','highlight']){
    assert.equal((markup.match(new RegExp('data-rt-apply="'+kind+'"','g'))||[]).length,1);
    assert.equal((markup.match(new RegExp('data-rt-palette="'+kind+'"','g'))||[]).length,1);
    assert.match(markup,new RegExp('id="rt-'+kind+'-palette"[^>]*hidden'));
  }
  for(const cmd of ['undo','redo','bold','italic','underline','strike','fontsize','ol','ul','quote','code','link','clear'])assert.ok(markup.includes('data-rt-cmd="'+cmd+'"'),cmd);
});
