const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
function harness(){
  const c={SESSION:{userId:'owner',name:'내 이름'},location:{hash:'#/'},isAdmin:()=>false,canAccessWorksheet:()=>true,isBookLocked:()=>false,esc,I_LOCK:'lock',
    headerAvatarHtml:()=>'<span data-avatar></span>',headerThemeHtml:()=>'<button data-theme-control></button>',svgIcon:()=>'<svg data-lock-icon aria-hidden="true"></svg>',
    readingDataReady:()=>true,myCurrentPage:()=>42,GrowellBookDetails:{coverHtml:()=>'<button data-book-cover></button>',hintHtml:()=>'<span data-reading-hint>읽는 부분</span>'},
    adminLockPanelHtml:()=>'<div data-admin-lock></div>',lockedBookGateHtml:()=>'<section data-book-lock></section>'};
  for(const [fn,name] of [['mineTabHtml','mine'],['shareTabHtml','share'],['worksheetTabHtml','worksheet'],['materialsTabHtml','materials'],['habitTabHtml','habit']]){
    c[fn]=(book,postId)=>'<section data-space="'+name+'" data-book="'+book.id+'"'+(postId?' data-post="'+postId+'"':'')+'></section>';
  }
  vm.createContext(c);vm.runInContext(section('function headerHtml(','function footerHtml(')+section('function bookPageHtml(','/* ---------------- master render')+section('function currentRoute(){',"window.addEventListener('hashchange'"),c);
  return c;
}
function navigation(c,route){const header=c.headerHtml(route);return header.match(/<nav class="primary-nav[^>]*>[\s\S]*?<\/nav>/)[0];}
function links(html){return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([,attrs,body])=>({href:attrs.match(/href="([^"]+)"/)[1],active:/aria-current="page"/.test(attrs),attrs,label:body.replace(/<svg[\s\S]*?<\/svg>/g,'').replace(/<[^>]+>/g,'')}));}
function book(id='emotion'){return {id,area:{emotion:'감정',thought:'생각',body:'신체',action:'행동'}[id],accent:id,title:id+'의 책',subtitle:'책 소개'};}

test('main navigation shows six spaces in order and links directly to the existing emotion routes',()=>{
  const c=harness(),nav=navigation(c,{view:'home'}),items=links(nav);
  assert.deepEqual(items.map(item=>item.label),['홈','나의 공간','나눔','활동지','자료실','습관']);
  assert.deepEqual(items.map(item=>item.href),['#/','#/book/emotion/mine','#/book/emotion/share','#/book/emotion/worksheet','#/book/emotion/materials','#/book/emotion/habit']);
  assert.deepEqual(items.filter(item=>item.active).map(item=>item.label),['홈']);
  assert.doesNotMatch(nav,/아카이브|>감정<|>생각<|>신체<|>행동</);
  assert.equal((c.headerHtml({view:'home'}).match(/<nav /g)||[]).length,1);
});

test('current menu follows the exact space including post details without marking unrelated legacy or account routes active',()=>{
  const c=harness();
  for(const [tab,label] of [['mine','나의 공간'],['share','나눔'],['worksheet','활동지'],['materials','자료실'],['habit','습관']]){
    for(const postId of [undefined,'record-id']){
      const selected=links(navigation(c,{view:'book',bookId:'emotion',tab,postId})).filter(item=>item.active);
      assert.equal(selected.length,1);assert.equal(selected[0].label,label);
    }
  }
  assert.equal(links(navigation(c,{view:'book',bookId:'emotion'})).find(item=>item.active).label,'나의 공간');
  for(const route of [{view:'archive'},{view:'login'},{view:'profile-edit'},{view:'admin-users'},...['thought','body','action'].map(bookId=>({view:'book',bookId,tab:'mine'}))]){
    assert.equal(links(navigation(c,route)).filter(item=>item.active).length,0);
  }
});

test('worksheet access remains indicated in the new menu without disabling the route or disclosing worksheet content',()=>{
  const c=harness();c.canAccessWorksheet=id=>{assert.equal(id,'emotion');return false;};
  const item=links(navigation(c,{view:'book',bookId:'emotion',tab:'worksheet'})).find(item=>item.label==='활동지');
  assert.equal(item.href,'#/book/emotion/worksheet');assert.equal(item.active,true);
  assert.match(item.attrs,/aria-label="활동지 · 잠김"/);assert.match(item.attrs,/title="관리자가 잠근 활동지예요\."/);assert.doesNotMatch(item.attrs,/disabled/);
  assert.match(navigation(c,{view:'home'}),/data-lock-icon/);
  c.canAccessWorksheet=()=>true;assert.doesNotMatch(navigation(c,{view:'home'}),/data-lock-icon|활동지 · 잠김/);
});

test('emotion pages keep their cover, title and matching content with no duplicate tabs, while other books retain their original tabs',()=>{
  const c=harness();
  for(const tab of ['mine','share','worksheet','materials','habit']){
    const html=c.bookPageHtml(book(),tab,'record-id');
    assert.doesNotMatch(html,/class="book-tabs"|data-book-tab=/);
    assert.match(html,/data-book-cover/);assert.match(html,/emotion의 책/);assert.match(html,/data-reading-hint/);
    assert.ok(html.includes('data-space="'+tab+'"'));assert.match(html,/id="book-tab-body"/);
  }
  for(const id of ['thought','body','action']){
    const html=c.bookPageHtml(book(id),'materials','record-id');
    assert.match(html,/class="book-tabs"/);assert.equal((html.match(/data-book-tab=/g)||[]).length,5);
    assert.ok(html.includes('data-book-id="'+id+'"'));assert.ok(html.includes('data-space="materials" data-book="'+id+'" data-post="record-id"'));
  }
  c.isBookLocked=()=>true;const locked=c.bookPageHtml(book(),'mine');assert.match(locked,/data-book-lock/);assert.doesNotMatch(locked,/data-space=|id="book-tab-body"/);
});

test('existing book, post and archive URLs still resolve without remapping or losing their identifiers',()=>{
  const c=harness();
  for(const id of ['emotion','thought','body','action']){
    c.location.hash='#/book/'+id;assert.equal(c.currentRoute().bookId,id);assert.equal(c.currentRoute().tab,'mine');
    for(const tab of ['mine','share','worksheet','materials','habit']){
      c.location.hash='#/book/'+id+'/'+tab+'/post/saved-id';const route=c.currentRoute();
      assert.equal(route.view,'book');assert.equal(route.bookId,id);assert.equal(route.tab,tab);assert.equal(route.postId,'saved-id');
    }
  }
  c.location.hash='#/archive';assert.equal(c.currentRoute().view,'archive');
});
