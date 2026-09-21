(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.GrowellHome = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  function values(collection){
    if(Array.isArray(collection)) return collection;
    if(collection && typeof collection==='object') return Object.values(collection);
    return [];
  }
  function validId(value){ return typeof value==='string' && value.trim().length>0; }
  function idSet(ids){
    if(Object.prototype.toString.call(ids)==='[object Set]') return new Set(Array.from(ids).filter(validId));
    return new Set(Array.isArray(ids) ? ids.filter(validId) : []);
  }
  function validYmd(value){
    if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var year=Number(value.slice(0,4)), month=Number(value.slice(5,7)), day=Number(value.slice(8,10));
    var leap=year%4===0 && (year%100!==0 || year%400===0);
    var days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
    return month>=1 && month<=12 && day>=1 && day<=days[month-1];
  }
  // Epoch values use milliseconds, matching Date.now() in the stored app data.
  // An ISO date/time without an offset is read as UTC for consistent ordering.
  function parseTimestamp(value){
    if(typeof value==='number') return Number.isFinite(value) && Math.abs(value)<=8640000000000000 ? value : null;
    if(typeof value!=='string' || !value.trim()) return null;
    var text=value.trim();
    if(/^-?\d+(?:\.\d+)?$/.test(text)) return parseTimestamp(Number(text));
    var match=/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(text);
    if(!match || !validYmd(match[1])) return null;
    if(match[2]!==undefined){
      if(Number(match[2])>23 || Number(match[3])>59 || (match[4]!==undefined && Number(match[4])>59)) return null;
      if(match[5] && match[5]!=='Z' && (Number(match[5].slice(1,3))>23 || Number(match[5].slice(4,6))>59)) return null;
      if(!match[5]) text+='Z';
    }
    var timestamp=Date.parse(text);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  function compareId(a,b){ return a.id<b.id ? -1 : a.id>b.id ? 1 : 0; }
  function compareTime(a,b,field,newest){
    var first=parseTimestamp(a[field]), second=parseTimestamp(b[field]);
    if(first===null || second===null){
      if(first!==second) return first===null ? 1 : -1;
    } else if(first!==second) return newest ? second-first : first-second;
    return compareId(a,b);
  }

  function selectReadingBook(books, readingMetaValues, userId, announcementBookId, unlockedIds){
    var allowed=idSet(unlockedIds), known=new Map(), order=new Map();
    values(books).forEach(function(book,index){
      if(book && validId(book.id) && allowed.has(book.id) && !known.has(book.id)){
        known.set(book.id,book); order.set(book.id,index);
      }
    });
    var chosen=null, latest=null;
    if(validId(userId)) values(readingMetaValues).forEach(function(meta){
      if(!meta || meta.userId!==userId || !known.has(meta.bookId)) return;
      var timestamp=parseTimestamp(meta.updatedAt);
      if(timestamp===null) return;
      if(latest===null || timestamp>latest || (timestamp===latest && order.get(meta.bookId)<order.get(chosen))){
        chosen=meta.bookId; latest=timestamp;
      }
    });
    if(chosen!==null) return known.get(chosen);
    if(known.has(announcementBookId)) return known.get(announcementBookId);
    return known.size ? known.values().next().value : null;
  }

  // Pass STATE.posts (or its values) explicitly. This never walks other state
  // collections; encrypted private rows and worksheet-shaped rows are rejected.
  function selectRecentPosts(posts, userId, unlockedIds, limit){
    if(!validId(userId)) return [];
    var allowed=idSet(unlockedIds);
    var result=values(posts).filter(function(post){
      return post && validId(post.id) && validId(post.bookId) && validId(post.userId)
        && post.userId!==userId && allowed.has(post.bookId)
        && !Object.prototype.hasOwnProperty.call(post,'iv')
        && !Object.prototype.hasOwnProperty.call(post,'data')
        && !Object.prototype.hasOwnProperty.call(post,'activityKey');
    }).slice().sort(function(a,b){ return compareTime(a,b,'createdAt',true); });
    if(limit===undefined || limit===Infinity) return result;
    var count=Number(limit);
    if(!Number.isFinite(count) || count<=0) return [];
    return result.slice(0,Math.floor(count));
  }

  function activeHabits(habits, userId, unlockedIds, todayYmd){
    if(!validId(userId) || !validYmd(todayYmd)) return [];
    var allowed=idSet(unlockedIds);
    return values(habits).filter(function(habit){
      if(!habit || !validId(habit.id) || !validId(habit.bookId) || habit.userId!==userId || !allowed.has(habit.bookId)) return false;
      var start=habit.startDate, end=habit.endDate;
      var hasStart=start!==undefined && start!==null && start!=='';
      var hasEnd=end!==undefined && end!==null && end!=='';
      if((hasStart && !validYmd(start)) || (hasEnd && !validYmd(end))) return false;
      if(hasStart && hasEnd && start>end) return false;
      return (!hasStart || start<=todayYmd) && (!hasEnd || todayYmd<=end);
    }).slice().sort(function(a,b){ return compareTime(a,b,'createdAt',false); });
  }

  return {selectReadingBook:selectReadingBook,selectRecentPosts:selectRecentPosts,activeHabits:activeHabits,parseTimestamp:parseTimestamp};
});
