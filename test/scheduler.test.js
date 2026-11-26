import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../server/scheduler.js';
import { at, periodOf, periodRange } from '../server/time.js';

const hours = { work: { 1: ['09:00', '12:00'], 2: ['09:00', '12:00'], 3: ['09:00', '12:00'], 4: ['09:00', '12:00'], 5: ['09:00', '12:00'] },
  personal: { 0: [['10:00', '12:00']], 6: [['10:00', '12:00']], 1: [['18:00', '20:00']] } };
const mon = '2026-11-23';

test('fills in order, splits around busy time, respects schedules', () => {
  const now = at(mon, 8 * 60);
  const busy = [{ s: at(mon, 10 * 60), e: at(mon, 10 * 60 + 30) }];
  const r = schedule({ now, hours, chunk: 30, busy, items: [
    { key: 'a', remaining: 90, schedule: 'work' },
    { key: 'b', remaining: 60, schedule: 'work' },
    { key: 'c', remaining: 30, schedule: 'personal' },
  ] });
  const a = r.blocks.filter(b => b.key === 'a');
  assert.equal(a[0].s, at(mon, 540)); assert.equal(a[0].e, at(mon, 600));   // 9-10
  assert.equal(a[1].s, at(mon, 630)); assert.equal(a[1].e, at(mon, 660));   // 10:30-11
  const b = r.blocks.filter(x => x.key === 'b');
  assert.equal(b[0].s, at(mon, 660));
  const c = r.blocks.find(x => x.key === 'c');
  assert.equal(c.s, at(mon, 18 * 60));
});

test('preferred weekday, pins and deadlines', () => {
  const now = at(mon, 8 * 60);
  const r = schedule({ now, hours, chunk: 30, items: [
    { key: 'pin', remaining: 60, schedule: 'work', pins: [{ s: at(mon, 540), e: at(mon, 600) }] },
    { key: 'sat', remaining: 60, schedule: 'personal', days: [6] },
    { key: 'late', remaining: 600, schedule: 'work', deadline: at('2026-11-24', 0) },
  ] });
  assert.equal(r.blocks.filter(b => b.key === 'pin').length, 1);
  assert.equal(r.blocks.find(b => b.key === 'sat').s, at('2026-11-28', 600));
  assert.equal(r.info.late.late, true);
  assert.equal(r.blocks.find(b => b.key === 'late').s, at(mon, 600));
});

test('recurrence periods', () => {
  const w = { freq: 'week', every: 1, anchor: '2026-11-18' };
  assert.equal(periodOf(w, '2026-11-22'), 0); assert.equal(periodOf(w, '2026-11-23'), 1);
  assert.deepEqual(periodRange(w, 1), ['2026-11-23', '2026-11-30']);
  const m = { freq: 'month', every: 1, anchor: '2026-11-05' };
  assert.deepEqual(periodRange(m, 2), ['2027-01-01', '2027-02-01']);
});

test('tasks at the same location are batched', () => {
  const sat = '2026-11-28', now = at(sat, 9 * 60);
  const r = schedule({ now, hours, chunk: 15, items: [
    { key: 'wash', remaining: 15, schedule: 'personal', loc: 'Basement' },
    { key: 'desk', remaining: 30, schedule: 'personal' },
    { key: 'catfood', remaining: 10, schedule: 'personal', loc: 'Basement', earliest: at('2026-11-23', 0), deadline: at('2026-12-05', 0) },
  ] });
  const w = r.blocks.find(b => b.key === 'wash'), c = r.blocks.find(b => b.key === 'catfood'), d = r.blocks.find(b => b.key === 'desk');
  assert.equal(c.s, w.e, 'cat food right after the washer');
  assert.ok(d.s >= c.e);
});

