const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const suggestions=require('../habitSuggestions.js');
const source=fs.readFileSync(path.join(__dirname,'../habitGuide.js'),'utf8');

function harness(data=suggestions){
  const document={activeElement:null};
  const decode=value=>String(value).replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
  function matches(node,selector){
    if(selector[0]==='#')return node.getAttribute('id')===selector.slice(1);
    if(selector[0]==='.')return (node.getAttribute('class')||'').split(/\s+/).includes(selector.slice(1));
    const attrs=[...selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
    if(attrs.length)return attrs.every(([,name,value])=>node.getAttribute(name)!==null&&(value===undefined||node.getAttribute(name)===value));
    return node.tagName===selector.toUpperCase();
  }
  class Element{
    constructor(tag,attrs={}){this.tagName=tag.toUpperCase();this.attrs={...attrs};this.children=[];this.parentNode=null;this.listeners={};this.html='';this.disabled=Object.hasOwn(attrs,'disabled');}
    get parentElement(){return this.parentNode;}
    get className(){return this.attrs.class||'';}
    set className(value){this.attrs.class=value;}
    getAttribute(name){return Object.hasOwn(this.attrs,name)?this.attrs[name]:null;}
    setAttribute(name,value){this.attrs[name]=String(value);}
    contains(node){return this===node||this.children.some(child=>child.contains(node));}
    all(){return this.children.flatMap(child=>[child,...child.all()]);}
    querySelector(selector){return this.all().find(node=>matches(node,selector))||null;}
    querySelectorAll(selector){return this.all().filter(node=>matches(node,selector));}
    addEventListener(name,fn){(this.listeners[name]||(this.listeners[name]=new Set())).add(fn);}
    removeEventListener(name,fn){this.listeners[name]?.delete(fn);}
    focus(options){assert.equal(options.preventScroll,true);document.activeElement=this;}
    scrollIntoView(options){this.scrolled=options;}
    emit(name,values={}){const event={target:this,preventDefault(){this.defaultPrevented=true;},...values};for(let node=this;node;node=node.parentNode){for(const fn of node.listeners[name]||[])fn(event);}return event;}
    click(){if(!this.disabled)this.emit('click');}
    get textContent(){return decode(this.html.replace(/<[^>]+>/g,''));}
    get innerHTML(){return this.html;}
    set innerHTML(html){
      this.html=html;this.children=[];const stack=[this];
      for(const match of html.matchAll(/<\/?[a-z][^>]*>/gi)){
        const token=match[0];
        if(token.startsWith('</')){if(stack.length>1)stack.pop();continue;}
        const [,tag,raw]=token.match(/^<([a-z0-9-]+)([\s\S]*?)\/?\s*>$/i),attrs={};
        for(const [,name,quoted,single] of raw.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g))attrs[name]=decode(quoted??single??'');
        const child=new Element(tag,attrs),parent=stack[stack.length-1];parent.children.push(child);child.parentNode=parent;
        if(!['br','input','img','hr','meta','link'].includes(tag.toLowerCase())){
          const end=html.indexOf('</'+tag,match.index+token.length);child.html=end<0?'':html.slice(match.index+token.length,end);stack.push(child);
        }
      }
    }
  }
  const dialog=new Element('dialog',{class:'habit-value-guide'});
  let opens=0,closes=0,removes=0;
  dialog.showModal=()=>opens++;dialog.close=()=>closes++;dialog.remove=()=>removes++;
  const context={GrowellHabitSuggestions:data,document};vm.createContext(context);vm.runInContext(source,context);
  return {dialog,document,api:context.GrowellHabitGuide,get lifecycle(){return {opens,closes,removes};}};
}

