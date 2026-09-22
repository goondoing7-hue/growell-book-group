const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const source=html.slice(html.indexOf('var RT_ALLOWED_TAGS ='),html.indexOf('function sanitizeHtml('));

function text(value){return {nodeType:3,textContent:value,cloneNode(){return text(value);}};}
function element(tag,attrs={},children=[]){return {nodeType:1,tagName:tag.toUpperCase(),attrs:{...attrs},childNodes:children,
  getAttribute(key){return this.attrs[key]??null;},setAttribute(key,value){this.attrs[key]=value;},appendChild(child){this.childNodes.push(child);}};}
function sanitizer(){const context={document:{createElement:tag=>element(tag)}};vm.createContext(context);vm.runInContext(source,context);return context.rtSanitizeNode;}
function tree(node){return node.nodeType===3?node.textContent:{tag:node.tagName,attrs:node.attrs,children:node.childNodes.map(tree)};}

test('native FONT after replacing selected text retains text color, highlight and size through repeated saves',()=>{
  const sanitize=sanitizer();
  const input=element('font',{color:'#2d6694',size:'5',style:'background-color: rgb(184, 230, 199);'},[text('다시 입력한 한글 문장')]);
  const once=sanitize(input)[0],twice=sanitize(once)[0];
  assert.deepEqual(tree(once),{tag:'FONT',attrs:{color:'#2d6694',size:'5',style:'background-color:rgb(184, 230, 199)'},children:['다시 입력한 한글 문장']});
  assert.deepEqual(tree(twice),tree(once));
});

test('FONT allows only validated color, size, foreground and background styles; other attributes never survive',()=>{
  const sanitize=sanitizer();
  const input=element('font',{color:' blue ',size:'3',face:'untrusted-font',class:'unsafe',id:'unsafe',onclick:'attack()',onmouseover:'attack()',style:'color: rgb(45, 102, 148); background-color: #B8E6C7; position:fixed; background-image:url(https://example.org/track); font-size:1000px;'},[text('색과 강조만 유지')]);
  const output=sanitize(input)[0];
  assert.deepEqual(output.attrs,{size:'3',color:'blue',style:'color:rgb(45, 102, 148);background-color:#B8E6C7'});
});

test('unsafe FONT color attributes and CSS values are rejected without discarding Korean text',()=>{
  const sanitize=sanitizer();
  for(const color of ['red;background-color:blue','url(https://example.org/track)','expression(alert(1))','var(--unsafe)','red!important','"><img src=x onerror=attack()>']){
    const output=sanitize(element('font',{color,size:'99',style:'color:expression(alert(1));background-color:url(https://example.org/track);'},[text('본문은 그대로')]))[0];
    assert.deepEqual(output.attrs,{},color);
    assert.equal(output.childNodes[0].textContent,'본문은 그대로');
  }
});

test('nested formatting survives inside colored FONT while executable descendants are still dropped',()=>{
  const sanitize=sanitizer();
  const input=element('font',{color:'#2D6694',style:'background-color:rgba(184, 230, 199, 0.8)'},[
    element('strong',{onclick:'attack()'},[text('굵은 문장')]),
    element('span',{style:'color:purple;top:0',onload:'attack()'},[text('다른 색')]),
    element('script',{},[text('attack()')]),element('img',{src:'x',onerror:'attack()'})
  ]);
  assert.deepEqual(tree(sanitize(input)[0]),{tag:'FONT',attrs:{color:'#2D6694',style:'background-color:rgba(184, 230, 199, 0.8)'},children:[
    {tag:'STRONG',attrs:{},children:['굵은 문장']},{tag:'SPAN',attrs:{style:'color:purple'},children:['다른 색']}
  ]});
});

function photoRenderer(){
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const context={URL,esc,sanitizeHtml:value=>String(value||''),nlToBr:esc,stripHtml:value=>value.replace(/<[^>]*>/g,''),
    noteTypeOf:()=>null,fontSizeOf:()=>({cls:''}),BG_COLORS:[{key:'#fff1da'}],INSIGHT_QUESTIONS:[],
    NOTE_TYPES:[],SESSION:{userId:'synthetic-reader'},composerEditId:()=>null,composerDraftKey:()=> 'test-draft',composerDrafts:{},
    rtToolbarHtml:()=>'',svgIcon:()=>'',I_IMG:'',I_CLOSE:'',I_COMMENT:'',I_LOCK:''};
  vm.createContext(context);
  function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
  vm.runInContext(section('function safePhotoUrl(', 'function photoFromUrl(')+
    section('function noteComposerHtml(', 'function noteCtaHtml(')+
    section('function noteBodyHtml(', 'function commentsForPost(')+
    section('function spaceStoryHtml(', 'function spaceHeadingHtml(')+
    section('function materialNoteBodyBlockHtml(', 'function materialNoteCardHtml('),context);
  function renders(photo){
    const payload={title:'지켜야 할 제목',html:'<p>지켜야 할 본문</p>',photo:{dataUrl:photo}};
    const detail=context.noteBodyHtml(payload);
    return [detail.mediaHtml+detail.bodyHtml,context.spaceStoryHtml(payload,'#/book/emotion/mine/post/test'),
      context.noteComposerHtml({id:'emotion',area:'감정',accent:'emotion'},{containerId:'mine-composer',editingPost:payload,heading:'기록',closeId:'close',submitId:'save'}),
      context.materialNoteBodyBlockHtml(payload)];
  }
  return {context,renders};
}

test('photo renderer accepts HTTP and raster data images while escaping URL query separators',()=>{
  const {context,renders}=photoRenderer();
  for(const url of ['https://example.org/photo.jpg?width=640&height=480','http://localhost:3000/photo.png',
    'data:image/jpeg;base64,AQID','data:image/png;base64,AQID','data:image/webp;base64,AQID','data:image/gif;base64,AQID']){
    assert.equal(context.safePhotoUrl(url),url);
    for(const markup of renders(url)){
      assert.match(markup,/<img /);assert.ok(markup.includes('src="'+context.esc(url)+'"'));
      assert.ok(markup.includes('지켜야 할 본문'));
    }
  }
});

test('public, private, editor and material photo views reject URL attribute injection and executable schemes',()=>{
  const {context,renders}=photoRenderer();
  for(const url of ['https://example.org/x" onerror="attack()',"https://example.org/x' onerror='attack()",
    'javascript:attack()','data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,AQID" onerror="attack()',
    '//example.org/photo.jpg','file:///secret.jpg','blob:https://example.org/test',
    'https://example.org/\nphoto.jpg','https://','https://member:password@example.org/private.jpg',null,{}]){
    assert.equal(context.safePhotoUrl(url),null,String(url));
    for(const markup of renders(url)){
      assert.doesNotMatch(markup,/<img\b|onerror\s*=/i,String(url));
      assert.ok(markup.includes('지켜야 할 본문'),'invalid photo must not discard the note text');
    }
  }
});
