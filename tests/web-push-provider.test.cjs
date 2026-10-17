'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const P=require('../server/webPushProvider.cjs');
function keys(){const e=crypto.createECDH('prime256v1');e.generateKeys();return{publicKey:e.getPublicKey().toString('base64url'),privateKey:e.getPrivateKey().toString('base64url')};}
function subscription(endpoint='https://fcm.googleapis.com/fcm/send/SYNTHETIC_TEST_ENDPOINT'){return{endpoint,expirationTime:null,keys:{p256dh:keys().publicKey,auth:crypto.randomBytes(16).toString('base64url')}};}
test('endpoint accepts only trusted HTTPS Web Push services and rejects SSRF or redirects',()=>{
  for(const host of ['fcm.googleapis.com','updates.push.services.mozilla.com','updates-autopush.push.services.mozilla.com','web.push.apple.com','db5p.notify.windows.com'])assert.equal(P.endpointUrl('https://'+host+'/SYNTHETIC').hostname,host);
  for(const endpoint of ['https://attacker.example/x','http://fcm.googleapis.com/x','https://fcm.googleapis.com.attacker.example/x','https://localhost/x','https://127.0.0.1/x','https://[::1]/x','https://fcm.googleapis.com:8443/x','https://user:secret@fcm.googleapis.com/x','https://fcm.googleapis.com/x#fragment','https://fcm.googleapis.com/','https://notify.windows.com/x','https://fcm.googleapis.com/x\n','file:///private'])assert.throws(()=>P.endpointUrl(endpoint),e=>e.code==='subscription-invalid');
});
test('subscription accepts genuine P-256/auth bytes only and rejects added secret fields',()=>{
  const valid=subscription();assert.deepEqual(P.validateSubscription(valid),valid);
  for(const invalid of [{...valid,keys:{...valid.keys,p256dh:'A'.repeat(87)}},{...valid,keys:{...valid.keys,auth:'short'}},{...valid,keys:{...valid.keys,auth:valid.keys.auth+'='}},{...valid,keys:{...valid.keys,privateKey:'MUST NOT STORE'}},{...valid,expirationTime:Infinity},{...valid,expirationTime:-1},{...valid,injected:'PRIVATE'},{...valid,endpoint:'https://fcm.googleapis.com/'+ 'x'.repeat(5000)}])assert.throws(()=>P.validateSubscription(invalid),e=>e.code==='subscription-invalid');
});
test('VAPID config verifies a matching curve key pair',()=>{
  const pair=keys();assert.equal(P.validateVapid(pair.publicKey,pair.privateKey),true);assert.equal(P.validateVapid(pair.publicKey,keys().privateKey),false);assert.equal(P.validateVapid('PUBLIC','PRIVATE'),false);
});
test('provider awaits encrypted push acceptance and bounds TTL with fixed identity and no proxy',async()=>{
  const pair=keys(),config={configured:true,origin:'https://growell-book.vercel.app',...pair},calls=[];
  let release;const blocked=new Promise(resolve=>{release=resolve;});
  const provider=P.createProvider(config,{sendNotification:async(...args)=>{calls.push(args);await blocked;return{statusCode:201,body:'PRIVATE PROVIDER'};}});
  let finished=false;const promise=provider.send(subscription(),{version:1,type:'test',body:'알림'},999999).then(result=>{finished=true;return result;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);release();assert.deepEqual(await promise,{accepted:true});
  assert.equal(calls.length,1);assert.equal(calls[0][2].TTL,3600);assert.equal(calls[0][2].timeout,6000);assert.equal(calls[0][2].vapidDetails.subject,config.origin);assert.equal(calls[0][2].proxy,undefined);
});
test('provider maps errors to fixed categories without preserving endpoint, headers, or response',async()=>{
  const config={configured:true,origin:'https://growell-book.vercel.app',...keys()};
  for(const [status,code] of [[404,'subscription-gone'],[410,'subscription-gone'],[429,'push-rate-limited'],[500,'push-unavailable'],[503,'push-unavailable'],[400,'push-rejected'],[401,'push-rejected'],[403,'push-rejected'],[302,'push-uncertain'],[undefined,'push-uncertain']]){
    const provider=P.createProvider(config,{sendNotification:async()=>{throw Object.assign(new Error('PRIVATE ENDPOINT AND KEYS'),{statusCode:status,body:'PRIVATE',headers:{authorization:'PRIVATE'}});}});
    await assert.rejects(provider.send(subscription(),{type:'test'}),error=>error.code===code&&!JSON.stringify(error).includes('PRIVATE')&&!error.message.includes('PRIVATE'));
  }
});
test('unsafe endpoint, disabled config and oversized payload never reach the network',async()=>{
  let calls=0;const config={configured:true,origin:'https://growell-book.vercel.app',...keys()},provider=P.createProvider(config,{sendNotification:async()=>{calls++;return{statusCode:201};}});
  await assert.rejects(provider.send(subscription('https://attacker.example/x'),{type:'test'}));
  await assert.rejects(provider.send(subscription(),{body:'x'.repeat(4000)}));
  await assert.rejects(P.createProvider({...config,configured:false},{sendNotification:async()=>{calls++;}}).send(subscription(),{}));assert.equal(calls,0);
});
