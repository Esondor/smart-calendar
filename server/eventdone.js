// Start and Done for an appointment, from the web app and the menu bar: it ended now, as planned, or at a time you give.
// The real end goes into the calendar when it can be edited (Google); a read-only calendar (Exchange, ICS) keeps its time,
// and Smart Calendar uses the real end itself (calendarEvents). Either way the plan is worked out again from there.
import { get, run } from './db.js';
import { httpErr } from './auth.js';
import { markDirty } from './planner.js';
import * as A from './actions.js';
import * as google from './sync/google.js';

export async function finishEvent(uid, e, endIn) {
  const now = Date.now(), end = endIn === 'planned' ? e.end : endIn == null ? now : +endIn;
  if (!(end > e.start) || (endIn !== 'planned' && end > now + 60000)) throw httpErr(400, 'Invalid end');
  const editable = !!get(`SELECT 1 AS x FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND c.writable = 1 AND a.kind = 'google'`, e.calendar_id);
  let moved = false;
  if (end !== e.end && !e.all_day && editable) {
    try { await google.updateEvent(uid, e, { start: e.start, end, title: null, calendar_id: null, all_day: null }, 'one'); moved = true; }
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
