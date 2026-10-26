(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellPrivateShareDomain=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var TYPES=['quote','thought','question','summary'];
  var BACKGROUNDS=['','#EFE6D8','#E4EEE6','#F3E1E6','#E1EAF3','#E9E2F2','#F4EDE0'];
  var FONT_SIZES=['','sm','lg','xl'];
  var MIME_TYPES=['','image/jpeg','image/png','image/webp','image/gif'];
  var POST_COLUMNS=['id','book_id','user_id','checkin','note_type','meeting_no','q1','q2','q3','page','html','photo_url','bg_color','font_size','title','created_at','updated_at'];
  function record(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
  function text(value,label){if(value==null)return '';if(typeof value!=='string')throw new TypeError(label+' 형식을 확인해주세요.');return value;}
  function selected(value,allowed,label){var result=text(value,label);if(allowed.indexOf(result)<0)throw new TypeError(label+' 설정을 확인해주세요.');return result;}
  function photoCopy(value,safePhotoUrl){
    if(value==null)return null;
    if(!record(value)||typeof value.dataUrl!=='string')throw new TypeError('첨부 사진을 확인해주세요.');
    var url=safePhotoUrl(value.dataUrl);
    if(typeof url!=='string'||!url)throw new TypeError('첨부 사진을 안전하게 열 수 없어 공유하지 않았어요.');
    var mime=selected(value.mimeType,MIME_TYPES,'첨부 사진');
    var embedded=/^data:(image\/(?:jpeg|png|webp|gif));base64,/i.exec(url);
    if(embedded){
      if(mime&&mime!==embedded[1].toLowerCase())throw new TypeError('첨부 사진 형식을 확인해주세요.');
      if(!mime)mime=embedded[1].toLowerCase();
    }
    return {dataUrl:url,mimeType:mime};
  }
  function hasText(html){
    return html.replace(/<[^>]*>/g,'').replace(/&nbsp;|&#0*160;|&#x0*a0;/gi,' ').replace(/[\s\u200b\ufeff]/g,'').length>0;
  }
  /* Only the selected record's display fields cross the private/public boundary. */
  function fields(payload,helpers){
    if(!record(payload))throw new TypeError('공유할 기록 형식을 확인해주세요.');
    if(!helpers||typeof helpers.sanitizeHtml!=='function'||typeof helpers.plainTextHtml!=='function'||typeof helpers.safePhotoUrl!=='function')throw new TypeError('공유에 필요한 편집 도구를 확인해주세요.');
    var originalHtml=payload.html==null?helpers.plainTextHtml(text(payload.text,'기록 내용')):text(payload.html,'기록 내용');
    if(typeof originalHtml!=='string')throw new TypeError('공유할 기록 내용을 확인해주세요.');
    var html=helpers.sanitizeHtml(originalHtml);
    if(typeof html!=='string')throw new TypeError('공유할 기록 내용을 확인해주세요.');
    var photo=photoCopy(payload.photo,helpers.safePhotoUrl);
    if(!hasText(html)&&!photo&&helpers.allowEmpty!==true)throw new TypeError('나눌 내용이나 사진이 없어요.');
    var page=payload.page;
    if(typeof page==='number'){
      if(!Number.isFinite(page))throw new TypeError('페이지 형식을 확인해주세요.');
      page=String(page);
    }else page=text(page,'페이지');
    return {title:text(payload.title,'제목'),html:html,page:page,photo:photo,
      bgColor:selected(payload.bgColor,BACKGROUNDS,'배경색'),fontSize:selected(payload.fontSize,FONT_SIZES,'글자 크기'),
      noteType:TYPES.indexOf(payload.noteType)>=0?payload.noteType:'thought',
      checkin:null,meetingNo:'',q1:'',q2:'',q3:''};
  }
  function identifier(value){return typeof value==='string'&&value.length>0&&value===value.trim();}
  function timestamp(value){return Number.isSafeInteger(value)&&value>0;}
  /* An uncertain insert response is success only when the entire intended post exists. */
  function matchingRow(actual,expected){
    if(!record(actual)||!record(expected)||!identifier(expected.id)||!identifier(expected.book_id)||!identifier(expected.user_id)||!timestamp(expected.created_at)||!(expected.updated_at===null||timestamp(expected.updated_at)))return false;
    return POST_COLUMNS.every(function(key){return Object.prototype.hasOwnProperty.call(actual,key)&&Object.prototype.hasOwnProperty.call(expected,key)&&actual[key]===expected[key];});
  }
  function message(noteType){
    if(noteType==='insight')return '통찰 정리의 내용은 그대로 두고 나눔의 내 생각으로 올려요.';
    if(TYPES.indexOf(noteType)<0)return '기록의 내용은 그대로 두고 나눔의 내 생각으로 올려요.';
    return '';
  }
  return {fields:fields,matchingRow:matchingRow,message:message};
});