test('guide introduction renders seven values, three steps and expandable multi-paragraph rationale without owning the dialog lifecycle',()=>{
  const h=harness();let closed=0;h.api.mount(h.dialog,{onClose:()=>closed++});
  assert.match(h.dialog.innerHTML,/좋은 습관은<br><span>좋은 방향에서/);
  assert.equal(h.dialog.querySelector('.hg-why-body').querySelectorAll('p').length,3);
  assert.equal(h.dialog.querySelector('.hg-seven').querySelectorAll('button').length,7);
  assert.equal(h.dialog.querySelector('.hg-steps').querySelectorAll('li').length,3);
  assert.equal(h.dialog.querySelector('.hg-why').getAttribute('open'),null);
  assert.doesNotMatch(h.dialog.innerHTML,/모두 해내기보다|왜 습관으로|chapter-prev|chapter-next/);
  assert.equal(h.dialog.getAttribute('aria-labelledby'),'habit-value-guide-title');
  h.dialog.querySelector('#habit-value-guide-close').querySelector('path').click();
  assert.equal(closed,1);assert.deepEqual(h.lifecycle,{opens:0,closes:0,removes:0});
});

test('one practice is visible at a time and choosing forwards the selected value and exact allowed keyword',()=>{
  const h=harness(),choices=[];h.api.mount(h.dialog,{valueId:'wisdom',kind:'do',onChoose:(...args)=>choices.push(args)});
  const practice=h.dialog.querySelectorAll('[data-habit-guide-practice]');
  assert.deepEqual(practice.map(tab=>tab.textContent),suggestions.suggestions('do','wisdom'));
  const value=suggestions.categories().find(value=>value.id==='wisdom');
  assert.ok(h.dialog.querySelector('#habit-guide-action').textContent.includes(value.examples[0].action));
  const last=practice.at(-1);last.focus({preventScroll:true});last.click();
  assert.equal(h.dialog.querySelectorAll('[data-habit-guide-practice]').at(-1),last,'keyword click keeps the same focused control');
  assert.equal(last.getAttribute('aria-selected'),'true');
  assert.equal(practice[0].getAttribute('aria-selected'),'false');
  assert.equal(h.dialog.querySelector('#habit-guide-action').getAttribute('aria-labelledby'),last.getAttribute('id'));
  assert.ok(h.dialog.querySelector('#habit-guide-action').textContent.includes(value.examples.at(-1).action));
  assert.ok(!h.dialog.querySelector('#habit-guide-action').textContent.includes(value.examples[0].action));
  h.dialog.querySelector('[data-habit-guide-choose]').click();
  assert.deepEqual(choices,[['wisdom',last.textContent]]);
  assert.equal(h.document.activeElement,last);assert.deepEqual(h.lifecycle,{opens:0,closes:0,removes:0});
});

test('avoid mode excludes reading from both the practice tabs and chosen habit',()=>{
  const h=harness(),choices=[];h.api.mount(h.dialog,{valueId:'wisdom',kind:'avoid',onChoose:(...args)=>choices.push(args)});
  const tabs=h.dialog.querySelectorAll('[data-habit-guide-practice]');
  assert.deepEqual(tabs.map(tab=>tab.textContent),suggestions.suggestions('avoid','wisdom'));
  assert.ok(!tabs.some(tab=>tab.textContent==='독서'));
  for(const tab of tabs){tab.click();h.dialog.querySelector('[data-habit-guide-choose]').click();}
  assert.deepEqual(choices.map(choice=>choice[1]),suggestions.suggestions('avoid','wisdom'));
  const before=choices.length;tabs[0].setAttribute('data-habit-guide-practice','99');tabs[0].click();
  h.dialog.querySelector('[data-habit-guide-choose]').click();
  assert.equal(choices.length,before+1);assert.equal(choices.at(-1)[1],tabs.at(-1).textContent,'invalid index cannot change the current selection');
});

