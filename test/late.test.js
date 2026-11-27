// Forgot to start: the session starts from the planned time and runs to the planned end + 30 min, 30 min more each time, until Done
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-late-'));

const { run, get } = await import('../server/db.js');
const { createUser } = await import('../server/auth.js');
const { planUser, missedStart, openEnd } = await import('../server/planner.js');
const A = await import('../server/actions.js');

const u = createUser({ username: 'lea', name: 'Lea', password: 'long password 123' });
const now = Date.now();
const pid = Number(run(`INSERT INTO projects(name, owner_id, created_at) VALUES ('Work', ?, ?)`, u, now).lastInsertRowid);
run('INSERT INTO project_members(project_id, user_id) VALUES (?, ?)', pid, u);
const tid = Number(run(`INSERT INTO tasks(project_id, title, duration, auto, created_by, assignee_id, created_at, updated_at) VALUES (?, 'Write', 60, 1, ?, ?, ?, ?)`, pid, u, u, now, now).lastInsertRowid);

test('openEnd: 30 min more each time the end is reached', () => {
  const t = 1_000_000_000_000, M = 60000;
  assert.equal(openEnd(t + 10 * M, t), t + 10 * M);
  assert.equal(openEnd(t, t), t + 30 * M);
  assert.equal(openEnd(t, t + 29 * M), t + 30 * M);
  assert.equal(openEnd(t, t + 30 * M), t + 60 * M);
});

test('a block started late starts from its planned time and keeps going until Done', () => {
  const b = planUser(u, now).blocks.find(x => x.key === String(tid));
  assert.ok(b, 'planned');
  planUser(u, b.s);                                   // the block is due
  const late = b.s + 20 * 60000;
  planUser(u, late);                                  // nobody started it: it slid with the clock
  const m = missedStart(u, late);
  assert.equal(m.key, String(tid)); assert.equal(m.s, b.s);
  A.startTimer(u, tid, 0, null, null, { since: m.s, until: m.e + 30 * 60000 });
  const a = get('SELECT * FROM active WHERE user_id = ?', u);
  assert.equal(a.since, b.s);
  const after = a.until + 5 * 60000, p = planUser(u, after);
  const cur = p.blocks.filter(x => x.key === String(tid));
  assert.equal(cur.length, 1, 'only the running session');
  assert.equal(cur[0].s, b.s); assert.equal(cur[0].e, a.until + 30 * 60000);
  assert.equal(missedStart(u, after), null, 'nothing missed while it runs');
  A.stopTimer(u, { done: true, end: after });
  assert.equal(get('SELECT start FROM work_log WHERE task_id = ?', tid).start, b.s);
});
