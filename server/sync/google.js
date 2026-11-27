// Google Calendar: OAuth, calendar list, event sync (near/far windows), plan calendar write-back,
// and detection of changes you make in Google/Apple Calendar (move = pin, delete or /later = postpone, /done or ✓/x = done, /skip = skip this round).
import { serverConf, baseUrl, publicUrl } from '../serverconf.js';
import { all, get, run, tx, J } from '../db.js';
import { encrypt, decrypt, randomToken } from '../crypto.js';
import { settingsOf, saveSettings, taskById } from '../models.js';
import { parseKey, partPoints } from '../planner.js';
import { dayStart, isoDate } from '../time.js';
import { randomUUID, createHash } from 'node:crypto';
import { withLock } from '../lock.js';
import { storeEvents } from './store.js';
import { userTag } from '../conflicts.js';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth', TOKEN = 'https://oauth2.googleapis.com/token', API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar'];
export const TAG = '[smart-calendar]';
export const DONE_RE = /^\s*(✓|✔|☑|\[x\]|x\s|x$|X\s|X$|done\b|erledigt\b)/i;
// commands typed into a planned block's title or notes: /done, /later, /skip
const CMD_RE = /(?:^|\s)\/(done|later|skip)\b/i, CMD_ALL = /(^|\s)\/(done|later|skip)\b/gi;
const ownLine = l => l.includes(TAG);   // the app's own hint line ("Type /done …") is not a command
export const blockCommand = e => (String(e.summary || '') + '\n' + String(e.description || '').split('\n').filter(l => !ownLine(l)).join('\n')).match(CMD_RE)?.[1].toLowerCase() || null;
// one ✓ in front, whatever was there (✓, x, done, ▷, the command): never piles up
const LEAD = /^\s*(?:(?:✓|✔|☑|\[x\]|x(?=\s|$)|done\b|erledigt\b|▷)\s*)+/i;
export const doneTitle = t => '✓ ' + stripCmd(t).replace(LEAD, '').trim();
const stripCmd = s => String(s || '').split('\n').map(l => ownLine(l) ? l : l.replace(CMD_ALL, '$1').replace(/[ \t]{2,}/g, ' ').trimEnd()).join('\n').trim();
export const enabled = () => { const c = serverConf(); return !!(c.googleClientId && c.googleClientSecret); };
export const redirectUri = () => `${baseUrl()}/api/google/callback`;

// ---------- OAuth ----------
const pending = new Map();   // state -> { uid, exp }
export function authUrl(uid) {
  const state = randomToken(24);
  pending.set(state, { uid, exp: Date.now() + 10 * 60000 });
  for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
  const q = new URLSearchParams({ client_id: serverConf().googleClientId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return `${AUTH}?${q}`;
}
export async function handleCallback(uid, state, code) {
  const p = pending.get(state); pending.delete(state);
  if (!p || p.uid !== uid || p.exp < Date.now()) throw new Error('Sign-in expired or was started in another session. Please try again.');
  const r = await fetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: serverConf().googleClientId, client_secret: serverConf().googleClientSecret, redirect_uri: redirectUri(), grant_type: 'authorization_code' }) });
  const tok = await r.json();
  if (!r.ok || !tok.refresh_token) throw new Error('Google did not return a refresh token: ' + (tok.error_description || tok.error || r.status));
  const claims = JSON.parse(Buffer.from(String(tok.id_token || '..').split('.')[1] || '', 'base64url').toString() || '{}');
  const email = claims.email || 'Google account';
  const ex = get(`SELECT id FROM accounts WHERE user_id = ? AND kind = 'google' AND label = ?`, uid, email);
  let id;
  if (ex) { run(`UPDATE accounts SET secret = ?, status = 'ok', error = NULL WHERE id = ?`, encrypt({ refresh_token: tok.refresh_token }), ex.id); id = ex.id; }
  else id = Number(run(`INSERT INTO accounts(user_id, kind, label, secret) VALUES (?, 'google', ?, ?)`, uid, email, encrypt({ refresh_token: tok.refresh_token })).lastInsertRowid);
  tokens.set(id, { access: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 });
  const acc = get('SELECT * FROM accounts WHERE id = ?', id);
  await syncCalendarList(acc);
  // zero-question setup: the plan goes into a dedicated "Smart Calendar" calendar in this account
  const s = settingsOf(uid);
  if (!s.plan.calendarId || !get('SELECT 1 FROM calendars WHERE id = ?', s.plan.calendarId)) {
    const ex = get(`SELECT * FROM calendars WHERE account_id = ? AND name = 'Smart Calendar' AND writable = 1`, id) || await createCalendar(acc, 'Smart Calendar');
    s.plan.calendarId = ex.id; saveSettings(uid, s);
    run('UPDATE calendars SET is_plan = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE user_id = ?', ex.id, uid);
  }
  return id;
}

