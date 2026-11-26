// Clashes: an event of a group calendar (a calendar with "Only with" words, e.g. the team calendar) overlaps a blocking
// event of your own. You decide which one wins. "#JD-blocked" (your tag) is written into the notes of the one that loses:
// the group event when your own wins (the others see you can't come), your own event when the group event wins.
// Choosing the other one moves the note. That needs a Google calendar you may edit; an Exchange/ICS link is read-only.
// Until you decide: the event ranked higher wins (Settings → Calendars → Ranking; outside work hours your own events
// rank first; each event can be moved in its sheet), but on a day with "JD Holiday" your own event does.
import { all, get, run } from './db.js';
import { settingsOf } from './models.js';
import { calendarEvents, wordsMatcher, eventRanker } from './planner.js';
import { googleApi } from './sync/google.js';
import { notify } from './notify.js';
import { isoDate, dayStart, addDays, hm, minOfDay } from './time.js';
import { syslog } from './logs.js';

const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOLIDAY = /\b(holidays?|urlaub|vacation|ferien|abwesend|ooo|out of office)\b/i;
const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// your short tag for what the app writes into shared calendars (JD → #JD-blocked)
export function userTag(uid, s = settingsOf(uid)) {
  const own = String(s.plan.tag || '').trim().replace(/[^\p{L}\p{N}_-]/gu, '');
  if (own) return own;
  for (const c of all(`SELECT include_words FROM calendars WHERE user_id = ? AND include_words != ''`, uid)) {
    const w = c.include_words.split(',').map(x => x.trim().replace(/^"|"$/g, '')).find(x => /^[\p{L}\p{N}_-]+$/u.test(x));
    if (w) return w;
  }
  const u = get('SELECT username, name FROM users WHERE id = ?', uid) || {};
  return initials(u.name) || String(u.username || 'me').toUpperCase();
}
// "Jane van Doe" → JVD; one word: its first two letters (Jane → JA)
export function initials(name) {
  const w = String(name || '').trim().split(/[\s.-]+/).map(x => x.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  return (w.length > 1 ? w.map(x => x[0]).join('').slice(0, 4) : (w[0] || '').slice(0, 2)).toUpperCase();
}
export const markerOf = tag => `#${tag}-blocked`;
const markerRe = tag => new RegExp(`(^|\\n)[ \\t]*${esc(markerOf(tag))}[ \\t]*(?=\\n|$)`, 'gi');
export const withMarker = (desc, tag, on) => {
  const clean = String(desc || '').replace(markerRe(tag), '').replace(/\n{3,}/g, '\n\n').trim();
  return on ? (clean ? clean + '\n\n' : '') + markerOf(tag) : clean;
};

const holidayOn = (evs, tag, ms) => {
  const isTag = wordsMatcher(tag), d0 = dayStart(isoDate(ms)), d1 = dayStart(addDays(isoDate(ms), 1));
  return evs.some(e => (e.all_day || e.end - e.start >= 864e5) && e.start < d1 && e.end > d0 && HOLIDAY.test(e.title) && isTag.test(e.title));
};

// the same appointment kept on purpose in two calendars (e.g. the group calendar and the one shared with your partner):
// similar title (your tag and filter words left out) and start and end within 15 minutes → not a clash
const norm = (t, drop) => { let s = String(t || '').toLowerCase(); for (const w of drop) s = s.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w.toLowerCase())}(?![\\p{L}\\p{N}])`, 'gu'), ' '); return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); };
export function sameAppointment(a, b, drop = []) {
  if (Math.abs(a.start - b.start) > 15 * 60000 || Math.abs(a.end - b.end) > 15 * 60000) return false;
  const x = norm(a.title, drop), y = norm(b.title, drop);
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))));
}
// the clashes right now: one per group event, with the first own event it overlaps
export function findClashes(uid, now = Date.now(), s = settingsOf(uid)) {
  const groupCals = new Set(all(`SELECT id FROM calendars WHERE user_id = ? AND include_words != ''`, uid).map(r => r.id));
  if (!groupCals.size) return [];
  const copies = new Set(all('SELECT mirror_to FROM calendars WHERE user_id = ? AND mirror_to IS NOT NULL', uid).map(r => r.mirror_to));
  const to = dayStart(addDays(isoDate(now), Math.max(2, s.plan.days || 14)));
  const evs = calendarEvents(uid, now, to, s), tag = userTag(uid, s), rankOf = eventRanker(uid, s);
  const drop = [tag, ...all(`SELECT include_words FROM calendars WHERE user_id = ? AND include_words != ''`, uid).flatMap(c => c.include_words.split(',').map(w => w.trim().replace(/^"|"$/g, '')).filter(Boolean))];
  const group = evs.filter(e => groupCals.has(e.calendar_id) && e.timed && e.blocks && e.end > now);
  const mine = evs.filter(e => !groupCals.has(e.calendar_id) && !copies.has(e.calendar_id) && e.timed && e.blocks);
  const out = [];
  for (const g of group) {
    const m = mine.find(x => x.start < g.end && x.end > g.start && !(g.dup && g.dup === x.dup) && !sameAppointment(g, x, drop)); if (!m) continue;
    const holiday = holidayOn(evs, tag, g.start), higher = rankOf(g) <= rankOf(m);
    out.push({ key: `${g.calendar_id}:${g.ext_id}`, g, m, def: higher && !holiday ? 'work' : 'mine', higher, holiday });
  }
  return out;
}

// write / remove the marker in one event's notes (Google calendars you may edit)
async function setMarker(uid, calId, extId, on) {
  if (!calId || !extId) return false;
  const cal = get(`SELECT c.*, a.kind, a.status FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?`, calId);
  if (!cal || cal.kind !== 'google' || !cal.writable || cal.status !== 'ok') return false;
  const acc = get('SELECT * FROM accounts WHERE id = ?', cal.account_id), tag = userTag(uid);
  const path = `/calendars/${encodeURIComponent(cal.ext_id)}/events/${encodeURIComponent(extId)}`;
  const ev = await googleApi(acc, 'GET', path);
  const desc = withMarker(ev.description, tag, on);
  if (desc !== String(ev.description || '').trim() && (on || markerRe(tag).test(ev.description || ''))) await googleApi(acc, 'PATCH', path, { description: desc });
  run('UPDATE events SET descr = ? WHERE calendar_id = ? AND ext_id = ?', desc.slice(0, 2000), calId, extId);
  return true;
}
// the note goes into the loser: the group event when yours wins ('mine'), yours when the group event wins ('work'), none for 'same'
async function apply(uid, row, choice) {
  const flip = async (cal, ext, want, was) => {
    if (!!was === want) return was ? 1 : 0;
    try { if (await setMarker(uid, cal, ext, want)) return want ? 1 : 0; } catch (e) { syslog('warn', 'clash', `calendar note: ${e.message}`, uid); }
    return was ? 1 : 0;
  };
  const off = choice !== 'mine', mOff = choice !== 'work';      // take a note away first, then write the other
  let marked = row.marked, m_marked = row.m_marked;
  if (off) marked = await flip(row.g_cal, row.g_ext, false, marked);
  if (mOff) m_marked = await flip(row.m_cal, row.m_ext, false, m_marked);
  if (!off) marked = await flip(row.g_cal, row.g_ext, true, marked);
  if (!mOff) m_marked = await flip(row.m_cal, row.m_ext, true, m_marked);
  run('UPDATE conflicts SET choice = ?, marked = ?, m_marked = ? WHERE user_id = ? AND key = ?', choice, marked, m_marked, uid, row.key);
  return { ...row, choice, marked, m_marked };
}
const writable = calId => !!get(`SELECT 1 FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND a.kind = 'google' AND c.writable = 1`, calId);

export async function checkClashes(uid, now = Date.now()) {
  const s = settingsOf(uid), found = findClashes(uid, now, s), tag = userTag(uid, s);
  const have = new Map(all('SELECT * FROM conflicts WHERE user_id = ?', uid).map(r => [r.key, r]));
  for (const c of found) {
    let row = have.get(c.key); have.delete(c.key);
    if (!row) {
      run(`INSERT INTO conflicts(user_id, key, g_cal, g_ext, g_title, m_title, m_cal, m_ext, start, end, choice, by_me, marked, notified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, 0)`,
        uid, c.key, c.g.calendar_id, c.g.ext_id, c.g.title, c.m.title, c.m.calendar_id, c.m.ext_id, c.g.start, c.g.end);
      row = get('SELECT * FROM conflicts WHERE user_id = ? AND key = ?', uid, c.key);
    } else {
      // now overlapping another own event: the note leaves the old one
      if (row.m_marked && (row.m_cal !== c.m.calendar_id || row.m_ext !== c.m.ext_id)) { try { await setMarker(uid, row.m_cal, row.m_ext, false); } catch {} row.m_marked = 0; }
      run('UPDATE conflicts SET g_title = ?, m_title = ?, m_cal = ?, m_ext = ?, start = ?, end = ?, m_marked = ? WHERE user_id = ? AND key = ?', c.g.title, c.m.title, c.m.calendar_id, c.m.ext_id, c.g.start, c.g.end, row.m_marked, uid, c.key);
      row = { ...row, m_cal: c.m.calendar_id, m_ext: c.m.ext_id };
    }
    const choice = row.by_me ? row.choice : c.def;
    // automatic or yours: the note sits in the loser (also written when it was missing, e.g. the calendar became editable)
    if (choice && (choice !== row.choice || !!row.marked !== (choice === 'mine' && writable(c.g.calendar_id)) || !!row.m_marked !== (choice === 'work' && writable(c.m.calendar_id))))
      row = await apply(uid, { ...row, g_title: c.g.title, m_title: c.m.title }, choice);
    if (!row.notified) {
      run('UPDATE conflicts SET notified = 1 WHERE user_id = ? AND key = ?', uid, c.key);
      const when = `${DN[new Date(c.g.start).getDay()]} ${hm(minOfDay(c.g.start))}`, noted = c.def === 'work' ? row.m_marked : row.marked;
      const why = `${c.def === 'work' ? c.g.title : c.m.title} wins${c.def === 'mine' && c.holiday ? ' (holiday)' : ''}${noted ? `, ${markerOf(tag)} noted in ${c.def === 'work' ? c.m.title : c.g.title}` : ''}`;
      await notify(uid, 'clash', { title: `Clash ${when}: ${c.g.title} · ${c.m.title}`, body: `${why}.`, tag: 'clash:' + c.key, url: '/#/now', mailExtra: 'Change it on the Now page under Clashes:',
        actions: [{ action: 'clash-work', title: c.g.title.slice(0, 24) }, { action: 'clash-mine', title: c.m.title.slice(0, 24) }], clash: c.key }).catch(() => {});
    }
  }
  // gone (moved, deleted, no longer overlapping): take the note back; finished ones are kept as they are
  for (const r of have.values()) {
    if (r.end > now && r.marked) { try { await setMarker(uid, r.g_cal, r.g_ext, false); } catch {} }
    if (r.end > now && r.m_marked) { try { await setMarker(uid, r.m_cal, r.m_ext, false); } catch {} }
    run('DELETE FROM conflicts WHERE user_id = ? AND key = ?', uid, r.key);
  }
}

// put a clash away: your choice (or the one shown) stays, both events stay, it is not shown or asked again.
// same = it's one appointment in two calendars: no "#TAG-blocked" note (taken back if it was written)
export async function dismissClash(uid, key, same = false) {
  const row = get('SELECT * FROM conflicts WHERE user_id = ? AND key = ?', uid, key);
  if (!row) return null;
  if (same) await apply(uid, row, 'same'); else if (!row.choice) await apply(uid, row, 'work');
  run(`UPDATE conflicts SET dismissed = 1, by_me = 1, notified = 1${same ? ", choice = 'same'" : ''} WHERE user_id = ? AND key = ?`, uid, key);
  return true;
}
// bring a dismissed clash back (Show Again in the event's sheet)
export function undismissClash(uid, calId, extId) {
  run(`UPDATE conflicts SET dismissed = 0, by_me = CASE WHEN choice = 'same' THEN 0 ELSE by_me END, choice = CASE WHEN choice = 'same' THEN '' ELSE choice END
    WHERE user_id = ? AND dismissed = 1 AND ((g_cal = ? AND g_ext = ?) OR (m_cal = ? AND m_ext = ?))`, uid, calId, extId, calId, extId);
}
// Events you put aside: hidden in Smart Calendar for you, never removed from their calendar (others may need them).
// The loser of a dismissed clash, and the group copy of an appointment you also keep in your own calendar.
export function hiddenEvents(uid, evs, s = settingsOf(uid)) {
  const out = new Set(), key = (c, x) => c + ':' + x;
  for (const r of all('SELECT g_cal, g_ext, m_cal, m_ext, choice FROM conflicts WHERE user_id = ? AND dismissed = 1', uid))
    out.add(r.choice === 'work' ? key(r.m_cal, r.m_ext) : key(r.g_cal, r.g_ext));
  const groupCals = new Set(all(`SELECT id FROM calendars WHERE user_id = ? AND include_words != ''`, uid).map(r => r.id));
  if (groupCals.size) {
    const tag = userTag(uid, s), drop = [tag, ...all(`SELECT include_words FROM calendars WHERE user_id = ? AND include_words != ''`, uid).flatMap(c => c.include_words.split(',').map(w => w.trim().replace(/^"|"$/g, '')).filter(Boolean))];
    const own = evs.filter(e => !groupCals.has(e.calendar_id));
    for (const g of evs) if (groupCals.has(g.calendar_id) && own.some(m => m.start < g.end && m.end > g.start && sameAppointment(g, m, drop))) out.add(key(g.calendar_id, g.ext_id));
  }
  // copies made with "Also in …": the original stays visible (it keeps its calendar's color), the copies are hidden
  const byDup = new Map();
  for (const e of evs) if (e.dup) { if (!byDup.has(e.dup + '@' + e.start)) byDup.set(e.dup + '@' + e.start, []); byDup.get(e.dup + '@' + e.start).push(e); }
  for (const L of byDup.values()) if (L.length > 1) { const orig = e => e.dup === `${e.calendar_id}:${e.ext_id}` || e.dup === `${e.calendar_id}:${e.series}`;
    L.sort((a, b) => (orig(b) - orig(a)) || (groupCals.has(a.calendar_id) - groupCals.has(b.calendar_id)) || (a.calendar_id - b.calendar_id)); L.slice(1).forEach(e => out.add(key(e.calendar_id, e.ext_id))); }
  return new Set(evs.filter(e => out.has(key(e.calendar_id, e.ext_id))).map(e => e.id));
}
export async function decideClash(uid, key, choice) {
  const row = get('SELECT * FROM conflicts WHERE user_id = ? AND key = ?', uid, key);
  if (!row) return null;
  run('UPDATE conflicts SET by_me = 1 WHERE user_id = ? AND key = ?', uid, key);
  return apply(uid, { ...row, by_me: 1 }, choice === 'mine' ? 'mine' : 'work');
}
export const listClashes = (uid, now = Date.now()) => all(`SELECT k.key, k.g_cal, k.g_ext, k.g_title, k.m_cal, k.m_ext, k.m_title, k.start, k.end, k.choice, k.by_me, k.marked, k.m_marked, g.name AS g_name, m.name AS m_name
    FROM conflicts k LEFT JOIN calendars g ON g.id = k.g_cal LEFT JOIN calendars m ON m.id = k.m_cal WHERE k.user_id = ? AND k.end > ? AND k.dismissed = 0 ORDER BY k.start`, uid, now)
  .map(r => ({ ...r, writable: writable(r.g_cal) }));

export async function clashTick() {
  for (const u of all(`SELECT DISTINCT user_id FROM calendars WHERE include_words != ''`)) await checkClashes(u.user_id).catch(e => syslog('warn', 'clash', e.message, u.user_id));
}
