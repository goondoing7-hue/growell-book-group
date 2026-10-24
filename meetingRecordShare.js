(function(root,factory){
  'use strict';
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellMeetingRecordShare=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  var ORIGIN='https://growell-book.vercel.app';
  var BOOKS=Object.freeze(['emotion','thought','body','action']);
  function target(bookId,round){
    if(BOOKS.indexOf(bookId)<0)return null;
    if(typeof round!=='number'&&typeof round!=='string')return null;
    var value=String(round);
    if(!/^[1-9]\d{0,3}$/.test(value))return null;
    var number=Number(value);
    return {bookId:bookId,round:number,title:'GROWELL · '+number+'번째 모임 기록',
      url:ORIGIN+'/meeting/'+bookId+'/'+number,
      appUrl:ORIGIN+'/#/book/'+bookId+'/share/meeting/'+number};
  }
  function shareData(record){
    if(!record||record.status!=='published')return null;
    var value=target(record.bookId,record.round);
    return value?{title:value.title,url:value.url}:null;
  }
  function current(options){return !options||typeof options.isCurrent!=='function'||options.isCurrent();}
  function cancelled(){return {status:'cancelled'};}
  function fallbackCopy(root,text){
    var doc=root.document;
    if(!doc||!doc.body||typeof doc.execCommand!=='function')return false;
    var previous=doc.activeElement,node=doc.createElement('textarea');
    node.value=text;node.setAttribute('readonly','');node.setAttribute('aria-hidden','true');
    node.style.cssText='position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    doc.body.appendChild(node);
    try{node.select();node.setSelectionRange(0,text.length);return doc.execCommand('copy')===true;}
    catch(error){return false;}
    finally{node.remove();if(previous&&previous.isConnected&&typeof previous.focus==='function')previous.focus({preventScroll:true});}
  }
  async function shareRecord(root,record,options){
    var data=shareData(record);
    if(!data)throw new Error('게시된 모임 기록만 공유할 수 있어요.');
    if(!current(options))return cancelled();
    var navigator=root.navigator||{};
    if(typeof navigator.share==='function'){
      try{await navigator.share(data);return current(options)?{status:'shared'}:cancelled();}
      catch(error){if(error&&error.name==='AbortError')return cancelled();}
    }
    if(!current(options))return cancelled();
    if(navigator.clipboard&&typeof navigator.clipboard.writeText==='function'){
      try{await navigator.clipboard.writeText(data.url);return current(options)?{status:'copied'}:cancelled();}
      catch(error){/* The older copy path supports browsers without clipboard permission. */}
    }
    if(!current(options))return cancelled();
    if(fallbackCopy(root,data.url))return {status:'copied'};
    throw new Error('링크를 복사하지 못했어요. 다시 눌러주세요.');
  }
  return Object.freeze({target:target,shareData:shareData,shareRecord:shareRecord});
});
