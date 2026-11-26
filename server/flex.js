// Turn a calendar event into a task the planner places for you.
// Type into an event's title or notes in any calendar app:
//   /flex 30   the event's time span is the window (e.g. 08:00–11:00 on weekdays): 30 min in it, as soon as possible,
//              placed smartly (next to another appointment or about an hour before closing; meals give way)
//   /task      a normal planned task as long as the event (or /task 45 for 45 min)
// The event is replaced by the planned block. The same is offered as "Auto-schedule" in the event's sheet.
import { all, get, run } from './db.js';
import { isoDate, hm, wd } from './time.js';
import { markDirty } from './planner.js';

export const FLEX_RE = /(^|\s)\/(flex|task)(?:\s+(\d+(?:[.,]\d+)?)\s*(min|m|h)?)?(?=\s|$)/i;
export function parseFlex(title, descr) {
  const m = String(title || '').match(FLEX_RE) || String(descr || '').match(FLEX_RE);
  if (!m) return null;
  const n = m[3] ? parseFloat(m[3].replace(',', '.')) : null;
  return { kind: m[2].toLowerCase(), minutes: n ? Math.round(/^h/i.test(m[4] || '') ? n * 60 : n) : null };
}
const strip = s => String(s || '').replace(new RegExp(FLEX_RE.source, 'gi'), '$1').replace(/[ \t]{2,}/g, ' ').trim();

// flexible appointments live in your own "Appointments" project (made on first use; ones made earlier move there)
export function appointmentsProject(uid) {
  const ex = get(`SELECT p.id FROM projects p WHERE p.owner_id = ? AND p.archived = 0 AND json_extract(p.meta, '$.appointments') = 1`, uid);
  if (ex) return ex.id;
  const now = Date.now(), sort = (get('SELECT MAX(sort) AS m FROM projects WHERE owner_id = ?', uid).m || 0) + 1;
  const pid = Number(run(`INSERT INTO projects(name, color, kind, owner_id, schedule, columns, created_at, sort, meta) VALUES ('Appointments', '#0a84ff', 'board', ?, 'personal', ?, ?, ?, ?)`,
    uid, JSON.stringify(['To do', 'Done']), now, sort, JSON.stringify({ appointments: 1 })).lastInsertRowid);
  run(`INSERT INTO project_members(project_id, user_id, role) VALUES (?, ?, 'owner')`, pid, uid);
  run(`UPDATE tasks SET project_id = ?, location = location WHERE created_by = ? AND status != 'done' AND json_extract(meta, '$.win') IS NOT NULL`, pid, uid);
  return pid;
}
// where /task goes: your personal / household project, else your first one
export function defaultProject(uid) {
  const ps = all(`SELECT p.id, p.name, p.kind FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ? WHERE p.archived = 0 ORDER BY p.sort, p.id`, uid);
  return (ps.find(p => /personal|privat|pers[öo]nlich|household|haus|home|wohnung/i.test(p.name) && p.kind !== 'outline') || ps.find(p => p.kind !== 'outline') || ps[0])?.id || null;
}

// ev: { calendar_id, ext_id, start, end, title, descr, location }; opts: { kind: 'flex'|'task', minutes, win }
export function eventToTask(uid, ev, { kind = 'flex', minutes = null, win = null } = {}) {
  const pid = kind === 'flex' ? appointmentsProject(uid) : defaultProject(uid); if (!pid) throw new Error('Create a project first');
  const dup = get(`SELECT id FROM tasks WHERE ext_source = 'gcal' AND ext_id = ? AND created_by = ?`, `${ev.calendar_id}:${ev.ext_id}`, uid);
  if (dup) return dup.id;
  const len = Math.max(5, Math.round((ev.end - ev.start) / 60000));
  const day = wd(isoDate(ev.start));
  const w = kind === 'flex' ? (win || { days: day >= 1 && day <= 5 ? [1, 2, 3, 4, 5] : [0, 6], s: hm(new Date(ev.start).getHours() * 60 + new Date(ev.start).getMinutes()), e: hm(new Date(ev.end).getHours() * 60 + new Date(ev.end).getMinutes()) }) : null;
  const span = w ? (+w.e.slice(0, 2) * 60 + +w.e.slice(3)) - (+w.s.slice(0, 2) * 60 + +w.s.slice(3)) : 24 * 60;
  const dur = Math.max(5, Math.min(minutes || (kind === 'flex' ? Math.min(len, 60) : len), span));   // /flex without minutes: up to an hour
  const now = Date.now(), sort = (get('SELECT MAX(sort) AS m FROM tasks WHERE project_id = ?', pid).m || 0) + 1;
  const id = Number(run(`INSERT INTO tasks(project_id, title, notes, duration, created_by, assignee_id, created_at, updated_at, start_after, location, meta, auto, sort, ext_source, ext_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'gcal', ?)`, pid, strip(ev.title).slice(0, 300) || 'Appointment', strip(ev.descr).slice(0, 4000), dur, uid, uid, now, now,
    isoDate(Math.max(ev.start, now)), ev.location || null, JSON.stringify(w ? { win: w } : {}), sort, `${ev.calendar_id}:${ev.ext_id}`).lastInsertRowid);
  markDirty(uid);
  return id;
}

// a flexible appointment made in the app (+ → Flexible Appointment): planned inside its window, written to the chosen calendar
export function createFlexible(uid, { title, minutes, win, calendarId, startAfter, location, notes, travel }) {
  const pid = appointmentsProject(uid);
  if (calendarId && !get(`SELECT 1 FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND c.user_id = ? AND c.writable = 1 AND a.kind = 'google'`, calendarId, uid)) throw new Error('Choose one of your Google calendars');
  const now = Date.now(), sort = (get('SELECT MAX(sort) AS m FROM tasks WHERE project_id = ?', pid).m || 0) + 1;
  const meta = { ...(win ? { win } : {}), ...(calendarId ? { calendarId: +calendarId } : {}), ...(+travel > 0 ? { travel: Math.min(180, Math.round(+travel)) } : {}) };
  const id = Number(run(`INSERT INTO tasks(project_id, title, notes, duration, created_by, assignee_id, created_at, updated_at, start_after, location, meta, auto, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, pid, String(title || '').trim().slice(0, 300) || 'Appointment', String(notes || '').slice(0, 4000), Math.max(5, Math.min(24 * 60, +minutes || 30)),
    uid, uid, now, now, startAfter && /^\d{4}-\d\d-\d\d$/.test(startAfter) ? startAfter : isoDate(now), location ? String(location).slice(0, 300) : null, JSON.stringify(meta), sort).lastInsertRowid);
  markDirty(uid);
  return id;
}
