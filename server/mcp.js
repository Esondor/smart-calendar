// Claude connector, part 2: an MCP server (Streamable HTTP, JSON responses) at /mcp.
// Every call acts as the one user whose OAuth token it carries, and only on projects that user is a member of.
import { db, all, get, run, J, kvGet, kvSet } from './db.js';
import { isMember, projectIdsFor, projectRow, taskRow, settingsOf, logActivity } from './models.js';
import { getPlan, calendarEvents } from './planner.js';
import * as A from './actions.js';
import { audit } from './logs.js';
import { userFromBearer, resourceUrl, issuer } from './oauth.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const PRI = ['asap', 'high', 'medium', 'low'];
const pad = n => String(n).padStart(2, '0');
const fmt = ms => { if (!ms) return null; const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const date = v => { if (v === null || v === '') return null; if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v; throw new Error(`"${v}" is not a date (YYYY-MM-DD)`); };
const str = (v, n) => String(v ?? '').slice(0, n);
const lvl = t => t.meta?.level || (t.parent_id ? 'item' : 'chapter');
const fail = msg => { throw Object.assign(new Error(msg), { tool: true }); };

function needProject(uid, pid) {
  if (!Number.isInteger(+pid) || !isMember(uid, +pid)) fail(`Project ${pid} not found`);
  return projectRow(get('SELECT * FROM projects WHERE id = ?', +pid));
}
// when each task is planned: first block, last block, too late for its deadline
function planInfo(uid) {
  const out = new Map(); let p;
  try { p = getPlan(uid); } catch { return out; }
  for (const [k, u] of Object.entries(p.units)) {
    const i = p.info[k] || {}, o = out.get(u.t.id);
    if (!o || (i.first || Infinity) < (o.first || Infinity)) out.set(u.t.id, { first: i.first, end: i.end, late: !!i.late, unplaced: i.unplaced || 0 });
  }
  return out;
}

// ---------- reading ----------
function listProjects(uid) {
  const info = planInfo(uid);
  return projectIdsFor(uid).map(id => get('SELECT * FROM projects WHERE id = ? AND archived = 0', id)).filter(Boolean).map(p => {
    const ts = all('SELECT id, status, duration, spent, parent_id FROM tasks WHERE project_id = ?', p.id), parents = new Set(ts.map(t => t.parent_id).filter(Boolean));
    const leaves = ts.filter(t => !parents.has(t.id)), open = leaves.filter(t => t.status !== 'done');
    const end = Math.max(0, ...open.map(t => info.get(t.id)?.end || 0));
    return { id: p.id, name: p.name, kind: p.kind, target_date: p.target_date, tasks: leaves.length, open: open.length,
      open_hours: Math.round(open.reduce((s, t) => s + Math.max(0, t.duration - t.spent), 0) / 6) / 10, planned_finish: fmt(end) };
  });
}
function nodeOut(t, kind, info, kids) {
  const m = t.meta || {}, level = kind === 'outline' ? lvl(t) : null, ch = kids.get(t.id) || [];
  const o = { id: t.id, ...(level ? { level } : {}) };
  const num = level === 'chapter' ? m.num : level === 'section' ? m.sid : null;
  if (num) o.number = num;
  o.title = t.title; o.status = t.status;
  if (level === 'chapter') Object.assign(o, clean({ short: m.short, summary: m.thread, purpose: m.role, leads_to: m.out }));
  if (level === 'section') Object.assign(o, clean({ note: m.warn, key_points: m.pts?.length ? m.pts : null }));
  if (!ch.length) {
    const i = info.get(t.id);
    Object.assign(o, { duration_min: t.duration, spent_min: Math.round(t.spent), planned: t.auto, priority: PRI[t.priority] || 'medium' },
      clean({ deadline: t.deadline, start_after: t.start_after, recurring: t.recur ? true : null }),
      t.status !== 'done' && i ? clean({ first_block: fmt(i.first), last_block: fmt(i.end), late: i.late || null, unplaced_min: i.unplaced || null }) : {});
  }
  if (t.notes?.trim()) o.notes = t.notes.slice(0, 4000);
  if (t.points?.length) o.checklist = t.points.map(x => ({ text: x.t, done: !!x.done }));
  if (ch.length) o.children = ch.map(c => nodeOut(c, kind, info, kids));
  return o;
}
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''));
function getProject(uid, pid, includeDone = true) {
  const p = needProject(uid, pid), info = planInfo(uid);
  const rows = all('SELECT * FROM tasks WHERE project_id = ? ORDER BY sort, id', p.id).map(taskRow).filter(t => includeDone || t.status !== 'done' || all('SELECT 1 FROM tasks WHERE parent_id = ? LIMIT 1', t.id).length);
  const ids = new Set(rows.map(t => t.id)), kids = new Map();
  for (const t of rows) { const k = t.parent_id && ids.has(t.parent_id) ? t.parent_id : 0; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(t); }
  const end = Math.max(0, ...rows.filter(t => t.status !== 'done').map(t => info.get(t.id)?.end || 0));
  return { project: clean({ id: p.id, name: p.name, kind: p.kind, target_date: p.target_date, levels: p.kind === 'outline' ? (p.meta.levels || ['Chapter', 'Section']) : null, planned_finish: fmt(end) }),
    tree: (kids.get(0) || []).map(t => nodeOut(t, p.kind, info, kids)) };
}
function schedule(uid, days) {
  const now = Date.now(), to = now + Math.max(1, Math.min(31, +days || 7)) * 864e5;
  let p; try { p = getPlan(uid); } catch { p = { blocks: [], units: {} }; }
  const blocks = p.blocks.filter(b => b.e > now && b.s < to).map(b => { const u = p.units[b.key]; return u && { start: fmt(b.s), end: fmt(b.e), task_id: u.t.id, title: u.t.title, project: u.t.p_name }; }).filter(Boolean);
  const events = calendarEvents(uid, now, to).filter(e => !e.ours).map(e => ({ start: e.all_day ? fmt(e.start).slice(0, 10) : fmt(e.start), end: e.all_day ? null : fmt(e.end), title: e.title, calendar: e.cal, blocks_time: !!e.blocks }));
  return { now: fmt(now), planned_blocks: blocks, appointments: events };
}

