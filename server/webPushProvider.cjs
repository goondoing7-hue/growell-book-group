'use strict';

const crypto = require('node:crypto');
const D = require('./driveBackupDomain.cjs');
const MAX_ENDPOINT_BYTES = 4096;
function endpointUrl(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value,'utf8') > MAX_ENDPOINT_BYTES || /[\s\u0000-\u001f\u007f]/.test(value)) throw new D.BackupError('subscription-invalid',400);
  let url; try { url = new URL(value); } catch (_) { throw new D.BackupError('subscription-invalid',400); }
  const host=url.hostname.toLowerCase();
  const allowed=['fcm.googleapis.com','android.googleapis.com','web.push.apple.com','updates.push.services.mozilla.com','push.services.mozilla.com'].includes(host)
    || host.endsWith('.push.services.mozilla.com') || host.endsWith('.notify.windows.com');
  if (!allowed || url.protocol!=='https:' || url.username || url.password || url.hash || url.port && url.port!=='443' || !url.pathname || url.pathname==='/') throw new D.BackupError('subscription-invalid',400);
  return url;
}
function decodeKey(value,length) {
  if (typeof value!=='string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new D.BackupError('subscription-invalid',400);
  const bytes=Buffer.from(value,'base64url');
  if (bytes.length!==length || bytes.toString('base64url')!==value) throw new D.BackupError('subscription-invalid',400);
  return bytes;
}
function publicKey(value) {
  const bytes=decodeKey(value,65);
  try { if(bytes[0]!==4 || !crypto.ECDH.convertKey(bytes,'prime256v1').equals(bytes)) throw new Error(); }
  catch (_) { throw new D.BackupError('subscription-invalid',400); }
  return bytes;
}
function validateSubscription(value) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!['endpoint','expirationTime','keys'].includes(key)) || !value.keys || Object.keys(value.keys).some(key=>!['p256dh','auth'].includes(key))) throw new D.BackupError('subscription-invalid',400);
  endpointUrl(value.endpoint); publicKey(value.keys.p256dh); decodeKey(value.keys.auth,16);
  const expirationTime=value.expirationTime??null;
  if (expirationTime!==null && (!Number.isSafeInteger(expirationTime) || expirationTime<0)) throw new D.BackupError('subscription-invalid',400);
  return {endpoint:value.endpoint,expirationTime,keys:{p256dh:value.keys.p256dh,auth:value.keys.auth}};
}
function validateVapid(publicValue,privateValue) {
  try {
    const publicBytes=publicKey(publicValue),privateBytes=decodeKey(privateValue,32),ecdh=crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(privateBytes);
    return ecdh.getPublicKey().equals(publicBytes);
  } catch (_) { return false; }
}
function createProvider(config,options={}) {
  const send=options.sendNotification || ((...args)=>require('web-push').sendNotification(...args));
  return {
    async send(subscription,payload,ttl=300) {
      const clean=validateSubscription(subscription);
      const text=JSON.stringify(payload);
      if (!config.configured || Buffer.byteLength(text)>3000) throw new D.BackupError('push-unavailable');
      try {
        const response=await send(clean,text,{vapidDetails:{subject:config.origin,publicKey:config.publicKey,privateKey:config.privateKey},TTL:Math.max(1,Math.min(3600,Math.floor(ttl))),urgency:'normal',timeout:6000});
        if (!response || ![200,201,202,204].includes(response.statusCode)) throw Object.assign(new Error(),{statusCode:response?.statusCode});
        return {accepted:true};
      } catch(error) {
        // Do not return provider response bodies, endpoints, request headers, or
        // keys: push libraries attach those credentials to rejection objects.
        const status=Number(error?.statusCode);
        if ([404,410].includes(status)) throw new D.BackupError('subscription-gone',410);
        if (status===429) throw new D.BackupError('push-rate-limited',429,300);
        if (status>=500 && status<=599) throw new D.BackupError('push-unavailable',503,120);
        if (status>=400 && status<=499) throw new D.BackupError('push-rejected',502);
        throw new D.BackupError('push-uncertain',503,300,true);
      }
    }
  };
}
module.exports={MAX_ENDPOINT_BYTES,endpointUrl,decodeKey,validateSubscription,validateVapid,createProvider};
