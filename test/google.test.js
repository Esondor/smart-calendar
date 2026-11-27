// Integration test of the Google plan-calendar round trip against an in-memory fake of the Calendar API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
process.env.GOOGLE_CLIENT_ID = 'x'; process.env.GOOGLE_CLIENT_SECRET = 'y';

// ---- fake Google Calendar ----
const store = new Map(); let nextId = 1; const watches = [], stopped = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opt = {}) => {
  const u = new URL(url), m = opt.method || 'GET', json = (o, s = 200) => new Response(s === 204 ? null : JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'at', expires_in: 3600 });
  const p = u.pathname.replace('/calendar/v3', '');
  if (p === '/users/me/calendarList') return json({ items: [{ id: 'plan@x', summary: 'Plan', accessRole: 'owner' }, { id: 'work@x', summary: 'Work', accessRole: 'owner' }] });
  if (p === '/channels/stop') { stopped.push(JSON.parse(opt.body).id); return json(null, 204); }
  if (/\/events\/watch$/.test(p)) { const b = JSON.parse(opt.body); watches.push(b); return json({ id: b.id, resourceId: 'res-' + b.id, expiration: String(Date.now() + 7 * 864e5) }); }
  let mm = p.match(/^\/calendars\/([^/]+)\/events$/);
  if (mm && m === 'GET') {
    const a = Date.parse(u.searchParams.get('timeMin')), b = Date.parse(u.searchParams.get('timeMax'));
    const cal = decodeURIComponent(mm[1]);
    return json({ items: [...store.values()].filter(e => (e.cal || 'plan@x') === cal && Date.parse(e.end.dateTime) > a && Date.parse(e.start.dateTime) < b) });
  }
  if (mm && m === 'POST') { const e = { ...JSON.parse(opt.body), id: 'e' + nextId++, status: 'confirmed', cal: decodeURIComponent(mm[1]) }; store.set(e.id, e); return json(e); }
  mm = p.match(/^\/calendars\/([^/]+)\/events\/([^/]+)\/move$/);
  if (mm && m === 'POST') { const e = store.get(decodeURIComponent(mm[2])); if (!e) return json({}, 404); e.cal = u.searchParams.get('destination'); return json(e); }
  mm = p.match(/^\/calendars\/([^/]+)\/events\/([^/]+)$/);
  if (mm) {
    const id = decodeURIComponent(mm[2]), e = store.get(id);
    if (!e) return json({ error: { message: 'not found' } }, 404);
    if (m === 'GET') return json(e);
    if (m === 'DELETE') { store.delete(id); return json(null, 204); }
    if (m === 'PATCH') { Object.assign(e, JSON.parse(opt.body)); return json(e); }
  }
  return realFetch(url, opt);
};

const { run, get, all } = await import('../server/db.js');
const { encrypt } = await import('../server/crypto.js');
const { createUser } = await import('../server/auth.js');
const { settingsOf, saveSettings } = await import('../server/models.js');
const { planUser, getPlan } = await import('../server/planner.js');
const google = await import('../server/sync/google.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = createUser({ username: 'tester', name: 'T', password: 'long password 123' });
const pid = get('SELECT id FROM projects WHERE owner_id = ?', uid).id;
// working hours: every day 00:00–24:00 so the test is independent of the clock
const s = settingsOf(uid); const all24 = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, ['00:00', '24:00']]));
s.hours = { work: all24, personal: all24 }; s.fixed = []; s.plan.days = 3; s.plan.logOn = false;
const accId = Number(run(`INSERT INTO accounts(user_id, kind, label, secret) VALUES (?, 'google', 'me@x', ?)`, uid, encrypt({ refresh_token: 'r' })).lastInsertRowid);
const acc = get('SELECT * FROM accounts WHERE id = ?', accId);
await google.syncCalendarList(acc);
const cal = get(`SELECT * FROM calendars WHERE account_id = ? AND ext_id = 'plan@x'`, accId);
run('UPDATE calendars SET is_plan = 1 WHERE id = ?', cal.id);
s.plan.calendarId = cal.id; saveSettings(uid, s);
const now = Date.now();
const tid = Number(run(`INSERT INTO tasks(project_id, title, duration, created_by, assignee_id, created_at, updated_at, start_after) VALUES (?, 'Write chapter', 60, ?, ?, ?, ?, ?)`,
  pid, uid, uid, now, now, new Date(now + 864e5).toISOString().slice(0, 10)).lastInsertRowid);   // tomorrow, so nothing is "running"
const calNow = () => get('SELECT * FROM calendars WHERE id = ?', cal.id);
const syncPlanCal = () => google.syncEvents(acc, calNow(), now - 864e5, now + 10 * 864e5);