const tokens = new Map();
async function accessToken(acc) {
  const c = tokens.get(acc.id); if (c && c.exp > Date.now()) return c.access;
  const { refresh_token } = decrypt(acc.secret);
  const r = await fetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token, client_id: serverConf().googleClientId, client_secret: serverConf().googleClientSecret, grant_type: 'refresh_token' }) });
  const tok = await r.json();
  if (!r.ok) {
    const e = new Error(tok.error === 'invalid_grant' ? 'Google access was revoked or expired. Reconnect the account.' : 'Token refresh failed: ' + (tok.error_description || tok.error));
    e.auth = tok.error === 'invalid_grant'; throw e;
  }
  tokens.set(acc.id, { access: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 });
  return tok.access_token;
}
async function api(acc, method, path, body, query) {
  const url = API + path + (query ? '?' + new URLSearchParams(query) : '');
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { method, headers: { authorization: 'Bearer ' + await accessToken(acc), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && attempt === 0) { tokens.delete(acc.id); continue; }
    if ((r.status === 429 || r.status === 403 && /rate/i.test(await r.clone().text())) && attempt < 3) { await new Promise(s => setTimeout(s, 1000 * 2 ** attempt)); continue; }
    if (r.status === 204) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(`Google ${method} ${path}: ${r.status} ${j.error?.message || ''}`); e.status = r.status; throw e; }
    return j;
  }
}

