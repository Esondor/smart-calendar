// Business actions shared by the HTTP API, the calendar sync and the Vikunja sync.
import { all, get, run, tx, J } from './db.js';
import { taskById, settingsOf, logActivity, membersOf } from './models.js';
import { markDirty, usersOfProject, keyOf, assigneeOf } from './planner.js';
import { notifyUsers } from './bus.js';
import { isoDate, dayStart, dayEnd } from './time.js';

const label = t => t.title.slice(0, 110);
const name = uid => (get('SELECT name FROM users WHERE id = ?', uid) || {}).name || 'Someone';
let hooks = { onDone: [], onStart: [] };
export const onTaskDone = fn => hooks.onDone.push(fn);   // (task, done, uid): Vikunja write-back, push notifications
export const onTaskStart = fn => hooks.onStart.push(fn); // (task, uid): Vikunja In Progress

function touchProject(pid) { const us = usersOfProject(pid); markDirty(us); notifyUsers(us, 'tasks'); }

// mark a task (or one instance of a recurring task) done / open again
export function setDone(uid, taskId, period, done, via = 'app') {
  const t = taskById(taskId); if (!t) return null;
  const p = t.recur ? (period ?? 0) : 0;
  const act = get('SELECT * FROM active WHERE user_id = ?', uid);
  if (done && act && act.task_id === taskId && act.period === p) stopTimer(uid, { done: true });
  tx(() => {
    if (t.recur) {
      if (done) run(`INSERT INTO occurrences(task_id, period, status, at, by) VALUES (?, ?, 'done', ?, ?) ON CONFLICT(task_id, period) DO UPDATE SET status = 'done', at = excluded.at, by = excluded.by`, taskId, p, Date.now(), uid);
      else run('DELETE FROM occurrences WHERE task_id = ? AND period = ?', taskId, p);
    } else {
      const cols = J(get('SELECT columns FROM projects WHERE id = ?', t.project_id).columns, []);
      if (done) run(`UPDATE tasks SET status = 'done', col = ?, done_at = ?, done_by = ?, do_next = NULL, updated_at = ? WHERE id = ?`, Math.max(0, cols.length - 1), Date.now(), uid, Date.now(), taskId);
      else run(`UPDATE tasks SET status = 'todo', col = CASE WHEN col >= ? THEN 0 ELSE col END, done_at = NULL, done_by = NULL, updated_at = ? WHERE id = ?`, Math.max(1, cols.length - 1), Date.now(), taskId);
      // ticking a leaf ticks its checklist; finishing all children of a parent closes the parent
      if (done) { const pts = t.points.map(x => ({ ...x, done: true })); run('UPDATE tasks SET points = ? WHERE id = ?', JSON.stringify(pts), taskId); }
      for (let pid = t.parent_id; pid; pid = get('SELECT parent_id FROM tasks WHERE id = ?', pid)?.parent_id) {
        const open = get(`SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND status != 'done'`, pid).n;
        run(`UPDATE tasks SET status = ?, done_at = ? WHERE id = ?`, open ? 'todo' : 'done', open ? null : Date.now(), pid);
      }
    }
  });
  logActivity(t.project_id, uid, `${done ? 'Completed' : 'Reopened'} ${label(t)}${via !== 'app' ? ` (${via})` : ''}`);
  if (done) createFollowups(uid, t);
  else run(`DELETE FROM tasks WHERE source_task = ? AND status != 'done' AND spent = 0 AND created_at > ?`, taskId, Date.now() - 15 * 60000);   // undo: drop the follow-ups it just created
  hooks.onDone.forEach(fn => { try { fn(taskById(taskId), done, uid, p); } catch (e) { console.error(e); } });
  touchProject(t.project_id);
  return taskById(taskId);
}

