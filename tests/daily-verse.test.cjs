const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const daily=require('../dailyVerseDomain.js');
const verses=Object.freeze(Array.from({length:50},(_,index)=>Object.freeze({reference:'출처 '+index,text:'검증용 원문 '+index})));

test('the first verse begins at Korean midnight on September 23 and stays stable all day',()=>{
  const first=daily.get(verses,'2026-09-22T15:00:00.000Z');
  assert.deepEqual(first,{reference:'출처 0',text:'검증용 원문 0',index:0,dateKey:'2026-09-23'});
  assert.deepEqual(daily.get(verses,'2026-09-23T14:59:59.999Z'),first);
  assert.deepEqual(daily.get(verses,new Date('2026-09-23T12:00:00+09:00')),first);
  assert.equal(daily.get(verses,'2026-09-22T14:59:59.999Z').index,49);
  assert.equal(daily.get(verses,'2026-09-23T15:00:00.000Z').index,1);
});
test('all fifty verses rotate in order and the next cycle starts without modifying source data',()=>{
  const before=JSON.stringify(verses),anchor=Date.parse('2026-09-23T00:00:00+09:00');
  for(let index=0;index<50;index++)assert.equal(daily.get(verses,anchor+index*86400000).index,index);
  assert.equal(daily.get(verses,'2026-11-12T00:00:00+09:00').index,0);
  const selected=daily.get(verses,anchor);selected.text='changed by caller';
  assert.equal(JSON.stringify(verses),before);assert.equal(daily.get(verses,anchor).text,'검증용 원문 0');
});
test('Korean calendar rotation advances once through leap day and year boundaries',()=>{
  for(const dates of [['2028-02-28','2028-02-29','2028-03-01'],['2026-12-31','2027-01-01','2027-01-02']]){
    const selected=dates.map(date=>daily.get(verses,date+'T00:00:00+09:00'));
    assert.deepEqual(selected.map(verse=>verse.dateKey),dates);
    assert.equal(selected[1].index,(selected[0].index+1)%50);
    assert.equal(selected[2].index,(selected[1].index+1)%50);
  }
});
test('empty or unavailable verse data and invalid dates fail without inventing a passage',()=>{
  assert.equal(daily.get([],Date.now()),null);assert.equal(daily.get(null,Date.now()),null);
  assert.equal(daily.get(verses,'invalid'),null);assert.equal(daily.get([{text:'missing reference'}],Date.now()),null);
});
test('the browser module exposes the same deterministic getter without CommonJS',()=>{
  const context=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname,'../dailyVerseDomain.js'),'utf8'),context);
  assert.equal(context.GrowellDailyVerse.get(verses,'2026-09-23T00:00:00+09:00').index,0);
});