test('plan blocks are written to the plan calendar', async () => {
  const st = await google.pushPlan(uid, () => planUser(uid));
  assert.equal(st.err, ''); assert.equal(st.nc, 1);
  const ev = [...store.values()][0];
  assert.equal(ev.summary, 'Write chapter');
  assert.equal(ev.extendedProperties.private.sc, '1');
  assert.equal(ev.transparency, 'transparent');
  // a second push with an unchanged plan writes nothing
  const st2 = await google.pushPlan(uid, () => planUser(uid));
  assert.equal(st2.nc + st2.np + st2.nd, 0);
  // renamed, same time: the block is rewritten in place; then nothing again
  const tid = get(`SELECT id FROM tasks WHERE title = 'Write chapter'`).id;
  run(`UPDATE tasks SET title = 'Write chapter two' WHERE id = ?`, tid);
  const st3 = await google.pushPlan(uid, () => planUser(uid));
  assert.equal(st3.np, 1); assert.equal(st3.nc + st3.nd, 0); assert.equal(ev.summary, 'Write chapter two');
  assert.equal((await google.pushPlan(uid, () => planUser(uid))).np, 0);
  run(`UPDATE tasks SET title = 'Write chapter' WHERE id = ?`, tid); await google.pushPlan(uid, () => planUser(uid));
  // our own event never counts as busy time
  await syncPlanCal();
  assert.equal(get('SELECT ours FROM events WHERE ext_id = ?', ev.id).ours, 1);
});

test('the plan is computed again only when time reaches a point where it can change', async () => {
  await new Promise(r => setTimeout(r, 500));   // re-plans still queued from before
  const t0 = Date.now(), p = planUser(uid, t0), b = p.blocks[0];
  assert.ok(p.next > t0 && p.next <= t0 + 30 * 60000, 'within half an hour');
  assert.ok(p.next <= (b.s > t0 ? b.s : b.e), 'no later than the next block starts or ends');
  const q = getPlan(uid); assert.equal(getPlan(uid), q, 'cached until then'); assert.equal(q.sig, p.sig);
  assert.equal(planUser(uid, t0 + 1000).sig, p.sig, 'same data a second later: same plan');
});

test('moving the event in the calendar pins the task there', async () => {
  const ev = [...store.values()][0], s0 = Date.parse(ev.start.dateTime);
  const ns = s0 + 3 * 3600e3;
  ev.start = { dateTime: new Date(ns).toISOString() }; ev.end = { dateTime: new Date(ns + 3600e3).toISOString() };
  await syncPlanCal(); await sleep(500);
  const pin = get(`SELECT * FROM overrides WHERE task_id = ? AND kind = 'pin'`, tid);
  assert.ok(pin); assert.equal(pin.start, ns);
  const plan = planUser(uid);
  assert.equal(plan.blocks.find(b => b.key === String(tid)).s, ns);
  const st = await google.pushPlan(uid, () => getPlan(uid));
  assert.equal(st.nc + st.nd, 0, 'moved event is kept, not recreated');
  assert.equal(store.size, 1);
});

test('renaming the event to "✓ …" marks the task done', async () => {
  const ev = [...store.values()][0];
  ev.summary = '✓ ' + ev.summary;
  await syncPlanCal(); await sleep(500);
  assert.equal(get('SELECT status FROM tasks WHERE id = ?', tid).status, 'done');
});

test('deleting the event postpones the task', async () => {
  const t2 = Number(run(`INSERT INTO tasks(project_id, title, duration, created_by, assignee_id, created_at, updated_at, start_after) VALUES (?, 'Clean bathroom', 30, ?, ?, ?, ?, ?)`,
    pid, uid, uid, now, now, new Date(now + 864e5).toISOString().slice(0, 10)).lastInsertRowid);
  await google.pushPlan(uid, () => planUser(uid));
  const pe = get('SELECT * FROM plan_events WHERE task_id = ?', t2);
  store.delete(pe.ext_id);
  await syncPlanCal(); await sleep(500);
  const d = get(`SELECT * FROM overrides WHERE task_id = ? AND kind = 'defer'`, t2);
  assert.ok(d); assert.equal(d.end, pe.end);
  const b = planUser(uid).blocks.find(x => x.key === String(t2));
  assert.ok(b.s >= pe.end, 'rescheduled after the deleted slot');
  await google.pushPlan(uid, () => getPlan(uid));
  assert.ok(get('SELECT * FROM plan_events WHERE task_id = ?', t2), 'a new block was written');
});

test('/done, /later and /skip typed into a block', async () => {
  const mk = (title, recur) => Number(run(`INSERT INTO tasks(project_id, title, duration, created_by, assignee_id, created_at, updated_at, start_after, recur) VALUES (?, ?, 30, ?, ?, ?, ?, ?, ?)`,
    pid, title, uid, uid, now, now, new Date(now + 864e5).toISOString().slice(0, 10), recur ? JSON.stringify(recur) : null).lastInsertRowid);
  const a = mk('Mail taxes'), b = mk('Call bank'), c = mk('Water plants', { freq: 'week', every: 1, anchor: new Date(now).toISOString().slice(0, 10) });
  await google.pushPlan(uid, () => planUser(uid));
  const pe = id => get('SELECT * FROM plan_events WHERE task_id = ?', id), ea = pe(a), eb = pe(b), ec = pe(c);
  store.get(ea.ext_id).description += '\n/done';
  store.get(eb.ext_id).summary += ' /later';
  store.get(ec.ext_id).summary = '/skip ' + store.get(ec.ext_id).summary;
  await syncPlanCal(); await sleep(500);
  assert.equal(get('SELECT status FROM tasks WHERE id = ?', a).status, 'done', '/done in the notes');
  assert.equal(store.get(ea.ext_id).summary, '✓ Mail taxes', 'stays in the calendar as done');
  assert.ok(!/(^|\s)\/done/.test(store.get(ea.ext_id).description), 'command removed from the notes');
  assert.ok(!store.has(eb.ext_id), '/later removes the block');
  assert.ok(get(`SELECT * FROM overrides WHERE task_id = ? AND kind = 'defer'`, b), '/later postpones');
  assert.equal(get('SELECT status FROM occurrences WHERE task_id = ? AND period = ?', c, ec.period)?.status, 'skipped', '/skip skips this round');
  assert.ok(!store.has(ec.ext_id));
  await google.pushPlan(uid, () => getPlan(uid));
  assert.ok(pe(b) && pe(b).ext_id !== eb.ext_id, 'postponed task gets a new block');
});

