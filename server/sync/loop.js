// Background sync: runs all the time inside the container, also when no browser is open.
//   Google calendars: pushed: Google tells the server about every change, which is read, planned and shown at once;
//     polling stays as a fallback (with push: current week every 5 min, the next ~2 months hourly; without: every minute / 15 min)
//   ICS (Exchange) feeds: every 2 min (conditional GET)
//   Vikunja: pushed by webhooks (fallback every 15 min); without them every minute
// After every change the affected users are re-planned and the plan is written to Google.
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { all, get, run, J } from '../db.js';
import { isoDate, dayStart, addDays, monday } from '../time.js';
import * as google from './google.js';
import { syncIcs } from './ics.js';
import { syncVikunja, pushDone, hookValid, moveToBucket } from './vikunja.js';
import { markDirty, onPlanned, getPlan, planAll, planDue } from '../planner.js';
import { withLock } from '../lock.js';
import { notifyUsers } from '../bus.js';
import { notifyTick, notify } from '../notify.js';
import { clashTick, checkClashes } from '../conflicts.js';
import { trackedEnds } from '../eventdone.js';
import { archiveTick } from '../actions.js';
import { onTaskDone, onTaskStart, settleAllPaused } from '../actions.js';
import { membersOf, settingsOf } from '../models.js';
import { syslog } from '../logs.js';
import { travelTick } from '../travel.js';
import { mirrorCalendar, removeDuplicates } from './mirror.js';

const lastRun = new Map();       // `${kind}:${id}` -> ms
const due = (k, sec) => { const l = lastRun.get(k) || 0; if (Date.now() - l < sec * 1000) return false; lastRun.set(k, Date.now()); return true; };
const setErr = (acc, e) => {
  run('UPDATE accounts SET status = ?, error = ? WHERE id = ?', e ? (e.auth ? 'auth' : 'error') : 'ok', e ? String(e.message || e).slice(0, 500) : null, acc.id);
  if (e && acc.status === 'ok') notify(acc.user_id, 'sync', { title: `${acc.label} is not syncing`, body: String(e.message || e).slice(0, 200), tag: 'sync-' + acc.id, url: '/#/settings' }).catch(() => {});
  if (e && (acc.status === 'ok' || acc.error !== String(e.message || e).slice(0, 500))) syslog(e.auth ? 'error' : 'warn', 'sync', `${acc.kind} “${acc.label}”: ${e.message}`, acc.user_id);
  if (!e && acc.status !== 'ok') syslog('info', 'sync', `${acc.kind} “${acc.label}” works again`, acc.user_id);
};
export const syncState = () => ({ lastRun: Object.fromEntries(lastRun) });

// the two ranges read: through the end of this week (+ next week on Sundays), and the ~2 months after
function ranges() {
  const today = isoDate(Date.now());
  const nearTo = dayStart(addDays(monday(today), 7 + (new Date().getDay() === 0 ? 7 : 0))) + 864e5;
  return [[dayStart(today) - 864e5, nearTo], [nearTo, dayStart(addDays(today, config.sync.farDays + 1))]];
}
const SYNCED = '(use_busy = 1 OR is_plan = 1 OR writable = 1 OR mirror_to IS NOT NULL)';   // your own calendars are shown (and editable) too
const pushed = c => J(c.watch, null)?.exp > Date.now();
const watchWarned = new Set();

