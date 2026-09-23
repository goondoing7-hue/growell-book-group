(function(root,factory){
  'use strict';
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellCommunity=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var defaults=Object.freeze({emotion:'최근 내 마음에 이름을 붙여 준 순간이 있었나요?',thought:'책 속의 어떤 생각이 나의 시선을 바꾸었나요?',body:'오늘 몸이 나에게 보내는 신호는 무엇인가요?',action:'이번 주에 작게 실천해 보고 싶은 것은 무엇인가요?'});
  function question(value){return typeof value==='string'?value.trim():'';}
  function validQuestion(value){var text=question(value);return !!text&&Array.from(text).length<=240;}
  function questionRows(rows){
    if(!Array.isArray(rows))throw new Error('question-load-invalid');
    var result=Object.create(null);
    rows.forEach(function(row){
      if(!row||!Object.prototype.hasOwnProperty.call(defaults,row.book_id)||!validQuestion(row.question)||!Number.isSafeInteger(Number(row.revision))||Number(row.revision)<1)throw new Error('question-load-invalid');
      result[row.book_id]={question:question(row.question),revision:Number(row.revision)};
    });
    return result;
  }
  function questionFor(book,rows){return rows&&rows[book.id]?rows[book.id].question:defaults[book.id]||(book.checkin&&book.checkin.prompt)||'책을 읽으며 어떤 생각이 떠올랐나요?';}
  function timestamp(value){
    if(typeof value==='number')return Number.isFinite(value)?value:0;
    if(typeof value!=='string'||!value.trim())return 0;
    var numeric=Number(value);if(Number.isFinite(numeric))return numeric;
    var parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:0;
  }
  // Deliberately accepts only shared posts. Private entries are never an input.
  function authorPosts(posts,userId,unlockedIds,isMember){
    if(!isMember||typeof userId!=='string'||!userId)return [];
    var allowed=new Set(unlockedIds||[]);
    return Object.values(posts||{}).filter(function(post){return post&&typeof post.id==='string'&&post.id&&post.userId===userId&&allowed.has(post.bookId);}).sort(function(a,b){
      return timestamp(b.createdAt)-timestamp(a.createdAt)||a.id.localeCompare(b.id);
    });
  }
  return {defaults:defaults,question:question,validQuestion:validQuestion,questionRows:questionRows,questionFor:questionFor,authorPosts:authorPosts};
});
