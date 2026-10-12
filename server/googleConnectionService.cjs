'use strict';

const crypto = require('node:crypto');
const Drive = require('./driveBackupDomain.cjs');
const Calendar = require('./meetingCalendarDomain.cjs');

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
async function saveConnections({config, driveStore, calendarStore, mailStore, approved, owner, authId, tokens, identity}) {
  requireGrantedScopes(tokens);
  if (typeof identity?.subject !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(identity.subject)) {
    throw new Drive.BackupError('identity-invalid', 403);
  }
  const accountId = Drive.hash(identity.subject), accountEmail = Drive.clean(identity.email, 254);
  let connected = 0;
  for (const [store, domain] of [[driveStore, Drive], [calendarStore, Calendar]]) {
    // Recheck approval between independent writes, including after the first
    // call fails, so revocation cannot authorize a second connector.
    await approved(authId, owner);
    const generation = crypto.randomUUID();
    const payload = {generation, account_id: accountId, account_email: accountEmail,
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
    try { await mailStore.configure(owner, authId, 'connect', {}); }
    catch (error) {
      if (['membership-required', 'authentication-required'].includes(error?.code)) throw error;
      return 'partial';
    }
  }
  return connected === 2 ? 'connected' : 'partial';
}

module.exports = {requireGrantedScopes, saveConnections};
