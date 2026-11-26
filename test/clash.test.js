// Clashes between a group event and an own blocking event: default rule, holiday, your choice, note in the group event
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-clash-'));
process.env.GOOGLE_CLIENT_ID = 'x'; process.env.GOOGLE_CLIENT_SECRET = 'y';

const gev = new Map();
globalThis.fetch = async (url, opt = {}) => {
  const u = new URL(url), json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'at', expires_in: 3600 });
  const id = decodeURIComponent(u.pathname.split('/').pop()), e = gev.get(id);
  if (!e) return json({ error: { message: 'nf' } }, 404);
  if ((opt.method || 'GET') === 'PATCH') Object.assign(e, JSON.parse(opt.body));
  return json(e);
};
const { run, get, all } = await import('../server/db.js');
const { encrypt } = await import('../server/crypto.js');
const { createUser } = await import('../server/auth.js');
const { settingsOf, saveSettings } = await import('../server/models.js');
const C = await import('../server/conflicts.js');
const { isoDate, addDays, at } = await import('../server/time.js');

const uid = createUser({ username: 'jdoe', name: 'S', password: 'long password 123' });
const s = settingsOf(uid); const work = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, ['09:00', '17:00']]));
s.hours.work = work; saveSettings(uid, s);
const acc = Number(run(`INSERT INTO accounts(user_id, kind, label, secret, status) VALUES (?, 'google', 'me', ?, 'ok')`, uid, encrypt({ refresh_token: 'r' })).lastInsertRowid);
const group = Number(run(`INSERT INTO calendars(account_id, user_id, ext_id, name, use_busy, writable, include_words, exclude_words) VALUES (?, ?, 'group@x', 'Group', 1, 1, 'JD', 'MK')`, acc, uid).lastInsertRowid);
const mine = Number(run(`INSERT INTO calendars(account_id, user_id, ext_id, name, use_busy, writable) VALUES (?, ?, 'me@x', 'Me', 1, 1)`, acc, uid).lastInsertRowid);
const day = n => addDays(isoDate(Date.now()), n);
const ev = (cal, id, title, d, a, b, extra = {}) => { run(`INSERT INTO events(calendar_id, ext_id, start, end, title, all_day) VALUES (?, ?, ?, ?, ?, ?)`, cal, id, a == null ? at(d, 0) : at(d, a * 60), b == null ? at(addDays(d, 1), 0) : at(d, b * 60), title, a == null ? 1 : 0); gev.set(id, { id, summary: title, description: extra.descr || '' }); };

test('clashes: ranking, holiday, your choice, note in the group event', async () => {
  ev(group, 'g1', 'JD Team meeting', day(2), 10, 11);  ev(mine, 'm1', 'Dentist', day(2), 10.5, 11.5);
  ev(group, 'g2', 'JD Evening review', day(2), 19, 20, { descr: 'Agenda' }); ev(mine, 'm2', 'Climbing', day(2), 19, 21);
  ev(group, 'g3', 'JD Standup', day(3), 9, 9.5); ev(mine, 'm3', 'Doctor', day(3), 9, 10); ev(group, 'h', 'JD Holiday', day(3));   // holiday → mine wins
  ev(group, 'g4', 'MK Workshop', day(2), 14, 15); ev(mine, 'm4', 'Call', day(2), 14, 15);    // not my group event → no clash
  await C.checkClashes(uid);
  const rows = () => Object.fromEntries(all('SELECT * FROM conflicts').map(r => [r.g_ext, r]));
  assert.deepEqual(Object.keys(rows()).sort(), ['g1', 'g2', 'g3']);
  assert.equal(rows().g1.choice, 'work', 'group calendar is ranked first by default'); assert.equal(gev.get('g1').description, '');
  assert.equal(gev.get('m1').description, '#JD-blocked', 'the note goes into the loser: your own event');
  assert.equal(rows().g2.choice, 'mine', 'after work hours your own event ranks first'); assert.equal(gev.get('g2').description, 'Agenda\n\n#JD-blocked');
  assert.equal(gev.get('m2').description, '');
  assert.equal(rows().g3.choice, 'mine', 'holiday that day'); assert.equal(gev.get('g3').description, '#JD-blocked');
  assert.ok(all('SELECT notified FROM conflicts').every(r => r.notified === 1));
  // the dentist dragged above the group calendar in its sheet: it wins in work hours too
  run(`INSERT INTO event_rules(user_id, calendar_id, series, rank) VALUES (?, ?, 'm1', ?)`, uid, mine, 'cal:' + group);
  await C.checkClashes(uid);
  assert.equal(rows().g1.choice, 'mine'); assert.equal(gev.get('g1').description, '#JD-blocked'); assert.equal(gev.get('m1').description, '', 'moved to the group event');
  run(`DELETE FROM event_rules WHERE series = 'm1'`);
  await C.checkClashes(uid);
  assert.equal(rows().g1.choice, 'work', 'automatic again'); assert.equal(gev.get('g1').description, ''); assert.equal(gev.get('m1').description, '#JD-blocked');
  const st = settingsOf(uid);
  // you decide
  await C.decideClash(uid, `${group}:g2`, 'work');
  assert.equal(gev.get('g2').description, 'Agenda'); assert.equal(gev.get('m2').description, '#JD-blocked', 'your choice moves the note');
  await C.checkClashes(uid);
  assert.equal(rows().g2.choice, 'work', 'your choice stays');
  await C.decideClash(uid, `${group}:g1`, 'mine'); await C.decideClash(uid, `${group}:g1`, 'mine');
  assert.equal(gev.get('g1').description, '#JD-blocked', 'never written twice'); assert.equal(gev.get('m1').description, '');
  // the own event goes away → the note is taken back
  run(`DELETE FROM events WHERE ext_id = 'm1'`);
  await C.checkClashes(uid);
  assert.equal(gev.get('g1').description, ''); assert.ok(!get(`SELECT 1 FROM conflicts WHERE g_ext = 'g1'`));
  // own tag
  st.plan.tag = 'SR'; saveSettings(uid, st); assert.equal(C.userTag(uid), 'SR');
  assert.equal(C.withMarker('x\n\n#SR-blocked', 'SR', true), 'x\n\n#SR-blocked');
});

