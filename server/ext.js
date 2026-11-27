// Token-based access for devices without a login:
//   API tokens (per user)   → /api/ext/*  : Home Assistant, the Mac menu bar
//   Display tokens (admin)  → /api/wall/* : wall-mounted tablet, chosen household members
import { all, get, run, J } from './db.js';
import { randomToken, sha256 } from './crypto.js';
import { httpErr } from './auth.js';
import { audit } from './logs.js';
import { serverConf, setServerConf, baseUrl } from './serverconf.js';
import { recordFailure } from './policy.js';
import { getPlan, parseKey, calendarEvents, joinLink, busyOf, shownBusy, markDirty, winOf } from './planner.js';
import { hiddenEvents } from './conflicts.js';
import { taskById, membersOf, projectIdsFor, projectPlaces, isMember, DEFAULT_PLACES } from './models.js';
import * as A from './actions.js';
import { notify } from './notify.js';
import { bus, notifyUsers } from './bus.js';
import { finishEvent, startEvent } from './eventdone.js';
import * as google from './sync/google.js';
import { defaultProject, createFlexible, eventToTask } from './flex.js';
import { isoDate, dayStart, addDays } from './time.js';

export function newToken(uid, kind, name, users = []) {
  const tok = 'sc_' + randomToken(24);
  run('INSERT INTO api_tokens(user_id, kind, name, token_hash, users, created_at) VALUES (?, ?, ?, ?, ?, ?)', uid, kind, String(name || kind).slice(0, 60), sha256(tok), JSON.stringify(users), Date.now());
  return tok;
}
function tokenFrom(req, kind) {
  const h = req.headers.authorization || '', tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!tok) throw httpErr(401, 'Token required');
  const t = get('SELECT * FROM api_tokens WHERE token_hash = ? AND kind = ?', sha256(tok), kind);
  if (!t) { recordFailure(req.ip, 'token'); throw httpErr(401, 'Invalid token'); }
  const u = get('SELECT * FROM users WHERE id = ? AND disabled = 0', t.user_id);
  if (!u) throw httpErr(401, 'Account disabled');
  if (!t.last_used || Date.now() - t.last_used > 60000) run('UPDATE api_tokens SET last_used = ? WHERE id = ?', Date.now(), t.id);
  return { t, u };
}
// the wall's project(s): the display owner's projects with "Wall display" on (else the one with places). This is the one
// place where everyone sees everyone's tasks, and only the tasks of these projects
export function wallProjects(ownerId) {
  const ps = projectIdsFor(ownerId).map(id => get('SELECT * FROM projects WHERE id = ? AND archived = 0', id)).filter(Boolean);
  const on = ps.filter(p => J(p.meta, {}).wall === true);
  return (on.length ? on : ps.filter(p => projectPlaces(p))).map(p => p.id);
}
const household = uid => [...new Set([uid, ...all('SELECT DISTINCT y.user_id FROM project_members x JOIN project_members y ON x.project_id = y.project_id WHERE x.user_id = ?', uid).map(r => r.user_id)])];

