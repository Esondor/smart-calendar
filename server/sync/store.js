// Cached events of one calendar: what a sync read is compared with what is stored, and only the difference is written.
// Unchanged events are not touched and keep their id (an open page can still change them).
import { all, run, tx } from '../db.js';

// rows: [{ ext_id, start, end, … }] for the calendar in the range given by where/args ('' = the whole calendar).
// Returns how many events were added, changed or removed.
export function storeEvents(calId, rows, where = '', args = []) {
  const cols = Object.keys(rows[0] || {});
  return tx(() => {
    const have = new Map(), extra = [];
    for (const r of all(`SELECT * FROM events WHERE calendar_id = ?${where ? ' AND ' + where : ''}`, calId, ...args))
      have.has(r.ext_id) ? extra.push(r.id) : have.set(r.ext_id, r);
    let n = 0; const seen = new Set();
    for (const x of rows) {
      if (seen.has(x.ext_id)) continue; seen.add(x.ext_id);
      // not in the range yet: moved here from outside it (that row is reused) or new
      const old = have.get(x.ext_id) || (where ? all('SELECT * FROM events WHERE calendar_id = ? AND ext_id = ? LIMIT 1', calId, x.ext_id)[0] : null);
      if (!old) { run(`INSERT INTO events(calendar_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`, calId, ...cols.map(c => x[c])); n++; continue; }
      have.delete(x.ext_id);
      const diff = cols.filter(c => (old[c] ?? null) !== (x[c] ?? null));
      if (diff.length) { run(`UPDATE events SET ${diff.map(c => c + ' = ?').join(', ')} WHERE id = ?`, ...diff.map(c => x[c]), old.id); n++; }
    }
    for (const id of [...extra, ...[...have.values()].map(r => r.id)]) { run('DELETE FROM events WHERE id = ?', id); n++; }
    return n;
  });
}