test('moving a missed appointment: inside its opening hours, clear of higher-ranked calendars only', async () => {
  const { findSlot } = await import('../server/reschedule.js');
  const { calendarEvents } = await import('../server/planner.js');
  const st = settingsOf(uid);
  st.hours['dr miller'] = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, ['08:00', '12:00']]));
  st.plan.rank = ['cal:' + group, 'cal:' + mine, 'tasks']; st.plan.eventBuffer = 0; saveSettings(uid, st);
  run('DELETE FROM events'); run('DELETE FROM conflicts');
  const d = day(5);
  ev(mine, 'doc', 'Dr. Miller', day(-1), 9, 10);            // missed yesterday
  ev(group, 'gx', 'JD Planning', d, 8, 9.5);              // group calendar (ranked higher) blocks 08:00–09:30
  ev(mine, 'own', 'Gym', d, 9.5, 10.5);                    // same calendar: blocks too
  run(`INSERT INTO event_rules(user_id, calendar_id, series, hours) VALUES (?, ?, 'doc', 'dr miller')`, uid, mine);
  const doc = calendarEvents(uid, at(day(-1), 0), at(day(0), 0)).find(e => e.ext_id === 'doc');
  const slot = findSlot(uid, doc, at(d, 0));
  assert.equal(slot.start, at(d, 10.5 * 60), 'after the group event and the gym, inside opening hours');
  assert.equal(slot.end - slot.start, 3600e3);
  // with the group calendar ranked below, it may take 08:00
  st.plan.rank = ['cal:' + mine, 'cal:' + group, 'tasks']; saveSettings(uid, st);
  assert.equal(findSlot(uid, doc, at(d, 0)).start, at(d, 8 * 60));
  // its own window instead of an hours set: every day 10:30–11:30 (the gym ends 10:30)
  run(`UPDATE event_rules SET hours = NULL, win = ? WHERE series = 'doc'`, JSON.stringify({ days: [0, 1, 2, 3, 4, 5, 6], s: '10:30', e: '11:30' }));
  assert.equal(findSlot(uid, doc, at(d, 0)).start, at(d, 10.5 * 60));
  run(`UPDATE event_rules SET win = ? WHERE series = 'doc'`, JSON.stringify({ days: [0, 1, 2, 3, 4, 5, 6], s: '10:00', e: '11:00' }));
  assert.equal(findSlot(uid, doc, at(d, 0)).start, at(addDays(d, 1), 10 * 60), 'window taken by the gym that day → next day');
  run(`UPDATE event_rules SET hours = 'dr miller', win = NULL WHERE series = 'doc'`);
  // no opening hours left that day → next day
  st.plan.rank = ['cal:' + group, 'cal:' + mine, 'tasks']; saveSettings(uid, st);
  ev(group, 'gy', 'JD Workshop', d, 9.5, 12);
  assert.equal(findSlot(uid, doc, at(d, 0)).start, at(addDays(d, 1), 8 * 60));
});

