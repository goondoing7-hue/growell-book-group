'use strict';
const {describe, test, before, beforeEach, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {PGlite} = require('@electric-sql/pglite');
const sql = fs.readFileSync(path.join(__dirname, '../server/material-video-transcript.sql'), 'utf8');
const AUTH = '11111111-1111-4111-8111-111111111111', LEASE = '22222222-2222-4222-8222-222222222222', OTHER = '33333333-3333-4333-8333-333333333333';
const ID = 'aBcDeFg1234';
const transcript = {text: '첫 번째 원문\nSecond original line.\t그대로 보존', language: 'ko', source: 'youtube_captions'};
describe('native transcript PostgreSQL cache and paid-request boundary', () => {
  let db;
  before(async () => {
    db = new PGlite();
    await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      create table public.profiles(id text primary key,auth_user_id uuid not null unique,is_deleted boolean not null default false,approval_status text not null default 'approved');
      create table public.material_notes(id text primary key,html text);insert into public.material_notes values('existing','untouched');`);
    await db.exec(sql);
  });
  beforeEach(async () => {await db.exec('reset role;truncate public.growell_material_transcript_cache,public.growell_material_transcript_usage,public.profiles');await db.query('insert into public.profiles(id,auth_user_id) values($1,$2::uuid)', ['owner', AUTH]);});
  after(async () => {await db?.close();});
  async function role(name, operation) {await db.exec('set role ' + name);try {return await operation();} finally {await db.exec('reset role');}}
  async function call(fn, args) {
    const q = fn === 'claim' ? 'select public.growell_material_transcript_claim($1,$2,$3,$4::uuid,$5::uuid,$6::boolean) as value' : 'select public.growell_material_transcript_finish($1,$2,$3::uuid,$4::jsonb) as value';
    return (await db.query(q, args.map(value => value && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0].value;
  }
  const claim = (id = ID, lease = LEASE, owner = 'owner', auth = AUTH, enabled = true) => role('service_role', () => call('claim', [id, 1, owner, auth, lease, enabled]));
  const finish = (result = {status: 'ready', transcript}, lease = LEASE) => role('service_role', () => call('finish', [ID, 1, lease, result]));
  const usage = async () => Number((await db.query("select coalesce(sum(attempts),0) as n from public.growell_material_transcript_usage where owner_id=''" )).rows[0].n);
  const expireRetry = () => db.exec("update public.growell_material_transcript_cache set retry_at=clock_timestamp()-interval '1 second'");
  const reserve = (lease=LEASE, owner='owner', auth=AUTH) => role('service_role',async()=>
    (await db.query('select public.growell_material_transcript_reserve_fallback($1,1,$2,$3::uuid,$4::uuid) as value',[ID,owner,auth,lease])).rows[0].value);
  test('migration reapplies without altering materials; RLS and RPC grants exclude all browser roles', async () => {
    await db.exec(sql);assert.deepEqual((await db.query('select * from public.material_notes')).rows, [{id: 'existing', html: 'untouched'}]);
    for (const name of ['anon', 'authenticated']) {
      await assert.rejects(role(name, () => db.query('select * from public.growell_material_transcript_cache')), e => e.code === '42501');
      await assert.rejects(role(name, () => db.query('select * from public.growell_material_transcript_usage')), e => e.code === '42501');
      await assert.rejects(role(name, () => call('claim', [ID, 1, 'owner', AUTH, LEASE, true])), e => e.code === '42501');
      await assert.rejects(role(name, () => call('finish', [ID, 1, LEASE, {status: 'ready', transcript}])), e => e.code === '42501');
      await assert.rejects(role(name,()=>db.query('select public.growell_material_transcript_reserve_fallback($1,1,$2,$3::uuid,$4::uuid)',[ID,'owner',AUTH,LEASE])),e=>e.code==='42501');
    }
    const rows = (await db.query("select relrowsecurity from pg_class where relname in ('growell_material_transcript_cache','growell_material_transcript_usage')")).rows;
    assert.equal(rows.length, 2);assert.ok(rows.every(r => r.relrowsecurity));
  });
  test('exclusive leases deduplicate misses; complete native text is shared across members and reads are free', async () => {
    assert.equal((await claim()).status, 'claimed');assert.equal((await claim(ID, OTHER)).status, 'pending');assert.equal(await usage(), 1);
    assert.equal((await finish()).status, 'ready');
    const result = await claim(ID, OTHER);assert.deepEqual(result.transcript, transcript);assert.ok(result.fetchedAt);assert.equal(await usage(), 1);
    await db.query('insert into public.profiles(id,auth_user_id) values($1,$2::uuid)', ['other', OTHER]);
    assert.equal((await claim(ID, LEASE, 'other', OTHER)).status, 'ready');assert.equal(await usage(), 1);
  });
  test('unconfigured requests and revoked members cannot spend quota; cached text works without a key', async () => {
    assert.equal((await claim(ID, LEASE, 'owner', AUTH, false)).reason, 'not_configured');assert.equal(await usage(), 0);
    await claim();await finish();assert.equal((await claim(ID, OTHER, 'owner', AUTH, false)).status, 'ready');
    await assert.rejects(claim(ID, LEASE, 'owner', OTHER), e => e.code === '42501');
    await db.exec("update public.profiles set approval_status='pending'");await assert.rejects(claim(), e => e.code === '42501');
    await db.exec("update public.profiles set approval_status='approved',is_deleted=true");await assert.rejects(claim(), e => e.code === '42501');assert.equal(await usage(), 1);
  });
  test('member 10/day and global 20/day caps include retries but never prevent cache reads', async () => {
    await claim();await finish();
    for (let n = 1; n < 10; n++) assert.equal((await claim('video' + String(n).padStart(6, '0'))).status, 'claimed');
    assert.equal((await claim('video999999')).reason, 'rate_limited');assert.equal(await usage(), 10);assert.equal((await claim()).status, 'ready');
    await db.exec("update public.growell_material_transcript_usage set attempts=20 where owner_id='';update public.growell_material_transcript_usage set attempts=0 where owner_id='owner'");
    assert.equal((await claim('video888888')).reason, 'rate_limited');assert.equal(await usage(), 20);
  });
  test('rolling 31-day 100 paid-request ceiling spans month boundaries and releases old usage', async () => {
    await db.exec("insert into public.growell_material_transcript_usage values(((clock_timestamp() at time zone 'Asia/Seoul')::date-30),'',100)");
    assert.equal((await claim()).reason, 'rate_limited');assert.equal(await usage(), 100);
    await db.exec("update public.growell_material_transcript_usage set usage_day=usage_day-1 where attempts=100");
    assert.equal((await claim()).status, 'claimed');
    const today = (await db.query("select attempts from public.growell_material_transcript_usage where owner_id='' and usage_day=(clock_timestamp() at time zone 'Asia/Seoul')::date")).rows[0];assert.equal(today.attempts, 1);
  });
  test('206 absence is remembered seven days and failed retries back off without billing cache hits', async () => {
    await claim();assert.equal((await finish({status: 'unavailable', reason: 'transcript_unavailable'})).retryAfter, 604800);
    assert.equal((await claim()).reason, 'transcript_unavailable');assert.equal(await usage(), 1);
    await expireRetry();assert.equal((await claim()).status, 'claimed');assert.equal(await usage(), 2);
    assert.equal((await finish({status: 'unavailable', reason: 'temporary_error'})).retryAfter, 900);
    assert.equal((await claim()).reason, 'temporary_error');assert.equal(await usage(), 2);
    await expireRetry();assert.equal((await claim()).status, 'claimed');assert.equal(await usage(), 3);
  });
  test('202 jobs are resumed with free, leased, bounded polls instead of sending another billed URL request', async () => {
    await claim();assert.equal((await finish({status: 'pending', jobId: 'native-job_123'})).status, 'pending');
    assert.equal((await claim()).status, 'pending');assert.equal(await usage(), 1);
    for (let n = 1; n <= 10; n++) {
      await expireRetry();const poll = await claim();assert.equal(poll.jobId, 'native-job_123');assert.equal(poll.status, 'claimed');
      assert.equal((await claim(ID, OTHER)).status, 'pending');
      await finish({status: 'pending', jobId: 'native-job_123'});assert.equal(await usage(), 1);
    }
    await expireRetry();const exhausted = await claim();assert.equal(exhausted.reason, 'temporary_error');assert.equal(exhausted.retryAfter, 900);assert.equal(await usage(), 1);
  });
  test('jobs expire after ten minutes and cannot change identifiers mid-poll', async () => {
    await claim();await finish({status: 'pending', jobId: 'native-job'});await expireRetry();await claim();
    await assert.rejects(finish({status: 'pending', jobId: 'different-job'}), e => e.code === '22023');
    await finish({status: 'pending', jobId: 'native-job'});await expireRetry();
    await db.exec("update public.growell_material_transcript_cache set job_started_at=clock_timestamp()-interval '11 minutes'");
    assert.equal((await claim()).reason, 'temporary_error');assert.equal(await usage(), 1);
  });
  test('English fallback is billed once and only an approved live lease can reserve it', async()=>{
    await claim();assert.equal((await reserve(OTHER)).reserved,false);assert.equal(await usage(),1);
    assert.equal((await reserve()).reserved,true);assert.equal(await usage(),2);
    assert.equal((await reserve()).reserved,false);assert.equal(await usage(),2);
    await finish();assert.equal((await reserve()).reserved,false);
    await assert.rejects(reserve(LEASE,'owner',OTHER), e=>e.code==='42501');
  });
  test('fallback cannot exceed daily or rolling limits and leaves existing primary work intact',async()=>{
    for(const value of [10,100]){
      await db.exec('truncate public.growell_material_transcript_cache,public.growell_material_transcript_usage');
      await claim();
      if(value===10) await db.exec("update public.growell_material_transcript_usage set attempts=10 where owner_id='owner'");
      else await db.exec("insert into public.growell_material_transcript_usage values(((clock_timestamp() at time zone 'Asia/Seoul')::date-1),'',99)");
      assert.equal((await reserve()).reserved,false);assert.equal((await finish()).status,'ready');
    }
  });
  test('paid fallback may replace Korean job once; resumed English jobs cannot switch back',async()=>{
    await claim();await finish({status:'pending',jobId:'ko-job',requestedLanguage:'ko'});await expireRetry();await claim();
    await assert.rejects(finish({status:'pending',jobId:'en-job',requestedLanguage:'en'}),e=>e.code==='22023');
    assert.equal((await reserve()).reserved,true);
    await finish({status:'pending',jobId:'en-job',requestedLanguage:'en'});await expireRetry();
    const resumed=await claim();assert.equal(resumed.requestedLanguage,'en');assert.equal(resumed.jobId,'en-job');
    assert.equal((await reserve()).reserved,false);assert.equal(await usage(),2);
    await assert.rejects(finish({status:'pending',jobId:'new-job',requestedLanguage:'en'}),e=>e.code==='22023');
    await assert.rejects(finish({status:'pending',jobId:'en-job',requestedLanguage:'ko'}),e=>e.code==='22023');
    const result=await finish({status:'ready',transcript:{...transcript,title:'실제 영상 제목'}});
    assert.equal(result.transcript.title,'실제 영상 제목');
    await db.exec(sql);
    assert.equal((await claim()).transcript.title,'실제 영상 제목');assert.equal(await usage(),2);
  });
  test('expired leases recover safely and late responses cannot overwrite a newer lease', async () => {
    await claim();assert.equal((await finish({status: 'ready', transcript}, OTHER)).status, 'pending');
    await db.exec("update public.growell_material_transcript_cache set lease_until=clock_timestamp()-interval '1 second'");
    assert.equal((await finish()).status, 'pending');assert.equal((await claim(ID, OTHER)).status, 'claimed');
    assert.equal((await finish()).status, 'pending');assert.equal((await finish({status: 'ready', transcript}, OTHER)).status, 'ready');assert.equal(await usage(), 2);
  });
  test('generated, malformed and oversized text never becomes native; extra fields and provider errors are discarded', async () => {
    await claim();
    for (const invalid of [{...transcript, text: ''}, {...transcript, text: 'x'.repeat(2097153)}, {...transcript, text: 'a\u0001b'}, {...transcript, language: '<ko>'}, {...transcript, source: 'ai_generated'}, {...transcript, language: null}]) {
      await assert.rejects(finish({status: 'ready', transcript: invalid}), e => e.code === '22023');
    }
    await assert.rejects(finish({status: 'pending', jobId: '../evil'}), e => e.code === '22023');
    assert.equal((await finish({status: 'unavailable', reason: 'provider secret'})).reason, 'temporary_error');
    assert.equal(JSON.stringify((await db.query('select * from public.growell_material_transcript_cache')).rows).includes('secret'), false);
    await expireRetry();await claim();const result = await finish({status: 'ready', transcript: {...transcript, secret: 'discard'}});assert.deepEqual(result.transcript, transcript);
  });
});
