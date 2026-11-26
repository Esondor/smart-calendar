// Token API for the Mac menu bar app: agenda with appointments and planned tasks, start, stop, done
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ext-'));
process.env.GOOGLE_CLIENT_ID = 'x'; process.env.GOOGLE_CLIENT_SECRET = 'y';
// Google Calendar, enough for moving an event's end
const gstore = new Map(), realFetch = globalThis.fetch;
globalThis.fetch = async (url, opt = {}) => {
  const u = new URL(url), m = opt.method || 'GET', json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'at', expires_in: 3600 });
  if (u.hostname !== 'www.googleapis.com') return realFetch(url, opt);
  const id = decodeURIComponent(u.pathname.split('/').pop());
  if (id === 'events') return json({ items: [...gstore.values()] });
  const e = gstore.get(id); if (m === 'PATCH') Object.assign(e, JSON.parse(opt.body));
  return json(e);
};

const Fastify = (await import('fastify')).default;
const { run, get } = await import('../server/db.js');
const { encrypt } = await import('../server/crypto.js');
const { createUser } = await import('../server/auth.js');
const { default: extRoutes, newToken } = await import('../server/ext.js');

const uid = createUser({ username: 'jdoe', name: 'S', password: 'long password 123' });
const tok = newToken(uid, 'api', 'Mac');
const acc = Number(run(`INSERT INTO accounts(user_id, kind, label, secret, status) VALUES (?, 'google', 'me', ?, 'ok')`, uid, encrypt({ refresh_token: 'r' })).lastInsertRowid);
const cal = Number(run(`INSERT INTO calendars(account_id, user_id, ext_id, name, color, use_busy, writable) VALUES (?, ?, 'me@x', 'Me', '#ff0000', 1, 1)`, acc, uid).lastInsertRowid);
const H = 3600e3, now = Date.now();
run(`INSERT INTO events(calendar_id, ext_id, start, end, title, link) VALUES (?, 'a', ?, ?, 'Standup', 'https://meet.google.com/abc-defg-hij')`, cal, now + H, now + 1.5 * H);
run(`INSERT INTO events(calendar_id, ext_id, start, end, title) VALUES (?, 'b', ?, ?, 'Yesterday')`, cal, now - 30 * H, now - 29 * H);
run(`INSERT INTO events(calendar_id, ext_id, start, end, title) VALUES (?, 'c', ?, ?, 'Next week')`, cal, now + 8 * 24 * H, now + 8 * 24 * H + H);
const pid = Number(run(`INSERT INTO projects(name, owner_id, created_at) VALUES ('Home', ?, ?)`, uid, now).lastInsertRowid);
run(`INSERT INTO project_members(project_id, user_id) VALUES (?, ?)`, pid, uid);
const tid = Number(run(`INSERT INTO tasks(project_id, title, duration, created_by, created_at, updated_at) VALUES (?, 'Laundry', 30, ?, ?, ?)`, pid, uid, now, now).lastInsertRowid);

const app = Fastify(); await app.register(extRoutes); await app.ready();
test.after(() => app.close());
const call = (method, url, t = tok) => app.inject({ method, url, headers: t ? { authorization: 'Bearer ' + t } : {}, payload: method === 'POST' ? {} : undefined });

test('agenda: needs a token, lists coming appointments with join link', async () => {
  assert.equal((await call('GET', '/api/ext/agenda', null)).statusCode, 401);
  assert.equal((await call('GET', '/api/ext/agenda', 'sc_wrong')).statusCode, 401);
  const r = await call('GET', '/api/ext/agenda'); assert.equal(r.statusCode, 200);
  const a = r.json();
  assert.deepEqual(a.events.map(e => e.title), ['Standup'], 'yesterday and next week are left out');
  assert.equal(a.events[0].join, 'https://meet.google.com/abc-defg-hij');
  assert.equal(a.events[0].color, '#ff0000');
  assert.equal(a.active, null);
});

test('start and stop a task; other people\'s tasks are not found', async () => {
  assert.equal((await call('POST', `/api/ext/tasks/${tid}/start`)).statusCode, 200);
  let a = (await call('GET', '/api/ext/agenda')).json();
  assert.equal(a.active.title, 'Laundry');
  assert.equal((await call('POST', '/api/ext/timer/stop')).statusCode, 200);
  a = (await call('GET', '/api/ext/agenda')).json();
  assert.equal(a.active, null);
  const other = createUser({ username: 'mkay', name: 'P', password: 'long password 456' });
  assert.equal((await call('POST', `/api/ext/tasks/${tid}/start`, newToken(other, 'api', 'x'))).statusCode, 404);
  assert.equal(get('SELECT 1 AS x FROM active WHERE user_id = ?', other), undefined);
});

