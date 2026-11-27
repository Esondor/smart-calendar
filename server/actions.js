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
  if (done) { const ps = get('SELECT task_id, period FROM paused WHERE user_id = ?', uid); if (ps && ps.task_id === taskId && ps.period === p) settlePaused(uid, { gone: true }); }
  tx(() => {
    if (t.recur) {
      if (done) run(`INSERT INTO occurrences(task_id, period, status, at, by) VALUES (?, ?, 'done', ?, ?) ON CONFLICT(task_id, period) DO UPDATE SET status = 'done', at = excluded.at, by = excluded.by`, taskId, p, Date.now(), uid);
      else run('DELETE FROM occurrences WHERE task_id = ? AND period = ?', taskId, p);
    } else {
      const cols = J(get('SELECT columns FROM projects WHERE id = ?', t.project_id).columns, []);
      if (done) run(`UPDATE tasks SET status = 'done', col = ?, done_at = ?, done_by = ?, do_next = NULL, updated_at = ? WHERE id = ?`, Math.max(0, cols.length - 1), Date.now(), uid, Date.now(), taskId);
      else run(`UPDATE tasks SET status = 'todo', col = CASE WHEN col >= ? THEN 0 ELSE col END, done_at = NULL, done_by = NULL, archived_at = NULL, updated_at = ? WHERE id = ?`, Math.max(1, cols.length - 1), Date.now(), taskId);
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
  if (!from && resumePaused(uid, taskId, period, mode)) return;
  if (from) settlePaused(uid, { gone: true });
  run('INSERT INTO active(user_id, task_id, period, since, mode, note, until) VALUES (?, ?, ?, ?, ?, ?, ?)', uid, taskId, period, from ? from.since : Date.now(), mode, note, from ? from.until : null);
  const t = taskById(taskId);
  if (t && !t.recur && t.status === 'todo') { run(`UPDATE tasks SET status = 'doing', col = CASE WHEN col = 0 THEN 1 ELSE col END WHERE id = ?`, taskId); touchProject(t.project_id); }
  hooks.onStart.forEach(fn => { try { fn(t, uid); } catch (e) { console.error(e); } });
  markDirty(uid); notifyUsers([uid], 'timer');
}
export function stopTimer(uid, { done = false, end = Date.now(), cal = true } = {}) {
  const a = get('SELECT * FROM active WHERE user_id = ?', uid); if (!a) return 0;
  run('DELETE FROM active WHERE user_id = ?', uid);
  const m = Math.max(0, (end - a.since) / 60000), t = taskById(a.task_id);
  if (m >= 1 && t) {
    run('INSERT INTO work_log(user_id, task_id, period, kind, start, end, note, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', uid, a.task_id, a.period, a.mode === 'r' ? 'research' : 'work', a.since, end, a.note, done ? 1 : 0);
    if (!t.recur) run('UPDATE tasks SET spent = spent + ? WHERE id = ?', m, a.task_id);
    if (cal) logSession(uid, a, t, end, done);
  }
  markDirty(uid); notifyUsers([uid], 'timer');
  return m;
}
function logSession(uid, a, t, end, done = false) {
  const r = a.mode === 'r';
  // a block in the calendar that already shows this session (it is kept, cut to the real end): no second entry
  const shown = !r && get('SELECT 1 FROM plan_events WHERE user_id = ? AND task_id = ? AND start <= ? AND end >= ?', uid, a.task_id, a.since + 60000, Math.min(end, Date.now()) - 60000);
  if (!shown) logToCalendar(uid, '✓ ' + (r ? 'Research' + (a.note ? ': ' + a.note : '') + ' · ' : '') + label(t), a.since, end, r ? 'research' : 'session');
}

// ---------- pause ----------
// Pause logs the session so far and keeps the task in Now. Resumed within 10 min, it goes on as one session (the
// pause counts as part of it); after that the part before stays on its own and Resume starts a new session.
export const RESUME_MS = 10 * 60000;
export function pauseTimer(uid) {
  const a = get('SELECT * FROM active WHERE user_id = ?', uid); if (!a) return 0;
  if (a.mode === 'r') return stopTimer(uid);
  const now = Date.now(), m = stopTimer(uid, { cal: false, end: now });
  const log = get('SELECT id FROM work_log WHERE user_id = ? AND task_id = ? AND start = ? ORDER BY id DESC LIMIT 1', uid, a.task_id, a.since);
  run('DELETE FROM paused WHERE user_id = ?', uid);
  run('INSERT INTO paused(user_id, task_id, period, since, at, until, note, log_id, cal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', uid, a.task_id, a.period, a.since, now, a.until, a.note, log?.id ?? null, log ? 1 : 0);
  notifyUsers([uid], 'timer');
  return m;
}
// the paused session is split for good: its part goes into the log calendar; gone: no longer waits in Now
export function settlePaused(uid, { gone = false, now = Date.now() } = {}) {
  const p = get('SELECT * FROM paused WHERE user_id = ?', uid); if (!p) return;
  if (p.cal && (gone || now - p.at >= RESUME_MS)) {
    const t = taskById(p.task_id);
    if (t) logSession(uid, { task_id: p.task_id, since: p.since, mode: null, note: p.note }, t, p.at);
    run('UPDATE paused SET cal = 0 WHERE user_id = ?', uid);
  }
  if (gone) { run('DELETE FROM paused WHERE user_id = ?', uid); notifyUsers([uid], 'timer'); }
}
export function settleAllPaused(now = Date.now()) {
  for (const p of all('SELECT user_id FROM paused WHERE cal = 1 AND at <= ?', now - RESUME_MS)) settlePaused(p.user_id, { now });
}
// Start on the paused task within 10 min: the logged part is taken back and the session goes on from its old start
function resumePaused(uid, taskId, period, mode) {
  const p = get('SELECT * FROM paused WHERE user_id = ?', uid); if (!p) return false;
  const same = p.task_id === taskId && p.period === period && !mode;
  const log = same && p.log_id && get('SELECT * FROM work_log WHERE id = ?', p.log_id);
  if (!same || Date.now() - p.at >= RESUME_MS || (p.log_id && !log)) { settlePaused(uid, { gone: true }); return false; }
  if (log) {
    run('DELETE FROM work_log WHERE id = ?', log.id);
    const t = taskById(taskId); if (t && !t.recur) run('UPDATE tasks SET spent = MAX(0, spent - ?) WHERE id = ?', (log.end - log.start) / 60000, taskId);
  }
  run('DELETE FROM paused WHERE user_id = ?', uid);
  run('INSERT INTO active(user_id, task_id, period, since, mode, note, until) VALUES (?, ?, ?, ?, NULL, ?, ?)', uid, taskId, period, p.since, p.note, p.until);
  markDirty(uid); notifyUsers([uid], 'timer');
  return true;
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
// a fixed break (Lunch, …) on one day only: moved there (it becomes a break of that day) or left out; the other days stay as set
export function fixedOnDay(uid, fid, date, { start, end, title, remove = false } = {}) {
  const f = (settingsOf(uid).fixed || []).find(x => String(x.id) === String(fid)); if (!f) return null;
  const key = `${f.id}:${date}`;
  if (!get(`SELECT 1 FROM appts WHERE user_id = ? AND kind = 'skipfixed' AND title = ?`, uid, key))
    run(`INSERT INTO appts(user_id, start, end, title, kind) VALUES (?, ?, ?, ?, 'skipfixed')`, uid, dayStart(date), dayEnd(date), key);
  const id = remove ? null : Number(run(`INSERT INTO appts(user_id, start, end, title, kind) VALUES (?, ?, ?, ?, 'break')`, uid, start, end, title || f.t).lastInsertRowid);
  markDirty(uid);
  return id;
}
// a logged session moved or resized in the calendar: its minutes follow, and its entry in Google (a kept block) is cut anew
export function moveSession(uid, id, start, end) {
  const w = get('SELECT * FROM work_log WHERE id = ? AND user_id = ?', id, uid); if (!w) return false;
  run('UPDATE work_log SET start = ?, end = ? WHERE id = ?', start, end, id);
  const t = taskById(w.task_id);
  if (t && !t.recur) run('UPDATE tasks SET spent = MAX(0, spent + ?) WHERE id = ?', ((end - start) - (w.end - w.start)) / 60000, w.task_id);
  run('UPDATE plan_events SET kept = 0, start = ?, end = ? WHERE user_id = ? AND task_id = ? AND kept = 1 AND start < ? AND end > ?', Math.min(start, w.start), Math.max(end, w.end), uid, w.task_id, w.end, w.start);
  markDirty(uid); notifyUsers([uid], 'timer');
  return true;
}
// a fixed break on one day as set again: the day's skip goes, and the break it was moved to (if given)
export function fixedDayReset(uid, fid, date, breakId = null) {
  run(`DELETE FROM appts WHERE user_id = ? AND kind = 'skipfixed' AND title = ?`, uid, `${fid}:${date}`);
  if (breakId) run(`DELETE FROM appts WHERE id = ? AND user_id = ? AND kind = 'break'`, breakId, uid);
  markDirty(uid);
}
// a logged session removed in the calendar, or put back (undo): its minutes and its entry in Google follow
export function removeSession(uid, id) {
  const w = get('SELECT * FROM work_log WHERE id = ? AND user_id = ?', id, uid); if (!w) return null;
  run('DELETE FROM work_log WHERE id = ?', id);
  const t = taskById(w.task_id);
  if (t && !t.recur) run('UPDATE tasks SET spent = MAX(0, spent - ?) WHERE id = ?', (w.end - w.start) / 60000, w.task_id);
  run('UPDATE plan_events SET kept = 0 WHERE user_id = ? AND task_id = ? AND kept = 1 AND start < ? AND end > ?', uid, w.task_id, w.end, w.start);
  markDirty(uid); notifyUsers([uid], 'timer');
  return w;
}
export function addSession(uid, w) {
  const t = taskById(w.task_id); if (!t) return null;
  const id = Number(run('INSERT INTO work_log(user_id, task_id, period, kind, start, end, note, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', uid, w.task_id, w.period || 0, w.kind === 'research' ? 'research' : 'work', w.start, w.end, w.note || null, w.done ? 1 : 0).lastInsertRowid);
  if (!t.recur) run('UPDATE tasks SET spent = spent + ? WHERE id = ?', (w.end - w.start) / 60000, w.task_id);
  markDirty(uid); notifyUsers([uid], 'timer');
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
// (the calendar row keeps what Google has until the plan is written there, else Google would read as moved back)
export function pinBlock(uid, taskId, period, oldStart, s, e) {
  // the session that runs now: its start is when you began (earlier or later, not before your last session), its end where
  // you put it, then 30 min more each time it is reached, until Done
  const a = get('SELECT * FROM active WHERE user_id = ?', uid), now = Date.now();
  if (s != null && a && a.task_id === taskId && (a.period || 0) === period && s < now) {
    const last = get('SELECT MAX(end) e FROM work_log WHERE user_id = ? AND end <= ?', uid, now)?.e || 0;
    const since = Math.max(Math.min(s, now - 60000), last, now - 864e5);
    run('UPDATE active SET since = ?, until = ? WHERE user_id = ?', since, Math.max(e, now + 5 * 60000), uid);
    run(`DELETE FROM overrides WHERE user_id = ? AND task_id = ? AND period = ? AND kind = 'pin'`, uid, taskId, period);
    markDirty(uid); notifyUsers([uid], 'timer');
    return;
  }
  run(`DELETE FROM overrides WHERE user_id = ? AND task_id = ? AND period = ? AND kind = 'pin' AND (ABS(start - ?) < 60000 OR ? = 0)`, uid, taskId, period, oldStart || 0, oldStart ? 1 : 0);
  if (s != null) run(`INSERT INTO overrides(user_id, task_id, period, kind, start, end, created_at) VALUES (?, ?, ?, 'pin', ?, ?, ?)`, uid, taskId, period, s, e, Date.now());
  markDirty(uid);
}
export function postpone(uid, taskId, period, until) {
  if (get('SELECT 1 FROM paused WHERE user_id = ? AND task_id = ?', uid, taskId)) settlePaused(uid, { gone: true });
  run(`DELETE FROM overrides WHERE user_id = ? AND task_id = ? AND period = ? AND kind = 'pin'`, uid, taskId, period);
  run(`INSERT INTO overrides(user_id, task_id, period, kind, start, end, created_at) VALUES (?, ?, ?, 'defer', ?, ?, ?)`, uid, taskId, period, Date.now(), until, Date.now());
  markDirty(uid);
}
export function skipOccurrence(uid, taskId, period) {
  if (get('SELECT 1 FROM paused WHERE user_id = ? AND task_id = ?', uid, taskId)) settlePaused(uid, { gone: true });
  const t = taskById(taskId); if (!t || !t.recur) return;
  run(`INSERT INTO occurrences(task_id, period, status, at, by) VALUES (?, ?, 'skipped', ?, ?) ON CONFLICT(task_id, period) DO UPDATE SET status = 'skipped'`, taskId, period, Date.now(), uid);
  logActivity(t.project_id, uid, `Skipped ${label(t)}`);
  touchProject(t.project_id);
}
// undo a skip: the round is planned again (only a skip is taken back, never a done)
export function unskipOccurrence(uid, taskId, period) {
  const t = taskById(taskId); if (!t) return;
  run(`DELETE FROM occurrences WHERE task_id = ? AND period = ? AND status = 'skipped'`, taskId, period);
  touchProject(t.project_id);
}
// a deleted task can come back (⌘Z in the calendar): before it goes, everything that goes with it (its sub-tasks and every
// row that points at them: sessions, rounds, pins, calendar entries …) is kept for an hour, then put back as it was
const DELETED = new Map();
const refsToTasks = () => all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'tasks'`).flatMap(t =>
  all(`SELECT "from" AS col FROM pragma_foreign_key_list(?) WHERE "table" = 'tasks'`, t.name).map(r => ({ table: t.name, col: r.col })));
export function deleteTask(uid, id) {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) all('SELECT id FROM tasks WHERE parent_id = ?', ids[i]).forEach(r => ids.push(r.id));
  const q = ids.map(() => '?').join(',');
  const snap = { tasks: ids.map(x => get('SELECT * FROM tasks WHERE id = ?', x)).filter(Boolean),
    rows: refsToTasks().map(({ table, col }) => ({ table, rows: all(`SELECT * FROM "${table}" WHERE "${col}" IN (${q})`, ...ids) })).filter(x => x.rows.length) };
  run('DELETE FROM tasks WHERE id = ?', id);
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  DELETED.set(token, { uid, at: Date.now(), snap });
  for (const [k, v] of DELETED) if (Date.now() - v.at > 3600e3) DELETED.delete(k);
  return token;
}
export function restoreTask(uid, token) {
  const d = DELETED.get(token); if (!d || d.uid !== uid) return null;
  // the task first (it must come back); then each row on its own, so one that no longer fits does not stop the rest
  const ins = (table, r) => { const ks = Object.keys(r); run(`INSERT OR IGNORE INTO "${table}"(${ks.map(k => `"${k}"`).join(',')}) VALUES (${ks.map(() => '?').join(',')})`, ...ks.map(k => r[k])); };
  tx(() => d.snap.tasks.forEach(r => ins('tasks', r)));
  for (const { table, rows } of d.snap.rows) for (const r of rows) { try { ins(table, r); } catch (e) { console.warn('restore', table, e.message); } }
  DELETED.delete(token);
  const t = d.snap.tasks[0]; if (t) touchProject(t.project_id);
  return t?.id ?? null;
}
// the archive of a board: done tasks put away, by hand or after the project's setting (meta.archiveAfter days, default
// 7, 0 = never); repeating tasks and outlines (a thesis keeps its structure) are never archived
export const ARCHIVE_DAYS = p => { const m = J(p.meta, {}); return m.archiveAfter == null ? 7 : Math.max(0, +m.archiveAfter || 0); };
export function archiveTask(uid, id, on = true) {
  const t = taskById(id); if (!t || (on && t.status !== 'done')) return false;
  run('UPDATE tasks SET archived_at = ? WHERE id = ?', on ? Date.now() : null, id);
  logActivity(t.project_id, uid, `${on ? 'Archived' : 'Restored'} ${t.title}`); touchProject(t.project_id);
  return true;
}
export function archiveDone(uid, pid, olderThan = Date.now()) {
  const n = run(`UPDATE tasks SET archived_at = ? WHERE project_id = ? AND status = 'done' AND archived_at IS NULL AND recur IS NULL AND COALESCE(done_at, updated_at) <= ?`, Date.now(), pid, olderThan).changes;
  if (n && uid) { logActivity(pid, uid, `Archived ${n} done`); touchProject(pid); }
  return n;
}
export function archiveTick(now = Date.now()) {
  for (const p of all(`SELECT id, meta FROM projects WHERE kind = 'board' AND archived = 0`)) {
    const d = ARCHIVE_DAYS(p); if (!d) continue;
    if (archiveDone(null, p.id, now - d * 864e5)) touchProject(p.id);
  }
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
