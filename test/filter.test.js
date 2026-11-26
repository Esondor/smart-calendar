import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-f-'));
const { blocks, blocksByRule, joinLink } = await import('../server/planner.js');
const ev = (title, c = {}) => ({ title, descr: '', free: 0, use_busy: 1, ...c });

test('keyword filters per calendar', () => {
  const group = { include_words: 'JD, Group', exclude_words: 'MK' };
  assert.equal(blocks(ev('JD Zahnarzt', group)), true);
  assert.equal(blocks(ev('Group dinner', group)), true);
  assert.equal(blocks(ev('Alex Yoga', group)), true, 'unknown → blocks by default');
  assert.equal(blocks(ev('Alex Yoga', { ...group, only_mine: 1 })), false, 'only mine');
  assert.equal(blocks(ev('Spring party', { ...group, only_mine: 1 })), false, 'whole words only');
  assert.equal(blocks(ev('JD + MK Urlaub', group)), true, 'your own words win');
  assert.equal(blocks(ev('MK Urlaub', group)), false, 'only the other people → hidden');
  // boss names things oddly: unknown events block by default; known other people don't; "Only mine" = just my words
  const boss = { include_words: 'JD', exclude_words: 'AD, CD, EF, Robin' };
  assert.equal(blocks(ev('JD, AD - Meeting', boss)), true);
  assert.equal(blocks(ev('AD - Meeting', boss)), false);
  assert.equal(blocks(ev('Meeting', boss)), true, 'everything else blocks');
  assert.equal(blocks(ev('Meeting', { ...boss, only_mine: 1 })), false, 'only mine');
  assert.equal(blocks(ev('MK Termin', { exclude_words: 'mk' })), false, 'case-insensitive');
  assert.equal(blocks(ev('Anything')), true, 'no filter = everything busy');
  assert.equal(blocks(ev('JD Meeting', { ...group, descr: 'agenda\n/hide' })), false, '/hide in the notes wins');
  assert.equal(blocks(ev('Meeting /free', group)), false);
  assert.equal(blocks(ev('Meeting #free', group)), true, '# is no longer a command');
  assert.equal(blocks(ev('JD', { ...group, free: 1 })), false, 'free events never block');
  assert.equal(blocks(ev('JD', { ...group, use_busy: 0 })), false);
});
test.after(() => setTimeout(() => process.exit(0), 50));

test('quoted words are case-sensitive', () => {
  const c = { include_words: '"JD", group', only_mine: 1 };
  assert.equal(blocks(ev('JD Termin', c)), true);
  assert.equal(blocks(ev('jd termin', c)), false, 'quoted = exact case');
  assert.equal(blocks(ev('GROUP dinner', c)), true, 'unquoted = any case');
  assert.equal(blocks(ev('Urlaub MK', { exclude_words: '"MK"' })), false);
  assert.equal(blocks(ev('Pause', { exclude_words: '"MK"' })), true, 'whole words');
  assert.equal(blocks(ev('mk', { exclude_words: '"MK"' })), true, 'lower case not excluded');
});

test('all-day and multi-day rules', () => {
  const D = 864e5, day = { start: 0, end: D, all_day: 1, free: 1 }, trip = { start: 0, end: 3 * D, all_day: 1, free: 1 }, timed = { start: 0, end: 3600e3, free: 1 };
  assert.equal(blocksByRule(ev('Holiday', day), {}), false, 'free all-day: blocks only when busy (default)');
  assert.equal(blocksByRule(ev('Holiday', { ...day, free: 0 }), {}), true);
  assert.equal(blocksByRule(ev('Holiday', day), { allDay: 'always' }), true);
  assert.equal(blocksByRule(ev('Holiday', { ...day, free: 0 }), { allDay: 'never' }), false);
  assert.equal(blocksByRule(ev('Trip', trip), { allDay: 'always' }), false, 'several days follow their own rule');
  assert.equal(blocksByRule(ev('Trip', trip), { multiDay: 'always' }), true);
  assert.equal(blocksByRule(ev('Trip', { ...trip, all_day: 0, free: 0 }), { multiDay: 'never' }), false, 'timed over several days too');
  assert.equal(blocksByRule(ev('Trip /free', trip), { multiDay: 'always' }), false, '/free still wins');
  assert.equal(blocksByRule(ev('Trip', { ...trip, use_busy: 0 }), { multiDay: 'always' }), false, 'calendar not used for busy');
  assert.equal(blocksByRule(ev('Call', timed), { allDay: 'always', multiDay: 'always' }), false, 'normal events unchanged');
});

test('/block and /free in title or notes', () => {
  assert.equal(blocks(ev('Lunch /free')), false);
  assert.equal(blocks(ev('Lunch', { descr: 'see you\n/free' })), false);
  assert.equal(blocks(ev('Focus /block', { free: 1 })), true);
  assert.equal(blocks(ev('Focus', { free: 1, descr: '/block' })), true);
  assert.equal(blocks(ev('https://x.com/free talk')), true, 'not inside a link');
  assert.equal(blocksByRule(ev('Trip /block', { start: 0, end: 3 * 864e5, all_day: 1, free: 1 }), { multiDay: 'never' }), true, 'the event wins over the rule');
});

test('join link: call link, or a meeting link in the place or notes', () => {
  assert.equal(joinLink({ link: 'https://meet.google.com/abc-defg-hij' }), 'https://meet.google.com/abc-defg-hij');
  assert.equal(joinLink({ descr: 'Join here: https://us02web.zoom.us/j/123456?pwd=x. Thanks' }), 'https://us02web.zoom.us/j/123456?pwd=x', 'without the full stop');
  assert.equal(joinLink({ location: 'Microsoft Teams Meeting', descr: '<https://teams.microsoft.com/l/meetup-join/19%3ameeting_x>' }), 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x');
  assert.equal(joinLink({ location: 'Raum 2.14', descr: 'see https://example.com/agenda' }), null, 'ordinary links are no meeting');
  assert.equal(joinLink({ link: 'https://www.google.com/calendar/event?eid=x' }), null);
});