async function syncGoogle(acc, force) {
  const [[nearFrom, nearTo], [, farTo]] = ranges();
  let changed = false;
  await withLock('cal:' + acc.user_id, async () => {
    if (force || due(`gl:${acc.id}`, 6 * 3600)) await google.syncCalendarList(acc);
    for (let c of all(`SELECT * FROM calendars WHERE account_id = ? AND ${SYNCED}`, acc.id)) {
      if (google.pushUrl() && due(`gw:${c.id}`, 3600)) {
        try { const w = await google.watchCalendar(acc, c); c = { ...c, watch: JSON.stringify(w) }; }
        catch (e) { if (!watchWarned.has(c.id)) { watchWarned.add(c.id); syslog('warn', 'sync', `push for “${c.name}” not available, checking every minute: ${e.message}`, acc.user_id); } }
      }
      // syncEvents writes only what differs and says how many events changed (time, title, place, notes, …)
      const p = pushed(c);
      if (force || due(`gn:${c.id}`, p ? 300 : config.sync.nearSec - 2)) changed = (await google.syncEvents(acc, c, nearFrom, nearTo)) > 0 || changed;
      if (force || due(`gf:${c.id}`, p ? 3600 : config.sync.farSec)) changed = (await google.syncEvents(acc, c, nearTo, farTo)) > 0 || changed;
    }
  });
  await google.writeLog(acc.user_id);
  return changed;
}

export async function syncAccount(acc, force = false) {
  return withLock('acc:' + acc.id, async () => {
    try {
      let changed = false;
      if (acc.kind === 'google') { if (!google.enabled()) return; changed = await syncGoogle(acc, force); }
      else if (acc.kind === 'ics') { if (!force && !due(`ics:${acc.id}`, config.sync.icsSec)) return; const r = await syncIcs(acc, config.sync.farDays); changed = !r.unchanged; }
      else if (acc.kind === 'vikunja') { if (!force && !due(`vk:${acc.id}`, J(acc.state, {}).hooks?.ok ? 900 : config.sync.vikunjaSec)) return; await syncVikunja(acc); }
      run('UPDATE accounts SET last_sync = ? WHERE id = ?', Date.now(), acc.id);
      if (acc.status !== 'ok') setErr(acc, null);
      await afterSync(acc, changed, force);
      if (acc.kind === 'google' && due(`mirdup:${acc.user_id}`, 3600)) await removeDuplicates(acc.user_id).catch(() => {});
    } catch (e) { setErr(acc, e); notifyUsers([acc.user_id], 'sync'); }
  });
}

// something changed: plan anew right away, show it, check clashes; filtered copies follow
async function afterSync(acc, changed, force) {
  if (changed) { markDirty(acc.user_id, true); notifyUsers([acc.user_id], 'sync'); await checkClashes(acc.user_id).catch(e => syslog('warn', 'clash', e.message, acc.user_id)); }
  for (const c of all('SELECT id FROM calendars WHERE account_id = ? AND mirror_to IS NOT NULL', acc.id))
    if (changed || force || due(`mir:${c.id}`, 900)) await mirrorCalendar(c.id).catch(e => syslog('warn', 'sync', `filtered copy: ${e.message}`, acc.user_id));
}

// Google says a calendar changed (POST /api/google/push): read it a moment later (changes come in bursts)
const pushWait = new Map();
export function googlePushed(channelId, token, state) {
  const c = get(`SELECT * FROM calendars WHERE json_extract(watch, '$.id') = ? AND ${SYNCED}`, String(channelId || ''));
  const want = Buffer.from(String(J(c?.watch, {}).token || '')), got = Buffer.from(String(token || ''));
  if (!c || !want.length || want.length !== got.length || !timingSafeEqual(want, got)) return false;
  if (state === 'sync') return true;                    // the first message of a new channel: nothing changed
  clearTimeout(pushWait.get(c.id));
  pushWait.set(c.id, setTimeout(() => { pushWait.delete(c.id); syncPushed(c.id).catch(e => syslog('warn', 'sync', `push: ${e.message}`, c.user_id)); }, 1500));
  return true;
}
async function syncPushed(calId) {
  const c = get('SELECT * FROM calendars WHERE id = ?', calId), acc = c && get(`SELECT * FROM accounts WHERE id = ? AND status != 'auth'`, c.account_id);
  if (!acc || !google.enabled()) return;
  await withLock('acc:' + acc.id, async () => {
    let n = 0;
    await withLock('cal:' + acc.user_id, async () => { for (const [a, b] of ranges()) n += await google.syncEvents(acc, c, a, b); });
    lastRun.set(`gn:${c.id}`, Date.now());
    await afterSync(acc, n > 0, false);
  });
}