test('batching takes only one instance of a repeating chore', () => {
  const mon = '2026-11-23', now = at(mon, 17 * 60);
  const r = schedule({ now, hours: { personal: { 1: [['18:00', '21:00']], 2: [['18:00', '21:00']] } }, chunk: 5, items: [
    { key: '7@0', remaining: 5, schedule: 'personal', loc: 'basement', earliest: at('2026-11-16', 0), deadline: at(mon, 24 * 60) },
    { key: '7@1', remaining: 5, schedule: 'personal', loc: 'basement', earliest: at(mon, 0), deadline: at('2026-11-30', 0) },
    { key: '9', remaining: 10, schedule: 'personal', loc: 'basement' },
  ] });
  const a = r.blocks.find(b => b.key === '7@0'), w = r.blocks.find(b => b.key === '9'), n = r.blocks.find(b => b.key === '7@1');
  assert.equal(w.s, a.e);
  assert.ok(!n || n.s >= w.e + 0 && !n.batched, 'next week not pulled into this visit');
});

test('ordered project: a task starts only after the previous one is finished', () => {
  const now = at(mon, 8 * 60);
  // "c" must wait for "a" (Tuesday) although Monday still has room
  const r = schedule({ now, hours, chunk: 30, busy: [{ s: at(mon, 540), e: at(mon, 600) }], items: [
    { key: 'a', remaining: 60, schedule: 'work', earliest: at('2026-11-24', 0) },
    { key: 'c', remaining: 60, schedule: 'work', after: 'a' },
    { key: 'free', remaining: 60, schedule: 'work' },
  ] });
  const a = r.blocks.find(x => x.key === 'a'), c = r.blocks.find(x => x.key === 'c'), f = r.blocks.find(x => x.key === 'free');
  assert.equal(a.s, at('2026-11-24', 540));
  assert.ok(c.s >= a.e, 'c after a');
  assert.ok(f.s < c.s, 'unrelated work is not held back');
});

test('appointment in a window: one piece, an hour before closing, next to another appointment, meals give way', () => {
  const now = at(mon, 7 * 60), win = { days: [1, 2, 3, 4, 5], s: '08:00', e: '11:00' };
  const doc = { key: 'doc', remaining: 30, schedule: 'work', win };
  // nothing else that morning: 10:00–10:30, not first thing at 8
  let r = schedule({ now, hours, busy: [], items: [doc] });
  assert.equal(r.blocks.length, 1); assert.equal(r.blocks[0].s, at(mon, 10 * 60)); assert.equal(r.blocks[0].e, at(mon, 10 * 60 + 30));
  // another appointment 09:00–09:30: right after it (one trip)
  r = schedule({ now, hours, busy: [{ s: at(mon, 9 * 60), e: at(mon, 9 * 60 + 30), kind: 'event' }], items: [doc] });
  assert.equal(r.blocks[0].s, at(mon, 9 * 60 + 30));
  // breakfast 09:45–10:30 is a meal: it gives way; a work meeting 09:30–11:00 does not → next day
  r = schedule({ now, hours, busy: [{ s: at(mon, 9 * 60 + 45), e: at(mon, 10 * 60 + 30), kind: 'fixed', soft: true }], items: [doc] });
  assert.equal(r.blocks[0].s, at(mon, 10 * 60));
  r = schedule({ now, hours, busy: [{ s: at(mon, 8 * 60), e: at(mon, 11 * 60), kind: 'event' }], items: [doc] });
  assert.equal(r.blocks[0].s, at('2026-11-24', 10 * 60));
  // ordinary tasks still keep the meal free
  r = schedule({ now: at(mon, 9 * 60), hours, busy: [{ s: at(mon, 9 * 60), e: at(mon, 12 * 60), kind: 'fixed', soft: true }], items: [{ key: 't', remaining: 60, schedule: 'work' }] });
  assert.ok(r.blocks[0].s >= at('2026-11-24', 0));
  // late in the window already: still today if it fits
  r = schedule({ now: at(mon, 10 * 60 + 20), hours, busy: [], items: [doc] });
  assert.equal(r.blocks[0].s, at(mon, 10 * 60 + 20));
});

