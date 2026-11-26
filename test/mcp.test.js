// Claude connector: per-user switch, OAuth (registration, consent, PKCE, refresh), MCP tools on an outline project
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mcp-'));

const Fastify = (await import('fastify')).default;
const cookie = (await import('@fastify/cookie')).default;
const { run, get, all } = await import('../server/db.js');
const { createUser } = await import('../server/auth.js');
const { sha256 } = await import('../server/crypto.js');
const { default: oauthRoutes } = await import('../server/oauth.js');
const { default: mcpRoutes } = await import('../server/mcp.js');

const uid = createUser({ username: 'jdoe', name: 'Jo', password: 'long password 123' });
const other = createUser({ username: 'mkay', name: 'Mo', password: 'long password 456' });
const session = u => { const t = crypto.randomBytes(16).toString('hex'); run('INSERT INTO sessions(token_hash, user_id, created_at, expires_at, last_seen, mfa) VALUES (?, ?, ?, ?, ?, 1)', sha256(t), u, Date.now(), Date.now() + 864e5, Date.now()); return 'sc_session=' + t; };
const me = session(uid), them = session(other);
const now = Date.now();
const pid = Number(run(`INSERT INTO projects(name, kind, owner_id, created_at, meta) VALUES ('Thesis', 'outline', ?, ?, '{}')`, uid, now).lastInsertRowid);
run('INSERT INTO project_members(project_id, user_id) VALUES (?, ?)', pid, uid);
const add = (title, parent, meta, extra = {}) => Number(run(`INSERT INTO tasks(project_id, parent_id, title, meta, duration, auto, spent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  pid, parent, title, JSON.stringify(meta), extra.duration || 30, extra.auto ?? 0, extra.spent || 0, now, now).lastInsertRowid);
const ch1 = add('Introduction', null, { level: 'chapter', num: '1' });
const s11 = add('Motivation', ch1, { level: 'section', sid: '1.1' });
const it1 = add('Write draft', s11, { level: 'item' }, { duration: 120, auto: 1, spent: 30 });
const it2 = add('Find sources', s11, { level: 'item' }, { duration: 60, auto: 1 });

const app = Fastify(); await app.register(cookie); await app.register(oauthRoutes); await app.register(mcpRoutes); await app.ready();
test.after(() => app.close());
const CB = 'https://claude.ai/api/mcp/auth_callback';
const verifier = crypto.randomBytes(32).toString('base64url'), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const form = o => new URLSearchParams(o).toString();
let client, tokens;

async function connect(cookieHdr) {
  const q = form({ response_type: 'code', client_id: client, redirect_uri: CB, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });
  const page = await app.inject({ url: '/oauth/authorize?' + q, headers: { cookie: cookieHdr } });
  const csrf = (page.body.match(/name="csrf" value="([^"]+)"/) || [])[1];
  return { page, csrf, q };
}
async function rpc(method, params, tok = tokens?.access_token) {
  const r = await app.inject({ method: 'POST', url: '/mcp', headers: tok ? { authorization: 'Bearer ' + tok } : {}, payload: { jsonrpc: '2.0', id: 1, method, params } });
  return r;
}
const tool = async (name, args) => { const r = (await rpc('tools/call', { name, arguments: args })).json().result; return r.isError ? { error: r.content[0].text } : r.structuredContent; };

test('discovery and registration only for Claude callbacks', async () => {
  const m = (await app.inject({ url: '/.well-known/oauth-authorization-server' })).json();
  assert.match(m.token_endpoint, /\/oauth\/token$/); assert.deepEqual(m.code_challenge_methods_supported, ['S256']);
  assert.equal((await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['https://evil.example/cb'] } })).statusCode, 400);
  const r = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Claude', redirect_uris: [CB] } });
  assert.equal(r.statusCode, 201); client = r.json().client_id;
});

test('/mcp without a token asks for sign-in', async () => {
  const r = await rpc('tools/list', {}, null);
  assert.equal(r.statusCode, 401); assert.match(r.headers['www-authenticate'], /resource_metadata=/);
});

test('consent: signed out → sign-in; Claude off → refused; on → code → token', async () => {
  const out = await app.inject({ url: '/oauth/authorize?' + form({ response_type: 'code', client_id: client, redirect_uri: CB, code_challenge: challenge, code_challenge_method: 'S256' }) });
  assert.equal(out.statusCode, 302); assert.match(out.headers.location, /^\/\?next=/);
  let c = await connect(me); assert.match(c.page.body, /Claude Is Off/); assert.equal(c.csrf, undefined);
  run(`UPDATE users SET settings = json_set(settings, '$.claude', json('true')) WHERE id = ?`, uid);
  c = await connect(me); assert.ok(c.csrf);
  // a forged form (no csrf) is refused
  assert.equal((await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie: me, 'content-type': 'application/x-www-form-urlencoded' }, payload: c.q + '&answer=allow' })).statusCode, 403);
  const ok = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie: me, 'content-type': 'application/x-www-form-urlencoded' }, payload: c.q + '&answer=allow&csrf=' + c.csrf });
  assert.equal(ok.statusCode, 302);
  const back = new URL(ok.headers.location); assert.equal(back.origin + back.pathname, CB); assert.equal(back.searchParams.get('state'), 'xyz');
  const code = back.searchParams.get('code');
  const tf = p => app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: form(p) });
  assert.equal((await tf({ grant_type: 'authorization_code', code, redirect_uri: CB, client_id: client, code_verifier: 'wrong'.repeat(10) })).statusCode, 400, 'bad verifier');
  // the code is single use: the failed try above already spent it, so connect again
  c = await connect(me);
  const ok2 = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie: me, 'content-type': 'application/x-www-form-urlencoded' }, payload: c.q + '&answer=allow&csrf=' + c.csrf });
  const code2 = new URL(ok2.headers.location).searchParams.get('code');
  const t = await tf({ grant_type: 'authorization_code', code: code2, redirect_uri: CB, client_id: client, code_verifier: verifier });
  assert.equal(t.statusCode, 200); tokens = t.json(); assert.match(tokens.access_token, /^sca_/);
  const t2 = await tf({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client });
  assert.equal(t2.statusCode, 200);
  assert.equal((await tf({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client })).statusCode, 400, 'refresh tokens rotate');
  tokens = t2.json();
});

test('another user with Claude off cannot connect', async () => {
  const c = await connect(them); assert.match(c.page.body, /Claude Is Off/);
});

test('tools: initialize, list, read the outline', async () => {
  const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).json().result;
  assert.equal(init.protocolVersion, '2025-06-18'); assert.ok(init.capabilities.tools);
  const names = (await rpc('tools/list', {})).json().result.tools.map(t => t.name);
  assert.ok(names.includes('apply_changes') && names.includes('get_project'));
  const ps = await tool('list_projects', {}); assert.ok(ps.projects.some(p => p.name === 'Thesis'));
  const p = await tool('get_project', { project_id: pid });
  assert.equal(p.tree[0].title, 'Introduction'); assert.equal(p.tree[0].number, '1');
  assert.deepEqual(p.tree[0].children[0].children.map(x => x.title), ['Write draft', 'Find sources']);
  assert.equal(p.tree[0].children[0].children[0].duration_min, 120);
});

test('apply_changes: dry run changes nothing, then applies; refs; guards; undo', async () => {
  const changes = [
    { op: 'add', ref: 'c2', title: 'Method', number: '2', summary: 'How it was done' },
    { op: 'add', ref: 's21', parent: 'c2', title: 'Setup', number: '2.1' },
    { op: 'add', parent: 's21', title: 'Describe the rig', duration_min: 90, deadline: '2026-12-10' },
    { op: 'update', id: it1, duration_min: 180 },
    { op: 'move', id: it2, parent: 's21', position: 0 },
    { op: 'done', id: it1 },
  ];
  const before = all('SELECT COUNT(*) AS n FROM tasks')[0].n;
  const d = await tool('apply_changes', { project_id: pid, changes, dry_run: true });
  assert.equal(d.dry_run, true); assert.equal(d.changes.length, 6);
  assert.equal(all('SELECT COUNT(*) AS n FROM tasks')[0].n, before, 'dry run leaves the database alone');
  const r = await tool('apply_changes', { project_id: pid, changes, dry_run: false });
  assert.equal(r.applied, true);
  const p = await tool('get_project', { project_id: pid });
  const ch2 = p.tree.find(x => x.title === 'Method');
  assert.equal(ch2.level, 'chapter'); assert.equal(ch2.summary, 'How it was done');
  assert.deepEqual(ch2.children[0].children.map(x => x.title), ['Find sources', 'Describe the rig']);
  assert.equal(ch2.children[0].children[1].level, 'item'); assert.equal(ch2.children[0].children[1].duration_min, 90);
  assert.equal(get('SELECT duration, status FROM tasks WHERE id = ?', it1).status, 'done');
  // a section cannot go under a section; logged work cannot be deleted; nothing of a failed batch stays
  const bad = await tool('apply_changes', { project_id: pid, dry_run: false, changes: [{ op: 'add', title: 'Keep?', parent: ch1, level: 'item' }, { op: 'add', title: 'X', parent: s11, level: 'section' }] });
  assert.match(bad.error, /Change 2/); assert.ok(!get(`SELECT 1 FROM tasks WHERE title = 'Keep?'`));
  assert.match((await tool('apply_changes', { project_id: pid, dry_run: false, changes: [{ op: 'delete', id: ch1 }] })).error, /logged work/);
  // undo: back to before the batch, the moved item is under its old section again
  assert.equal((await tool('undo_last_changes', { project_id: pid })).undone, true);
  assert.equal(get('SELECT parent_id FROM tasks WHERE id = ?', it2).parent_id, s11);
  assert.equal(get('SELECT status, duration FROM tasks WHERE id = ?', it1).duration, 120);
  assert.ok(!get(`SELECT 1 FROM tasks WHERE title = 'Method'`));
  assert.match((await tool('undo_last_changes', { project_id: pid })).error, /Nothing to undo/);
});

test('only the token owner\'s projects; turning Claude off cuts the connection', async () => {
  const pid2 = Number(run(`INSERT INTO projects(name, owner_id, created_at) VALUES ('Private', ?, ?)`, other, now).lastInsertRowid);
  run('INSERT INTO project_members(project_id, user_id) VALUES (?, ?)', pid2, other);
  assert.match((await tool('get_project', { project_id: pid2 })).error, /not found/);
  const np = await tool('create_project', { name: 'Garden', kind: 'board' });
  assert.ok(get('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?', np.id, uid));
  run(`UPDATE users SET settings = json_remove(settings, '$.claude') WHERE id = ?`, uid);
  assert.equal((await rpc('tools/list', {})).statusCode, 401);
});

test('guide and new ids for set_order', async () => {
  run(`UPDATE users SET settings = json_set(settings, '$.claude', json('true')) WHERE id = ?`, uid);
  assert.match((await tool('get_guide', {})).guide, /writing order/);
  const r = await tool('apply_changes', { project_id: pid, dry_run: false, changes: [{ op: 'add', ref: 'c9', title: 'Outlook', number: '9' }, { op: 'add', ref: 's91', parent: 'c9', title: 'Next steps' }, { op: 'add', parent: 's91', title: 'Write it', duration_min: 60 }] });
  assert.ok(r.ids.s91 > 0);
  const p = await tool('get_project', { project_id: pid });
  const units = p.order.flatMap(ph => ph.units.map(u => u.id));
  assert.ok(units.includes(r.ids.s91));
  const o = await tool('set_order', { project_id: pid, phases: [{ name: 'First', units: [r.ids.s91] }, { name: 'Rest', units: units.filter(x => x !== r.ids.s91) }] });
  assert.equal(o.order[0].units[0].title, 'Next steps');
});

test('numbers on every level: problems are reported, renumber fixes them', async () => {
  const p0 = await tool('get_project', { project_id: pid });
  const intro = p0.tree.find(x => x.title === 'Introduction');
  // a section numbered for another chapter, an item without a number next to numbered ones
  const r = await tool('apply_changes', { project_id: pid, dry_run: false, changes: [
    { op: 'update', id: it2, number: '1.1.2' }, { op: 'update', id: it1, number: '1.1.1' },
    { op: 'add', ref: 's', parent: intro.id, title: 'Scope', number: '3.1' },
    { op: 'add', parent: 's', title: 'Limits', duration_min: 45 },
  ] });
  assert.ok(r.numbering_problems.some(x => /3\.1 “Scope”.*chapter 1/.test(x)), r.numbering_problems.join('\n'));
  const f = await tool('apply_changes', { project_id: pid, dry_run: false, changes: [{ op: 'renumber' }] });
  assert.equal(f.numbering_problems, undefined);
  const p = await tool('get_project', { project_id: pid });
  const sec = p.tree.find(x => x.id === intro.id).children.find(x => x.title === 'Scope');
  assert.equal(sec.number, '1.2'); assert.equal(sec.children[0].number, '1.2.1');
  assert.equal(p.tree.find(x => x.id === intro.id).children[0].children[0].number, '1.1.1', 'item numbers are shown');
});

test('planning notes and the order back to the outline', async () => {
  await tool('update_project', { project_id: pid, planning_notes: 'revise 900 words/h' });
  assert.equal((await tool('get_project', { project_id: pid })).project.planning_notes, 'revise 900 words/h');
  const o = await tool('set_order', { project_id: pid, follow_outline: true });
  assert.match(o.order[0].phase, /^1 /);
  assert.equal(o.order[0].units[0].title, 'Motivation');
});
