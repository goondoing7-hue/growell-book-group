(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellHabitSuggestions=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var areas=[
    {id:'emotion',label:'감정'},
    {id:'thought',label:'생각'},
    {id:'body',label:'신체'},
    {id:'action',label:'행동'}
  ];
  var examples={
    do:{
      emotion:[
        '오늘 감정 한 단어 적기',
        '고마운 일 한 가지 적기',
        '기분 좋았던 순간 떠올리기',
        '나에게 위로 한마디 쓰기',
        '좋아하는 음악 한 곡 듣기',
        '가까운 사람에게 안부 전하기'
      ],
      thought:[
        '떠오른 생각 한 줄 적기',
        '오늘 배운 것 한 가지 정리하기',
        '궁금한 질문 하나 적기',
        '서로 다른 의견 한 번 들어보기',
        '결정하기 전 이유 적어보기',
        '하루를 돌아보는 문장 쓰기'
      ],
      body:[
        '가볍게 10분 걷기',
        '몸을 천천히 3분 풀기',
        '앉아 있다가 잠깐 일어나기',
        '물 한 잔 마시기',
        '식사할 때 천천히 씹기',
        '잠들기 전 화면 잠깐 내려놓기'
      ],
      action:[
        '오늘 할 일 세 가지 적기',
        '책상 위 한 곳 정리하기',
        '미뤄둔 작은 일 하나 시작하기',
        '약속 시간 5분 전에 준비하기',
        '사용한 물건 제자리에 두기',
        '내일 필요한 물건 미리 챙기기'
      ]
    },
    avoid:{
      emotion:[
        '화난 채로 메시지 보내지 않기',
        '나를 낮추는 말 하지 않기',
        '상대의 기분을 혼자 단정하지 않기',
        '서운한 마음을 비꼬는 말로 전하지 않기',
        '부탁을 듣자마자 무조건 수락하지 않기',
        'SNS를 보며 나를 비교하지 않기'
      ],
      thought:[
        '확인하지 않은 정보 퍼뜨리지 않기',
        '제목만 보고 내용 단정하지 않기',
        '실수 하나로 하루 전체 평가하지 않기',
        '답을 정해두고 검색하지 않기',
        '생각 정리 중 다른 앱 열지 않기',
        '상대의 설명을 끝까지 듣기 전에 판단하지 않기'
      ],
      body:[
        '잠자리에서 영상 이어 보지 않기',
        '식사 중 휴대폰 보지 않기',
        '걸으면서 휴대폰 보지 않기',
        '쉬는 시간에 화면만 보지 않기',
        '몸을 움직일 때 무리해서 속도 내지 않기',
        '잠들 준비를 하다 알림 확인하지 않기'
      ],
      action:[
        '할 일 시작 전 SNS 열지 않기',
        '필요하지 않은 물건 충동구매하지 않기',
        '사용한 물건 그대로 두지 않기',
        '알람을 여러 번 미루지 않기',
        '대화 중 휴대폰 확인하지 않기',
        '할 일을 여러 개 동시에 벌이지 않기'
      ]
    }
  };
  function categories(){return areas.map(function(area){return {id:area.id,label:area.label};});}
  function suggestions(kind,category){
    if((kind!=='do'&&kind!=='avoid')||!areas.some(function(area){return area.id===category;}))return [];
    return examples[kind][category].slice();
  }
  return {categories:categories,suggestions:suggestions};
});
