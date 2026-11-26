import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-vk-'));
const tasks = new Map([
  [1, { id: 1, title: 'Order nozzles', description: '<p>est: 45m</p>', done: false, project_id: 7, priority: 4, due_date: '2026-12-01T12:00:00Z', start_date: '0001-01-01T00:00:00Z', assignees: [{ id: 42 }], labels: [], updated: 'u1' }],
  [2, { id: 2, title: 'Someone else', description: '', done: false, project_id: 7, priority: 1, due_date: '0001-01-01T00:00:00Z', start_date: '0001-01-01T00:00:00Z', assignees: [{ id: 9 }], labels: [], updated: 'u1' }],
  [3, { id: 3, title: 'Calibrate stage', description: '', done: false, project_id: 7, priority: 2, due_date: '0001-01-01T00:00:00Z', start_date: '0001-01-01T00:00:00Z', assignees: [{ id: 42 }], labels: [{ title: '2h' }], updated: 'u1' }],
]);
const hooks = [], authCalls = [], moves = [];
globalThis.fetch = async (url, opt = {}) => {
  const u = new URL(url), p = u.pathname.replace('/api/v1', ''), m = opt.method || 'GET';
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
  // Vikunja behind Authelia: firstfactor sets the session cookie, the API answers only with it
  if (u.host === 'auth.gate.test' && p === '/api/firstfactor') { const b = JSON.parse(opt.body); authCalls.push(b.username);
    return b.password === 'right' ? new Response(JSON.stringify({ status: 'OK', data: { redirect: b.targetURL } }), { status: 200, headers: { 'set-cookie': 'authelia_session=abc; Path=/; Domain=gate.test; HttpOnly' } })
      : new Response(JSON.stringify({ status: 'KO', message: 'Authentication failed.' }), { status: 401 }); }
  if (u.host === 'vk.gate.test' && opt.headers?.cookie !== 'authelia_session=abc') return new Response('<a href="https://auth.gate.test/?rd=https%3A%2F%2Fvk.gate.test%2Fapi%2Fv1%2Fuser&amp;rm=GET">401 Unauthorized</a>', { status: 401 });
  if (u.host === 'guarded.test') return new Response('<a href="https://auth.guarded.test/">401 Unauthorized</a>', { status: 401 });
  if (p === '/user') return opt.headers?.authorization === 'Bearer tk_api' ? json({ message: 'missing, malformed, expired or otherwise invalid token provided' }, 401) : json({ id: 42, username: 'jdoe' });
  if (p === '/projects' && opt.headers?.authorization !== 'Bearer tk_api') return json([{ id: 7, title: 'Lab' }]);
  if (p === '/projects') return json([{ id: 7, title: 'Lab', owner: { id: 42, username: 'jdoe' } }, { id: 8, title: 'Shared', owner: { id: 9, username: 'x' } }, { id: 5, title: 'Inbox', owner: { id: 42, username: 'jdoe' } }]);
  if (u.host === 'new.test' && p === '/user') return json({ id: 42, username: 'jdoe' });
  if (u.host === 'new.test' && p === '/projects') return json([{ id: 7, title: 'Lab' }]);
  if (u.host === 'new.test' && p === '/tasks/all') return json({ message: 'Invalid model provided.' }, 400);
  if (u.host === 'new.test' && p === '/tasks') { const pg = +u.searchParams.get('page'), open = [...tasks.values()].filter(t => !t.done); return json(open.slice((pg - 1) * 2, pg * 2)); }   // at most 2 per page
  if (p === '/tasks/all') return json(u.searchParams.get('page') === '1' ? [...tasks.values()].filter(t => !t.done) : []);
  if (p === '/projects/7/views') return json([{ id: 70, view_kind: 'list' }, { id: 71, view_kind: 'kanban', done_bucket_id: 713 }]);
  if (p === '/projects/7/views/71/tasks') return json([{ id: 710, title: 'Dokumente & Infos', tasks: [{ id: 20, title: 'Datenblätter', attachments: [{ id: 5, created: '2026-11-01T10:00:00Z', file: { name: 'Nozzle.pdf', mime: 'application/pdf', size: 2048 } }] }] },
    { id: 711, title: 'To-Do', tasks: [...tasks.values()].filter(t => !t.done && t.project_id === 7) }]);
  if (p === '/tasks/20/attachments/5') return new Response('%PDF-1.4 test', { status: 200, headers: { 'content-type': 'application/pdf' } });
  if (p === '/projects/7/views/71/buckets') return json([{ id: 711, title: 'To-Do' }, { id: 712, title: 'In Progress' }, { id: 713, title: 'Fertig' }]);
  const bm = p.match(/^\/projects\/7\/views\/71\/buckets\/(\d+)\/tasks$/);
  if (bm && m === 'POST') { moves.push([JSON.parse(opt.body).task_id, +bm[1]]); return json({}); }
  const wh = p.match(/^\/projects\/(\d+)\/webhooks$/);
  if (wh && m === 'GET') return json(hooks.filter(h => h.project === +wh[1]));
  if (wh && m === 'PUT') { const b = JSON.parse(opt.body); hooks.push({ ...b, project: +wh[1], id: hooks.length + 1 }); return json(b); }
  const mm = p.match(/^\/tasks\/(\d+)$/);
  if (mm) { const t = tasks.get(+mm[1]); if (!t) return json({ message: 'nope' }, 404); if (m === 'POST') { Object.assign(t, JSON.parse(opt.body), { updated: 'u' + Date.now() }); } return json(t); }
  return json({}, 404);
};
const { run, get, all } = await import('../server/db.js');
const { encrypt } = await import('../server/crypto.js');
const { createUser } = await import('../server/auth.js');
const { syncVikunja, pushDone, durationOf, vikunjaUser, moveToBucket, docFiles, attachment, forgetFiles } = await import('../server/sync/vikunja.js');
const { setDone } = await import('../server/actions.js');