test('Now buttons: more time, postpone, break; bad times refused', async () => {
  const post = (url, payload) => app.inject({ method: 'POST', url, headers: { authorization: 'Bearer ' + tok }, payload });
  assert.equal((await post(`/api/ext/tasks/${tid}/more`, { minutes: 30 })).statusCode, 200);
  assert.equal(get('SELECT duration FROM tasks WHERE id = ?', tid).duration, 60);
  assert.equal((await post(`/api/ext/tasks/${tid}/postpone`, { until: Date.now() - 1 })).statusCode, 400);
  assert.equal((await post(`/api/ext/tasks/${tid}/postpone`, { until: Date.now() + 3600e3 })).statusCode, 200);
  assert.equal((await post('/api/ext/break', { minutes: 15 })).statusCode, 200);
  assert.ok(get(`SELECT 1 AS x FROM appts WHERE user_id = ? AND title = 'Break'`, uid));
  assert.equal((await post(`/api/ext/tasks/${tid}/done`, {})).statusCode, 200);
  assert.equal(get('SELECT status FROM tasks WHERE id = ?', tid).status, 'done');
});

test('stream: refuses without a token, says hello and passes changes on', async () => {
  assert.equal((await call('GET', '/api/ext/stream', null)).statusCode, 401);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/ext/stream`, { headers: { authorization: 'Bearer ' + tok } });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const rd = res.body.getReader(), dec = new TextDecoder(); let got = '';
  const { notifyUsers } = await import('../server/bus.js');
  setTimeout(() => notifyUsers([uid], 'plan'), 50);
  while (!got.includes('plan')) got += dec.decode((await rd.read()).value);
  assert.match(got, /"hello"/); assert.match(got, /"plan"/);
  await rd.cancel();
});

test('appointments: start, pause, done; done moves the end to the real one, earlier or later', async () => {
  const H = 3600e3, t = Date.now(), iso = ms => new Date(ms).toISOString();
  const add = (ext, title, s, e) => { run(`INSERT INTO events(calendar_id, ext_id, start, end, title) VALUES (?, ?, ?, ?, ?)`, cal, ext, s, e, title); gstore.set(ext, { id: ext, status: 'confirmed', summary: title, start: { dateTime: iso(s) }, end: { dateTime: iso(e) } }); return get('SELECT id FROM events WHERE ext_id = ?', ext).id; };
  const s0 = Math.max(new Date().setHours(0, 0, 0, 0), t - 2 * H), over = add('over', 'Long meeting', s0, s0 + 10 * 60e3);
  const post = (url, payload = {}) => app.inject({ method: 'POST', url, headers: { authorization: 'Bearer ' + tok }, payload });
  let a = (await call('GET', '/api/ext/agenda')).json();
  assert.ok(a.events.some(e => e.title === 'Long meeting' && e.editable), 'ended today, not done yet: still listed');
  assert.equal((await post(`/api/ext/tasks/${tid}/start`)).statusCode, 200);
  assert.equal((await post(`/api/ext/events/${over}/start`)).statusCode, 200);
  a = (await call('GET', '/api/ext/agenda')).json();
  assert.equal(a.active, null, 'starting an appointment stops the task timer');
  assert.ok(a.events.find(e => e.title === 'Long meeting').since);
  assert.equal((await post(`/api/ext/events/${over}/pause`)).statusCode, 200);
  assert.equal((await call('GET', '/api/ext/agenda')).json().events.find(e => e.title === 'Long meeting').since, null);
  assert.equal((await post(`/api/ext/events/${over}/done`, { end: s0 - 1 })).statusCode, 400, 'end before the start');
  const r = (await post(`/api/ext/events/${over}/done`)).json();
  assert.equal(r.moved, true);
  assert.ok(Math.abs(Date.parse(gstore.get('over').end.dateTime) - Date.now()) < 5000, 'the end moved to now in Google');
  assert.ok(!(await call('GET', '/api/ext/agenda')).json().events.some(e => e.title === 'Long meeting'), 'done: gone from the list');
  const early = add('early', 'Short call', t - 10 * 60e3, t + H);
  assert.equal((await post(`/api/ext/events/${early}/done`)).json().moved, true);
  assert.ok(Math.abs(Date.parse(gstore.get('early').end.dateTime) - Date.now()) < 5000, 'done early: the end moves to now, the time after is free again');
  assert.equal((await post(`/api/ext/events/${early}/done`, { end: Date.now() + 3600e3 })).statusCode, 400, 'no end in the future');
  const other = add('pick', 'Review', s0, s0 + 5 * 60e3);
  await post(`/api/ext/events/${other}/done`, { end: s0 + 30 * 60e3 });
  assert.equal(Date.parse(gstore.get('pick').end.dateTime), s0 + 30 * 60e3, 'a chosen end');
});

test('start: the first start moves the appointment to now with its length; a resume does not', async () => {
  const H = 3600e3, t = Date.now(), iso = ms => new Date(ms).toISOString(), m = ms => Math.floor(ms / 60000) * 60000;
  const post = url => app.inject({ method: 'POST', url, headers: { authorization: 'Bearer ' + tok }, payload: {} });
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title) VALUES (?, 'soon', ?, ?, 'Workshop')`, cal, t + H, t + 2 * H);
  gstore.set('soon', { id: 'soon', status: 'confirmed', summary: 'Workshop', start: { dateTime: iso(t + H) }, end: { dateTime: iso(t + 2 * H) } });
  const id = get(`SELECT id FROM events WHERE ext_id = 'soon'`).id;
  const r = (await post(`/api/ext/events/${id}/start`)).json();
  assert.equal(r.moved, true);
  assert.equal(Date.parse(gstore.get('soon').start.dateTime), m(Date.now()), 'an hour early: the start is now');
  assert.equal(Date.parse(gstore.get('soon').end.dateTime), m(Date.now()) + H, 'the same length');
  const id2 = get(`SELECT id FROM events WHERE ext_id = 'soon'`).id;
  await post(`/api/ext/events/${id2}/pause`);
  assert.equal((await post(`/api/ext/events/${id2}/start`)).json().moved, false, 'resume: nothing moves');
  // read-only: the calendar keeps its time, the planner uses the real start
  const ro = Number(run(`INSERT INTO calendars(account_id, user_id, ext_id, name, use_busy, writable) VALUES (?, ?, 'ro@x', 'Exchange RO', 1, 0)`, acc, uid).lastInsertRowid);
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title) VALUES (?, 'ros', ?, ?, 'Lecture')`, ro, t + H, t + 2 * H);
  const rid = get(`SELECT id FROM events WHERE ext_id = 'ros'`).id;
  assert.equal((await post(`/api/ext/events/${rid}/start`)).json().moved, false);
  assert.equal(get('SELECT start FROM events WHERE id = ?', rid).start, t + H);
  const { calendarEvents } = await import('../server/planner.js');
  const ros = calendarEvents(uid, t - H, t + 3 * H).find(x => x.ext_id === 'ros');
  assert.equal(ros.start, m(Date.now())); assert.equal(ros.end, m(Date.now()) + H);
  await post(`/api/ext/events/${rid}/pause`); await post(`/api/ext/events/${id2}/pause`);
});

test('month range: past and done appointments included, breaks listed, bad ranges refused', async () => {
  const t0 = new Date().setHours(0, 0, 0, 0), D = 864e5;
  assert.equal((await call('GET', `/api/ext/agenda?from=${t0}&to=${t0 + 60 * D}`)).statusCode, 400, 'at most 45 days');
  const a = (await call('GET', `/api/ext/agenda?from=${t0 - 3 * D}&to=${t0 + 30 * D}`)).json();
  const titles = a.events.map(e => e.title);
  assert.ok(titles.includes('Yesterday') && titles.includes('Next week'), 'the whole range');
  assert.ok(a.events.find(e => e.title === 'Long meeting')?.done, 'done appointments stay, marked done');
  assert.ok(a.breaks.some(b => b.title === 'Break'), 'the break taken earlier');
  assert.ok(!(await call('GET', '/api/ext/agenda')).json().events.some(e => e.title === 'Yesterday'));
});

test('copies: the original lists the calendars of its copies, the copies are left out', async () => {
  const other = Number(run(`INSERT INTO calendars(account_id, user_id, ext_id, name, color, use_busy) VALUES (?, ?, 'mk@x', 'Shared', '#00ff00', 1)`, acc, uid).lastInsertRowid);
  const s0 = Date.now() + 5 * 3600e3;
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title, dup) VALUES (?, 'orig', ?, ?, 'Dinner', ?)`, cal, s0, s0 + 3600e3, `${cal}:orig`);
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title, dup) VALUES (?, 'copy', ?, ?, 'Dinner', ?)`, other, s0, s0 + 3600e3, `${cal}:orig`);
  const d = (await call('GET', '/api/ext/agenda')).json().events.filter(e => e.title === 'Dinner');
  assert.equal(d.length, 1); assert.deepEqual(d[0].alsoIn, [{ name: 'Shared', color: '#00ff00' }]);
});

test('read-only calendar: done keeps the calendar as it is, planning uses the real end', async () => {
  const ro = Number(run(`INSERT INTO calendars(account_id, user_id, ext_id, name, use_busy, writable) VALUES (?, ?, 'ex@x', 'Exchange', 1, 0)`, acc, uid).lastInsertRowid);
  const t = Date.now();
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title) VALUES (?, 'ro1', ?, ?, 'Doctor')`, ro, t - 20 * 60e3, t + 2 * 3600e3);
  const id = get(`SELECT id FROM events WHERE ext_id = 'ro1'`).id;
  const r = (await app.inject({ method: 'POST', url: `/api/ext/events/${id}/done`, headers: { authorization: 'Bearer ' + tok }, payload: {} })).json();
  assert.equal(r.moved, false);
  assert.equal(get(`SELECT end FROM events WHERE id = ?`, id).end, t + 2 * 3600e3, 'the calendar keeps its time');
  const { calendarEvents } = await import('../server/planner.js');
  const e = calendarEvents(uid, t - 3600e3, t + 3 * 3600e3).find(x => x.ext_id === 'ro1');
  assert.ok(Math.abs(e.end - Date.now()) < 5000, 'the planner sees the real end');
});