test('a project can write into its own calendar', async () => {
  const cal2 = get(`SELECT * FROM calendars WHERE ext_id = 'work@x'`);
  const st = settingsOf(uid); st.plan.projectCalendars = { [pid]: cal2.id }; saveSettings(uid, st);
  await google.pushPlan(uid, () => planUser(uid));
  const active = () => [...store.values()].filter(e => e.extendedProperties?.private?.sc === '1' && !e.summary.startsWith('✓'));
  const ours = active();
  assert.ok(ours.length > 0 && ours.every(e => e.cal === 'work@x'), 'all blocks moved to the project calendar');
  assert.equal(all('SELECT DISTINCT calendar_id FROM plan_events WHERE user_id = ?', uid).map(r => r.calendar_id).join(), String(cal2.id));
  st.plan.projectCalendars = {}; saveSettings(uid, st);
  await google.pushPlan(uid, () => planUser(uid));
  assert.ok(active().length > 0 && active().every(e => e.cal === 'plan@x'), 'and back');
});
test.after(() => setTimeout(() => process.exit(0), 50));

test('events of your own calendars can be created, edited, moved and deleted from the app', async () => {
  const work = get(`SELECT * FROM calendars WHERE ext_id = 'work@x'`), planCal = get(`SELECT * FROM calendars WHERE ext_id = 'plan@x'`);
  run('UPDATE calendars SET is_plan = 0 WHERE id = ?', work.id);   // a normal calendar of yours
  const t0 = Math.ceil((Date.now() + 2 * 864e5) / 3600e3) * 3600e3;
  await google.createEvent(uid, work.id, { title: 'Dentist', start: t0, end: t0 + 3600e3 });
  const g = [...store.values()].find(e => e.summary === 'Dentist');
  assert.equal(g.cal, 'work@x');
  let row = get(`SELECT * FROM events WHERE ext_id = ?`, g.id); assert.ok(row, 'cached right away');
  await google.updateEvent(uid, row, { title: 'Dentist (moved)', start: t0 + 3600e3, end: t0 + 7200e3 });
  assert.equal(g.summary, 'Dentist (moved)'); assert.equal(Date.parse(g.start.dateTime), t0 + 3600e3);
  const before = row.id;
  row = get(`SELECT * FROM events WHERE ext_id = ?`, g.id); assert.equal(row.start, t0 + 3600e3);
  assert.equal(row.id, before, 'same id after a change, so an open page can keep editing it');
  run(`INSERT INTO events(calendar_id, ext_id, start, end) VALUES (?, 'later', 0, 1)`, planCal.id);   // newer rows of other calendars, as in real use
  await google.syncEvents(acc, get('SELECT * FROM calendars WHERE id = ?', work.id), now - 864e5, now + 10 * 864e5);
  assert.equal(get(`SELECT id FROM events WHERE ext_id = ?`, g.id).id, before, 'and after a background sync');
  const workCal = () => get('SELECT * FROM calendars WHERE id = ?', work.id);
  assert.equal(await google.syncEvents(acc, workCal(), now - 864e5, now + 10 * 864e5), 0, 'nothing changed → nothing written');
  g.summary = 'Dentist (renamed)';
  assert.equal(await google.syncEvents(acc, workCal(), now - 864e5, now + 10 * 864e5), 1, 'a new title is a change');
  row = get(`SELECT * FROM events WHERE ext_id = ?`, g.id); assert.equal(row.title, 'Dentist (renamed)'); assert.equal(row.id, before);
  run(`DELETE FROM events WHERE ext_id = 'later'`);
  // repeating event: "all" shifts the series master by the same amount
  store.set('m1', { id: 'm1', cal: 'work@x', summary: 'Weekly', status: 'confirmed', start: { dateTime: new Date(t0 - 7 * 864e5).toISOString(), timeZone: 'Europe/Berlin' }, end: { dateTime: new Date(t0 - 7 * 864e5 + 3600e3).toISOString() } });
  store.set('m1_x', { id: 'm1_x', recurringEventId: 'm1', cal: 'work@x', summary: 'Weekly', status: 'confirmed', start: { dateTime: new Date(t0 + 3 * 3600e3).toISOString() }, end: { dateTime: new Date(t0 + 4 * 3600e3).toISOString() } });
  await google.syncEvents(acc, get('SELECT * FROM calendars WHERE id = ?', work.id), now - 864e5, now + 10 * 864e5);
  const inst = get(`SELECT * FROM events WHERE ext_id = 'm1_x'`); assert.equal(inst.series, 'm1');
  await google.updateEvent(uid, inst, { start: inst.start + 1800e3, end: inst.end + 1800e3 }, 'all');
  assert.equal(Date.parse(store.get('m1').start.dateTime), t0 - 7 * 864e5 + 1800e3); assert.equal(store.get('m1').start.timeZone, 'Europe/Berlin');
  // move to another calendar of the same account, then delete
  row = get(`SELECT * FROM events WHERE ext_id = ?`, g.id);
  await google.updateEvent(uid, row, { calendar_id: planCal.id });
  assert.equal(g.cal, 'plan@x');
  row = get(`SELECT * FROM events WHERE ext_id = ? AND calendar_id = ?`, g.id, planCal.id); assert.ok(row, 'now cached in the other calendar');
  await google.deleteEvent(uid, row);
  assert.ok(!store.has(g.id)); assert.ok(!get('SELECT 1 FROM events WHERE id = ?', row.id));
});

