(function(root,factory){
  'use strict';
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellMeetingRecords=api;
})(typeof window!=='undefined'?window:globalThis,function(root){
  'use strict';
  // The application owns authorization, RPCs and original-post navigation. No
  // meeting content or draft is persisted by this module outside those RPCs.
  var app=null,dialog=null,subdialog=null,returnFocus=null,owner=null,epoch=null;
  var state=null,drafts=Object.create(null),request=0,busy=false,carouselDispose=null,downloadCancel=null;
  var limits={sections:20,concepts:30,questions:30,question:1000,materials:30,topic:160,summary:120,detail:10000,word:80,meaning:4000};
  var paths={close:'m6 6 12 12M18 6 6 18',back:'m15 18-6-6 6-6',next:'m9 6 6 6-6 6',plus:'M12 5v14M5 12h14',book:'M12 5v15M12 5C8 2 4 3 2 4v15c4-2 7-1 10 1 3-2 6-3 10-1V4c-2-1-6-2-10 1Z',file:'M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 12h8M8 16h8',out:'M8 5h11v11M19 5 5 19',play:'m9 5 11 7-11 7V5Z'};
  function icon(name){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+paths[name]+'"/></svg>';}
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function clone(value){return JSON.parse(JSON.stringify(value));}
  function uuid(){var domain=root.GrowellMeetingRecordsDomain;if(domain&&domain.newId)return domain.newId();if(root.crypto&&typeof root.crypto.randomUUID==='function')return root.crypto.randomUUID();throw new Error('기록 ID를 만들 수 없어요. 페이지를 새로 열어주세요.');}
  function member(){return app&&app.sessionUserId();}
  function sessionEpoch(){return app&&app.sessionEpoch();}
  function current(){return !!app&&owner===member()&&epoch===sessionEpoch();}
  function allowed(bookId){return current()&&!!member()&&app.canReadBook(bookId);}
  function admin(){return current()&&app.isAdmin();}
  function editable(record){return admin()&&record&&record.userId===member();}
  function normalize(record){var domain=root.GrowellMeetingRecordsDomain;return domain&&domain.normalizeRecord?domain.normalizeRecord(record):record;}
  function button(label,action,classes,extra){return '<button type="button" class="'+(classes||'mr-button')+'" data-mr-action="'+action+'" '+(extra||'')+'>'+label+'</button>';}
  function dateText(value){
    if(value==null||value==='')return '날짜 미정';
    var text=String(value);if(/^\d{4}-\d{2}-\d{2}$/.test(text))return text.replace(/-/g,'.');
    var timestamp=typeof value==='number'?value:/^\d{10,13}$/.test(text)?Number(text):text;
    if(typeof timestamp==='number'&&timestamp>0&&timestamp<100000000000)timestamp*=1000;
    var date=new Date(timestamp);if(!Number.isFinite(date.getTime()))return text;
    return date.getFullYear()+'.'+String(date.getMonth()+1).padStart(2,'0')+'.'+String(date.getDate()).padStart(2,'0');
  }
  function book(){return state&&app.bookById(state.bookId);}
  function recordKey(record){return record.bookId+':'+record.id;}
  function snapshotDraft(){if(state&&state.draft&&editable(state.draft))drafts[recordKey(state.draft)]=clone(state.draft);}
  function ensureOwner(){if(owner!==member()||epoch!==sessionEpoch()){reset();owner=member();epoch=sessionEpoch();}}
  function configure(adapter){
    ['sessionUserId','sessionEpoch','isAdmin','canReadBook','bookById','loadRecords','saveRecord','deleteRecord','getInsights','getMaterials','openPost','openMaterial','showToast'].forEach(function(name){if(!adapter||typeof adapter[name]!=='function')throw new Error('Missing meeting records adapter: '+name);});
    reset();app=adapter;owner=member();epoch=sessionEpoch();
  }
  function closeSub(restore){
    if(!subdialog)return;
    var node=subdialog,focus=node._returnFocus;subdialog=null;
    if(node.open)node.close();node.remove();
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed('meeting-records-sub');
    if(restore!==false&&focus&&focus.isConnected)focus.focus({preventScroll:true});
  }
  function close(restore,force){
    if(busy&&!force)return false;
    if(downloadCancel){downloadCancel();downloadCancel=null;}
    snapshotDraft();closeSub(false);request++;
    if(carouselDispose){carouselDispose();carouselDispose=null;}
    if(dialog){var node=dialog,focus=returnFocus;dialog=null;returnFocus=null;state=null;if(node.open)node.close();node.remove();if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed('meeting-records');if(restore!==false&&focus&&focus.isConnected)focus.focus({preventScroll:true});}
    busy=false;return true;
  }
  function reset(){close(false,true);drafts=Object.create(null);owner=null;epoch=null;request++;}
  function shell(trigger){
    close(false);returnFocus=trigger||document.activeElement;
    dialog=document.createElement('dialog');dialog.className='meeting-records-dialog';dialog.setAttribute('aria-labelledby','mr-dialog-title');
    dialog.addEventListener('cancel',function(event){event.preventDefault();close();});
    dialog.addEventListener('click',function(event){if(event.target===dialog){var r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();return;}handleClick(event);});
    dialog.addEventListener('input',handleInput);dialog.addEventListener('change',handleChange);
    document.body.appendChild(dialog);
    return dialog;
  }
  function showShell(){
    dialog.showModal();
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.open('meeting-records',{close:function(){close();},canClose:function(){return !busy;}});
  }
  function subShell(title,body,actions,trigger){
    closeSub(false);var node=document.createElement('dialog');subdialog=node;node._returnFocus=trigger||document.activeElement;
    node.className='meeting-records-dialog meeting-records-subdialog';node.setAttribute('aria-labelledby','mr-sub-title');
    node.innerHTML='<div class="mr-body"><div class="mr-subtitle-row"><div>'+title+'</div>'+button(icon('close'),'close-sub','mr-icon-button','aria-label="팝업 닫기"')+'</div>'+body+'</div>'+(actions?'<div class="mr-actions">'+actions+'</div>':'');
    function dismiss(event){event.preventDefault();if(!busy)closeSub();}
    node.addEventListener('cancel',dismiss);
    node.addEventListener('click',function(event){var target=event.target.closest('[data-mr-action="close-sub"]');if(target){dismiss(event);return;}if(event.target===node){var r=node.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dismiss(event);}});
    document.body.appendChild(node);node.showModal();
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.open('meeting-records-sub',{close:function(){closeSub();},canClose:function(){return !busy;}});
    return node;
  }
  function launchHtml(bookId){return '<button class="meeting-records-launch" type="button" data-meeting-records="'+esc(bookId)+'" aria-haspopup="dialog">'+icon('book')+'모임별 기록</button>';}
  function bind(container){
    (container||document).querySelectorAll('[data-meeting-records]').forEach(function(node){if(node._meetingRecordsBound)return;node._meetingRecordsBound=true;node.addEventListener('click',function(){
      var round=node.getAttribute('data-meeting-round');
      if(round!==null)openRound(node.getAttribute('data-meeting-records'),round,node);
      else openList(node.getAttribute('data-meeting-records'),node);
    });});
  }
  function openRound(bookId,round,trigger){
    var value=String(round==null?'':round).normalize('NFKC').trim();
    if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>9999)return;
    openList(bookId,trigger,Number(value));
  }
  function openList(bookId,trigger,requestedRound){
    if(!app)return;ensureOwner();if(!allowed(bookId)||!app.bookById(bookId)||busy)return;
    shell(trigger);state={bookId:bookId,requestedRound:requestedRound||null,view:'list',rows:[],loading:true,error:'',draft:null,record:null,editingConcept:null,undo:null,slide:0,dirty:false,preview:false,conflict:false};
    render();showShell();loadRows();
  }
  function validRows(rows){
    if(!Array.isArray(rows))throw new Error('Invalid meeting record response');
    var normalized=rows.map(normalize);if(normalized.some(function(row){return !row||!validation(row).ok;}))throw new Error('Invalid meeting record contents');
    return normalized.filter(function(row){return row.bookId===state.bookId&&(row.status==='published'||(admin()&&row.userId===member()));}).sort(function(a,b){return Number(b.round)-Number(a.round)||String(b.date||'').localeCompare(String(a.date||''));});
  }
  function loadRows(){
    if(!dialog||!allowed(state.bookId))return Promise.resolve(false);
    var node=dialog,bookId=state.bookId,id=++request;state.loading=true;state.error='';render();
    return Promise.resolve().then(function(){return app.loadRecords(bookId);}).then(function(rows){
      if(dialog!==node||id!==request||!allowed(bookId))return false;
      state.rows=validRows(rows);state.loading=false;
      if(state.requestedRound){
        var selected=state.rows.find(function(row){return row.status==='published'&&Number(row.round)===state.requestedRound;});
        if(selected){state.requestedRound=null;openRecord(selected);return true;}
      }
      render();return true;
    }).catch(function(){if(dialog===node&&id===request&&allowed(bookId)){state.loading=false;state.error='모임 기록을 불러오지 못했어요. 잠시 후 다시 시도해주세요.';render();}return false;});
  }
  function byId(id){return state.rows.find(function(row){return row.id===id;});}
  function freshRecord(){
    var day=new Date(),localDate=day.getFullYear()+'-'+String(day.getMonth()+1).padStart(2,'0')+'-'+String(day.getDate()).padStart(2,'0');
    return {id:uuid(),bookId:state.bookId,userId:member(),round:Math.max(0,...state.rows.map(function(row){return Number(row.round)||0;}))+1,date:localDate,topic:'',sections:[{id:uuid(),summary:'',detail:''}],concepts:[],thoughtQuestions:[],materialIds:[],status:'draft',revision:0,createdAt:null,updatedAt:null};
  }
  function beginEdit(record){
    if(!admin()||record&&!editable(record))return;
    if(!record){record=Object.keys(drafts).map(function(key){return drafts[key];}).find(function(row){return row.bookId===state.bookId&&row.revision===0&&editable(row);})||freshRecord();}
    state.record=record.revision>0?clone(record):null;state.draft=clone(drafts[recordKey(record)]||record);state.dirty=!!drafts[recordKey(record)];state.view='edit';state.preview=false;state.editingConcept=null;state.undo=null;state.error='';state.conflict=false;state.slide=0;render();
  }
  function openRecord(record){if(!record)return;state.record=record;state.draft=null;state.view='read';state.preview=false;state.error='';state.conflict=false;state.slide=0;render();}
  function topHtml(){
    var closeButton=button(icon('close'),'close','mr-icon-button mr-close','aria-label="모임별 기록 닫기"');
    if(state.view==='list')return '<div class="mr-top"><h2 id="mr-dialog-title">모임별 기록</h2>'+closeButton+'</div>';
    var editMode=state.view==='edit'||state.preview;
    return '<div class="mr-top">'+button(icon('back')+'모임별 기록','list','mr-back')+(editMode?'<div class="mr-modes" aria-label="모임 기록 화면 전환">'+button('작성 화면','editor-mode','','aria-pressed="'+(!state.preview)+'"')+button('미리보기','preview-mode','','aria-pressed="'+state.preview+'"')+'</div>':'')+closeButton+'</div>';
  }
  function listHtml(){
    if(state.requestedRound){
      var message=state.loading?'<p class="mr-empty" role="status">모임 기록을 불러오는 중이에요…</p>':state.error?'<div class="mr-empty" role="alert">'+esc(state.error)+'<br>'+button('다시 불러오기','retry')+'</div>':'<p class="mr-empty" role="status">아직 공개된 모임 기록이 없어요.</p>';
      return '<div class="mr-body"><p class="mr-book-label">'+esc(book().title)+'</p><h1 class="mr-title">'+esc(state.requestedRound)+'번째 모임 기록</h1>'+message+button('모든 모임 기록 보기','list','mr-button')+'</div>';
    }
    var pending=admin()?Object.keys(drafts).map(function(key){return drafts[key];}).find(function(row){return row.bookId===state.bookId&&row.revision===0&&editable(row);}):null;
    var content=state.loading?'<p class="mr-empty" role="status">모임 기록을 불러오는 중이에요…</p>':state.error?'<div class="mr-empty" role="alert">'+esc(state.error)+'<br>'+button('다시 불러오기','retry')+'</div>':state.rows.length?state.rows.map(function(row){
      var insights=insightRows(row).length;
      return button('<span class="mr-meeting-round">'+esc(row.round)+'번째</span><span class="mr-meeting-copy"><strong>'+esc(row.topic||'작성 중인 모임 기록')+(row.status==='draft'?'<span class="mr-badge">임시 저장</span>':'')+'</strong><small>'+esc(dateText(row.date))+' · 통찰 '+insights+'개 · 자료 '+row.materialIds.length+'개</small></span>'+icon('next'),'record','mr-meeting-row','data-id="'+esc(row.id)+'"');
    }).join(''):'<div class="mr-empty">아직 모임 기록이 없어요.'+(admin()?'<br>첫 모임의 이야기를 남겨보세요.':'')+'</div>';
    return '<div class="mr-body"><div class="mr-list-head"><div><p class="mr-book-label">'+esc(book().title)+'</p><h1 class="mr-title">함께 쌓은 이야기</h1><p class="mr-intro">모임에서 나눈 생각을 회차별로 다시 읽어요.</p></div>'+(admin()&&!state.loading&&!state.error?button(icon('plus')+'기록 작성','create','mr-button mr-primary'):'')+'</div>'+(pending?'<div class="mr-notice">아직 저장하지 않은 작성 내용이 있어요.'+button('이어서 작성','create','mr-link')+'</div>':'')+content+'</div>';
  }
  function insightRows(record){
    var rows=app.getInsights(record.bookId,record.round);
    return (Array.isArray(rows)?rows:[]).filter(function(row){return row&&row.id&&row.bookId===record.bookId&&Number(row.round)===Number(record.round)&&row.visible!==false&&row.private!==true&&Array.isArray(row.answers);});
  }
  function materialRows(){var rows=app.getMaterials(state.bookId);return (Array.isArray(rows)?rows:[]).filter(function(row){return row&&row.id&&row.bookId===state.bookId;});}
  function ownMaterials(){var rows=app.getOwnMaterials?app.getOwnMaterials(state.bookId):materialRows();return (Array.isArray(rows)?rows:[]).filter(function(row){return row&&row.bookId===state.bookId&&row.userId===member();});}
  function materialIcon(row){return row.type==='영상'||row.type==='video'?'play':'file';}
  function materialType(row){return ({video:'추천영상',guide:'안내',meeting:'모임자료',deepen:'심화자료',article:'글',document:'문서'})[row.type]||row.type||'자료';}
  function insightAvatarHtml(row){
    var name=row.name||'모임원';
    // Resolve the current member profile when rendering; never store a photo in the record.
    var content=typeof app.avatarHtml==='function'?app.avatarHtml(row.userId,name,book().accent||'emotion'):esc(Array.from(String(name))[0]);
    return '<div class="mr-avatar" aria-hidden="true">'+content+'</div>';
  }
  function carouselHtml(record){
    var rows=insightRows(record),labels=['모임 소감','새로운 깨달음','실천할 배움'];state.slide=Math.max(0,Math.min(state.slide,rows.length-1));
    return '<section class="mr-section mr-divider" data-mr-carousel aria-label="이 모임의 회원 통찰"><div class="mr-section-head"><h2>함께 나눈 통찰<small>'+rows.length+'개</small></h2>'+(rows.length?'<div class="mr-carousel-nav"><span class="mr-count" data-mr-count aria-live="polite">'+(state.slide+1)+' / '+rows.length+'</span>'+button(icon('back'),'previous','mr-icon-button','aria-label="이전 통찰"')+button(icon('next'),'next','mr-icon-button','aria-label="다음 통찰"')+'</div>':'')+'</div><p class="mr-subtitle">'+esc(record.round)+'번째 모임에 남긴 통찰 정리가 자동으로 연결돼요.</p>'+(rows.length?'<div class="mr-track" data-mr-track tabindex="0" aria-label="통찰 목록. 좌우 방향키로 넘길 수 있어요.">'+rows.map(function(row,index){
      return '<article class="mr-insight" role="link" tabindex="0" data-mr-post="'+esc(row.id)+'" aria-label="'+esc(row.name||'모임원')+'의 통찰 원문 보기, '+(index+1)+' / '+rows.length+'"><div class="mr-author">'+insightAvatarHtml(row)+'<strong>'+esc(row.name||'모임원')+'</strong><small>'+esc(row.date?dateText(row.date):'')+'</small></div><div class="mr-answers">'+labels.map(function(label,j){return '<div class="mr-answer"><h3>'+label+'</h3><p>'+esc(row.answers[j]||'작성한 답변이 없어요.')+'</p></div>';}).join('')+'</div><span class="mr-insight-tail">통찰 원문 보기 ↗</span></article>';
    }).join('')+'</div><div class="mr-slide-foot"><span>옆으로 넘기고, 카드를 눌러 원문을 읽어보세요.</span><div class="mr-dots" aria-hidden="true">'+rows.map(function(_,i){return '<span class="'+(i===state.slide?'is-active':'')+'"></span>';}).join('')+'</div></div>':'<div class="mr-empty">아직 이 회차에 등록된 통찰이 없어요.</div>')+'</section>';
  }
  function resourcesHtml(record,editing){
    var materials=materialRows(),available=record.materialIds.map(function(id){return materials.find(function(row){return row.id===id;})||{id:id,missing:true,title:'삭제되었거나 볼 수 없는 자료'};});
    return '<section class="mr-section mr-divider"><div class="mr-section-head"><h2>'+(editing?'관련 자료':'함께 읽고 볼 자료')+'<small>'+record.materialIds.length+'개'+(editing?' 연결':'')+'</small></h2>'+(editing?button(icon('plus')+'자료실에서 선택','materials','mr-link','aria-haspopup="dialog"'):'')+'</div><div class="mr-resources">'+(available.map(function(row){
      if(editing)return '<div class="mr-selected-row">'+icon(materialIcon(row))+(row.missing?'<span>'+esc(row.title)+'</span>':button(esc(row.title),'material','mr-link','data-id="'+esc(row.id)+'"'))+button(icon('close'),'remove-material','mr-icon-button','data-id="'+esc(row.id)+'" aria-label="'+esc(row.title)+' 연결 해제"')+'</div>';
      return row.missing?'<div class="mr-empty">'+esc(row.title)+'</div>':button('<span class="mr-resource-icon">'+icon(materialIcon(row))+'</span><span class="mr-resource-body"><strong>'+esc(row.title||'자료실 글')+'</strong><small>'+esc(materialType(row))+' · 자료실</small></span><span class="mr-resource-tail">'+icon('out')+'</span>','material','mr-resource','data-id="'+esc(row.id)+'"');
    }).join('')||'<div class="mr-empty">연결된 자료가 없어요.</div>')+'</div><p class="mr-note">'+(editing?'내가 올린 자료를 연결해요. 연결을 해제해도 자료실의 원본 글은 유지돼요.':'자료를 누르면 자료실의 해당 글을 볼 수 있어요.')+'</p></section>';
  }
  var preparationFields=['date','time','place','reading','sharing','habit'];
  function emptyPreparation(){return {date:'',time:'',place:'',reading:'',sharing:'',habit:''};}
  function preparationHtml(record,editing){
    var next=record.nextMeeting||emptyPreparation();
    if(!editing&&!preparationFields.some(function(key){return typeof next[key]==='string'&&next[key].trim();}))return '';
    var heading='<div class="mr-section-head"><h2>다음 모임 준비</h2></div>';
    if(editing){
      function field(key,label,type){
        var attrs=' data-mr-next="'+key+'"';
        var control=type?'<input type="'+type+'"'+attrs+' value="'+esc(next[key])+'">':'<textarea rows="2" maxlength="'+(key==='place'?1000:4000)+'"'+attrs+'>'+esc(next[key])+'</textarea>';
        return '<label class="mr-field'+(key==='sharing'?' mr-preparation-sharing-field':'')+'"><span>'+label+'</span>'+control+(key==='sharing'?'<small>나눔 과제는 하이라이트로 강조돼요.</small>':'')+'</label>';
      }
      return '<section class="mr-edit-section mr-divider" data-mr-preparation>'+heading+'<p class="mr-subtitle">다음 만남의 일정과 준비할 내용을 적어주세요. 작성한 항목만 보여요.</p><div class="mr-fields-row">'+field('date','다음 모임 날짜','date')+field('time','다음 모임 시간','time')+'</div>'+field('place','장소')+field('reading','읽기 범위')+field('sharing','나눔')+field('habit','독서 습관')+'</section>';
    }
    var rows=[],when=[next.date?dateText(next.date):'',next.time||''].filter(Boolean).join(' · ');
    if(when)rows.push('<div class="mr-preparation-row"><dt>일시</dt><dd>'+esc(when)+'</dd></div>');
    [['place','장소'],['reading','읽기 범위'],['sharing','나눔'],['habit','독서 습관']].forEach(function(entry){
      var value=next[entry[0]];if(typeof value!=='string'||!value.trim())return;
      rows.push('<div class="mr-preparation-row'+(entry[0]==='sharing'?' mr-preparation-highlight':'')+'"><dt>'+entry[1]+'</dt><dd>'+(entry[0]==='sharing'?'<mark>'+esc(value)+'</mark>':esc(value))+'</dd></div>');
    });
    return '<section class="mr-section mr-divider" data-mr-preparation>'+heading+'<dl class="mr-preparation-list">'+rows.join('')+'</dl></section>';
  }
  function readHtml(record){
    var outline=record.sections.map(function(section,i){
      return '<li><span class="mr-number" aria-hidden="true">'+(i+1)+'.</span>'+button(esc(section.summary||'핵심 내용을 입력해주세요.'),'jump-section','mr-core-jump','data-id="'+esc(section.id)+'" aria-controls="mr-story-'+esc(section.id)+'"')+'</li>';
    }).join('');
    var stories=record.sections.map(function(section,i){
      return '<article class="mr-story" id="mr-story-'+esc(section.id)+'" data-mr-story="'+esc(section.id)+'" tabindex="-1" aria-labelledby="mr-story-heading-'+esc(section.id)+'"><h3 id="mr-story-heading-'+esc(section.id)+'"><span class="mr-number">'+(i+1)+'.</span><span>'+esc(section.summary||'새 주제')+'</span></h3><p class="mr-summary">'+esc(section.detail||'아직 작성한 내용이 없어요.')+'</p></article>';
    }).join('');
    return '<div class="mr-body">'+(state.preview?'<div class="mr-notice">작성 중인 내용의 미리보기예요. 저장하거나 게시하면 반영돼요.</div>':'')+'<div class="mr-eyebrow"><span class="mr-round">'+esc(record.round)+'번째 모임</span><span>'+esc(dateText(record.date))+'</span><span class="mr-owner">'+(record.status==='draft'?'임시 저장 · 나에게만 공개':'운영자 정리')+'</span></div><h1 id="mr-dialog-title" class="mr-topic">'+esc(record.topic||'모임 주제')+'</h1><p class="mr-book">'+icon('book')+esc(book().title)+'</p><section class="mr-section mr-core"><div class="mr-section-head"><h2>핵심 요약</h2></div><ol class="mr-core-list">'+outline+'</ol>'+(!record.sections.length?'<p class="mr-note">아직 작성된 핵심 요약이 없어요.</p>':'')+'</section><section class="mr-section"><div class="mr-section-head"><h2>함께 살펴본 개념</h2></div><div class="mr-keywords">'+record.concepts.map(function(concept){return button(esc(concept.word||'새 키워드'),'concept','mr-keyword','data-id="'+esc(concept.id)+'" aria-haspopup="dialog"');}).join('')+'</div><p class="mr-note">'+(record.concepts.length?'키워드를 누르면 의미를 팝업으로 볼 수 있어요.':'아직 정리한 개념이 없어요.')+'</p></section>'+questionsHtml(record,false)+'<section class="mr-section mr-divider"><div class="mr-section-head"><h2>모임 내용</h2></div>'+stories+'</section>'+preparationHtml(record,false)+carouselHtml(record)+resourcesHtml(record,false)+'</div>';
  }
  function questionsHtml(record,editing){
    var questions=record.thoughtQuestions||[];
    if(!editing&&!questions.length)return '';
    var heading='<div class="mr-section-head"><h2>생각 질문</h2>'+(editing?button(icon('plus')+'질문 추가','add-question','mr-link',questions.length>=limits.questions?'disabled':''):'')+'</div>';
    var rows=questions.map(function(item,index){
      if(!editing)return '<li><span class="mr-number" aria-hidden="true">'+(index+1)+'.</span><p>'+esc(item.text)+'</p></li>';
      return '<div class="mr-outline-row mr-question-row"><span class="mr-number" aria-hidden="true">'+(index+1)+'.</span><textarea class="mr-outline-input" rows="2" maxlength="'+limits.question+'" data-mr-question="'+esc(item.id)+'" aria-label="생각 질문 '+(index+1)+'" placeholder="함께 생각해볼 질문을 적어주세요.">'+esc(item.text)+'</textarea>'+button(icon('close'),'remove-question','mr-icon-button','data-id="'+esc(item.id)+'" aria-label="생각 질문 '+(index+1)+' 삭제"')+'</div>';
    }).join('');
    return '<section class="'+(editing?'mr-edit-section':'mr-section')+' mr-divider" data-mr-thought-questions>'+heading+(editing?'<p class="mr-subtitle">책을 읽으며 떠오른 질문을 순서대로 정리해주세요.</p>'+rows+(!questions.length?'<div class="mr-empty">함께 생각해볼 질문을 추가해보세요.</div>':'')+undoHtml('question'):'<ol class="mr-thought-questions">'+rows+'</ol>')+'</section>';
  }
  function undoHtml(kind){return state.undo&&state.undo.kind===kind?'<div class="mr-local-notice" role="status"><span>'+(kind==='section'?'주제와 연결된 내용을 삭제했어요.':kind==='question'?'생각 질문을 삭제했어요.':'키워드와 의미를 삭제했어요.')+'</span>'+button('실행 취소','undo','mr-link')+'</div>':'';}
  function outlineHtml(record){return '<section class="mr-edit-section"><div class="mr-section-head"><h2>핵심 요약</h2></div><p class="mr-subtitle">한 주제를 한 문장으로 짧게 적어주세요.</p>'+record.sections.map(function(section,i){return '<div class="mr-outline-row"><span class="mr-number" aria-hidden="true">'+(i+1)+'.</span><textarea class="mr-outline-input" rows="2" maxlength="'+limits.summary+'" data-mr-section="'+esc(section.id)+'" data-part="summary" aria-label="핵심 요약 '+(i+1)+'" placeholder="핵심 내용을 한 문장으로">'+esc(section.summary)+'</textarea>'+button(icon('close'),'remove-section','mr-icon-button','data-id="'+esc(section.id)+'" aria-label="핵심 요약 '+(i+1)+' 및 연결 내용 삭제"')+'</div>';}).join('')+button(icon('plus')+'주제 추가','add-section','mr-link',record.sections.length>=limits.sections?'disabled':'')+undoHtml('section')+'<p class="mr-note">입력한 문장은 아래 ‘모임 내용’의 소제목으로 연결돼요.</p></section>';}
  function conceptsHtml(record){
    var selected=record.concepts.find(function(item){return item.id===state.editingConcept;})||record.concepts[0];state.editingConcept=selected?selected.id:null;
    return '<section class="mr-edit-section mr-divider"><div class="mr-section-head"><h2>함께 살펴본 개념</h2>'+button(icon('plus')+'키워드 추가','add-concept','mr-link',record.concepts.length>=limits.concepts?'disabled':'')+'</div><div class="mr-keywords">'+record.concepts.map(function(item){return button(esc(item.word||'새 키워드'),'edit-concept','mr-keyword','data-id="'+esc(item.id)+'" aria-pressed="'+(item.id===state.editingConcept)+'"');}).join('')+'</div>'+(selected?'<div class="mr-keyword-editor"><label class="mr-field"><span>키워드</span><input type="text" maxlength="'+limits.word+'" data-mr-concept="'+esc(selected.id)+'" data-part="word" value="'+esc(selected.word)+'" placeholder="예: 감정 알아차리기"></label><label class="mr-field"><span>의미</span><textarea maxlength="'+limits.meaning+'" rows="3" data-mr-concept="'+esc(selected.id)+'" data-part="meaning" placeholder="키워드를 누르면 보일 설명을 적어주세요.">'+esc(selected.meaning)+'</textarea></label><div class="mr-keyword-remove">'+button('이 키워드 삭제','remove-concept','mr-link','data-id="'+esc(selected.id)+'"')+'</div></div>':'<div class="mr-empty">키워드와 의미를 하나씩 추가해보세요.</div>')+undoHtml('concept')+'</section>';
  }
  function editorHtml(record){return '<div class="mr-body"><h1 id="mr-dialog-title" class="mr-edit-title">모임의 이야기를 남겨요</h1><p class="mr-editor-book">'+esc(book().title)+'</p>'+(state.dirty?'<div class="mr-notice">작성 중인 내용을 이어서 편집하고 있어요.</div>':'')+'<div class="mr-fields-row"><label class="mr-field"><span>모임 회차</span><input type="number" min="1" max="9999" step="1" inputmode="numeric" data-mr-field="round" value="'+esc(record.round)+'" aria-label="모임 회차"></label><label class="mr-field"><span>모임 날짜</span><input type="date" data-mr-field="date" value="'+esc(record.date)+'"></label></div><label class="mr-field"><span>모임 주제</span><input type="text" maxlength="'+limits.topic+'" data-mr-field="topic" value="'+esc(record.topic)+'" placeholder="이번 모임에서 함께 나눈 주제"><small>모임 주제가 기록의 제목으로 표시돼요.</small></label>'+outlineHtml(record)+conceptsHtml(record)+questionsHtml(record,true)+'<section class="mr-edit-section mr-divider"><div class="mr-section-head"><h2>모임 내용</h2><span class="mr-auto">핵심 요약과 연결</span></div><p class="mr-subtitle">각 주제 아래에 모임에서 나눈 내용을 풀어 적어주세요.</p>'+record.sections.map(function(section,i){return '<label class="mr-field mr-detail-field"><span><span class="mr-number">'+(i+1)+'.</span><span data-mr-heading="'+esc(section.id)+'">'+esc(section.summary||'새 주제를 입력해주세요.')+'</span></span><textarea maxlength="'+limits.detail+'" rows="4" data-mr-section="'+esc(section.id)+'" data-part="detail" placeholder="이 주제에 대해 나눈 이야기와 생각">'+esc(section.detail)+'</textarea></label>';}).join('')+(!record.sections.length?'<div class="mr-empty">위에서 핵심 요약의 주제를 추가해주세요.</div>':'')+'</section>'+preparationHtml(record,true)+carouselHtml(record)+resourcesHtml(record,true)+'</div>';}
  function actionsHtml(){
    if(state.view==='list')return '';
    if(state.view==='edit'||state.preview){var published=state.record&&state.record.status==='published';return '<div class="mr-actions"><span class="mr-note" data-mr-save-note>'+ (published?'저장하면 게시한 기록에 반영돼요.':'임시 저장한 기록은 나에게만 보여요.')+'</span>'+(state.preview?button('PDF 저장','download-record'):'')+(!published?button('임시 저장','save-draft'):'')+button(published?'수정 저장':'게시하기','publish','mr-button mr-primary')+'</div>';}
    return '<div class="mr-actions"><p class="mr-print-help">PDF 파일을 바로 내려받습니다.</p>'+button('PDF 저장','download-record')+(editable(state.record)?button('기록 삭제','delete','mr-link mr-danger')+button(state.record.status==='draft'?'이어서 작성':'내용 수정','edit'):'')+'</div>';
  }
  function render(preserveScroll,focus){
    if(!dialog||!state)return;
    if(!allowed(state.bookId)){close(false,true);return;}
    if((state.view==='edit'||state.preview)&&!editable(state.draft)){close(false,true);return;}
    var old=dialog.querySelector('.mr-body'),scroll=preserveScroll&&old?old.scrollTop:0;
    if(carouselDispose){carouselDispose();carouselDispose=null;}
    dialog.innerHTML=topHtml()+(state.view==='list'?listHtml():state.view==='edit'&&!state.preview?editorHtml(state.draft):readHtml(state.preview?state.draft:state.record))+actionsHtml()+(state.view==='list'?'':'<div class="mr-message" role="status" aria-live="polite" data-mr-message></div>');
    setMessage(state.view==='list'?'':state.error,state.conflict);setBusy(busy);bindCarousel();
    var body=dialog.querySelector('.mr-body');if(body)body.scrollTop=scroll;
    if(focus){var target=Array.from(dialog.querySelectorAll(focus.selector)).find(function(node){return !focus.id||node.getAttribute(focus.attribute||'data-id')===focus.id;});if(target)target.focus({preventScroll:true});}
  }
  function setMessage(message,conflict){if(!dialog)return;var target=dialog.querySelector('[data-mr-message]');if(!target)return;target.textContent=message||'';if(conflict){var show=document.createElement('button');show.type='button';show.className='mr-link';show.setAttribute('data-mr-action','conflict');show.textContent='최신 기록 확인';target.appendChild(show);}}
  function setBusy(value){busy=value;if(dialog)dialog.querySelectorAll('button,input,textarea,select').forEach(function(node){if(value){node.dataset.mrDisabled=String(node.disabled);node.disabled=true;}else if(node.dataset.mrDisabled!==undefined){node.disabled=node.dataset.mrDisabled==='true';delete node.dataset.mrDisabled;}});if(subdialog)subdialog.querySelectorAll('button,input').forEach(function(node){node.disabled=value;});}
  function markDirty(){state.dirty=true;state.error='';snapshotDraft();setMessage('');}
  function handleInput(event){
    if(!state||state.view!=='edit'||state.preview||busy||!editable(state.draft))return;
    var node=event.target,field=node.getAttribute('data-mr-field'),id=node.getAttribute('data-mr-section'),conceptId=node.getAttribute('data-mr-concept'),questionId=node.getAttribute('data-mr-question'),part=node.getAttribute('data-part'),item;
    var nextField=node.getAttribute('data-mr-next');
    if(preparationFields.indexOf(nextField)>=0){if(!state.draft.nextMeeting)state.draft.nextMeeting=emptyPreparation();state.draft.nextMeeting[nextField]=node.value;markDirty();}
    if(['date','topic','round'].indexOf(field)>=0){state.draft[field]=field==='round'?node.value:node.value;markDirty();}
    if(id&&['summary','detail'].indexOf(part)>=0){item=state.draft.sections.find(function(row){return row.id===id;});if(item){item[part]=node.value;markDirty();if(part==='summary')dialog.querySelectorAll('[data-mr-heading]').forEach(function(heading){if(heading.getAttribute('data-mr-heading')===id)heading.textContent=node.value||'새 주제를 입력해주세요.';});}}
    if(conceptId&&['word','meaning'].indexOf(part)>=0){item=state.draft.concepts.find(function(row){return row.id===conceptId;});if(item){item[part]=node.value;markDirty();if(part==='word')dialog.querySelectorAll('[data-mr-action="edit-concept"]').forEach(function(chip){if(chip.getAttribute('data-id')===conceptId)chip.textContent=node.value||'새 키워드';});}}
    if(questionId){item=(state.draft.thoughtQuestions||[]).find(function(row){return row.id===questionId;});if(item){item.text=node.value;markDirty();}}
  }
  function handleChange(event){if(event.target.getAttribute('data-mr-field')==='round'&&state&&state.view==='edit'&&!busy){handleInput(event);refreshCarousel();}}
  function refreshCarousel(){if(carouselDispose){carouselDispose();carouselDispose=null;}var section=dialog&&dialog.querySelector('[data-mr-carousel]');if(section){state.slide=0;section.outerHTML=carouselHtml(state.draft);bindCarousel();}}
  function handleClick(event){
    var target=event.target.closest('[data-mr-action]');if(!target||target.disabled||busy||!state)return;
    if(!allowed(state.bookId)){close(false,true);return;}
    var action=target.getAttribute('data-mr-action'),id=target.getAttribute('data-id'),record=state.draft,item,index;
    if(action==='close'){close();return;}
    if(action==='list'){snapshotDraft();closeSub(false);state.view='list';state.requestedRound=null;state.draft=null;state.preview=false;state.error='';state.conflict=false;render();loadRows();return;}
    if(action==='retry'){loadRows();return;}
    if(action==='record'){openRecord(byId(id));return;}
    if(action==='create'){beginEdit(null);return;}
    if(action==='edit'){beginEdit(state.record);return;}
    if(action==='jump-section'){jumpToSection(id);return;}
    if(action==='download-record'){downloadMeeting();return;}
    if(action==='concept'){openConcept(id,target);return;}
    if(action==='material'){navigateOriginal('material',id);return;}
    if(action==='delete'){confirmDelete(target);return;}
    if(action==='conflict'){openConflict(target);return;}
    if(!record||!editable(record))return;
    if(action==='editor-mode'||action==='preview-mode'){snapshotDraft();state.preview=action==='preview-mode';state.view='edit';render();return;}
    if(action==='save-draft'||action==='publish'){save(action==='publish'?'published':'draft');return;}
    if(action==='materials'){openMaterials(target);return;}
    if(action==='edit-concept'){state.editingConcept=id;render(true,{selector:'[data-mr-action="edit-concept"]',id:id});return;}
    if(action==='add-section'&&record.sections.length<limits.sections){item={id:uuid(),summary:'',detail:''};record.sections.push(item);markDirty();render(true,{selector:'[data-mr-section][data-part="summary"]',id:item.id,attribute:'data-mr-section'});return;}
    if(action==='remove-section'){index=record.sections.findIndex(function(row){return row.id===id;});if(index>=0)state.undo={kind:'section',index:index,item:record.sections.splice(index,1)[0]};}
    else if(action==='add-concept'&&record.concepts.length<limits.concepts){item={id:uuid(),word:'',meaning:''};record.concepts.push(item);state.editingConcept=item.id;markDirty();render(true,{selector:'[data-mr-concept][data-part="word"]',id:item.id,attribute:'data-mr-concept'});return;}
    else if(action==='remove-concept'){index=record.concepts.findIndex(function(row){return row.id===id;});if(index>=0)state.undo={kind:'concept',index:index,item:record.concepts.splice(index,1)[0]};}
    else if(action==='add-question'&&(record.thoughtQuestions||[]).length<limits.questions){item={id:uuid(),text:''};if(!record.thoughtQuestions)record.thoughtQuestions=[];record.thoughtQuestions.push(item);markDirty();render(true,{selector:'[data-mr-question]',id:item.id,attribute:'data-mr-question'});return;}
    else if(action==='remove-question'){index=(record.thoughtQuestions||[]).findIndex(function(row){return row.id===id;});if(index>=0)state.undo={kind:'question',index:index,item:record.thoughtQuestions.splice(index,1)[0]};}
    else if(action==='undo'&&state.undo){var undo=state.undo,items=undo.kind==='section'?record.sections:undo.kind==='question'?(record.thoughtQuestions||[]):record.concepts;if(items.length>=(undo.kind==='section'?limits.sections:undo.kind==='question'?limits.questions:limits.concepts))return;items.splice(undo.index,0,undo.item);if(undo.kind==='concept')state.editingConcept=undo.item.id;state.undo=null;}
    else if(action==='remove-material'){record.materialIds=record.materialIds.filter(function(value){return value!==id;});}
    else return;
    markDirty();render(true);
  }
  function jumpToSection(id){
    var record=state.preview?state.draft:state.record;
    if(!record||!record.sections.some(function(section){return section.id===id;}))return;
    var body=dialog.querySelector('.mr-body'),target=Array.from(dialog.querySelectorAll('[data-mr-story]')).find(function(node){return node.getAttribute('data-mr-story')===id;});
    if(!body||!target)return;
    var top=target.getBoundingClientRect().top-body.getBoundingClientRect().top+body.scrollTop-14;
    target.focus({preventScroll:true});
    var reduced=root.matchMedia&&root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    body.scrollTo({top:Math.max(0,top),behavior:reduced?'instant':'smooth'});
  }
  function downloadMeeting(){
    if(busy||!state||!allowed(state.bookId))return;
    var record=state.preview?state.draft:state.record;if(!record)return;
    var downloader=root.GrowellMeetingRecordsPrint;
    if(!downloader||typeof downloader.downloadRecord!=='function'||typeof app.getAccessToken!=='function'){setMessage('PDF 저장 기능을 불러오지 못했어요. 페이지를 새로 열어주세요.');return;}
    var node=dialog,viewState=state,bookId=state.bookId,id=++request,preview=state.preview,task,outputRecord=clone(normalize(record));
    outputRecord.round=Number(outputRecord.round);
    if(preview)outputRecord.status='draft';
    function active(){return dialog===node&&state===viewState&&request===id&&allowed(bookId);}
    state.error='';busy=true;render(true);setMessage('PDF 파일을 준비하고 있어요.');
    try{task=downloader.downloadRecord(root,outputRecord,{preview:preview,getAccessToken:app.getAccessToken,isCurrent:active});}
    catch(error){task=Promise.reject(error);}
    downloadCancel=typeof task.cancel==='function'?task.cancel:null;
    Promise.resolve(task).then(function(){if(active())app.showToast('PDF 파일을 내려받았어요.');}).catch(function(error){
      if(active())state.error=error&&error.message&&/[가-힣]/.test(error.message)?error.message:'PDF를 내려받지 못했어요. 잠시 후 다시 저장해주세요.';
    }).finally(function(){if(active()){busy=false;downloadCancel=null;render(true);}});
  }
  function openConcept(id,trigger){
    var record=state.preview?state.draft:state.record;if(!record)return;
    var item=record.concepts.find(function(row){return row.id===id;});if(!item)return;
    subShell('<small>함께 살펴본 개념</small><h2 id="mr-sub-title">'+esc(item.word||'새 키워드')+'</h2>','<p class="mr-meaning">'+esc(item.meaning||'아직 작성한 의미가 없어요.')+'</p>','',trigger);
  }
  function openMaterials(trigger){
    snapshotDraft();var draft=state.draft,selected=draft.materialIds.slice(),rows=ownMaterials();
    var node=subShell('<small>관련 자료 연결</small><h2 id="mr-sub-title">내가 올린 자료</h2>','<p class="mr-subtitle">이 책의 자료실에 직접 올린 글을 선택해주세요.</p>'+(rows.length?rows.map(function(row){return '<label class="mr-pick"><input type="checkbox" data-mr-pick="'+esc(row.id)+'" '+(selected.indexOf(row.id)>=0?'checked':'')+'><span><strong>'+esc(row.title||'자료실 글')+'</strong><small>'+esc(materialType(row))+(row.date?' · '+esc(dateText(row.date)):'')+'</small></span></label>';}).join(''):'<div class="mr-empty">이 책의 자료실에 직접 올린 자료가 아직 없어요.</div>')+'<p class="mr-message" data-mr-pick-message role="status"></p>','<span class="mr-note" data-mr-pick-count>'+selected.length+'개 선택</span>'+button('취소','close-sub')+button('선택한 자료 연결','attach','mr-button mr-primary'),trigger);
    node.addEventListener('change',function(event){var id=event.target.getAttribute('data-mr-pick');if(!id||!editable(draft))return;if(event.target.checked&&selected.length>=limits.materials){event.target.checked=false;node.querySelector('[data-mr-pick-message]').textContent='자료는 최대 '+limits.materials+'개까지 연결할 수 있어요.';return;}selected=event.target.checked?Array.from(new Set(selected.concat(id))):selected.filter(function(value){return value!==id;});node.querySelector('[data-mr-pick-count]').textContent=selected.length+'개 선택';});
    node.addEventListener('click',function(event){if(!event.target.closest('[data-mr-action="attach"]')||busy||!editable(draft)||state.draft!==draft)return;draft.materialIds=selected;markDirty();closeSub(false);render(true,{selector:'[data-mr-action="materials"]'});});
  }
  function navigateOriginal(kind,id){
    if(busy||!state||!allowed(state.bookId))return;
    var bookId=state.bookId,record=state.view==='edit'||state.preview?state.draft:state.record;
    if(kind==='post'&&!insightRows(record).some(function(row){return row.id===id;}))return;
    if(kind==='material'&&(!record||record.materialIds.indexOf(id)<0||!materialRows().some(function(row){return row.id===id;})))return;
    snapshotDraft();if(!close(false))return;if(kind==='post')app.openPost(id,bookId);else app.openMaterial(id,bookId);
  }
  function validation(record){
    var domain=root.GrowellMeetingRecordsDomain;if(domain&&domain.validateRecord)return domain.validateRecord(record);
    var errors=[];if(!Number.isInteger(Number(record.round))||Number(record.round)<1||Number(record.round)>9999)errors.push('모임 회차를 1부터 9999 사이의 숫자로 입력해주세요.');
    if(record.status==='published'){if(!String(record.topic).trim())errors.push('모임 주제를 입력해주세요.');if(!/^\d{4}-\d{2}-\d{2}$/.test(record.date))errors.push('모임 날짜를 입력해주세요.');if(!record.sections.length||record.sections.some(function(row){return !row.summary.trim()||!row.detail.trim();}))errors.push('핵심 요약과 연결된 모임 내용을 입력해주세요.');if(record.concepts.some(function(row){return !row.word.trim()||!row.meaning.trim();}))errors.push('각 키워드와 의미를 함께 입력해주세요.');}
    return {ok:!errors.length,errors:errors};
  }
  function save(status){
    if(busy||!editable(state.draft))return;
    snapshotDraft();var payload=clone(state.draft);payload.status=status;payload.round=Number(payload.round);payload=normalize(payload);
    var result=validation(payload);if(!result.ok){state.error=(result.errors||['입력한 내용을 확인해주세요.']).join('\n');setMessage(state.error);return;}
    var node=dialog,bookId=state.bookId,id=++request,oldRevision=Number(payload.revision)||0;
    state.error='';setMessage('저장 중이에요…');setBusy(true);
    Promise.resolve().then(function(){if(!allowed(bookId)||!editable(payload))throw new Error('Permission changed');return app.saveRecord(payload);}).then(function(response){
      if(dialog!==node||id!==request||!allowed(bookId))return;
      var saved=normalize(response);if(!saved||saved.id!==payload.id||saved.bookId!==bookId||saved.userId!==member()||saved.status!==status||Number(saved.revision)<=oldRevision)throw new Error('저장 결과를 확인하지 못했어요.');
      delete drafts[recordKey(payload)];state.rows=state.rows.filter(function(row){return row.id!==saved.id;}).concat([saved]);state.draft=null;state.dirty=false;busy=false;openRecord(saved);app.showToast(status==='draft'?'모임 기록을 임시 저장했어요.':'모임 기록을 게시했어요.');
    }).catch(function(error){
      if(dialog!==node||id!==request||!allowed(bookId))return;
      state.conflict=!!(error&&(error.code==='40001'||error.code==='23505'||error.code==='CONFLICT'||error.status===409));
      state.error=state.conflict?'다른 곳에서 이 기록이 변경되었거나 같은 회차의 기록이 생겼어요. 최신 기록을 확인해주세요. 작성 중인 내용은 그대로 있어요.':(error&&error.message&&/[가-힣]/.test(error.message)?error.message:'저장하지 못했어요. 작성 중인 내용은 그대로 있으니 다시 시도해주세요.');
      setMessage(state.error,state.conflict);
    }).finally(function(){if(dialog===node&&id===request){setBusy(false);}});
  }
  function confirmDelete(trigger){
    var record=state.record;if(!editable(record))return;
    var node=subShell('<h2 id="mr-sub-title">모임 기록을 삭제할까요?</h2>','<p class="mr-intro">'+esc(record.topic||'작성 중인 모임 기록')+'<br>연결된 회원 통찰과 자료실 원본 글은 유지돼요.</p><p class="mr-message" data-mr-delete-message role="status"></p>',button('취소','close-sub')+button('기록 삭제','confirm-delete','mr-button mr-danger'),trigger);
    node.addEventListener('click',function(event){if(!event.target.closest('[data-mr-action="confirm-delete"]')||busy||!editable(record))return;
      var main=dialog,id=++request;setBusy(true);node.querySelector('[data-mr-delete-message]').textContent='삭제 중이에요…';
      Promise.resolve().then(function(){if(!editable(record))throw new Error('Permission changed');return app.deleteRecord(record);}).then(function(result){
        if(dialog!==main||subdialog!==node||id!==request||!allowed(record.bookId))return;if(result===false||result&&result.error)throw result&&result.error||new Error('Delete failed');
        delete drafts[recordKey(record)];setBusy(false);closeSub(false);state.rows=state.rows.filter(function(row){return row.id!==record.id;});state.record=null;state.view='list';state.error='';render();app.showToast('모임 기록을 삭제했어요.');
      }).catch(function(error){if(dialog!==main||subdialog!==node||id!==request)return;node.querySelector('[data-mr-delete-message]').textContent=error&&error.code==='40001'?'다른 곳에서 기록이 변경되었어요. 목록을 새로 불러온 뒤 확인해주세요.':'삭제하지 못했어요. 잠시 후 다시 시도해주세요.';}).finally(function(){if(dialog===main&&id===request)setBusy(false);});
    });
  }
  function openConflict(trigger){
    var draft=state.draft,bookId=state.bookId;
    var node=subShell('<h2 id="mr-sub-title">최신 기록 확인</h2>','<div class="mr-intro" data-mr-conflict-body>최근 저장된 기록을 불러오는 중이에요…</div>','',trigger);
    Promise.resolve().then(function(){return app.loadRecords(bookId);}).then(function(rows){
      if(subdialog!==node||!allowed(bookId)||state.draft!==draft)return;
      var saved=validRows(rows).find(function(row){return row.id===draft.id;});
      var body=node.querySelector('[data-mr-conflict-body]');
      if(!saved){body.textContent='이 기록이 삭제되었거나 같은 회차의 다른 기록이 있어요. 작성 화면에서 회차를 확인해주세요.';return;}
      body.innerHTML='<p class="mr-note">최근 저장된 내용이에요. 현재 작성 중인 내용은 작성 화면에 유지돼요.</p><div class="mr-conflict-copy"><strong>'+esc(saved.topic||'작성 중인 기록')+'</strong>\n'+esc(dateText(saved.date))+' · '+esc(saved.round)+'번째 모임\n\n'+saved.sections.map(function(item,i){return esc((i+1)+'. '+item.summary+'\n'+item.detail);}).join('\n\n')+'</div><p class="mr-note">다시 시작을 누르면 작성 중인 내용을 최근 저장된 내용으로 바꿔요.</p>';
      var actions=document.createElement('div');actions.className='mr-actions';actions.innerHTML=button('작성 내용 유지','close-sub')+button('최신 기록으로 다시 시작','use-latest','mr-button mr-primary');node.appendChild(actions);
      actions.querySelector('[data-mr-action="use-latest"]').addEventListener('click',function(){if(!editable(saved))return;delete drafts[recordKey(draft)];state.rows=state.rows.filter(function(row){return row.id!==saved.id;}).concat(saved);closeSub(false);beginEdit(saved);});
    }).catch(function(){if(subdialog===node)node.querySelector('[data-mr-conflict-body]').textContent='최신 기록을 불러오지 못했어요. 작성 중인 내용은 유지돼요.';});
  }
  function bindCarousel(){
    var panel=dialog&&dialog.querySelector('[data-mr-carousel]'),track=panel&&panel.querySelector('[data-mr-track]');if(!track)return;
    var cards=Array.from(track.querySelectorAll('[data-mr-post]')),previous=panel.querySelector('[data-mr-action="previous"]'),next=panel.querySelector('[data-mr-action="next"]'),counter=panel.querySelector('[data-mr-count]'),dots=Array.from(panel.querySelectorAll('.mr-dots span'));
    var listeners=[],observer=null,drag=null,index=Math.max(0,Math.min(state.slide,cards.length-1)),suppressUntil=0,disposed=false,scrollFrame=null,trackWidth=track.clientWidth;
    function on(node,type,handler,options){node.addEventListener(type,handler,options);listeners.push(function(){node.removeEventListener(type,handler,options);});}
    function left(card){return card.getBoundingClientRect().left-track.getBoundingClientRect().left+track.scrollLeft;}
    function closest(){var value=0,distance=Infinity;cards.forEach(function(card,i){var d=Math.abs(left(card)-track.scrollLeft);if(d<distance){value=i;distance=d;}});return value;}
    function fitHeight(){
      if(disposed||!cards[index])return;
      // Offscreen long answers must not stretch the current card or its track.
      var height=cards[index].getBoundingClientRect().height;if(!(height>0))return;
      var style=root.getComputedStyle(track),size=Math.ceil(height+(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0))+'px';
      if(track.style.height!==size)track.style.height=size;
      if(track.scrollTop)track.scrollTop=0;
    }
    function controls(){if(!state||disposed)return;state.slide=index;previous.disabled=busy||index===0;next.disabled=busy||index===cards.length-1;counter.textContent=(index+1)+' / '+cards.length;dots.forEach(function(dot,i){dot.classList.toggle('is-active',i===index);});fitHeight();}
    function go(value,smooth){index=Math.max(0,Math.min(cards.length-1,value));controls();var reduced=root.matchMedia&&root.matchMedia('(prefers-reduced-motion: reduce)').matches;track.scrollTo({left:left(cards[index]),behavior:smooth&&!reduced?'smooth':'instant'});}
    on(previous,'click',function(){go(index-1,true);});on(next,'click',function(){go(index+1,true);});
    on(track,'scroll',function(){if(drag||disposed||scrollFrame)return;scrollFrame=root.requestAnimationFrame(function(){scrollFrame=null;if(!disposed){index=closest();controls();}});},{passive:true});
    on(track,'keydown',function(event){
      if(event.altKey||event.ctrlKey||event.metaKey)return;
      var card=event.target.closest('[data-mr-post]');
      if(card&&(event.key==='Enter'||event.key===' ')){event.preventDefault();navigateOriginal('post',card.getAttribute('data-mr-post'));return;}
      var to=event.key==='ArrowRight'?index+1:event.key==='ArrowLeft'?index-1:event.key==='Home'?0:event.key==='End'?cards.length-1:null;if(to!==null){event.preventDefault();go(to,true);if(card)cards[index].focus({preventScroll:true});}
    });
    on(track,'dragstart',function(event){event.preventDefault();});
    on(track,'pointerdown',function(event){
      if(event.button!==0||event.isPrimary===false)return;
      drag={id:event.pointerId,type:event.pointerType,x:event.clientX,y:event.clientY,left:track.scrollLeft,index:index,moved:false};
    });
    on(track,'pointermove',function(event){
      if(!drag||drag.id!==event.pointerId)return;var dx=event.clientX-drag.x,dy=event.clientY-drag.y;
      if(!drag.moved){if(Math.abs(dx)<8&&Math.abs(dy)<8)return;drag.moved=true;suppressUntil=Date.now()+500;if(drag.type==='mouse'&&Math.abs(dy)>Math.abs(dx)){drag=null;return;}if(drag.type==='mouse'){track.classList.add('is-dragging');track.setPointerCapture(event.pointerId);}}
      // Touch scrolling stays native; only mouse dragging sets scrollLeft.
      if(drag.type==='mouse'){event.preventDefault();track.scrollLeft=drag.left-dx;}
    });
    function finish(event,cancelled){
      if(!drag||drag.id!==event.pointerId)return;var ended=drag;drag=null;track.classList.remove('is-dragging');if(track.hasPointerCapture(event.pointerId))track.releasePointerCapture(event.pointerId);
      if(!ended.moved)return;suppressUntil=Date.now()+500;
      if(ended.type==='mouse'){var to=closest(),distance=track.scrollLeft-ended.left;if(!cancelled&&to===ended.index&&Math.abs(distance)>Math.min(70,track.clientWidth*.16))to+=distance>0?1:-1;go(to,true);}
    }
    on(track,'pointerup',function(event){finish(event,false);});on(track,'pointercancel',function(event){finish(event,true);});on(track,'lostpointercapture',function(event){finish(event,true);});
    on(track,'pointerleave',function(event){if(drag&&drag.id===event.pointerId&&!drag.moved)drag=null;});
    on(track,'click',function(event){if(Date.now()<suppressUntil&&event.detail!==0){event.preventDefault();event.stopImmediatePropagation();return;}var card=event.target.closest('[data-mr-post]');if(card){event.preventDefault();navigateOriginal('post',card.getAttribute('data-mr-post'));}},true);
    go(index,false);if(root.ResizeObserver){observer=new root.ResizeObserver(function(){
      if(disposed)return;
      if(!drag&&track.clientWidth!==trackWidth){trackWidth=track.clientWidth;go(index,false);}else fitHeight();
    });observer.observe(track);cards.forEach(function(card){observer.observe(card);});}
    carouselDispose=function(){disposed=true;listeners.forEach(function(remove){remove();});if(observer)observer.disconnect();if(scrollFrame)root.cancelAnimationFrame(scrollFrame);};
  }
  return {configure:configure,launchHtml:launchHtml,bind:bind,openList:openList,openRound:openRound,close:close,reset:reset};
});