// ---------- changing ----------
// fields Claude may set on a task → table columns and the outline's meta
function fieldsOf(c, level, meta0) {
  const set = {}, meta = { ...meta0 };
  if ('title' in c) set.title = str(c.title, 300).trim() || fail('title is empty');
  if ('notes' in c) set.notes = str(c.notes, 20000);
  if ('duration_min' in c) { const d = Math.round(+c.duration_min); if (!(d > 0)) fail('duration_min must be a number of minutes'); set.duration = Math.max(5, Math.min(24 * 60, d)); }
  if ('deadline' in c) set.deadline = date(c.deadline);
  if ('start_after' in c) set.start_after = date(c.start_after);
  if ('priority' in c) { const i = PRI.indexOf(String(c.priority).toLowerCase()); if (i < 0) fail('priority is asap, high, medium or low'); set.priority = i; }
  if ('planned' in c) set.auto = c.planned ? 1 : 0;
  if ('status' in c) { if (!['todo', 'doing'].includes(c.status)) fail('status is todo or doing (use the done change to finish a task)'); set.status = c.status; }
  if ('checklist' in c) set.points = JSON.stringify((Array.isArray(c.checklist) ? c.checklist : []).slice(0, 200).map(x => typeof x === 'string' ? { t: str(x, 500), done: false } : { t: str(x?.text, 500), done: !!x?.done }));
  if ('number' in c) { if (level === 'chapter') meta.num = str(c.number, 12); else if (level === 'section') meta.sid = str(c.number, 12); }
  const M = { short: ['short', 40], summary: ['thread', 300], purpose: ['role', 2000], leads_to: ['out', 2000], note: ['warn', 500] };
  for (const [k, [mk, n]] of Object.entries(M)) if (k in c) meta[mk] = str(c[k], n);
  if ('key_points' in c) meta.pts = (Array.isArray(c.key_points) ? c.key_points : []).map(x => str(x, 500).trim()).filter(Boolean).slice(0, 50);
  return { set, meta };
}
function place(pid, parentId, id, position) {
  const sib = all('SELECT id FROM tasks WHERE project_id = ? AND parent_id IS ? AND id != ? ORDER BY sort, id', pid, parentId, id).map(r => r.id);
  const i = position == null || isNaN(+position) ? sib.length : Math.max(0, Math.min(sib.length, Math.round(+position)));
  sib.splice(i, 0, id); sib.forEach((x, k) => run('UPDATE tasks SET sort = ? WHERE id = ?', k, x));
}
const subtree = id => all('WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id) SELECT t.* FROM tasks t JOIN d ON d.id = t.id', id);
const LEVEL_OK = { chapter: [null], section: ['chapter'], item: [null, 'chapter', 'section'] };
const undoKey = (uid, pid) => `claude-undo:${uid}:${pid}`;