// ---------- day view data shared by the menu bar, Home Assistant and the wall ----------
function dayData(uid, { only = null } = {}) {
  const p = getPlan(uid), now = Date.now(), end = dayStart(addDays(isoDate(now), 1));
  const isHome = u => !only || only.includes(u.t.project_id);
  const inWall = pid => !only || only.includes(pid);
  const item = (u, b) => ({ key: u.key, taskId: u.t.id, period: u.period ?? 0, title: u.t.title, project: u.t.p_name, color: u.t.p_color, location: u.t.location || null,
    duration: u.t.duration, assignee: u.t.assignee_id, rotate: u.t.assign_mode === 'rotate', start: b?.s ?? null, end: b?.e ?? null, overdue: !!u.overdue || !!(p.info[u.key]?.late), recur: !!u.t.recur, followup: !!u.t.source_task });
  const today = [], seen = new Set();
  for (const b of p.blocks) {
    if (b.s >= end) break;
    const u = p.units[b.key]; if (!u || seen.has(b.key) || !isHome(u)) continue;
    seen.add(b.key); today.push(item(u, b));
  }
  // nearby: same location, not today, allowed to start within a week
  const locs = new Set(today.map(i => (i.location || '').toLowerCase()).filter(Boolean));
  const todayIds = new Set(today.map(i => i.taskId));
  const also = Object.values(p.units).filter(u => !seen.has(u.key) && !todayIds.has(u.t.id) && u.t.auto && u.t.location && locs.has(u.t.location.toLowerCase()) && (u.earliest || 0) < now + 7 * 864e5 && isHome(u))
    .map(u => item(u, p.blocks.find(b => b.key === u.key))).filter((x, i, a) => a.findIndex(y => y.taskId === x.taskId) === i);
  const waiting = all(`SELECT t.id, t.title, t.wait_event, t.wait_until, t.location FROM tasks t JOIN project_members m ON m.project_id = t.project_id AND m.user_id = ?
    WHERE t.status != 'done' AND t.wait_event IS NOT NULL AND (t.wait_until IS NULL OR t.wait_until > ?) AND (t.assignee_id = ? OR t.assignee_id IS NULL)`, uid, now, uid).filter(t => inWall(get('SELECT project_id FROM tasks WHERE id = ?', t.id)?.project_id));
  const doneToday = all(`SELECT t.id, t.title, t.location, t.project_id, COALESCE(o.at, t.done_at) AS at FROM tasks t LEFT JOIN occurrences o ON o.task_id = t.id AND o.by = ? AND o.at >= ?
    WHERE ((t.done_by = ? AND t.done_at >= ?) OR o.task_id IS NOT NULL)`, uid, dayStart(isoDate(now)), uid, dayStart(isoDate(now))).filter(t => inWall(t.project_id));
  // every open chore (next occurrence each), for the overview by place
  const chores = [], seenT = new Set();
  for (const u of Object.values(p.units).sort((a, b) => (p.info[a.key]?.first || 9e15) - (p.info[b.key]?.first || 9e15))) {
    if (!u.t.auto || seenT.has(u.t.id) || !isHome(u)) continue;
    const i = p.info[u.key] || {};
    if (i.first && i.first > now + 14 * 864e5) continue;
    seenT.add(u.t.id); chores.push({ ...item(u, i.first ? { s: i.first, e: i.end } : null), late: !!i.late });
  }
  const act = get('SELECT a.task_id, a.period, a.since, t.project_id FROM active a JOIN tasks t ON t.id = a.task_id WHERE a.user_id = ?', uid);
  return { now, today, also, waiting, doneToday, chores, active: act && inWall(act.project_id) ? { task_id: act.task_id, period: act.period, since: act.since } : null };
}

