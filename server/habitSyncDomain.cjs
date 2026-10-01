'use strict';

const crypto = require('node:crypto');
const reading = require('../readingHabit.js');
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const LOGIN_ORIGIN = 'https://login.microsoftonline.com';
const SCOPES = 'openid offline_access https://graph.microsoft.com/Tasks.ReadWrite';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class SyncError extends Error {
  constructor(code, status = 503, retryAfter = 0, uncertain = false) {
    super(code); this.code = code; this.status = status; this.retryAfter = retryAfter; this.uncertain = uncertain;
  }
}

function getConfig(env = process.env) {
  let key;
  try { key = Buffer.from(env.GROWELL_SYNC_KEY || '', 'base64'); } catch (_) { key = Buffer.alloc(0); }
  const origin = env.GROWELL_SYNC_ORIGIN || 'https://growell-book.vercel.app';
  const database = env.GROWELL_SUPABASE_URL || 'https://oxaeecawijnetwmvggjs.supabase.co';
  const safeOrigin = /^https:\/\/[^/?#:@]+(?::443)?$/.test(origin);
  const safeDatabase = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(database);
  const config = {
    origin, database, key, clientId: env.GROWELL_MS_CLIENT_ID || '', clientSecret: env.GROWELL_MS_CLIENT_SECRET || '',
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || '', cronSecret: env.CRON_SECRET || '', scopes: SCOPES,
    redirectUri: origin + '/api/habit-sync'
  };
  config.configured = !!(safeOrigin && safeDatabase && key.length === 32 && config.clientId && config.clientSecret && config.serviceKey && config.cronSecret);
  return config;
}

function seal(value, key, context) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
function unseal(value, key, context) {
  try {
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8'));
  } catch (_) { throw new SyncError('connection-key-invalid', 503); }
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function clean(value, length = 500) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length) : '';
}
function validTime(value) { return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function parseTime(value, fallback) {
  const text = clean(value).replace(/^매일\s*/, '');
  if (validTime(text)) return text;
  const match = /^(오전|오후)\s*(\d{1,2})시(?:\s*(\d{1,2})분)?$/.exec(text);
  if (match && +match[2] >= 1 && +match[2] <= 12 && (!match[3] || +match[3] <= 59)) {
    const hour = (+match[2] % 12) + (match[1] === '오후' ? 12 : 0);
    return String(hour).padStart(2, '0') + ':' + String(+(match[3] || 0)).padStart(2, '0');
  }
  if (!validTime(fallback)) throw new SyncError('invalid-time', 400);
  return fallback;
}
function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value && value >= '2000-01-01' && value <= '9999-12-31';
}
function koreanNow(now = Date.now()) { return new Date(now + 9 * 3600000).toISOString().slice(0, 19); }
function nextDay(day) { return new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10); }
function taskPayload(habit, marker, fallback, origin, now = Date.now()) {
  if (!habit || !clean(habit.name, 200) || !UUID.test(marker)) throw new SyncError('invalid-habit', 400);
  if ((habit.start_date && !validDay(habit.start_date)) || (habit.end_date && !validDay(habit.end_date))) throw new SyncError('invalid-habit', 400);
  const current = koreanNow(now), time = parseTime(habit.time, fallback);
  let day = validDay(habit.start_date) && habit.start_date > current.slice(0, 10) ? habit.start_date : current.slice(0, 10);
  if (day + 'T' + time + ':00' <= current) day = nextDay(day);
  const end = validDay(habit.end_date) ? habit.end_date : '';
  if (end && end < day) return null; // Expired habits never produce a new recurring reminder.
  const decoded = reading.decode(habit.goal);
  // A malformed metadata envelope must not expose its private archive IDs.
  const goal = typeof habit.goal === 'string' && habit.goal.startsWith('growell-reading-habit-v1:') && decoded.goal === habit.goal ? '' : clean(decoded.goal);
  const lines = [habit.behavior_type === 'avoid' ? '절제할 습관' : '실천할 습관'];
  if (goal) lines.push('목표: ' + goal);
  if (clean(habit.place)) lines.push('장소: ' + clean(habit.place));
  lines.push('알림: 매일 ' + time + ' (한국 시간)');
  const route = ['emotion', 'thought', 'body', 'action'].includes(habit.book_id) ? habit.book_id : 'emotion';
  const url = origin + '/#/book/' + route + '/habit';
  const markerText = 'GROWELL-SYNC:' + marker;
  lines.push('', '습관의 성공 체크는 GROWELL에서 직접 기록합니다.', url, markerText);
  const recurrence = {
    pattern: {type: 'daily', interval: 1},
    range: {type: end ? 'endDate' : 'noEnd', startDate: day, recurrenceTimeZone: 'Korea Standard Time'}
  };
  if (end) recurrence.range.endDate = end;
  const dateTime = {dateTime: day + 'T' + time + ':00', timeZone: 'Korea Standard Time'};
  return {
    title: clean(habit.name, 200), body: {contentType: 'text', content: lines.join('\n')},
    isReminderOn: true, reminderDateTime: dateTime, dueDateTime: dateTime,
    startDateTime: {dateTime: day + 'T00:00:00', timeZone: 'Korea Standard Time'}, recurrence,
    linkedResources: [{applicationName: 'GROWELL', displayName: 'GROWELL 습관', externalId: marker, webUrl: url}]
  };
}
function hasMarker(task, marker) {
  if (!task || !UUID.test(marker)) return false;
  if (Array.isArray(task.linkedResources) && task.linkedResources.some(link => link && link.applicationName === 'GROWELL' && link.externalId === marker)) return true;
  const content = task.body && task.body.content;
  return typeof content === 'string' && content.includes('GROWELL-SYNC:' + marker) && !/[a-f0-9-]/i.test(content.split('GROWELL-SYNC:' + marker)[1]?.[0] || '');
}
function retryDelay(header, attempts = 0, now = Date.now()) {
  let seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) seconds = Math.ceil((Date.parse(header) - now) / 1000);
  return Math.max(30, Math.min(86400, Number.isFinite(seconds) && seconds > 0 ? seconds : 30 * 2 ** Math.min(attempts, 10)));
}
module.exports = {GRAPH_ORIGIN, LOGIN_ORIGIN, SCOPES, UUID, SyncError, getConfig, seal, unseal, hash, equal, clean, validTime, parseTime, validDay, koreanNow, taskPayload, hasMarker, retryDelay};