test('/block and /free typed into a title move to the notes', async () => {
  const work = get(`SELECT * FROM calendars WHERE ext_id = 'work@x'`); run('UPDATE calendars SET writable = 1, use_busy = 1 WHERE id = ?', work.id);
  const t = Math.ceil((now + 2 * 864e5) / 3600e3) * 3600e3, at = ms => ({ dateTime: new Date(ms).toISOString() });
  store.set('u1', { id: 'u1', cal: 'work@x', status: 'confirmed', summary: 'Gym /block', transparency: 'transparent', start: at(t), end: at(t + 3600e3) });
  store.set('u2', { id: 'u2', cal: 'work@x', status: 'confirmed', summary: '/free Lunch with Alex', description: 'Cafe', start: at(t + 7200e3), end: at(t + 10800e3) });
  await google.syncEvents(acc, get('SELECT * FROM calendars WHERE id = ?', work.id), now, now + 5 * 864e5);
  const u1 = store.get('u1'), u2 = store.get('u2');
  assert.equal(u1.summary, 'Gym'); assert.equal(u1.description, '/block'); assert.equal(u1.transparency, 'opaque');
  assert.equal(u2.summary, 'Lunch with Alex'); assert.equal(u2.description, 'Cafe\n\n/free'); assert.equal(u2.transparency, 'transparent');
  const { calendarEvents } = await import('../server/planner.js');
  const ev = Object.fromEntries(calendarEvents(uid, now, now + 5 * 864e5).filter(e => e.calendar_id === work.id).map(e => [e.ext_id, e]));
  assert.equal(ev.u1.blocks, true); assert.equal(ev.u2.blocks, false);
  await google.syncEvents(acc, get('SELECT * FROM calendars WHERE id = ?', work.id), now, now + 5 * 864e5);
  assert.equal(store.get('u1').description, '/block', 'nothing piles up');
  store.delete('u1'); store.delete('u2');
});

test('/flex in an event: it becomes a planned task with the event\'s time span as window', async () => {
  const work = get(`SELECT * FROM calendars WHERE ext_id = 'work@x'`);
  const { isoDate, addDays, at, wd } = await import('../server/time.js');
  let d = addDays(isoDate(now), 2); while (wd(d) === 0 || wd(d) === 6) d = addDays(d, 1);
  const iso = (m) => new Date(at(d, m)).toISOString();
  store.set('f1', { id: 'f1', cal: 'work@x', status: 'confirmed', summary: 'Dr. Miller /flex 30', location: 'Praxis Miller', start: { dateTime: iso(8 * 60) }, end: { dateTime: iso(11 * 60) } });
  store.set('f2', { id: 'f2', cal: 'work@x', status: 'confirmed', summary: 'Steuer', description: '/task', start: { dateTime: iso(14 * 60) }, end: { dateTime: iso(15 * 60 + 30) } });
  await google.syncEvents(acc, get('SELECT * FROM calendars WHERE id = ?', work.id), now, now + 6 * 864e5);
  assert.ok(!store.has('f1') && !store.has('f2'), 'the events are replaced');
  const t1 = get(`SELECT * FROM tasks WHERE ext_id = ?`, work.id + ':f1'), t2 = get(`SELECT * FROM tasks WHERE ext_id = ?`, work.id + ':f2');
  assert.equal(t1.title, 'Dr. Miller'); assert.equal(t1.duration, 30); assert.equal(t1.location, 'Praxis Miller');
  assert.deepEqual(JSON.parse(t1.meta).win, { days: [1, 2, 3, 4, 5], s: '08:00', e: '11:00' });
  assert.equal(t2.title, 'Steuer'); assert.equal(t2.duration, 90); assert.deepEqual(JSON.parse(t2.meta), {});
  // planned inside the window, one piece
  const p = planUser(uid), b = p.blocks.filter(x => x.key === String(t1.id));
  assert.equal(b.length, 1); assert.equal(b[0].e - b[0].s, 30 * 60000);
  const m = new Date(b[0].s).getHours() * 60 + new Date(b[0].s).getMinutes();
  assert.ok(m >= 8 * 60 && m + 30 <= 11 * 60, 'inside 08:00–11:00');
  run('DELETE FROM tasks WHERE id IN (?, ?)', t1.id, t2.id);
});

