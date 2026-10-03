'use strict';

const {describe,test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const S=require('../server/driveBackupService.cjs');
const D=require('../server/driveBackupDomain.cjs');
const migration=fs.readFileSync(path.join(__dirname,'../server/drive-backup.sql'),'utf8');
const schedule=fs.readFileSync(path.join(__dirname,'../server/drive-backup-schedule.sql'),'utf8');
const AUTH='11111111-1111-4111-8111-111111111111';
const OTHER_AUTH='22222222-2222-4222-8222-222222222222';
const GEN='33333333-3333-4333-8333-333333333333';
const NEXT_GEN='44444444-4444-4444-8444-444444444444';
const TOKEN='synthetic-encrypted-token-for-tests';
const SOURCES=['private_entries','habits','material_notes','posts','comments','worksheets','reading_logs','reading_meta'];
const codeIs=code=>error=>error.code===code;

// Real PostgreSQL semantics in isolated memory. No member data, credentials,
// live database, Google account, or external API is used by these tests.
describe('Google Drive backup PostgreSQL durability and privacy',()=>{
  let db;
  before(async()=>{
    db=new PGlite();
    await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      create table public.profiles(id text primary key,auth_user_id uuid unique not null,
        approval_status text not null default 'approved',is_deleted boolean not null default false,
        pbkdf2_salt text default 'not-for-backup',recovery_key text default 'not-for-backup');
      create table public.private_entries(id text primary key,user_id text not null references public.profiles(id) on delete cascade,
        book_id text,iv text,data text,created_at bigint,updated_at bigint,unknown_secret text);
      create table public.habits(id text primary key,user_id text not null references public.profiles(id) on delete cascade,
        book_id text,name text,place text,time text,goal text,behavior_type text,start_date date,end_date date,
        weekdays integer[],checked_dates text[],created_at bigint,updated_at bigint);
      create table public.material_notes(id text primary key,user_id text not null references public.profiles(id) on delete cascade,
        book_id text,note_type text,page text,html text,photo_url text,drive_links jsonb,meeting_no text,font_size text,title text,created_at bigint,updated_at bigint);
      create table public.posts(id text primary key,user_id text not null references public.profiles(id) on delete cascade,
        book_id text,checkin text,note_type text,meeting_no text,q1 text,q2 text,q3 text,page text,html text,photo_url text,bg_color text,font_size text,title text,created_at bigint,updated_at bigint);
      create table public.comments(id text primary key,user_id text not null references public.profiles(id) on delete cascade,post_id text,text text,created_at bigint);
      create table public.worksheets(id text primary key,user_id text not null references public.profiles(id) on delete cascade,book_id text,activity_key text,data jsonb,created_at bigint,updated_at bigint);
      create table public.reading_logs(id text primary key,user_id text not null references public.profiles(id) on delete cascade,book_id text,seconds integer,page integer,start_page integer,created_at bigint);
      create table public.reading_meta(book_id text,user_id text not null references public.profiles(id) on delete cascade,current_page integer,updated_at bigint,primary key(book_id,user_id));
      grant select,insert,update,delete on all tables in schema public to service_role;
      grant insert,update,delete on public.private_entries,public.habits,public.material_notes,public.posts,public.comments,public.worksheets,public.reading_logs,public.reading_meta to authenticated;`);
    await db.exec(migration);
  });
  beforeEach(async()=>{
    await db.exec('reset role;truncate public.profiles cascade');
    await db.query('insert into public.profiles(id,auth_user_id) values($1,$2::uuid),($3,$4::uuid)',['owner',AUTH,'other',OTHER_AUTH]);
  });
  after(async()=>{if(db)await db.close();});
  async function asRole(role,action){
    assert.ok(['anon','authenticated','service_role'].includes(role));await db.exec('set role '+role);
    try{return await action();}finally{await db.exec('reset role');}
  }
  async function rpc(name,args){
    const queries={
      configure:'select public.growell_drive_backup_configure($1,$2::uuid,$3,$4::jsonb) as value',
      oauth:'select public.growell_drive_backup_oauth($1,$2::jsonb) as value',
      claim:'select public.growell_drive_backup_claim($1,$2::integer) as value',
      snapshot:'select public.growell_drive_backup_snapshot($1,$2::uuid,$3::uuid) as value',
      apply:'select public.growell_drive_backup_apply($1,$2::uuid,$3::uuid,$4,$5::jsonb) as value'
    };
    assert.ok(queries[name]);
    return (await db.query(queries[name],args.map(value=>value&&typeof value==='object'?JSON.stringify(value):value))).rows[0].value;
  }
  const configure=(op,payload={},owner='owner',auth=AUTH)=>asRole('service_role',()=>rpc('configure',[owner,auth,op,payload]));
  const connect=(generation=GEN,account='google-sub-hash',owner='owner',auth=AUTH)=>configure('connect',{
    generation,token_cipher:TOKEN,account_id:account,account_email:'test@example.invalid'
  },owner,auth);
  const claim=(owner='owner',limit=1)=>asRole('service_role',()=>rpc('claim',[owner,limit]));
  const apply=(job,op,payload={})=>asRole('service_role',()=>rpc('apply',[job.connection.owner_id,job.connection.generation,job.connection.lease_token,op,payload]));
  const snapshot=job=>asRole('service_role',()=>rpc('snapshot',[job.connection.owner_id,job.connection.generation,job.connection.lease_token]));
  const oauth=(op,payload)=>asRole('service_role',()=>rpc('oauth',[op,payload]));
  const connection=(owner='owner')=>db.query('select * from public.growell_drive_backup_connections where owner_id=$1',[owner]).then(r=>r.rows[0]);
  const insert=(source,id='one',owner='owner')=>{
    assert.ok(SOURCES.includes(source));
    return db.query('insert into public.'+source+'('+ (source==='reading_meta'?'book_id':'id')+',user_id) values($1,$2)',[id,owner]);
  };
  async function reserve(job){
    assert.deepEqual(await apply(job,'ids',{folder_id:'folder-123',file_id:'file-456'}),{applied:true});
    assert.deepEqual(await apply(job,'created',{folder_created:true,file_created:true}),{applied:true});
  }
  async function succeed(job,revision){return apply(job,'success',{revision,counts:{habits:1},hash:'a'.repeat(64)});}

  function serviceWithDatabase(provider){
    const config=D.getConfig({GROWELL_SYNC_KEY:Buffer.alloc(32,7).toString('base64'),GROWELL_GOOGLE_CLIENT_ID:'test-client-id',
      GROWELL_GOOGLE_CLIENT_SECRET:'test-client-secret',SUPABASE_SERVICE_ROLE_KEY:'test-service-role',CRON_SECRET:'test-cron-secret'});
    const request=async(raw,options={})=>{
      const url=new URL(raw);assert.equal(url.origin,config.database);
      if(url.pathname==='/auth/v1/user'){
        if(options.headers.Authorization==='Bearer valid-owner-session')return {id:AUTH};
        if(options.headers.Authorization==='Bearer valid-other-session')return {id:OTHER_AUTH};
        throw new D.BackupError('authentication-required',401);
      }
      assert.equal(options.headers.Authorization,'Bearer '+config.serviceKey);
      const name=url.pathname.replace('/rest/v1/rpc/growell_drive_backup_','');
      if(name!==url.pathname){
        const body=JSON.parse(options.body);const args={oauth:[body.p_operation,body.p_payload],
          configure:[body.p_owner,body.p_auth,body.p_operation,body.p_payload],claim:[body.p_owner,body.p_limit],
          snapshot:[body.p_owner,body.p_generation,body.p_lease],apply:[body.p_owner,body.p_generation,body.p_lease,body.p_operation,body.p_payload]};
        assert.ok(args[name]);return asRole('service_role',()=>rpc(name,args[name]));
      }
      if(url.pathname==='/rest/v1/profiles'){
        assert.equal(url.searchParams.get('select'),'id,auth_user_id,is_deleted,approval_status');
        return asRole('service_role',()=>db.query('select id,auth_user_id,is_deleted,approval_status from public.profiles where auth_user_id=$1::uuid',
          [url.searchParams.get('auth_user_id').replace(/^eq\./,'')]).then(result=>result.rows));
      }
      assert.equal(url.pathname,'/rest/v1/growell_drive_backup_connections');
      return asRole('service_role',()=>db.query('select * from public.growell_drive_backup_connections where owner_id=$1',
        [url.searchParams.get('owner_id').replace(/^eq\./,'')]).then(result=>JSON.parse(JSON.stringify(result.rows))));
    };
    const service=S.createService({config,request,providerFactory:()=>provider});
    return service;
  }
  async function connectService(service){
    const profile=await service.authenticate({headers:{authorization:'Bearer valid-owner-session'}});
    await service.store.configure(profile.id,profile.auth_user_id,'connect',{generation:GEN,account_id:'google-sub-hash',account_email:'test@example.invalid',
      token_cipher:D.seal({refreshToken:'synthetic-refresh-token',scope:D.SCOPES},service.config.key,D.tokenContext(profile.id,GEN))});
    return profile;
  }

  test('real service and SQL complete a backup, preserve in-flight edits, and expose exact successful timestamp',async()=>{
    for(const source of SOURCES)await insert(source,'mine');await insert('habits','other-private-habit','other');
    await db.query("update public.private_entries set iv='original-iv',data='original-ciphertext',unknown_secret='not-exported' where user_id='owner'");
    const uploads=[];let allocations=0;
    const provider={
      refresh:async token=>{assert.equal(token.refreshToken,'synthetic-refresh-token');return {accessToken:'test-access-token'};},
      allocateIds:async(token,count)=>{assert.equal(token,'test-access-token');assert.equal(count,2);allocations++;return ['folder-123','file-456'];},
      writeBackup:async input=>{
        const reserved=await connection();assert.equal(reserved.folder_id,input.folderId);assert.equal(reserved.file_id,input.fileId);
        assert.ok(reserved.lease_token);assert.ok(reserved.snapshot_revision,'snapshot and ID reservation precede upload');
        await input.beforeWrite();await input.onCreated({folderCreated:true});await input.onCreated({folderCreated:true,fileCreated:true});
        uploads.push(JSON.parse(input.content));
        if(uploads.length===1)await insert('habits','saved-during-upload');
      }
    };
    const service=serviceWithDatabase(provider),profile=await connectService(service);
    assert.deepEqual(await service.run(profile.id),{processed:1});let status=await service.status(profile),saved=await connection();
    assert.equal(status.lastBackedUpAt,saved.last_synced_at.toISOString());assert.equal(status.pending,true);assert.equal(status.busy,false);assert.equal(saved.lease_token,null);
    assert.equal(status.folderUrl,'https://drive.google.com/drive/folders/folder-123');assert.equal(status.counts.habits,1);
    assert.equal(uploads[0].ownerId,'owner');assert.equal(uploads[0].data.private_entries[0].data,'original-ciphertext');
    assert.equal(uploads[0].data.habits.length,1);assert.equal(JSON.stringify(uploads[0]).includes('other-private-habit'),false);
    assert.equal(JSON.stringify(uploads[0]).includes('not-exported'),false);assert.equal(uploads[0].contentHash,saved.last_hash);
    assert.deepEqual(await service.run(profile.id),{processed:1});status=await service.status(profile);saved=await connection();
    assert.equal(status.pending,false);assert.equal(status.counts.habits,2);assert.equal(status.lastBackedUpAt,saved.last_synced_at.toISOString());
    assert.equal(uploads.length,2);assert.equal(allocations,1,'retries reuse reserved remote IDs');
    assert.deepEqual(await service.run(profile.id),{processed:0});assert.equal(uploads.length,2,'no changes means no new upload');
    for(const field of ['token_cipher','lease_token','auth_user_id','generation'])assert.equal(status[field],undefined);
  });

  test('real service errors persist safe hyphenated codes and retain last successful receipt',async()=>{
    let fail=false;const uploads=[];
    const service=serviceWithDatabase({refresh:async()=>({accessToken:'test-access-token'}),allocateIds:async()=>['folder-123','file-456'],
      writeBackup:async input=>{
        await input.beforeWrite();if(fail)throw new D.BackupError('remote-unavailable',503,300);
        await input.onCreated({folderCreated:true,fileCreated:true});uploads.push(input.content);
      }});
    const profile=await connectService(service);assert.deepEqual(await service.run(profile.id),{processed:1});const previous=await connection();
    await insert('habits','pending-habit');fail=true;assert.deepEqual(await service.run(profile.id),{processed:0});
    const stored=await connection(),status=await service.status(profile);
    assert.equal(stored.error_code,'remote-unavailable');assert.equal(stored.attempts,1);assert.equal(stored.lease_token,null);
    assert.equal(status.errorCode,'remote-unavailable');assert.equal(status.pending,true);assert.equal(status.lastBackedUpAt,previous.last_synced_at.toISOString());
    assert.equal(stored.last_hash,previous.last_hash);assert.equal(stored.synced_revision,previous.synced_revision);assert.equal(uploads.length,1);
    assert.deepEqual(await service.run(profile.id),{processed:0},'backoff prevents repeated remote writes');
  });

  test('real service authenticates membership and prevents cross-owner backup or a revoked in-flight upload',async()=>{
    let writes=0;
    const service=serviceWithDatabase({refresh:async()=>({accessToken:'test-access-token'}),allocateIds:async()=>['folder-123','file-456'],
      writeBackup:async input=>{
        await db.query("update public.profiles set approval_status='pending' where id='owner'");
        await input.beforeWrite();writes++;await input.onCreated({folderCreated:true,fileCreated:true});
      }});
    const profile=await connectService(service),other=await service.authenticate({headers:{authorization:'Bearer valid-other-session'}});
    assert.equal(other.id,'other');assert.deepEqual(await service.run(other.id),{processed:0});
    await assert.rejects(service.mutate(other,'sync',{}),codeIs('55000'));assert.equal((await connection()).manual_requested,false);
    await assert.rejects(service.authenticate({headers:{authorization:'Bearer invalid-session'}}),codeIs('authentication-required'));
    await assert.rejects(service.status({id:'owner',auth_user_id:OTHER_AUTH}),codeIs('membership-required'));
    assert.deepEqual(await service.run(profile.id),{processed:0});assert.equal(writes,0);assert.equal(await connection(),undefined);
    await assert.rejects(service.authenticate({headers:{authorization:'Bearer valid-owner-session'}}),codeIs('membership-required'));
  });

  test('migration is idempotent and does not enroll members or change source rows',async()=>{
    await insert('habits');const before=(await db.query('select * from public.habits')).rows;
    await db.exec(migration);assert.equal(await connection(),undefined);
    const result=await connect();assert.equal(result.enabled,true);assert.equal(result.dirty_revision,1);
    assert.equal(result.token_cipher,undefined);assert.equal(result.lease_token,undefined);
    await db.exec(migration);assert.deepEqual((await db.query('select * from public.habits')).rows,before);
    assert.equal((await connection()).dirty_revision,1);assert.equal((await claim()).length,1);
  });

  test('source compatibility guard rejects missing critical data instead of silently exporting partial rows',async()=>{
    for(const [table,column] of [['private_entries','data'],['private_entries','iv'],['habits','checked_dates'],['reading_meta','current_page']]){
      await db.exec('alter table public.'+table+' rename column '+column+' to omitted_backup_column');
      try{await assert.rejects(db.exec(migration),error=>error.code==='P0001'&&error.message.includes(table+'.'+column));}
      finally{await db.exec('rollback;alter table public.'+table+' rename column omitted_backup_column to '+column);}
    }
    await db.exec(migration);
  });

  test('every owned collection marks inserts, changes and deletions including paused connections',async()=>{
    await connect();await configure('settings',{enabled:false});let revision=(await connection()).dirty_revision;
    for(const source of SOURCES){
      await asRole('authenticated',()=>insert(source));assert.equal((await connection()).dirty_revision,++revision,source+' insert');
      const column=source==='reading_meta'?'current_page':source==='comments'?'text':source==='worksheets'?'activity_key':source==='habits'?'name':source==='reading_logs'?'seconds':source==='private_entries'?'data':'title';
      const value=['current_page','seconds'].includes(column)?1:'changed';
      await db.query('update public.'+source+' set '+column+'=$1 where user_id=$2',[value,'owner']);
      assert.equal((await connection()).dirty_revision,++revision,source+' update');
      await db.query('delete from public.'+source+' where user_id=$1',['owner']);assert.equal((await connection()).dirty_revision,++revision,source+' delete');
    }
    assert.deepEqual(await claim(),[],'paused automatic processing stays paused');
    await configure('sync');assert.equal((await claim()).length,1,'manual backup works while paused');
  });

  test('ownership transfers dirty both members without enrolling unconnected members',async()=>{
    await connect();await insert('habits');let before=await connection();
    await db.query("update public.habits set user_id='other'");assert.equal((await connection()).dirty_revision,before.dirty_revision+1);
    assert.equal(await connection('other'),undefined);
    await connect(NEXT_GEN,'other-google','other',OTHER_AUTH);const previous=(await connection('other')).dirty_revision;
    await db.query("update public.habits set user_id='owner'");assert.equal((await connection('other')).dirty_revision,previous+1);
  });

  test('snapshot includes only owner and allowlisted fields, preserves ciphertext, archive and full histories',async()=>{
    await connect();for(const source of SOURCES){await insert(source,'mine');await insert(source,'theirs','other');}
    await db.query("update public.private_entries set book_id='archive',iv='original-IV',data='original-encrypted-payload',created_at=123,updated_at=456,unknown_secret='must-never-export' where user_id='owner'");
    await db.query("update public.habits set name='독서',weekdays=array[1,3,5],checked_dates=array['2026-10-01','2026-10-03'] where user_id='owner'");
    const job=(await claim())[0], result=await snapshot(job);
    assert.deepEqual(Object.keys(result.data).sort(),SOURCES.slice().sort());
    for(const rows of Object.values(result.data)){assert.equal(rows.length,1);assert.equal(rows[0].user_id,'owner');}
    assert.deepEqual(result.data.private_entries[0],{id:'mine',user_id:'owner',book_id:'archive',iv:'original-IV',data:'original-encrypted-payload',created_at:123,updated_at:456});
    assert.deepEqual(result.data.habits[0].checked_dates,['2026-10-01','2026-10-03']);assert.deepEqual(result.data.habits[0].weekdays,[1,3,5]);
    const serialized=JSON.stringify(result);for(const secret of ['unknown_secret','must-never-export','pbkdf2_salt','recovery_key',AUTH,OTHER_AUTH,TOKEN,'theirs'])assert.equal(serialized.includes(secret),false,secret);
    assert.equal((await connection()).snapshot_revision,result.revision);
    await db.query("update public.private_entries set unknown_secret='different' where user_id='owner'");
    assert.equal((await connection()).dirty_revision,result.revision,'unexported columns do not trigger export');
  });

  test('snapshot reads more than Supabase default page size without silently truncating',async()=>{
    await db.query("insert into public.comments(id,user_id,text) select 'comment-'||n,'owner','message' from generate_series(1,1201) n");
    await connect();const result=await snapshot((await claim())[0]);assert.equal(result.data.comments.length,1201);
  });

  test('successful receipt marks only snapshotted revision and preserves edits made during upload',async()=>{
    await connect();const job=(await claim())[0];await reserve(job);const original=await snapshot(job);
    await insert('habits');assert.deepEqual(await succeed(job,original.revision+1),{applied:false},'cannot claim a revision that was not snapshotted');
    assert.deepEqual(await succeed(job,original.revision),{applied:true});await apply(job,'release');
    const stored=await connection();assert.equal(stored.synced_revision,original.revision);assert.equal(stored.dirty_revision,original.revision+1);
    assert.equal((await claim()).length,1,'new edit is still pending');
  });

  test('unchanged backups stop claiming and manual request restarts without changing enabled setting',async()=>{
    await connect();let job=(await claim())[0];await reserve(job);await succeed(job,(await snapshot(job)).revision);await apply(job,'release');
    assert.deepEqual(await claim(),[]);await configure('settings',{enabled:false});await configure('sync');
    job=(await claim())[0];assert.equal(job.connection.enabled,false);await succeed(job,(await snapshot(job)).revision);await apply(job,'release');
    assert.deepEqual(await claim(),[]);assert.equal((await connection()).enabled,false);assert.equal((await connection()).manual_requested,false);
  });

  test('Drive IDs are reserved before creation and cannot change within one account',async()=>{
    await connect();const job=(await claim())[0];await assert.rejects(apply(job,'created',{file_created:true}),codeIs('23514'));
    await reserve(job);await assert.rejects(apply(job,'ids',{folder_id:'different',file_id:'file-456'}),codeIs('22023'));
    assert.deepEqual(await apply(job,'ids',{folder_id:'folder-123',file_id:'file-456'}),{applied:true});
    await apply(job,'created',{folder_created:false,file_created:false});assert.equal((await connection()).file_created,true,'creation markers are monotonic');
    await apply(job,'release');await configure('disconnect');assert.equal((await connection()).token_cipher,null);
    await connect(NEXT_GEN);let stored=await connection();assert.equal(stored.folder_id,'folder-123');assert.equal(stored.file_created,true);
    await connect(GEN,'different-google-account');stored=await connection();assert.equal(stored.folder_id,null);assert.equal(stored.file_id,null);assert.equal(stored.file_created,false);
  });

  test('leases block concurrent claim/configuration and fence stale or expired workers',async()=>{
    await connect();const job=(await claim())[0];assert.deepEqual(await claim(),[]);
    for(const operation of ['disconnect','sync','settings'])await assert.rejects(configure(operation,{enabled:false}),codeIs('40001'));
    assert.deepEqual(await apply({...job,connection:{...job.connection,generation:NEXT_GEN}},'guard'),{applied:false});
    for(const field of ['generation','lease_token']){
      const missing={...job,connection:{...job.connection,[field]:null}};
      assert.equal(await snapshot(missing),null);assert.deepEqual(await apply(missing,'guard'),{applied:false});
    }
    await db.query("update public.growell_drive_backup_connections set lease_until=clock_timestamp()-interval '1 second'");
    assert.equal(await snapshot(job),null);assert.deepEqual(await apply(job,'guard'),{applied:false});
    const replacement=(await claim())[0];assert.notEqual(replacement.connection.lease_token,job.connection.lease_token);
    assert.deepEqual(await apply(job,'release'),{applied:false});assert.deepEqual(await apply(replacement,'guard'),{applied:true});
  });

  test('retry delay remains durable when a new source edit arrives and does not lose pending revision',async()=>{
    await connect();const job=(await claim())[0];await apply(job,'failure',{error_code:'drive_unavailable',retry_after:300});await apply(job,'release');
    const before=await connection();await insert('habits');const after=await connection();
    assert.equal(after.next_sync_at.getTime(),before.next_sync_at.getTime());assert.equal(after.dirty_revision,before.dirty_revision+1);assert.deepEqual(await claim(),[]);
    await configure('sync');assert.equal((await claim()).length,1,'explicit retry can bypass timed backoff');
  });

  test('revoked token pauses automatic and manual processing while allowing lease release',async()=>{
    await connect();await configure('sync');const job=(await claim())[0];
    await apply(job,'failure',{error_code:'google_reconnect_required',disable:true});assert.deepEqual(await apply(job,'guard'),{applied:false});
    assert.equal(await snapshot(job),null);assert.deepEqual(await apply(job,'release'),{applied:true});assert.deepEqual(await claim(),[]);
    assert.equal((await connection()).enabled,false);assert.equal((await connection()).manual_requested,false);
  });

  test('membership revocation removes credentials and OAuth state without deleting owned data',async()=>{
    for(const change of ["approval_status='pending'","is_deleted=true","auth_user_id='55555555-5555-4555-8555-555555555555'"]){
      await db.query('update public.profiles set approval_status=$1,is_deleted=false,auth_user_id=$2::uuid where id=$3',['approved',AUTH,'owner']);
      await connect();const job=(await claim())[0];await insert('habits','source-'+change.length);
      await db.query('update public.profiles set '+change+" where id='owner'");assert.equal(await connection(),undefined);
      assert.deepEqual(await apply(job,'guard'),{applied:false});assert.equal(await snapshot(job),null);
      assert.ok((await db.query("select count(*)::integer as n from public.habits where user_id='owner'")).rows[0].n>0);
    }
  });

  test('wrong user cannot configure and OAuth state is short lived, bound and one-use',async()=>{
    await assert.rejects(configure('connect',{generation:GEN,token_cipher:TOKEN,account_id:'x'},'owner',OTHER_AUTH),codeIs('42501'));
    const payload={state_hash:'a'.repeat(64),owner_id:'owner',auth_user_id:AUTH,verifier_cipher:TOKEN,expires_at:new Date(Date.now()+300000).toISOString()};
    await oauth('put',payload);const consumed=await oauth('consume',{state_hash:payload.state_hash});assert.equal(consumed.owner_id,'owner');
    assert.equal(await oauth('consume',{state_hash:payload.state_hash}),null);
    await assert.rejects(oauth('put',{...payload,expires_at:new Date(Date.now()+3600000).toISOString()}),codeIs('22023'));
    await assert.rejects(oauth('put',{...payload,auth_user_id:OTHER_AUTH}),codeIs('42501'));
    await oauth('put',payload);await db.query("update public.profiles set is_deleted=true where id='owner'");
    assert.equal(await oauth('consume',{state_hash:payload.state_hash}),null);
  });

  test('connector credentials, OAuth states and all RPCs are denied to browser roles',async()=>{
    await connect();for(const role of ['anon','authenticated']){
      await asRole(role,async()=>{
        for(const table of ['connections','oauth_states'])await assert.rejects(db.query('select * from public.growell_drive_backup_'+table),codeIs('42501'));
        for(const query of [
          "select public.growell_drive_backup_configure('owner','"+AUTH+"','disconnect','{}')",
          "select public.growell_drive_backup_oauth('consume','{}')",
          'select public.growell_drive_backup_claim()',
          "select public.growell_drive_backup_snapshot('owner','"+GEN+"','"+NEXT_GEN+"')",
          "select public.growell_drive_backup_apply('owner','"+GEN+"','"+NEXT_GEN+"','guard','{}')",
          "select public.growell_drive_backup_mark_dirty('owner')",
          "select public.growell_drive_backup_project('private_entries','{}')"
        ])await assert.rejects(db.query(query),codeIs('42501'));
      });
    }
    const rls=(await db.query("select relrowsecurity from pg_class where oid in ('public.growell_drive_backup_connections'::regclass,'public.growell_drive_backup_oauth_states'::regclass)")).rows;
    assert.ok(rls.every(row=>row.relrowsecurity));
  });

  test('oversized snapshots fail as a whole and retain the previous successful backup receipt',async()=>{
    await connect();let job=(await claim())[0];await reserve(job);await succeed(job,(await snapshot(job)).revision);await apply(job,'release');const receipt=await connection();
    await insert('private_entries');await db.query("update public.private_entries set data=repeat('x',21*1024*1024) where user_id='owner'");
    job=(await claim())[0];await assert.rejects(snapshot(job),codeIs('22001'));
    const unchanged=await connection();assert.equal(unchanged.synced_revision,receipt.synced_revision);assert.equal(unchanged.last_hash,receipt.last_hash);assert.equal(unchanged.snapshot_revision,null);
  });

  test('scheduler uses its own job and the existing Vault secret without changing habit sync',()=>{
    assert.match(schedule,/cron\.schedule\('growell-drive-backup','\* \* \* \* \*'/);
    assert.match(schedule,/\/api\/drive-backup\?action=worker/);assert.match(schedule,/growell_habit_sync_worker_secret/);
    assert.doesNotMatch(schedule,/cron\.(unschedule|alter_job)/);assert.doesNotMatch(schedule,/cron\.schedule\('growell-habit-sync'/);
  });
});
