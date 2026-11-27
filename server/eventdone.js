// Start and Done for an appointment, from the web app and the menu bar: it ended now, as planned, or at a time you give.
// The real end goes into the calendar when it can be edited (Google); a read-only calendar (Exchange, ICS) keeps its time,
// and Smart Calendar uses the real end itself (calendarEvents). Either way the plan is worked out again from there.
import { get, run, all } from './db.js';
import { httpErr } from './auth.js';
import { markDirty, openEnd } from './planner.js';
import { syslog } from './logs.js';
import * as A from './actions.js';
import * as google from './sync/google.js';

export async function finishEvent(uid, e, endIn) {
  const tr = get('SELECT orig_end FROM event_track WHERE user_id = ? AND calendar_id = ? AND ext_id = ?', uid, e.calendar_id, e.ext_id);
  const now = Date.now(), end = endIn === 'planned' ? (tr?.orig_end || e.end) : endIn == null ? now : +endIn;
  if (!(end > e.start) || (endIn !== 'planned' && end > now + 60000)) throw httpErr(400, 'Invalid end');
  const editable = !!get(`SELECT 1 AS x FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND c.writable = 1 AND a.kind = 'google'`, e.calendar_id);
  let moved = false;
  // time you blocked with Smart Calendar is logged like a task: "✓ …"
  const title = editable && /(^|\s)\/block\b/.test(e.descr || '') && !google.DONE_RE.test(e.title) ? google.doneTitle(e.title) : null;
  if ((end !== e.end && !e.all_day || title) && editable) {
    try { await google.updateEvent(uid, e, { start: e.start, end: e.all_day ? e.end : end, title, calendar_id: null, all_day: null }, 'one'); moved = end !== e.end; }
    catch (x) { throw httpErr(x.statusCode || 502, x.message); }
  }
  A.eventDone(uid, e, now, e.all_day || end === e.end ? null : end);
  markDirty(uid, true);
  return { ok: true, moved, end };
}

// Start: the first start moves the appointment to now (earlier or later than planned) and keeps its length;
// a resume after a pause changes nothing. Read-only calendars keep their time, Smart Calendar uses the real start.
export async function startEvent(uid, e) {
  const now = Math.floor(Date.now() / 60000) * 60000;
  const t = get('SELECT since, spent, done_at FROM event_track WHERE user_id = ? AND calendar_id = ? AND ext_id = ?', uid, e.calendar_id, e.ext_id);
  const first = !t || (!t.since && !t.spent && !t.done_at);
  const move = first && !e.all_day && Math.abs(now - e.start) >= 60000, end = now + (e.end - e.start);
  A.startEvent(uid, e);
  if (!move) return { ok: true, moved: false };
  const editable = !!get(`SELECT 1 AS x FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND c.writable = 1 AND a.kind = 'google'`, e.calendar_id);
  let moved = false;
  if (editable) {
    try { await google.updateEvent(uid, e, { start: now, end, title: null, calendar_id: null, all_day: null }, 'one'); moved = true; }
    catch { /* the calendar keeps its time; the plan uses the real start below */ }
  }
  run('UPDATE event_track SET began = ? WHERE user_id = ? AND calendar_id = ? AND ext_id = ?', moved ? null : now, uid, e.calendar_id, e.ext_id);
  markDirty(uid, true);
  return { ok: true, moved, start: now, end };
}

// Google shows a tracked appointment as Smart Calendar does: running into its end, 30 min more each time, until Done;
// paused after its planned end, it ends there (or now). Every minute, and right after Pause.
export async function trackedEnds(only = null, now = Date.now()) {
  const rows = all(`SELECT k.user_id, k.since, k.orig_end, e.id, e.calendar_id, e.ext_id, e.series, e.start, e.end, e.all_day FROM event_track k
    JOIN events e ON e.calendar_id = k.calendar_id AND e.ext_id = k.ext_id JOIN calendars c ON c.id = k.calendar_id JOIN accounts a ON a.id = c.account_id
    WHERE k.done_at IS NULL AND (k.since IS NOT NULL OR k.orig_end IS NOT NULL) AND e.all_day = 0 AND e.start <= ? AND c.writable = 1 AND a.kind = 'google' AND a.status = 'ok'`, now);
  for (const r of rows) {
    if (only && r.user_id !== only) continue;
    const m = Math.ceil(now / 60000) * 60000, back = Math.max(r.orig_end || 0, m);
    const end = r.since ? (r.end <= now + 60000 ? openEnd(r.end, now + 60000) : null) : r.end > back + 60000 ? back : null;
    if (!end) continue;
    try {
      await google.updateEvent(r.user_id, r, { start: r.start, end, title: null, calendar_id: null, all_day: null }, 'one');
      if (!r.orig_end) run('UPDATE event_track SET orig_end = ? WHERE user_id = ? AND calendar_id = ? AND ext_id = ?', r.end, r.user_id, r.calendar_id, r.ext_id);
      markDirty(r.user_id, true);
    } catch (x) { syslog('warn', 'sync', `appointment end not written to Google: ${x.message}`, r.user_id); }
  }
}