test('filtered copy: only events passing the keyword filter are copied, and follow changes', async () => {
  const { mirrorCalendar } = await import('../server/sync/mirror.js');
  const icsAcc = Number(run(`INSERT INTO accounts(user_id, kind, label, secret) VALUES (?, 'ics', 'Group', ?)`, uid, encrypt({ url: 'https://x/ics' })).lastInsertRowid);
  const src = Number(run(`INSERT INTO calendars(account_id, user_id, ext_id, name, use_busy, include_words, only_mine) VALUES (?, ?, 'ics', 'Group', 1, 'JD', 1)`, icsAcc, uid).lastInsertRowid);
  const dst = get(`SELECT * FROM calendars WHERE ext_id = 'work@x'`);
  run('UPDATE calendars SET mirror_to = ? WHERE id = ?', dst.id, src);
  const t = Math.ceil((Date.now() + 864e5) / 3600e3) * 3600e3;
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title) VALUES (?, 'g1', ?, ?, 'JD Termin'), (?, 'g2', ?, ?, 'MK Termin'), (?, 'g3', ?, ?, 'JD + MK')`, src, t, t + 3600e3, src, t, t + 3600e3, src, t + 7200e3, t + 9000e3);
  const copies = () => [...store.values()].filter(e => e.extendedProperties?.private?.mirror === String(src)).map(e => e.summary).sort();
  await mirrorCalendar(src);
  assert.deepEqual(copies(), ['JD + MK', 'JD Termin']);
  await mirrorCalendar(src);
  assert.deepEqual(copies(), ['JD + MK', 'JD Termin'], 'nothing duplicated');
  run(`UPDATE calendars SET exclude_words = 'MK' WHERE id = ?`, src);
  run(`UPDATE events SET title = 'JD Termin (moved)', start = start + 1800000, end = end + 1800000 WHERE calendar_id = ? AND ext_id = 'g1'`, src);
  await mirrorCalendar(src);
  assert.deepEqual(copies(), ['JD + MK', 'JD Termin (moved)'], 'own words win over the except list');
  run(`UPDATE calendars SET only_mine = 0 WHERE id = ?`, src);
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title) VALUES (?, 'g4', ?, ?, 'Meeting')`, src, t + 4 * 3600e3, t + 5 * 3600e3);
  await mirrorCalendar(src);
  assert.deepEqual(copies(), ['JD + MK', 'JD Termin (moved)', 'Meeting'], 'everything else is copied too');
  const c = [...store.values()].find(e => e.summary === 'JD Termin (moved)');
  assert.equal(Date.parse(c.start.dateTime), t + 1800e3);  // all-day and multi-day events follow the same filter
  const { dayStart, isoDate, addDays } = await import('../server/time.js');
  const d1 = dayStart(addDays(isoDate(Date.now()), 1));
  run(`UPDATE calendars SET only_mine = 1 WHERE id = ?`, src);
  run(`INSERT INTO events(calendar_id, ext_id, start, end, all_day, title, free) VALUES (?, 'g5', ?, ?, 1, 'JD holiday', 1), (?, 'g6', ?, ?, 1, 'MK holiday', 0), (?, 'g7', ?, ?, 0, 'JD trip', 0)`,
    src, d1 - 2 * 864e5, d1 + 3 * 864e5, src, d1, d1 + 864e5, src, d1 + 3600e3, d1 + 3 * 864e5);
  await mirrorCalendar(src);
  assert.deepEqual(copies(), ['JD + MK', 'JD Termin (moved)', 'JD holiday', 'JD trip']);
  // place, notes and call link come along, and follow changes
  run(`UPDATE events SET location = 'Raum 2.14', descr = 'Agenda', link = 'https://meet.google.com/abc-defg-hij' WHERE calendar_id = ? AND ext_id = 'g3'`, src);
  await mirrorCalendar(src);
  const g3 = [...store.values()].find(e => e.summary === 'JD + MK');
  assert.equal(g3.location, 'Raum 2.14'); assert.match(g3.description, /^Agenda\n\nhttps:\/\/meet\.google\.com\/abc-defg-hij\n\nCopy of/);
  const h = [...store.values()].find(e => e.summary === 'JD holiday');
  assert.equal(h.start.date, addDays(isoDate(Date.now()), -1)); assert.equal(h.end.date, addDays(isoDate(Date.now()), 4));
});