const uid = createUser({ username: 'vk', name: 'V', password: 'long password 123' });
const accId = Number(run(`INSERT INTO accounts(user_id, kind, label, secret) VALUES (?, 'vikunja', 'Team', ?)`, uid, encrypt({ url: 'https://vk.test', token: 't' })).lastInsertRowid);
const acc = () => get('SELECT * FROM accounts WHERE id = ?', accId);
const local = id => get(`SELECT * FROM tasks WHERE ext_source = 'vikunja' AND ext_id = ?`, String(id));

test('an API token (no access to /user): you are the owner of most of your projects', async () => {
  assert.deepEqual(await vikunjaUser({ secret: encrypt({ url: 'https://vk.test', token: 'tk_api' }) }), { id: 42, username: 'jdoe' });
});

test('a sign-in page in front of Vikunja is named as the problem, not the token', async () => {
  await assert.rejects(vikunjaUser({ secret: encrypt({ url: 'https://guarded.test', token: 'tk_x' }) }), e => e.status === 502 && /sign-in page/.test(e.message));
});

test('behind Authelia: signs in with your sign-in there, keeps the session, waits after a wrong password', async () => {
  const ok = { secret: encrypt({ url: 'https://vk.gate.test', token: 'tk_x', login: { user: 'jd', pass: 'right' } }) };
  assert.equal((await vikunjaUser(ok)).id, 42);
  await vikunjaUser(ok); assert.equal(authCalls.length, 1, 'the session is reused');
  const bad = { secret: encrypt({ url: 'https://vk.gate.test', token: 'tk_x', login: { user: 'jd', pass: 'wrong' } }) };
  await assert.rejects(vikunjaUser(bad), e => /not accepted/.test(e.message));
  await assert.rejects(vikunjaUser(bad), e => /not accepted/.test(e.message));
  assert.equal(authCalls.length, 2, 'no second try with a wrong password right away');
});

test('newer Vikunja: tasks from /tasks, also when it gives fewer per page than asked', async () => {
  const id = Number(run(`INSERT INTO accounts(user_id, kind, label, secret) VALUES (?, 'vikunja', 'New', ?)`, uid, encrypt({ url: 'https://new.test', token: 't' })).lastInsertRowid);
  await syncVikunja(get('SELECT * FROM accounts WHERE id = ?', id));
  const n = get(`SELECT COUNT(*) AS n FROM tasks WHERE ext_source = 'vikunja' AND ext_account = ?`, id).n;
  run('DELETE FROM tasks WHERE ext_account = ?', id); run('DELETE FROM accounts WHERE id = ?', id);
  assert.equal(n, 2, 'both of my open tasks, over two pages');
});

