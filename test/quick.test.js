// Quick add: one line → title, day and time, how long, due date, priority, place (the parser lives in the browser code)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/js/lib.js', import.meta.url), 'utf8');
const parseQuick = new Function(src.slice(src.indexOf('const WDN = '), src.indexOf('// a duration typed freely')).replace('export function parseQuick', 'function parseQuick') + '; return parseQuick;')();
const base = new Date('2026-11-27T19:00:00').getTime();   // a Friday evening
const at = s => new Date(s).getTime();

test('appointments: a day and a time, how long, a place', () => {
  let r = parseQuick('Dentist tue 15:00 1h @Main St 4', base);
  assert.deepEqual([r.kind, r.title, r.start, r.minutes, r.place], ['appt', 'Dentist', at('2026-12-01T15:00'), 60, 'Main St 4']);
  r = parseQuick('Call mum tomorrow 18-18:30', base); assert.deepEqual([r.title, r.start, r.minutes], ['Call mum', at('2026-11-28T18:00'), 30]);
  r = parseQuick('Zahnarzt morgen um 15 Uhr', base); assert.deepEqual([r.title, r.start], ['Zahnarzt', at('2026-11-28T15:00')]);
  r = parseQuick('Gym 3pm', base); assert.equal(r.start, at('2026-11-28T15:00'), 'passed today: tomorrow');
  r = parseQuick('Meeting 12.12. 10:30 45 min', base); assert.deepEqual([r.start, r.minutes], [at('2026-12-12T10:30'), 45]);
});
test('tasks: how long, due, priority, hours; ordinary words stay in the title', () => {
  let r = parseQuick('Tax return by fri 2h !!', base);
  assert.deepEqual([r.kind, r.title, r.minutes, r.due, r.priority], ['task', 'Tax return', 120, at('2026-11-27T00:00'), 1]);
  r = parseQuick('Report bis Mo #work asap', base); assert.deepEqual([r.title, r.due, r.priority, r.hours], ['Report', at('2026-11-30T00:00'), 0, 'work']);
  r = parseQuick('do the dishes so it is clean', base); assert.equal(r.title, 'do the dishes so it is clean'); assert.equal(r.day, undefined);
  assert.equal(parseQuick('Buy milk', base).kind, 'task');
});
