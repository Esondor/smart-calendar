// Booking: free times from your plan (never over appointments or breaks, never showing them), a public link for guests,
// a time for several members of a project, and the notification center that holds what needs an answer
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-book-'));

const Fastify = (await import('fastify')).default;
const { run, get, all } = await import('../server/db.js');
const { createUser } = await import('../server/auth.js');
const { settingsOf, saveSettings } = await import('../server/models.js');
const { findSlots, checkTime, saveLink } = await import('../server/booking.js');
const A = await import('../server/actions.js');
const { default: bookingRoutes } = await import('../server/booking-routes.js');

const mkUser = (name, from, to) => { const u = createUser({ username: name, name: name[0].toUpperCase() + name.slice(1), password: 'long password 123' });
  const s = settingsOf(u), h = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, [from, to]])); s.hours = { work: h, personal: h }; s.fixed = []; saveSettings(u, s); return u; };
const me = mkUser('mara', '09:00', '17:00'), bo = mkUser('bo', '13:00', '20:00');
const now = Date.now(), D = 864e5, day = new Date(now + 2 * D).toLocaleDateString('sv'), at = h => new Date(`${day}T${h}`).getTime();
A.addAppt(me, at('10:00'), at('11:00'), 'Dentist', 'appt');

const app = Fastify();
app.addHook('onRequest', async req => { if (req.headers['x-u']) req.user = get('SELECT * FROM users WHERE id = ?', +req.headers['x-u']); });
await app.register(bookingRoutes); await app.ready();
test.after(() => app.close());
const call = (u, method, url, payload) => app.inject({ method, url, headers: { ...(u ? { 'x-u': String(u) } : {}), 'x-sc': '1' }, payload }).then(r => ({ code: r.statusCode, j: r.json() }));

test('suggested times: in your hours, never over an appointment, best fits first', () => {
  const S = findSlots([me], { minutes: 60, days: 4, hours: 'work', notice: 0, perDay: 10, max: 100 }).filter(x => new Date(x.s).toLocaleDateString('sv') === day);
  assert.ok(S.length > 0);
  assert.ok(S.every(x => x.s >= at('09:00') && x.e <= at('17:00')), 'in the hours');
  assert.ok(!S.some(x => x.s < at('11:00') && x.e > at('10:00')), 'not over the dentist');
  assert.equal(checkTime(me, at('10:30'), at('11:30'), 'work').ok, false);
  assert.deepEqual(Object.keys(S[0]).sort(), ['e', 'fit', 's'], 'only times, nothing of the calendar');
});

test('a guest: a suggested time is booked at once; their own time outside your hours waits for you', async () => {
  const id = saveLink(me, { title: 'Call', minutes: [30, 60], days: 7, hours: 'work', notice: 0 });
  const tok = get('SELECT token FROM booking_links WHERE id = ?', id).token;
  const info = await call(null, 'GET', `/api/book/${tok}`);
  assert.equal(info.j.title, 'Call'); assert.equal(info.j.with, 'Mara'); assert.ok(!('user_id' in info.j));
  const slots = (await call(null, 'GET', `/api/book/${tok}/slots?minutes=30`)).j;
  const s = slots.find(x => new Date(x.s).toLocaleDateString('sv') === day);
  const r = await call(null, 'POST', `/api/book/${tok}`, { name: 'Guest One', email: 'guest@example.com', start: s.s, minutes: 30 });
  assert.equal(r.j.status, 'confirmed');
  assert.ok(get(`SELECT 1 FROM appts WHERE user_id = ? AND start = ? AND title = 'Call: Guest One'`, me, s.s), 'in your calendar');
  assert.equal((await call(null, 'POST', `/api/book/${tok}`, { name: 'Two', start: s.s, minutes: 30 })).code, 409, 'that time is taken now');
  // their own time at 18:00 (after your hours): a request in the notification center
  const own = await call(null, 'POST', `/api/book/${tok}`, { name: 'Late Guest', start: at('18:00'), minutes: 30, own: true });
  assert.equal(own.j.status, 'pending');
  const inbox = (await call(me, 'GET', '/api/inbox')).j;
  const req = inbox.items.find(x => x.kind === 'booking'); assert.ok(req && /Late Guest/.test(req.title));
  await call(me, 'POST', `/api/inbox/${req.id}`, { yes: true });
  assert.ok(get(`SELECT 1 FROM appts WHERE user_id = ? AND start = ?`, me, at('18:00')), 'accepted: booked');
  assert.equal((await call(null, 'GET', `/api/book/nope`)).code, 404);
});

test('a project: a time when all chosen members are free, booked for each; one declines', async () => {
  const pid = Number(run(`INSERT INTO projects(name, owner_id, created_at) VALUES ('Band', ?, ?)`, me, now).lastInsertRowid);
  [me, bo].forEach(u => run('INSERT INTO project_members(project_id, user_id) VALUES (?, ?)', pid, u));
  const S = (await call(me, 'POST', `/api/projects/${pid}/slots`, { members: [bo], minutes: 60, days: 4, hours: 'all' })).j;
  const onDay = S.filter(x => new Date(x.s).toLocaleDateString('sv') === day);
  assert.ok(onDay.length && onDay.every(x => x.s >= at('13:00') && x.e <= at('17:00')), 'only when both have hours');
  const t = onDay[0];
  assert.equal((await call(me, 'POST', `/api/projects/${pid}/book`, { title: 'Rehearsal', members: [bo], start: t.s, end: t.e })).j.ok, true);
  assert.ok(get(`SELECT 1 FROM appts WHERE user_id = ? AND start = ? AND title = 'Rehearsal'`, me, t.s));
  const hold = (await call(bo, 'GET', '/api/inbox')).j.items.find(x => x.kind === 'hold'); assert.ok(hold);
  await call(bo, 'POST', `/api/inbox/${hold.id}`, { yes: false });
  assert.ok(!get(`SELECT 1 FROM appts WHERE user_id = ? AND start = ? AND title = 'Rehearsal'`, bo, t.s), 'declined: gone for Bo');
  assert.ok((await call(me, 'GET', '/api/inbox')).j.items.some(x => /can't make/.test(x.title)), 'the organizer is told');
  assert.equal((await call(bo, 'POST', `/api/projects/999/slots`, {})).code, 404);
});

test('Clear All: what needs no answer goes, requests to answer stay', async () => {
  const { addInbox } = await import('../server/booking.js');
  addInbox(me, 'info', 'Something'); addInbox(me, 'booking', 'Asks', '', { booking: 0 });
  const r = (await call(me, 'POST', '/api/inbox/clear')).j;
  assert.ok(r.items.every(x => x.kind === 'booking' || x.kind === 'hold'));
  assert.ok(r.items.some(x => x.title === 'Asks'));
});