test('a flexible appointment goes to its own project and is written to the chosen calendar, without a main plan calendar', async () => {
  const { createFlexible } = await import('../server/flex.js');
  const work = get(`SELECT * FROM calendars WHERE ext_id = 'work@x'`);
  const st = settingsOf(uid); const keep = st.plan.calendarId, keepDays = st.plan.days; st.plan.calendarId = null; st.plan.projectCalendars = {}; st.plan.days = 14; saveSettings(uid, st);
  const { isoDate, addDays } = await import('../server/time.js');
  const id = createFlexible(uid, { title: 'Dr. Miller', minutes: 30, win: { days: [0, 1, 2, 3, 4, 5, 6], s: '08:00', e: '11:00' }, calendarId: work.id, startAfter: addDays(isoDate(now), 1), location: 'Hauptstr. 5' });
  const t = get('SELECT t.*, p.name AS pname FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?', id);
  assert.equal(t.pname, 'Appointments');
  await google.pushPlan(uid, () => planUser(uid));
  const ev = [...store.values()].find(e => e.summary === 'Dr. Miller');
  assert.ok(ev, 'written to Google'); assert.equal(ev.cal, 'work@x', 'into the chosen calendar');
  assert.equal(ev.extendedProperties.private.sc, '1', 'marked as ours: never read back as busy');
  assert.equal(ev.location, 'Hauptstr. 5', 'with its place');
  // done: it stays as a normal appointment (planned ahead → it ends now), not a block of the app
  const { setDone } = await import('../server/actions.js');
  setDone(uid, id, null, true);
  await google.pushPlan(uid, () => planUser(uid));
  const kept = store.get(ev.id);
  assert.ok(kept, 'still in the calendar'); assert.equal(kept.summary, 'Dr. Miller'); assert.equal(kept.extendedProperties.private.sc, 'done');
  assert.ok(Math.abs(Date.parse(kept.end.dateTime) - Date.now()) < 120000, 'ends now');
  assert.equal(Date.parse(kept.end.dateTime) - Date.parse(kept.start.dateTime), 30 * 60000, 'its length');
  assert.ok(!/smart-calendar/.test(kept.description || ''));
  await google.syncEvents(get('SELECT * FROM accounts WHERE id = ?', work.account_id), get('SELECT * FROM calendars WHERE id = ?', work.id), Date.now() - 864e5, Date.now() + 864e5);
  assert.equal(get('SELECT ours FROM events WHERE ext_id = ?', ev.id)?.ours, 0, 'shown as an appointment');
  st.plan.calendarId = keep; st.plan.days = keepDays; saveSettings(uid, st); run('DELETE FROM tasks WHERE id = ?', id); store.delete(ev.id);
});

test('push: Google says a calendar changed → it is read at once; wrong tokens are ignored', async () => {
  const { setServerConf } = await import('../server/serverconf.js');
  const { googlePushed } = await import('../server/sync/loop.js');
  const cal = () => get(`SELECT * FROM calendars WHERE ext_id = 'work@x'`);
  const acc0 = get('SELECT * FROM accounts WHERE id = ?', cal().account_id);
  assert.equal(google.pushUrl(), null, 'no public https address → no push');
  setServerConf({ baseUrl: 'https://plan.example.de' });
  const w = await google.watchCalendar(acc0, cal());
  assert.equal(watches.at(-1).address, 'https://plan.example.de/api/google/push'); assert.equal(JSON.parse(cal().watch).id, w.id);
  assert.equal((await google.watchCalendar(acc0, cal())).id, w.id, 'still valid: not renewed');
  assert.equal(watches.length, 1);
  assert.equal(googlePushed(w.id, 'wrong', 'exists'), false); assert.equal(googlePushed('nope', w.token, 'exists'), false);
  const t0 = Math.ceil((Date.now() + 864e5) / 3600e3) * 3600e3;
  store.set('push1', { id: 'push1', cal: 'work@x', summary: 'Pushed', status: 'confirmed', start: { dateTime: new Date(t0).toISOString() }, end: { dateTime: new Date(t0 + 3600e3).toISOString() } });
  assert.equal(googlePushed(w.id, w.token, 'exists'), true);
  await new Promise(r => setTimeout(r, 2200));
  assert.ok(get(`SELECT 1 FROM events WHERE ext_id = 'push1'`), 'read right after the push');
  // renewed a day before it runs out; the old channel is stopped
  run('UPDATE calendars SET watch = ? WHERE id = ?', JSON.stringify({ ...w, exp: Date.now() + 3600e3 }), cal().id);
  const w2 = await google.watchCalendar(acc0, get(`SELECT * FROM calendars WHERE ext_id = 'work@x'`));
  assert.notEqual(w2.id, w.id); assert.deepEqual(stopped, [w.id]);
  setServerConf({ baseUrl: '' }); store.delete('push1');
});

