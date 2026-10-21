'use strict';

const crypto = require('node:crypto');
const Drive = require('./driveBackupDomain.cjs');
const Calendar = require('./meetingCalendarDomain.cjs');

function verifiedGoogleAccount(user, authId) {
  if (!user || user.id !== authId || !Array.isArray(user.identities)) throw new Drive.BackupError('authentication-required', 401);
  const identities = user.identities.filter(value => value?.provider === 'google');
  if (!identities.length) return null;
  const subject = identities[0]?.identity_data?.sub;
  if (identities.length !== 1 || typeof subject !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(subject)
    || identities[0].provider_id && identities[0].provider_id !== subject) throw new Drive.BackupError('identity-invalid', 403);
  return Drive.hash(subject);
}

async function loadGoogleAccount({config, request, authId}) {
  const user = await request(config.database + '/auth/v1/admin/users/' + encodeURIComponent(authId), {
    headers: {apikey:config.serviceKey, Authorization:'Bearer ' + config.serviceKey}
  }, 'auth');
  return verifiedGoogleAccount(user, authId);
}

function enabledIntent(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || ['drive','calendar','mail'].some(name => typeof value[name] !== 'boolean')) throw new Drive.BackupError('invalid-request', 400);
  return {drive:value.drive, calendar:value.calendar, mail:value.mail};
}

function requireGrantedScopes(tokens) {
  const scopes = new Set(typeof tokens?.scope === 'string' ? tokens.scope.split(/\s+/) : []);
  if (!scopes.has(Drive.DRIVE_SCOPE) || !scopes.has(Calendar.CALENDAR_SCOPE) || !scopes.has('openid')
    || !(scopes.has('email') || scopes.has('https://www.googleapis.com/auth/userinfo.email'))) {
    throw new Drive.BackupError('consent-required', 403);
  }
  if (typeof tokens.refreshToken !== 'string' || !tokens.refreshToken || tokens.refreshToken.length > 16384) {
    throw new Drive.BackupError('consent-required', 403);
  }
}

// Both connectors receive the same explicitly granted Google account, using
// their existing owner-bound encrypted stores. Their RPCs retain same-account
// folder/file IDs and calendar delivery receipts. Never roll back a successful
// connector by disconnecting it when the other RPC has a temporary failure.
async function saveConnections({config, driveStore, calendarStore, mailStore, approved, owner, authId, tokens, identity, desiredEnabled, requestedService}) {
  requireGrantedScopes(tokens);
  const enabled = enabledIntent(desiredEnabled);
  if (enabled && (!['drive','calendar','mail'].includes(requestedService) || enabled[requestedService] !== true)) throw new Drive.BackupError('invalid-request',400);
  // Only the clicked switch is changed. Every other preference is read by its
  // locked SQL connection; OFF is merely the default when no setting exists.
  // An OAuth snapshot must never overwrite another tab's newer ON or OFF.
  const setting = name => enabled ? name === requestedService ? {enabled:true} : {default_enabled:false} : {};
  if (typeof identity?.subject !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(identity.subject)) {
    throw new Drive.BackupError('identity-invalid', 403);
  }
  const accountId = Drive.hash(identity.subject), accountEmail = Drive.clean(identity.email, 254);
  let connected = 0;
  for (const [store, domain, name] of [[driveStore, Drive, 'drive'], [calendarStore, Calendar, 'calendar']]) {
    // Recheck approval between independent writes, including after the first
    // call fails, so revocation cannot authorize a second connector.
    await approved(authId, owner);
    const generation = crypto.randomUUID();
    const payload = {generation, account_id: accountId, account_email: accountEmail, ...setting(name),
      token_cipher: domain.seal({refreshToken: tokens.refreshToken, scope: tokens.scope}, config.key, domain.tokenContext(owner, generation))};
    try {
      await store.configure(owner, authId, 'connect', payload);
      connected++;
    } catch (error) {
      if (['membership-required', 'authentication-required'].includes(error?.code)) throw error;
      // A single failed store is shown as partial rather than claiming that
      // both connected. No old token, authored row, file or event is deleted.
    }
  }
  if (!connected) throw new Drive.BackupError('service-unavailable');
  if (connected === 2 && mailStore) {
    await approved(authId, owner);
    try { await mailStore.configure(owner, authId, 'connect', setting('mail')); }
    catch (error) {
      if (['membership-required', 'authentication-required'].includes(error?.code)) throw error;
      return 'partial';
    }
  }
  return connected === 2 ? 'connected' : 'partial';
}

module.exports = {requireGrantedScopes, saveConnections, verifiedGoogleAccount, loadGoogleAccount, enabledIntent};
