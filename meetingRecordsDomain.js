(function(root, factory){
  var api = factory(root);
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.GrowellMeetingRecordsDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root){
  'use strict';

  var LIMITS = Object.freeze({ topic:160, summary:120, detail:10000, word:80, meaning:4000, sections:20, concepts:30, materials:30, round:9999, nextPlace:1000, nextText:4000 });
  var BOOKS = ['emotion','thought','body','action'];
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
  var MATERIAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
  var FIELDS=['id','bookId','round','date','topic','sections','concepts','materialIds','nextMeeting','status','userId','revision','createdAt','updatedAt'];
  var own = function(object,key){ return Object.prototype.hasOwnProperty.call(object,key); };
  function plainObject(value){
    if(!value || Object.prototype.toString.call(value)!=='[object Object]') return false;
    var proto=Object.getPrototypeOf(value);
    return proto===null || Object.getPrototypeOf(proto)===null;
  }
  function isUuid(value){ return typeof value==='string' && UUID.test(value); }
  function validDate(value){
    if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var y=Number(value.slice(0,4)), m=Number(value.slice(5,7)), d=Number(value.slice(8,10));
    var leap=y%4===0 && (y%100!==0 || y%400===0);
    var days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
    return y>=1 && m>=1 && m<=12 && d>=1 && d<=days[m-1];
  }
  function validTimestamp(value){
    if(typeof value!=='string') return false;
    var parts=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if(!parts || !validDate(parts[1]) || +parts[2]>23 || +parts[3]>59 || +parts[4]>59) return false;
    if(parts[5]!=='Z' && (+parts[5].slice(1,3)>23 || +parts[5].slice(4,6)>59)) return false;
    return Number.isFinite(Date.parse(value));
  }
  function clone(value,seen){
    if(!value || typeof value!=='object') return value;
    seen=seen || new WeakMap();
    if(seen.has(value)) return seen.get(value);
    if(value instanceof Date) return new Date(value.getTime());
    var result=Array.isArray(value) ? [] : {};
    seen.set(value,result);
    Object.keys(value).forEach(function(key){
      Object.defineProperty(result,key,{ value:clone(value[key],seen), enumerable:true, writable:true, configurable:true });
    });
    return result;
  }

  // Normalization does not invent identities, truncate text, or repair invalid
  // types. A malformed server row must still fail validation rather than turn
  // into a plausible replacement for an existing record.
  function normalizeRecord(row){
    if(!plainObject(row)) return null;
    var result={};
    FIELDS.forEach(function(key){
      if(own(row,key)) result[key]=clone(row[key]);
    });
    if(!own(result,'date') || result.date==='') result.date=null;
    if(!own(result,'topic')) result.topic='';
    if(!own(result,'sections')) result.sections=[];
    if(!own(result,'concepts')) result.concepts=[];
    if(!own(result,'materialIds')) result.materialIds=[];
    if(!own(result,'nextMeeting')) result.nextMeeting=null;
    if(!own(result,'createdAt')) result.createdAt=null;
    if(!own(result,'updatedAt')) result.updatedAt=null;
    return result;
  }

  function validateRecord(record){
    var errors=[];
    if(!plainObject(record)) return {ok:false,errors:['모임 기록 형식이 올바르지 않습니다.']};
    if(Object.keys(record).some(function(key){return FIELDS.indexOf(key)===-1;})) errors.push('알 수 없는 모임 기록 항목이 있습니다.');
    var published=record.status==='published';
    function text(value,max,label,required){
      if(typeof value!=='string' || value.indexOf('\u0000')!==-1){ errors.push(label+' 형식이 올바르지 않습니다.'); return; }
      if(Array.from(value).length>max) errors.push(label+'은(는) '+max+'자 이내로 작성해주세요.');
      if(required && !value.trim()) errors.push(label+'을(를) 작성해주세요.');
    }
    if(!isUuid(record.id)) errors.push('모임 기록 ID가 올바르지 않습니다.');
    if(BOOKS.indexOf(record.bookId)===-1) errors.push('책 구분이 올바르지 않습니다.');
    if(!Number.isInteger(record.round) || record.round<1 || record.round>LIMITS.round) errors.push('모임 회차는 1부터 9999까지 입력해주세요.');
    if(record.status!=='draft' && record.status!=='published') errors.push('게시 상태가 올바르지 않습니다.');
    if(typeof record.userId!=='string' || !record.userId.trim() || record.userId.indexOf('\u0000')!==-1) errors.push('작성자 정보가 올바르지 않습니다.');
    if(!Number.isSafeInteger(record.revision) || record.revision<0 || record.revision>Number.MAX_SAFE_INTEGER-1) errors.push('저장 버전이 올바르지 않습니다.');
    if(record.date===null || record.date===''){
      if(published) errors.push('모임 날짜를 선택해주세요.');
    } else if(!validDate(record.date)) errors.push('모임 날짜가 올바르지 않습니다.');
    text(record.topic,LIMITS.topic,'모임 주제',published);
    if(record.nextMeeting!==undefined && record.nextMeeting!==null){
      var preparation=record.nextMeeting, preparationFields=['date','time','place','reading','sharing','habit'];
      if(!plainObject(preparation)) errors.push('다음 모임 준비 형식이 올바르지 않습니다.');
      else {
        if(Object.keys(preparation).some(function(key){return preparationFields.indexOf(key)===-1;})) errors.push('다음 모임 준비에 알 수 없는 항목이 있습니다.');
        preparationFields.forEach(function(key){
          text(preparation[key],key==='date'?10:key==='time'?5:key==='place'?LIMITS.nextPlace:LIMITS.nextText,'다음 모임 준비',false);
        });
        if(typeof preparation.date==='string' && preparation.date!=='' && !validDate(preparation.date)) errors.push('다음 모임 날짜가 올바르지 않습니다.');
        if(typeof preparation.time==='string' && preparation.time!=='' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(preparation.time)) errors.push('다음 모임 시간은 24시간 형식으로 입력해주세요.');
      }
    }
    ['createdAt','updatedAt'].forEach(function(key){
      if(record[key]!==undefined && record[key]!==null && !validTimestamp(record[key])) errors.push('기록 시각이 올바르지 않습니다.');
    });
    function nodes(items,max,label,fields){
      if(!Array.isArray(items)){ errors.push(label+' 형식이 올바르지 않습니다.'); return; }
      if(items.length>max) errors.push(label+'은(는) '+max+'개까지 추가할 수 있습니다.');
      var ids=new Set();
      Array.from(items).forEach(function(item){
        if(!plainObject(item)){ errors.push(label+' 항목 형식이 올바르지 않습니다.'); return; }
        var keys=['id'].concat(fields.map(function(field){return field[0];}));
        if(Object.keys(item).some(function(key){return keys.indexOf(key)===-1;})) errors.push(label+'에 알 수 없는 항목이 있습니다.');
        if(typeof item.id!=='string' || !NODE_ID.test(item.id)) errors.push(label+' 항목 ID가 올바르지 않습니다.');
        else {
          var id=item.id;
          if(ids.has(id)) errors.push(label+' 항목 ID가 중복되었습니다.');
          ids.add(id);
        }
        fields.forEach(function(field){ text(item[field[0]],field[1],field[2],published); });
      });
    }
    nodes(record.sections,LIMITS.sections,'모임 내용',[
      ['summary',LIMITS.summary,'핵심 요약'],['detail',LIMITS.detail,'모임 내용']
    ]);
    if(published && Array.isArray(record.sections) && record.sections.length===0) errors.push('핵심 요약과 모임 내용을 한 가지 이상 작성해주세요.');
    nodes(record.concepts,LIMITS.concepts,'개념',[
      ['word',LIMITS.word,'개념 키워드'],['meaning',LIMITS.meaning,'개념 의미']
    ]);
    if(!Array.isArray(record.materialIds)) errors.push('연결 자료 형식이 올바르지 않습니다.');
    else {
      if(record.materialIds.length>LIMITS.materials) errors.push('관련 자료는 30개까지 연결할 수 있습니다.');
      var materialIds=new Set();
      Array.from(record.materialIds).forEach(function(id){
        if(typeof id!=='string' || !MATERIAL_ID.test(id)) errors.push('연결 자료 ID가 올바르지 않습니다.');
        else {
          var normalized=id;
          if(materialIds.has(normalized)) errors.push('같은 자료를 중복해서 연결할 수 없습니다.');
          materialIds.add(normalized);
        }
      });
    }
    return {ok:errors.length===0,errors:Array.from(new Set(errors))};
  }

  function newId(){
    var crypto=root && root.crypto;
    if(crypto && typeof crypto.randomUUID==='function') return crypto.randomUUID();
    if(!crypto || typeof crypto.getRandomValues!=='function') throw new Error('안전한 ID를 만들 수 없습니다. 페이지를 새로 열어주세요.');
    var bytes=crypto.getRandomValues(new Uint8Array(16));
    bytes[6]=(bytes[6]&15)|64; bytes[8]=(bytes[8]&63)|128;
    var hex=Array.from(bytes,function(value){return value.toString(16).padStart(2,'0');}).join('');
    return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
  }
  function newRecord(bookId,userId){
    return {id:newId(),bookId:bookId,round:1,date:null,topic:'',sections:[],concepts:[],materialIds:[],nextMeeting:null,status:'draft',userId:userId || '',revision:0,createdAt:null,updatedAt:null};
  }

  return Object.freeze({LIMITS:LIMITS,normalizeRecord:normalizeRecord,validateRecord:validateRecord,newRecord:newRecord,newId:newId,isUuid:isUuid,validDate:validDate});
});
