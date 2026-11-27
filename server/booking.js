// Booking: a time with you, found in your plan without showing it.
// - A link for people outside the app (/book/<token>): they see suggested times that fit your plan (never your entries),
//   or ask for a time of their own; suggested times are booked at once, their own times wait for you (notification center).
// - In a shared project: a time when the chosen members are all free, booked for each of them; each keeps or declines it.
// Fit: "best" leaves your planned tasks where they are; "good" moves tasks that can move (not ASAP / High ones);
// appointments, breaks and buffers are never booked over.
import crypto from 'node:crypto';
import { all, get, run, J } from './db.js';
import { settingsOf, membersOf } from './models.js';
import { busyOf, getPlan, markDirty } from './planner.js';
import { addAppt } from './actions.js';
import { notifyUsers } from './bus.js';
import { notify } from './notify.js';
import { sendMail, mailReady } from './mail.js';
import { isoDate, addDays, at, tm, wd, dayStart } from './time.js';
import * as google from './sync/google.js';

const STEP = 15 * 60000;
const ranges = v => !v ? [] : Array.isArray(v[0]) ? v : [v];
const merge = L => L.sort((a, b) => a[0] - b[0]).reduce((o, r) => { const l = o[o.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else o.push([...r]); return o; }, []);
// the hours that may be booked on a day: one set of hours, or all of them together
function hoursOn(s, name, date) {
  const H = s.hours || {}, sets = name === 'all' ? Object.values(H) : [H[name] || H.work || {}];
  return merge(sets.flatMap(h => ranges((h || {})[wd(date)]).map(([a, b]) => [tm(a), tm(b)]))).map(([a, b]) => [at(date, a), at(date, b)]);
}
// what a time means for one person: null = not possible; else how well it fits
function fitFor(uid, s, e, busy, blocks) {
  if (busy.some(b => b.s < e && b.e > s)) return null;
  const hit = blocks.filter(b => b.s < e && b.e > s);
  if (!hit.length) return 'best';
  return hit.every(b => b.pri >= 1.5) ? 'good' : null;   // Medium / Low tasks move; High / ASAP stay
}
function ctx(uid, from, to) {
  const busy = busyOf(uid, from, to).filter(b => b.kind !== 'skipfixed').map(b => ({ s: b.s, e: b.e }));
  const p = getPlan(uid), blocks = (p.blocks || []).filter(b => b.e > from && b.s < to).map(b => ({ s: b.s, e: b.e, pri: p.units[b.key]?.pri ?? p.units[b.key]?.t?.priority ?? 2 }));
  return { busy, blocks, s: settingsOf(uid) };
}
// suggested times: for each person their hours (or all), free of anything fixed; best first, at most `perDay` a day,
// at least an hour apart, earliest days first; urgent: the "good" ones (tasks moved) count as much as the best
export function findSlots(uids, { minutes, days = 21, hours = 'work', notice = 120, now = Date.now(), urgent = false, perDay = 3, max = 24, after = 0, until = 0, win = null }) {
  const need = minutes * 60000, from = Math.max(now + notice * 60000, after || 0), to = until || dayStart(addDays(isoDate(now), days + 1));
  const C = uids.map(u => ctx(u, now, to)), out = [], w = win && Array.isArray(win.days) && win.s && win.e ? win : null;
  for (let d = isoDate(from); dayStart(d) < to && out.length < max; d = addDays(d, 1)) {
    // the hours everyone has that day (hours of each person, intersected)
    // a window of its own (between times, on some days) instead of the hours
    let win = w ? (w.days.includes(wd(d)) ? [[at(d, tm(w.s)), at(d, tm(w.e))]] : []) : hoursOn(C[0].s, hours, d);
    for (const c of w ? [] : C.slice(1)) { const h = hoursOn(c.s, hours, d); win = win.flatMap(([a, b]) => h.map(([x, y]) => [Math.max(a, x), Math.min(b, y)])).filter(([a, b]) => b > a); }
    const day = [];
    for (const [a, b] of win) for (let t = Math.ceil(Math.max(a, from) / STEP) * STEP; t + need <= b; t += STEP) {
      const fits = C.map((c, i) => fitFor(uids[i], t, t + need, c.busy, c.blocks)); if (fits.includes(null)) continue;
      day.push({ s: t, e: t + need, fit: fits.every(f => f === 'best') ? 'best' : 'good' });
    }
    const rank = x => (urgent || x.fit === 'best' ? 0 : 1);
    const pick = [];
    for (const x of day.sort((p, q) => rank(p) - rank(q) || p.s - q.s)) { if (pick.length >= perDay) break; if (pick.every(y => Math.abs(y.s - x.s) >= 3600e3)) pick.push(x); }
    out.push(...pick.sort((p, q) => p.s - q.s));
  }
  return out.slice(0, max);
}
// a time someone asks for themselves: never over something fixed; outside your hours it is possible, but it is a request
export function checkTime(uid, s, e, hours) {
  const c = ctx(uid, s - 864e5, e + 864e5), f = fitFor(uid, s, e, c.busy, c.blocks);
  if (!f) return { ok: false };
  const d = isoDate(s), inHours = hoursOn(c.s, hours, d).some(([a, b]) => s >= a && e <= b);
  return { ok: true, fit: f, inHours };
}

// ---------- the notification center ----------
export function addInbox(uid, kind, title, body = '', data = {}, push = null) {
  const id = Number(run('INSERT INTO inbox(user_id, kind, title, body, data, at) VALUES (?, ?, ?, ?, ?, ?)', uid, kind, title, body, JSON.stringify(data), Date.now()).lastInsertRowid);
  notifyUsers([uid], 'inbox');
  if (push) notify(uid, push, { title, body, url: '/#/now', tag: 'inbox-' + id }).catch(() => {});
  return id;
}
export const inboxOf = uid => all('SELECT * FROM inbox WHERE user_id = ? ORDER BY at DESC LIMIT 200', uid).map(r => ({ ...r, data: J(r.data, {}) }));

// ---------- links for people outside the app ----------
const when = ms => new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const linkOut = l => ({ id: l.id, token: l.token, title: l.title, minutes: J(l.minutes, [30, 60]), days: l.days, hours: l.hours, calendar_id: l.calendar_id, notice: l.notice, active: !!l.active });
export function saveLink(uid, b, id = null) {
  const minutes = JSON.stringify([...new Set((Array.isArray(b.minutes) ? b.minutes : [30, 60]).map(Number).filter(m => m >= 5 && m <= 480))].sort((x, y) => x - y).slice(0, 6));
  const v = [String(b.title || 'Meeting').trim().slice(0, 100) || 'Meeting', minutes === '[]' ? '[30]' : minutes, Math.max(1, Math.min(90, +b.days || 21)), String(b.hours || 'work').slice(0, 40),
    +b.calendar_id || null, Math.max(0, Math.min(7 * 1440, +b.notice || 0)), b.active === false ? 0 : 1];
  if (id) { run('UPDATE booking_links SET title = ?, minutes = ?, days = ?, hours = ?, calendar_id = ?, notice = ?, active = ? WHERE id = ? AND user_id = ?', ...v, id, uid); return id; }
  return Number(run('INSERT INTO booking_links(title, minutes, days, hours, calendar_id, notice, active, user_id, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...v, uid, crypto.randomBytes(12).toString('base64url'), Date.now()).lastInsertRowid);
}
export const linkByToken = t => get('SELECT * FROM booking_links WHERE token = ? AND active = 1', String(t || ''));
// a booking becomes an appointment: in the link's Google calendar, else blocked time in Smart Calendar
async function confirm(b, l) {
  const title = `${l.title}: ${b.name}`, descr = [b.email, b.note].filter(Boolean).join('\n');
  let done = false;
  if (l.calendar_id) { try { await google.createEvent(l.user_id, l.calendar_id, { title, start: b.start, end: b.end, descr }); done = true; } catch { /* below */ } }
  if (!done) addAppt(l.user_id, b.start, b.end, title, 'appt');
  run(`UPDATE bookings SET status = 'confirmed' WHERE id = ?`, b.id);
  markDirty(l.user_id, true);
  if (b.email && mailReady()) sendMail(b.email, `${l.title}: ${when(b.start)}`, `Your time is booked: ${when(b.start)}–${new Date(b.end).toTimeString().slice(0, 5)}.`).catch(() => {});
}
// a guest books: a suggested time at once, their own time as a request
export async function book(l, { name, email, note, start, minutes, own }) {
  const mins = J(l.minutes, [30]).includes(+minutes) ? +minutes : J(l.minutes, [30])[0], s = +start, e = s + mins * 60000;
  if (!(s > Date.now() + l.notice * 60000)) throw Object.assign(new Error('Please choose a later time'), { statusCode: 400 });
  const chk = checkTime(l.user_id, s, e, l.hours);
  if (!chk.ok) throw Object.assign(new Error('This time is no longer free'), { statusCode: 409 });
  const id = Number(run('INSERT INTO bookings(link_id, user_id, name, email, note, start, end, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', l.id, l.user_id,
    String(name).trim().slice(0, 80), email ? String(email).trim().slice(0, 120) : null, note ? String(note).slice(0, 1000) : null, s, e, Date.now()).lastInsertRowid);
  const b = get('SELECT * FROM bookings WHERE id = ?', id);
  // their own time outside your hours waits for you; anything else is booked at once
  if (own && !chk.inHours) {
    addInbox(l.user_id, 'booking', `${b.name} asks for ${when(s)}`, `${l.title} · ${mins} min${b.note ? ' · ' + b.note : ''}`, { booking: id }, 'booking');
    return { status: 'pending' };
  }
  await confirm(b, l);
  addInbox(l.user_id, 'info', `${b.name} booked ${when(s)}`, `${l.title} · ${mins} min${b.note ? ' · ' + b.note : ''}`, { booking: id }, 'booking');
  return { status: 'confirmed', start: s, end: e };
}
export async function answerBooking(uid, id, yes) {
  const b = get(`SELECT * FROM bookings WHERE id = ? AND user_id = ? AND status = 'pending'`, id, uid); if (!b) return false;
  const l = get('SELECT * FROM booking_links WHERE id = ?', b.link_id);
  if (yes) await confirm(b, l);
  else { run(`UPDATE bookings SET status = 'declined' WHERE id = ?`, id); if (b.email && mailReady()) sendMail(b.email, `${l.title}: ${when(b.start)}`, 'Sorry, this time does not work. Please choose another one with the same link.').catch(() => {}); }
  return true;
}

// ---------- a time for several members of a project ----------
export async function bookWith(organizer, { title, members, start, end, calendarId = null, location = null, notes = null }) {
  const who = [...new Set([organizer, ...members])], names = new Map(all(`SELECT id, name FROM users WHERE id IN (${who.map(() => '?').join(',')})`, ...who).map(u => [u.id, u.name]));
  const busy = who.filter(u => !checkTime(u, start, end, 'all').ok);
  if (busy.length) throw Object.assign(new Error(`${busy.map(u => u === organizer ? 'You are' : (names.get(u) || '').split(' ')[0] + ' is').join(', ')} not free then`), { statusCode: 409 });
  const t = String(title || 'Meeting').trim().slice(0, 120) || 'Meeting', org = names.get(organizer) || '';
  let mine = false;
  if (calendarId) { try { await google.createEvent(organizer, calendarId, { title: t, start, end, location: location || null, descr: notes || null }); mine = true; markDirty(organizer, true); } catch { /* below */ } }
  if (!mine) addAppt(organizer, start, end, t, 'appt');
  for (const u of who) if (u !== organizer) {
    const appt = addAppt(u, start, end, t, 'appt');
    addInbox(u, 'hold', `${org} booked “${t}” with you`, when(start) + (location ? ' · ' + location : ''), { appt, organizer, title: t, start }, 'partner');
  }
  return { ok: true };
}
export const bookGroup = (organizer, pid, { title, members, start, end }) => {
  const ok = new Set(membersOf(pid).map(m => m.id));
  return bookWith(organizer, { title, members: members.filter(m => ok.has(m)), start, end });
};
export function answerHold(uid, row, yes) {
  if (yes) return true;
  run(`DELETE FROM appts WHERE id = ? AND user_id = ?`, row.data.appt, uid); markDirty(uid, true);
  const me = get('SELECT name FROM users WHERE id = ?', uid)?.name || '';
  if (row.data.organizer) addInbox(row.data.organizer, 'info', `${me} can't make “${row.data.title}”`, when(row.data.start), {}, 'partner');
  return true;
}