export function applyChanges(uid, pid, changes, dry) {
  const p = needProject(uid, pid), outline = p.kind === 'outline', s = settingsOf(uid);
  if (!Array.isArray(changes) || !changes.length) fail('changes is empty');
  if (changes.length > 300) fail('At most 300 changes at once');
  const refs = new Map(), lines = [], doneOps = [];
  const own = id => { const t = get('SELECT * FROM tasks WHERE id = ? AND project_id = ?', id, p.id); if (!t) fail(`task ${id} is not in this project`); return taskRow(t); };
  const resolve = v => { if (v == null) return null; if (refs.has(String(v))) return refs.get(String(v)); if (Number.isInteger(+v)) return +v; fail(`unknown ref "${v}"`); };
  const parentOf = (v, level) => {
    const id = resolve(v), par = id ? own(id) : null;
    if (outline && !LEVEL_OK[level].includes(par ? lvl(par) : null)) fail(`a ${level} cannot go ${par ? `under a ${lvl(par)}` : 'at the top level'}`);
    return par;
  };
  const q = t => `“${t.length > 60 ? t.slice(0, 57) + '…' : t}”`;
  const snapshot = dry ? null : { at: Date.now(), rows: all('SELECT * FROM tasks WHERE project_id = ?', p.id) };
  db.exec('BEGIN');
  try {
    changes.forEach((c, n) => {
      try {
        if (!c || typeof c !== 'object') fail('not an object');
        if (c.op === 'add') {
          const par0 = c.parent != null ? own(resolve(c.parent)) : null;
          const level = outline ? (c.level || (!par0 ? 'chapter' : lvl(par0) === 'chapter' ? 'section' : 'item')) : null;
          if (outline && !LEVEL_OK[level]) fail('level is chapter, section or item');
          const par = outline ? parentOf(c.parent, level) : par0;
          const leaf = !outline || level === 'item';
          const base = outline ? (level === 'chapter' ? { level, short: str(c.title, 24) } : { level }) : {};
          const { set, meta } = fieldsOf({ ...c }, level, base);
          if (!set.title) fail('title is missing');
          const now = Date.now();
          const row = { project_id: p.id, parent_id: par?.id ?? null, title: set.title, duration: leaf ? (outline ? s.dSub || 90 : s.dFree || 60) : 30, auto: leaf ? 1 : 0, grp: par?.grp || 0,
            sort: 1e9, assignee_id: uid, created_by: uid, created_at: now, updated_at: now, ...set, meta: JSON.stringify(meta) };
          const id = Number(run(`INSERT INTO tasks(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, ...Object.values(row)).lastInsertRowid);
          place(p.id, row.parent_id, id, c.position);
          if (c.ref != null) refs.set(String(c.ref), id);
          lines.push(`Add ${level || 'task'} ${q(row.title)}${par ? ` under ${q(par.title)}` : ''}${leaf ? `, ${row.duration} min` : ''}`);
        } else if (c.op === 'update') {
          const t = own(resolve(c.id)), level = outline ? lvl(t) : null;
          const { set, meta } = fieldsOf(c, level, t.meta);
          if (JSON.stringify(meta) !== JSON.stringify(t.meta)) set.meta = JSON.stringify(meta);
          const keys = Object.keys(set); if (!keys.length) fail('nothing to change');
          run(`UPDATE tasks SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(set), Date.now(), t.id);
          const what = Object.keys(c).filter(k => !['op', 'id'].includes(k)).map(k => k === 'title' ? `title → ${q(set.title)}` : k === 'duration_min' ? `${t.duration} → ${set.duration} min` : ['deadline', 'start_after'].includes(k) ? `${k} → ${c[k] ?? 'none'}` : k);
          lines.push(`Update ${q(t.title)}: ${what.join(', ')}`);
        } else if (c.op === 'move') {
          const t = own(resolve(c.id)), level = outline ? lvl(t) : null;
          const par = 'parent' in c ? (outline ? parentOf(c.parent, level) : (c.parent == null ? null : own(resolve(c.parent)))) : (t.parent_id ? own(t.parent_id) : null);
          if (par && subtree(t.id).some(x => x.id === par.id)) fail('cannot move a task into itself');
          run('UPDATE tasks SET parent_id = ?, grp = ?, updated_at = ? WHERE id = ?', par?.id ?? null, par ? par.grp : t.grp, Date.now(), t.id);
          place(p.id, par?.id ?? null, t.id, c.position);
          lines.push(`Move ${q(t.title)}${'parent' in c ? (par ? ` under ${q(par.title)}` : ' to the top level') : ''}${c.position != null ? ` to position ${+c.position + 1}` : ''}`);
        } else if (c.op === 'done') {
          const t = own(resolve(c.id)); if (t.recur) fail('recurring tasks are ticked off in the app');
          const done = c.done !== false; doneOps.push({ id: t.id, done });
          lines.push(`${done ? 'Mark done' : 'Reopen'} ${q(t.title)}`);
        } else if (c.op === 'delete') {
          const t = own(resolve(c.id)), all_ = subtree(t.id);
          if (all_.some(x => x.spent > 0) || get(`SELECT 1 FROM work_log WHERE task_id IN (${all_.map(() => '?').join(',')}) LIMIT 1`, ...all_.map(x => x.id))) fail(`${q(t.title)} has logged work; mark it done instead`);
          if (all_.some(x => x.ext_source)) fail(`${q(t.title)} comes from Vikunja; change it there`);
          run('DELETE FROM tasks WHERE id = ?', t.id);
          lines.push(`Delete ${q(t.title)}${all_.length > 1 ? ` with ${all_.length - 1} inside` : ''}`);
        } else fail('op is add, update, move, done or delete');
      } catch (e) { e.message = `Change ${n + 1}${c?.op ? ` (${c.op})` : ''}: ${e.message}`; throw e; }
    });
    // the done changes run after the rest, with the app's own logic (parents close, follow-ups, Vikunja)
    for (const d of doneOps) if (!get('SELECT 1 FROM tasks WHERE id = ?', d.id)) fail('A task marked done is deleted in the same batch');
    db.exec(dry ? 'ROLLBACK' : 'COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  if (dry) return { dry_run: true, changes: lines };
  kvSet(undoKey(uid, p.id), snapshot);
  for (const d of doneOps) A.setDone(uid, d.id, 0, d.done, 'Claude');
  logActivity(p.id, uid, `Claude: ${lines.length} change${lines.length === 1 ? '' : 's'}`);
  A.touchProject(p.id);
  return { applied: true, changes: lines };
}

// puts the project's tasks back as they were before Claude's last batch
export function undoLast(uid, pid) {
  const p = needProject(uid, pid), snap = kvGet(undoKey(uid, p.id));
  if (!snap || Date.now() - snap.at > 7 * 864e5) fail('Nothing to undo');
  const cols = all('PRAGMA table_info(tasks)').map(c => c.name), before = new Map(snap.rows.map(r => [r.id, r]));
  // parent links may point at rows that come back later in the same transaction: checked at the end
  db.exec('BEGIN'); db.exec('PRAGMA defer_foreign_keys = ON');
  try {
    const set = cols.filter(c => c !== 'id');
    for (const r of snap.rows) {
      if (get('SELECT 1 FROM tasks WHERE id = ?', r.id)) run(`UPDATE tasks SET ${set.map(c => c + ' = ?').join(', ')} WHERE id = ?`, ...set.map(c => r[c]), r.id);
      else run(`INSERT INTO tasks(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map(c => r[c]));
    }
    // only now: tasks added by the batch (nothing from before hangs under them any more)
    for (const { id } of all('SELECT id FROM tasks WHERE project_id = ?', p.id)) if (!before.has(id)) run('DELETE FROM tasks WHERE id = ?', id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  kvSet(undoKey(uid, p.id), null);
  logActivity(p.id, uid, 'Claude: undone');
  A.touchProject(p.id);
  return { undone: true };
}

function createProject(uid, a) {
  const name = str(a.name, 100).trim() || fail('name is missing'), outline = a.kind !== 'board';
  const meta = outline ? { levels: Array.isArray(a.levels) && a.levels.length === 2 ? a.levels.map(x => str(x, 30)) : ['Chapter', 'Section'] } : {};
  const sort = (get('SELECT MAX(p.sort) AS m FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ?', uid).m || 0) + 1;
  const id = Number(run(`INSERT INTO projects(name, color, kind, owner_id, schedule, target_date, sort, created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    name, /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : '#1971c2', outline ? 'outline' : 'board', uid, a.schedule === 'personal' ? 'personal' : 'work', a.target_date ? date(a.target_date) : null, sort, Date.now(), JSON.stringify(meta)).lastInsertRowid);
  run(`INSERT INTO project_members(project_id, user_id, role) VALUES (?, ?, 'owner')`, id, uid);
  logActivity(id, uid, 'Created by Claude'); A.touchProject(id);
  return { id, name, kind: outline ? 'outline' : 'board' };
}
function updateProject(uid, a) {
  const p = needProject(uid, a.project_id), set = {};
  if ('name' in a) set.name = str(a.name, 100).trim() || fail('name is empty');
  if ('target_date' in a) set.target_date = date(a.target_date);
  if ('schedule' in a) set.schedule = a.schedule === 'personal' ? 'personal' : 'work';
  if ('levels' in a) { if (!(Array.isArray(a.levels) && a.levels.length === 2)) fail('levels is two names, e.g. ["Chapter", "Section"]'); set.meta = JSON.stringify({ ...p.meta, levels: a.levels.map(x => str(x, 30)) }); }
  if (!Object.keys(set).length) fail('nothing to change');
  run(`UPDATE projects SET ${Object.keys(set).map(k => k + ' = ?').join(', ')} WHERE id = ?`, ...Object.values(set), p.id);
  A.touchProject(p.id);
  return { updated: true };
}

// ---------- tool list ----------
const FIELDS = {
  title: { type: 'string' }, notes: { type: 'string', description: 'Free text shown with the task' },
  duration_min: { type: 'number', description: 'Estimated work in minutes (items and board tasks). The planner books this much time.' },
  deadline: { type: ['string', 'null'], description: 'YYYY-MM-DD, null clears' }, start_after: { type: ['string', 'null'], description: 'YYYY-MM-DD: not planned before this day, null clears' },
  priority: { type: 'string', enum: PRI }, planned: { type: 'boolean', description: 'true = the planner schedules it; false = kept on the Later list' },
  status: { type: 'string', enum: ['todo', 'doing'] },
  checklist: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } } } },
  number: { type: 'string', description: 'Outline: chapter number ("3") or section number ("3.2")' },
  short: { type: 'string', description: 'Chapter: short name for lists' }, summary: { type: 'string', description: 'Chapter: one-line summary' },
  purpose: { type: 'string', description: 'Chapter: what it is for' }, leads_to: { type: 'string', description: 'Chapter: bridge to the next chapter' },
  note: { type: 'string', description: 'Section: warning or note shown on it' }, key_points: { type: 'array', items: { type: 'string' }, description: 'Section: key points' },
};
const id = { type: ['integer', 'string'], description: 'Task id, or the ref of a task added earlier in the same batch' };
const TOOLS = [
  { name: 'list_projects', title: 'List projects', description: 'The user\'s projects with open work and the planned finish.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'get_project', title: 'Read a project', description: 'A project as a tree. Outline projects (e.g. a thesis): chapters → sections → items; items carry the estimate (duration_min), time spent, and when the planner has booked them. Read this before changing a project.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'integer' }, include_done: { type: 'boolean', description: 'Default true' } }, required: ['project_id'] }, annotations: { readOnlyHint: true } },
  { name: 'get_schedule', title: 'Read the schedule', description: 'Planned work blocks and calendar appointments for the coming days.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 31, description: 'Default 7' } } }, annotations: { readOnlyHint: true } },
  { name: 'apply_changes', title: 'Change a project', description: 'Add, update, move, finish or delete tasks of one project in one batch. Always call it with dry_run: true first, show the user the returned list, and apply (dry_run: false) only after they agree. The planner reschedules right after.',
    inputSchema: { type: 'object', required: ['project_id', 'changes', 'dry_run'], properties: {
      project_id: { type: 'integer' }, dry_run: { type: 'boolean', description: 'true = only check and describe the changes' },
      changes: { type: 'array', maxItems: 300, items: { type: 'object', required: ['op'], properties: {
        op: { type: 'string', enum: ['add', 'update', 'move', 'done', 'delete'] }, id,
        ref: { type: 'string', description: 'add: a name for the new task, usable as id or parent by later changes in this batch' },
        parent: { ...id, type: ['integer', 'string', 'null'], description: 'add/move: the chapter or section it goes into; null = top level' },
        level: { type: 'string', enum: ['chapter', 'section', 'item'], description: 'add, outline projects: default follows from the parent' },
        position: { type: 'integer', description: 'add/move: 0-based place among its siblings; default last' },
        done: { type: 'boolean', description: 'done: false reopens' }, ...FIELDS } } } } }, annotations: { destructiveHint: true } },
  { name: 'undo_last_changes', title: 'Undo the last change', description: 'Puts the project back as it was before the last applied apply_changes batch (within 7 days). Edits made in the app since then are lost.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'integer' } }, required: ['project_id'] }, annotations: { destructiveHint: true } },
  { name: 'create_project', title: 'Create a project', description: 'A new empty project; fill it with apply_changes. kind outline = chapters/sections/items (thesis, report, course); board = a plain list of tasks.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['outline', 'board'], description: 'Default outline' },
      target_date: { type: 'string', description: 'YYYY-MM-DD' }, levels: { type: 'array', items: { type: 'string' }, description: 'Outline: names of the two levels, default ["Chapter", "Section"]' },
      schedule: { type: 'string', enum: ['work', 'personal'], description: 'Which hours it is planned into; default work' } } } },
  { name: 'update_project', title: 'Change project details', description: 'Rename a project or change its target date, hours or level names.',
    inputSchema: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'integer' }, name: { type: 'string' }, target_date: { type: ['string', 'null'] },
      schedule: { type: 'string', enum: ['work', 'personal'] }, levels: { type: 'array', items: { type: 'string' } } } } },
];
const INSTRUCTIONS = `Smart Calendar plans the user's tasks into the free time of their calendar. Projects of kind "outline" (such as a thesis) are trees: chapters → sections → items; only items (leaves) carry an estimate (duration_min) and get booked.
To bring a project in line with a document: read it with get_project, compare, then send all edits as one apply_changes batch with dry_run: true, show the user the list it returns, and apply with dry_run: false once they agree. Keep ids of existing tasks (update or move them) rather than deleting and re-adding, so logged work stays attached. Tasks with logged work cannot be deleted; mark them done. Times are the user's local time.`;

