(function(root,factory){
  var api=factory();
  if(typeof module==='object' && module.exports)module.exports=api;
  else root.GrowellReadingHabits=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var PREFIX='growell-reading-habit-v1:';
  var VALUE_IDS=['faith','love','virtue','wisdom','emotion','beauty','body'];
  var own=Object.prototype.hasOwnProperty;
  function id(value,max){return typeof value==='string' && value.length<=max && /^[A-Za-z0-9_-]+$/.test(value);}
  function normalizeValueId(value){return typeof value==='string' && VALUE_IDS.indexOf(value)>=0?value:'';}
  function normalizeGoal(value){
    if(!value || typeof value!=='object' || Array.isArray(value) || !id(value.bookId,384) ||
      !Number.isSafeInteger(value.targetPages) || value.targetPages<1 || value.targetPages>100000)return null;
    var linked=value.linkedBookId;
    if(linked===undefined || linked===null)linked='';
    if(linked!=='' && !id(linked,160))return null;
    return {bookId:value.bookId,linkedBookId:linked,targetPages:value.targetPages};
  }
  function encode(goalText,readingGoal,valueId){
    if(typeof goalText!=='string')throw new TypeError('습관 목표를 확인해주세요.');
    var selectedValue=normalizeValueId(valueId);
    if(valueId!==undefined && valueId!==null && valueId!=='' && !selectedValue)throw new TypeError('선택한 습관 가치를 확인해주세요.');
    var goal=null;
    if(readingGoal!==null && readingGoal!==undefined){
      goal=normalizeGoal(readingGoal);
      if(!goal)throw new TypeError('독서할 책과 목표 쪽수를 확인해주세요.');
    }
    if(!goal && !selectedValue)return goalText;
    var value={goal:goalText,readingGoal:goal};
    if(selectedValue)value.valueId=selectedValue;
    return PREFIX+JSON.stringify(value);
  }
  function decode(stored){
    var fallback={goal:typeof stored==='string'?stored:'',readingGoal:null};
    if(typeof stored!=='string' || stored.slice(0,PREFIX.length)!==PREFIX)return fallback;
    try{
      var value=JSON.parse(stored.slice(PREFIX.length));
      if(!value || typeof value!=='object' || Array.isArray(value) || typeof value.goal!=='string')return fallback;
      var selectedValue=normalizeValueId(value.valueId);
      if(own.call(value,'valueId') && value.valueId!==null && value.valueId!=='' && !selectedValue)return fallback;
      var goal=null;
      if(value.readingGoal!==null && value.readingGoal!==undefined){
        goal=normalizeGoal(value.readingGoal);
        if(!goal)return fallback;
      }
      if(!goal && !selectedValue)return fallback;
      var decoded={goal:value.goal,readingGoal:goal};
      if(selectedValue)decoded.valueId=selectedValue;
      return decoded;
    }catch(e){return fallback;}
  }
  function validDay(value){
    if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
    var date=new Date(value+'T00:00:00Z');
    return value.slice(0,4)!=='0000' && Number.isFinite(date.getTime()) && date.toISOString().slice(0,10)===value;
  }
  function localDay(timestamp){
    if(!Number.isSafeInteger(timestamp) || timestamp<1 || timestamp>8640000000000000)return '';
    var date=new Date(timestamp);
    return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
  }
  function progress(readingGoal,rows,ownerId,today){
    var goal=normalizeGoal(readingGoal),result={pages:0,targetPages:goal?goal.targetPages:0,achieved:false,available:false,bookTitle:''};
    if(!goal || !Array.isArray(rows) || !id(ownerId,160) || !validDay(today))return result;
    var owned=rows.filter(function(row){return row && row.entry && row.entry.userId===ownerId && row.book && typeof row.book==='object' && !Array.isArray(row.book);});
    var exact=owned.filter(function(row){return row.entry.id===goal.bookId;}),row;
    // A duplicate identity is ambiguous. Never replace a deleted exact match by
    // a similarly titled or newly linked book.
    if(exact.length){if(exact.length!==1)return result;row=exact[0];}
    else if(goal.linkedBookId && goal.bookId==='private_archive_'+ownerId+'_arc_shared_'+goal.linkedBookId){
      var linked=owned.filter(function(item){return item.book.linkedBookId===goal.linkedBookId;});
      if(linked.length===1)row=linked[0];
    }
    if(!row || row.book.deleted)return result;
    result.available=true;
    result.bookTitle=typeof row.book.title==='string'?row.book.title:'';
    var seen=new Set();
    (Array.isArray(row.book.readingSessions)?row.book.readingSessions:[]).forEach(function(session){
      if(!session || typeof session!=='object' || Array.isArray(session) || session.deleted || session.startPageKnown===false || !id(session.id,160) ||
        !own.call(session,'startPage') || !own.call(session,'endPage') ||
        !Number.isSafeInteger(session.startPage) || !Number.isSafeInteger(session.endPage) ||
        session.startPage<0 || session.endPage>100000 || session.endPage<=session.startPage ||
        localDay(session.createdAt)!==today || seen.has(session.id))return;
      seen.add(session.id);
      result.pages+=session.endPage-session.startPage;
    });
    result.achieved=result.pages>=result.targetPages;
    return result;
  }
  return {normalizeGoal:normalizeGoal,normalizeValueId:normalizeValueId,encode:encode,decode:decode,progress:progress};
});
