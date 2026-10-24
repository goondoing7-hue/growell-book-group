(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory;
  else root.GrowellMeetingRecordsBridge=factory;
}(typeof window!=='undefined'?window:this,function createMeetingRecordsBridge(a){
  'use strict';
  var books=Object.create(null),loads=Object.create(null),sequence=0;
  function identity(){return {user:a.sessionUserId(),epoch:a.sessionEpoch(),sequence:sequence};}
  function current(s){return !!s.user&&s.user===a.sessionUserId()&&s.epoch===a.sessionEpoch()&&s.sequence===sequence;}
  function assert(s,bookId){if(!current(s)||!a.canReadBook(bookId))throw new Error('계정이나 접근 권한이 변경되었어요. 다시 열어주세요.');}
  function message(error){
    var text=String(error&&error.message||'');
    function failure(label,code){var result=new Error(label);result.code=error&&error.code||code;return result;}
    if(/conflict|revision|changed/i.test(text))return failure('다른 화면에서 수정된 기록이에요. 입력한 내용은 보관되니 최신 기록을 확인해주세요.','40001');
    if(/duplicate|already exists|unique/i.test(text))return failure('같은 회차의 모임 기록이 이미 있어요. 목록에서 확인해주세요.','23505');
    if(/material/i.test(text))return new Error('연결한 자료를 확인해주세요. 삭제되었거나 직접 올린 자료가 아닐 수 있어요.');
    if(/permission|denied|access|member|owner/i.test(text))return new Error('이 기록을 저장하거나 볼 수 있는 권한이 없어요.');
    return failure('모임 기록을 처리하지 못했어요. 입력한 내용은 그대로 있으니 잠시 후 다시 시도해주세요.');
  }
  async function loadRecords(bookId){
    var s=identity();assert(s,bookId);
    var token=(loads[bookId]||0)+1;loads[bookId]=token;
    var result=await Promise.all([
      a.sb.rpc('growell_get_meeting_records',{p_book_id:bookId}),
      a.sb.from('posts').select('*').eq('book_id',bookId),
      a.sb.from('material_notes').select('*').eq('book_id',bookId)
    ]);
    assert(s,bookId);
    for(var i=0;i<result.length;i++)if(result[i].error)throw message(result[i].error);
    if(!Array.isArray(result[0].data)||!Array.isArray(result[1].data)||!Array.isArray(result[2].data))throw message();
    var posts=result[1].data.map(a.mapPost),materials=result[2].data.map(a.mapMaterial);
    if(loads[bookId]===token)books[bookId]={posts:posts,materials:materials,identity:s};
    return result[0].data.map(a.domain.normalizeRecord);
  }
  function content(bookId,key){
    var book=books[bookId];
    return book&&current(book.identity)&&a.canReadBook(bookId)?book[key]:[];
  }
  async function saveRecord(record){
    record=a.domain.normalizeRecord(record);
    var s=identity();assert(s,record.bookId);
    if(!a.isAdmin()||record.userId!==s.user)throw message({message:'permission denied'});
    var validation=a.domain.validateRecord(record);
    if(!validation.ok)throw new Error(validation.errors.join('\n'));
    var result=await a.sb.rpc('growell_save_meeting_record',{p_record:record,p_expected_revision:record.revision});
    assert(s,record.bookId);
    if(result.error)throw message(result.error);
    if(!result.data||!result.data.id)throw message();
    return a.domain.normalizeRecord(result.data);
  }
  async function deleteRecord(record){
    var s=identity();assert(s,record.bookId);
    if(!a.isAdmin()||record.userId!==s.user)throw message({message:'permission denied'});
    var result=await a.sb.rpc('growell_delete_meeting_record',{p_id:record.id,p_expected_revision:record.revision});
    assert(s,record.bookId);
    if(result.error)throw message(result.error);
    if(!result.data||result.data.deleted!==true)throw message();
    return result.data;
  }
  function getInsights(bookId,round){
    return content(bookId,'posts').filter(function(p){return p.bookId===bookId&&p.noteType==='insight'&&Number(p.meetingNo)===Number(round);})
      .sort(function(x,y){return new Date(x.createdAt)-new Date(y.createdAt);})
      .map(function(p){return {id:p.id,bookId:p.bookId,userId:p.userId,round:Number(p.meetingNo),name:p.userName||'회원',date:p.createdAt,answers:[p.q1||'',p.q2||'',p.q3||'']};});
  }
  function getMaterials(bookId){return content(bookId,'materials').map(function(m){return {id:m.id,bookId:m.bookId,userId:m.userId,title:m.title||'자료실 글',type:m.noteType||'자료',date:m.createdAt};});}
  function openSource(id,bookId,kind){
    var key=kind==='post'?'posts':'materials';
    var item=content(bookId,key).find(function(p){return p.id===id&&p.bookId===bookId;});
    if(!item){a.showToast('글을 찾을 수 없어요. 모임 기록을 다시 열어주세요.',true);return;}
    a.openSource(item,kind);
  }
  return {loadRecords:loadRecords,saveRecord:saveRecord,deleteRecord:deleteRecord,getInsights:getInsights,getMaterials:getMaterials,getInsightPosts:function(bookId){return content(bookId,'posts').filter(function(p){return p.bookId===bookId&&p.noteType==='insight';});},
    openPost:function(id,bookId){openSource(id,bookId,'post');},openMaterial:function(id,bookId){openSource(id,bookId,'material');},
    reset:function(){sequence++;books=Object.create(null);loads=Object.create(null);}};
}));
