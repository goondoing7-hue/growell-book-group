(function(root,factory){
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellArchiveCalendar=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var DAY=86400000,dialog=null,context=null,month=null,colors=new Map();
  var PALETTE=['#728c7a','#8c7b99','#6d879b','#a48268','#9e777c','#8a8c62'];
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function day(value){
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.slice(0,4)==='0000')return null;
    var parsed=new Date(value+'T00:00:00Z');
    return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value?Math.floor(parsed.getTime()/DAY):null;
  }
  function today(value){
    if(typeof value==='string'&&day(value)!==null)return value;
    var date=value instanceof Date?value:new Date();
    if(!Number.isFinite(date.getTime()))date=new Date();
    return String(date.getFullYear()).padStart(4,'0')+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
  }
  function dateOf(value){return new Date(value*DAY).toISOString().split('T')[0];}
  function monthStart(year,monthNumber){return day(String(year).padStart(4,'0')+'-'+String(monthNumber).padStart(2,'0')+'-01');}
  function nextMonth(year,monthNumber,step){var next=year*12+monthNumber-1+step;return {year:Math.floor(next/12),month:next%12+1};}
  function validRows(rows){
    var ids=new Set();return (Array.isArray(rows)?rows:[]).filter(function(row){
      if(!row||!row.entry||typeof row.entry.id!=='string'||!row.book||row.book.deleted||ids.has(row.entry.id))return false;
      ids.add(row.entry.id);return true;
    });
  }
  function summary(rows,reference){
    var date=today(reference),year=date.slice(0,4),monthKey=date.slice(0,7),all=validRows(rows);
    var result={total:all.length,monthCompleted:0,reading:0,yearCompleted:0};
    all.forEach(function(row){var b=row.book;if(b.status==='reading')result.reading++;
      if(b.status!=='completed'||day(b.endDate)===null)return;
      if(b.endDate.slice(0,4)===year)result.yearCompleted++;
      if(b.endDate.slice(0,7)===monthKey)result.monthCompleted++;
    });return result;
  }
  function period(book,reference){
    if(book.status==='unread')return null;
    var start=day(book.startDate),end=day(book.endDate),current=day(today(reference)),openEnd=false,partial=false;
    if(start!==null&&end!==null&&end<start)return null;
    if(start===null&&end===null)return null;
    if(start===null){start=end;partial=true;}
    else if(end===null){
      if(book.status==='reading'&&current>=start){end=current;openEnd=true;}
      else{end=start;partial=true;}
    }
    return {start:start,end:end,openEnd:openEnd,partial:partial};
  }
  function layoutMonth(rows,year,monthNumber,reference){
    if(!Number.isInteger(year)||year<1||year>9999||!Number.isInteger(monthNumber)||monthNumber<1||monthNumber>12)throw new RangeError('달력을 표시할 날짜를 확인해주세요.');
    var first=monthStart(year,monthNumber),last=monthNumber===12&&year===9999?day('9999-12-31'):monthStart(nextMonth(year,monthNumber,1).year,nextMonth(year,monthNumber,1).month)-1;
    var offset=(new Date(first*DAY).getUTCDay()+6)%7,gridStart=first-offset,weeks=[],all=validRows(rows),dated=0;
    var periods=all.map(function(row){var span=period(row.book,reference);if(span)dated++;return span?{row:row,span:span}:null;}).filter(Boolean);
    for(var w=0;w<6;w++){
      var begin=gridStart+w*7,finish=begin+6,lanes=[],segments=[];
      periods.filter(function(item){return item.span.start<=Math.min(finish,last)&&item.span.end>=Math.max(begin,first);}).sort(function(a,b){return a.span.start-b.span.start||b.span.end-a.span.end||String(a.row.book.title).localeCompare(String(b.row.book.title),'ko');}).forEach(function(item){
        var start=Math.max(begin,first,item.span.start),end=Math.min(finish,last,item.span.end),startCol=start-begin,endCol=end-begin,lane=0;
        while(lanes[lane]!==undefined&&lanes[lane]>=startCol)lane++;
        lanes[lane]=endCol;
        segments.push({id:item.row.entry.id,title:String(item.row.book.title||'나의 책'),coverUrl:item.row.book.coverUrl||'',startCol:startCol,endCol:endCol,lane:lane,continuesBefore:item.span.start<start,continuesAfter:item.span.end>end,span:item.span,book:item.row.book});
      });
      weeks.push({days:Array.from({length:7},function(_,i){var value=begin+i;return {date:dateOf(value),number:new Date(value*DAY).getUTCDate(),inMonth:value>=first&&value<=last,today:dateOf(value)===today(reference)};}),segments:segments,lanes:Math.max(1,lanes.length)});
    }
    return {year:year,month:monthNumber,weeks:weeks,undated:all.filter(function(row){return row.book.status!=='unread';}).length-dated,summary:summary(all,String(year).padStart(4,'0')+'-'+String(monthNumber).padStart(2,'0')+'-01')};
  }
  function fallbackColor(key){var hash=0;for(var i=0;i<String(key).length;i++)hash=(Math.imul(hash,31)+String(key).charCodeAt(i))|0;return PALETTE[(hash>>>0)%PALETTE.length];}
  function colorFromPixels(pixels){
    var buckets=new Map();
    for(var i=0;i+3<pixels.length;i+=4){
      var r=pixels[i],g=pixels[i+1],b=pixels[i+2],max=Math.max(r,g,b),min=Math.min(r,g,b),light=(max+min)/2,saturation=max?((max-min)/max):0;
      if(pixels[i+3]<180||light>235||light<25||saturation<.1)continue;
      var key=(r>>5)+','+(g>>5)+','+(b>>5),bucket=buckets.get(key)||{r:0,g:0,b:0,n:0,weight:0};
      bucket.r+=r;bucket.g+=g;bucket.b+=b;bucket.n++;bucket.weight+=1+saturation*.5;buckets.set(key,bucket);
    }
    var best=null;buckets.forEach(function(bucket){if(!best||bucket.weight>best.weight)best=bucket;});
    if(!best)return null;
    return '#'+['r','g','b'].map(function(key){return Math.round(best[key]/best.n*.72+128*.28).toString(16).padStart(2,'0');}).join('');
  }
  function safeCover(value){var domain=root.GrowellArchiveDomain;return domain&&domain.safeCoverUrl?domain.safeCoverUrl(value):'';}
  function coverColor(segment){
    var url=safeCover(segment.coverUrl),fallback=fallbackColor(segment.id+'|'+segment.title);
    if(!url||!root.Image||!root.document)return Promise.resolve(fallback);
    if(colors.has(url))return colors.get(url);
    var promise=new Promise(function(resolve){
      var image=new root.Image(),settled=false,timer=root.setTimeout(function(){finish(fallback);},3000);
      function finish(color){if(settled)return;settled=true;root.clearTimeout(timer);image.onload=null;image.onerror=null;resolve(color||fallback);}
      image.crossOrigin='anonymous';image.referrerPolicy='no-referrer';
      image.onload=function(){try{var canvas=root.document.createElement('canvas');canvas.width=24;canvas.height=24;var ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)return finish(fallback);ctx.drawImage(image,0,0,24,24);finish(colorFromPixels(ctx.getImageData(0,0,24,24).data));}catch(e){finish(fallback);}};
      image.onerror=function(){finish(fallback);};image.src=url;
    });colors.set(url,promise);return promise;
  }
  function icon(name){var paths={close:'m6 6 12 12M18 6 6 18',left:'m15 5-7 7 7 7',right:'m9 5 7 7-7 7',calendar:'M8 2v4m8-4v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z'};return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+paths[name]+'"/></svg>';}
  function current(){return !!(dialog&&context&&context.getOwnerId()===context.ownerId&&(!context.isCurrent||context.isCurrent()));}
  function ownedRows(rows){return validRows(rows).filter(function(row){return row.entry.userId===context.ownerId;});}
  function spanLabel(segment){var b=segment.book;return (b.startDate||'시작일 미기록')+' ~ '+(b.endDate||(segment.span.openEnd?'읽는 중':'완독일 미기록'));}
  function bodyHtml(model){
    var s=model.summary,themeTotals=root.GrowellArchiveStats&&root.GrowellArchiveStats.themeSummary?root.GrowellArchiveStats.themeSummary(context.rows,context.ownerId):{emotion:0,thought:0,body:0,action:0};
    return '<div class="archive-calendar-month"><button type="button" class="icon-btn" data-calendar-shift="-1" aria-label="이전 달"'+(model.year===1&&model.month===1?' disabled':'')+'>'+icon('left')+'</button><h3 id="archive-calendar-month">'+model.year+'년 '+model.month+'월</h3><button type="button" class="icon-btn" data-calendar-shift="1" aria-label="다음 달"'+(model.year===9999&&model.month===12?' disabled':'')+'>'+icon('right')+'</button></div>'+
      '<div class="archive-calendar-statistics">'+[['monthCompleted',model.month+'월 완독'],['emotion','감정'],['thought','생각'],['body','신체'],['action','행동']].map(function(pair){var count=pair[0]==='monthCompleted'?s.monthCompleted:themeTotals[pair[0]];return '<button type="button" data-calendar-stat="'+pair[0]+'" aria-label="'+pair[1]+(pair[0]==='monthCompleted'?'':' 누적 완독')+' '+count+'권" aria-haspopup="dialog">'+pair[1]+'<strong>'+count+'<small>권</small></strong></button>';}).join('')+'</div><p class="archive-calendar-theme-help">주제별 권수는 전체 기간의 완독한 책을 세어요.</p>'+
      '<div class="archive-calendar-grid" role="group" aria-labelledby="archive-calendar-month"><div class="archive-calendar-weekdays">'+['월','화','수','목','금','토','일'].map(function(label){return '<span>'+label+'</span>';}).join('')+'</div>'+model.weeks.map(function(week){return '<div class="archive-calendar-week"><div class="archive-calendar-dates">'+week.days.map(function(d){return '<time datetime="'+d.date+'" class="'+(!d.inMonth?'is-outside ':'')+(d.today?'is-today':'')+'">'+d.number+'</time>';}).join('')+'</div><div class="archive-calendar-bars" style="grid-template-rows:repeat('+week.lanes+',24px)">'+week.segments.map(function(segment){return '<button type="button" class="archive-calendar-book'+(segment.continuesBefore?' continues-before':'')+(segment.continuesAfter?' continues-after':'')+'" data-calendar-book="'+esc(segment.id)+'" aria-haspopup="dialog" title="'+esc(segment.title+' · '+spanLabel(segment))+'" aria-label="'+esc(segment.title+' · '+spanLabel(segment)+' · 독서 기록 보기')+'" style="grid-column:'+(segment.startCol+1)+' / '+(segment.endCol+2)+';grid-row:'+(segment.lane+1)+';--calendar-book-color:'+fallbackColor(segment.id+'|'+segment.title)+'"><span>'+esc(segment.title)+'</span></button>';}).join('')+'</div></div>';}).join('')+'</div>'+
      '<p class="archive-calendar-help">책 이름을 누르면 독서 기록을 볼 수 있어요. 읽는 중인 책은 오늘까지 표시해요.</p>'+(model.undated?'<p class="archive-calendar-missing">읽기 날짜가 없는 '+model.undated+'권은 달력에 표시하지 않아요.</p>':'');
  }
  function paint(focusShift){
    if(!current()){close();return;}
    var node=dialog,activeContext=context,scroll=node.scrollTop,model=layoutMonth(context.rows,month.year,month.month,context.now),body=node.querySelector('[data-calendar-body]');
    body.innerHTML=bodyHtml(model);node.scrollTop=scroll;
    node.querySelectorAll('[data-calendar-shift]').forEach(function(button){button.onclick=function(){if(!current())return close();var step=Number(button.dataset.calendarShift),next=nextMonth(month.year,month.month,step);if(next.year<1||next.year>9999)return;month=next;paint(step);};});
    node.querySelectorAll('[data-calendar-book]').forEach(function(button){button.onclick=function(){if(!current())return close();var id=button.dataset.calendarBook;if(!context.rows.some(function(row){return row.entry.id===id&&!row.book.deleted;}))return;context.onSelect(id,button);};});
    node.querySelectorAll('[data-calendar-stat]').forEach(function(button){button.onclick=function(){
      if(!current())return close();if(!root.GrowellArchiveStats)return;var kind=button.dataset.calendarStat,reference=String(month.year).padStart(4,'0')+'-'+String(month.month).padStart(2,'0')+'-01';
      root.GrowellArchiveStats.open({kind:kind,title:kind==='monthCompleted'?month.year+'년 '+month.month+'월 완독한 책':'',rows:context.rows,now:reference,ownerId:context.ownerId,getOwnerId:context.getOwnerId,isCurrent:function(){return dialog===node&&context===activeContext&&current();},onSelect:function(id,trigger){if(current())context.onSelect(id,trigger);},trigger:button,getTrigger:function(key){return node.querySelector('[data-calendar-stat="'+key+'"]');}});
    };});
    if(focusShift!==undefined){var trigger=node.querySelector('[data-calendar-shift="'+focusShift+'"]');if(trigger)trigger.focus({preventScroll:true});}
    var seen=new Set();model.weeks.forEach(function(week){week.segments.forEach(function(segment){if(seen.has(segment.id))return;seen.add(segment.id);coverColor(segment).then(function(color){if(dialog!==node||context!==activeContext||!current()||!context.rows.some(function(row){return row.entry.id===segment.id&&(row.book.coverUrl||'')===segment.coverUrl;}))return;node.querySelectorAll('[data-calendar-book]').forEach(function(button){if(button.dataset.calendarBook===segment.id)button.style.setProperty('--calendar-book-color',color);});});});});
  }
  function close(){
    var node=dialog,old=context;dialog=null;context=null;month=null;
    if(node){node.close();node.remove();}
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed('archive-calendar');
    if(root.GrowellArchiveStats)root.GrowellArchiveStats.refresh();
    if(old&&old.getOwnerId()===old.ownerId&&(!old.isCurrent||old.isCurrent())&&old.trigger&&old.trigger.isConnected)old.trigger.focus({preventScroll:true});
  }
  function reset(){close();colors.clear();}
  function open(options){
    if(!options||!options.ownerId||typeof options.getOwnerId!=='function'||options.getOwnerId()!==options.ownerId||options.isCurrent&&!options.isCurrent()||!root.document)return;
    close();context=Object.assign({},options);context.rows=ownedRows(options.rows);context.now=today(options.now);var date=context.now.split('-');month={year:Number(date[0]),month:Number(date[1])};
    var node=root.document.createElement('dialog');dialog=node;node.className='archive-calendar-dialog';node.setAttribute('aria-labelledby','archive-calendar-title');
    node.innerHTML='<header class="archive-calendar-header"><h2 id="archive-calendar-title">'+icon('calendar')+'독서 달력</h2><button type="button" class="icon-btn" data-calendar-close aria-label="독서 달력 닫기">'+icon('close')+'</button></header><div class="archive-calendar-body" data-calendar-body></div>';
    root.document.body.appendChild(node);node.querySelector('[data-calendar-close]').onclick=close;node.addEventListener('cancel',function(event){event.preventDefault();close();});paint();
    if(dialog!==node)return;node.showModal();if(root.GrowellPopupHistory)root.GrowellPopupHistory.open('archive-calendar',{close:close});
  }
  function refresh(rows){if(!dialog)return;if(!current())return reset();context.rows=ownedRows(rows);paint();}
  return {summary:summary,layoutMonth:layoutMonth,fallbackColor:fallbackColor,colorFromPixels:colorFromPixels,open:open,close:close,reset:reset,refresh:refresh};
});
