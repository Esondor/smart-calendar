// Google Maps proxy: suggestions near home, place details, travel time by car and bike (Google faked)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-maps-'));
const seen = [];
globalThis.fetch = async (url, opt = {}) => {
  const u = new URL(url), body = opt.body ? JSON.parse(opt.body) : null, json = o => new Response(JSON.stringify(o), { status: 200 });
  seen.push({ path: u.pathname, body, key: opt.headers?.['x-goog-api-key'], referer: opt.headers?.referer });
  if (u.pathname.endsWith('places:autocomplete')) return json({ suggestions: [{ placePrediction: { placeId: 'p1', text: { text: 'Dr. med. Miller, Hauptstr. 5' }, structuredFormat: { mainText: { text: 'Dr. med. Miller' }, secondaryText: { text: 'Hauptstr. 5, Musterstadt' } }, distanceMeters: 2300 } }] });
  if (u.pathname.startsWith('/v1/places/')) return json({ id: 'p1', displayName: { text: 'Dr. med. Miller' }, formattedAddress: 'Hauptstr. 5, 12345 Musterstadt', location: { latitude: 50.1, longitude: 8.6 } });
  if (u.hostname === 'maps.app.goo.gl') return new Response(null, { status: 302, headers: { location: 'https://www.google.com/maps/place/North+Campus/@48.1,11.5,17z/data=!3d48.13743!4d11.57549' } });
  if (u.hostname === 'routes.googleapis.com') return json({ routes: [{ duration: body.travelMode === 'DRIVE' ? '540s' : '1260s', distanceMeters: 3100 }] });
  return new Response('{}', { status: 404 });
};
const { run, get } = await import('../server/db.js');
const { createUser } = await import('../server/auth.js');
const { settingsOf, saveSettings } = await import('../server/models.js');
const { setServerConf } = await import('../server/serverconf.js');
const M = await import('../server/maps.js');

test('places and travel time through the server', async () => {
  const uid = createUser({ username: 'jdoe', name: 'S', password: 'long password 123' });
  await assert.rejects(() => M.suggest(uid, 'Dr. Miller'), /not set up/);
  setServerConf({ mapsKey: 'k123', baseUrl: 'https://plan.example.com' });
  const s = settingsOf(uid); s.plan.home = { address: 'Gartenweg 1, 12345 Musterstadt', lat: 50.11, lng: 8.62 }; saveSettings(uid, s);
  const L = await M.suggest(uid, 'Dr. Miller', 'sess');
  assert.deepEqual(L, [{ id: 'p1', title: 'Dr. med. Miller', sub: 'Hauptstr. 5, Musterstadt', km: 2.3 }]);
  assert.equal(seen[0].key, 'k123'); assert.equal(seen[0].referer, 'https://plan.example.com/', 'a key limited to the app\'s website accepts it'); assert.ok(seen[0].body.locationBias.circle, 'near home');
  const p = await M.place('p1', 'sess');
  assert.equal(p.text, 'Dr. med. Miller, Hauptstr. 5, 12345 Musterstadt');
  const t = await M.travel(uid, p.address);
  assert.deepEqual(t, { car: { min: 9, km: 3.1 }, bike: { min: 21, km: 3.1 } });
  setServerConf({ mapsKey: '' }); assert.ok(M.mapsReady(), 'an empty field keeps the key');
});

