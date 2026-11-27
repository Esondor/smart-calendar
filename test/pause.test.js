// Pause: the session so far is logged and the task waits in Now; resumed within 10 min it is one session, later a new one
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-pause-'));

const { run, get, all } = await import('../server/db.js');
const { createUser } = await import('../server/auth.js');
const A = await import('../server/actions.js');

const u = createUser({ username: 'pia', name: 'Pia', password: 'long password 123' });
const now = Date.now();
const pid = Number(run(`INSERT INTO projects(name, owner_id, created_at) VALUES ('Work', ?, ?)`, u, now).lastInsertRowid);
run('INSERT INTO project_members(project_id, user_id) VALUES (?, ?)', pid, u);
const mk = title => Number(run(`INSERT INTO tasks(project_id, title, duration, auto, created_by, assignee_id, created_at, updated_at) VALUES (?, ?, 120, 1, ?, ?, ?, ?)`, pid, title, u, u, now, now).lastInsertRowid);
const logs = id => all('SELECT start, end FROM work_log WHERE task_id = ? ORDER BY start', id);
const backdate = ms => { run('UPDATE active SET since = since - ? WHERE user_id = ?', ms, u); };

test('resumed within 10 min: one session from the first start', () => {
  const t = mk('Write');
  A.startTimer(u, t); backdate(30 * 60000);
  const since = get('SELECT since FROM active WHERE user_id = ?', u).since;
  A.pauseTimer(u);
  assert.equal(logs(t).length, 1, 'logged at once');
  assert.ok(get('SELECT 1 FROM paused WHERE user_id = ? AND task_id = ?', u, t), 'waits in Now');
  assert.ok(get('SELECT spent FROM tasks WHERE id = ?', t).spent >= 29);
  run('UPDATE paused SET at = at - ? WHERE user_id = ?', 5 * 60000, u);   // 5 min later
  A.startTimer(u, t);
  assert.equal(get('SELECT since FROM active WHERE user_id = ?', u).since, since, 'goes on from the first start');
  assert.equal(logs(t).length, 0, 'the logged part is taken back');
  assert.ok(get('SELECT spent FROM tasks WHERE id = ?', t).spent < 1);
  assert.equal(get('SELECT 1 FROM paused WHERE user_id = ?', u), undefined);
  A.stopTimer(u);
  assert.equal(logs(t).length, 1); assert.equal(logs(t)[0].start, since);
});

test('after 10 min: the part before stays on its own, Resume starts a new session', () => {
  const t = mk('Read');
  A.startTimer(u, t); backdate(40 * 60000);
  A.pauseTimer(u);
  run('UPDATE paused SET at = at - ? WHERE user_id = ?', 15 * 60000, u);
  A.settleAllPaused();
  assert.equal(get('SELECT cal FROM paused WHERE user_id = ?', u).cal, 0, 'split for good');
  assert.ok(get('SELECT 1 FROM paused WHERE user_id = ?', u), 'still waits in Now');
  const t0 = Date.now(); A.startTimer(u, t);
  assert.ok(get('SELECT since FROM active WHERE user_id = ?', u).since >= t0, 'new start time');
  assert.equal(logs(t).length, 1, 'the first part kept');
  A.stopTimer(u);
});

test('done, another task or stop: no longer waits in Now', () => {
  const t = mk('Mail'), o = mk('Other');
  A.startTimer(u, t); backdate(10 * 60000); A.pauseTimer(u);
  A.startTimer(u, o);
  assert.equal(get('SELECT 1 FROM paused WHERE user_id = ?', u), undefined);
  assert.equal(logs(t).length, 1, 'kept');
  backdate(10 * 60000); A.pauseTimer(u);
  A.setDone(u, o, 0, true);
  assert.equal(get('SELECT 1 FROM paused WHERE user_id = ?', u), undefined);
});
