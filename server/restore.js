// Restore from "Backup" (Settings → Data): brings back projects that are missing (deleted by mistake, or a new server),
// with their tasks, rounds, work sessions; settings like hours and fixed blocks are taken over. Nothing is duplicated.
import { all, get, run, tx, J } from './db.js';
import { settingsOf, saveSettings } from './models.js';
import { markDirty } from './planner.js';
import { httpErr } from './auth.js';

const TASK_COLS = ['title', 'notes', 'status', 'col', 'priority', 'duration', 'min_chunk', 'deadline', 'start_after', 'assign_mode', 'schedule', 'auto', 'recur', 'points', 'meta', 'sort', 'grp', 'do_next', 'spent', 'done_at', 'location', 'wait_event', 'wait_until', 'created_at', 'updated_at'];
export function restoreBackup(uid, data) {
  if (!data || !Array.isArray(data.projects) || !Array.isArray(data.tasks)) throw httpErr(400, 'Not a Smart Calendar backup');
  return tx(() => {
    const s = settingsOf(uid), b = data.settings || {};
    for (const k of ['hours', 'fixed', 'chunk', 'dFree', 'dSub', 'horizonDays', 'notify', 'view']) if (b[k] != null) s[k] = b[k];
    saveSettings(uid, s);
    const pmap = new Map(), tmap = new Map(); let np = 0, nt = 0, nl = 0;
    for (const p of data.projects) {
      const there = get(`SELECT p.id FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ? WHERE p.id = ? OR json_extract(p.meta, '$.restoredFrom') = ?`, uid, p.id, p.id);
      if (there) continue;   // still there, or restored before
      if (p.name === 'Inbox' && get(`SELECT 1 FROM projects WHERE owner_id = ? AND name = 'Inbox'`, uid)) { pmap.set(p.id, get(`SELECT id FROM projects WHERE owner_id = ? AND name = 'Inbox'`, uid).id); continue; }
      const id = Number(run(`INSERT INTO projects(name, color, kind, owner_id, schedule, columns, meta, target_date, sort, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        String(p.name || 'Project').slice(0, 100), p.color || '#1971c2', p.kind === 'outline' ? 'outline' : 'board', uid, p.schedule || 'work', p.columns || '["To do","Done"]', JSON.stringify({ ...J(p.meta, {}), restoredFrom: p.id }), p.target_date || null, p.sort || 0, p.archived ? 1 : 0, p.created_at || Date.now()).lastInsertRowid);
      run(`INSERT INTO project_members(project_id, user_id, role) VALUES (?, ?, 'owner')`, id, uid);
      pmap.set(p.id, id); np++;
    }
    // tasks: parents first, so their new ids are known
    let rest = data.tasks.filter(t => pmap.has(t.project_id));
    for (let guard = 0; rest.length && guard < 20; guard++) {
      const next = [];
      for (const t of rest) {
        if (t.parent_id && !tmap.has(t.parent_id) && rest.some(x => x.id === t.parent_id)) { next.push(t); continue; }
        const vals = TASK_COLS.map(k => t[k] ?? null);
        const id = Number(run(`INSERT INTO tasks(project_id, parent_id, assignee_id, created_by, ${TASK_COLS.join(', ')}) VALUES (?, ?, ?, ?, ${TASK_COLS.map(() => '?').join(', ')})`,
          pmap.get(t.project_id), t.parent_id ? tmap.get(t.parent_id) ?? null : null, uid, uid, ...vals.map((v, i) => v ?? (['created_at', 'updated_at'].includes(TASK_COLS[i]) ? Date.now() : ['status'].includes(TASK_COLS[i]) ? 'todo' : ['points'].includes(TASK_COLS[i]) ? '[]' : ['meta'].includes(TASK_COLS[i]) ? '{}' : ['col', 'priority', 'sort', 'grp', 'spent', 'auto'].includes(TASK_COLS[i]) ? (TASK_COLS[i] === 'auto' ? 1 : TASK_COLS[i] === 'priority' ? 2 : 0) : TASK_COLS[i] === 'duration' ? 30 : null))).lastInsertRowid);
        tmap.set(t.id, id); nt++;
      }
      rest = next;
    }
    for (const o of data.occurrences || []) if (tmap.has(o.task_id)) run('INSERT OR IGNORE INTO occurrences(task_id, period, status, at, by, spent) VALUES (?, ?, ?, ?, ?, ?)', tmap.get(o.task_id), o.period, o.status, o.at, uid, o.spent || 0);
    for (const w of data.work_log || []) if (tmap.has(w.task_id)) { run('INSERT INTO work_log(user_id, task_id, period, kind, start, end, note, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', uid, tmap.get(w.task_id), w.period || 0, w.kind || 'work', w.start, w.end, w.note || null, w.done || 0); nl++; }
    for (const a of data.appts || []) if (a.end > Date.now() && !get('SELECT 1 FROM appts WHERE user_id = ? AND start = ? AND title = ?', uid, a.start, a.title)) run('INSERT INTO appts(user_id, start, end, title, kind) VALUES (?, ?, ?, ?, ?)', uid, a.start, a.end, a.title, a.kind || 'appt');
    markDirty(uid, true);
    return { projects: np, tasks: nt, sessions: nl };
  });
}