// ---------- timer ----------
// from: started late, from the planned time (since) and running to until, 30 min more each time, until Done
export function startTimer(uid, taskId, period = 0, mode = null, note = null, from = null) {
  const a = get('SELECT * FROM active WHERE user_id = ?', uid);
  if (!from && a && a.task_id === taskId && a.period === period && (a.mode || null) === mode) return;
  stopTimer(uid); pauseEvent(uid);
  run('INSERT INTO active(user_id, task_id, period, since, mode, note, until) VALUES (?, ?, ?, ?, ?, ?, ?)', uid, taskId, period, from ? from.since : Date.now(), mode, note, from ? from.until : null);
  const t = taskById(taskId);
  if (t && !t.recur && t.status === 'todo') { run(`UPDATE tasks SET status = 'doing', col = CASE WHEN col = 0 THEN 1 ELSE col END WHERE id = ?`, taskId); touchProject(t.project_id); }
  hooks.onStart.forEach(fn => { try { fn(t, uid); } catch (e) { console.error(e); } });
  markDirty(uid); notifyUsers([uid], 'timer');
}
export function stopTimer(uid, { done = false, end = Date.now() } = {}) {
  const a = get('SELECT * FROM active WHERE user_id = ?', uid); if (!a) return 0;
  run('DELETE FROM active WHERE user_id = ?', uid);
  const m = Math.max(0, (end - a.since) / 60000), t = taskById(a.task_id);
  if (m >= 1 && t) {
    run('INSERT INTO work_log(user_id, task_id, period, kind, start, end, note, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', uid, a.task_id, a.period, a.mode === 'r' ? 'research' : 'work', a.since, end, a.note, done ? 1 : 0);
    if (!t.recur) run('UPDATE tasks SET spent = spent + ? WHERE id = ?', m, a.task_id);
    const r = a.mode === 'r';
    // a block in the calendar that already shows this session (it is kept, cut to the real end): no second entry
    const shown = !r && get('SELECT 1 FROM plan_events WHERE user_id = ? AND task_id = ? AND start <= ? AND end >= ?', uid, a.task_id, a.since + 60000, Math.min(end, Date.now()) - 60000);
    if (!shown) logToCalendar(uid, (r ? 'Research' + (a.note ? ': ' + a.note : '') + ' · ' : done ? '✓ ' : '') + label(t), a.since, end, r ? 'research' : 'session');
  }
  markDirty(uid); notifyUsers([uid], 'timer');
  return m;
}
// research already done: counts as work on the task (moves minutes out of a running writing session)
export function logResearch(uid, taskId, period, minutes, note) {
  const now = Date.now(), a = get('SELECT * FROM active WHERE user_id = ?', uid);
  if (a && a.task_id === taskId && a.period === period && a.mode !== 'r') {
    const cut = Math.min(minutes, (now - a.since) / 60000), endW = now - cut * 60000;
    stopTimer(uid, { end: endW });
    run('INSERT INTO active(user_id, task_id, period, since, mode, note) VALUES (?, ?, ?, ?, NULL, NULL)', uid, taskId, period, now);
  }
  const t = taskById(taskId);
  run(`INSERT INTO work_log(user_id, task_id, period, kind, start, end, note) VALUES (?, ?, ?, 'research', ?, ?, ?)`, uid, taskId, period, now - minutes * 60000, now, note);
  if (!t.recur) run('UPDATE tasks SET spent = spent + ? WHERE id = ?', minutes, taskId);
  logToCalendar(uid, 'Research' + (note ? ': ' + note : '') + ' · ' + label(t), now - minutes * 60000, now, 'research');
  markDirty(uid); notifyUsers([uid], 'timer');
}
export function addMinutes(uid, taskId, extra) {
  const t = taskById(taskId); if (!t) return;
  const a = get('SELECT since FROM active WHERE user_id = ? AND task_id = ?', uid, taskId);
  const used = t.spent + (a ? (Date.now() - a.since) / 60000 : 0);
  run('UPDATE tasks SET duration = ?, updated_at = ? WHERE id = ?', Math.max(t.duration, Math.ceil(used / 15) * 15) + extra, Date.now(), taskId);
  touchProject(t.project_id);
}

