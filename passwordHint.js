(function(root,factory){
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellPasswordHint=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var questions=[
    {id:'first_school',label:'처음 다닌 학교 이름은 무엇인가요?'},
    {id:'childhood_place',label:'어릴 때 살던 동네는 어디인가요?'},
    {id:'childhood_nickname',label:'어릴 때 별명은 무엇인가요?'},
    {id:'memorable_book',label:'기억에 남는 책 제목은 무엇인가요?'},
    {id:'favorite_place',label:'기억에 남는 장소는 어디인가요?'}
  ];
  function normalizeAnswer(value){return value.normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase();}
  function validate(value,options){
    if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.questionId!=='string')throw new Error('비밀번호 확인 질문을 선택해주세요.');
    var legacy=value.questionId==='legacy'&&options&&options.legacy===true;
    if(!legacy&&!questions.some(function(question){return question.id===value.questionId;}))throw new Error('비밀번호 확인 질문을 선택해주세요.');
    if(typeof value.answer!=='string'||!value.answer.trim())throw new Error(legacy?'기존에 등록한 힌트를 입력해주세요.':'선택한 질문의 답을 입력해주세요.');
    if(!legacy&&value.answer.length>200)throw new Error('질문의 답은 200자 이내로 입력해주세요.');
    return {questionId:value.questionId,answer:legacy?value.answer.trim():normalizeAnswer(value.answer)};
  }
  async function encode(value,options){
    var hint=validate(value,options);
    if(hint.questionId==='legacy')return hint.answer;
    var bytes=new TextEncoder().encode(JSON.stringify([hint.questionId,hint.answer]));
    var hash=await root.crypto.subtle.digest('SHA-256',bytes);
    return 'gwq1:'+Array.from(new Uint8Array(hash),function(byte){return byte.toString(16).padStart(2,'0');}).join('');
  }
  function formHtml(prefix,options){
    if(!/^(su|fp|pe)$/.test(prefix))throw new Error('Unknown hint form');
    return '<label class="field-label" for="'+prefix+'-hint-question">비밀번호 확인 질문</label><select id="'+prefix+'-hint-question" class="password-hint-question" required><option value="">질문을 선택해주세요</option>'+questions.map(function(question){return '<option value="'+question.id+'">'+question.label+'</option>';}).join('')+(options&&options.legacy?'<option value="legacy">기존 힌트로 확인</option>':'')+'</select><label class="field-label" for="'+prefix+'-hint">질문의 답</label><input type="text" id="'+prefix+'-hint" autocomplete="off"'+(options&&options.legacy?'':' maxlength="200"')+' required placeholder="선택한 질문의 답을 입력해주세요">';
  }
  function readForm(document,prefix){var question=document.getElementById(prefix+'-hint-question'),answer=document.getElementById(prefix+'-hint');return {questionId:question?question.value:'',answer:answer?answer.value:''};}
  return {questions:questions.map(function(question){return Object.freeze(question);}),normalizeAnswer:normalizeAnswer,validate:validate,encode:encode,formHtml:formHtml,readForm:readForm};
});