test('the way from home is the buffer before an appointment: by bike up to 25 min, else by car', async () => {
  setServerConf({ mapsKey: 'k123' });
  const { encrypt } = await import('../server/crypto.js');
  const { refreshTravel } = await import('../server/travel.js');
  const { calendarEvents } = await import('../server/planner.js');
  const uid = createUser({ username: 'way', name: 'W', password: 'long password 123' });
  const s = settingsOf(uid); s.plan.home = { address: 'Gartenweg 1, 12345 Musterstadt' }; s.plan.eventBuffer = 0; saveSettings(uid, s);
  const acc = Number(run(`INSERT INTO accounts(user_id, kind, label, secret, status) VALUES (?, 'google', 'me', ?, 'ok')`, uid, encrypt({ refresh_token: 'r' })).lastInsertRowid);
  const cal = Number(run(`INSERT INTO calendars(account_id, user_id, ext_id, name, use_busy, writable) VALUES (?, ?, 'w@x', 'Me', 1, 1)`, acc, uid).lastInsertRowid);
  const t0 = Date.now() + 2 * 864e5, H = 3600e3;
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title, location) VALUES (?, 'doc', ?, ?, 'Doctor', 'Hauptstr. 5, Musterstadt')`, cal, t0, t0 + H);
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title, location) VALUES (?, 'call', ?, ?, 'Call', 'Microsoft Teams Meeting')`, cal, t0 + 3 * H, t0 + 4 * H);
  const n0 = seen.length;
  assert.equal(await refreshTravel(uid), 1, 'only the place you go to');
  assert.equal(await refreshTravel(uid), 0, 'known places are not asked again');
  assert.equal(seen.length - n0, 2, 'car and bike, once');
  let ev = calendarEvents(uid, t0 - H, t0 + 5 * H);
  const doc = ev.find(e => e.ext_id === 'doc'), call = ev.find(e => e.ext_id === 'call');
  assert.deepEqual(doc.travel, { mode: 'bike', min: 21, before: 25, there: true, home: true }); assert.equal(doc.before, 25);
  assert.equal(doc.after, 25, 'the last place of the day: the way home after it');
  assert.equal(call.travel, null); assert.equal(call.before, 0);
  s.plan.bikeMax = 15; saveSettings(uid, s);
  ev = calendarEvents(uid, t0 - H, t0 + 5 * H).find(e => e.ext_id === 'doc');
  assert.deepEqual(ev.travel, { mode: 'car', min: 9, before: 10, there: true, home: true }, 'longer by bike than you like: car');
  s.plan.eventBuffer = 15; saveSettings(uid, s);
  ev = calendarEvents(uid, t0 - H, t0 + 5 * H).find(e => e.ext_id === 'doc');
  assert.equal(ev.before, 15, 'a short way: at least the usual buffer'); assert.equal(ev.after, 15);
  s.plan.eventBuffer = 0; saveSettings(uid, s);
  // right after another appointment, the way there still comes first (as far as the gap allows)
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title) VALUES (?, 'before', ?, ?, 'Meeting')`, cal, t0 - H, t0 - 5 * 60000);
  ev = calendarEvents(uid, t0 - 2 * H, t0 + 5 * H);
  assert.equal(ev.find(e => e.ext_id === 'doc').before, 5); assert.equal(ev.find(e => e.ext_id === 'before').after, 0);
});

test('two appointments at the same place: there once, home after the last', async () => {
  const { encrypt } = await import('../server/crypto.js');
  const { refreshTravel } = await import('../server/travel.js');
  const { calendarEvents } = await import('../server/planner.js');
  setServerConf({ mapsKey: 'k123' });
  const uid = createUser({ username: 'campus', name: 'C', password: 'long password 123' });
  const s = settingsOf(uid); s.plan.home = { address: 'Gartenweg 1, 12345 Musterstadt' }; s.plan.eventBuffer = 15; saveSettings(uid, s);
  const acc = Number(run(`INSERT INTO accounts(user_id, kind, label, secret, status) VALUES (?, 'google', 'me', ?, 'ok')`, uid, encrypt({ refresh_token: 'r' })).lastInsertRowid);
  const cal = Number(run(`INSERT INTO calendars(account_id, user_id, ext_id, name, use_busy, writable) VALUES (?, ?, 'c@x', 'Me', 1, 1)`, acc, uid).lastInsertRowid);
  const d0 = new Date(Date.now() + 2 * 864e5); d0.setHours(0, 0, 0, 0); const T = h => d0.getTime() + h * 3600e3;
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title, location) VALUES (?, 'a', ?, ?, 'Seminar', 'North Campus')`, cal, T(9), T(10));
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title, location) VALUES (?, 'b', ?, ?, 'Lab', 'North Campus')`, cal, T(13), T(14));
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title) VALUES (?, 'c', ?, ?, 'Call')`, cal, T(17), T(18));
  await refreshTravel(uid);
  const ev = calendarEvents(uid, T(0), T(24)), by = k => ev.find(e => e.ext_id === k);
  assert.equal(by('a').before, 25); assert.equal(by('a').after, 15, 'still there: the usual buffer');
  assert.equal(by('b').before, 15, 'already there: no way there'); assert.equal(by('b').after, 25, 'home after the last place');
  assert.ok(by('b').travel.home && !by('b').travel.there);
  assert.equal(by('c').travel, null);
  const { busyOf } = await import('../server/planner.js');
  assert.ok(busyOf(uid, T(0), T(24)).some(b => b.kind === 'buffer' && b.s === T(14) && !b.pad), 'the way home is not a buffer a meal may use');
});