test('a dismissed clash keeps its choice, is not shown again, and the note stays', async () => {
  run('DELETE FROM events'); run('DELETE FROM conflicts'); run('DELETE FROM event_rules');
  const st = settingsOf(uid); st.plan.rank = []; saveSettings(uid, st);
  ev(group, 'z1', 'JD Review', day(4), 19, 20); ev(mine, 'z2', 'Cinema', day(4), 19, 21);
  await C.checkClashes(uid);
  assert.equal(C.listClashes(uid).length, 1);
  await C.decideClash(uid, `${group}:z1`, 'mine');
  await C.dismissClash(uid, `${group}:z1`);
  assert.equal(C.listClashes(uid).length, 0, 'not shown any more');
  await C.checkClashes(uid);
  assert.equal(C.listClashes(uid).length, 0, 'not asked again');
  assert.equal(get(`SELECT choice FROM conflicts WHERE g_ext = 'z1'`).choice, 'mine');
  assert.equal(gev.get('z1').description, '#SR-blocked', 'both events stay, the note stays (tag set to SR above)');
});

test('the same appointment in two calendars is no clash', async () => {
  run('DELETE FROM events'); run('DELETE FROM conflicts');
  assert.equal(C.sameAppointment({ title: 'JD Dr. Miller', start: 0, end: 36e5 }, { title: 'Dr. Miller', start: 5 * 60000, end: 36e5 }, ['JD']), true);
  assert.equal(C.sameAppointment({ title: 'JD Team meeting', start: 0, end: 36e5 }, { title: 'Dentist', start: 0, end: 36e5 }, ['JD']), false);
  assert.equal(C.sameAppointment({ title: 'Dr. Miller', start: 0, end: 36e5 }, { title: 'Dr. Miller', start: 2 * 36e5, end: 3 * 36e5 }, []), false, 'different time');
  ev(group, 'd1', 'JD Dinner with Alex', day(4), 19, 21); ev(mine, 'd2', 'Dinner with Alex', day(4), 19, 21);
  await C.checkClashes(uid);
  assert.equal(C.listClashes(uid).length, 0);
  // not recognised (different title): "Same Appointment" puts it away without a note
  ev(group, 'd3', 'JD Elternabend', day(5), 19, 20); ev(mine, 'd4', 'Schule Sam', day(5), 19, 20);
  await C.checkClashes(uid);
  const k = C.listClashes(uid)[0].key;
  await C.decideClash(uid, k, 'mine'); assert.match(gev.get('d3').description, /-blocked/);
  await C.dismissClash(uid, k, true);
  assert.equal(gev.get('d3').description, '', 'note taken back'); assert.equal(gev.get('d4').description, '', 'no note in either'); assert.equal(C.listClashes(uid).length, 0);
});

test('put aside events are hidden for you, never removed', async () => {
  run('DELETE FROM events'); run('DELETE FROM conflicts');
  const { calendarEvents } = await import('../server/planner.js');
  ev(group, 'h1', 'JD Review', day(4), 19, 20); ev(mine, 'h2', 'Cinema', day(4), 19, 21);
  ev(group, 'h3', 'JD Dinner with Alex', day(5), 19, 21); ev(mine, 'h4', 'Dinner with Alex', day(5), 19, 21);
  await C.checkClashes(uid);
  const k = C.listClashes(uid)[0].key;
  await C.decideClash(uid, k, 'mine'); await C.dismissClash(uid, k);
  const evs = calendarEvents(uid, Date.now(), Date.now() + 8 * 864e5), byExt = Object.fromEntries(evs.map(e => [e.ext_id, e.id]));
  const hid = C.hiddenEvents(uid, evs);
  assert.ok(hid.has(byExt.h1), 'the group event that lost'); assert.ok(!hid.has(byExt.h2));
  assert.ok(hid.has(byExt.h3) && !hid.has(byExt.h4), 'the group copy of the same appointment');
  assert.ok(gev.has('h1') && gev.has('h3'), 'still in the group calendar');
  C.undismissClash(uid, group, 'h1');
  assert.ok(!C.hiddenEvents(uid, evs).has(byExt.h1)); assert.equal(C.listClashes(uid).length, 1, 'the clash is back');
});

test('copies of one appointment ("Also in …") are shown once and are no clash', async () => {
  run('DELETE FROM events'); run('DELETE FROM conflicts');
  const { calendarEvents } = await import('../server/planner.js');
  ev(group, 'c1', 'JD Dr. Miller pickup', day(4), 10, 11); ev(mine, 'c2', 'Sam abholen', day(4), 10, 11);   // different titles
  run(`UPDATE events SET dup = '${group}:c1' WHERE ext_id IN ('c1', 'c2')`);
  await C.checkClashes(uid);
  assert.equal(C.listClashes(uid).length, 0, 'linked copies never clash');
  const evs = calendarEvents(uid, Date.now(), Date.now() + 8 * 864e5), id = x => evs.find(e => e.ext_id === x).id, hid = C.hiddenEvents(uid, evs);
  assert.ok(!hid.has(id('c1')) && hid.has(id('c2')), 'the original stays visible in its color, the copy is hidden');
});