test('loose breaks move up to an hour for appointments and ASAP tasks; firm breaks stay', () => {
  const now = at(mon, 7 * 60), win = { days: [1, 2, 3, 4, 5], s: '10:00', e: '10:30' };
  const brk = (soft) => ({ s: at(mon, 10 * 60), e: at(mon, 10 * 60 + 30), kind: 'fixed', bid: 'breakfast:' + mon, soft });
  let r = schedule({ now, hours, busy: [brk(true)], items: [{ key: 'doc', remaining: 30, schedule: 'work', win }] });
  assert.equal(r.blocks[0].s, at(mon, 10 * 60), 'the appointment takes the time');
  assert.deepEqual(r.breaks, [{ id: 'breakfast:' + mon, s0: at(mon, 10 * 60), s: at(mon, 9 * 60 + 30), e: at(mon, 10 * 60) }], 'the break moves next to it');
  r = schedule({ now, hours, busy: [brk(false)], items: [{ key: 'doc', remaining: 30, schedule: 'work', win }] });
  assert.equal(r.blocks[0].s, at('2026-11-24', 10 * 60), 'a firm break stays, the appointment takes the next day');
  // an ASAP task may use the break time; an ordinary one may not
  const busy = [{ s: at(mon, 9 * 60), e: at(mon, 12 * 60), kind: 'fixed', bid: 'long:' + mon, soft: true }];
  r = schedule({ now: at(mon, 9 * 60), hours, busy, items: [{ key: 'asap', remaining: 60, schedule: 'work', important: true }] });
  assert.equal(r.blocks[0].s, at(mon, 9 * 60)); assert.equal(r.breaks[0].s, at(mon, 10 * 60), 'an hour later');
  r = schedule({ now: at(mon, 9 * 60), hours, busy, items: [{ key: 'asap', remaining: 120, schedule: 'work', important: true }] });
  assert.equal(r.breaks[0].s, null, 'no room within an hour: it gives way');
  r = schedule({ now: at(mon, 9 * 60), hours, busy, items: [{ key: 'normal', remaining: 60, schedule: 'work' }] });
  assert.ok(r.blocks[0].s >= at('2026-11-24', 0)); assert.equal(r.breaks.length, 0);
});

test('travel time is kept free around an appointment, the appointment stays inside opening hours', () => {
  const now = at(mon, 7 * 60), win = { days: [1, 2, 3, 4, 5], s: '08:00', e: '11:00' };
  const doc = { key: 'doc', remaining: 30, schedule: 'work', win, pad: 15 };
  let r = schedule({ now, hours, busy: [{ s: at(mon, 9 * 60), e: at(mon, 9 * 60 + 30), kind: 'event' }], items: [doc] });
  assert.equal(r.blocks[0].s, at(mon, 9 * 60 + 45), 'leave right after the other appointment, 15 min on the way');
  // only 08:00–08:40 free: travel may start before opening, the visit not
  r = schedule({ now, hours, busy: [{ s: at(mon, 8 * 60 + 40), e: at(mon, 11 * 60), kind: 'event' }], items: [{ ...doc, win: { ...win } }] });
  // 07:45 off, 08:00–08:30 there, back by 08:45: the meeting at 08:40 is in the way → next day, late in the window
  assert.equal(r.blocks[0].s, at('2026-11-24', 10 * 60 + 30));
});

