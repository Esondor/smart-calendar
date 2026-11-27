// One kind of appointment: at a time, or planned (work / personal hours or a window, from / until); priority rises towards the end date
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-appt-'));

const { get } = await import('../server/db.js');
const { createUser } = await import('../server/auth.js');
const { settingsOf, saveSettings } = await import('../server/models.js');
const { planUser, effPri } = await import('../server/planner.js');
const { createFlexible } = await import('../server/flex.js');

const u = createUser({ username: 'ap', name: 'Ap', password: 'long password 123' });
const s = settingsOf(u), all24 = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, ['00:00', '24:00']]));
s.hours = { work: all24, personal: all24 }; s.fixed = []; saveSettings(u, s);
const D = 864e5, now = Date.now();
const unit = (priority, days, extra = {}) => ({ t: { priority, duration: 60 }, spent: 0, hardDeadline: true, period: null, deadline: now + days * D, ...extra });

test('priority rises as the end date comes near', () => {
  assert.equal(effPri(unit(3, 30), now), 3, 'far away: as set');
  assert.ok(effPri(unit(3, 10), now) < 3 && effPri(unit(3, 10), now) > 2);
  assert.ok(effPri(unit(3, 5), now) < 2, 'within a week: High or more');
  assert.ok(effPri(unit(3, 1), now) < 1, 'a day left: nearly ASAP');
  assert.equal(effPri(unit(3, -1), now), 0, 'past: ASAP');
  assert.equal(effPri(unit(1, 30), now), 1, 'never lower than set');
  assert.equal(effPri(unit(3, 1, { period: 5 }), now), 3, 'repeating: each round as set');
  assert.equal(effPri(unit(3, 1, { overdue: true }), now), 0);
});

test('a planned appointment: in personal hours, from a day, by an end date, with its priority', () => {
  const from = new Date(now + 2 * D).toLocaleDateString('sv'), until = new Date(now + 4 * D).toLocaleDateString('sv');
  const id = createFlexible(u, { title: 'Call the bank', minutes: 45, schedule: 'personal', startAfter: from, deadline: until, priority: 3 });
  const t = get('SELECT * FROM tasks WHERE id = ?', id);
  assert.equal(t.schedule, 'personal'); assert.equal(t.deadline, until); assert.equal(t.priority, 3); assert.equal(JSON.parse(t.meta).appt, 1);
  const p = planUser(u, now), b = p.blocks.find(x => x.key === String(id));
  assert.ok(b && b.s >= new Date(from + 'T00:00').getTime(), 'not before its first day');
  assert.ok(p.units[String(id)].pri < 2, 'its end date is close: higher than set');
  assert.equal(get('SELECT priority FROM tasks WHERE id = ?', createFlexible(u, { title: 'x', minutes: 30 })).priority, 2, 'Medium unless chosen');
});

test('an ordered project (a thesis) keeps its priority: it is worked through in its order', () => {
  assert.equal(effPri(unit(3, 1, { ordered: true }), now), 3);
  assert.equal(effPri(unit(3, 1), now) < 1, true, 'a normal task rises');
});
