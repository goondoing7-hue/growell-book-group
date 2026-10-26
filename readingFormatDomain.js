(function(root,factory){
  'use strict';
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellReadingFormatDomain=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function object(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
  function clean(value,limit){return typeof value==='string'?Array.from(value.trim()).slice(0,limit).join(''):'';}
  function normalizeFormat(value){return value==='ebook'?'ebook':'paper';}
  function percent(value){return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100?Math.round(value*10)/10:null;}
  function normalizeSettings(value){
    var source=object(value)?value:{},raw=object(source.ebook)?source.ebook:{},progress=percent(raw.progressPercent);
    return {format:normalizeFormat(source.format),ebook:{sectionId:clean(raw.sectionId,200),sectionTitle:clean(raw.sectionTitle,2000),
      progressPercent:progress,progressKind:progress===null?'':'estimated',estimateBasis:raw.estimateBasis==='paper-toc'?'paper-toc':raw.estimateBasis==='equal-sections'?'equal-sections':'',
      updatedAt:Number.isSafeInteger(raw.updatedAt)&&raw.updatedAt>=0?raw.updatedAt:0}};
  }
  function settingsFromBook(book){return normalizeSettings(book&&book.readingSettings);}
  function changeFormat(settings,format){var next=normalizeSettings(settings);next.format=normalizeFormat(format);return next;}
  function page(value){return Number.isSafeInteger(value)&&value>0?value:null;}
  // Exact titles and IDs come from the supplied contents. The paper boundaries
  // are only weights for an estimate; no paper-page record is created or changed.
  function tocEntries(rows,totalPages){
    if(!Array.isArray(rows))return [];
    var total=page(totalPages),entries=[],seen=new Set();
    function add(row,group){
      if(!object(row))return;
      var id=clean(row.id,200),title=clean(row.title,2000);if(!id||!title||seen.has(id))return;
      seen.add(id);entries.push({id:id,title:title,label:clean(row.label||group.label,200),chapterId:clean(group.id||id,200),
        chapterTitle:clean(group.title||title,2000),page:page(row.page),totalPages:total});
    }
    rows.forEach(function(row){
      if(!object(row))return;
      var children=Array.isArray(row.sections)?row.sections.filter(object):[];
      var group={id:row.chapterId||row.id,title:row.chapterTitle||row.title,label:row.label||''};
      if(children.length){
        // A chapter introduction is a real selectable title when it has a
        // distinct known range before the first subsection. Equal start pages
        // must not count the same content twice.
        if(page(row.page)!==null&&page(children[0].page)!==null&&row.page<children[0].page)add(row,group);
        children.forEach(function(child){add(child,group);});
      }else add(row,group);
    });
    var weighted=total!==null&&entries.every(function(row,index){return row.page!==null&&row.page<=total&&(!index||row.page>entries[index-1].page);});
    return entries.map(function(row,index){
      var start,end;
      if(weighted){start=Math.max(0,row.page-1)/total*100;end=(index+1<entries.length?entries[index+1].page-1:total)/total*100;}
      else {start=index/entries.length*100;end=(index+1)/entries.length*100;}
      return Object.assign({},row,{startPercent:start,endPercent:end,estimateBasis:weighted?'paper-toc':'equal-sections'});
    });
  }
  function estimateSelection(entries,id){
    if(!Array.isArray(entries)||typeof id!=='string')return null;
    var row=entries.find(function(item){return item&&item.id===id;});
    if(!row||percent(row.startPercent)===null||percent(row.endPercent)===null||row.endPercent<row.startPercent)return null;
    return {sectionId:row.id,sectionTitle:(row.label?row.label+' · ':'')+row.title,
      progressPercent:Math.min(99.9,percent((row.startPercent+row.endPercent)/2)),progressKind:'estimated',estimateBasis:row.estimateBasis==='paper-toc'?'paper-toc':'equal-sections'};
  }
  function selectSection(settings,entries,id,now){
    var selection=estimateSelection(entries,id);if(!selection)return null;
    var next=normalizeSettings(settings);next.format='ebook';next.ebook=Object.assign(selection,{updatedAt:Number.isSafeInteger(now)&&now>=0?now:0});return next;
  }
  return {normalizeFormat:normalizeFormat,normalizeSettings:normalizeSettings,settingsFromBook:settingsFromBook,changeFormat:changeFormat,
    tocEntries:tocEntries,estimateSelection:estimateSelection,selectSection:selectSection};
});