test('loose breaks leave appointments and close short gaps next to them, within an hour', () => {
  const now = at(mon, 7 * 60), ev = (a, b) => ({ s: at(mon, a), e: at(mon, b), kind: 'event' });
  const brk = (id, a, b) => ({ s: at(mon, a), e: at(mon, b), kind: 'fixed', bid: id, soft: true });
  // a meeting until 10:45, lunch at 11:30: lunch moves up to 10:45
  let r = schedule({ now, hours, busy: [ev(600, 645), brk('lunch', 690, 765)], items: [] });
  assert.deepEqual(r.breaks.map(x => [x.id, x.s]), [['lunch', at(mon, 645)]]);
  // dinner 19:30 on an appointment until 20:00: after it
  r = schedule({ now, hours, busy: [ev(1080, 1200), brk('dinner', 1170, 1260)], items: [] });
  assert.deepEqual(r.breaks.map(x => [x.id, x.s]), [['dinner', at(mon, 1200)]]);
  // more than an hour away: stays
  r = schedule({ now, hours, busy: [ev(540, 600), brk('lunch', 690, 765)], items: [] });
  assert.equal(r.breaks.length, 0);
  // a break that has begun stays
  r = schedule({ now: at(mon, 700), hours, busy: [ev(600, 645), brk('lunch', 690, 765)], items: [] });
  assert.equal(r.breaks.length, 0);
});

test('ASAP tasks: breakfast or lunch may be left out, not both; dinner only moves, up to 2 h later', () => {
  const day = { 1: ['07:00', '23:00'] }, h = { work: day };
  const meal = (id, meal, a, b, only) => ({ s: at(mon, a), e: at(mon, b), kind: 'fixed', bid: id, soft: true, meal, only });
  const asap = n => ({ key: 'asap', remaining: n, schedule: 'work', important: true });
  // from 7:00 the whole morning: breakfast 8:00 gives way, lunch has to stay
  let r = schedule({ now: at(mon, 420), hours: h, busy: [meal('b', 'breakfast', 480, 510), meal('l', 'lunch', 720, 780)], items: [asap(8 * 60)] });
  const br = Object.fromEntries(r.breaks.map(x => [x.id, x]));
  assert.equal(br.b?.s, null, 'breakfast left out');
  assert.ok(!br.l || br.l.s != null, 'lunch kept');
  const L = br.l ? [br.l.s, br.l.e] : [at(mon, 720), at(mon, 780)];
  assert.ok(!r.blocks.some(b => b.s < L[1] && b.e > L[0]), 'nothing on lunch');
  // dinner 19:00–20:00 with ASAP work from 18:00 to 21:30: dinner at 21:00 at the latest, never left out
  r = schedule({ now: at(mon, 1080), hours: h, busy: [meal('d', 'dinner', 1140, 1200)], items: [asap(5 * 60)] });
  const d = r.breaks.find(x => x.id === 'd');
  assert.ok(d && d.s != null && d.s <= at(mon, 1260), 'dinner moved, at most 2 h later');
  assert.ok(!r.blocks.some(b => b.s < d.e && b.e > d.s), 'nothing on dinner');
});

test('a break loose only for ASAP tasks stays for appointments and gaps', () => {
  const now = at(mon, 420), ev = { s: at(mon, 600), e: at(mon, 645), kind: 'event' };
  const r = schedule({ now, hours, busy: [ev, { s: at(mon, 690), e: at(mon, 765), kind: 'fixed', bid: 'lunch', soft: true, only: 'asap' }], items: [] });
  assert.equal(r.breaks.length, 0);
});

test('a loose meal may use the default buffer after a meeting, not travel time', () => {
  const now = at(mon, 420), brk = { s: at(mon, 690), e: at(mon, 765), kind: 'fixed', bid: 'lunch', soft: true, meal: 'lunch' };
  const meet = [{ s: at(mon, 600), e: at(mon, 645), kind: 'event' }];
  let r = schedule({ now, hours, busy: [...meet, { s: at(mon, 645), e: at(mon, 660), kind: 'buffer', pad: true }, brk], items: [] });
  assert.equal(r.breaks[0].s, at(mon, 645), 'lunch right after the meeting');
  r = schedule({ now, hours, busy: [...meet, { s: at(mon, 645), e: at(mon, 660), kind: 'buffer', pad: false }, brk], items: [] });
  assert.equal(r.breaks[0].s, at(mon, 660), 'a buffer you set stays free');
});
