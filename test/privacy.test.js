// Privacy between users: your calendar is yours; others' plans only for a shared project's tasks; only people you know are listed
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-priv-'));

const Fastify = (await import('fastify')).default;
const { run, get } = await import('../server/db.js');
const { createUser } = await import('../server/auth.js');
const { default: apiRoutes } = await import('../server/api.js');

const a = createUser({ username: 'anna', name: 'Anna', password: 'long password 123' });
const b = createUser({ username: 'ben', name: 'Ben', password: 'long password 123' });
const c = createUser({ username: 'cleo', name: 'Cleo', password: 'long password 123' });
const now = Date.now();
const proj = (name, ...us) => { const id = Number(run(`INSERT INTO projects(name, owner_id, created_at) VALUES (?, ?, ?)`, name, us[0], now).lastInsertRowid); us.forEach(u => run('INSERT INTO project_members(project_id, user_id) VALUES (?, ?)', id, u)); return id; };
const shared = proj('Home', a, b), bens = proj('Ben private', b);
const task = (pid, title, who) => Number(run(`INSERT INTO tasks(project_id, title, duration, auto, created_by, assignee_id, created_at, updated_at) VALUES (?, ?, 60, 1, ?, ?, ?, ?)`, pid, title, who, who, now, now).lastInsertRowid);
task(shared, 'Paint the hall', b); task(bens, 'Secret thing', b);

const app = Fastify();
app.addHook('onRequest', async req => { req.user = get('SELECT * FROM users WHERE id = ?', +req.headers['x-u']); });
await app.register(apiRoutes); await app.ready();
test.after(() => app.close());
const as = (u, method, url, payload) => app.inject({ method, url, headers: { 'x-u': String(u), 'x-sc': '1' }, payload }).then(r => ({ code: r.statusCode, j: r.json() }));

test('the calendar is always your own, whatever user is asked for', async () => {
  const r = await as(a, 'GET', `/api/plan?user=${b}`);
  assert.equal(r.j.user, a);
  assert.ok(!Object.values(r.j.units).some(u => /Paint|Secret/.test(u.title)), 'nothing of Ben\'s plan');
});

test('a shared project shows when the others work on its tasks, nothing else', async () => {
  const r = await as(a, 'GET', `/api/projects/${shared}/team`);
  assert.ok(r.j.blocks.length > 0);
  assert.ok(r.j.blocks.every(x => x.user === b && x.title === 'Paint the hall'));
  assert.equal((await as(a, 'GET', `/api/projects/${bens}/team`)).code, 404);
});

test('only people you know are listed and can be picked; others by exact username', async () => {
  const boot = await as(a, 'GET', '/api/bootstrap'); assert.ok(boot.j.users, JSON.stringify(boot.j).slice(0, 300));
  assert.deepEqual(boot.j.users.map(u => u.id).sort(), [a, b].sort());
  assert.equal((await as(a, 'POST', `/api/projects/${shared}/members`, { user_id: c })).code, 404);
  const r = await as(a, 'POST', `/api/projects/${shared}/members`, { username: 'cleo' });
  assert.equal(r.code, 200); assert.ok(r.j.some(m => m.id === c));
});
