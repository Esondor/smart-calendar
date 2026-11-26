// Project order (writing order): derived from the old plan order, saved as phases, followed by the planner
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-order-'));

const { run, get } = await import('../server/db.js');
const { createUser } = await import('../server/auth.js');
const { projectOrder, saveOrder, orderRanks } = await import('../server/order.js');
const { workUnits, orderUnits } = await import('../server/planner.js');

const uid = createUser({ username: 'jdoe', name: 'Jo', password: 'long password 123' });
const now = Date.now();
const pid = Number(run(`INSERT INTO projects(name, kind, owner_id, created_at, meta) VALUES ('Thesis', 'outline', ?, ?, ?)`, uid, now, JSON.stringify({ groups: ['Methods first', 'Then the rest'] })).lastInsertRowid);
run('INSERT INTO project_members(project_id, user_id) VALUES (?, ?)', pid, uid);
const add = (title, parent, level, grp, sort) => Number(run(`INSERT INTO tasks(project_id, parent_id, title, meta, grp, sort, auto, assignee_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  pid, parent, title, JSON.stringify({ level }), grp, sort, level === 'item' ? 1 : 0, uid, now, now).lastInsertRowid);
const c1 = add('Intro', null, 'chapter', 0, 0), c2 = add('Methods', null, 'chapter', 0, 1);
const s11 = add('Motivation', c1, 'section', 1, 0), s21 = add('Setup', c2, 'section', 0, 0), s22 = add('Analysis', c2, 'section', 0, 1);
const i11 = add('Write motivation', s11, 'item', 1, 10), i21 = add('Describe setup', s21, 'item', 0, 1), i22 = add('Describe analysis', s22, 'item', 0, 2);
const i21b = add('Setup figure', s21, 'item', 0, 3);
const loose = add('Ask supervisor', c1, 'item', 1, 11);
const P = () => get('SELECT * FROM projects WHERE id = ?', pid);
const planOrder = () => orderUnits(workUnits(uid), uid).filter(u => u.t.project_id === pid).map(u => u.t.title);

test('without a saved order: phases from the old plan order, with their names', () => {
  const o = projectOrder(P());
  assert.deepEqual(o.phases.map(ph => ph.name), ['Methods first', 'Then the rest']);
  assert.deepEqual(o.phases.map(ph => ph.units), [[s21, s22], [s11, loose]]);
});

test('a saved order is followed by the planner, items keep their order inside a section', () => {
  saveOrder(pid, { phases: [{ name: 'A', units: [s22, s11] }, { name: 'B', units: [loose, s21] }] });
  assert.deepEqual(planOrder(), ['Describe analysis', 'Write motivation', 'Ask supervisor', 'Describe setup', 'Setup figure']);
  const r = orderRanks(P()); assert.ok(r.get(i22) < r.get(i11) && r.get(i21) < r.get(i21b));
});

test('a new section lands after its outline neighbour; unknown and duplicate ids are dropped', () => {
  const s23 = add('Validation', c2, 'section', 0, 2);
  const o = projectOrder(P());
  assert.deepEqual(o.phases[0].units, [s22, s23, s11], 'after Analysis, the section before it in the outline');
  const saved = saveOrder(pid, { phases: [{ name: 'Only', units: [s21, s21, 999999, c1] }] });
  assert.equal(saved.phases.length, 1);
  assert.ok(saved.phases[0].units.indexOf(s21) < saved.phases[0].units.indexOf(s22), 'what was given keeps its order');
  assert.equal(saved.phases[0].units.filter(x => x === s21).length, 1);
  assert.ok(!saved.phases[0].units.includes(c1), 'a chapter is not a unit');
  assert.equal(saved.phases[0].units.length, 5, 'the units left out are placed again');
});
