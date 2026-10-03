'use strict';
const {describe, test, before, beforeEach, after} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {PGlite} = require('@electric-sql/pglite');
const nativeSql = fs.readFileSync(path.join(__dirname, '../server/material-video-transcript.sql'), 'utf8');
const translationSql = fs.readFileSync(path.join(__dirname, '../server/material-video-translation.sql'), 'utf8');
const AUTH = '11111111-1111-4111-8111-111111111111';
const OTHER_AUTH = '33333333-3333-4333-8333-333333333333';
const GENERATION = '22222222-2222-4222-8222-222222222222';
const ID = 'aBcDeFg1234';
const original = {text: 'First original caption.\nThe next paragraph stays in English.', language: 'en', source: 'youtube_captions', title: 'Actual video title'};
const translated = {status: 'ready', text: '첫 번째 자막입니다.\n다음 문단도 온전히 번역합니다.', model: 'google/gemini-2.5-flash', inputTokens: 125, outputTokens: 84, durationMs: 920};

describe('Korean translation PostgreSQL persistence and one-time spending', () => {
  let db;
  before(async () => {
    db = new PGlite();
    await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      create table public.profiles(id text primary key,auth_user_id uuid not null unique,is_deleted boolean not null default false,approval_status text not null default 'approved');
      create table public.material_notes(id text primary key,html text);insert into public.material_notes values('existing','untouched');`);
    await db.exec(nativeSql);
    await db.exec(translationSql);
  });
  beforeEach(async () => {
    await db.exec('reset role;truncate public.growell_material_translation_cache,public.growell_material_transcript_cache,public.growell_material_transcript_usage,public.profiles');
    await db.query('insert into public.profiles(id,auth_user_id) values($1,$2::uuid),($3,$4::uuid)', ['owner', AUTH, 'other', OTHER_AUTH]);
    await native();
  });
  after(async () => {await db?.close();});
  async function role(name, operation) {await db.exec('set role ' + name);try {return await operation();} finally {await db.exec('reset role');}}
  async function native(id = ID, content = original, version = 2) {
    await db.query("insert into public.growell_material_transcript_cache(video_id,version,state,transcript,fetched_at) values($1,$2,'ready',$3::jsonb,clock_timestamp())", [id, version, JSON.stringify(content)]);
  }
  async function rawClaim({id = ID, version = 2, translationVersion = 1, owner = 'owner', auth = AUTH, generation = GENERATION, enabled = true} = {}) {
    return (await db.query('select public.growell_material_translation_claim($1,$2,$3,$4,$5::uuid,$6::uuid,$7::boolean) as value', [id, version, translationVersion, owner, auth, generation, enabled])).rows[0].value;
  }
  const claim = options => role('service_role', () => rawClaim(options));
  async function rawFinish(result = translated, generation = GENERATION) {
    return (await db.query('select public.growell_material_translation_finish($1::uuid,$2::jsonb) as value', [generation, JSON.stringify(result)])).rows[0].value;
  }
  const finish = (result, generation) => role('service_role', () => rawFinish(result, generation));
  const count = async () => Number((await db.query('select count(*) as n from public.growell_material_translation_cache')).rows[0].n);
  const row = async () => (await db.query('select * from public.growell_material_translation_cache where generation_id=$1::uuid', [GENERATION])).rows[0];
  async function seedQuota(number, {owner = 'other', age = '0 days'} = {}) {
    await db.query(`insert into public.growell_material_transcript_cache(video_id,version,state,transcript,fetched_at)
      select 'seed_'||lpad(i::text,6,'0'),2,'ready',$2::jsonb,clock_timestamp() from generate_series(1,$1::integer) i`, [number, JSON.stringify(original)]);
    await db.query(`insert into public.growell_material_translation_cache(generation_id,video_id,transcript_version,translation_version,owner_id,state,lease_until,created_at,reason)
      select md5('generation-'||i::text)::uuid,'seed_'||lpad(i::text,6,'0'),2,1,$2,'unavailable',clock_timestamp()-$3::interval,
        date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' - $3::interval,'translation_failed'
      from generate_series(1,$1::integer) i`, [number, owner, age]);
  }

  test('anonymous and signed-in browser roles cannot read or mutate cache or execute either RPC', async () => {
    for (const name of ['anon', 'authenticated']) {
      await assert.rejects(role(name, () => db.query('select * from public.growell_material_translation_cache')), e => e.code === '42501');
      await assert.rejects(role(name, () => db.query("delete from public.growell_material_translation_cache")), e => e.code === '42501');
      await assert.rejects(role(name, () => rawClaim()), e => e.code === '42501');
      await assert.rejects(role(name, () => rawFinish()), e => e.code === '42501');
    }
    assert.equal((await db.query("select relrowsecurity from pg_class where relname='growell_material_translation_cache'")).rows[0].relrowsecurity, true);
    assert.equal(await count(), 0);
  });
  test('only matching approved active membership can reserve or read a translation', async () => {
    await assert.rejects(claim({auth: OTHER_AUTH}), e => e.code === '42501');
    await assert.rejects(claim({owner: 'absent'}), e => e.code === '42501');
    await db.exec("update public.profiles set approval_status='pending' where id='owner'");
    await assert.rejects(claim(), e => e.code === '42501');
    await db.exec("update public.profiles set approval_status='approved',is_deleted=true where id='owner'");
    await assert.rejects(claim(), e => e.code === '42501');
    assert.equal(await count(), 0);
    await db.exec("update public.profiles set is_deleted=false where id='owner'");
    await claim();await finish();
    await db.exec("update public.profiles set approval_status='pending' where id='owner'");
    await assert.rejects(claim(), e => e.code === '42501');
  });
  test('valid generation identity is persisted before generation and duplicate claims cannot reserve again', async () => {
    for (const options of [{generation: null}, {id: 'invalid'}, {version: 0}, {translationVersion: 1000}]) {
      await assert.rejects(claim(options), e => e.code === '22023');
    }
    assert.deepEqual(await claim(), {status: 'claimed', generationId: GENERATION});
    const saved = await row();assert.equal(saved.generation_id, GENERATION);assert.equal(saved.state, 'pending');assert.equal(saved.translation, null);
    assert.equal(saved.owner_id, 'owner');assert.ok(new Date(saved.lease_until) > new Date(saved.created_at));
    assert.deepEqual(await claim({generation: randomUUID()}), {status: 'pending'});
    assert.deepEqual(await claim({owner: 'other', auth: OTHER_AUTH, generation: randomUUID()}), {status: 'pending'});
    assert.equal(await count(), 1);
  });
  test('successful complete Korean text and metadata are saved once while English source remains unchanged', async () => {
    const before = (await db.query('select * from public.growell_material_transcript_cache')).rows;
    await claim();const result = await finish();
    assert.equal(result.status, 'ready');assert.equal(result.translation.text, translated.text);
    assert.equal(result.translation.language, 'ko');assert.equal(result.translation.source, 'ai_translation');
    assert.equal(result.translation.generationId, GENERATION);assert.equal(result.translation.model, translated.model);assert.ok(result.translation.generatedAt);
    const saved = await row();assert.equal(saved.input_tokens, 125);assert.equal(saved.output_tokens, 84);assert.equal(saved.duration_ms, 920);assert.ok(saved.finished_at);
    assert.deepEqual((await db.query('select * from public.growell_material_transcript_cache')).rows, before);
    assert.deepEqual(await finish({...translated, text: '다른 번역으로 바꾸지 않습니다.'}), result);
    assert.deepEqual(await finish({status: 'unavailable'}), result);
  });
  test('ready translations are shared free across approved readers even after provider or quota is unavailable', async () => {
    await claim();const ready = await finish();
    await seedQuota(20);
    assert.deepEqual(await claim({enabled: false, owner: 'other', auth: OTHER_AUTH, generation: randomUUID()}), ready);
    assert.deepEqual(await claim({generation: randomUUID()}), ready);assert.equal(await count(), 21);
    assert.equal(Number((await db.query('select coalesce(sum(attempts),0) as n from public.growell_material_transcript_usage')).rows[0].n), 0);
  });
  test('failed partial generations preserve audit data privately and never incur an automatic paid retry', async () => {
    await claim();
    const failure = {status: 'unavailable', model: translated.model, partial: [{index: 0, text: '보존할 첫 번째 번역 조각'}], inputTokens: 200, outputTokens: 100, durationMs: 1234};
    assert.deepEqual(await finish(failure), {status: 'unavailable'});
    const saved = await row();assert.deepEqual(saved.partial_output, failure.partial);assert.equal(saved.reason, 'translation_failed');
    assert.equal(saved.model, failure.model);assert.equal(saved.input_tokens, 200);assert.equal(saved.output_tokens, 100);assert.equal(saved.duration_ms, 1234);
    for (let n = 0; n < 3; n++) assert.deepEqual(await claim({generation: randomUUID()}), {status: 'unavailable'});
    assert.deepEqual(await finish(), {status: 'unavailable'});assert.equal(await count(), 1);assert.deepEqual((await row()).partial_output, failure.partial);
  });
  test('expired in-flight work does not restart; its original late successful result can still be preserved', async () => {
    await claim();await db.exec("update public.growell_material_translation_cache set lease_until=clock_timestamp()-interval '1 second'");
    assert.deepEqual(await claim({generation: randomUUID()}), {status: 'unavailable'});
    assert.equal((await row()).reason, 'translation_interrupted');assert.equal(await count(), 1);
    assert.deepEqual(await claim({generation: randomUUID()}), {status: 'unavailable'});
    const success = await finish();assert.equal(success.status, 'ready');assert.equal(success.translation.generationId, GENERATION);
    assert.equal((await row()).reason, null);assert.deepEqual(await claim({enabled: false}), success);
  });
  test('native Korean, other languages, missing or pending captions do not consume a generation', async () => {
    for (const language of ['ko', 'ko-KR', 'ja']) {
      await db.query('update public.growell_material_transcript_cache set transcript=$1::jsonb', [JSON.stringify({...original, language})]);
      assert.deepEqual(await claim(), {status: 'unavailable'});
    }
    assert.deepEqual(await claim({id: 'missing1234'}), {status: 'unavailable'});
    await db.exec("update public.growell_material_transcript_cache set state='pending',transcript=null,fetched_at=null");
    assert.deepEqual(await claim(), {status: 'unavailable'});assert.equal(await count(), 0);
  });
  test('English regional variants are accepted, disabled providers and more than 60,000 characters are not', async () => {
    assert.deepEqual(await claim({enabled: false}), {status: 'unavailable'});
    await db.query('update public.growell_material_transcript_cache set transcript=$1::jsonb', [JSON.stringify({...original, text: 'x'.repeat(60001)})]);
    assert.deepEqual(await claim(), {status: 'unavailable'});assert.equal(await count(), 0);
    await db.query('update public.growell_material_transcript_cache set transcript=$1::jsonb', [JSON.stringify({...original, language: 'EN-us', text: 'x'.repeat(60000)})]);
    assert.equal((await claim()).status, 'claimed');
  });
  test('daily member cap includes failed attempts and rejects the eleventh fresh generation', async () => {
    await seedQuota(10, {owner: 'owner'});
    assert.deepEqual(await claim(), {status: 'unavailable'});assert.equal(await count(), 10);
    assert.equal((await claim({owner: 'other', auth: OTHER_AUTH})).status, 'claimed');assert.equal(await count(), 11);
  });
  test('global daily cap rejects a twenty-first generation regardless of member', async () => {
    await seedQuota(20);
    assert.deepEqual(await claim(), {status: 'unavailable'});assert.equal(await count(), 20);
  });
  test('rolling 31-day ceiling includes the thirtieth prior Korean date and excludes older dates', async () => {
    await seedQuota(100, {age: '30 days'});
    assert.deepEqual(await claim(), {status: 'unavailable'});assert.equal(await count(), 100);
    await db.exec("update public.growell_material_translation_cache set created_at=created_at-interval '1 day'");
    assert.equal((await claim()).status, 'claimed');assert.equal(await count(), 101);
  });
  test('invalid ready output never replaces a pending generation or mutates native captions', async () => {
    await claim();
    for (const bad of [{...translated, text: ''}, {...translated, text: 'English only'}, {...translated, text: '한글\u0001제어 문자'}, {...translated, text: '한'.repeat(349526)}, {...translated, model: null}, {...translated, model: 'x\nunsafe'}]) {
      await assert.rejects(finish(bad), e => e.code === '22023');
      assert.equal((await row()).state, 'pending');
    }
    assert.deepEqual(await finish(translated, randomUUID()), {status: 'unavailable'});
    assert.deepEqual((await db.query('select transcript from public.growell_material_transcript_cache where video_id=$1', [ID])).rows[0].transcript, original);
    assert.equal((await finish()).status, 'ready');
  });
  test('reapplying both additive migrations preserves completed, partial and native material data', async () => {
    await claim();const ready = await finish();
    const secondId = 'second12345', secondGeneration = randomUUID();await native(secondId);
    await claim({id: secondId, generation: secondGeneration});
    await finish({status: 'unavailable', model: translated.model, partial: [{index: 0, text: '보존하는 번역 조각'}]}, secondGeneration);
    const before = (await db.query('select * from public.growell_material_translation_cache order by video_id')).rows;
    await db.exec(nativeSql);await db.exec(translationSql);
    assert.deepEqual((await db.query('select * from public.growell_material_translation_cache order by video_id')).rows, before);
    assert.deepEqual(await claim(), ready);
    assert.deepEqual((await db.query('select * from public.material_notes')).rows, [{id: 'existing', html: 'untouched'}]);
    assert.deepEqual((await db.query('select transcript from public.growell_material_transcript_cache where video_id=$1', [ID])).rows[0].transcript, original);
  });
});