function call(uid, name, a = {}) {
  switch (name) {
    case 'list_projects': return { projects: listProjects(uid) };
    case 'get_project': return getProject(uid, a.project_id, a.include_done !== false);
    case 'get_schedule': return schedule(uid, a.days);
    case 'apply_changes': if (typeof a.dry_run !== 'boolean') fail('dry_run is required'); return applyChanges(uid, a.project_id, a.changes, a.dry_run);
    case 'undo_last_changes': return undoLast(uid, a.project_id);
    case 'create_project': return createProject(uid, a);
    case 'update_project': return updateProject(uid, a);
    default: fail(`Unknown tool ${name}`);
  }
}

export default async function mcpRoutes(app) {
  const challenge = (req, reply, why) => reply.code(401).header('www-authenticate', `Bearer resource_metadata="${issuer(req)}/.well-known/oauth-protected-resource/mcp"${why ? ', error="invalid_token"' : ''}`).send({ error: 'Sign in required' });
  // browsers may only talk to it from Claude or from this server (DNS rebinding)
  const originOk = req => { const o = req.headers.origin; if (!o) return true; try { const h = new URL(o).hostname; return ['claude.ai', 'claude.com'].includes(h) || o === new URL(issuer(req)).origin; } catch { return false; } };
  app.post('/mcp', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!originOk(req)) return reply.code(403).send({ error: 'Origin not allowed' });
    const who = userFromBearer(req);
    if (!who) return challenge(req, reply, !!req.headers.authorization);
    const one = async m => {
      if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return m?.id != null ? { jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'Invalid request' } } : null;
      if (m.id == null) return null;   // notification
      const ok = result => ({ jsonrpc: '2.0', id: m.id, result });
      if (m.method === 'initialize') {
        const v = VERSIONS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : VERSIONS[0];
        return ok({ protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'smart-calendar', title: 'Smart Calendar', version: '1.1.0' }, instructions: INSTRUCTIONS });
      }
      if (m.method === 'ping') return ok({});
      if (m.method === 'tools/list') return ok({ tools: TOOLS });
      if (m.method === 'tools/call') {
        const name = m.params?.name;
        try {
          const r = call(who.u.id, name, m.params?.arguments || {});
          if (name === 'apply_changes' && !r.dry_run) audit(req, 'claude.apply', `${r.changes.length} changes in project ${m.params.arguments.project_id}`, null, who.u.id);
          return ok({ content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r });
        } catch (e) {
          if (!e.tool && !/^Change \d/.test(e.message)) req.log.error(e);
          return ok({ content: [{ type: 'text', text: e.tool || /^Change \d/.test(e.message) ? e.message : 'Server error' }], isError: true });
        }
      }
      return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } };
    };
    const body = req.body;
    if (Array.isArray(body)) { const out = (await Promise.all(body.map(one))).filter(Boolean); return out.length ? reply.send(out) : reply.code(202).send(); }
    const out = await one(body);
    return out ? reply.send(out) : reply.code(202).send();
  });
  app.get('/mcp', async (req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'Use POST' }));
  app.delete('/mcp', async (req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'Use POST' }));
}
export { TOOLS, resourceUrl };