// ---------- busy time from the "Now" buttons ----------
export function logToCalendar(uid, title, start, end, kind) {
  const s = settingsOf(uid);
  if (!s.plan.logOn || end - start < 60000) return;
  run('INSERT INTO outbox(user_id, title, start, end, descr) VALUES (?, ?, ?, ?, ?)', uid, title, start, end, `[smart-calendar:log] ${kind}`);
}
export function addAppt(uid, start, end, title, kind = 'appt') {
  const id = Number(run('INSERT INTO appts(user_id, start, end, title, kind) VALUES (?, ?, ?, ?, ?)', uid, start, end, title, kind).lastInsertRowid);
  if (kind === 'appt') { const s = settingsOf(uid); if (s.plan.calendarId || s.plan.logCalendarId) run('INSERT INTO outbox(user_id, title, start, end, descr) VALUES (?, ?, ?, ?, ?)', uid, title, start, end, 'Blocked via Smart Calendar\n/block'); }
  markDirty(uid);
  return id;
}
export function breakNow(uid, minutes, title) {
  const now = Date.now(); stopTimer(uid);
  addAppt(uid, now, now + minutes * 60000, title, 'break');
  logToCalendar(uid, title, now, now + minutes * 60000, 'break');
  if (/lunch/i.test(title)) {   // an early lunch replaces today's fixed lunch block
    const s = settingsOf(uid), wd = new Date(now).getDay();
    (s.fixed || []).filter(f => /lunch/i.test(f.t) && f.days.includes(wd)).forEach(f => run(`INSERT INTO appts(user_id, start, end, title, kind) VALUES (?, ?, ?, ?, 'skipfixed')`, uid, dayStart(isoDate(now)), dayEnd(isoDate(now)), `${f.id}:${isoDate(now)}`));
  }
  markDirty(uid);
}
export function interrupted(uid, minutes, title) {
  const now = Date.now(), a = get('SELECT * FROM active WHERE user_id = ?', uid);
  if (a) { const cut = Math.min(minutes, (now - a.since) / 60000); run('UPDATE active SET since = since + ? WHERE user_id = ?', cut * 60000, uid); }
  addAppt(uid, now - minutes * 60000, now, title || 'Interruption', 'intr');
  logToCalendar(uid, 'Interruption' + (title ? ': ' + title : ''), now - minutes * 60000, now, 'interruption');
}

// ---------- reactions to edits made in Google / Apple Calendar ----------
export function applyCalendarChange(uid, { r, kind, s, e }) {
  const t = taskById(r.task_id);
  if (!t) { run('DELETE FROM plan_events WHERE id = ?', r.id); return; }
  if (kind === 'done') {
    run('DELETE FROM plan_events WHERE id = ?', r.id);
    setDone(uid, t.id, r.period, true, 'calendar');
  } else if (kind === 'skip' && t.recur) {
    run('DELETE FROM plan_events WHERE id = ?', r.id);
    skipOccurrence(uid, t.id, r.period);
  } else if (kind === 'deleted' || kind === 'later' || kind === 'skip') {
    run('DELETE FROM plan_events WHERE id = ?', r.id);
    run(`DELETE FROM overrides WHERE task_id = ? AND period = ? AND kind = 'pin' AND ABS(start - ?) < 60000`, t.id, r.period, r.start);
    run(`INSERT INTO overrides(user_id, task_id, period, kind, start, end, created_at) VALUES (?, ?, ?, 'defer', ?, ?, ?)`, uid, t.id, r.period, r.start, Math.max(r.end, Date.now()), Date.now());
    logActivity(t.project_id, uid, `Postponed ${label(t)} (calendar)`);
  } else if (kind === 'moved') {
    run(`DELETE FROM overrides WHERE task_id = ? AND period = ? AND kind = 'pin' AND ABS(start - ?) < 60000`, t.id, r.period, r.start);
    run(`INSERT INTO overrides(user_id, task_id, period, kind, start, end, created_at) VALUES (?, ?, ?, 'pin', ?, ?, ?)`, uid, t.id, r.period, s, e, Date.now());
    run('UPDATE plan_events SET start = ?, end = ? WHERE id = ?', s, e, r.id);
  }
  touchProject(t.project_id);
}

