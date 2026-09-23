(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.GrowellDailyVerse=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var DAY=86400000,KOREA_OFFSET=9*60*60*1000,ANCHOR_DAY=Date.UTC(2026,8,23)/DAY;
  function get(verses,now){
    if(!Array.isArray(verses)||!verses.length) return null;
    var timestamp=now===undefined?Date.now():new Date(now).getTime();
    if(!Number.isFinite(timestamp)) return null;
    var koreanDay=Math.floor((timestamp+KOREA_OFFSET)/DAY);
    var index=((koreanDay-ANCHOR_DAY)%verses.length+verses.length)%verses.length;
    var verse=verses[index];
    if(!verse||typeof verse.reference!=='string'||typeof verse.text!=='string'||!verse.reference.trim()||!verse.text.trim()) return null;
    return {reference:verse.reference,text:verse.text,index:index,dateKey:new Date(koreanDay*DAY).toISOString().slice(0,10)};
  }
  function getCompact(verses,now){
    if(!Array.isArray(verses)) return null;
    // Rotate complete short passages; never cut off or rewrite the supplied wording.
    var shortVerses=verses.filter(function(verse){
      return verse&&typeof verse.reference==='string'&&verse.reference.trim()&&typeof verse.text==='string'&&verse.text.trim()&&Array.from(verse.text).length<=35;
    });
    return get(shortVerses,now);
  }
  return {get:get,getCompact:getCompact};
});
