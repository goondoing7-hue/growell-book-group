'use strict';
const {describe, test, before, beforeEach, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {PGlite} = require('@electric-sql/pglite');
const sql = fs.readFileSync(path.join(__dirname, '../server/material-video-summary.sql'), 'utf8');
const AUTH = '11111111-1111-4111-8111-111111111111', LEASE = '22222222-2222-4222-8222-222222222222', OTHER = '33333333-3333-4333-8333-333333333333';
const ID = 'aBcDeFg1234';
const summary = {overview: '공개 영상 요약', points: ['핵심 한 가지', '다른 핵심']};
describe('material video summary cache PostgreSQL boundary', () => {
  let db;
  before(async () => {
    db = new PGlite();
    await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      create table public.profiles(id text primary key,auth_user_id uuid not null unique,is_deleted boolean not null default false,approval_status text not null default 'approved');`);
    await db.exec(sql);
  });
  beforeEach(async () => {await db.exec('reset role;truncate public.growell_material_video_cache,public.growell_material_video_usage,public.profiles');await db.query('insert into public.profiles(id,auth_user_id) values($1,$2::uuid)', ['owner', AUTH]);});
  after(async () => {await db?.close();});
  async function role(name, operation) {await db.exec('set role ' + name);try {return await operation();} finally {await db.exec('reset role');}}
  async function call(fn, args) {
    const q = fn === 'claim' ? 'select public.growell_material_video_claim($1,$2,$3,$4::uuid,$5::uuid) as value' : 'select public.growell_material_video_finish($1,$2,$3::uuid,$4::jsonb) as value';
    return (await db.query(q, args.map(value => value && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0].value;
  }
  const claim = (id = ID, lease = LEASE, owner = 'owner', auth = AUTH) => role('service_role', () => call('claim', [id, 1, owner, auth, lease]));
  const finish = (result = {status: 'ready', summary}, lease = LEASE) => role('service_role', () => call('finish', [ID, 1, lease, result]));
  const usage = async () => (await db.query("select attempts from public.growell_material_video_usage where owner_id=''" )).rows[0]?.attempts || 0;
  test('migration is reapplicable and client roles cannot read, write or claim summaries', async () => {
    await db.exec(sql);
    for (const name of ['anon', 'authenticated']) {
      await assert.rejects(role(name, () => db.query('select * from public.growell_material_video_cache')), e => e.code === '42501');
      await assert.rejects(role(name, () => call('claim', [ID, 1, 'owner', AUTH, LEASE])), e => e.code === '42501');
      await assert.rejects(role(name, () => call('finish', [ID, 1, LEASE, {status: 'ready', summary}])), e => e.code === '42501');
    }
    assert.equal((await db.query("select relrowsecurity from pg_class where relname='growell_material_video_cache'" )).rows[0].relrowsecurity, true);
  });
  test('one lease per video prevents duplicate provider attempts; ready cache is shared across users', async () => {
    assert.equal((await claim()).status, 'claimed');assert.equal((await claim(ID, OTHER)).status, 'pending');assert.equal(await usage(), 1);
    assert.equal((await finish()).status, 'ready');
    const cached = await claim(ID, OTHER);assert.equal(cached.status, 'ready');assert.deepEqual(cached.summary, summary);assert.ok(cached.generatedAt);assert.equal(await usage(), 1);
    await db.query('insert into public.profiles(id,auth_user_id) values($1,$2::uuid)', ['other', OTHER]);
    assert.equal((await claim(ID, LEASE, 'other', OTHER)).status, 'ready');assert.equal(await usage(), 1);
  });
  test('rejected and deleted users cannot spend generation quota, even through service RPC', async () => {
    await assert.rejects(claim(ID, LEASE, 'owner', OTHER), e => e.code === '42501');
    await db.exec("update public.profiles set approval_status='pending'");await assert.rejects(claim(), e => e.code === '42501');
    await db.exec("update public.profiles set approval_status='approved',is_deleted=true");await assert.rejects(claim(), e => e.code === '42501');assert.equal(await usage(), 0);
  });
  test('daily member and global caps bound new generation attempts without denying cached results', async () => {
    await claim();await finish();
    for (let n = 1; n < 10; n++) assert.equal((await claim('video' + String(n).padStart(6, '0'))).status, 'claimed');
    assert.equal((await claim('video999999')).reason, 'rate_limited');assert.equal(await usage(), 10);
    assert.equal((await claim()).status, 'ready');
    await db.exec("update public.growell_material_video_usage set attempts=50 where owner_id='';update public.growell_material_video_usage set attempts=0 where owner_id='owner'");
    assert.equal((await claim('video888888')).reason, 'rate_limited');assert.equal(await usage(), 50);
  });
  test('temporary and unavailable videos are cooled down; expired cooldown allows a bounded retry', async () => {
    await claim();assert.equal((await finish({status: 'unavailable', reason: 'temporary_error'})).retryAfter, 900);
    assert.equal((await claim()).reason, 'temporary_error');assert.equal(await usage(), 1);
    await db.exec("update public.growell_material_video_cache set retry_at=clock_timestamp()-interval '1 second'");
    assert.equal((await claim()).status, 'claimed');assert.equal(await usage(), 2);
    assert.equal((await finish({status: 'unavailable', reason: 'video_unavailable'})).retryAfter, 86400);
    assert.equal((await claim()).reason, 'video_unavailable');assert.equal(await usage(), 2);
  });
  test('expired leases can be recovered and stale completions cannot overwrite newer work', async () => {
    await claim();assert.equal((await finish({status: 'ready', summary}, OTHER)).status, 'pending');
    await db.exec("update public.growell_material_video_cache set lease_until=clock_timestamp()-interval '1 second'");
    assert.equal((await finish()).status, 'pending');assert.equal((await claim(ID, OTHER)).status, 'claimed');
    assert.equal((await finish()).status, 'pending');assert.equal((await finish({status: 'ready', summary}, OTHER)).status, 'ready');assert.equal(await usage(), 2);
  });
  test('invalid outputs cannot become ready, raw provider errors are never retained', async () => {
    await claim();
    for (const invalid of [{overview: '', points: ['x']}, {overview: 'x', points: []}, {overview: 'x', points: [42]}, {overview: 'x'.repeat(1201), points: ['x']}, {overview: 'x', points: Array(9).fill('x')}]) {
      await assert.rejects(finish({status: 'ready', summary: invalid}), e => e.code === '22023');
    }
    assert.equal((await finish({status: 'unavailable', reason: 'provider secret'})).reason, 'temporary_error');
    const stored = (await db.query('select * from public.growell_material_video_cache')).rows[0];assert.equal(stored.reason, 'temporary_error');assert.equal(stored.lease_token, null);
  });
});
