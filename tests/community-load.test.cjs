const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function harness({admin=true,worksheetGate=null}={}){
  const gate=deferred(),requests=[];
  const server={
    profiles:[{id:'owner',name:'원래 이름',avatar_url:'old-avatar',auth_user_id:'auth-owner',is_admin:admin},{id:'other',name:'다른 회원'}],
    posts:[{id:'p1',user_id:'owner',book_id:'emotion',title:'원래 제목',html:'<p>원래 글</p>'},{id:'p2',user_id:'other',book_id:'emotion',title:'원격에서 삭제된 글'}],
    comments:[{id:'c1',user_id:'owner',post_id:'p1',text:'원래 댓글'}],
    material_notes:[{id:'m1',user_id:'owner',book_id:'emotion',html:'원래 자료',drive_links:[]}],
    worksheets:[{id:'w1',user_id:'owner',book_id:'emotion',activity_key:'reflection',data:{answer:'원래 응답'}}],
    book_locks:[{book_id:'emotion',locked:false,note:'원래 설정'}],
    announcement:[{book_id:'global',next_date:'2026-09-25',next_time:'19:00',reading_book_id:'emotion',reading_range:'1장'}]
  };
  let renderCount=0;
  const c={Promise,SESSION:{userId:'owner'},saveSessionEpoch:1,sharedPostsLoadState:'idle',render(){renderCount++;},
    STATE:{users:{},posts:{},comments:{},materialNotes:{},worksheets:{},bookLocks:{},announcement:{next:{date:'2026-09-25',time:'19:00',place:'',note:''},reading:{bookId:'emotion',meetingNo:'',chapter:'',range:'1장',concept:'',note:''}},privateEntries:{private:{iv:'encrypted',data:'secret'}},habits:{keep:{name:'개인 습관'}},readingLogs:{keep:{seconds:10}}},
    sb:{from(table){requests.push(table);return {select(){return (table==='worksheets'&&worksheetGate?worksheetGate.promise:gate.promise).then(()=>server[table] instanceof Error?{error:server[table],data:null}:{data:clone(server[table]),error:null});}};}}
  };
  vm.createContext(c);vm.runInContext(section('function photoFromUrl(', '\nvar STATE ='),c);
  vm.runInContext(section('function currentUser()', 'function isAdmin()'),c);
  const mappings=[['profiles','users','mapProfileRow','id'],['posts','posts','mapPostRow','id'],['comments','comments','mapCommentRow','id'],['material_notes','materialNotes','mapMaterialNoteRow','id'],['worksheets','worksheets','mapWorksheetRow','id'],['book_locks','bookLocks','mapBookLockRow','book_id']];
  for(const [table,key,mapper,id] of mappings)for(const row of server[table])c.STATE[key][row[id]]=c[mapper](clone(row),c.STATE.users);
  return {c,server,requests,finish:()=>gate.resolve(),renders:()=>renderCount};
}