// ---------- agenda for the Mac menu bar: appointments, planned tasks and breaks ----------
// default: today and tomorrow, ended appointments only while not marked done; month (from/to): everything in it, for the calendar
function agenda(uid, { days = 2, from: f, to: t } = {}) {
  const now = Date.now(), month = f != null, p = getPlan(uid);
  const from = month ? f : dayStart(isoDate(now)), to = month ? t : dayStart(addDays(isoDate(now), days));
  const raw = calendarEvents(uid, from, to), hidden = hiddenEvents(uid, raw);
  // copies of an appointment in other calendars ("Also in …"): their colors next to the original
  const copies = new Map();
  for (const e of raw) if (e.dup) { const k = e.dup + '@' + e.start; if (!copies.has(k)) copies.set(k, []); copies.get(k).push({ id: e.calendar_id, name: e.cal, color: e.color || null }); }
  const track = new Map(all('SELECT * FROM event_track WHERE user_id = ?', uid).map(r => [r.calendar_id + ':' + r.ext_id, r]));
  const events = [];
  for (const e of raw) {
    const allDay = !!e.all_day || e.end - e.start >= 864e5, t = track.get(e.calendar_id + ':' + e.ext_id);
    // ended today and not marked done yet: kept for "Done" (a meeting that ran longer)
    if (hidden.has(e.id) || e.start >= to || e.end <= from) continue;
    if (!month && (t?.done_at || (e.end <= now && (allDay || !e.blocks)) || (e.end <= now && !t && e.end < now - 12 * 3600e3))) continue;
    events.push({ id: e.id, calendarId: e.calendar_id, title: e.title, start: e.start, end: e.end, allDay, blocks: !!e.blocks, editable: !!e.editable, cal: e.cal, color: e.color || null, location: e.location || null, join: joinLink(e),
      alsoIn: e.dup ? (copies.get(e.dup + '@' + e.start) || []).filter(c => c.id !== e.calendar_id).map(({ name, color }) => ({ name, color })) : [],
      notes: (e.descr || '').trim().slice(0, 600) || null, since: t?.since ?? null, spent: t ? Math.round(t.spent) : 0, done: !!t?.done_at, travel: e.travel ? { mode: e.travel.mode, min: e.travel.min, before: e.travel.there ? e.before : 0, after: e.travel.home ? e.after : 0 } : null, pin: e.pin || null });
  }
  const tasks = [], pins = new Set(all(`SELECT task_id, period, start FROM overrides WHERE user_id = ? AND kind = 'pin'`, uid).map(o => `${o.task_id}:${o.period}:${Math.round(o.start / 60000)}`));
  for (const b of p.blocks) {
    if (b.s >= to) break; if (b.e <= Math.max(now, from)) continue;
    const u = p.units[b.key]; if (!u) continue;
    tasks.push({ key: b.key, taskId: u.t.id, period: u.period ?? 0, title: u.t.title, project: u.t.p_name, color: u.t.p_color || null, location: u.t.location || null, recur: !!u.t.recur, start: b.s, end: b.e,
      flexible: !!(typeof u.t.meta === 'string' ? J(u.t.meta, {}) : u.t.meta || {}).win, pinned: pins.has(`${u.t.id}:${u.period ?? 0}:${Math.round(b.s / 60000)}`) });
  }
  const a = get('SELECT a.task_id, a.period, a.since, t.title, t.recur FROM active a JOIN tasks t ON t.id = a.task_id WHERE a.user_id = ?', uid);
  const running = a && p.blocks.find(b => p.units[b.key]?.t.id === a.task_id && b.s <= now && b.e > now);
  const breaks = shownBusy(uid, Math.max(from, dayStart(isoDate(now))), to).filter(b => !['event', 'buffer', 'skipfixed'].includes(b.kind) && b.e > from).map(b => ({ title: b.t, start: b.s, end: b.e }));
  // every calendar, to show or leave out in the menu bar; new appointments only go to your own writable ones (not the plan calendar or a calendar that receives filtered copies)
  const calendars = all(`SELECT c.id, c.name, c.color, (c.writable = 1 AND a.kind = 'google' AND c.is_plan = 0 AND c.id NOT IN (SELECT mirror_to FROM calendars WHERE user_id = ? AND mirror_to IS NOT NULL)) AS writable FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.user_id = ? ORDER BY c.name`, uid, uid).map(c => ({ ...c, writable: !!c.writable }));
  // projects for a new task, the one new tasks go to by default first
  const def = defaultProject(uid), projects = projectIdsFor(uid).map(id => get('SELECT id, name, color FROM projects WHERE id = ? AND archived = 0', id)).filter(Boolean).sort((a, b) => (b.id === def) - (a.id === def));
  return { now, events, tasks, breaks, calendars, projects, active: a ? { taskId: a.task_id, period: a.period, title: a.title, recur: !!a.recur, since: a.since, until: running?.e ?? null } : null };
}
const per = req => Math.max(0, +(req.body?.period || 0) || 0);
const ownEvent = (u, id) => { const e = get('SELECT e.*, c.user_id, (c.writable = 1 AND a.kind = \'google\') AS editable FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id WHERE e.id = ?', id); if (!e || e.user_id !== u.id) throw httpErr(404, 'Event not found'); return e; };
const ownTask = (u, id) => { if (!projectIdsFor(u.id).includes(get('SELECT project_id FROM tasks WHERE id = ?', id)?.project_id)) throw httpErr(404, 'Not found'); return id; };

