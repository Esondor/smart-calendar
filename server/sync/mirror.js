// Filtered copy of a calendar: events whose title passes the calendar's keyword filter ("Only with" / "Except")
// are copied one-way into a Google calendar of yours, e.g. "Group calendar filtered", with place, notes and call link.
// Hide the full calendar, show the copy.
import { all, get, run } from '../db.js';
import { wordsPass, HIDE_TAG } from '../planner.js';
import { googleApi as api } from './google.js';
import { withLock } from '../lock.js';
import { config } from '../config.js';
import { dayStart, isoDate, addDays } from '../time.js';

const pass = (c, e) => !HIDE_TAG.test(e.title + ' ' + (e.descr || '')) && wordsPass(c, e.title);
const gTime = (ms, allDay) => allDay ? { date: isoDate(ms) } : { dateTime: new Date(ms).toISOString() };

export async function mirrorCalendar(srcId) {
  const src = get('SELECT * FROM calendars WHERE id = ?', srcId); if (!src?.mirror_to) return null;
  const dst = get(`SELECT c.*, a.status AS a_status FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND a.kind = 'google'`, src.mirror_to);
  if (!dst || !dst.writable || dst.a_status !== 'ok') return null;
  const acc = get('SELECT * FROM accounts WHERE id = ?', dst.account_id);
  return withLock('mirror:' + src.id, async () => {
    const from = dayStart(isoDate(Date.now())) - 864e5, to = dayStart(addDays(isoDate(Date.now()), config.sync.farDays + 1));
    const want = new Map();
    for (const e of all('SELECT * FROM events WHERE calendar_id = ? AND end > ? AND start < ? AND ours = 0', src.id, from, to))
      if (pass(src, e)) want.set(e.ext_id, { e, sig: [e.start, e.end, e.all_day, e.title, e.free, e.location || '', e.descr || '', e.link || ''].join('|') });
    const have = new Map(all('SELECT * FROM mirror_events WHERE calendar_id = ?', src.id).map(r => [r.src, r]));
    const path = id => `/calendars/${encodeURIComponent(dst.ext_id)}/events${id ? '/' + encodeURIComponent(id) : ''}`;
    const body = e => ({ summary: e.title, start: gTime(e.start, e.all_day), end: gTime(e.all_day ? Math.max(e.end, e.start + 864e5) : e.end, e.all_day),
      transparency: e.free ? 'transparent' : 'opaque', reminders: { useDefault: false, overrides: [] }, location: e.location || '',
      description: [e.descr, e.link && !String(e.descr || '').includes(e.link) ? e.link : '', `Copy of “${src.name}” [smart-calendar]`].filter(Boolean).join('\n\n'),
      extendedProperties: { private: { sc: '1', mirror: String(src.id) } } });
    let n = 0;
    for (const [k, r] of have) {
      if (want.has(k)) continue;
      const old = get('SELECT start FROM events WHERE calendar_id = ? AND ext_id = ?', src.id, k);
      if (old && old.start < from) continue;     // past: keep the copy
      await api(acc, 'DELETE', path(r.ext_id)).catch(x => { if (x.status !== 404 && x.status !== 410) throw x; });
      run('DELETE FROM mirror_events WHERE calendar_id = ? AND src = ?', src.id, k); n++;
    }
    for (const [k, w] of want) {
      const r = have.get(k);
      if (r && r.sig === w.sig) continue;
      if (r) { try { await api(acc, 'PATCH', path(r.ext_id), body(w.e)); run('UPDATE mirror_events SET sig = ? WHERE calendar_id = ? AND src = ?', w.sig, src.id, k); n++; continue; } catch (x) { if (x.status !== 404 && x.status !== 410) throw x; } }
      const g = await api(acc, 'POST', path(), body(w.e));
      run('INSERT OR REPLACE INTO mirror_events(calendar_id, src, ext_id, sig) VALUES (?, ?, ?, ?)', src.id, k, g.id, w.sig); n++;
    }
    return n;
  });
}
// turning the copy off removes the copied events (the calendar itself stays in Google)
export async function clearMirror(srcId) {
  const src = get('SELECT * FROM calendars WHERE id = ?', srcId), dst = src?.mirror_to && get('SELECT * FROM calendars WHERE id = ?', src.mirror_to);
  if (dst) { const acc = get('SELECT * FROM accounts WHERE id = ?', dst.account_id);
    for (const r of all('SELECT * FROM mirror_events WHERE calendar_id = ?', srcId)) await api(acc, 'DELETE', `/calendars/${encodeURIComponent(dst.ext_id)}/events/${encodeURIComponent(r.ext_id)}`).catch(() => {}); }
  run('DELETE FROM mirror_events WHERE calendar_id = ?', srcId); run('UPDATE calendars SET mirror_to = NULL WHERE id = ?', srcId);
}

// extra copies created by accident (same name, used by nothing, holding only copied events): removed from Google
export async function removeDuplicates(uid) {
  const used = new Set(all('SELECT mirror_to FROM calendars WHERE user_id = ? AND mirror_to IS NOT NULL', uid).map(r => r.mirror_to));
  const names = new Set(all('SELECT name FROM calendars WHERE id IN (' + ([...used].join(',') || '0') + ')').map(r => r.name));
  let n = 0;
  for (const c of all(`SELECT c.* FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.user_id = ? AND a.kind = 'google' AND a.status = 'ok' AND c.writable = 1`, uid)) {
    if (used.has(c.id) || !names.has(c.name) || c.is_plan || c.use_busy) continue;
    if (get('SELECT 1 FROM events WHERE calendar_id = ? AND ours = 0', c.id)) continue;     // has events of its own → not ours to delete
    const acc = get('SELECT * FROM accounts WHERE id = ?', c.account_id);
    await api(acc, 'DELETE', `/calendars/${encodeURIComponent(c.ext_id)}`).catch(x => { if (x.status !== 404 && x.status !== 410) throw x; });
    run('DELETE FROM calendars WHERE id = ?', c.id); n++;
  }
  return n;
}