test('duration parsing', () => {
  assert.equal(durationOf({ labels: [{ title: '1.5h' }] }, 60), 90);
  assert.equal(durationOf({ description: 'Dauer: 20 min' }, 60), 20);
  assert.equal(durationOf({}, 60), 60);
});
test('imports my open tasks only, with priority, deadline, duration', async () => {
  await syncVikunja(acc());
  assert.ok(local(1)); assert.ok(!local(2)); assert.ok(local(3));
  assert.equal(local(1).priority, 0); assert.equal(local(1).duration, 45); assert.equal(local(1).deadline, '2026-12-01');
  assert.equal(local(3).duration, 120);
  assert.match(get('SELECT name FROM projects WHERE id = ?', local(1).project_id).name, /Team · Lab/);
});
test('done here is written back to Vikunja', async () => {
  setDone(uid, local(1).id, 0, true);
  await pushDone({ ...local(1) }, true);
  assert.equal(tasks.get(1).done, true);
  assert.equal(tasks.get(1).title, 'Order nozzles', 'full task preserved on write-back');
});
test('done in Vikunja closes it here', async () => {
  tasks.get(3).done = true; tasks.get(3).done_at = new Date().toISOString();
  await syncVikunja(acc());
  assert.equal(local(3).status, 'done');
});
test.after(() => setTimeout(() => process.exit(0), 50));

test('webhooks: added once per project with the public address; only signed calls count', async () => {
  const { setServerConf } = await import('../server/serverconf.js');
  const { hookValid } = await import('../server/sync/vikunja.js');
  const { createHmac } = await import('node:crypto');
  await syncVikunja(acc()); assert.equal(hooks.length, 0, 'no public https address → no webhooks');
  setServerConf({ baseUrl: 'https://plan.example.de' });
  await syncVikunja(acc());
  assert.equal(hooks.length, 1); assert.equal(hooks[0].target_url, `https://plan.example.de/api/vikunja/push/${accId}`);
  assert.ok(hooks[0].events.includes('task.updated') && hooks[0].secret.length >= 32);
  assert.equal(JSON.parse(acc().state).hooks.ok, true);
  run('UPDATE accounts SET state = json_set(state, \'$.hooks.at\', 0) WHERE id = ?', accId);   // checked again later: not added twice
  await syncVikunja(acc()); assert.equal(hooks.length, 1);
  const body = Buffer.from(JSON.stringify({ event_name: 'task.updated', data: { task: { id: 1 } } }));
  const sig = createHmac('sha256', hooks[0].secret).update(body).digest('hex');
  assert.equal(hookValid(acc(), body, sig), true);
  assert.equal(hookValid(acc(), body, createHmac('sha256', hooks[0].secret).update(body).digest('base64')), true);
  assert.equal(hookValid(acc(), Buffer.from('{"x":1}'), sig), false, 'changed body');
  assert.equal(hookValid(acc(), body, ''), false);
  setServerConf({ baseUrl: '' });
});

test('assigned to the user named in Settings, not to whoever the token seemed to be', async () => {
  tasks.set(10, { id: 10, title: 'Write report', description: '', done: false, project_id: 7, priority: 2, due_date: '0001-01-01T00:00:00Z', start_date: '0001-01-01T00:00:00Z', assignees: [{ id: 42, username: 'jdoe' }], labels: [], updated: 'u1' });
  await syncVikunja(acc()); assert.ok(local(10));
  const st = JSON.parse(acc().state || '{}'); st.cfg = { ...(st.cfg || {}), onlyAssigned: true, user: 'alex' }; run('UPDATE accounts SET state = ? WHERE id = ?', JSON.stringify(st), accId);
  tasks.set(9, { id: 9, title: 'Alex\'s task', description: '', done: false, project_id: 7, priority: 2, due_date: '0001-01-01T00:00:00Z', start_date: '0001-01-01T00:00:00Z', assignees: [{ id: 5, username: 'Alex' }], labels: [], updated: 'u1' });
  await syncVikunja(acc());
  assert.ok(local(9), 'mine by name'); assert.ok(!local(10), 'not mine any more: removed here');
  st.cfg.user = ''; run('UPDATE accounts SET state = ? WHERE id = ?', JSON.stringify(st), accId); tasks.delete(9);
  await syncVikunja(acc()); assert.ok(local(10)); assert.ok(!local(9));
});

test('Kanban: Start → In Progress, Done → the done bucket', async () => {
  const t = local(10);
  assert.equal(await moveToBucket(t, 'progress'), true); assert.deepEqual(moves.at(-1), [10, 712]);
  assert.equal(await moveToBucket(t, 'done'), true); assert.deepEqual(moves.at(-1), [10, 713]);
});

