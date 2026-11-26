// The order a project is worked through (e.g. the writing order of a thesis), separate from its outline.
// It is a list of phases, each a list of units: a section (with all its items) or a task that is not in a section.
// Kept in project.meta.order = { phases: [{ name, units: [taskId] }] }. The planner fills ordered projects in this order.
// Projects without a saved order (and units added later) fall back to the old plan order (grp, sort).
import { all, get, run, J } from './db.js';

const levelOf = t => t.meta?.level || (t.parent_id ? 'item' : 'chapter');
const metaOf = t => typeof t.meta === 'string' ? J(t.meta, {}) : (t.meta || {});

// the units of a project, in outline order (chapter, then its children)
function unitsOf(rows) {
  const ts = rows.map(r => ({ ...r, meta: metaOf(r) })), by = new Map(ts.map(t => [t.id, t]));
  const kids = id => ts.filter(t => (t.parent_id || null) === id).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const out = [], walk = id => {
    for (const t of kids(id)) {
      const lv = levelOf(t);
      if (lv === 'section') out.push(t);
      else if (lv === 'chapter' && !t.parent_id && (t.meta.level === 'chapter' || ts.some(x => x.parent_id === t.id))) walk(t.id);
      else if (!(t.parent_id && levelOf(by.get(t.parent_id) || {}) === 'section')) out.push(t);
    }
  };
  walk(null);
  return { units: out, by, kids };
}

// the order as it is used: saved phases cleaned up, missing units placed next to their outline neighbour
export function projectOrder(p, rows = all('SELECT * FROM tasks WHERE project_id = ?', p.id)) {
  const meta = metaOf(p), { units, kids } = unitsOf(rows), ids = new Set(units.map(u => u.id));
  let phases;
  const saved = meta.order?.phases;
  if (Array.isArray(saved) && saved.length) {
    const seen = new Set();
    phases = saved.map((ph, i) => ({ name: String(ph?.name || '').slice(0, 80) || `Phase ${i + 1}`, units: (Array.isArray(ph?.units) ? ph.units : []).map(Number).filter(id => ids.has(id) && !seen.has(id) && seen.add(id)) }));
  } else {
    // derived from the old plan order: leaves by (grp, sort); a unit takes the place of its first leaf
    const names = Array.isArray(meta.groups) ? meta.groups.map(g => Array.isArray(g) ? g[0] : typeof g === 'object' ? g?.name : g) : [];
    const leafOf = u => levelOf(u) === 'section' ? kids(u.id) : [u];
    const key = u => { const L = leafOf(u); if (!L.length) return null; const f = L.reduce((a, b) => (a.grp - b.grp || a.sort - b.sort || a.id - b.id) <= 0 ? a : b); return [f.grp, f.sort, f.id]; };
    const keyed = units.map(u => ({ u, k: key(u) })).filter(x => x.k).sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2]);
    const grps = [...new Set(keyed.map(x => x.k[0]))];
    phases = grps.map((g, i) => ({ name: String(names[g] || '').slice(0, 80) || (grps.length > 1 ? `Phase ${i + 1}` : 'Order'), units: keyed.filter(x => x.k[0] === g).map(x => x.u.id) }));
    if (!phases.length) phases = [{ name: 'Order', units: [] }];
  }
  // units not in the order yet (new sections, new tasks): right after the unit before them in the outline
  units.forEach((u, i) => {
    if (phases.some(ph => ph.units.includes(u.id))) return;
    for (let j = i - 1; j >= 0; j--) { const ph = phases.find(x => x.units.includes(units[j].id)); if (ph) { ph.units.splice(ph.units.indexOf(units[j].id) + 1, 0, u.id); return; } }
    const first = phases.find(ph => ph.units.length) || phases[0]; first.units.unshift(u.id);
  });
  return { phases };
}

// rank of each schedulable task of the project in that order (lower = first)
export function orderRanks(p, rows = all('SELECT * FROM tasks WHERE project_id = ?', p.id)) {
  const { phases } = projectOrder(p, rows), rank = new Map();
  const kids = id => rows.filter(t => t.parent_id === id).sort((a, b) => a.sort - b.sort || a.id - b.id);
  let n = 0;
  for (const ph of phases) for (const id of ph.units) {
    const L = kids(id);
    if (!L.length) rank.set(id, n++);
    else for (const t of L) { const sub = kids(t.id); if (sub.length) sub.forEach(x => rank.set(x.id, n++)); else rank.set(t.id, n++); }
  }
  return rank;
}

export function saveOrder(pid, body) {
  const p = get('SELECT * FROM projects WHERE id = ?', pid);
  const ids = new Set(unitsOf(all('SELECT * FROM tasks WHERE project_id = ?', pid)).units.map(u => u.id)), seen = new Set();
  const phases = (Array.isArray(body?.phases) ? body.phases : []).slice(0, 100).map((ph, i) => ({ name: String(ph?.name || '').trim().slice(0, 80) || `Phase ${i + 1}`,
    units: (Array.isArray(ph?.units) ? ph.units : []).map(Number).filter(id => ids.has(id) && !seen.has(id) && seen.add(id)) }));
  if (!phases.length) phases.push({ name: 'Order', units: [] });
  run('UPDATE projects SET meta = ? WHERE id = ?', JSON.stringify({ ...J(p.meta, {}), order: { phases } }), pid);
  return projectOrder({ ...p, meta: JSON.stringify({ ...J(p.meta, {}), order: { phases } }) });
}
