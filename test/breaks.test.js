// Loose breaks as the app shows them: moved off appointments and next to them, in the calendar data and the menu bar
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-breaks-'));
const { run } = await import('../server/db.js');
const { encrypt } = await import('../server/crypto.js');
const { createUser } = await import('../server/auth.js');
const { settingsOf, saveSettings } = await import('../server/models.js');
const { shownBusy, getPlan, markDirty } = await import('../server/planner.js');

test('dinner moves off an evening appointment, lunch closes the gap after a morning one', () => {
  const uid = createUser({ username: 'brk', name: 'B', password: 'long password 123' });
  const s = settingsOf(uid); const all7 = [0, 1, 2, 3, 4, 5, 6];
  s.fixed = [{ id: 'lunch', t: 'Lunch', days: all7, s: '11:30', e: '12:45' }, { id: 'dinner', t: 'Dinner', days: all7, s: '19:30', e: '21:00' }];
  s.plan.eventBuffer = 15; saveSettings(uid, s);
  const acc = Number(run(`INSERT INTO accounts(user_id, kind, label, secret, status) VALUES (?, 'google', 'me', ?, 'ok')`, uid, encrypt({ refresh_token: 'r' })).lastInsertRowid);
  const cal = Number(run(`INSERT INTO calendars(account_id, user_id, ext_id, name, use_busy, writable) VALUES (?, ?, 'g@x', 'Group Calendar', 1, 0)`, acc, uid).lastInsertRowid);
  const d = new Date(Date.now() + 2 * 864e5); d.setHours(0, 0, 0, 0); const T = (h, m = 0) => d.getTime() + (h * 60 + m) * 60000;
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title) VALUES (?, 'w', ?, ?, 'DM, JD - Prof. Smith')`, cal, T(10), T(10, 45));
  run(`INSERT INTO events(calendar_id, ext_id, start, end, title) VALUES (?, 'x', ?, ?, 'Weihnachtsmarkt')`, cal, T(18), T(20));
  markDirty(uid, true);
  const b = shownBusy(uid, T(0), T(24), getPlan(uid)).filter(x => x.kind === 'fixed');
  const at = t => b.find(x => x.t === t);
  assert.equal(at('Lunch').s, T(10, 45), 'lunch right after the meeting');
  assert.equal(at('Dinner').s, T(20), 'dinner after the market');
});
