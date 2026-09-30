(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellHabitSuggestions=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  var values=[
    {
      "id": "faith",
      "label": "성",
      "hanja": "聖",
      "title": "하나님과 함께 정하는 삶의 방향",
      "summary": "하나님과 소통하며 오늘의 마음과 선택을 돌아보는 가치예요.",
      "description": "성은 하나님께 마음을 열고, 그분과의 관계 안에서 삶의 방향을 살피는 거룩의 가치예요. 거룩을 나의 노력으로 완성하려 하기보다, 은혜를 구하며 매일의 삶에서 하나님께 응답하는 태도를 뜻해요.",
      "why": "기도와 말씀을 위한 작은 시간을 정해요. 은혜로 주어지는 거룩을 기억하며 하나님과의 관계 안에서 하루를 살아가요.",
      "reflection": "오늘의 선택 가운데 하나님께 여쭙고 싶은 것은 무엇인가요?",
      "examples": [
        {
          "keyword": "기도",
          "action": "하루를 시작하며 감사 한 가지와 오늘의 마음을 하나님께 말씀드려요."
        },
        {
          "keyword": "묵상",
          "action": "성경 한 구절을 읽고 오늘의 삶과 이어지는 생각을 한 줄 적어요."
        },
        {
          "keyword": "필사",
          "action": "성경 한 구절을 천천히 쓰고 마음에 남는 단어에 표시해요."
        },
        {
          "keyword": "통독",
          "action": "정해 둔 순서로 성경 한 단락을 읽고 다음에 읽을 곳을 표시해요."
        }
      ],
      "meaning": "거룩",
      "headline": "하나님께 마음을 열고,\n하루의 방향을 찾다.",
      "lead": "하나님께 받은 은혜에 응답하며 삶의 방향을 살펴요.",
      "question": "오늘 하나님께 여쭙고 싶은 것은 무엇인가요?"
    },
    {
      "id": "love",
      "label": "애",
      "hanja": "愛",
      "title": "받은 사랑을 사람에게 전하는 마음",
      "summary": "하나님께 받은 사랑을 가까운 사람에게 구체적으로 전하는 가치예요.",
      "description": "애는 하나님으로부터 받은 사랑을 다른 사람에게 흘려보내는 가치예요. 보답을 먼저 계산하기보다 상대를 소중히 여기고, 그 사람에게 필요한 관심을 건네는 마음이에요.",
      "why": "소중한 마음은 표현할 때 상대에게 닿아요. 짧은 안부와 따뜻한 말 한마디로 사랑을 일상의 관계 속에 이어 가요.",
      "reflection": "오늘 내가 관심을 건네고 싶은 사람은 누구인가요?",
      "examples": [
        {
          "keyword": "대화",
          "action": "가까운 사람에게 오늘 어땠는지 묻고 휴대폰을 내려놓고 들어요."
        },
        {
          "keyword": "연락",
          "action": "생각나는 한 사람에게 오늘 안부를 묻는 짧은 메시지를 보내요."
        },
        {
          "keyword": "칭찬",
          "action": "상대에게서 발견한 좋은 행동 한 가지를 구체적으로 말해요."
        }
      ],
      "meaning": "사랑",
      "headline": "내가 받은 사랑을,\n한 사람에게 건네다.",
      "lead": "하나님께 받은 사랑을 가까운 사람에게 구체적으로 전해요.",
      "question": "오늘 관심을 건네고 싶은 사람은 누구인가요?"
    },
    {
      "id": "virtue",
      "label": "덕",
      "hanja": "德",
      "title": "작은 선택으로 쌓아 가는 성품",
      "summary": "배려와 절제, 용서와 인내를 생활 속 선택으로 쌓아 가는 가치예요.",
      "description": "덕은 옳다고 여기는 것을 실제 행동으로 옮기며 길러 가는 성품이에요. 배려, 절제, 용서, 관용과 인내처럼 함께 살아가는 사람을 넓게 품는 태도를 포함해요.",
      "why": "성품은 되풀이하는 작은 행동에 드러나요. 먼저 인사하고 잠시 양보하는 연습으로 함께 살아갈 마음을 넓혀요.",
      "reflection": "오늘 조금 더 배려하거나 절제할 수 있는 순간은 언제인가요?",
      "examples": [
        {
          "keyword": "인사",
          "action": "오늘 만나는 사람 한 명에게 먼저 눈을 맞추고 반갑게 인사해요."
        },
        {
          "keyword": "양보",
          "action": "순서나 자리를 다투고 싶을 때 한 번 멈추고 상대를 배려해요."
        },
        {
          "keyword": "봉사",
          "action": "함께 쓰는 공간에서 누군가에게 도움이 되는 작은 일 하나를 맡아요."
        },
        {
          "keyword": "절제",
          "action": "충동적으로 하고 싶은 일이 생기면 잠시 멈추고 필요한지 살펴요."
        }
      ],
      "meaning": "성품",
      "headline": "작은 선택을 쌓아,\n되고 싶은 나에 가까이.",
      "lead": "배려와 절제, 용서와 인내를 생활 속 선택으로 길러요.",
      "question": "오늘 조금 더 배려할 수 있는 순간은 언제인가요?"
    },
    {
      "id": "wisdom",
      "label": "지",
      "hanja": "智",
      "title": "배운 것을 연결해 삶에 쓰는 지혜",
      "summary": "읽고 배우고 생각한 것을 연결해 실제 문제를 풀어 가는 가치예요.",
      "description": "지는 정보를 많이 아는 데서 더 나아가, 서로 다른 생각을 연결하고 판단하는 힘이에요. 읽기와 쓰기, 집중과 분석, 질문과 창의적인 시도를 통해 배운 것을 삶의 문제에 적용해요.",
      "why": "배운 것을 내 말로 정리하면 어디에 쓸지 발견할 수 있어요. 조금씩 읽고 다시 생각하며 이해를 생활 속 선택으로 옮겨요.",
      "reflection": "오늘 배운 것 한 가지를 내 생활의 어디에 써 볼 수 있을까요?",
      "examples": [
        {
          "keyword": "독서",
          "action": "고른 책의 정해 둔 분량을 읽고 기억하고 싶은 생각 한 줄을 남겨요."
        },
        {
          "keyword": "공부",
          "action": "궁금한 주제 하나를 10분 동안 살펴보고 내 말로 설명해요."
        },
        {
          "keyword": "복습",
          "action": "오늘 배운 내용 한 가지를 자료를 덮고 떠올려 짧게 적어요."
        },
        {
          "keyword": "자격증",
          "action": "준비하는 분야의 문제 한 개를 풀고 답의 이유를 확인해요."
        },
        {
          "keyword": "자기개발",
          "action": "기르고 싶은 능력 하나를 정해 오늘 해 볼 작은 연습을 10분 해요."
        }
      ],
      "meaning": "지혜",
      "headline": "배운 것을 연결해,\n내 삶의 답을 찾아가다.",
      "lead": "읽고 배우고 생각한 것을 연결해 실제 문제를 풀어 가요.",
      "question": "오늘 배운 것을 내 생활의 어디에 써 볼까요?"
    },
    {
      "id": "emotion",
      "label": "정",
      "hanja": "情",
      "title": "내 마음을 알고 다른 마음에 귀 기울이기",
      "summary": "감정을 알아차리고 나와 다른 사람의 마음을 헤아리는 가치예요.",
      "description": "정은 기쁨과 슬픔을 느끼는 마음을 소중히 여기고, 감정을 섬세하게 알아가는 가치예요. 내 마음을 표현하면서 다른 사람의 이야기도 듣고, 함께 기뻐하고 슬퍼할 수 있는 공감을 길러요.",
      "why": "마음에도 알아차리고 표현할 시간이 필요해요. 일기와 경청으로 감정을 살피며 함께 기뻐하고 슬퍼할 자리를 만들어요.",
      "reflection": "오늘 가장 선명했던 감정과 그 뒤에 있던 바람은 무엇인가요?",
      "examples": [
        {
          "keyword": "일기",
          "action": "오늘의 감정 한 단어와 그 감정을 느낀 순간을 한 줄 적어요."
        },
        {
          "keyword": "경청",
          "action": "상대의 말을 끝까지 듣고 내가 이해한 마음이 맞는지 물어요."
        },
        {
          "keyword": "산책",
          "action": "잠깐 걸으며 주변 풍경과 지금 내 마음에 함께 주의를 기울여요."
        },
        {
          "keyword": "위로",
          "action": "힘든 사람에게 조언을 서두르지 않고 마음을 알아주는 말을 건네요."
        }
      ],
      "meaning": "공감",
      "headline": "내 마음에 귀 기울여,\n다른 마음을 이해하다.",
      "lead": "감정을 알아차리고 나와 다른 사람의 마음을 헤아려요.",
      "question": "오늘 내 마음에 가장 오래 남은 감정은 무엇인가요?"
    },
    {
      "id": "beauty",
      "label": "미",
      "hanja": "美",
      "title": "아름다움을 발견하고 나답게 표현하기",
      "summary": "자연과 예술, 일상에서 아름다움을 발견하고 표현하는 가치예요.",
      "description": "미는 하나님이 만드신 세상의 질서와 아름다움을 발견하고, 마음에 와닿은 것을 표현하는 가치예요. 음악과 그림 같은 예술뿐 아니라 생활 공간을 정돈하고 작은 풍경을 감상하는 일에도 아름다움을 담을 수 있어요.",
      "why": "익숙한 것에도 잠시 시선을 머물러 보세요. 감상하고 만들고 정돈하는 습관이 느낀 아름다움을 삶 속에 담아 줘요.",
      "reflection": "오늘 눈길이나 마음이 머물렀던 아름다움은 무엇인가요?",
      "examples": [
        {
          "keyword": "청소",
          "action": "책상 위 한 곳을 정돈하고 그 공간을 기분 좋게 바라봐요."
        },
        {
          "keyword": "음악",
          "action": "음악 한 곡에 집중하고 마음에 남는 느낌을 한 단어로 적어요."
        },
        {
          "keyword": "예술",
          "action": "작품 한 점을 감상하고 마음에 닿은 부분과 이유를 한 줄 남겨요."
        }
      ],
      "meaning": "아름다움",
      "headline": "일상의 아름다움을,\n나만의 표현으로 남기다.",
      "lead": "하나님이 만드신 세상의 아름다움을 발견하고 나답게 표현해요.",
      "question": "오늘 눈길이나 마음이 머문 아름다움은 무엇인가요?"
    },
    {
      "id": "body",
      "label": "체",
      "hanja": "體",
      "title": "삶을 받쳐 주는 몸을 소중히 돌보기",
      "summary": "하나님이 주신 몸의 상태를 살피고 움직임과 쉼을 챙기는 가치예요.",
      "description": "체는 하루를 살아가는 몸을 소중히 여기고 꾸준히 돌보는 가치예요. 몸은 배우고 사랑하고 실천하는 일의 바탕이므로, 나의 상태에 맞는 움직임과 식사, 휴식에 관심을 기울여요.",
      "why": "몸은 배우고 사랑하고 실천하는 하루의 바탕이에요. 내 상태에 맞는 작은 돌봄을 정해 삶의 다른 가치도 함께 받쳐 줘요.",
      "reflection": "오늘 내 몸에 필요한 것은 움직임인가요, 쉼인가요?",
      "examples": [
        {
          "keyword": "운동",
          "action": "오늘 몸 상태를 살피고 나에게 맞는 가벼운 운동을 5분 해요."
        },
        {
          "keyword": "달리기",
          "action": "오늘 몸 상태에 맞춰 짧게 달리고 필요하면 걸으며 쉬어요."
        },
        {
          "keyword": "호흡",
          "action": "편안히 앉아 잠시 자연스럽게 숨 쉬는 느낌에 주의를 기울여요."
        },
        {
          "keyword": "식단",
          "action": "한 끼 식사를 준비할 때 먹을 음식의 구성을 한 번 살펴요."
        },
        {
          "keyword": "수면",
          "action": "정해 둔 시각에 하던 일을 마무리하고 잠들 준비를 시작해요."
        },
        {
          "keyword": "걷기",
          "action": "오늘의 일상에서 걸을 수 있는 짧은 구간 하나를 정해 걸어요."
        },
        {
          "keyword": "스트레칭",
          "action": "오래 앉아 있었다면 잠시 일어나 편안한 범위에서 몸을 풀어요."
        }
      ],
      "meaning": "몸돌봄",
      "headline": "나의 하루를 받치는 몸,\n움직임과 쉼으로 돌보다.",
      "lead": "하나님이 주신 몸의 상태를 살피고 움직임과 쉼을 챙겨요.",
      "question": "지금 내 몸에 필요한 것은 움직임인가요, 쉼인가요?"
    }
  ];

  var guidebook={
    "title": "좋은 습관은, 좋은 방향에서.",
    "intro": "어떤 사람이 되고 싶은지, 오늘 무엇을 해 볼지. 성·애·덕·지·정·미·체는 그 두 질문을 연결하는 일곱 가지 가치예요. 마음에 머문 가치를 반복할 수 있는 작은 행동으로 바꾸어 보세요.",
    "whyTitle": "왜 일곱 가지 가치일까요?",
    "why": "하나님이 창조하신 우리는 영성을 지닌 존재이며, 감성과 지성, 육체가 함께 어우러져 살아가요. 이 모든 면이 고르게 자라도록 삶을 일곱 가치로 살펴봐요.\n\n성·애·덕·지·정·미·체는 서로 구분되지만 따로 떨어져 있지 않아요. 서로 이어지며 한 사람의 인격과 실력을 이루고, 하나의 실천 안에서도 함께 자랄 수 있어요.\n\n음식을 골고루 먹듯 여러 가치를 균형 있게 돌보며 오늘의 습관을 정해요. 매일 일곱 가지를 모두 채울 필요는 없어요. 지금 필요한 한 가지 작은 실천부터 시작해 보세요.",
    "connection": "가치는 서로 이어져 있어요. 책을 읽으며 지혜를 배우고, 등장인물의 마음에 공감하고, 배운 것을 누군가를 돕는 행동으로 옮길 수 있어요. 같은 산책도 몸을 움직이는 데 마음을 두면 체, 내 감정을 살피는 데 마음을 두면 정이 돼요. 지금 내가 기르고 싶은 뜻을 기준으로 골라 보세요.",
    "steps": [
      {
        "title": "가치 하나 고르기",
        "text": "지금 내 삶에 필요한 방향을 살펴요."
      },
      {
        "title": "작은 약속 만들기",
        "text": "키워드를 골라 언제, 어디서, 얼마나 할지 정해요."
      },
      {
        "title": "실천하고 돌아보기",
        "text": "해낸 날에는 체크해요. 어려웠다면 더 작게, 다시 시작해요."
      }
    ],
    "closing": "체크의 개수로 나의 가치를 평가하지 않아요. 오늘의 작은 행동이 내가 소중히 여기는 방향을 향했는지, 그것을 천천히 살펴보세요.",
    "lead": "소중히 여기는 가치 하나를, 오늘의 작은 행동으로.",
    "whyBody": "하나님이 창조하신 우리는 영성을 지닌 존재이며, 감성과 지성, 육체가 함께 어우러져 살아가요. 이 모든 면이 고르게 자라도록 삶을 일곱 가치로 살펴봐요.\n\n성·애·덕·지·정·미·체는 서로 구분되지만 따로 떨어져 있지 않아요. 서로 이어지며 한 사람의 인격과 실력을 이루고, 하나의 실천 안에서도 함께 자랄 수 있어요.\n\n음식을 골고루 먹듯 여러 가치를 균형 있게 돌보며 오늘의 습관을 정해요. 매일 일곱 가지를 모두 채울 필요는 없어요. 지금 필요한 한 가지 작은 실천부터 시작해 보세요."
  };

  function copy(value){
    if(Array.isArray(value))return value.map(copy);
    if(value&&typeof value==='object'){
      var result={};
      Object.keys(value).forEach(function(key){result[key]=copy(value[key]);});
      return result;
    }
    return value;
  }
  function categories(){return copy(values);}
  function suggestions(kind,category){
    if(kind!=='do'&&kind!=='avoid')return [];
    var value=values.filter(function(item){return item.id===category;})[0];
    if(!value)return [];
    return value.examples.map(function(example){return example.keyword;}).filter(function(keyword){
      return kind!=='avoid'||keyword!=='독서';
    });
  }
  // Names stay on this device. These rules suggest a value; they do not infer a
  // person's intent. Explicit choices are retained by the caller.
  var inferenceRules={
    faith:[
      [20,/감사기도|새벽기도|성경읽|성경필사|말씀묵상|하나님과|주님과/],
      [8,/하나님|예수|주님|성경|말씀|예배|찬양|신앙|영성|경건|중보|큐티/],
      [16,/\b(?:pray(?:er|ing|s)?|bible|scripture|devotional|worship|praise|faith|spiritual)\b/,true],
      [20,/\b(?:read(?:ing)? (?:the )?bible|bible study|thanksgiving prayer)\b/,true]
    ],
    love:[
      [20,/부모님안부|가족안부|친구안부|안부묻|안부전|감사전|사랑표현|고마움전|감사편지/],
      [8,/가족|부모님|엄마|아빠|친구|배우자|부부|연인|안부|편지|전화|사랑|고마움|감사인사/],
      [16,/\b(?:family|parents?|friends?|spouse|relationship|love|call(?:ing)?|contact|conversation|compliment|letter)\b/,true]
    ],
    virtue:[
      [20,/소비줄이|지출줄이|충동구매|과소비|낭비줄이|욕줄이|말조심|약속지키|시간약속|쓰레기줍|일회용품줄이|분리수거/],
      [8,/배려|용서|인내|정직|친절|예의|존중|기부|나눔|절약|저축|검소|책임|약속|금연|금주|줄이기|덜쓰기/],
      [16,/\b(?:volunteer(?:ing)?|donat(?:e|ion|ing)|kindness|courtesy|patience|forgiv(?:e|eness|ing)|honesty|restraint|budget(?:ing)?|sav(?:e|ing)|recycl(?:e|ing))\b/,true]
    ],
    wisdom:[
      [20,/책읽|책한권|독후감|독서노트|영어단어|외국어|자기계발|자기개발|문제풀|문제해결|머신러닝|딥러닝|강의듣|기사읽|뉴스읽/],
      [8,/학습|예습|학업|시험|영어|중국어|일본어|단어|어휘|문법|수학|과학|역사|코딩|프로그래밍|강의|강좌|배우기|암기|문제집|지식/],
      [16,/\b(?:read(?:ing)?|books?|stud(?:y|ying)|learn(?:ing)?|review|vocabulary|english|language|coding|programming|course|lecture|certification|homework|self[- ]development)\b/,true],
      [20,/\b(?:machine learning|deep learning|learn(?:ing)? (?:english|vocabulary)|review(?:ing)? notes)\b/,true]
    ],
    emotion:[
      [20,/감사일기|감정일기|마음일기|감정기록|기분기록|마음돌보|마음챙김|이야기들어|마음나누|감정표현/],
      [8,/감정|기분|공감|마음|명상|심호흡|스트레스|감사기록/],
      [16,/\b(?:journal(?:ing)?|diary|emotion(?:s|al)?|feeling(?:s)?|empathy|listen(?:ing)?|comfort|mindfulness|meditat(?:e|ion|ing)|gratitude)\b/,true],
      [20,/\b(?:gratitude journal|gratitude diary|record(?:ing)? feelings|active listening)\b/,true]
    ],
    beauty:[
      [20,/방정리|집정리|책상정리|옷장정리|공간정리|주변정리|설거지|침구정돈|침대정리|음악감상|미술감상|전시관람|꽃가꾸|사진찍/],
      [8,/정돈|미술|그림|그리기|노래|악기|피아노|기타연습|연주|작곡|공예|도예|전시|사진|꾸미기|꽃꽂이|정원/],
      [16,/\b(?:clean(?:ing)?|tidy(?:ing)?|declutter(?:ing)?|music|art|arts|paint(?:ing)?|draw(?:ing)?|sing(?:ing)?|piano|guitar|craft(?:s)?|museum|photography|garden(?:ing)?)\b/,true],
      [20,/\b(?:listen(?:ing)? to music|learn(?:ing)? (?:the )?(?:piano|guitar)|organi[sz](?:e|ing) (?:my |the )?(?:room|desk))\b/,true]
    ],
    body:[
      [20,/물마시|물먹|물한잔|수분섭취|수분보충|일찍자|일찍일어|제때자|잠자기|잠들기|잠자리에|아침먹|아침식사|끼니챙기|건강식|계단오르|숨쉬기|몸풀기|러닝머신/],
      [8,/체조|요가|필라테스|헬스|근력|스쿼트|팔굽혀|수영|자전거|등산|러닝|조깅|취침|기상|휴식|수분|양치|비타민|영양|식사|식습관|야식/],
      [16,/\b(?:exercis(?:e|ing)|workout|fitness|run(?:ning)?|jog(?:ging)?|walk(?:ing)?|stretch(?:ing)?|yoga|swim(?:ming)?|cycl(?:e|ing)|breath(?:e|ing)?|sleep(?:ing)?|bedtime|water|hydrat(?:e|ion|ing)|diet|nutrition|meal(?:s)?|rest)\b/,true]
    ]
  };
  function inferValueId(name){
    if(typeof name!=='string')return '';
    var text=name.normalize('NFKC').toLowerCase().trim().replace(/\s+/g,' ');
    if(!text)return '';
    // The actual picker vocabulary always wins, including 산책 → 정.
    for(var i=0;i<values.length;i++){
      if(values[i].examples.some(function(example){return text===example.keyword;}))return values[i].id;
    }
    var compact=text.replace(/\s+/g,'');
    var bestId='virtue',bestScore=0;
    values.forEach(function(value){
      var score=0;
      value.examples.forEach(function(example){
        if(text.indexOf(example.keyword)>=0)score+=12;
      });
      inferenceRules[value.id].forEach(function(rule){
        // Compact Korean phrases tolerate spacing. English uses word boundaries
        // on the original text, so "art" does not accidentally match "start".
        if(rule[1].test(rule[2]?text:compact))score+=rule[0];
      });
      // Equal scores use the stable 성·애·덕·지·정·미·체 order. An unknown
      // non-empty name means keeping a small promise, under 덕.
      if(score>bestScore){bestId=value.id;bestScore=score;}
    });
    return bestId;
  }
  function guide(){return copy(guidebook);}
  return {categories:categories,suggestions:suggestions,guide:guide,inferValueId:inferValueId};
});
