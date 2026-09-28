(function(root){
  'use strict';
  var app=null,locks={},state='idle',request=null,version=0;
  function approved(row){return !!(row&&!row.is_deleted&&row.approval_status==='approved');}
  function message(status){return status==='rejected'?'가입 신청이 승인되지 않았어요. 관리자에게 문의해주세요.':'관리자 승인을 기다리고 있어요. 승인 후 로그인할 수 있어요.';}
  function current(owner,epoch){return app.SESSION&&app.SESSION.userId===owner&&app.saveSessionEpoch===epoch;}
  function info(bookId){return locks[bookId]||{book_id:bookId,locked:true,revision:0};}
  function canOpen(bookId){return !!(app&&app.SESSION&&(app.isAdmin()||(state==='ready'&&info(bookId).locked===false)));}
  function reset(){version++;locks={};state='idle';request=null;}
  function load(){
    if(!app.SESSION)return Promise.resolve(false);
    if(request)return request;
    var owner=app.SESSION.userId,epoch=app.saveSessionEpoch,loadVersion=version;
    state='loading';
    request=Promise.resolve(app.sb.rpc('growell_get_worksheet_locks')).then(function(result){
      if(!current(owner,epoch)||version!==loadVersion)return false;
      if(result.error||!Array.isArray(result.data))throw new Error('worksheet-lock-load-failed');
      var next={};result.data.forEach(function(row){next[row.book_id]={book_id:row.book_id,locked:row.locked!==false,revision:Number(row.revision)||0};});
      locks=next;state='ready';return true;
    }).catch(function(){if(current(owner,epoch)&&version===loadVersion){locks={};state='error';}return false;}).finally(function(){if(version===loadVersion)request=null;});
    return request;
  }
  function panel(bookId){
    if(!app.isAdmin())return '';
    var row=info(bookId);
    return '<div class="worksheet-access-panel"><div><strong>활동지 공개 설정</strong><p>'+(state==='error'?'잠금 상태를 불러오지 못했어요.':row.locked?'현재 관리자만 열 수 있어요.':'승인된 회원이 활동지를 열고 작성할 수 있어요.')+'</p></div>'+
      (state==='error'?'<button class="btn btn-secondary btn-sm" data-reload-worksheet-locks>다시 불러오기</button>':'<button type="button" class="btn btn-secondary btn-sm" data-worksheet-lock="'+app.esc(bookId)+'"'+(state!=='ready'?' disabled':'')+'>'+ (state!=='ready'?'확인 중…':row.locked?'회원에게 열기':'활동지 잠그기')+'</button>')+'</div>';
  }
  function bind(){
    document.querySelectorAll('[data-worksheet-lock]').forEach(function(button){button.addEventListener('click',async function(){
      if(!app.SESSION||!app.isAdmin()||state!=='ready')return;
      var bookId=button.dataset.worksheetLock,row=info(bookId),owner=app.SESSION.userId,epoch=app.saveSessionEpoch;
      button.disabled=true;
      try{
        var result=await app.sb.rpc('growell_set_worksheet_lock',{p_book_id:bookId,p_locked:!row.locked,p_expected_revision:row.revision});
        if(!current(owner,epoch))return;
        if(result.error||!result.data)throw new Error('save-failed');
        var updated=Array.isArray(result.data)?result.data[0]:result.data;
        if(updated.book_id!==bookId||typeof updated.locked!=='boolean')throw new Error('save-failed');
        locks[bookId]=updated;app.showToast(updated.locked?'활동지를 잠갔어요.':'승인된 회원에게 활동지를 열었어요.');app.reloadCommunity();
      }catch(e){if(current(owner,epoch)){app.showToast('설정을 저장하지 못했어요. 최신 상태를 다시 확인해주세요.',true);await load();app.render();}}
    });});
    document.querySelectorAll('[data-reload-worksheet-locks]').forEach(function(button){button.addEventListener('click',function(){button.disabled=true;load().then(function(){app.render();});});});
    document.querySelectorAll('[data-review-member]').forEach(function(button){button.addEventListener('click',async function(){
      if(!app.SESSION||!app.isAdmin())return;
      var id=button.dataset.reviewMember,decision=button.dataset.decision,owner=app.SESSION.userId,epoch=app.saveSessionEpoch;
      if(!['approved','rejected'].includes(decision))return;
      button.disabled=true;
      try{
        var result=await app.sb.rpc('growell_review_member',{p_profile_id:id,p_decision:decision});
        if(!current(owner,epoch))return;
        if(result.error||!result.data)throw new Error('review-failed');
        app.showToast(decision==='approved'?'가입을 승인했어요. 이제 로그인할 수 있어요.':'가입 신청을 승인하지 않았어요.');app.reloadCommunity();
      }catch(e){if(current(owner,epoch)){button.disabled=false;app.showToast('가입 상태를 변경하지 못했어요. 사진과 관리자 권한을 확인해주세요.',true);}}
    });});
  }
  var api={configure:function(adapter){app=adapter;},approved:approved,message:message,info:info,canOpen:canOpen,load:load,reset:reset,panel:panel,bind:bind};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellMemberAccess=api;
})(typeof window!=='undefined'?window:globalThis);