test('a Vikunja account\'s own calendar: blocks titled with your tag, done as "TAG - ✓ …"', async () => {
  const work = get(`SELECT * FROM calendars WHERE ext_id = 'work@x'`);
  const st = settingsOf(uid); const keep = { ...st.plan }; st.plan.tag = 'JD'; st.plan.days = 3; saveSettings(uid, st);
  const vacc = Number(run(`INSERT INTO accounts(user_id, kind, label, secret, state) VALUES (?, 'vikunja', 'Team', ?, ?)`, uid, encrypt({ url: 'https://vk.x', token: 't' }), JSON.stringify({ cfg: { calendarId: work.id } })).lastInsertRowid);
  const t0 = Date.now();
  const vid = Number(run(`INSERT INTO tasks(project_id, title, duration, created_by, assignee_id, created_at, updated_at, ext_source, ext_id, ext_account, start_after) VALUES (?, 'Order nozzles', 30, ?, ?, ?, ?, 'vikunja', '77', ?, ?)`,
    pid, uid, uid, t0, t0, vacc, new Date(t0 + 864e5).toISOString().slice(0, 10)).lastInsertRowid);
  await google.pushPlan(uid, () => planUser(uid));
  const ev = [...store.values()].find(e => /Order nozzles/.test(e.summary || ''));
  assert.ok(ev); assert.equal(ev.cal, 'work@x', 'in the account\'s calendar'); assert.equal(ev.summary, 'JD - Order nozzles');
  // a session that ran: kept, cut to its end, marked done after the tag
  const row = get('SELECT * FROM plan_events WHERE ext_id = ?', ev.id);
  run('UPDATE plan_events SET start = ?, end = ? WHERE id = ?', Date.now() - 30 * 60000, Date.now() + 30 * 60000, row.id);
  run(`UPDATE tasks SET status = 'done', done_at = ? WHERE id = ?`, Date.now(), vid);
  await google.pushPlan(uid, () => planUser(uid));
  assert.equal(store.get(ev.id).summary, 'JD - ✓ Order nozzles');
  run('DELETE FROM tasks WHERE id = ?', vid); run('DELETE FROM accounts WHERE id = ?', vacc); store.delete(ev.id);
  const s2 = settingsOf(uid); s2.plan = keep; saveSettings(uid, s2);
});

test('a block that passed without work goes away; worked on or done from it stays', async () => {
  const t0 = Date.now(), mk = title => Number(run(`INSERT INTO tasks(project_id, title, duration, created_by, assignee_id, created_at, updated_at, start_after) VALUES (?, ?, 30, ?, ?, ?, ?, ?)`,
    pid, title, uid, uid, t0, t0, new Date(t0 + 864e5).toISOString().slice(0, 10)).lastInsertRowid);
  const work = get(`SELECT * FROM calendars WHERE ext_id = 'work@x'`);
  const st = settingsOf(uid), keep = { ...st.plan }; st.plan.calendarId = work.id; st.plan.days = 21; saveSettings(uid, st);
  const a = mk('Skipped thing'), b = mk('Worked thing'), c = mk('Ticked thing');
  await google.pushPlan(uid, () => planUser(uid));
  const evOf = title => [...store.values()].find(e => e.summary === title);
  const ea = evOf('Skipped thing'), eb = evOf('Worked thing'), ec = evOf('Ticked thing');
  assert.ok(ea && eb && ec, JSON.stringify([...store.values()].map(e => e.summary)));
  // all three an hour ago
  for (const e of [ea, eb, ec]) run('UPDATE plan_events SET start = ?, end = ? WHERE ext_id = ?', t0 - 90 * 60000, t0 - 60 * 60000, e.id);
  run("INSERT INTO work_log(user_id, task_id, kind, start, end) VALUES (?, ?, 'work', ?, ?)", uid, b, t0 - 85 * 60000, t0 - 65 * 60000);
  run(`UPDATE tasks SET status = 'done', done_at = ? WHERE id = ?`, t0 - 30 * 60000, c);
  await google.pushPlan(uid, () => planUser(uid));
  const sa = store.get(ea.id);
  assert.ok(!sa || sa.status === 'cancelled' || Date.parse(sa.start.dateTime) >= t0 - 60000, 'not worked on: planned again, nothing left at the old time');
  assert.ok(![...store.values()].some(e => /Skipped/.test(e.summary || '') && e.status !== 'cancelled' && Date.parse(e.start.dateTime) < t0 - 60000), 'nothing logged');
  assert.ok(store.has(eb.id) && store.get(eb.id).status !== 'cancelled', 'worked on: kept');
  assert.equal(store.get(eb.id).summary, '✓ Worked thing', 'logged with ✓');
  assert.equal(Date.parse(store.get(eb.id).start.dateTime), t0 - 85 * 60000, 'as it was worked');
  assert.equal(Date.parse(store.get(eb.id).end.dateTime), t0 - 65 * 60000);
  assert.equal(store.get(ec.id)?.summary, '✓ Ticked thing', 'done: kept, ticked');
  for (const id of [a, b, c]) run('DELETE FROM tasks WHERE id = ?', id);
  const s2 = settingsOf(uid); s2.plan = keep; saveSettings(uid, s2);
});