test('every calendar can be shown or left out; copies and the plan calendar take no new appointments', async () => {
  const tgt = Number(run(`INSERT INTO calendars(account_id, user_id, ext_id, name, use_busy, writable) VALUES (?, ?, 'grp@x', 'Group copy', 1, 1)`, acc, uid).lastInsertRowid);
  run('UPDATE calendars SET mirror_to = ? WHERE id = ?', tgt, cal);
  const c = (await call('GET', '/api/ext/agenda')).json().calendars.find(x => x.id === tgt);
  run('UPDATE calendars SET mirror_to = NULL WHERE id = ?', cal);
  assert.ok(c, 'listed'); assert.equal(c.writable, false);
});

test('quick add, pin and unpin, fixed to flexible', async () => {
  const post = (url, payload = {}) => app.inject({ method: 'POST', url, headers: { authorization: 'Bearer ' + tok }, payload });
  let a = (await call('GET', '/api/ext/agenda')).json();
  assert.ok(a.projects.length && a.calendars.some(c => c.writable), 'projects and writable calendars to choose from');
  assert.equal((await post('/api/ext/tasks', { title: '' })).statusCode, 400);
  const t = (await post('/api/ext/tasks', { title: 'Call the bank', minutes: 15 })).json();
  assert.equal(get('SELECT duration, assignee_id FROM tasks WHERE id = ?', t.id).duration, 15);
  const f = await post('/api/ext/flexible', { title: 'Haircut', minutes: 45, win: { days: [1, 2, 3, 4, 5, 6, 0], s: '00:00', e: '23:59' } });
  assert.equal(f.statusCode, 200);
  assert.ok(JSON.parse(get('SELECT meta FROM tasks WHERE id = ?', f.json().id).meta).win, 'flexible: planned inside its window');
  const s0 = Date.now() + 3 * 3600e3;
  assert.equal((await post(`/api/ext/tasks/${t.id}/pin`, { start: s0, end: s0 + 15 * 60e3 })).statusCode, 200);
  assert.ok(get(`SELECT 1 AS x FROM overrides WHERE task_id = ? AND kind = 'pin'`, t.id), 'pinned');
  assert.equal((await post(`/api/ext/tasks/${t.id}/unpin`)).statusCode, 200);
  assert.equal(get(`SELECT 1 AS x FROM overrides WHERE task_id = ? AND kind = 'pin'`, t.id), undefined, 'planned automatically again');
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title) VALUES (?, 'fx', ?, ?, 'Physio')`, cal, s0, s0 + 3600e3);
  const ev = get(`SELECT id FROM events WHERE ext_id = 'fx'`).id;
  const r = (await post(`/api/ext/events/${ev}/flexible`)).json();
  assert.equal(get('SELECT title FROM tasks WHERE id = ?', r.id).title, 'Physio', 'the appointment is now a flexible one');
  assert.equal((await post('/api/ext/events', { title: 'Lunch with Tom', start: s0, end: s0 - 1, calendar_id: cal })).statusCode, 400);
});
