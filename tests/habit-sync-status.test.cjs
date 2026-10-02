'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createStore, createService} = require('../server/habitSyncService.cjs');
const now = () => Date.parse('2026-10-02T03:00:00Z');
const owner = 'fixture-owner', generation = 'fixture-generation';
const profile = {id: owner};
function fixture(overrides = {}) {
  const connection = {token_cipher: 'PRIVATE_TOKEN', enabled: true, generation, list_id: 'PRIVATE_LIST'};
  const habits = ['synced', 'pending', 'attention', 'unlinked', 'old', 'foreign', 'missing', 'ended'].map(id => ({id, user_id: owner, name: id, time: '오후 4시', start_date: '2026-10-01', end_date: id === 'ended' ? '2026-10-01' : '', goal: 'PRIVATE_GOAL'}));
  habits.push({id: 'other-owner', user_id: 'other', name: 'PRIVATE_OTHER'});
  const tracked = ['synced', 'pending', 'attention', 'old', 'foreign', 'missing'].map(id => ({habit_id: id, owner_id: id === 'foreign' ? 'other' : owner, generation: id === 'old' ? 'previous-generation' : generation, task_id: id === 'missing' ? null : 'PRIVATE_TASK', pending: id === 'pending', last_error: id === 'attention' ? 'remote-missing' : null, marker: 'PRIVATE_MARKER', desired: {goal: 'PRIVATE_DESIRED'}}));
  const calls = [];
  const store = {connection: async id => {calls.push(['connection', id]); return connection;}, pending: async id => {calls.push(['pending', id]);return 1;}, habits: async id => {calls.push(['habits', id]);return habits;}, tracked: async (...args) => {calls.push(['tracked', ...args]);return tracked;}, ...overrides};
  return {service: createService({store, config: {}, now}), calls, habits, tracked};
}
test('status separates current owner habits by actual queue state without exposing provider metadata', async () => {
  const h = fixture(), result = await h.service.status(profile);
  assert.deepEqual(result.habits.map(row => [row.habitId, row.state]), [['synced','synced'],['pending','pending'],['attention','attention'],['unlinked','unlinked'],['old','unlinked'],['foreign','unlinked'],['missing','pending'],['ended','unlinked']]);
  assert.equal(result.habits[0].time, '16:00');
  assert.equal(result.habits.at(-1).canConnect, false);
  assert.equal(result.habits[2].errorCode, 'remote-missing');
  assert.equal(result.pendingCount, 1);
  assert.ok(!h.calls.some(call => call[0] === 'pending'), 'count and rows come from the same queue read');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|fixture-generation|fixture-owner/);
  assert.ok(h.calls.some(call => JSON.stringify(call) === JSON.stringify(['tracked',owner,generation])));
});
test('disconnected account shows available habits as unlinked and never reads stale provider mappings', async () => {
  const h = fixture({connection: async () => null, tracked: async () => {throw new Error('must not read old account');}});
  const result = await h.service.status(profile);
  assert.equal(result.connected, false);
  assert.ok(result.habits.every(row => row.state === 'unlinked'));
});
test('malformed reads fail closed instead of presenting all habits as unlinked', async () => {
  await assert.rejects(fixture({habits: async () => null}).service.status(profile), /service-unavailable/);
  await assert.rejects(fixture({tracked: async () => ({})}).service.status(profile), /service-unavailable/);
});
test('status omits unknown error text and never invents an exact time or valid end date', async () => {
  const h = fixture();h.tracked[0].last_error='PRIVATE_PROVIDER_ERROR';
  h.habits[0].time='잠들기 전';h.habits[0].end_date='invalid';
  const row = (await h.service.status(profile)).habits[0];
  assert.equal(row.errorCode,'service-unavailable');assert.equal(row.state,'attention');assert.equal(row.time,'');assert.equal(row.canConnect,false);
});

test('status exposes normalized weekdays and blocks schedules with no remaining occurrence', async () => {
  const h = fixture();
  h.habits[0].weekdays=[5,1,3,1];
  h.habits[1].weekdays=[1];h.habits[1].end_date='2026-10-04';
  h.habits[2].weekdays=[];
  const rows=(await h.service.status(profile)).habits;
  assert.deepEqual(rows[0].weekdays,[1,3,5]);assert.equal(rows[0].scheduleLabel,'월·수·금');assert.equal(rows[0].canConnect,true);
  assert.equal(rows[1].canConnect,false);assert.equal(rows[2].canConnect,false);
  assert.deepEqual(rows[3].weekdays,[0,1,2,3,4,5,6]);assert.equal(rows[3].scheduleLabel,'매일');
});
test('status storage paginates owner-scoped reads and limits selected fields', async () => {
  const calls = [], store = createStore({database:'https://fixture.supabase.co',serviceKey:'PRIVATE_SERVICE'}, async url => {
    calls.push(new URL(url));return calls.length === 1 ? Array.from({length:1000},(_,id)=>({id})) : [{id:'last'}];
  });
  assert.equal((await store.habits('owner value')).length,1001);
  assert.equal(calls[0].searchParams.get('user_id'),'eq.owner value');assert.equal(calls[1].searchParams.get('offset'),'1000');
  assert.equal(calls[0].searchParams.get('order'),'id.asc');assert.doesNotMatch(calls[0].searchParams.get('select'),/goal|place|checked|\*/);
  assert.match(calls[0].searchParams.get('select'),/weekdays/);
  const queries = [], queueStore=createStore({database:'https://fixture.supabase.co',serviceKey:'PRIVATE_SERVICE'},async url=>{queries.push(new URL(url));return [];});
  await queueStore.tracked('owner','generation');assert.equal(queries[0].searchParams.get('owner_id'),'eq.owner');assert.equal(queries[0].searchParams.get('generation'),'eq.generation');
  assert.doesNotMatch(queries[0].searchParams.get('select'),/desired|marker|token|\*/);
});