test('Google shows what Smart Calendar shows: a dragged block, the session that runs from its start, paused as ✓, resumed as one', async () => {
  const A = await import('../server/actions.js');
  const t0 = Date.now(), tomorrow = new Date(t0 + 864e5).toISOString().slice(0, 10);
  const id = Number(run(`INSERT INTO tasks(project_id, title, duration, created_by, assignee_id, created_at, updated_at, start_after) VALUES (?, 'Drag me', 30, ?, ?, ?, ?, ?)`, pid, uid, uid, t0, t0, tomorrow).lastInsertRowid);
  await google.pushPlan(uid, () => planUser(uid));
  const ev = [...store.values()].find(e => e.summary === 'Drag me'); assert.ok(ev);
  const s0 = Date.parse(ev.start.dateTime), s1 = s0 + 3 * 3600e3;
  A.pinBlock(uid, id, 0, s0, s1, s1 + 45 * 60000);
  await google.pushPlan(uid, () => planUser(uid));
  assert.equal(Date.parse(store.get(ev.id).start.dateTime), s1, 'dragged: moved in Google');
  assert.equal(Date.parse(store.get(ev.id).end.dateTime), s1 + 45 * 60000);
  // started from 20 min ago: Google shows it from then
  A.startTimer(uid, id, 0, null, null, { since: t0 - 20 * 60000, until: t0 + 40 * 60000 });
  await google.pushPlan(uid, () => planUser(uid));
  const runs = () => [...store.values()].filter(e => /Drag me/.test(e.summary || '') && Date.parse(e.start.dateTime) <= Date.now());
  assert.equal(runs().length, 1); assert.equal(Date.parse(runs()[0].start.dateTime), t0 - 20 * 60000, 'from its start');
  const rid = runs()[0].id;
  // paused: what was worked stays as the log, with ✓
  A.pauseTimer(uid);
  await google.pushPlan(uid, () => planUser(uid));
  assert.equal(store.get(rid).summary, '✓ Drag me');
  assert.ok(Math.abs(Date.parse(store.get(rid).end.dateTime) - Date.now()) < 120000, 'ends where it was paused');
  // resumed at once: the same entry goes on, no second one
  A.startTimer(uid, id, 0);
  await google.pushPlan(uid, () => planUser(uid));
  assert.equal(runs().length, 1); assert.equal(runs()[0].id, rid); assert.equal(store.get(rid).summary, 'Drag me');
  A.stopTimer(uid, { done: true });
  run('DELETE FROM tasks WHERE id = ?', id);
});

test('a block that began but was not started moves with the plan in Google (nothing kept at its old start)', async () => {
  const t0 = Date.now();
  const id = Number(run(`INSERT INTO tasks(project_id, title, duration, created_by, assignee_id, created_at, updated_at) VALUES (?, 'Not started', 60, ?, ?, ?, ?)`, pid, uid, uid, t0, t0).lastInsertRowid);
  await google.pushPlan(uid, () => planUser(uid));
  const ev = [...store.values()].find(e => e.summary === 'Not started'); assert.ok(ev);
  run('UPDATE plan_events SET start = ?, end = ? WHERE ext_id = ?', t0 - 20 * 60000, t0 + 40 * 60000, ev.id);   // it began 20 min ago
  const b = planUser(uid).blocks.find(x => x.key === String(id));
  await google.pushPlan(uid, () => planUser(uid));
  const all = [...store.values()].filter(e => e.summary === 'Not started' || e.summary === '✓ Not started');
  assert.ok(all.every(e => !e.summary.startsWith('✓')), 'nothing logged');
  assert.ok(all.some(e => Date.parse(e.start.dateTime) === b.s), 'where the plan has it');
  assert.ok(!all.some(e => Date.parse(e.start.dateTime) < t0 - 60000), 'not at its old start');
  run('DELETE FROM tasks WHERE id = ?', id);
  await google.pushPlan(uid, () => planUser(uid));
});

test('a tracked appointment past its end: 30 min more in Google too; paused, it ends there', async () => {
  const A = await import('../server/actions.js');
  const { trackedEnds } = await import('../server/eventdone.js');
  const work = get(`SELECT * FROM calendars WHERE ext_id = 'work@x'`), t0 = Date.now();
  const end0 = t0 + 30000;
  store.set('appt1', { id: 'appt1', cal: 'work@x', summary: 'Long one', status: 'confirmed', start: { dateTime: new Date(t0 - 50 * 60000).toISOString() }, end: { dateTime: new Date(end0).toISOString() } });
  await google.syncEvents(get('SELECT * FROM accounts WHERE id = ?', work.account_id), work, t0 - 864e5, t0 + 864e5);
  const e = get(`SELECT * FROM events WHERE ext_id = 'appt1'`);
  A.startEvent(uid, e);
  await trackedEnds(uid);
  assert.equal(Date.parse(store.get('appt1').end.dateTime), end0 + 30 * 60000, '30 min more');
  assert.equal(get(`SELECT end FROM events WHERE ext_id = 'appt1'`).end, end0 + 30 * 60000, 'and in the app');
  await trackedEnds(uid);
  assert.equal(Date.parse(store.get('appt1').end.dateTime), end0 + 30 * 60000, 'once, not every minute');
  A.pauseEvent(uid);
  await trackedEnds(uid);
  const back = Math.max(end0, Math.ceil(Date.now() / 60000) * 60000);
  assert.ok(Math.abs(Date.parse(store.get('appt1').end.dateTime) - back) <= 60000, 'paused: ends at its end, or now');
  store.delete('appt1'); run(`DELETE FROM events WHERE ext_id = 'appt1'`); run('DELETE FROM event_track WHERE user_id = ?', uid);
});
