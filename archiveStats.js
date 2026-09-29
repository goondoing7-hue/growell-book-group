(function(root,factory){
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellArchiveStats=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var dialog=null,context=null,signature='';
  var STAT_KINDS=['total','monthCompleted','reading','yearCompleted'],THEME_KINDS=['emotion','thought','body','action'];
  var LABELS={total:'총 등록한 책',monthCompleted:'이번 달 완독한 책',reading:'읽는 중인 책',yearCompleted:'올해 완독한 책',emotion:'감정 · 누적 완독한 책',thought:'생각 · 누적 완독한 책',body:'신체 · 누적 완독한 책',action:'행동 · 누적 완독한 책'};
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function validDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.slice(0,4)==='0000')return false;var parsed=new Date(value+'T00:00:00Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;}
  function today(reference){if(validDate(reference))return reference;var now=reference instanceof Date&&Number.isFinite(reference.getTime())?reference:new Date();return String(now.getFullYear()).padStart(4,'0')+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');}
  function matchingRows(rows,kind,reference,ownerId){
    if(!Object.prototype.hasOwnProperty.call(LABELS,kind))return [];
    var seen=new Set(),date=today(reference);
    return (Array.isArray(rows)?rows:[]).filter(function(row){
      if(!row||!row.entry||typeof row.entry.id!=='string'||!row.book||row.book.deleted||ownerId!==undefined&&row.entry.userId!==ownerId||seen.has(row.entry.id))return false;
      seen.add(row.entry.id);var b=row.book;
      if(kind==='total')return true;if(kind==='reading')return b.status==='reading';
      if(THEME_KINDS.indexOf(kind)>=0)return b.status==='completed'&&Array.isArray(b.themes)&&b.themes.indexOf(kind)>=0;
      return b.status==='completed'&&validDate(b.endDate)&&b.endDate.slice(0,kind==='monthCompleted'?7:4)===date.slice(0,kind==='monthCompleted'?7:4);
    });
  }
  function summary(rows,reference,ownerId){var result={};STAT_KINDS.forEach(function(kind){result[kind]=matchingRows(rows,kind,reference,ownerId).length;});return result;}
  function themeSummary(rows,ownerId){var result={};THEME_KINDS.forEach(function(kind){result[kind]=matchingRows(rows,kind,undefined,ownerId).length;});return result;}
  function current(){return !!(dialog&&context&&context.getOwnerId()===context.ownerId&&(!context.isCurrent||context.isCurrent()));}
  function listed(){return matchingRows(context.rows,context.kind,context.now,context.ownerId);}
  function cover(book){var domain=root.GrowellArchiveDomain,url=domain&&domain.safeCoverUrl?domain.safeCoverUrl(book.coverUrl):'',badges=domain&&domain.themeBadgesHtml?domain.themeBadgesHtml(book.themes):'';return '<span class="archive-stats-cover">'+(url?'<img src="'+esc(url)+'" alt="" loading="lazy" referrerpolicy="no-referrer">':'<span class="archive-stats-cover-empty" aria-hidden="true">'+esc(book.title||'나의 책')+'</span>')+badges+'</span>';}
  function paint(){
    if(!current()){close(false);return;}
    var node=dialog,activeContext=context,items=listed(),next=JSON.stringify(items.map(function(row){return [row.entry.id,row.book.title,row.book.coverUrl,row.book.themes];}));if(signature===next)return;signature=next;
    var body=node.querySelector('[data-stats-body]'),scroll=node.scrollTop,bodyScroll=body.scrollTop,retained=new Map();
    node.querySelectorAll('[data-stats-book]').forEach(function(button){retained.set(button.dataset.statsBook,button);});
    body.innerHTML=items.length?'<div class="archive-stats-books">'+items.map(function(row){return '<button type="button" data-stats-book="'+esc(row.entry.id)+'" aria-haspopup="dialog">'+cover(row.book)+'<strong>'+esc(row.book.title||'나의 책')+'</strong></button>';}).join('')+'</div>':'<p class="archive-stats-empty">아직 해당하는 책이 없어요.</p>';
    node.querySelectorAll('[data-stats-book]').forEach(function(button){
      var old=retained.get(button.dataset.statsBook);if(old){old.innerHTML=button.innerHTML;button.replaceWith(old);button=old;}
      button.onclick=function(){if(dialog!==node||context!==activeContext)return;if(!current())return close(false);var id=button.dataset.statsBook;if(!listed().some(function(row){return row.entry.id===id;}))return;context.onSelect(id,button);};
    });
    node.querySelectorAll('.archive-stats-cover img').forEach(function(img){img.onerror=function(){img.remove();};});
    node.scrollTop=scroll;body.scrollTop=bodyScroll;
  }
  function close(restore){
    var node=dialog,old=context;dialog=null;context=null;signature='';
    if(node){node.close();node.remove();if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed('archive-stats');}
    if(restore!==false&&old&&old.getOwnerId()===old.ownerId&&(!old.isCurrent||old.isCurrent())){var target=old.getTrigger?old.getTrigger(old.kind):old.trigger;if(target&&target.isConnected)target.focus({preventScroll:true});}
  }
  function open(options){
    if(!options||!Object.prototype.hasOwnProperty.call(LABELS,options.kind)||!options.ownerId||typeof options.getOwnerId!=='function'||typeof options.onSelect!=='function'||options.getOwnerId()!==options.ownerId||options.isCurrent&&!options.isCurrent()||!root.document)return;
    close(false);context=Object.assign({},options);context.now=today(options.now);context.rows=options.rows||[];
    var node=root.document.createElement('dialog');dialog=node;node.className='archive-stats-dialog';node.setAttribute('aria-labelledby','archive-stats-title');
    node.innerHTML='<header class="archive-dialog-head"><h2 id="archive-stats-title">'+esc(context.title||LABELS[context.kind])+'</h2><button type="button" class="icon-btn" data-stats-close aria-label="책 목록 닫기"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="archive-stats-body" data-stats-body></div>';
    root.document.body.appendChild(node);node.querySelector('[data-stats-close]').onclick=function(){close();};node.addEventListener('cancel',function(event){event.preventDefault();close();});paint();
    if(dialog!==node)return;node.showModal();if(root.GrowellPopupHistory)root.GrowellPopupHistory.open('archive-stats',{close:function(){close();}});
  }
  function refresh(rows){if(!dialog)return;if(!current())return close(false);if(Array.isArray(rows))context.rows=rows;paint();}
  function reset(){close(false);}
  return {matchingRows:matchingRows,summary:summary,themeSummary:themeSummary,open:open,close:close,reset:reset,refresh:refresh};
});