// ---------- calendars ----------
export async function syncCalendarList(acc) {
  let items = [], pageToken;
  do { const j = await api(acc, 'GET', '/users/me/calendarList', null, { maxResults: '250', ...(pageToken ? { pageToken } : {}) }); items.push(...(j.items || [])); pageToken = j.nextPageToken; } while (pageToken);
  const have = new Set();
  for (const c of items) {
    have.add(c.id);
    const writable = ['owner', 'writer'].includes(c.accessRole) ? 1 : 0;
    run(`INSERT INTO calendars(account_id, user_id, ext_id, name, color, writable, use_busy) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, ext_id) DO UPDATE SET name = excluded.name, color = excluded.color, writable = excluded.writable`,
      acc.id, acc.user_id, c.id, c.summaryOverride || c.summary || c.id, c.backgroundColor || null, writable, c.primary ? 1 : 0);
  }
  all('SELECT id, ext_id FROM calendars WHERE account_id = ?', acc.id).forEach(c => { if (!have.has(c.ext_id)) run('DELETE FROM calendars WHERE id = ?', c.id); });
}
export async function createCalendar(acc, name) {
  const c = await api(acc, 'POST', '/calendars', { summary: name, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  await syncCalendarList(acc);
  return get('SELECT * FROM calendars WHERE account_id = ? AND ext_id = ?', acc.id, c.id);
}

const evTime = (t, end) => t.dateTime ? Date.parse(t.dateTime) : dayStart(t.date);
const isOurs = (e, known) => e.extendedProperties?.private?.sc === '1' || known.has(e.id) || /\[smart-calendar/.test(e.description || '');

// ---------- push: Google tells this server as soon as something changes in a calendar ----------
// needs the app's public https address (Administration → Server → Address); a channel lasts a week and is renewed a day before
export const pushUrl = () => publicUrl('/api/google/push');
export async function watchCalendar(acc, cal) {
  const url = pushUrl(), w = J(cal.watch, null);
  if (!url || (w && w.exp > Date.now() + 864e5)) return w;
  const id = randomUUID(), token = randomToken(24);
  const r = await api(acc, 'POST', `/calendars/${encodeURIComponent(cal.ext_id)}/events/watch`, { id, type: 'web_hook', address: url, token, params: { ttl: String(7 * 86400) } });
  const nw = { id, res: r.resourceId, token, exp: +r.expiration || Date.now() + 7 * 864e5 };
  run('UPDATE calendars SET watch = ? WHERE id = ?', JSON.stringify(nw), cal.id);
  if (w) await api(acc, 'POST', '/channels/stop', { id: w.id, resourceId: w.res }).catch(() => {});
  return nw;
}

// replace cached events of one calendar in [from, to)
export async function syncEvents(acc, cal, from, to) {
  const items = []; let pageToken;
  do {
    const j = await api(acc, 'GET', `/calendars/${encodeURIComponent(cal.ext_id)}/events`, null,
      { singleEvents: 'true', timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), maxResults: '2500', showDeleted: 'false', ...(pageToken ? { pageToken } : {}) });
    items.push(...(j.items || [])); pageToken = j.nextPageToken;
  } while (pageToken);
  const known = new Set(all('SELECT ext_id FROM plan_events WHERE calendar_id = ?', cal.id).map(r => r.ext_id));
  // only what differs from the cache is written (unchanged events keep their row and id)
  const rows = items.filter(e => e.status !== 'cancelled' && e.start).map(e => {
    const declined = (e.attendees || []).some(a => a.self && a.responseStatus === 'declined');
    return { ext_id: e.id, series: e.recurringEventId || e.id, start: evTime(e.start), end: evTime(e.end || e.start, true), all_day: e.start.date ? 1 : 0, title: e.summary || '(busy)',
      free: (e.transparency === 'transparent' || declined) ? 1 : 0, ours: isOurs(e, known) ? 1 : 0, descr: String(e.description || '').slice(0, 2000),
      location: e.location ? String(e.location).slice(0, 500) : null, link: e.hangoutLink || e.conferenceData?.entryPoints?.find(p => p.entryPointType === 'video')?.uri || null,
      dup: e.extendedProperties?.private?.scdup || e.extendedProperties?.shared?.scdup || null };
  });
  const changes = storeEvents(cal.id, rows, 'end > ? AND start < ?', [from, to]);
  if (cal.writable) await tidyTitleTags(acc, cal, items, known);
  if (cal.writable) await flexToTasks(acc, cal, items, known);
  if (cal.is_plan) await detectPlanChanges(acc, cal, items, from, to);
  return changes;     // events added, changed or removed in the cache
}

// /block, /free, /hide typed into the title of one of your events: taken out of the title (it would look bad everywhere),
// kept in the notes, and the event set to Busy / Free so every calendar app shows it right
const TITLE_TAG = /(^|\s)\/(block|free|frei|hide)\b/gi;
async function tidyTitleTags(acc, cal, items, known) {
  for (const e of items) {
    if (e.status === 'cancelled' || !e.summary || isOurs(e, known) || !e.summary.match(TITLE_TAG)) continue;
    const tags = [...new Set([...e.summary.matchAll(TITLE_TAG)].map(m => m[2].toLowerCase().replace('frei', 'free')))];
    const summary = e.summary.replace(TITLE_TAG, '$1').replace(/\s{2,}/g, ' ').trim() || 'Busy';
    const desc = String(e.description || ''), add = tags.filter(t => !new RegExp(`(^|\\s)/${t}\\b`, 'i').test(desc)).map(t => '/' + t);
    const body = { summary, description: [desc.trim(), add.join(' ')].filter(Boolean).join('\n\n') };
    if (tags.includes('block')) body.transparency = 'opaque'; else body.transparency = 'transparent';
    try {
      await api(acc, 'PATCH', `/calendars/${encodeURIComponent(cal.ext_id)}/events/${encodeURIComponent(e.id)}`, body);
      run('UPDATE events SET title = ?, descr = ?, free = ? WHERE calendar_id = ? AND ext_id = ?', summary, body.description.slice(0, 2000), body.transparency === 'transparent' ? 1 : 0, cal.id, e.id);
    } catch {}
  }
}

// /flex or /task typed into one of your events: it becomes a planned task (see flex.js), the event goes away
async function flexToTasks(acc, cal, items, known) {
  const { parseFlex, eventToTask } = await import('../flex.js');
  for (const e of items) {
    if (e.status === 'cancelled' || !e.start || isOurs(e, known)) continue;
    const f = parseFlex(e.summary, e.description); if (!f) continue;
    try {
      eventToTask(cal.user_id, { calendar_id: cal.id, ext_id: e.id, start: evTime(e.start), end: evTime(e.end || e.start, true), title: e.summary, descr: e.description, location: e.location }, f);
      await api(acc, 'DELETE', `/calendars/${encodeURIComponent(cal.ext_id)}/events/${encodeURIComponent(e.id)}`).catch(x => { if (x.status !== 404 && x.status !== 410) throw x; });
      run('DELETE FROM events WHERE calendar_id = ? AND ext_id = ?', cal.id, e.id);
    } catch {}
  }
}

// ---------- what did you change in the calendar? ----------
async function detectPlanChanges(acc, cal, items, from, to) {
  const byId = new Map(items.filter(e => e.status !== 'cancelled').map(e => [e.id, e]));
  const rows = all('SELECT * FROM plan_events WHERE calendar_id = ? AND kept = 0 AND end > ? AND start < ?', cal.id, from, to);
  const changes = [];
  for (const r of rows) {
    let e = byId.get(r.ext_id);
    if (!e) {   // gone from this window: deleted, or moved somewhere else
      try { e = await api(acc, 'GET', `/calendars/${encodeURIComponent(cal.ext_id)}/events/${encodeURIComponent(r.ext_id)}`); } catch (x) { if (x.status !== 404 && x.status !== 410) continue; e = null; }
      if (!e || e.status === 'cancelled') { changes.push({ r, kind: 'deleted' }); continue; }
    }
    const cmd = blockCommand(e);
    if (cmd || DONE_RE.test(e.summary || '')) { changes.push({ r, kind: cmd || 'done', e, cmd }); continue; }
    const s = evTime(e.start), en = evTime(e.end);
    if (Math.abs(s - r.start) > 60000 || Math.abs(en - r.end) > 60000) changes.push({ r, kind: 'moved', s, e: en });
  }
  if (!changes.length) return;
  const { applyCalendarChange } = await import('../actions.js');
  for (const c of changes) {
    applyCalendarChange(cal.user_id, c);
    if (!c.cmd && (c.kind !== 'done' || doneTitle(c.e.summary) === c.e.summary)) continue;   // "x …" typed by hand becomes "✓ …" too
    const path = `/calendars/${encodeURIComponent(cal.ext_id)}/events/${encodeURIComponent(c.r.ext_id)}`, gone = x => { if (x.status !== 404 && x.status !== 410) throw x; };
    try {
      // /done: stays in the calendar as "✓ …" (the log of what you did); /later, /skip: the block goes away, the task is planned again
      if (c.kind === 'done') await api(acc, 'PATCH', path, { summary: doneTitle(c.e.summary), description: stripCmd(c.e.description).split('\n').map(l => ownLine(l) ? TAG : l).join('\n') }).catch(gone);
      else { await api(acc, 'DELETE', path).catch(gone); run('DELETE FROM events WHERE calendar_id = ? AND ext_id = ?', cal.id, c.r.ext_id); }
    } catch {}
  }
}

// ---------- write the plan into the plan calendar ----------
const TOL = 10 * 60000;
// a calendar shared by the members of a project shows whose block it is
const sharedCalendar = (cal, projectId) => { const p = get('SELECT meta FROM projects WHERE id = ?', projectId); return !!p && J(p.meta, {}).sharedCal === cal.ext_id; };
function eventBody(uid, b, unit, cal) {
  const t = unit.t, s = settingsOf(uid);
  const pts = partPoints(t.points, b.part, b.parts).map(p => '• ' + p.t).join('\n');
  const who = cal && sharedCalendar(cal, t.project_id) ? ` · ${(get('SELECT name FROM users WHERE id = ?', uid) || {}).name || ''}` : '';
  const title = `${tagged(uid, t)}${t.title.slice(0, 110)}${b.parts > 1 ? ` (${b.part}/${b.parts})` : ''}${who}`;
  const desc = [t.notes ? t.notes.slice(0, 1500) : '', pts, `${t.p_name}${unit.period != null ? ' · repeats' : ''}`,
    `${baseUrl()}/#/task/${t.id}`, `${TAG} Type /done, /later or /skip in the title or notes.`].filter(Boolean).join('\n\n');
  return { summary: title, description: desc, ...(t.location ? { location: t.location.slice(0, 300) } : {}), start: { dateTime: new Date(b.s).toISOString() }, end: { dateTime: new Date(b.e).toISOString() },
    transparency: s.plan.busy ? 'opaque' : 'transparent', reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { sc: '1', key: b.key } } };
}

// what of a block's content is written (not its time): a change is written even if the block stays where it is
const contentSig = b => createHash('sha1').update(JSON.stringify([b.summary, b.description, b.transparency])).digest('base64url').slice(0, 16);
export const pushPlan = (uid, getPlan) => withLock('cal:' + uid, () => pushPlanNow(uid, getPlan()));
// which calendar a block goes to: the project's own calendar (per user) or the main plan calendar
// which calendar a planned block goes to: the task's own calendar (e.g. one shared with your partner), the project's, or the main plan calendar.
// Blocks carry the app's marker (sc=1), so a calendar that also counts as busy never reads them back as busy time.
// A Vikunja account can have its own calendar (e.g. a team calendar): its tasks' blocks go there, titled "TAG - …".
export const extCfg = t => t?.ext_source === 'vikunja' && t.ext_account ? (J(get('SELECT state FROM accounts WHERE id = ?', t.ext_account)?.state, {}).cfg || {}) : {};
export const targetCalendar = (s, projectId, t) => (t?.meta?.calendarId && +t.meta.calendarId) || (+extCfg(t).calendarId || null) || (s.plan.projectCalendars || {})[projectId] || s.plan.calendarId || null;
// your tag in front of the title in an account's own calendar ("JD - Order nozzles"); done: "JD - ✓ Order nozzles"
const tagged = (uid, t) => { if (!+extCfg(t).calendarId) return ''; const tag = userTag(uid); return tag ? tag + ' - ' : ''; };
const doneTagged = title => { const m = String(title).match(/^([\p{L}\p{N}_-]{1,12} - )(.*)$/su); return m && !DONE_RE.test(m[2]) ? m[1] + doneTitle(m[2]) : doneTitle(title); };

async function pushPlanNow(uid, plan) {
  const s = settingsOf(uid);
  const now = Date.now(), endMs = dayStart(isoDate(now + (s.plan.days || 14) * 864e5));
  const byCal = new Map();
  for (const b of plan.blocks) {
    if (!(b.e > now && b.s < endMs && plan.units[b.key])) continue;
    const t = plan.units[b.key].t, c = targetCalendar(s, t.project_id, t); if (!c) continue;
    if (!byCal.has(c)) byCal.set(c, []); byCal.get(c).push(b);
  }
  // also visit calendars that still hold our blocks (project moved to another calendar → clean up there)
  all('SELECT DISTINCT calendar_id FROM plan_events WHERE user_id = ?', uid).forEach(r => { if (!byCal.has(r.calendar_id)) byCal.set(r.calendar_id, []); });
  if (!byCal.size) return null;
  const tot = { at: Date.now(), nc: 0, np: 0, nd: 0, err: '' };
  for (const [calId, desired] of byCal) {
    const cal = get('SELECT c.*, a.status AS a_status FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND c.user_id = ?', calId, uid);
    if (!cal || !cal.writable || cal.a_status !== 'ok') continue;
    if (!cal.is_plan) run('UPDATE calendars SET is_plan = 1 WHERE id = ?', cal.id);   // changes made there are detected too
    const st = await reconcile(uid, cal, desired, plan, now, endMs);
    tot.nc += st.nc; tot.np += st.np; tot.nd += st.nd; if (st.err) tot.err = st.err;
  }
  return tot;
}

async function reconcile(uid, cal, desired, plan, now, endMs) {
  const acc = get('SELECT * FROM accounts WHERE id = ?', cal.account_id);
  run('DELETE FROM plan_events WHERE calendar_id = ? AND kept = 1 AND end < ?', cal.id, now - 30 * 864e5);
  const existing = all('SELECT * FROM plan_events WHERE calendar_id = ? AND kept = 0 ORDER BY start', cal.id).filter(x => x.end > now - 7 * 864e5);
  const kept = all('SELECT * FROM plan_events WHERE calendar_id = ? AND kept = 1 AND end > ?', cal.id, now - 864e5);
  const act = get('SELECT task_id, period, since FROM active WHERE user_id = ?', uid);
  // what was worked in a block until now: the timer sessions in it
  const worked = (x, until) => { const w = get('SELECT MIN(start) s, MAX(end) e FROM work_log WHERE user_id = ? AND task_id = ? AND end > ? AND start < ?', uid, x.task_id, x.start, until); return w?.e ? w : null; };
  const used = new Set(), keep = [], create = [], patch = [];
  for (const d of desired) {
    const { taskId, period } = parseKey(d.key);
    const running = !!act && act.task_id === taskId && (act.period || 0) === period && d.s <= now;
    const mine = existing.filter(x => !used.has(x.id) && x.task_id === taskId && x.period === period);
    // the same block (close in time); the session that runs now: the block it began in, or the part logged before a short pause
    let m = mine.find(x => Math.abs(x.start - d.s) <= TOL && Math.abs(x.end - d.e) <= TOL)
      || (running && mine.find(x => x.start <= now && x.end > now - TOL && d.s <= x.end + TOL));
    if (!m && running) { m = kept.find(x => !used.has(x.id) && x.task_id === taskId && x.period === period && Math.abs(x.start - d.s) <= 60000); if (m) run('UPDATE plan_events SET kept = 0 WHERE id = ?', m.id); }
    // else one that is still to come, or one that began but was not worked on (it moves with the plan, nothing is logged)
    if (!m) { m = mine.find(x => x.start > now) || mine.find(x => x.start <= now && !worked(x, now)); if (m) { used.add(m.id); patch.push({ m, d }); } else create.push(d); continue; }
    used.add(m.id);
    // Google shows the block where Smart Calendar has it
    if (Math.abs(d.s - m.start) > 60000 || Math.abs(d.e - m.end) > 60000) { patch.push({ m, d }); continue; }
    // same time: rewrite only if the title, notes or busy/free changed (older rows without a fingerprint: by title)
    const body = eventBody(uid, d, plan.units[d.key], cal), sig = contentSig(body);
    if (m.sig ? m.sig !== sig : m.title !== body.summary) patch.push({ m, d: { ...d, s: m.start, e: m.end } });
    else { if (!m.sig) run('UPDATE plan_events SET sig = ? WHERE id = ?', sig, m.id); keep.push(m); }
  }
  const left = existing.filter(x => !used.has(x.id));
  let nc = 0, np = 0, nd = 0, err = '';
  try {
    for (const x of left) {
      const t = taskById(x.task_id);
      const done = t && (t.status === 'done' || (t.recur && get('SELECT 1 FROM occurrences WHERE task_id = ? AND period = ?', t.id, x.period)));
      const path = `/calendars/${encodeURIComponent(cal.ext_id)}/events/${encodeURIComponent(x.ext_id)}`;
      // a flexible appointment marked done stays in the calendar as a normal appointment (title, place, notes): where it
      // was planned if that had begun (cut at now), else ending now; the app's marker goes, so it shows as an appointment
      if (done && t.meta?.win && !t.recur) {
        const m = Math.ceil(now / 60000) * 60000, len = x.end - x.start;
        let s = x.start, e = x.end;
        if (x.start >= now) { e = m; s = m - len; } else if (x.end > now) e = Math.max(m, x.start + 5 * 60000);
        const body = { summary: t.title.slice(0, 300), location: t.location || '', description: t.notes ? t.notes.slice(0, 2000) : '', transparency: 'opaque',
          start: { dateTime: new Date(s).toISOString() }, end: { dateTime: new Date(e).toISOString() }, extendedProperties: { private: { sc: 'done', key: null } } };
        await api(acc, 'PATCH', path, body).catch(e => { if (e.status !== 404 && e.status !== 410) throw e; });
        run('DELETE FROM plan_events WHERE id = ?', x.id); np++;
        continue;
      }
      if (x.start < now) {
        // past or running: stays in the calendar only if it was worked on (a timer session in it) or the task was done
        // from it on: then as the log, "✓ …", cut to what was worked. One that just passed by, was moved or planned
        // again goes away (nothing is logged)
        const until = Math.min(x.end, now), w = worked(x, until);
        const doneHere = done && (t.recur || (t.done_at || 0) >= x.start - TOL);
        if (!w && !doneHere) {
          await api(acc, 'DELETE', path).catch(e => { if (e.status !== 404 && e.status !== 410) throw e; });
          run('DELETE FROM plan_events WHERE id = ?', x.id); nd++; continue;
        }
        const s = w ? Math.max(x.start, w.s) : x.start, e = w ? Math.min(x.end, w.e) : Math.min(x.end, Math.ceil(now / 60000) * 60000);
        const title = DONE_RE.test(x.title) || /^[\p{L}\p{N}_-]{1,12} - [✓✔]/u.test(x.title) ? x.title : doneTagged(x.title), body = {};
        if (title !== x.title) body.summary = title;
        if (Math.abs(s - x.start) > 30000) body.start = { dateTime: new Date(s).toISOString() };
        if (Math.abs(e - x.end) > 30000) body.end = { dateTime: new Date(e).toISOString() };
        if (Object.keys(body).length) { await api(acc, 'PATCH', path, body).catch(e => { if (e.status !== 404 && e.status !== 410) throw e; }); np++; }
        run('UPDATE plan_events SET kept = 1, start = ?, end = ?, title = ? WHERE id = ?', s, e, title, x.id);
      } else {
        await api(acc, 'DELETE', path).catch(e => { if (e.status !== 404 && e.status !== 410) throw e; });
        run('DELETE FROM plan_events WHERE id = ?', x.id); nd++;
      }
    }
    for (const { m, d } of patch) {
      const body = eventBody(uid, d, plan.units[d.key], cal);
      try { await api(acc, 'PATCH', `/calendars/${encodeURIComponent(cal.ext_id)}/events/${encodeURIComponent(m.ext_id)}`, body); }
      catch (e) { if (e.status !== 404 && e.status !== 410) throw e; run('DELETE FROM plan_events WHERE id = ?', m.id); create.push(d); continue; }
      run('UPDATE plan_events SET start = ?, end = ?, title = ?, sig = ? WHERE id = ?', d.s, d.e, body.summary, contentSig(body), m.id); np++;
    }
    for (const d of create) {
      const body = eventBody(uid, d, plan.units[d.key], cal), { taskId, period } = parseKey(d.key);
      const e = await api(acc, 'POST', `/calendars/${encodeURIComponent(cal.ext_id)}/events`, body);
      run('INSERT INTO plan_events(user_id, calendar_id, ext_id, task_id, period, start, end, title, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', uid, cal.id, e.id, taskId, period, d.s, d.e, body.summary, contentSig(body)); nc++;
    }
    // keep the event cache in line with what we just wrote (marks them as ours)
    if (nc || np || nd) await syncEvents(acc, { ...cal, is_plan: 0 }, dayStart(isoDate(now)) - 864e5, endMs);
  } catch (e) { err = e.message; }
  const st = { at: Date.now(), nc, np, nd, err };
  run('UPDATE accounts SET state = json_set(state, ?, json(?)) WHERE id = ?', '$.lastPush', JSON.stringify(st), acc.id);
  return st;
}


// log entries (work sessions, breaks, interruptions) and "Block time" appointments
export async function writeLog(uid) {
  const s = settingsOf(uid), id = s.plan.logCalendarId || s.plan.calendarId;
  if (!id) return;
  const cal = get('SELECT * FROM calendars WHERE id = ? AND user_id = ? AND writable = 1', id, uid); if (!cal) return;
  const acc = get(`SELECT * FROM accounts WHERE id = ? AND status = 'ok'`, cal.account_id); if (!acc) return;
  for (const x of all('SELECT * FROM outbox WHERE user_id = ? ORDER BY id LIMIT 20', uid)) {
    try {
      const block = /[#/]block\b/.test(x.descr);   // (older queued entries still say #block)
      await api(acc, 'POST', `/calendars/${encodeURIComponent(cal.ext_id)}/events`, { summary: x.title, description: x.descr,
        start: { dateTime: new Date(x.start).toISOString() }, end: { dateTime: new Date(x.end).toISOString() },
        transparency: block ? 'opaque' : 'transparent', reminders: { useDefault: false, overrides: [] },
        extendedProperties: { private: block ? { scAppt: '1' } : { sc: '1' } } });
      run('DELETE FROM outbox WHERE id = ?', x.id);
    } catch (e) { run('UPDATE outbox SET tries = tries + 1, error = ? WHERE id = ?', e.message, x.id); break; }
  }
}
export { api as googleApi };

// ---------- edit your own calendar from the app ----------
const gTime = (ms, allDay) => allDay ? { date: isoDate(ms) } : { dateTime: new Date(ms).toISOString() };
// copies of one appointment in other calendars ("Also in …"): all carry the same key, so Smart Calendar shows the
// appointment once (the original, in its own calendar's color; dots for the others) and never takes the copies for a clash.
// title: an own name for the copies, e.g. "JD - Uni Weihnachtsmarkt" so the people of the other calendar know what it is
export async function copyEvent(uid, ev, calIds, title = '') {
  const dup = ev.dup || `${ev.calendar_id}:${ev.ext_id}`;
  if (!ev.dup) {
    try { const { cal, acc } = writableCal(uid, ev.calendar_id); await api(acc, 'PATCH', evPath(cal, ev.ext_id), { extendedProperties: { shared: { scdup: dup } } }); } catch {}
    run('UPDATE events SET dup = ? WHERE calendar_id = ? AND ext_id = ?', dup, ev.calendar_id, ev.ext_id);
  }
  let n = 0;
  for (const id of calIds) {
    if (id === ev.calendar_id || get('SELECT 1 FROM events WHERE calendar_id = ? AND dup = ? AND start = ?', id, dup, ev.start)) continue;
    await createEvent(uid, id, { title: title || ev.title, start: ev.start, end: ev.end, all_day: !!ev.all_day, location: ev.location, descr: ev.descr, dup }); n++;
  }
  return n;
}
const evPath = (cal, id) => `/calendars/${encodeURIComponent(cal.ext_id)}/events/${encodeURIComponent(id)}`;
function writableCal(uid, calId) {
  const cal = get(`SELECT c.*, a.status AS a_status FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND c.user_id = ? AND a.kind = 'google'`, calId, uid);
  if (!cal || !cal.writable) throw Object.assign(new Error('This calendar cannot be changed from here'), { statusCode: 400 });
  return { cal, acc: get('SELECT * FROM accounts WHERE id = ?', cal.account_id) };
}
async function refresh(acc, cal, from, to) {
  const t0 = dayStart(isoDate(Date.now())) - 864e5;
  await withLock('cal:' + acc.user_id, () => syncEvents(acc, cal, Math.max(t0, Math.min(from, to) - 864e5), Math.max(from, to) + 2 * 864e5));
}
// scope 'all' on a repeating event changes the whole series: title, and the same time shift for every occurrence
export async function updateEvent(uid, ev, ch, scope = 'one') {
  const { cal, acc } = writableCal(uid, ev.calendar_id);
  const series = scope === 'all' && ev.series && ev.series !== ev.ext_id;
  const id = series ? ev.series : ev.ext_id, body = {};
  if (ch.title != null) body.summary = String(ch.title).slice(0, 300);
  if (ch.location != null) body.location = String(ch.location).slice(0, 500);
  if (ch.start != null && ch.end != null) {
    const allDay = ch.all_day ?? !!ev.all_day;
    if (series) {
      const m = await api(acc, 'GET', evPath(cal, id)), ds = ch.start - ev.start, de = ch.end - ev.end;
      const ms = evTime(m.start), me = evTime(m.end || m.start);
      body.start = { ...gTime(ms + ds, allDay), ...(m.start.timeZone ? { timeZone: m.start.timeZone } : {}) };
      body.end = { ...gTime(me + de, allDay), ...(m.end?.timeZone ? { timeZone: m.end.timeZone } : {}) };
    } else { body.start = gTime(ch.start, allDay); body.end = gTime(allDay ? Math.max(ch.end, ch.start + 864e5) : ch.end, allDay); }
  }
  let target = cal;
  if (Object.keys(body).length) await api(acc, 'PATCH', evPath(cal, id), body, { sendUpdates: 'none' });
  if (ch.calendar_id && +ch.calendar_id !== cal.id) {        // move to another calendar of the same Google account
    const to = writableCal(uid, +ch.calendar_id);
    if (to.acc.id !== acc.id) throw Object.assign(new Error('Events can only move within the same Google account'), { statusCode: 400 });
    await api(acc, 'POST', evPath(cal, id) + '/move', null, { destination: to.cal.ext_id, sendUpdates: 'none' });
    target = to.cal; await refresh(acc, cal, ev.start, ev.end);
  }
  await refresh(acc, target, Math.min(ev.start, ch.start ?? ev.start), Math.max(ev.end, ch.end ?? ev.end) + (series ? 70 * 864e5 : 0));
}
export async function deleteEvent(uid, ev, scope = 'one') {
  const { cal, acc } = writableCal(uid, ev.calendar_id);
  const id = scope === 'all' && ev.series && ev.series !== ev.ext_id ? ev.series : ev.ext_id;
  await api(acc, 'DELETE', evPath(cal, id), null, { sendUpdates: 'none' }).catch(e => { if (e.status !== 404 && e.status !== 410) throw e; });
  if (id === ev.series) run('DELETE FROM events WHERE calendar_id = ? AND series = ?', cal.id, ev.series); else run('DELETE FROM events WHERE id = ?', ev.id);
}
export async function createEvent(uid, calId, { title, start, end, all_day, location, descr, dup }) {
  const { cal, acc } = writableCal(uid, calId);
  const e = await api(acc, 'POST', `/calendars/${encodeURIComponent(cal.ext_id)}/events`, { summary: String(title || 'New Event').slice(0, 300), start: gTime(start, all_day), end: gTime(all_day ? Math.max(end, start + 864e5) : end, all_day),
    ...(location ? { location: String(location).slice(0, 500) } : {}), ...(descr ? { description: String(descr).slice(0, 4000) } : {}), ...(dup ? { extendedProperties: { shared: { scdup: dup } } } : {}) });
  await refresh(acc, cal, start, end);
  return e.id;
}