// Vikunja webhook (POST /api/vikunja/push/:account): checked, then the account is read a moment later
export function vikunjaPushed(accId, raw, sig) {
  const acc = get(`SELECT * FROM accounts WHERE id = ? AND kind = 'vikunja'`, +accId);
  if (!acc || !hookValid(acc, raw, sig)) return false;
  clearTimeout(pushWait.get('vk' + acc.id));
  pushWait.set('vk' + acc.id, setTimeout(() => { pushWait.delete('vk' + acc.id); const a = get('SELECT * FROM accounts WHERE id = ?', acc.id); if (a) syncAccount(a, true); }, 1500));
  return true;
}

let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    const accs = all(`SELECT * FROM accounts WHERE status != 'auth'`);
    await Promise.all(accs.map(a => syncAccount(a)));
    // the plan follows the clock: re-planned when time reaches a point where it can change (a block starts, …)
    planDue();
    settleAllPaused();   // paused longer than 10 min: the session before stays on its own
    await trackedEnds().catch(e => console.warn('tracked', e.message));   // a tracked appointment's longer end, also in Google
    if (due('notify', 55)) await notifyTick().catch(e => console.warn('notify', e.message));
    if (due('clash', 55)) await clashTick().catch(e => console.warn('clash', e.message));
    if (due('archive', 3600)) { try { archiveTick(); } catch (e) { console.warn('archive', e.message); } }   // done tasks into the archive (project setting)
    if (due('travel', 600)) travelTick().catch(e => console.warn('travel', e.message));   // new places of the next two weeks: their way from home
  } finally { ticking = false; }
}

// write the plan to Google right after a re-plan (a second to gather quick changes); a change during a write
// is written right after it, so the last change always gets out
const pushTimers = new Map(), pushing = new Set(), again = new Set();
function schedulePush(uid) {
  if (!google.enabled()) return;   // blocks may go to project calendars or an appointment's own calendar, not only the main one
  if (pushing.has(uid)) { again.add(uid); return; }
  clearTimeout(pushTimers.get(uid));
  pushTimers.set(uid, setTimeout(async () => {
    pushTimers.delete(uid); pushing.add(uid);
    try { const st = await google.pushPlan(uid, () => getPlan(uid)); if (st && (st.nc || st.np || st.nd)) notifyUsers([uid], 'sync'); if (st?.err) syslog('warn', 'plan', 'writing plan to Google: ' + st.err, uid); }
    catch (e) { syslog('error', 'plan', e.message, uid); }
    finally { pushing.delete(uid); if (again.delete(uid)) schedulePush(uid); }
  }, 1000));
}

export function startSync() {
  onPlanned(uids => uids.forEach(schedulePush));
  // Start on a Vikunja task: it moves to "In Progress" on its Kanban (Pause leaves it there)
  onTaskStart((task, uid) => { if (task?.ext_source === 'vikunja') moveToBucket(task, 'progress').catch(e => syslog('warn', 'vikunja', 'In Progress: ' + e.message, uid)); });
  onTaskDone(async (task, done, uid) => {
    if (task?.ext_source === 'vikunja') pushDone(task, done).then(() => done && moveToBucket(task, 'done')).catch(e => syslog('warn', 'vikunja', 'write-back failed: ' + e.message, uid));
    // tell the other members of a shared project
    if (task && done) for (const m of membersOf(task.project_id)) {
      if (m.id === uid) continue;
      const who = get('SELECT name FROM users WHERE id = ?', uid)?.name || 'Someone';
      notify(m.id, 'partner', { title: task.title, body: `Completed by ${who}`, tag: 'partner-' + task.id, url: `/#/project/${task.project_id}` }).catch(() => {});
    }
  });
  planAll();
  setInterval(tick, 15000);
  setTimeout(tick, 1500);
}