async function release(uid, name) {
  const tasks = A.triggerEvent(household(uid), name);
  for (const t of tasks) notify(t.assignee_id || uid, 'ready', { title: t.title, body: 'Ready now', tag: 'event-' + t.id, url: '/#/now' }).catch(() => {});
  return tasks;
}

export default async function extRoutes(app) {
  // ----- personal API tokens (Settings) -----
  app.get('/api/me/tokens', async req => all(`SELECT id, name, created_at, last_used FROM api_tokens WHERE user_id = ? AND kind = 'api' ORDER BY id`, req.user.id));
  app.post('/api/me/tokens', async req => { const tok = newToken(req.user.id, 'api', req.body?.name || 'Token'); audit(req, 'token.create', String(req.body?.name || '')); return { token: tok }; });
  app.delete('/api/me/tokens/:id', async req => { run(`DELETE FROM api_tokens WHERE id = ? AND user_id = ? AND kind = 'api'`, +req.params.id, req.user.id); audit(req, 'token.delete'); return { ok: true }; });

  // ----- display tokens (Administration) -----
  const admin = req => { if (!req.user?.is_admin) throw httpErr(403, 'Admins only'); };
  app.get('/api/admin/displays', async req => { admin(req); return all(`SELECT d.id, d.name, d.users, d.created_at, d.last_used, u.name AS owner FROM api_tokens d JOIN users u ON u.id = d.user_id WHERE d.kind = 'display' ORDER BY d.id`).map(d => ({ ...d, users: J(d.users, []) })); });
  // Home Assistant: one display link for the token's household (replaces the previous one); its addresses may embed the wall view
  app.post('/api/ext/display', async req => {
    const { u } = tokenFrom(req, 'api');
    run(`DELETE FROM api_tokens WHERE user_id = ? AND kind = 'display' AND name = 'Home Assistant'`, u.id);
    const tok = newToken(u.id, 'display', 'Home Assistant', []);   // [] = everyone in the household, also people added later
    const origins = (Array.isArray(req.body?.origins) ? req.body.origins : []).map(x => { try { const o = new URL(String(x)); return /^https?:$/.test(o.protocol) ? o.origin : null; } catch { return null; } }).filter(Boolean).slice(0, 4);
    let framed = false;
    if (origins.length && u.is_admin) { const cur = serverConf().embedOrigins || []; setServerConf({ embedOrigins: [...new Set([...cur, ...origins])] }); framed = true; }
    else framed = origins.every(o => (serverConf().embedOrigins || []).includes(o));
    audit(req, 'display.create', 'Home Assistant', null, u.id);
    return { url: `${baseUrl()}/wall#key=${tok}`, framed };
  });

  app.post('/api/admin/displays', async req => {
    admin(req);
    const users = (req.body?.users || []).map(Number).filter(id => get('SELECT 1 FROM users WHERE id = ?', id));
    if (!users.length) throw httpErr(400, 'Choose at least one person');
    const tok = newToken(req.user.id, 'display', req.body?.name || 'Wall display', users);
    audit(req, 'display.create', String(req.body?.name || '')); return { token: tok };
  });
  // who a display shows: a fixed list of people, or [] = the household (everyone sharing a project with its owner, also people added later)
  app.put('/api/admin/displays/:id', async req => {
    admin(req);
    const users = (Array.isArray(req.body?.users) ? req.body.users : []).map(Number).filter(id => get('SELECT 1 FROM users WHERE id = ?', id));
    run(`UPDATE api_tokens SET users = ? WHERE id = ? AND kind = 'display'`, JSON.stringify(users), +req.params.id);
    audit(req, 'display.people', users.length ? users.join(',') : 'household'); return { ok: true };
  });
  app.delete('/api/admin/displays/:id', async req => { admin(req); run(`DELETE FROM api_tokens WHERE id = ? AND kind = 'display'`, +req.params.id); audit(req, 'display.delete'); return { ok: true }; });

  // ----- Home Assistant / menu bar (Bearer API token) -----
  app.get('/api/ext/today', async req => { const { u } = tokenFrom(req, 'api'); return { user: { id: u.id, name: u.name }, ...dayData(u.id) }; });
  app.get('/api/ext/agenda', async req => {
    const { u } = tokenFrom(req, 'api'), q = req.query, from = +q.from, to = +q.to;
    if (q.from != null) { if (!(from > 0 && to > from && to - from <= 45 * 864e5)) throw httpErr(400, 'Invalid range'); return agenda(u.id, { from, to }); }
    return agenda(u.id, { days: Math.max(1, Math.min(7, +q.days || 2)) });
  });
  // the Now buttons for the menu bar app
  app.post('/api/ext/tasks/:id/start', async req => { const { u } = tokenFrom(req, 'api'); A.startTimer(u.id, ownTask(u, +req.params.id), per(req)); return { ok: true }; });
  app.post('/api/ext/tasks/:id/more', async req => { const { u } = tokenFrom(req, 'api'); A.addMinutes(u.id, ownTask(u, +req.params.id), Math.max(5, Math.min(240, +req.body?.minutes || 30))); return { ok: true }; });
  app.post('/api/ext/tasks/:id/postpone', async req => { const { u } = tokenFrom(req, 'api'), until = +req.body?.until;
    if (!(until > Date.now() && until < Date.now() + 366 * 864e5)) throw httpErr(400, 'Invalid time');
    A.postpone(u.id, ownTask(u, +req.params.id), per(req), until); return { ok: true }; });
  app.post('/api/ext/tasks/:id/skip', async req => { const { u } = tokenFrom(req, 'api'); A.skipOccurrence(u.id, ownTask(u, +req.params.id), per(req)); return { ok: true }; });
  app.post('/api/ext/timer/stop', async req => { const { u } = tokenFrom(req, 'api'); A.stopTimer(u.id); return { ok: true }; });
  app.post('/api/ext/break', async req => { const { u } = tokenFrom(req, 'api'); A.breakNow(u.id, Math.max(5, Math.min(120, +req.body?.minutes || 15)), req.body?.title === 'Lunch' ? 'Lunch' : 'Break'); return { ok: true }; });
  // appointments: start, pause, done (eventdone.js: the real end, earlier or later than planned, and a new plan from there)
  app.post('/api/ext/events/:id/start', async req => { const { u } = tokenFrom(req, 'api'); return startEvent(u.id, ownEvent(u, +req.params.id)); });
  app.post('/api/ext/events/:id/pause', async req => { const { u } = tokenFrom(req, 'api'); ownEvent(u, +req.params.id); A.pauseEvent(u.id); return { ok: true }; });
  app.post('/api/ext/events/:id/done', async req => { const { u } = tokenFrom(req, 'api'); return finishEvent(u.id, ownEvent(u, +req.params.id), req.body?.end); });
  // + in the menu bar: a task, a fixed appointment, a flexible appointment
  app.post('/api/ext/tasks', async req => {
    const { u } = tokenFrom(req, 'api'), b = req.body || {}, title = String(b.title || '').trim().slice(0, 300);
    if (!title) throw httpErr(400, 'Title missing');
    const pid = projectIdsFor(u.id).includes(+b.project_id) ? +b.project_id : defaultProject(u.id); if (!pid) throw httpErr(400, 'Create a project first');
    const now = Date.now(), id = Number(run(`INSERT INTO tasks(project_id, title, duration, created_by, assignee_id, created_at, updated_at, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      pid, title, Math.max(5, Math.min(480, +b.minutes || 30)), u.id, u.id, now, now, (get('SELECT MAX(sort) AS m FROM tasks WHERE project_id = ?', pid).m || 0) + 1).lastInsertRowid);
    A.touchProject(pid); return { id };
  });
  app.post('/api/ext/events', async req => {
    const { u } = tokenFrom(req, 'api'), b = req.body || {}, start = +b.start, end = +b.end;
    if (!(end > start)) throw httpErr(400, 'End must be after start');
    if (!get('SELECT 1 FROM calendars WHERE id = ? AND user_id = ?', +b.calendar_id, u.id)) throw httpErr(404, 'Calendar not found');
    try { await google.createEvent(u.id, +b.calendar_id, { title: String(b.title || '').trim().slice(0, 300), start, end, all_day: false, location: b.location ? String(b.location).slice(0, 500) : null }); }
    catch (x) { throw httpErr(x.statusCode || 502, x.message); }
    markDirty(u.id, true); return { ok: true };
  });
  app.post('/api/ext/flexible', async req => {
    const { u } = tokenFrom(req, 'api'), b = req.body || {};
    try { return { id: createFlexible(u.id, { title: String(b.title || '').trim(), minutes: +b.minutes || 30, win: b.win && winOf(b.win), calendarId: +b.calendar_id || null, startAfter: b.start_after, location: b.location }) }; }
    catch (x) { throw httpErr(400, x.message); }
  });
  // pin a planned block where it is (the planner leaves it there), unpin it (planned automatically again)
  app.post('/api/ext/tasks/:id/pin', async req => {
    const { u } = tokenFrom(req, 'api'), s0 = +req.body?.start, e0 = +req.body?.end;
    if (!(e0 > s0)) throw httpErr(400, 'Invalid time');
    A.pinBlock(u.id, ownTask(u, +req.params.id), per(req), s0, s0, e0); return { ok: true };
  });
  app.post('/api/ext/tasks/:id/unpin', async req => {
    const { u } = tokenFrom(req, 'api'), id = ownTask(u, +req.params.id);
    run(`DELETE FROM overrides WHERE user_id = ? AND task_id = ? AND period = ? AND kind = 'pin'`, u.id, id, per(req));
    markDirty(u.id, true); notifyUsers([u.id], 'plan'); return { ok: true };
  });
  // a fixed appointment becomes a flexible one: planned automatically, about its old time of day (the web app's Auto-schedule)
  app.post('/api/ext/events/:id/flexible', async req => {
    const { u } = tokenFrom(req, 'api'), e = ownEvent(u, +req.params.id);
    if (!e.editable) throw httpErr(400, 'This calendar is read-only');
    let id; try { id = eventToTask(u.id, e, { kind: 'flex' }); } catch (x) { throw httpErr(400, x.message); }
    try { await google.deleteEvent(u.id, e, 'one'); } catch (x) { if (x.status !== 404 && x.status !== 410) throw httpErr(502, x.message); }
    markDirty(u.id, true); return { id };
  });
  // live updates: one idle connection, a keep-alive line every 50 s (under the usual 60 s proxy timeout); the app fetches the agenda when told
  app.get('/api/ext/stream', async (req, reply) => {
    const { u } = tokenFrom(req, 'api'), ev = 'u:' + u.id;
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = what => reply.raw.write(`data: ${JSON.stringify({ what })}\n\n`);
    bus.on(ev, send); send('hello');
    const ping = setInterval(() => reply.raw.write(': \n\n'), 50000);
    req.raw.on('close', () => { clearInterval(ping); bus.off(ev, send); });
  });
  app.post('/api/ext/event/:name', async req => {
    const { u } = tokenFrom(req, 'api'), tasks = await release(u.id, req.params.name);
    audit({ ip: req.ip, user: u }, 'event', `${req.params.name} → ${tasks.length} task(s)`);
    return { event: req.params.name, released: tasks.map(t => t.title) };
  });
  app.post('/api/ext/tasks/:id/done', async req => {
    const { t, u } = tokenFrom(req, 'api');
    A.setDone(u.id, ownTask(u, +req.params.id), per(req), true, t.name || 'token'); return { ok: true };
  });

  // ----- wall display (Bearer display token) -----
  const wallUser = (req) => {
    const { t } = tokenFrom(req, 'display'), pids = wallProjects(t.user_id), fixed = J(t.users, []);
    const members = [...new Set(pids.flatMap(pid => membersOf(pid).map(m => m.id)))];
    const ids = fixed.length ? fixed.filter(id => members.includes(id)) : members;
    const uid = +req.params.uid; if (req.params.uid && !ids.includes(uid)) throw httpErr(403, 'Not on this display');
    // a task of the wall's projects only
    const task = id => { const x = get('SELECT project_id FROM tasks WHERE id = ?', +id); if (!x || !pids.includes(x.project_id)) throw httpErr(404, 'Not found'); return x; };
    return { t, ids, uid, pids, task };
  };
  app.get('/api/wall', async req => { const { t, ids, pids } = wallUser(req); const places = [...new Set(pids.map(pid => get('SELECT name, meta FROM projects WHERE id = ?', pid)).filter(Boolean).flatMap(p => projectPlaces(p) || []))];
    return { places: places.length ? places : DEFAULT_PLACES, bg: J(get('SELECT settings FROM users WHERE id = ?', t.user_id)?.settings, {}).view?.bg || 'dusk', users: ids.map(id => get('SELECT id, name, color FROM users WHERE id = ? AND disabled = 0', id)).filter(Boolean) }; });
  app.get('/api/wall/:uid', async req => { const { uid, pids } = wallUser(req); return dayData(uid, { only: pids }); });
  app.post('/api/wall/:uid/done', async req => {
    const { uid, task } = wallUser(req), tid = +req.body?.task; task(tid);
    A.setDone(uid, tid, +(req.body?.period || 0), true, 'wall'); return { ok: true };
  });
  app.post('/api/wall/:uid/start', async req => {
    const { uid, task } = wallUser(req), tid = +req.body?.task; task(tid);
    A.startTimer(uid, tid, +(req.body?.period || 0)); return { ok: true };
  });
  app.post('/api/wall/:uid/stop', async req => { const { uid } = wallUser(req); A.stopTimer(uid); return { ok: true }; });
  // add a chore from the display: into the household project (the one with places), for the chosen person
  app.post('/api/wall/:uid/tasks', async req => {
    const { uid, ids, pids } = wallUser(req), b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 200); if (!title) throw httpErr(400, 'Title missing');
    const who = ids.includes(+b.assignee) ? +b.assignee : uid;
    const ps = pids.filter(pid => isMember(who, pid)).map(pid => get('SELECT * FROM projects WHERE id = ?', pid)).filter(Boolean);
    const p = ps.find(p => projectPlaces(p)) || ps[0];
    if (!p) throw httpErr(400, 'No wall project');
    const now = Date.now(), dur = Math.max(5, Math.min(480, +b.duration || 15));
    const id = Number(run(`INSERT INTO tasks(project_id, title, duration, location, assignee_id, created_by, created_at, updated_at, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id, title, dur, String(b.location || '').slice(0, 60) || null, who, uid, now, now, (get('SELECT MAX(sort) AS m FROM tasks WHERE project_id = ?', p.id).m || 0) + 1).lastInsertRowid);
    A.touchProject(p.id); return { ok: true, id };
  });
  // hand a chore to someone else on this display
  app.post('/api/wall/:uid/assign', async req => {
    const { ids, task } = wallUser(req), tid = +req.body?.task, to = +req.body?.user, t = task(tid);
    if (!ids.includes(to) || !isMember(to, t.project_id)) throw httpErr(404, 'Not found');
    run(`UPDATE tasks SET assignee_id = ?, assign_mode = 'fixed', updated_at = ? WHERE id = ?`, to, Date.now(), tid); A.touchProject(t.project_id); return { ok: true };
  });
  app.post('/api/wall/:uid/later', async req => {
    const { uid, task } = wallUser(req), tid = +req.body?.task; task(tid);
    A.postpone(uid, tid, +(req.body?.period || 0), Date.now() + 3 * 3600e3); return { ok: true };
  });
  app.post('/api/wall/:uid/ready', async req => {
    const { task } = wallUser(req), tid = +req.body?.task, t = task(tid);
    run('UPDATE tasks SET wait_event = NULL, wait_until = ? WHERE id = ?', Date.now(), tid); A.touchProject(t.project_id); return { ok: true };
  });
}
