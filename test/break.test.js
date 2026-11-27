// A break you schedule: a long task is split around it, like around Lunch; nothing goes into the calendar
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-break-'));

const { run, get } = await import('../server/db.js');
const { createUser } = await import('../server/auth.js');
const { settingsOf, saveSettings } = await import('../server/models.js');
const { planUser } = await import('../server/planner.js');
const A = await import('../server/actions.js');

const u = createUser({ username: 'bo', name: 'Bo', password: 'long password 123' });
const s = settingsOf(u), all24 = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, ['00:00', '24:00']]));
s.hours = { work: all24, personal: all24 }; s.fixed = []; s.plan.calendarId = 1; saveSettings(u, s);
const now = Date.now();
const pid = Number(run(`INSERT INTO projects(name, owner_id, created_at) VALUES ('Work', ?, ?)`, u, now).lastInsertRowid);
run('INSERT INTO project_members(project_id, user_id) VALUES (?, ?)', pid, u);
const tid = Number(run(`INSERT INTO tasks(project_id, title, duration, auto, created_by, assignee_id, created_at, updated_at) VALUES (?, 'Long task', 180, 1, ?, ?, ?, ?)`, pid, u, u, now, now).lastInsertRowid);

test('a scheduled break splits a long task around it', () => {
  const b = planUser(u, now).blocks.filter(x => x.key === String(tid)).sort((x, y) => x.s - y.s)[0];
  const bs = b.s + 60 * 60000, be = bs + 15 * 60000;
  A.addAppt(u, bs, be, 'Break', 'break');
  const p = planUser(u, now), mine = p.blocks.filter(x => x.key === String(tid));
  assert.ok(!mine.some(x => x.s < be && x.e > bs), 'nothing planned in the break');
  assert.equal(mine.reduce((m, x) => m + (x.e - x.s), 0) / 60000, 180, 'all of it still planned');
  assert.equal(get('SELECT COUNT(*) n FROM outbox WHERE user_id = ?', u).n, 0, 'not written to the calendar');
});

test('a fixed break on one day: moved or left out there only; the plan uses it', () => {
  const st = settingsOf(u); st.fixed = [{ id: 'l1', t: 'Lunch', s: '12:00', e: '12:45', days: [0, 1, 2, 3, 4, 5, 6], flex: false }]; saveSettings(u, st);
  const isoDate = d => new Date(d).toLocaleDateString('sv'), dayStart = d => new Date(d + 'T00:00').getTime();
  const d1 = isoDate(now + 864e5), d2 = isoDate(now + 2 * 864e5);
  const lunch = d => planUser(u, now).busy.filter(b => b.t === 'Lunch' && isoDate(b.s) === d);
  assert.equal(lunch(d1).length, 1);
  const at = dayStart(d1) + 14 * 3600e3;
  const id = A.fixedOnDay(u, 'l1', d1, { start: at, end: at + 30 * 60000 });
  assert.deepEqual(lunch(d1).map(b => [b.kind, b.s]), [['break', at]], 'moved that day');
  assert.equal(lunch(d2).length, 1, 'the next day as set');
  A.fixedOnDay(u, 'l1', d2, { remove: true });
  assert.equal(lunch(d2).length, 0, 'skipped that day');
  assert.equal(planUser(u, now).busy.filter(b => b.t === 'Lunch' && isoDate(b.s) === isoDate(now + 3 * 864e5)).length, 1, 'other days unchanged');
  assert.ok(id);
});

test('a logged session moved in the calendar: its minutes follow', () => {
  const t0 = Date.now() - 3 * 3600e3;
  const tid2 = Number(run(`INSERT INTO tasks(project_id, title, duration, auto, created_by, assignee_id, created_at, updated_at, spent) VALUES (?, 'Logged', 60, 1, ?, ?, ?, ?, 30)`, pid, u, u, now, now).lastInsertRowid);
  const id = Number(run(`INSERT INTO work_log(user_id, task_id, kind, start, end) VALUES (?, ?, 'work', ?, ?)`, u, tid2, t0, t0 + 30 * 60000).lastInsertRowid);
  assert.ok(A.moveSession(u, id, t0 - 15 * 60000, t0 + 30 * 60000));
  assert.equal(get('SELECT start FROM work_log WHERE id = ?', id).start, t0 - 15 * 60000);
  assert.equal(get('SELECT spent FROM tasks WHERE id = ?', tid2).spent, 45);
  assert.equal(A.moveSession(u + 99, id, t0, t0 + 60000), false, 'only your own');
});
