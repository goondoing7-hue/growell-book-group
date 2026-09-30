(function(root,factory){
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellHabitGuide=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var mounted=new WeakMap();
  var closeIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  var backIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>';
  var arrowIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6"/></svg>';
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(char){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char];});}
  function paragraphs(value){return String(value||'').split(/\n\s*\n/).filter(function(text){return text.trim();}).map(function(text){return '<p>'+esc(text.trim())+'</p>';}).join('');}

  function mount(dialog,options){
    if(!dialog||typeof dialog.querySelector!=='function'||typeof dialog.addEventListener!=='function')return function(){};
    var previous=mounted.get(dialog);if(previous)previous();
    options=options||{};
    var source=root.GrowellHabitSuggestions;
    var values=source&&typeof source.categories==='function'?source.categories():[];
    var guide=source&&typeof source.guide==='function'?source.guide():{};
    var kind=options.kind==='avoid'?'avoid':'do';
    var active=true,chapter='',practiceIndex=0;
    function current(){return active&&(typeof options.isCurrent!=='function'||options.isCurrent());}
    function byId(id){return values.filter(function(value){return value.id===id;})[0]||null;}
    function examples(value){
      var allowed=source&&typeof source.suggestions==='function'?source.suggestions(kind,value.id):[];
      return allowed.map(function(keyword){return (value.examples||[]).filter(function(example){return example.keyword===keyword;})[0];}).filter(function(example){return example&&typeof example.action==='string'&&(kind!=='avoid'||example.keyword!=='독서');});
    }
    if(byId(options.valueId))chapter=options.valueId;
    if(dialog.classList&&typeof dialog.classList.add==='function')dialog.classList.add('habit-guide-reader');
    else if((' '+(dialog.className||'')+' ').indexOf(' habit-guide-reader ')<0)dialog.className=(dialog.className?dialog.className+' ':'')+'habit-guide-reader';
    if(typeof dialog.setAttribute==='function')dialog.setAttribute('aria-labelledby','habit-value-guide-title');

    function header(){
      return '<header class="hg-header"><div class="hg-header-start">'+(chapter?'<button type="button" class="hg-back" data-habit-value-page="intro" aria-label="가이드 처음으로">'+backIcon+'<span>처음으로</span></button>':'<span class="hg-header-mark" aria-hidden="true">G</span>')+'<h2 id="habit-value-guide-title">가치 가이드</h2></div><button type="button" class="hg-close" id="habit-value-guide-close" aria-label="가치 습관 가이드 닫기">'+closeIcon+'</button></header>';
    }
    function introHtml(){
      return '<article class="hg-view hg-intro" data-habit-value-guide-content><div class="hg-intro-meta"><span class="hg-eyebrow">GROWELL HABIT GUIDE</span><span class="hg-folio">INTRO / 07</span></div><h3 class="hg-intro-title" tabindex="-1" data-hg-heading>좋은 습관은<br><span>좋은 방향에서</span></h3><p class="hg-intro-lead">'+esc(guide.lead||guide.intro||'')+'</p><nav class="hg-seven" aria-label="일곱 가치 둘러보기">'+values.map(function(value,index){return '<button type="button" data-habit-value-jump="'+esc(value.id)+'" style="--hg-index:'+index+'" aria-label="'+esc(value.label+' '+value.meaning+' 가이드')+'"><span>'+esc(value.label)+'</span><small>'+esc(value.hanja)+'</small></button>';}).join('')+'</nav><details class="hg-why"><summary>'+esc(guide.whyTitle||'왜 일곱 가지 가치일까요?')+'</summary><div class="hg-why-body">'+paragraphs(guide.whyBody||guide.why)+'</div></details><ol class="hg-steps">'+(guide.steps||[]).slice(0,3).map(function(step,index){return '<li><span class="hg-step-number">0'+(index+1)+'</span><h4>'+esc(step.title)+'</h4><p>'+esc(step.text)+'</p></li>';}).join('')+'</ol>'+(values.length?'<button type="button" class="hg-primary hg-intro-cta" data-habit-value-jump="'+esc(values[0].id)+'">일곱 가치 천천히 읽기'+arrowIcon+'</button>':'')+'</article>';
    }
    function actionHtml(example){return example?'<span class="hg-quote" aria-hidden="true">“</span><p>'+esc(example.action)+'</p>':'<p>아직 선택할 실천이 없어요.</p>';}
    function chapterHtml(){
      var value=byId(chapter),index=values.indexOf(value),items=examples(value);
      if(practiceIndex>=items.length)practiceIndex=0;
      return '<article class="hg-view hg-chapter" data-habit-value-guide-content><nav class="hg-value-tabs" role="tablist" aria-label="일곱 가치 가이드">'+values.map(function(item){var selected=item.id===chapter;return '<button type="button" role="tab" id="habit-guide-value-'+esc(item.id)+'" data-habit-value-page="'+esc(item.id)+'" data-value="'+esc(item.id)+'" aria-label="'+esc(item.label+' '+item.meaning)+'" aria-selected="'+selected+'" aria-controls="habit-guide-chapter-panel" tabindex="'+(selected?'0':'-1')+'"><b>'+esc(item.label)+'</b><small>'+esc(item.hanja)+'</small></button>';}).join('')+'</nav><div id="habit-guide-chapter-panel" role="tabpanel" aria-labelledby="habit-guide-value-'+esc(chapter)+'"><div class="hg-chapter-head"><div class="hg-chapter-mark" aria-hidden="true">'+esc(value.label)+'<small>'+esc(value.hanja)+'</small></div><div class="hg-chapter-caption"><span class="hg-eyebrow">VALUE 0'+(index+1)+' / 07</span><p>'+esc(value.meaning||value.title)+'</p></div></div><h3 class="hg-chapter-title" tabindex="-1" data-hg-heading>'+esc(value.headline||value.title)+'</h3><p class="hg-chapter-lead">'+esc(value.lead||value.summary)+'</p><section class="hg-practice" aria-labelledby="habit-guide-practice-title"><div class="hg-practice-heading"><h4 id="habit-guide-practice-title">오늘의 작은 실천</h4><span>단어를 눌러 살펴보세요</span></div><div class="hg-practice-tabs" role="tablist" aria-label="'+esc(value.label)+' 가치 실천 예시">'+items.map(function(item,i){return '<button type="button" role="tab" id="habit-guide-practice-'+i+'" data-habit-guide-practice="'+i+'" aria-selected="'+(i===practiceIndex)+'" aria-controls="habit-guide-action" tabindex="'+(i===practiceIndex?'0':'-1')+'">'+esc(item.keyword)+'</button>';}).join('')+'</div><div class="hg-action" id="habit-guide-action" role="tabpanel"'+(items.length?' aria-labelledby="habit-guide-practice-'+practiceIndex+'"':'')+' aria-live="polite" aria-atomic="true">'+actionHtml(items[practiceIndex])+'</div></section><p class="hg-question"><span>잠깐, 나에게 묻기</span>'+esc(value.question||value.reflection)+'</p><button type="button" class="hg-primary hg-start" data-habit-guide-choose'+(items.length?'':' disabled')+'>이 습관으로 시작하기</button></div></article>';
    }
    function focus(selector){var target=dialog.querySelector(selector);if(target&&typeof target.focus==='function')target.focus({preventScroll:true});}
    function render(focusSelector){
      if(!current())return;
      dialog.innerHTML=header()+'<div class="hg-body">'+(chapter?chapterHtml():introHtml())+'</div>';
      if(focusSelector)focus(focusSelector);
    }
    function selectPage(id,focusTab){
      if(id!=='intro'&&!byId(id))return;
      chapter=id==='intro'?'':id;practiceIndex=0;
      render(focusTab?'#habit-guide-value-'+chapter:'[data-hg-heading]');
    }
    function selectPractice(index,focusTab){
      var value=byId(chapter);if(!value)return;
      var items=examples(value);if(!Number.isInteger(index)||index<0||index>=items.length)return;
      practiceIndex=index;
      var tabs=dialog.querySelectorAll('[data-habit-guide-practice]');
      Array.prototype.forEach.call(tabs,function(tab){var selected=Number(tab.getAttribute('data-habit-guide-practice'))===index;tab.setAttribute('aria-selected',String(selected));tab.setAttribute('tabindex',selected?'0':'-1');});
      var panel=dialog.querySelector('#habit-guide-action');
      if(panel){panel.innerHTML=actionHtml(items[index]);panel.setAttribute('aria-labelledby','habit-guide-practice-'+index);}
      if(focusTab){
        var target=dialog.querySelector('#habit-guide-practice-'+index);
        if(target&&typeof target.focus==='function')target.focus({preventScroll:true});
        if(target&&typeof target.scrollIntoView==='function')target.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      }
    }
    function eventButton(event){
      var target=event.target;
      while(target&&target!==dialog){
        if(String(target.tagName).toLowerCase()==='button')return typeof dialog.contains!=='function'||dialog.contains(target)?target:null;
        target=target.parentElement||target.parentNode;
      }
      return null;
    }
    function click(event){
      if(!current())return;
      var button=eventButton(event);if(!button||button.disabled)return;
      var page=button.getAttribute('data-habit-value-page'),jump=button.getAttribute('data-habit-value-jump'),practice=button.getAttribute('data-habit-guide-practice');
      if(button.getAttribute('id')==='habit-value-guide-close'){if(typeof options.onClose==='function')options.onClose();}
      else if(page!==null)selectPage(page,page!=='intro');
      else if(jump!==null)selectPage(jump,false);
      else if(practice!==null)selectPractice(Number(practice),false);
      else if(button.getAttribute('data-habit-guide-choose')!==null){
        var value=byId(chapter),example=value&&examples(value)[practiceIndex];
        if(example&&typeof options.onChoose==='function')options.onChoose(value.id,example.keyword);
      }
    }
    function keydown(event){
      if(!current()||event.altKey||event.ctrlKey||event.metaKey)return;
      var keys=['ArrowLeft','ArrowRight','Home','End'];if(keys.indexOf(event.key)<0)return;
      var button=eventButton(event);if(!button)return;
      var page=button.getAttribute('data-habit-value-page'),practice=button.getAttribute('data-habit-guide-practice'),items,index;
      if(page!==null&&page!=='intro'){items=values;index=values.findIndex(function(value){return value.id===page;});}
      else if(practice!==null&&byId(chapter)){items=examples(byId(chapter));index=Number(practice);}
      else return;
      if(!items.length||index<0)return;
      event.preventDefault();
      var next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowRight'?1:-1)+items.length)%items.length;
      if(practice!==null)selectPractice(next,true);else selectPage(items[next].id,true);
    }
    function cleanup(){
      if(!active)return;active=false;
      if(typeof dialog.removeEventListener==='function'){dialog.removeEventListener('click',click);dialog.removeEventListener('keydown',keydown);}
      if(mounted.get(dialog)===cleanup)mounted.delete(dialog);
    }
    dialog.addEventListener('click',click);dialog.addEventListener('keydown',keydown);
    mounted.set(dialog,cleanup);render();
    return cleanup;
  }
  return {mount:mount};
});