test('planning off: not planned; while it runs, the session is a block', async () => {
  const { planUser } = await import('../server/planner.js');
  const { startTimer, stopTimer } = await import('../server/actions.js');
  const st = JSON.parse(acc().state || '{}'); st.cfg = { ...(st.cfg || {}), plan: false }; run('UPDATE accounts SET state = ? WHERE id = ?', JSON.stringify(st), accId);
  let p = planUser(uid);
  assert.ok(!p.blocks.some(b => b.key === String(local(10).id) || b.key.startsWith(local(10).id + '')), 'not planned');
  startTimer(uid, local(10).id, 0);
  p = planUser(uid);
  const b = p.blocks.find(b => b.key.split('@')[0] === String(local(10).id));
  assert.ok(b && b.s <= Date.now() && b.e > Date.now(), 'the running session is a block');
  stopTimer(uid);
  assert.ok(!planUser(uid).blocks.some(b => b.key.split('@')[0] === String(local(10).id)), 'paused: gone from the plan (kept in the calendar as history)');
  st.cfg.plan = true; run('UPDATE accounts SET state = ? WHERE id = ?', JSON.stringify(st), accId);
});

test('a project switched off (Sync) is gone here with its tasks; Plan off for one project only', async () => {
  const { planUser } = await import('../server/planner.js');
  tasks.set(11, { id: 11, title: 'Calibrate laser', description: '', done: false, project_id: 7, priority: 2, due_date: '0001-01-01T00:00:00Z', start_date: '0001-01-01T00:00:00Z', assignees: [{ id: 42, username: 'jdoe' }], labels: [], updated: 'u1' });
  await syncVikunja(acc());
  assert.ok(local(11)); assert.ok(JSON.parse(acc().state).vprojects.some(p => p.id === 7), 'the projects to choose from');
  const st = JSON.parse(acc().state); st.cfg.noPlan = [7]; run('UPDATE accounts SET state = ? WHERE id = ?', JSON.stringify(st), accId);
  assert.ok(!planUser(uid).blocks.some(b => b.key.split('@')[0] === String(local(11).id)), 'Plan off: not planned');
  st.cfg.noPlan = []; st.cfg.skip = [7]; run('UPDATE accounts SET state = ? WHERE id = ?', JSON.stringify(st), accId);
  await syncVikunja(acc());
  assert.ok(!local(11), 'its tasks are gone');
  assert.ok(!get(`SELECT 1 FROM projects WHERE ext_source = 'vikunja' AND ext_account = ? AND ext_id = '7'`, accId), 'the project is gone');
  st.cfg.skip = []; run('UPDATE accounts SET state = ? WHERE id = ?', JSON.stringify(st), accId);
  await syncVikunja(acc()); assert.ok(local(11), 'back when switched on'); tasks.delete(11);
});

test('files: the documents bucket\'s tasks are folders; their attachments are listed and fetched, and they are not tasks', async () => {
  tasks.set(20, { id: 20, title: 'Datenblätter', description: '', done: false, project_id: 7, priority: 2, due_date: '0001-01-01T00:00:00Z', start_date: '0001-01-01T00:00:00Z', assignees: [{ id: 42, username: 'jdoe' }], labels: [], updated: 'u1' });
  forgetFiles(accId);
  await syncVikunja(acc());
  assert.ok(!local(20), 'a folder is not a task');
  const f = await docFiles(acc());
  assert.deepEqual(f.list.map(p => [p.title, p.folders.map(x => [x.title, x.files.map(y => y.name)])]), [['Lab', [['Datenblätter', ['Nozzle.pdf']]]]]);
  const r = await attachment(acc(), 20, 5);
  assert.equal(await r.text(), '%PDF-1.4 test');
  // through the app: only your own folders' files; a PDF is shown inline, framed only by the app itself
  const Fastify = (await import('fastify')).default, { default: apiRoutes } = await import('../server/api.js');
  const app = Fastify(); app.addHook('onRequest', async req => { req.user = get('SELECT * FROM users WHERE id = ?', uid); }); await app.register(apiRoutes); await app.ready();
  const lab = get(`SELECT id FROM projects WHERE ext_source = 'vikunja' AND ext_id = '7' AND ext_account = ?`, accId).id;
  const list = (await app.inject({ url: '/api/files?project=' + lab })).json();
  assert.equal(list[0].projects[0].folders[0].files[0].name, 'Nozzle.pdf');
  const res = await app.inject({ url: `/api/files/${accId}/20/5?p=7` });
  assert.equal(res.statusCode, 200); assert.equal(res.body, '%PDF-1.4 test');
  assert.equal(res.headers['content-type'], 'application/pdf'); assert.match(res.headers['content-disposition'], /^inline/);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.equal((await app.inject({ url: `/api/files/${accId}/20/999?p=7` })).statusCode, 404, 'not one of the files shown');
  assert.match((await app.inject({ url: `/api/files/${accId}/20/5?p=7&download=1` })).headers['content-disposition'], /^attachment/);
  await app.close();
  tasks.delete(20);
});
