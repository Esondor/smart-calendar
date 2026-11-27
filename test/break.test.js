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
