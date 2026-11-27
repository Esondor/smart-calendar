// Routes of the notification center, booking links (yours and the public page) and group booking in a project.
import { all, get, run } from './db.js';
import { httpErr } from './auth.js';
import { isMember, contactsOf } from './models.js';
import { listClashes, dismissClash, userTag } from './conflicts.js';
import { findSlots, checkTime, inboxOf, answerBooking, answerHold, saveLink, linkOut, linkByToken, book, bookGroup, bookWith } from './booking.js';
import { notifyUsers } from './bus.js';

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

export default async function bookingRoutes(app) {
  // ---------- notification center: requests to answer, clashes, things to know ----------
  const center = uid => ({
    items: inboxOf(uid),
    requests: all(`SELECT r.id, r.created_at, p.name AS project, u.name AS from_name FROM share_requests r JOIN projects p ON p.id = r.project_id JOIN users u ON u.id = r.from_id WHERE r.to_id = ? ORDER BY r.id`, uid),
    clashes: { tag: userTag(uid), items: listClashes(uid) },
  });
  app.get('/api/inbox', async req => center(req.user.id));
  app.post('/api/inbox/:id', async req => {
    const uid = req.user.id, row = get('SELECT * FROM inbox WHERE id = ? AND user_id = ?', +req.params.id, uid); if (!row) throw httpErr(404, 'Not found');
    const r = { ...row, data: JSON.parse(row.data || '{}') }, yes = req.body?.yes !== false;
    if (r.kind === 'booking' && 'yes' in (req.body || {})) await answerBooking(uid, r.data.booking, yes);
    if (r.kind === 'hold' && 'yes' in (req.body || {})) answerHold(uid, r, yes);
    run('DELETE FROM inbox WHERE id = ?', r.id); notifyUsers([uid], 'inbox');
    return center(uid);
  });
  // Clear All: everything that needs no answer goes (clashes are put away as shown); requests to answer stay
  app.post('/api/inbox/clear', async req => {
    const uid = req.user.id;
    run(`DELETE FROM inbox WHERE user_id = ? AND kind NOT IN ('booking', 'hold')`, uid);
    for (const c of listClashes(uid)) await dismissClash(uid, c.key).catch(() => {});
    notifyUsers([uid], 'inbox');
    return center(uid);
  });

  // ---------- your booking links ----------
  app.get('/api/booking-links', async req => all('SELECT * FROM booking_links WHERE user_id = ? ORDER BY id', req.user.id).map(linkOut));
  app.post('/api/booking-links', async req => { const id = saveLink(req.user.id, req.body || {}); return linkOut(get('SELECT * FROM booking_links WHERE id = ?', id)); });
  app.patch('/api/booking-links/:id', async req => {
    const l = get('SELECT * FROM booking_links WHERE id = ? AND user_id = ?', +req.params.id, req.user.id); if (!l) throw httpErr(404, 'Not found');
    saveLink(req.user.id, { ...linkOut(l), ...(req.body || {}) }, l.id); return linkOut(get('SELECT * FROM booking_links WHERE id = ?', l.id));
  });
  app.delete('/api/booking-links/:id', async req => { run('DELETE FROM booking_links WHERE id = ? AND user_id = ?', +req.params.id, req.user.id); return { ok: true }; });

  // ---------- a time for several members of a shared project ----------
  const members = (uid, pid, list) => { if (!isMember(uid, pid)) throw httpErr(404, 'Project not found'); return [...new Set([uid, ...(Array.isArray(list) ? list : []).map(Number)])].filter(u => isMember(u, pid)); };
  app.post('/api/projects/:id/slots', async req => {
    const b = req.body || {}, pid = +req.params.id, who = members(req.user.id, pid, b.members);
    return findSlots(who, { minutes: Math.max(5, Math.min(480, int(b.minutes, 60))), days: Math.max(1, Math.min(60, int(b.days, 14))), hours: String(b.hours || 'all'), notice: 60, urgent: !!b.urgent, perDay: 3, max: 18 });
  });
  app.post('/api/projects/:id/book', async req => {
    const b = req.body || {}, pid = +req.params.id, who = members(req.user.id, pid, b.members), s = int(b.start, 0), e = int(b.end, 0);
    if (!(s > Date.now() && e > s)) throw httpErr(400, 'Invalid time');
    return bookGroup(req.user.id, pid, { title: b.title, members: who, start: s, end: e });
  });

  // ---------- an appointment with people you know (you share a project, or you invited them): their calendars count too ----------
  const people = (uid, list) => { const ok = new Set(contactsOf(uid).map(u => u.id)); const L = [...new Set((Array.isArray(list) ? list : []).map(Number))].filter(u => u !== uid);
    if (L.some(u => !ok.has(u))) throw httpErr(404, 'Not one of your contacts'); return L; };
  app.get('/api/people', async req => contactsOf(req.user.id).filter(u => u.id !== req.user.id).map(u => ({ id: u.id, name: u.name, color: u.color })));
  // is everyone free then? (only yes / no per person, nothing of their calendars)
  app.post('/api/people/check', async req => {
    const b = req.body || {}, L = people(req.user.id, b.members), s = int(b.start, 0), e = int(b.end, 0);
    return { busy: L.filter(u => !checkTime(u, s, e, 'all').ok), meBusy: !checkTime(req.user.id, s, e, 'all').ok };
  });
  app.post('/api/people/slots', async req => {
    const b = req.body || {}, L = people(req.user.id, b.members);
    return findSlots([req.user.id, ...L], { minutes: Math.max(5, Math.min(480, int(b.minutes, 60))), days: Math.max(1, Math.min(60, int(b.days, 21))), hours: String(b.hours || 'all'),
      notice: 30, urgent: !!b.urgent, perDay: int(b.perDay, 3), max: int(b.max, 18), after: int(b.after, 0), until: int(b.until, 0), win: b.win || null });
  });
  app.post('/api/people/book', async req => {
    const b = req.body || {}, L = people(req.user.id, b.members), s = int(b.start, 0), e = int(b.end, 0);
    if (!(s > Date.now() - 60000 && e > s)) throw httpErr(400, 'Invalid time');
    return bookWith(req.user.id, { title: b.title, members: L, start: s, end: e, calendarId: int(b.calendar_id, 0) || null, location: b.location || null, notes: b.notes || null });
  });

  // ---------- the public booking page (no sign-in; only free times, never what is in your calendar) ----------
  const linkOr404 = t => { const l = linkByToken(t); if (!l) throw httpErr(404, 'This link is not active'); return l; };
  app.get('/book/:token', (req, reply) => reply.sendFile('book.html'));
  app.get('/api/book/:token', async req => {
    const l = linkOr404(req.params.token), who = get('SELECT name FROM users WHERE id = ?', l.user_id)?.name || '';
    return { title: l.title, with: who.split(' ')[0], minutes: JSON.parse(l.minutes), days: l.days };
  });
  app.get('/api/book/:token/slots', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async req => {
    const l = linkOr404(req.params.token), mins = JSON.parse(l.minutes), m = mins.includes(+req.query.minutes) ? +req.query.minutes : mins[0];
    return findSlots([l.user_id], { minutes: m, days: l.days, hours: l.hours, notice: l.notice, urgent: req.query.urgent === '1', perDay: 4, max: 40 }).map(x => ({ s: x.s, e: x.e, fit: x.fit }));
  });
  app.post('/api/book/:token', { config: { rateLimit: { max: 8, timeWindow: '1 hour' } } }, async req => {
    const l = linkOr404(req.params.token), b = req.body || {};
    if (!String(b.name || '').trim()) throw httpErr(400, 'Please enter your name');
    if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email))) throw httpErr(400, 'Please check the e-mail address');
    return book(l, { name: b.name, email: b.email, note: b.note, start: int(b.start, 0), minutes: int(b.minutes, 0), own: !!b.own });
  });
}
