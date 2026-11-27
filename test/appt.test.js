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
  const round = (days, len) => unit(3, days, { period: 5, periodStart: now - (len - days) * D, periodEnd: now + days * D });
  assert.ok(effPri(round(0.2, 7), now) < 1, 'a weekly chore near the end of its week: nearly ASAP');
  assert.ok(effPri(round(3, 7), now) >= 2, 'mid-week: not yet');
  assert.ok(effPri(round(0.75, 1), now) >= 2, 'a daily one is not red all day');
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

test('due today with its hours over: it goes in this evening before bedtime, not after the deadline', () => {
  const v = createUser({ username: 'late1', name: 'L', password: 'long password 123' });
  const st = settingsOf(v), am = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, ['08:00', '12:00']]));
  st.hours = { work: am, personal: am }; st.fixed = []; st.plan.bedtime = '22:30'; saveSettings(v, st);
  const day = new Date(now).toLocaleDateString('sv'), at15 = new Date(day + 'T15:00').getTime();
  const id = createFlexible(v, { title: 'Due today', minutes: 30, schedule: 'personal', startAfter: day, deadline: day, priority: 2 });
  const p = planUser(v, at15), b = p.blocks.find(x => x.key === String(id));
  assert.ok(b, 'planned');
  assert.equal(new Date(b.s).toLocaleDateString('sv'), day, 'today');
  assert.ok(b.s >= at15 && b.e <= new Date(day + 'T22:30').getTime(), 'after now, before bedtime');
  assert.equal(p.info[String(id)].late, false);
  assert.ok(p.units[String(id)].pri < 0.5, 'ASAP by now');
  // without an end date it waits for its hours tomorrow
  const id2 = createFlexible(v, { title: 'Whenever', minutes: 30, schedule: 'personal', startAfter: day });
  const b2 = planUser(v, at15).blocks.find(x => x.key === String(id2));
  assert.notEqual(new Date(b2.s).toLocaleDateString('sv'), day);
});

test('start and due with a time of day: planned after the start, done by the due time', () => {
  const v = createUser({ username: 'late2', name: 'L', password: 'long password 123' });
  const st = settingsOf(v), all24 = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, ['00:00', '24:00']]));
  st.hours = { work: all24, personal: all24 }; st.fixed = []; saveSettings(v, st);
  const day = new Date(now + D).toLocaleDateString('sv'), from = new Date(day + 'T14:00').getTime(), due = new Date(day + 'T16:00').getTime();
  const id = createFlexible(v, { title: 'Pick up parcel', minutes: 30, schedule: 'personal', fromAt: from, dueAt: due });
  const t = get('SELECT * FROM tasks WHERE id = ?', id);
  assert.equal(t.start_after, day); assert.equal(t.deadline, day);
  const b = planUser(v, now).blocks.find(x => x.key === String(id));
  assert.ok(b.s >= from && b.e <= due, `${new Date(b.s)} – ${new Date(b.e)}`);
});
