'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {summarize, parseSummary, PROMPT} = require('../server/materialVideoAI.cjs');
const content = {available: true, overview: '영상의 실제 내용을 간략히 설명합니다.', points: ['첫 번째 핵심입니다.', '두 번째 핵심입니다.', '세 번째 핵심입니다.']};

test('video summary adapter sends only a canonical video to the gateway, with no tools or automatic retries', async () => {
  let request, gatewayOptions;
  const sdk = {createGateway(options) {gatewayOptions = options; return id => id;}, async generateText(options) {request = options; return {text: JSON.stringify(content), finishReason: 'stop'};}};
  const result = await summarize('abcdefghijk', {sdk, env: {VERCEL:'1'}});
  assert.equal(result.overview, content.overview); assert.equal(request.messages[0].content[0].data.href, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(request.messages[0].content[0].mediaType, 'video/mp4'); assert.equal(request.maxRetries, 0);
  assert.deepEqual(request.providerOptions.gateway.only, ['google']); assert.equal(request.tools, undefined); assert.deepEqual(gatewayOptions, {});
  assert.equal(request.model, 'google/gemini-2.5-flash'); assert.deepEqual(request.providerOptions.google.thinkingConfig, {thinkingBudget:0});
  assert.match(PROMPT, /untrusted/); assert.match(PROMPT, /Never invent/);
});
test('private credentials stay in the Gemini server header, never the video URL or model body', async () => {
  let url, request;
  const result = await summarize('abcdefghijk', {env:{GEMINI_API_KEY:'synthetic-secret'}, fetch:async (target,options) => {url=target;request=options;return {ok:true,text:async()=>JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(content)}]}}]})};}});
  assert.equal(request.headers['x-goog-api-key'], 'synthetic-secret'); assert.ok(!url.includes('synthetic-secret')); assert.ok(!request.body.includes('synthetic-secret'));
  assert.equal(JSON.parse(request.body).contents[0].parts[0].fileData.fileUri,'https://www.youtube.com/watch?v=abcdefghijk');
  assert.deepEqual(JSON.parse(request.body).generationConfig.thinkingConfig,{thinkingBudget:0});
  assert.equal(result.points.length,3); assert.equal(request.redirect,'error');
});
test('unverified, malformed, oversized and incomplete model answers are never presented as a summary', async () => {
  assert.throws(()=>parseSummary(JSON.stringify({available:false,overview:'Guess',points:[]})),{code:'video_unavailable'});
  for(const value of ['not JSON', JSON.stringify({...content,points:[]}), JSON.stringify({...content,overview:'x'.repeat(1501)}), 'x'.repeat(10001)]) assert.throws(()=>parseSummary(value));
  const sdk={createGateway:()=>id=>id,generateText:async()=>({text:JSON.stringify(content),finishReason:'length'})};
  await assert.rejects(summarize('abcdefghijk',{sdk,env:{}}),{code:'temporary_error'});
});
test('provider failures return fixed public codes without leaking provider body or credentials',async()=>{
  for(const [status,code] of [[401,'not_configured'],[403,'not_configured'],[402,'rate_limited'],[429,'rate_limited'],[400,'temporary_error'],[404,'temporary_error'],[503,'temporary_error']]){
    const sdk={createGateway:()=>id=>id,generateText:async()=>{throw {statusCode:status,message:'private-provider-response'};}};
    await assert.rejects(summarize('abcdefghijk',{sdk,env:{}}),error=>error.code===code&&!error.message.includes('private'));
  }
});
test('unsafe identifiers and configuration fail before provider requests',async()=>{
  await assert.rejects(summarize('../x',{env:{}}),{code:'video_unavailable'});
  await assert.rejects(summarize('abcdefghijk',{env:{}}),{code:'not_configured'});
  await assert.rejects(summarize('abcdefghijk',{env:{GEMINI_API_KEY:'test',GROWELL_VIDEO_MODEL:'../../model'}}),{code:'not_configured'});
});
test('model overrides use the matching reasoning options instead of incompatible parameters',async()=>{
  let request;
  const sdk={createGateway:()=>id=>id,generateText:async options=>{request=options;return {text:JSON.stringify(content),finishReason:'stop'};}};
  await summarize('abcdefghijk',{sdk,env:{GROWELL_VIDEO_MODEL:'google/gemini-3.8-flash'}});
  assert.deepEqual(request.providerOptions.google.thinkingConfig,{thinkingLevel:'low'});
});
