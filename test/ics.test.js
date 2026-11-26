// ICS import: all-day events, events that already started, Exchange-style all-day events
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ics-'));
const { run, all } = await import('../server/db.js');
const { encrypt } = await import('../server/crypto.js');
const { syncIcs } = await import('../server/sync/ics.js');
const { isoDate, addDays } = await import('../server/time.js');

const d = n => addDays(isoDate(Date.now()), n).replace(/-/g, '');
const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:started
SUMMARY:JD holiday
LOCATION:Mallorca
DTSTART;VALUE=DATE:${d(-3)}
DTEND;VALUE=DATE:${d(4)}
X-MICROSOFT-CDO-BUSYSTATUS:OOF
END:VEVENT
BEGIN:VEVENT
UID:exch
SUMMARY:JD training
DTSTART:${d(5)}T000000
DTEND:${d(7)}T000000
X-MICROSOFT-CDO-ALLDAYEVENT:TRUE
END:VEVENT
BEGIN:VEVENT
UID:old
SUMMARY:JD past
DTSTART;VALUE=DATE:${d(-10)}
DTEND;VALUE=DATE:${d(-8)}
END:VEVENT
END:VCALENDAR`;
globalThis.fetch = async () => new Response(ics, { status: 200 });

test('all-day and multi-day events are imported, also when they already started', async () => {
  const uid = Number(run(`INSERT INTO users(username, name, pw_hash, created_at) VALUES ('u', 'U', 'x', 0)`).lastInsertRowid);
  const acc = Number(run(`INSERT INTO accounts(user_id, kind, label, secret) VALUES (?, 'ics', 'Group', ?)`, uid, encrypt({ url: 'https://x/ics' })).lastInsertRowid);
  run(`INSERT INTO calendars(account_id, user_id, ext_id, name, use_busy) VALUES (?, ?, 'ics', 'Group', 1)`, acc, uid);
  await syncIcs({ id: acc, secret: all('SELECT secret FROM accounts WHERE id = ?', acc)[0].secret, state: null }, 62);
  const ev = Object.fromEntries(all('SELECT * FROM events').map(e => [e.series, e]));
  assert.ok(ev.started, 'holiday in progress is kept');
  assert.equal(ev.started.all_day, 1); assert.equal(ev.started.free, 0);
  assert.equal(Math.round((ev.started.end - ev.started.start) / 864e5), 7);
  assert.equal(ev.exch?.all_day, 1, 'Exchange all-day flag');
  assert.ok(!ev.old, 'finished events are not imported');
  assert.equal(ev.started.location, 'Mallorca');
});