test('a slow community read keeps newly saved posts and changed profiles, then maps author names from the merged profiles',async()=>{
  const h=harness(),pending=h.c.loadCommunityForCurrentMember();
  h.c.STATE.users.owner.name='수정한 이름';h.c.STATE.users.owner.avatar='new-avatar';
  h.c.STATE.posts.p1={...h.c.STATE.posts.p1,title:'저장한 최신 제목'};
  h.c.STATE.posts.new={id:'new',userId:'owner',bookId:'emotion',title:'방금 저장한 글'};
  h.c.STATE.users.new={id:'new',name:'방금 가입한 회원'};
  h.server.posts.push({id:'server-added',user_id:'owner',book_id:'emotion',title:'서버의 새 글'});
  h.finish();await pending;
  assert.equal(h.c.STATE.users.owner.name,'수정한 이름');assert.equal(h.c.STATE.users.owner.avatar,'new-avatar');
  assert.equal(h.c.STATE.posts.p1.title,'저장한 최신 제목');assert.equal(h.c.STATE.posts.new.title,'방금 저장한 글');
  assert.equal(h.c.STATE.users.new.name,'방금 가입한 회원');assert.equal(h.c.STATE.posts['server-added'].userName,'수정한 이름');
  assert.equal(h.c.sharedPostsLoadState,'ready');assert.equal(h.renders(),1);
});
test('deleting rows during the request never resurrects stale server rows from any collection',async()=>{
  const h=harness(),pending=h.c.loadCommunityForCurrentMember();
  const keys={users:'other',posts:'p1',comments:'c1',materialNotes:'m1',worksheets:'w1',bookLocks:'emotion',announcement:'next'};
  for(const [collection,id] of Object.entries(keys))delete h.c.STATE[collection][id];
  h.finish();await pending;
  for(const [collection,id] of Object.entries(keys))assert.equal(Object.hasOwn(h.c.STATE[collection],id),false,collection+' deletion was preserved');
});
test('in-place nested edits to comments, materials, worksheets, locks and an announcement survive the response',async()=>{
  const h=harness(),pending=h.c.loadCommunityForCurrentMember();
  h.c.STATE.comments.c1.text='수정한 댓글';h.c.STATE.materialNotes.m1.driveLinks.push({url:'https://example.com/reading'});
  h.c.STATE.worksheets.w1.data.answer='수정한 응답';h.c.STATE.bookLocks.emotion.locked=true;
  h.c.STATE.announcement.next.date='2026-10-02';h.server.announcement[0].reading_range='새로운 2장';
  h.finish();await pending;
  assert.equal(h.c.STATE.comments.c1.text,'수정한 댓글');assert.equal(h.c.STATE.materialNotes.m1.driveLinks.length,1);
  assert.equal(h.c.STATE.worksheets.w1.data.answer,'수정한 응답');assert.equal(h.c.STATE.bookLocks.emotion.locked,true);
  assert.equal(h.c.STATE.announcement.next.date,'2026-10-02');assert.equal(h.c.STATE.announcement.reading.range,'새로운 2장');
});
test('unchanged cloned rows accept newer remote values and remote deletions',async()=>{
  const h=harness(),pending=h.c.loadCommunityForCurrentMember();
  h.c.STATE=clone(h.c.STATE);h.server.posts[0].title='원격 최신 제목';h.server.posts=h.server.posts.filter(row=>row.id!=='p2');
  h.server.profiles[0].name='원격 최신 이름';h.finish();await pending;
  assert.equal(h.c.STATE.posts.p1.title,'원격 최신 제목');assert.equal(h.c.STATE.posts.p2,undefined);
  assert.equal(h.c.STATE.users.owner.name,'원격 최신 이름');
  assert.equal(h.c.STATE.privateEntries.private.data,'secret');assert.equal(h.c.STATE.habits.keep.name,'개인 습관');assert.equal(h.c.STATE.readingLogs.keep.seconds,10);
});
test('a failed collection response does not partially install any community data',async()=>{
  const h=harness(),pending=h.c.loadCommunityForCurrentMember();
  h.c.STATE.posts.local={id:'local',title:'요청 중 저장'};const expected=clone(h.c.STATE);
  h.server.profiles[0].name='서버 이름';h.server.comments=new Error('network failed');h.finish();await pending;
  assert.deepEqual(clone(h.c.STATE),expected);assert.equal(h.c.sharedPostsLoadState,'error');assert.equal(h.renders(),1);
});
test('logout or a new session epoch ignores an old successful community response',async()=>{
  for(const switchOwner of [false,true]){
    const h=harness(),pending=h.c.loadCommunityForCurrentMember();h.c.saveSessionEpoch++;
    h.c.SESSION=switchOwner?{userId:'next-member'}:null;h.c.STATE=clone(h.c.STATE);h.c.STATE.users.owner.name='새 세션 상태';
    h.c.sharedPostsLoadState='idle';const expected=clone(h.c.STATE);h.finish();await pending;
    assert.deepEqual(clone(h.c.STATE),expected);assert.equal(h.c.sharedPostsLoadState,'idle');assert.equal(h.renders(),0);
  }
});
test('an old request failure cannot mark a later session as failed and duplicate active reads are skipped',async()=>{
  const h=harness(),pending=h.c.loadCommunityForCurrentMember();h.c.loadCommunityForCurrentMember();assert.equal(h.requests.length,6);
  assert.ok(!h.requests.includes('worksheets'),'worksheet request waits for fresh server permissions');
  h.c.saveSessionEpoch++;h.c.sharedPostsLoadState='ready';h.server.posts=new Error('old request failure');h.finish();await pending;
  assert.equal(h.c.sharedPostsLoadState,'ready');assert.equal(h.renders(),0);
});

test('members never request worksheets and discard stale local worksheet cache without changing server records',async()=>{
  const h=harness({admin:false}),saved=clone(h.server.worksheets),pending=h.c.loadCommunityForCurrentMember();
  h.finish();await pending;
  assert.ok(!h.requests.includes('worksheets'));
  assert.deepEqual(clone(h.c.STATE.worksheets),{});
  assert.deepEqual(h.server.worksheets,saved);
  assert.equal(h.c.sharedPostsLoadState,'ready');
});

test('admin worksheet queries start only after fresh profiles verify an active administrator',async()=>{
  const h=harness(),pending=h.c.loadCommunityForCurrentMember();
  assert.ok(!h.requests.includes('worksheets'));
  h.finish();await pending;
  assert.equal(h.requests.filter(table=>table==='worksheets').length,1);
  assert.equal(h.c.STATE.worksheets.w1.data.answer,'원래 응답');
  for(const profileChange of [row=>{row.is_admin=false;},row=>{row.is_deleted=true;},row=>{row.id='missing-current-member';}]){
    const denied=harness(),load=denied.c.loadCommunityForCurrentMember();
    profileChange(denied.server.profiles[0]);denied.finish();await load;
    assert.ok(!denied.requests.includes('worksheets'));
    assert.notEqual((denied.c.STATE.users.owner||{}).isAdmin,true);
    assert.deepEqual(clone(denied.c.STATE.worksheets),{});
  }
});

test('fresh demotion clears cached worksheet access even when another collection fails, preserving profile edits',async()=>{
  const h=harness(),pending=h.c.loadCommunityForCurrentMember();
  h.c.STATE.users.owner.name='저장한 이름';h.server.profiles[0].is_admin=false;h.server.comments=new Error('other read failed');
  h.finish();await pending;
  assert.equal(h.c.STATE.users.owner.isAdmin,false);
  assert.equal(h.c.STATE.users.owner.name,'저장한 이름');
  assert.deepEqual(clone(h.c.STATE.worksheets),{});
  assert.ok(!h.requests.includes('worksheets'));assert.equal(h.c.sharedPostsLoadState,'error');
  assert.equal(h.renders(),2,'demotion redraws the admin gate before the later collection failure');
});

test('role loss during an in-flight admin worksheet response cannot restore cached worksheet contents',async()=>{
  const worksheetGate=deferred(),h=harness({worksheetGate}),pending=h.c.loadCommunityForCurrentMember();
  h.finish();for(let i=0;i<4;i++)await Promise.resolve();
  assert.ok(h.requests.includes('worksheets'));
  h.c.STATE.users.owner.isAdmin=false;h.c.STATE.worksheets={};
  worksheetGate.resolve();await pending;
  assert.equal(h.c.STATE.users.owner.isAdmin,false);
  assert.deepEqual(clone(h.c.STATE.worksheets),{});
});