// move a planned block in the web app (drag in the calendar) = same as moving it in Google
export function pinBlock(uid, taskId, period, oldStart, s, e) {
  run(`DELETE FROM overrides WHERE user_id = ? AND task_id = ? AND period = ? AND kind = 'pin' AND (ABS(start - ?) < 60000 OR ? = 0)`, uid, taskId, period, oldStart || 0, oldStart ? 1 : 0);
  if (s != null) run(`INSERT INTO overrides(user_id, task_id, period, kind, start, end, created_at) VALUES (?, ?, ?, 'pin', ?, ?, ?)`, uid, taskId, period, s, e, Date.now());
  if (s != null) run('UPDATE plan_events SET start = ?, end = ? WHERE user_id = ? AND task_id = ? AND period = ? AND ABS(start - ?) < 60000', s, e, uid, taskId, period, oldStart || 0);
  markDirty(uid);
}
export function postpone(uid, taskId, period, until) {
  run(`DELETE FROM overrides WHERE user_id = ? AND task_id = ? AND period = ? AND kind = 'pin'`, uid, taskId, period);
  run(`INSERT INTO overrides(user_id, task_id, period, kind, start, end, created_at) VALUES (?, ?, ?, 'defer', ?, ?, ?)`, uid, taskId, period, Date.now(), until, Date.now());
  markDirty(uid);
}
export function skipOccurrence(uid, taskId, period) {
  const t = taskById(taskId); if (!t || !t.recur) return;
  run(`INSERT INTO occurrences(task_id, period, status, at, by) VALUES (?, ?, 'skipped', ?, ?) ON CONFLICT(task_id, period) DO UPDATE SET status = 'skipped'`, taskId, period, Date.now(), uid);
  logActivity(t.project_id, uid, `Skipped ${label(t)}`);
  touchProject(t.project_id);
}
export { touchProject };

// ---------- follow-ups (e.g. washer → dryer → fold) and external events ----------
// task.meta.followups = [{ title, duration, after (min), event, location }]
export function createFollowups(uid, t) {
  const now = Date.now();
  for (const f of (t.meta?.followups || [])) {
    if (!f?.title) continue;
    const after = Math.max(0, +f.after || 0);
    run(`INSERT INTO tasks(project_id, title, duration, priority, assignee_id, created_by, created_at, updated_at, location, wait_event, wait_until, source_task, meta, sort, min_chunk)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, t.project_id, String(f.title).slice(0, 200), Math.max(5, +f.duration || 10), uid, uid, now, now,
      f.location ?? t.location ?? null, f.event ? String(f.event).slice(0, 60) : null, after ? now + after * 60000 : (f.event ? null : now), t.id,
      JSON.stringify({ followup: true, followups: f.then || [] }), now, Math.max(5, +f.duration || 10));
  }
}
// an event from outside (Home Assistant: "washer_done") releases waiting follow-ups of these users
export function triggerEvent(uids, name) {
  name = String(name || '').trim().toLowerCase().slice(0, 60);
  if (!name || !uids.length) return [];
  const rows = all(`SELECT t.* FROM tasks t JOIN project_members m ON m.project_id = t.project_id
    WHERE t.status != 'done' AND lower(t.wait_event) = ? AND m.user_id IN (${uids.map(() => '?').join(',')}) GROUP BY t.id`, name, ...uids);
  for (const r of rows) run('UPDATE tasks SET wait_event = NULL, wait_until = ?, updated_at = ? WHERE id = ?', Date.now(), Date.now(), r.id);
  const pids = [...new Set(rows.map(r => r.project_id))];
  pids.forEach(touchProject);
  return rows.map(r => taskById(r.id));
}

// ---------- appointments you track: start, pause, done (one runs at a time, a task timer stops it and the other way round) ----------
export function pauseEvent(uid, now = Date.now()) {
  const r = run('UPDATE event_track SET spent = spent + (? - since) / 60000.0, since = NULL WHERE user_id = ? AND since IS NOT NULL', now, uid);
  if (r.changes) notifyUsers([uid], 'timer');
}
export function startEvent(uid, e, now = Date.now()) {
  stopTimer(uid); pauseEvent(uid, now);
  run('DELETE FROM event_track WHERE user_id = ? AND start < ?', uid, now - 30 * 864e5);
  run(`INSERT INTO event_track(user_id, calendar_id, ext_id, start, since) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, calendar_id, ext_id) DO UPDATE SET since = excluded.since, done_at = NULL`, uid, e.calendar_id, e.ext_id, e.start, now);
  notifyUsers([uid], 'timer');
}
export function eventDone(uid, e, now = Date.now(), ended = null) {
  run(`INSERT INTO event_track(user_id, calendar_id, ext_id, start, done_at, ended) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, calendar_id, ext_id) DO UPDATE SET spent = spent + COALESCE((? - since) / 60000.0, 0), since = NULL, done_at = excluded.done_at, ended = excluded.ended`, uid, e.calendar_id, e.ext_id, e.start, now, ended, now);
  notifyUsers([uid], 'timer');
}