test('place rules: a room code in the place or title means the campus', async () => {
  const { encrypt } = await import('../server/crypto.js');
  const { refreshTravel, placeOf } = await import('../server/travel.js');
  const { calendarEvents } = await import('../server/planner.js');
  setServerConf({ mapsKey: 'k123' });
  const rules = [{ match: 'B## #-###', place: 'North Campus, Springfield' }];
  for (const l of ['B03 1-161', 'B03-1-161', 'B3-1-161', 'Raum B02 2-215']) assert.equal(placeOf({ location: l }, rules), 'North Campus, Springfield', l);
  assert.equal(placeOf({ location: 'Campus Mensa' }, rules), 'Campus Mensa');
  assert.equal(placeOf({ title: 'Group meeting B3-1-161', location: '' }, rules), 'North Campus, Springfield', 'in the title');
  assert.equal(placeOf({ location: 'B3-1-161' }, [{ match: '/^b\\d/', place: 'X' }]), 'X', 'a regex');
  for (const l of ['Waldstraße 12, 12345 Springfield', 'Waldstr. 12', 'Am Hafen 3, Springfield', '12345 Springfield', 'Waldweg 3 B3-1-161'])
    assert.equal(placeOf({ location: l, title: 'Meeting B3-1-161' }, rules), l, 'an address stays: ' + l);
  const uid = createUser({ username: 'rooms', name: 'R', password: 'long password 123' });
  const s = settingsOf(uid); s.plan.home = { address: 'Gartenweg 1, 12345 Musterstadt' }; s.plan.places = rules; saveSettings(uid, s);
  const acc = Number(run(`INSERT INTO accounts(user_id, kind, label, secret, status) VALUES (?, 'google', 'me', ?, 'ok')`, uid, encrypt({ refresh_token: 'r' })).lastInsertRowid);
  const cal = Number(run(`INSERT INTO calendars(account_id, user_id, ext_id, name, use_busy, writable) VALUES (?, ?, 'r@x', 'Me', 1, 1)`, acc, uid).lastInsertRowid);
  const t0 = Date.now() + 3 * 864e5;
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title, location) VALUES (?, 'r1', ?, ?, 'Seminar', 'B03 1-161')`, cal, t0, t0 + 3600e3);
  const n0 = seen.filter(x => x.body?.destination).length;
  await refreshTravel(uid);
  assert.ok(seen.slice(-2).every(x => x.body.destination.address === 'North Campus, Springfield'), 'the campus is asked, not the room');
  assert.ok(seen.filter(x => x.body?.destination).length > n0);
  const e = calendarEvents(uid, t0 - 3600e3, t0 + 2 * 3600e3).find(x => x.ext_id === 'r1');
  assert.equal(e.travel?.mode, 'bike'); assert.equal(e.before, 25);
});

test('pins: coordinates or a Google Maps link; the way goes to the pin, the event links to it', async () => {
  const { parsePin, pinName, placeOf } = await import('../server/travel.js');
  assert.deepEqual(parsePin('48.13743, 11.57549'), { lat: 48.13743, lng: 11.57549 });
  assert.deepEqual(parsePin('https://www.google.com/maps/place/North+Campus/@48.1370,11.5750,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x1!8m2!3d48.13743!4d11.57549'), { lat: 48.13743, lng: 11.57549 }, 'the exact pin, not the view');
  assert.deepEqual(parsePin('https://maps.google.com/?q=48.1,11.6'), { lat: 48.1, lng: 11.6 });
  assert.equal(parsePin('Waldstraße 12'), null); assert.equal(parsePin('99.5, 11.5'), null);
  assert.equal(pinName('https://www.google.com/maps/place/North+Campus/@48.1,11.5,17z'), 'North Campus');
  const rules = [{ match: 'B## #-###', place: 'North Campus', lat: 48.13743, lng: 11.57549 }];
  assert.equal(placeOf({ location: 'B3-1-161' }, rules), '48.13743,11.57549');
  const M2 = await import('../server/maps.js'); const before = seen.length;
  await M2.travel(createUser({ username: 'pin', name: 'P', password: 'long password 123' }), '48.13743,11.57549').catch(() => {});
  const uid = get('SELECT id FROM users WHERE username = ?', 'pin').id;
  const s = settingsOf(uid); s.plan.home = { address: 'Gartenweg 1', lat: 48.1, lng: 11.6 }; saveSettings(uid, s);
  await M2.travel(uid, '48.13743,11.57549');
  const r = seen.slice(before).find(x => x.body?.destination);
  assert.deepEqual(r.body.destination, { location: { latLng: { latitude: 48.13743, longitude: 11.57549 } } }, 'to the pin');
  assert.deepEqual(r.body.origin, { location: { latLng: { latitude: 48.1, longitude: 11.6 } } }, 'from home\'s pin');
});

test('settings: a pasted short link becomes the pin with its name', async () => {
  const Fastify = (await import('fastify')).default, { default: apiRoutes } = await import('../server/api.js');
  const uid = createUser({ username: 'pins2', name: 'P', password: 'long password 123' });
  const app = Fastify(); app.addHook('onRequest', async req => { req.user = get('SELECT * FROM users WHERE id = ?', uid); }); await app.register(apiRoutes); await app.ready();
  const plan = { ...settingsOf(uid).plan, places: [{ match: 'B## #-###', place: 'https://maps.app.goo.gl/abc123' }, { match: 'X#', place: '48.2, 11.6' }, { match: 'Y#', place: 'Mensa', lat: 48, lng: 11 }] };
  const r = await app.inject({ method: 'PUT', url: '/api/settings', payload: { plan } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(settingsOf(uid).plan.places, [{ match: 'B## #-###', place: 'North Campus', lat: 48.13743, lng: 11.57549 },
    { match: 'X#', place: '48.20000, 11.60000', lat: 48.2, lng: 11.6 }, { match: 'Y#', place: 'Mensa', lat: 48, lng: 11 }]);
  await app.close();
});