test('chapter and practice keyboard tabs update the visible panel with focus and roving tabindex preserved',()=>{
  const h=harness();h.api.mount(h.dialog,{valueId:'wisdom'});
  const event=h.dialog.querySelector('[data-habit-value-page="wisdom"]').emit('keydown',{key:'ArrowRight'});
  assert.equal(event.defaultPrevented,true);
  const emotion=h.dialog.querySelector('[data-habit-value-page="emotion"]');
  assert.equal(h.document.activeElement,emotion);assert.equal(emotion.getAttribute('tabindex'),'0');
  assert.equal(h.dialog.querySelector('#habit-guide-chapter-panel').getAttribute('aria-labelledby'),emotion.getAttribute('id'));
  assert.equal(h.dialog.querySelector('[data-habit-value-page="wisdom"]').getAttribute('tabindex'),'-1');
  h.dialog.querySelector('[data-habit-guide-practice="0"]').emit('keydown',{key:'End'});
  const last=h.dialog.querySelectorAll('[data-habit-guide-practice]').at(-1);
  assert.equal(h.document.activeElement,last);assert.equal(last.getAttribute('aria-selected'),'true');
  assert.equal(last.scrolled.inline,'nearest');
  last.emit('keydown',{key:'ArrowRight'});assert.equal(h.document.activeElement,h.dialog.querySelector('[data-habit-guide-practice="0"]'));
  const before=h.dialog.innerHTML;h.document.activeElement.emit('keydown',{key:'ArrowDown'});assert.equal(h.dialog.innerHTML,before);
  h.dialog.querySelector('[data-habit-value-page="intro"]').click();
  assert.ok(h.dialog.querySelector('.hg-intro'));assert.equal(h.document.activeElement,h.dialog.querySelector('[data-hg-heading]'));
  h.dialog.querySelector('[data-habit-value-jump="body"]').click();
  assert.equal(h.dialog.querySelector('[data-habit-value-page="body"]').getAttribute('aria-selected'),'true');
  assert.equal(h.document.activeElement,h.dialog.querySelector('[data-hg-heading]'));
});

test('stale sessions and cleaned-up mounts ignore close, choice and navigation events',()=>{
  const h=harness();let valid=true,closed=0,chosen=0;
  const cleanup=h.api.mount(h.dialog,{valueId:'love',isCurrent:()=>valid,onClose:()=>closed++,onChoose:()=>chosen++});
  valid=false;const html=h.dialog.innerHTML;
  h.dialog.querySelector('[data-habit-value-page="intro"]').click();
  h.dialog.querySelector('[data-habit-value-page="love"]').emit('keydown',{key:'ArrowRight'});
  h.dialog.querySelector('[data-habit-guide-choose]').click();h.dialog.querySelector('#habit-value-guide-close').click();
  assert.equal(h.dialog.innerHTML,html);assert.equal(chosen,0);assert.equal(closed,0);
  cleanup();cleanup();valid=true;h.dialog.querySelector('#habit-value-guide-close').click();
  assert.equal(closed,0);assert.equal(h.dialog.listeners.click.size,0);assert.equal(h.dialog.listeners.keydown.size,0);
});

test('remount on the same element removes previous listeners and leaves Escape to the parent',()=>{
  const h=harness();let old=0,current=0;
  const oldCleanup=h.api.mount(h.dialog,{onClose:()=>old++});
  h.api.mount(h.dialog,{valueId:'body',onClose:()=>current++});oldCleanup();
  assert.equal(h.dialog.listeners.click.size,1);assert.equal(h.dialog.listeners.keydown.size,1);
  const escape=h.dialog.querySelector('#habit-value-guide-close').emit('keydown',{key:'Escape'});
  assert.equal(escape.defaultPrevented,undefined);assert.equal(current,0);
  h.dialog.querySelector('#habit-value-guide-close').click();assert.equal(old,0);assert.equal(current,1);
});

test('metadata is escaped and unmapped suggestion keywords cannot become a selectable practice',()=>{
  const values=suggestions.categories();values[0].headline='<img src=x onerror="bad()">';values[0].examples[0].action='<script>bad()</script>';
  const h=harness({categories:()=>values,guide:()=>({whyBody:'<iframe>bad()</iframe>\n\nsecond',steps:[]}),suggestions:()=>['unknown','기도']});
  h.api.mount(h.dialog,{valueId:'faith'});
  assert.equal(h.dialog.querySelectorAll('img').length,0);assert.equal(h.dialog.querySelectorAll('script').length,0);
  assert.match(h.dialog.querySelector('.hg-chapter-title').innerHTML,/&lt;img/);
  assert.match(h.dialog.querySelector('#habit-guide-action').innerHTML,/&lt;script&gt;/);
  assert.deepEqual(h.dialog.querySelectorAll('[data-habit-guide-practice]').map(tab=>tab.textContent),['기도']);
  h.dialog.querySelector('[data-habit-value-page="intro"]').click();
  assert.equal(h.dialog.querySelectorAll('iframe').length,0);assert.match(h.dialog.querySelector('.hg-why-body').innerHTML,/&lt;iframe&gt;/);
});
