import { learnBaseUrl, baseUrl } from './serverconf.js';
import { audit } from './logs.js';
import { needs2fa } from './policy.js';
import { all, get, run, tx, J } from './db.js';
import { encrypt } from './crypto.js';
import { httpErr } from './auth.js';
import { settingsOf, saveSettings, publicUser, allUsers, contactsOf, projectIdsFor, isMember, membersOf, projectRow, taskRow, taskById, canEditTask, logActivity } from './models.js';
import { getPlan, markDirty, usersOfProject, parseKey, keyOf, assigneeOf, busyOf, shownBusy, calendarEvents, joinLink, eventRanker, winOf, missedStart, openEnd } from './planner.js';
import * as A from './actions.js';
import { bus, notifyUsers } from './bus.js';
import * as google from './sync/google.js';
import * as mirror from './sync/mirror.js';
import { withLock } from './lock.js';
import { normalizeUrl } from './sync/ics.js';
import { vikunjaUser, docFiles, attachment, forgetFiles, uploadFile } from './sync/vikunja.js';
import { syncAccount } from './sync/loop.js';
import { vapidPublicKey, sendPush } from './push.js';
import { finishEvent, startEvent, trackedEnds } from './eventdone.js';
import { listClashes, decideClash, dismissClash, undismissClash, hiddenEvents, userTag } from './conflicts.js';
import { mailReady, sendMail } from './mail.js';
import { notify, NOTIFY_TYPES } from './notify.js';
import { findSlot, rulesOf, ruleOf } from './reschedule.js';
import { eventToTask, createFlexible } from './flex.js';
import { projectOrder, saveOrder } from './order.js';
import * as maps from './maps.js';
import { homeChanged, refreshTravel, resolvePin } from './travel.js';
import { restoreBackup } from './restore.js';
import { periodOf, isoDate, dayStart, addDays } from './time.js';

const int = (v, d = null) => (v === null || v === '' || v === undefined || isNaN(+v)) ? d : Math.round(+v);
const dateOrNull = v => v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
const str = (v, n = 500) => String(v ?? '').slice(0, n);
const COLOR = /^#[0-9a-f]{6}$/i;

function needProject(uid, pid) { if (!isMember(uid, +pid)) throw httpErr(404, 'Project not found'); return +pid; }
function needTask(uid, tid) { const pid = canEditTask(uid, +tid); if (!pid) throw httpErr(404, 'Task not found'); return taskById(+tid); }

// planned time for a task: from its assignee's plan (shared projects show the partner's slot too)
function schedInfo(t, plans) {
  const planOf = uid => { if (!plans.has(uid)) { try { plans.set(uid, getPlan(uid)); } catch { plans.set(uid, null); } } return plans.get(uid); };
  if (t.status === 'done') return null;
  const uids = t.recur ? membersOf(t.project_id).map(m => m.id) : [assigneeOf(t)];
  let best = null;
  for (const uid of uids) {
    const p = planOf(uid); if (!p) continue;
    for (const [k, u] of Object.entries(p.units)) {
      if (u.t.id !== t.id) continue;
      const i = p.info[k] || {};
      const cand = { key: k, period: u.period, user: uid, first: i.first, end: i.end, late: i.late, unplaced: i.unplaced, deadline: u.deadline, overdue: !!u.overdue, periodStart: u.periodStart, periodEnd: u.periodEnd, remaining: Math.max(0, (u.t.duration || 0) - u.spent) };
      if (!best || (cand.first || Infinity) < (best.first || Infinity)) best = cand;
    }
  }
  return best;
}
function taskOut(t, plans) {
  const o = { ...t, sched: schedInfo(t, plans) };
  if (t.recur) {
    o.recur.anchor = o.recur.anchor || isoDate(t.created_at);
    const p0 = periodOf(o.recur, isoDate(Date.now()));
    o.occ = all('SELECT period, status, at, by FROM occurrences WHERE task_id = ? AND period >= ? ORDER BY period', t.id, p0 - 8);
    o.period = p0;
  }
  return o;
}
const TASK_FIELDS = {
  title: v => str(v, 300).trim() || 'Untitled', location: v => str(v, 60).trim() || null, notes: v => str(v, 20000), priority: v => Math.max(0, Math.min(3, int(v, 2))),
  duration: v => Math.max(5, Math.min(24 * 60, int(v, 30))), min_chunk: v => v == null || v === '' ? null : Math.max(5, Math.min(480, int(v, 30))),
  deadline: dateOrNull, start_after: dateOrNull, schedule: v => v ? str(v, 40) : null, auto: v => v ? 1 : 0, col: v => Math.max(0, int(v, 0)),
  sort: v => +v || 0, grp: v => int(v, 0), assign_mode: v => v === 'rotate' ? 'rotate' : 'fixed', parent_id: v => int(v, null),
  points: v => JSON.stringify((Array.isArray(v) ? v : []).slice(0, 200).map(p => ({ t: str(p.t, 500), done: !!p.done }))),
  meta: v => JSON.stringify(v && typeof v === 'object' ? v : {}),
  recur: v => {
    if (!v || !v.freq) return null;
    const r = { freq: ['day', 'week', 'month'].includes(v.freq) ? v.freq : 'week', every: Math.max(1, Math.min(52, int(v.every, 1))),
      anchor: dateOrNull(v.anchor) || isoDate(Date.now()), days: (Array.isArray(v.days) ? v.days : []).map(Number).filter(d => d >= 0 && d <= 6),
      window: ['any', 'morning', 'afternoon', 'evening'].includes(v.window) ? v.window : 'any', until: dateOrNull(v.until) };
    return JSON.stringify(r);
  },
};
function taskPatch(body, t) {
  const set = {};
  for (const [k, f] of Object.entries(TASK_FIELDS)) if (k in body) set[k] = f(body[k]);
  if ('status' in body && ['todo', 'doing'].includes(body.status)) set.status = body.status;
  if ('assignee_id' in body) set.assignee_id = body.assignee_id ? int(body.assignee_id) : null;
  return set;
}

export default async function apiRoutes(app) {
  // ---------- bootstrap ----------
  app.get('/api/bootstrap', async req => { if (req.user.is_admin) learnBaseUrl(req); return {
    me: publicUser(req.user), mail: mailReady(), maps: maps.mapsReady(), settings: settingsOf(req.user), users: req.user.is_admin ? allUsers() : contactsOf(req.user.id),
    google: google.enabled(), vapid: vapidPublicKey(), baseUrl: baseUrl(), version: '1.2.0',
    hasAccounts: !!get('SELECT 1 FROM accounts WHERE user_id = ?', req.user.id), must2fa: needs2fa(req.user),
  }; });
  app.put('/api/settings', async req => {
    const cur = settingsOf(req.user), b = req.body || {};
    const next = { ...cur };
    for (const k of ['hours', 'fixed', 'chunk', 'dFree', 'horizonDays', 'plan', 'notify', 'view', 'dSub', 'onboarded']) if (k in b) next[k] = b[k];
    next.chunk = Math.max(5, Math.min(240, int(next.chunk, 30))); next.horizonDays = Math.max(14, Math.min(120, int(next.horizonDays, 62)));
    if (next.notify) {
      const ch = {}; for (const [k, v] of Object.entries(next.notify.ch || {})) if (NOTIFY_TYPES.includes(k) && ['off', 'push', 'email', 'both'].includes(v)) ch[k] = v;
      next.notify.ch = ch;
      for (const k of ['before', 'eventBefore']) if (k in next.notify) next.notify[k] = Math.max(0, Math.min(120, int(next.notify[k], 5)));
      if ('morning' in next.notify && next.notify.morning && !/^\d\d:\d\d$/.test(next.notify.morning)) next.notify.morning = '07:30';
    }
    if (next.plan) { next.plan.days = Math.max(1, Math.min(60, int(next.plan.days, 14))); next.plan.eventBuffer = Math.max(0, Math.min(120, int(next.plan.eventBuffer, 15)));
      if ('home' in next.plan) { const h = next.plan.home; next.plan.home = h && h.address ? { address: String(h.address).slice(0, 300), lat: +h.lat || null, lng: +h.lng || null } : null;
        // a typed address (not picked from the suggestions): Google Maps finds it, so suggestions are near home too
        const H = next.plan.home; if (H && H.lat == null && maps.mapsReady()) { const f = await maps.locate(H.address).catch(() => null); if (f) Object.assign(H, f); } }
      // place rules: a room code pattern → the place you go to (travel.js)
      if ('places' in next.plan) next.plan.places = (Array.isArray(next.plan.places) ? next.plan.places : []).slice(0, 30)
        .map(r => ({ match: String(r?.match || '').trim().slice(0, 100), place: String(r?.place || '').trim().slice(0, 300), lat: Number.isFinite(+r?.lat) && r?.lat !== null && r?.lat !== '' ? +r.lat : null, lng: Number.isFinite(+r?.lng) && r?.lng !== null && r?.lng !== '' ? +r.lng : null }));
      // a pasted Google Maps link or "lat, lng" becomes the pin; the place keeps a name
      for (const r of next.plan.places || []) {
        if (!/^https?:\/\/|^-?\d+\.\d+\s*,/.test(r.place)) { if (r.lat == null || r.lng == null || Math.abs(r.lat) > 90 || Math.abs(r.lng) > 180) { r.lat = r.lng = null; } continue; }
        const x = await resolvePin(r.place).catch(() => ({}));
        if (x.pin) { r.lat = x.pin.lat; r.lng = x.pin.lng; r.place = x.name || `${x.pin.lat.toFixed(5)}, ${x.pin.lng.toFixed(5)}`; } else r.lat = r.lng = null;
      }
      if ('bikeMax' in next.plan) next.plan.bikeMax = Math.max(0, Math.min(90, int(next.plan.bikeMax, 25)));
      if ('tag' in next.plan) next.plan.tag = String(next.plan.tag || '').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 12);
      if ('rank' in next.plan) next.plan.rank = (Array.isArray(next.plan.rank) ? next.plan.rank : []).filter(k => /^(cal:\d+|tasks)$/.test(k)).slice(0, 50);
      for (const k of ['allDay', 'multiDay']) if (!['busy', 'always', 'never'].includes(next.plan[k])) delete next.plan[k]; }
    if (next.plan?.calendarId && !get('SELECT 1 FROM calendars WHERE id = ? AND user_id = ? AND writable = 1', next.plan.calendarId, req.user.id)) throw httpErr(400, 'Plan calendar must be one of your writable calendars');
    // project → own calendar (per user); only own writable calendars
    const pc = {};
    for (const [pid, cid] of Object.entries(next.plan?.projectCalendars || {})) if (cid && isMember(req.user.id, +pid) && get('SELECT 1 FROM calendars WHERE id = ? AND user_id = ? AND writable = 1', +cid, req.user.id)) pc[+pid] = +cid;
    if (next.plan) next.plan.projectCalendars = pc;
    const planCals = [next.plan?.calendarId, ...Object.values(pc)].filter(Boolean);
    run('UPDATE calendars SET is_plan = 0 WHERE user_id = ? AND id NOT IN (SELECT DISTINCT calendar_id FROM plan_events WHERE user_id = ?)', req.user.id, req.user.id);
    planCals.forEach(id => run('UPDATE calendars SET is_plan = 1 WHERE id = ?', id));
    saveSettings(req.user.id, next); markDirty(req.user.id, true);
    if ((cur.plan?.home?.address || '') !== (next.plan?.home?.address || '')) homeChanged(req.user.id);
    else if (JSON.stringify(cur.plan?.places || []) !== JSON.stringify(next.plan?.places || [])) refreshTravel(req.user.id).catch(() => {});
    return settingsOf(req.user.id);
  });

  // ---------- live updates (Server-Sent Events) ----------
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = what => reply.raw.write(`data: ${JSON.stringify({ what, at: Date.now() })}\n\n`);
    const ev = 'u:' + req.user.id; bus.on(ev, send);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000);
    send('hello');
    req.raw.on('close', () => { clearInterval(ping); bus.off(ev, send); });
  });

  // ---------- projects ----------
  app.get('/api/projects', async req => projectIdsFor(req.user.id).map(id => get('SELECT * FROM projects WHERE id = ?', id)).filter(Boolean).map(projectRow).sort((a, b) => a.sort - b.sort || a.id - b.id));
  app.post('/api/projects', async req => {
    const b = req.body || {};
    const id = Number(run('INSERT INTO projects(name, color, kind, owner_id, schedule, columns, target_date, sort, created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      str(b.name, 100) || 'Project', COLOR.test(b.color) ? b.color : '#1971c2', b.kind === 'outline' ? 'outline' : 'board', req.user.id, str(b.schedule || 'work', 40),
      JSON.stringify(Array.isArray(b.columns) && b.columns.length ? b.columns.map(c => str(c, 40)) : ['To do', 'In progress', 'Done']), dateOrNull(b.target_date), +b.sort || 10, Date.now(), JSON.stringify(b.meta && typeof b.meta === 'object' ? { wall: !!b.meta.wall, ordered: !!b.meta.ordered, ...(Array.isArray(b.meta.places) ? { places: b.meta.places.map(x => str(x, 40)).filter(Boolean).slice(0, 12) } : {}) } : {})).lastInsertRowid);
    run(`INSERT INTO project_members(project_id, user_id, role) VALUES (?, ?, 'owner')`, id, req.user.id);
    return projectRow(get('SELECT * FROM projects WHERE id = ?', id));
  });
  app.patch('/api/projects/:id', async req => {
    const pid = needProject(req.user.id, req.params.id), b = req.body || {};
    const f = { kind: v => v === 'outline' ? 'outline' : 'board', name: v => str(v, 100), color: v => COLOR.test(v) ? v : '#1971c2', schedule: v => str(v, 40), target_date: dateOrNull, sort: v => +v || 0, archived: v => v ? 1 : 0,
      columns: v => JSON.stringify((v || []).map(c => str(c, 40)).slice(0, 12)), meta: v => JSON.stringify(v || {}) };
    for (const [k, fn] of Object.entries(f)) if (k in b) run(`UPDATE projects SET ${k} = ? WHERE id = ?`, fn(b[k]), pid);
    A.touchProject(pid);
    return projectRow(get('SELECT * FROM projects WHERE id = ?', pid));
  });
  app.delete('/api/projects/:id', async req => {
    const pid = needProject(req.user.id, req.params.id), p = get('SELECT * FROM projects WHERE id = ?', pid);
    const us = usersOfProject(pid);
    audit(req, p.owner_id === req.user.id ? 'project.delete' : 'project.leave', p.name);
    if (p.owner_id === req.user.id) run('DELETE FROM projects WHERE id = ?', pid);
    else run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', pid, req.user.id);   // leave a shared project
    markDirty(us); notifyUsers(us, 'tasks'); return { ok: true };
  });
  app.post('/api/projects/:id/members', async req => {
    const pid = needProject(req.user.id, req.params.id);
    // people you already know (see contactsOf) are added; anyone else is asked by their ID (username) and accepts or declines
    const byId = int(req.body?.user_id, -1), name = str(req.body?.username, 40).trim().toLowerCase().replace(/^@/, '');
    if (name) {
      const to = get('SELECT id, name FROM users WHERE username = ? AND disabled = 0', name);
      if (!to) throw httpErr(404, 'No one with this ID');
      if (isMember(to.id, pid)) throw httpErr(409, `${to.name} is already in this project`);
      run('INSERT OR IGNORE INTO share_requests(project_id, from_id, to_id, created_at) VALUES (?, ?, ?, ?)', pid, req.user.id, to.id, Date.now());
      const pname = get('SELECT name FROM projects WHERE id = ?', pid).name;
      notify(to.id, 'partner', { title: `${req.user.name} invites you to “${pname}”`, body: 'Accept or decline in Smart Calendar.', url: '/#/requests', tag: 'share-' + pid }).catch(() => {});
      notifyUsers([to.id], 'requests');
      audit(req, 'project.ask', pname, to.id);
      return { requested: true, members: membersOf(pid) };
    }
    const u = byId > 0 && contactsOf(req.user.id).some(c => c.id === byId) ? get('SELECT id, name FROM users WHERE id = ? AND disabled = 0', byId) : null;
    if (!u) throw httpErr(404, 'No such user');
    run(`INSERT OR IGNORE INTO project_members(project_id, user_id, role) VALUES (?, ?, 'editor')`, pid, u.id);
    logActivity(pid, req.user.id, `Shared with ${u.name}`); audit(req, 'project.share', get('SELECT name FROM projects WHERE id = ?', pid).name, u.id); A.touchProject(pid);
    return membersOf(pid);
  });
  // requests to join a project: yours to answer
  app.get('/api/requests', async req => all(`SELECT r.id, r.created_at, p.name AS project, u.name AS from_name, u.username AS from_id FROM share_requests r
    JOIN projects p ON p.id = r.project_id JOIN users u ON u.id = r.from_id WHERE r.to_id = ? ORDER BY r.id`, req.user.id));
  app.post('/api/requests/:id', async req => {
    const r = get('SELECT * FROM share_requests WHERE id = ? AND to_id = ?', +req.params.id, req.user.id); if (!r) throw httpErr(404, 'Not found');
    run('DELETE FROM share_requests WHERE id = ?', r.id);
    const pname = get('SELECT name FROM projects WHERE id = ?', r.project_id)?.name;
    if (req.body?.accept && pname != null && isMember(r.from_id, r.project_id)) {
      run(`INSERT OR IGNORE INTO project_members(project_id, user_id, role) VALUES (?, ?, 'editor')`, r.project_id, req.user.id);
      logActivity(r.project_id, req.user.id, 'Joined'); A.touchProject(r.project_id);
      notify(r.from_id, 'partner', { title: `${req.user.name} joined “${pname}”`, body: '', url: '/#/project/' + r.project_id }).catch(() => {});
      audit(req, 'project.join', pname, req.user.id);
      return { joined: r.project_id };
    }
    return { declined: true };
  });
  app.delete('/api/projects/:id/members/:uid', async req => {
    const pid = needProject(req.user.id, req.params.id), p = get('SELECT owner_id FROM projects WHERE id = ?', pid);
    if (+req.params.uid === p.owner_id) throw httpErr(400, 'The owner cannot be removed');
    const us = usersOfProject(pid);
    run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', pid, +req.params.uid);
    markDirty(us); notifyUsers(us, 'tasks'); return membersOf(pid);
  });
  // the order the project is worked through (outline projects: the writing order); the planner follows it
  app.get('/api/projects/:id/order', async req => projectOrder(get('SELECT * FROM projects WHERE id = ?', needProject(req.user.id, req.params.id))));
  app.put('/api/projects/:id/order', async req => {
    const pid = needProject(req.user.id, req.params.id), r = saveOrder(pid, req.body);
    const last = get('SELECT user_id, at, text FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT 1', pid);   // one entry for a run of moves
    if (!(last?.text === 'Changed the order' && last.user_id === req.user.id && Date.now() - last.at < 30 * 60000)) logActivity(pid, req.user.id, 'Changed the order');
    A.touchProject(pid);
    return r;
  });
  // which calendar this project's blocks go to (per user); shared: every member writes into the same Google calendar
  app.post('/api/projects/:id/calendar', async req => {
    const pid = needProject(req.user.id, req.params.id), b = req.body || {}, p = get('SELECT * FROM projects WHERE id = ?', pid);
    const setFor = (uid, cid) => { const s = settingsOf(uid), pc = { ...(s.plan.projectCalendars || {}) }; if (cid) pc[pid] = cid; else delete pc[pid]; s.plan.projectCalendars = pc; saveSettings(uid, s);
      if (cid) run('UPDATE calendars SET is_plan = 1 WHERE id = ?', cid); markDirty(uid, true); };
    let cid = null;
    if (b.calendar === 'new') {
      const a = get(`SELECT * FROM accounts WHERE user_id = ? AND kind = 'google' AND status = 'ok' ORDER BY id LIMIT 1`, req.user.id); if (!a) throw httpErr(400, 'Connect Google first');
      cid = (await google.createCalendar(a, str(b.name || p.name, 80))).id;
    } else if (b.calendar) {
      cid = int(b.calendar); if (!get('SELECT 1 FROM calendars WHERE id = ? AND user_id = ? AND writable = 1', cid, req.user.id)) throw httpErr(400, 'Not one of your writable calendars');
    }
    setFor(req.user.id, cid);
    const missing = [];
    if (cid && b.shared) {
      const cal = get('SELECT * FROM calendars WHERE id = ?', cid), acc = get('SELECT * FROM accounts WHERE id = ?', cal.account_id);
      if (!/@group\.calendar\.google\.com$/.test(cal.ext_id)) throw httpErr(400, 'Your main calendar cannot be shared. Pick or create a separate calendar.');
      for (const m of membersOf(pid).filter(m => m.id !== req.user.id)) {
        let mine = get(`SELECT c.id FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.user_id = ? AND c.ext_id = ? AND c.writable = 1 AND a.status = 'ok'`, m.id, cal.ext_id);
        const macc = get(`SELECT * FROM accounts WHERE user_id = ? AND kind = 'google' AND status = 'ok' ORDER BY id LIMIT 1`, m.id);
        if (!mine && macc) {
          try {
            await google.googleApi(acc, 'POST', `/calendars/${encodeURIComponent(cal.ext_id)}/acl`, { role: 'writer', scope: { type: 'user', value: macc.label } }, { sendNotifications: 'false' });
            await google.googleApi(macc, 'POST', '/users/me/calendarList', { id: cal.ext_id }).catch(e => { if (e.status !== 409) throw e; });
            await google.syncCalendarList(macc);
            mine = get('SELECT id FROM calendars WHERE account_id = ? AND ext_id = ? AND writable = 1', macc.id, cal.ext_id);
          } catch (e) { req.log.warn(e); }
        }
        if (mine) setFor(m.id, mine.id); else missing.push(m.name);
      }
      const meta = { ...J(p.meta, {}), sharedCal: cal.ext_id };
      run('UPDATE projects SET meta = ? WHERE id = ?', JSON.stringify(meta), pid);
      logActivity(pid, req.user.id, `Shared calendar “${cal.name}”`);
      notifyUsers(usersOfProject(pid), 'tasks');
    }
    return { ok: true, calendar: cid, missing, settings: settingsOf(req.user.id) };
  });
  // pull to refresh: sync all of this user's accounts now (at most every 20 s)
  const lastManual = new Map();
  app.post('/api/sync', async req => {
    if (Date.now() - (lastManual.get(req.user.id) || 0) > 20000) {
      lastManual.set(req.user.id, Date.now());
      await Promise.all(all('SELECT * FROM accounts WHERE user_id = ?', req.user.id).map(a => syncAccount(a, true).catch(() => {})));
    }
    markDirty(req.user.id, true);     // pull to refresh: always plan anew
    return { ok: true };
  });
  app.get('/api/locations', async req => {
    const ids = projectIdsFor(req.user.id); if (!ids.length) return [];
    return all(`SELECT location AS name, COUNT(*) AS n FROM tasks WHERE location IS NOT NULL AND location != '' AND project_id IN (${ids.map(() => '?').join(',')}) GROUP BY lower(location) ORDER BY n DESC`, ...ids);
  });
  app.post('/api/tasks/:id/release', async req => {   // a waiting follow-up: start it now
    const t = needTask(req.user.id, req.params.id);
    run('UPDATE tasks SET wait_event = NULL, wait_until = ? WHERE id = ?', Date.now(), t.id); A.touchProject(t.project_id); return { ok: true };
  });
  app.get('/api/activity', async req => {
    const ids = req.query.project ? [needProject(req.user.id, req.query.project)] : projectIdsFor(req.user.id);
    if (!ids.length) return [];
    return all(`SELECT a.*, u.name AS user_name, u.color AS user_color, p.name AS project_name FROM activity a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.project_id IN (${ids.map(() => '?').join(',')}) ORDER BY a.at DESC LIMIT 100`, ...ids);
  });

  // ---------- tasks ----------
  app.get('/api/tasks', async req => {
    const ids = req.query.project ? [needProject(req.user.id, req.query.project)] : projectIdsFor(req.user.id);
    if (!ids.length) return [];
    const since = Date.now() - 30 * 864e5;
    const rows = all(`SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.project_id IN (${ids.map(() => '?').join(',')})
      AND (t.status != 'done' OR t.done_at > ? OR p.kind = 'outline' OR ? = 1) ORDER BY t.project_id, t.grp, t.sort, t.id`, ...ids, since, req.query.project ? 1 : 0);
    const plans = new Map();
    return rows.map(r => taskOut(taskRow(r), plans));
  });
  app.post('/api/tasks', async req => {
    const b = req.body || {}, pid = needProject(req.user.id, b.project_id);
    const f = taskPatch({ duration: settingsOf(req.user).dFree, ...b });
    if (f.parent_id && !get('SELECT 1 FROM tasks WHERE id = ? AND project_id = ?', f.parent_id, pid)) f.parent_id = null;
    const sort = b.sort ?? ((get('SELECT MAX(sort) AS m FROM tasks WHERE project_id = ?', pid).m || 0) + 1);
    const now = Date.now();
    const cols = ['project_id', 'created_by', 'created_at', 'updated_at', 'sort', 'assignee_id', ...Object.keys(f).filter(k => k !== 'sort' && k !== 'assignee_id')];
    const vals = [pid, req.user.id, now, now, sort, 'assignee_id' in f ? f.assignee_id : req.user.id, ...Object.keys(f).filter(k => k !== 'sort' && k !== 'assignee_id').map(k => f[k])];
    const id = Number(run(`INSERT INTO tasks(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...vals).lastInsertRowid);
    const t = taskById(id);
    logActivity(pid, req.user.id, `Added ${t.title}`); A.touchProject(pid);
    if (t.assignee_id && t.assignee_id !== req.user.id) notify(t.assignee_id, 'partner', { title: t.title, body: `Assigned by ${req.user.name}`, url: `/#/task/${id}` }).catch(() => {});
    return taskOut(t, new Map());
  });
  app.patch('/api/tasks/:id', async req => {
    const t = needTask(req.user.id, req.params.id), b = req.body || {};
    if ('project_id' in b) needProject(req.user.id, b.project_id);
    const f = taskPatch(b, t);
    if ('project_id' in b) f.project_id = +b.project_id;
    if (Object.keys(f).length) run(`UPDATE tasks SET ${Object.keys(f).map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(f), Date.now(), t.id);
    // moving a card into the last column = done; out of it = open
    if ('col' in b && !t.recur) {
      const cols = J(get('SELECT columns FROM projects WHERE id = ?', f.project_id || t.project_id).columns, []);
      const last = cols.length - 1;
      if (f.col >= last && t.status !== 'done') A.setDone(req.user.id, t.id, 0, true);
      else if (f.col < last && t.status === 'done') A.setDone(req.user.id, t.id, 0, false);
      else if (f.col > 0 && t.status === 'todo') run(`UPDATE tasks SET status = 'doing' WHERE id = ?`, t.id);
      else if (f.col === 0 && t.status === 'doing') run(`UPDATE tasks SET status = 'todo' WHERE id = ?`, t.id);
    }
    if ('status' in b && b.status === 'done') A.setDone(req.user.id, t.id, b.period, true);
    A.touchProject(t.project_id); if (f.project_id && f.project_id !== t.project_id) A.touchProject(f.project_id);
    return taskOut(taskById(t.id), new Map());
  });
  app.delete('/api/tasks/:id', async req => {
    const t = needTask(req.user.id, req.params.id);
    run('DELETE FROM tasks WHERE id = ?', t.id); logActivity(t.project_id, req.user.id, `Deleted ${t.title}`); A.touchProject(t.project_id);
    return { ok: true };
  });
  app.post('/api/tasks/:id/done', async req => { const t = needTask(req.user.id, req.params.id); return taskOut(A.setDone(req.user.id, t.id, int(req.body?.period, 0), req.body?.done !== false), new Map()); });
  app.post('/api/tasks/:id/skip', async req => { const t = needTask(req.user.id, req.params.id); A.skipOccurrence(req.user.id, t.id, int(req.body?.period, 0)); return { ok: true }; });
  app.post('/api/tasks/:id/next', async req => {
    const t = needTask(req.user.id, req.params.id);
    run('UPDATE tasks SET do_next = ?, auto = 1 WHERE id = ?', req.body?.off ? null : Date.now(), t.id); A.touchProject(t.project_id); return { ok: true };
  });
  app.post('/api/tasks/:id/postpone', async req => {
    const t = needTask(req.user.id, req.params.id), b = req.body || {};
    A.postpone(req.user.id, t.id, int(b.period, 0), int(b.until, Date.now() + 864e5)); return { ok: true };
  });
  app.post('/api/tasks/:id/pin', async req => {   // drag in the calendar
    const t = needTask(req.user.id, req.params.id), b = req.body || {};
    if (b.s != null && !(int(b.e) > int(b.s))) throw httpErr(400, 'End must be after start');
    A.pinBlock(req.user.id, t.id, int(b.period, 0), int(b.oldStart, 0), b.s == null ? null : int(b.s), b.e == null ? null : int(b.e)); return { ok: true };
  });
  app.post('/api/tasks/:id/auto', async req => {   // undo moves/postpones: back to the auto-scheduler
    const t = needTask(req.user.id, req.params.id), b = req.body || {};
    run('UPDATE tasks SET do_next = NULL WHERE id = ?', t.id);   // back to its normal place in the order
    if (b.period == null) run('DELETE FROM overrides WHERE user_id = ? AND task_id = ?', req.user.id, t.id);
    else run('DELETE FROM overrides WHERE user_id = ? AND task_id = ? AND period = ?', req.user.id, t.id, int(b.period, 0));
    markDirty(req.user.id, true); return { ok: true };
  });
  // your Google calendars, edited from the app (changes go to Google right away)
  const ownEvent = (uid, id) => { const e = get('SELECT e.*, c.user_id FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ?', +id); if (!e || e.user_id !== uid) throw httpErr(404, 'Event not found'); return e; };
  const gerr = e => { throw httpErr(e.statusCode || (e.status >= 400 && e.status < 500 ? 400 : 502), e.message); };
  app.patch('/api/events/:id', async req => {
    const e = ownEvent(req.user.id, req.params.id), b = req.body || {};
    const ch = { title: b.title != null ? str(b.title, 300) : null, calendar_id: int(b.calendar_id), all_day: b.all_day == null ? null : !!b.all_day, location: b.location != null ? str(b.location, 500) : null };
    if (b.start != null || b.end != null) { ch.start = int(b.start, e.start); ch.end = int(b.end, e.end); if (!(ch.end > ch.start)) throw httpErr(400, 'End must be after start'); }
    try { await google.updateEvent(req.user.id, e, ch, b.scope === 'all' ? 'all' : 'one'); } catch (x) { gerr(x); }
    // the event is read again from Google after the change: its id here changes
    const now = get('SELECT id FROM events WHERE calendar_id = ? AND ext_id = ?', ch.calendar_id || e.calendar_id, e.ext_id);
    markDirty(req.user.id, true); return { ok: true, id: now?.id ?? e.id };
  });
  // the times an event (series) may be moved to: an hours set, e.g. the doctor's opening hours
  app.put('/api/events/:id/rule', async req => {
    const e = ownEvent(req.user.id, req.params.id), b = req.body || {}, series = e.series || e.ext_id, cur = ruleOf(req.user.id, e.calendar_id, series);
    const next = { ...cur };
    if ('hours' in b) { next.hours = b.hours ? String(b.hours) : null; if (next.hours && !settingsOf(req.user.id).hours[next.hours]) throw httpErr(400, 'No such hours'); }
    if ('win' in b) {
      const w = b.win;
      if (!w) next.win = null;
      else {
        const days = [...new Set((w.days || []).map(Number).filter(d => d >= 0 && d <= 6))], ok = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
        if (!days.length || !ok(w.s) || !ok(w.e) || w.e <= w.s) throw httpErr(400, 'Times: a start before the end, and at least one day');
        next.win = { days, s: w.s, e: w.e };
      }
    }
    if ('rank' in b) { next.rank = b.rank && /^(cal:\d+|tasks|end)$/.test(b.rank) ? b.rank : null; }
    if (!next.hours && !next.win && !next.rank) run('DELETE FROM event_rules WHERE user_id = ? AND calendar_id = ? AND series = ?', req.user.id, e.calendar_id, series);
    else run(`INSERT INTO event_rules(user_id, calendar_id, series, hours, win, rank) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, calendar_id, series) DO UPDATE SET hours = excluded.hours, win = excluded.win, rank = excluded.rank`, req.user.id, e.calendar_id, series, next.hours, next.win ? JSON.stringify(next.win) : null, next.rank);
    markDirty(req.user.id, true);
    return { ok: true };
  });
  // move an event to the next time that fits its times, clear of everything ranked above its calendar
  app.post('/api/events/:id/reschedule', async req => {
    const e = ownEvent(req.user.id, req.params.id), b = req.body || {}, t0 = dayStart(isoDate(Date.now()));
    const from = b.from === 'tomorrow' ? dayStart(addDays(isoDate(Date.now()), 1)) : b.from === 'week' ? dayStart(addDays(isoDate(Date.now()), 7 - ((new Date().getDay() + 6) % 7))) : Math.max(Date.now(), t0);
    const slot = findSlot(req.user.id, e, from, b.hours !== undefined ? { set: b.hours || null } : {});
    if (!slot) throw httpErr(409, 'No free time in the next 60 days');
    try { await google.updateEvent(req.user.id, e, { start: slot.start, end: slot.end, title: null, calendar_id: null, all_day: null }, 'one'); } catch (x) { gerr(x); }
    markDirty(req.user.id, true); return slot;
  });
  // the event becomes a task the planner places (Auto-schedule in the sheet; /flex or /task in the calendar does the same)
  // Google Maps: suggestions while typing a place, the picked place, travel time from home
  app.get('/api/places', async req => { const q = String(req.query.q || '').trim(); if (q.length < 3) return []; try { const near = req.query.lat != null ? { lat: +req.query.lat, lng: +req.query.lng } : null; return await maps.suggest(req.user.id, q, String(req.query.s || ''), near); } catch (x) { throw httpErr(x.statusCode || 502, x.message); } });
  app.get('/api/places/:id', async req => { try { return await maps.place(req.params.id, String(req.query.s || '')); } catch (x) { throw httpErr(x.statusCode || 502, x.message); } });
  app.get('/api/travel', async req => { try { return (await maps.travel(req.user.id, String(req.query.to || '').trim())) || {}; } catch (x) { throw httpErr(x.statusCode || 502, x.message); } });
  app.post('/api/flexible', async req => {
    const b = req.body || {};
    try { return { id: createFlexible(req.user.id, { title: str(b.title, 300), minutes: int(b.minutes, 30), win: b.win && winOf(b.win), calendarId: int(b.calendar_id, 0) || null, startAfter: b.start_after, location: b.location, notes: b.notes, travel: int(b.travel, 0), deadline: b.deadline || null, priority: int(b.priority, 2), schedule: b.schedule || null }) }; }
    catch (x) { throw httpErr(400, x.message); }
  });
  app.post('/api/events/:id/to-task', async req => {
    const e = ownEvent(req.user.id, req.params.id), b = req.body || {};
    const win = b.win && winOf(b.win);
    let id; try { id = eventToTask(req.user.id, e, { kind: b.kind === 'task' ? 'task' : 'flex', minutes: int(b.minutes, 0) || null, win }); } catch (x) { throw httpErr(400, x.message); }
    try { await google.deleteEvent(req.user.id, e, 'one'); } catch (x) { if (x.status !== 404 && x.status !== 410) gerr(x); }
    markDirty(req.user.id, true); return { id };
  });
  app.delete('/api/events/:id', async req => {
    const e = ownEvent(req.user.id, req.params.id);
    try { await google.deleteEvent(req.user.id, e, req.query.scope === 'all' ? 'all' : 'one'); } catch (x) { gerr(x); }
    markDirty(req.user.id, true); return { ok: true };
  });
  app.post('/api/events', async req => {
    const b = req.body || {}, start = int(b.start), end = int(b.end);
    if (!(end > start)) throw httpErr(400, 'End must be after start');
    try { await google.createEvent(req.user.id, int(b.calendar_id), { title: str(b.title, 300), start, end, all_day: !!b.all_day, location: b.location ? str(b.location, 500) : null, descr: b.notes ? str(b.notes, 4000) : null }); } catch (x) { gerr(x); }
    markDirty(req.user.id, true); return { ok: true };
  });
  // travel / blocked time before and after a calendar event; a recurring event shares it across the series
  // clashes between group events and your own (Now page, push buttons)
  const clashes = uid => ({ tag: userTag(uid), items: listClashes(uid) });
  app.get('/api/clashes', async req => clashes(req.user.id));
  app.post('/api/clashes', async req => {
    const r = req.body?.dismiss || req.body?.same ? await dismissClash(req.user.id, String(req.body?.key || ''), !!req.body?.same) : await decideClash(req.user.id, String(req.body?.key || ''), req.body?.choice);
    if (!r) throw httpErr(404, 'This clash is gone');
    return clashes(req.user.id);
  });
  // copy an appointment into other calendars of yours, so the people there see it too
  app.post('/api/events/:id/copy', async req => {
    const e = ownEvent(req.user.id, req.params.id), ids = (Array.isArray(req.body?.calendars) ? req.body.calendars : []).map(Number).filter(Boolean).slice(0, 10);
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 300) : '';
    let n; try { n = await google.copyEvent(req.user.id, e, ids, title); } catch (x) { gerr(x); }
    markDirty(req.user.id, true); return { copied: n };
  });
  app.post('/api/events/:id/done', async req => finishEvent(req.user.id, ownEvent(req.user.id, req.params.id), req.body?.end));
  // track an appointment (e.g. blocked time that takes longer): Start, Pause; a task timer pauses it and the other way round
  app.post('/api/events/:id/start', async req => { const r = await startEvent(req.user.id, ownEvent(req.user.id, req.params.id)); markDirty(req.user.id, true); return r; });
  app.post('/api/events/:id/pause', async req => { ownEvent(req.user.id, req.params.id); A.pauseEvent(req.user.id); await trackedEnds(req.user.id).catch(() => {}); markDirty(req.user.id, true); return { ok: true }; });
  app.post('/api/events/:id/show', async req => { const e = ownEvent(req.user.id, req.params.id); undismissClash(req.user.id, e.calendar_id, e.ext_id); return { ok: true }; });
  app.put('/api/events/:id/buffer', async req => {
    const e = get('SELECT e.*, c.user_id FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ?', +req.params.id);
    if (!e || e.user_id !== req.user.id) throw httpErr(404, 'Event not found');
    const b = req.body || {}, m = v => v == null ? null : Math.max(0, Math.min(480, int(v, 0))), series = e.series || e.ext_id;
    const before = m(b.before), after = m(b.after), block = b.block == null ? null : b.block ? 1 : 0;
    if (before == null && after == null && block == null) run('DELETE FROM event_buffers WHERE user_id = ? AND calendar_id = ? AND series = ?', req.user.id, e.calendar_id, series);
    else run(`INSERT INTO event_buffers(user_id, calendar_id, series, before, after, block) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, calendar_id, series) DO UPDATE SET before = excluded.before, after = excluded.after, block = excluded.block`, req.user.id, e.calendar_id, series, before ?? 0, after ?? 0, block);
    markDirty(req.user.id, true); return { ok: true };
  });
  app.post('/api/tasks/reorder', async req => {   // [{id, sort, col?, grp?}]
    const list = Array.isArray(req.body) ? req.body.slice(0, 500) : [];
    const pids = new Set();
    tx(() => list.forEach(x => { const pid = canEditTask(req.user.id, x.id); if (!pid) return; pids.add(pid); run('UPDATE tasks SET sort = ?, grp = COALESCE(?, grp) WHERE id = ?', +x.sort || 0, x.grp == null ? null : int(x.grp), x.id); }));
    pids.forEach(A.touchProject); return { ok: true };
  });

  // ---------- plan + calendar view ----------
  app.get('/api/plan', async req => {
    const uid = req.user.id;   // only your own calendar; other members' plans are seen per shared project (/api/projects/:id/team)
    const now = Date.now(), from = int(req.query.from, now - 864e5), to = int(req.query.to, now + 14 * 864e5);
    const p = getPlan(uid);
    const blocks = p.blocks.filter(b => b.e > from && b.s < to).map(b => ({ ...b, ...parseKey(b.key) }));
    const units = {};
    for (const b of blocks) if (!units[b.key]) { const u = p.units[b.key]; if (u) units[b.key] = unitOut(u, p.info[b.key]); }
    const later = Object.values(p.units).filter(u => !u.t.auto).map(u => unitOut(u, {}));
    const unplaced = Object.entries(p.info).filter(([, i]) => i.unplaced > 0 && !i.first).map(([k]) => p.units[k] && unitOut(p.units[k], p.info[k])).filter(Boolean);
    const busy = shownBusy(uid, from, to, p);   // loose breaks where the planner put them
    const rules = rulesOf(uid), rankOf = eventRanker(uid), raw = calendarEvents(uid, from, to), hidden = hiddenEvents(uid, raw);
    // who else sees an appointment: the calendars of its copies ("Also in …")
    const also = new Map();
    for (const e of raw) if (e.dup) { const k = e.dup + '@' + e.start; if (!also.has(k)) also.set(k, []); also.get(k).push({ id: e.calendar_id, name: e.cal, color: e.color }); }
    const evs = raw.map(e => { const r = rules.get(`${e.calendar_id}:${e.series || e.ext_id}`) || {}; return { id: e.id, location: e.location || null, join: joinLink(e),
      hours: r.hours || null, win: r.win || null, rankSet: r.rank || null, rank: rankOf(e), start: e.start, end: e.end, all_day: e.all_day, title: e.title, free: e.free, cal: e.cal, color: e.color,
      blocks: e.blocks, before: e.before, after: e.after, travel: e.travel ? { mode: e.travel.mode, min: e.travel.min, there: e.travel.there, home: e.travel.home } : null, pin: e.pin || null, custom: e.custom, forced: e.forced, recurring: e.recurring, editable: !!e.editable, calendar_id: e.calendar_id, ext_id: e.ext_id, hidden: hidden.has(e.id),
      alsoIn: e.dup ? (also.get(e.dup + '@' + e.start) || []).filter(c => c.id !== e.calendar_id) : [], done: !!e.t_done,
      track: e.t_since || e.t_spent ? { since: e.t_since || null, spent: e.t_spent || 0 } : null }; });
    const moved = all('SELECT DISTINCT task_id, period, kind FROM overrides WHERE user_id = ? AND end > ?', uid, now);
    const doneT = all(`SELECT t.id, t.title, t.done_at AS at, p.color FROM tasks t JOIN projects p ON p.id = t.project_id JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
      WHERE t.status = 'done' AND t.done_at BETWEEN ? AND ? AND t.done_by = ?`, uid, from, to, uid);
    const doneO = all(`SELECT t.id, t.title, o.at, o.period, p.color FROM occurrences o JOIN tasks t ON t.id = o.task_id JOIN projects p ON p.id = t.project_id
      WHERE o.status = 'done' AND o.at BETWEEN ? AND ? AND o.by = ?`, from, to, uid);
    // what was done, kept in the calendar as it happened: every timer session, and a task ticked off without one
    const log = all(`SELECT w.*, t.title, t.project_id, p.name AS p_name, p.color FROM work_log w LEFT JOIN tasks t ON t.id = w.task_id LEFT JOIN projects p ON p.id = t.project_id
      WHERE w.user_id = ? AND w.end > ? AND w.start < ? ORDER BY w.start`, uid, from, to);
    const act = get('SELECT a.*, t.title FROM active a JOIN tasks t ON t.id = a.task_id WHERE a.user_id = ?', uid);
    const order = Object.keys(p.units).filter(k => p.units[k].t.auto).sort((a, b) => (p.info[a]?.first || Infinity) - (p.info[b]?.first || Infinity));
    const end = Math.max(0, ...Object.values(p.info).map(i => i.end || 0));
    const projectEnds = {};
    for (const b of p.blocks) { const u = p.units[b.key]; if (u) projectEnds[u.t.project_id] = Math.max(projectEnds[u.t.project_id] || 0, b.e); }
    return { now, user: uid, projectEnds, blocks, units, later, unplaced, busy: busy.filter(b => b.kind !== 'event' && b.kind !== 'buffer'), events: evs, moved, done: [...doneT, ...doneO], log, active: act ? { ...act, until: act.until ? openEnd(act.until, now) : null } : null,
      paused: act ? null : get('SELECT p.task_id, p.period, p.since, p.at, t.title FROM paused p JOIN tasks t ON t.id = p.task_id WHERE p.user_id = ?', uid) || null, late: act ? null : missedStart(uid, now, { late: false }), nextKeys: order.slice(0, 8), nextUnits: Object.fromEntries(order.slice(0, 8).map(k => [k, unitOut(p.units[k], p.info[k])])), projectedEnd: end || null };
  });
  // a shared project: when the other members are planned to work on its tasks (only those blocks, nothing else of their calendars)
  app.get('/api/projects/:id/team', async req => {
    const pid = +req.params.id; if (!isMember(req.user.id, pid)) throw httpErr(404, 'Project not found');
    const now = Date.now(), to = now + Math.max(1, Math.min(60, +req.query.days || 21)) * 864e5, out = [];
    for (const m of membersOf(pid).filter(m => m.id !== req.user.id)) {
      let p; try { p = getPlan(m.id); } catch { continue; }
      for (const b of p.blocks) {
        const u = p.units[b.key]; if (!u || u.t.project_id !== pid || b.e <= now || b.s >= to) continue;
        out.push({ user: m.id, start: b.s, end: b.e, task: u.t.id, title: u.t.title });
      }
    }
    return { blocks: out.sort((a, b) => a.start - b.start) };
  });
  // a task written to its own calendar (a flexible appointment in Family) takes that calendar's color
  const calColor = id => id ? get('SELECT color FROM calendars WHERE id = ?', +id)?.color || null : null;
  function unitOut(u, i = {}) {
    const t = u.t;
    return { key: u.key, taskId: t.id, period: u.period, title: t.title, notes: t.notes, points: t.points, meta: t.meta, project_id: t.project_id, p_name: t.p_name, p_color: calColor(t.meta?.calendarId) || t.p_color,
      priority: t.priority, pri: u.pri ?? t.priority, duration: t.duration, spent: u.spent, deadline: u.deadline, overdue: !!u.overdue, recur: !!t.recur, periodStart: u.periodStart, periodEnd: u.periodEnd,
      parent_id: t.parent_id, first: i.first || null, end: i.end || null, late: !!i.late, unplaced: i.unplaced || 0, auto: t.auto, ext_source: t.ext_source };
  }

  // ---------- timer + "Now" buttons ----------
  app.post('/api/timer/start', async req => { const b = req.body || {}, t = needTask(req.user.id, b.task), period = int(b.period, 0);
    // planned: forgot to start: from the planned start, to the planned end + 30 min, then 30 min more each time, until Done
    let from = null;
    if (b.planned) {
      const m = missedStart(req.user.id), k = m && parseKey(m.key);
      if (!k || k.taskId !== t.id || k.period !== period) throw httpErr(409, 'No planned start');
      from = { since: m.s, until: Math.max(m.e, m.s + 15 * 60000) + 30 * 60000 };
    }
    A.startTimer(req.user.id, t.id, period, b.mode === 'r' ? 'r' : null, b.note ? str(b.note, 200) : null, from); return { ok: true }; });
  app.post('/api/timer/stop', async req => ({ minutes: A.pauseTimer(req.user.id) }));
  app.post('/api/timer/drop', async req => { A.settlePaused(req.user.id, { gone: true }); return { ok: true }; });   // a paused task no longer waits in Now
  app.post('/api/timer/research', async req => { const b = req.body || {}, t = needTask(req.user.id, b.task); A.logResearch(req.user.id, t.id, int(b.period, 0), Math.max(1, Math.min(600, int(b.minutes, 15))), b.note ? str(b.note, 200) : null); return { ok: true }; });
  app.post('/api/timer/more', async req => { const t = needTask(req.user.id, req.body?.task); A.addMinutes(req.user.id, t.id, Math.max(5, int(req.body?.minutes, 30))); return { ok: true }; });
  app.post('/api/now/break', async req => { A.breakNow(req.user.id, Math.max(1, Math.min(600, int(req.body?.minutes, 15))), str(req.body?.title || 'Break', 80)); return { ok: true }; });
  app.post('/api/now/interrupt', async req => { A.interrupted(req.user.id, Math.max(1, Math.min(600, int(req.body?.minutes, 15))), str(req.body?.title, 120)); return { ok: true }; });
  app.post('/api/appts', async req => {
    const b = req.body || {}, s = int(b.start), e = int(b.end);
    if (!(s && e > s)) throw httpErr(400, 'End must be after start');
    const brk = b.kind === 'break';   // a break you schedule: shown like Lunch, not written to the calendar
    return { id: A.addAppt(req.user.id, s, e, str(b.title || (brk ? 'Break' : 'Blocked'), 120), brk ? 'break' : 'appt') };
  });
  app.patch('/api/appts/:id', async req => {
    const b = req.body || {}, a = get(`SELECT * FROM appts WHERE id = ? AND user_id = ? AND kind != 'skipfixed'`, +req.params.id, req.user.id); if (!a) throw httpErr(404, 'Not found');
    const s = b.start != null ? int(b.start) : a.start, e = b.end != null ? int(b.end) : a.end;
    if (!(s && e > s)) throw httpErr(400, 'End must be after start');
    run('UPDATE appts SET start = ?, end = ?, title = ? WHERE id = ?', s, e, b.title ? str(b.title, 120) : a.title, a.id); markDirty(req.user.id); return { ok: true };
  });
  app.post('/api/fixed/:id/day', async req => {
    const b = req.body || {}, date = String(b.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpErr(400, 'Invalid date');
    const s = int(b.start), e = int(b.end); if (!b.remove && !(s && e > s)) throw httpErr(400, 'End must be after start');
    const id = A.fixedOnDay(req.user.id, req.params.id, date, { start: s, end: e, title: b.title ? str(b.title, 120) : null, remove: !!b.remove });
    if (id === null && !b.remove) throw httpErr(404, 'Not found');
    return { ok: true, id };
  });
  app.delete('/api/appts/:id', async req => { run('DELETE FROM appts WHERE id = ? AND user_id = ?', +req.params.id, req.user.id); markDirty(req.user.id); return { ok: true }; });
  // minutes today and this week: everything (timer sessions and the appointments you had, overlaps counted once)
  // and the focus project alone (its sessions): your newest outline project
  app.get('/api/stats', async req => {
    const uid = req.user.id, now = Date.now(), d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const wk = new Date(d0); wk.setDate(wk.getDate() - ((wk.getDay() + 6) % 7));
    const focus = get(`SELECT p.id FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ? WHERE p.kind = 'outline' AND p.archived = 0 ORDER BY p.id DESC LIMIT 1`, uid)?.id;
    const sess = all('SELECT w.start, w.end, t.project_id FROM work_log w LEFT JOIN tasks t ON t.id = w.task_id WHERE w.user_id = ? AND w.end > ? AND w.start < ?', uid, +wk, now);
    const evs = calendarEvents(uid, +wk, now), hid = hiddenEvents(uid, evs);
    const appts = evs.filter(e => e.blocks && e.timed && !hid.has(e.id) && e.end > +wk && e.start < now);
    const minutes = (L, from) => {
      const iv = L.map(x => [Math.max(x.start, from), Math.min(x.end, now)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
      let m = 0, cs = -Infinity, ce = -Infinity;
      for (const [a, b] of iv) { if (a > ce) { if (ce > cs) m += ce - cs; cs = a; ce = b; } else ce = Math.max(ce, b); }
      if (ce > cs) m += ce - cs;
      return Math.round(m / 60000);
    };
    const all_ = [...sess, ...appts], th = focus ? sess.filter(x => x.project_id === focus) : [];
    return { today: minutes(all_, +d0), week: minutes(all_, +wk), focus: focus || null, focusToday: minutes(th, +d0), focusWeek: minutes(th, +wk) };
  });

  // ---------- integrations ----------
  app.get('/api/accounts', async req => all('SELECT id, kind, label, status, error, last_sync, state FROM accounts WHERE user_id = ? ORDER BY id', req.user.id).map(a => {
    const st = J(a.state, {}); delete a.state;
    const live = a.kind === 'vikunja' ? !!st.hooks?.ok : a.kind === 'google' && all('SELECT watch FROM calendars WHERE account_id = ?', a.id).some(c => J(c.watch, null)?.exp > Date.now());
    return { ...a, live, cfg: st.cfg || null, me: st.me ? { username: st.me.username } : null, vprojects: st.vprojects || [], count: st.count, lastPush: st.lastPush || null, calendars: all('SELECT id, name, color, use_busy, is_plan, writable, include_words, exclude_words, mirror_to, only_mine FROM calendars WHERE account_id = ? ORDER BY name', a.id) };
  }));
  app.get('/api/google/connect', async (req, reply) => { if (!google.enabled()) throw httpErr(400, 'Google is not configured on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)'); return reply.redirect(google.authUrl(req.user.id)); });
  app.get('/api/google/callback', async (req, reply) => {
    if (req.query.error) return reply.redirect('/#/setup?google=' + encodeURIComponent(req.query.error === 'access_denied' ? 'You clicked “Cancel” – nothing was connected.' : req.query.error));
    try { const id = await google.handleCallback(req.user.id, String(req.query.state || ''), String(req.query.code || '')); audit(req, 'account.connect', 'Google ' + (get('SELECT label FROM accounts WHERE id = ?', id) || {}).label); syncAccount(get('SELECT * FROM accounts WHERE id = ?', id), true); return reply.redirect('/#/setup?google=ok'); }
    catch (e) { return reply.redirect('/#/setup?google=' + encodeURIComponent(e.message)); }
  });
  app.post('/api/accounts/ics', async req => {
    let url; try { url = normalizeUrl(req.body?.url); } catch (e) { throw httpErr(400, e.message); }
    const label = str(req.body?.label || 'Exchange', 60);
    const id = Number(run(`INSERT INTO accounts(user_id, kind, label, secret) VALUES (?, 'ics', ?, ?)`, req.user.id, label, encrypt({ url })).lastInsertRowid);
    run('INSERT INTO calendars(account_id, user_id, ext_id, name, use_busy) VALUES (?, ?, ?, ?, 1)', id, req.user.id, 'ics', label);
    await syncAccount(get('SELECT * FROM accounts WHERE id = ?', id), true);
    audit(req, 'account.connect', 'ICS ' + label);
    return get('SELECT id, status, error FROM accounts WHERE id = ?', id);
  });
  app.post('/api/accounts/vikunja', async req => {
    const b = req.body || {};
    let url; try { url = new URL(String(b.url || '')).origin + new URL(String(b.url)).pathname.replace(/\/(api\/v1\/?)?$/, ''); } catch { throw httpErr(400, 'Enter the Vikunja address, e.g. https://tasks.example.com'); }
    if (!/^https?:/.test(url)) throw httpErr(400, 'http(s) only');
    // optional: your sign-in for a page in front of Vikunja (Authelia), kept encrypted like the token
    const login = b.login?.user && b.login?.pass ? { user: str(b.login.user, 200).trim(), pass: String(b.login.pass).slice(0, 500) } : undefined;
    const secret = encrypt({ url, token: str(b.token, 500).trim(), ...(login ? { login } : {}) });
    const tmp = { secret };
    let me; try { me = await vikunjaUser(tmp); } catch (e) { throw Object.assign(httpErr(400, e.status === 502 ? e.message : 'Vikunja rejected the token: ' + e.message), e.signin ? { signin: true } : {}); }
    const cfg = { onlyAssigned: b.onlyAssigned !== false, projects: [], duration: Math.max(5, int(b.duration, 60)), schedule: str(b.schedule || 'work', 40), prefix: str(b.label || 'Vikunja', 40) };
    const id = Number(run(`INSERT INTO accounts(user_id, kind, label, secret, state) VALUES (?, 'vikunja', ?, ?, ?)`, req.user.id, str(b.label || 'Vikunja', 60), secret, JSON.stringify({ me: { id: me.id, username: me.username }, cfg })).lastInsertRowid);
    await syncAccount(get('SELECT * FROM accounts WHERE id = ?', id), true);
    audit(req, 'account.connect', 'Vikunja ' + url);
    return get('SELECT id, status, error FROM accounts WHERE id = ?', id);
  });
  // Files: attachments of the folder tasks in your Vikunja projects' "Dokumente & Infos" buckets
  app.get('/api/files', async req => {
    const out = [];
    // ?project=<app project id>: only that Vikunja project's files
    const pr = req.query.project ? get(`SELECT ext_account, ext_id FROM projects WHERE id = ? AND ext_source = 'vikunja'`, +req.query.project) : null;
    if (req.query.project && (!pr || !isMember(req.user.id, +req.query.project))) throw httpErr(404, 'Not found');
    for (const a of all(`SELECT * FROM accounts WHERE user_id = ? AND kind = 'vikunja' AND status != 'auth'`, req.user.id)) {
      if (pr && a.id !== pr.ext_account) continue;
      try { const f = await docFiles(a, req.query.fresh ? 0 : undefined, pr ? pr.ext_id : null); if (f.list.length) out.push({ account: a.id, label: a.label, projects: f.list }); }
      catch (e) { out.push({ account: a.id, label: a.label, projects: [], error: e.message }); }
    }
    return out;
  });
  // upload: the file is the body; into a folder (?folder=<task>) or a new folder named ?name= in the project's files bucket
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 50 * 1024 * 1024 }, (req, body, done) => done(null, body));
  app.post('/api/files/upload', { bodyLimit: 50 * 1024 * 1024 }, async req => {
    const q = req.query, pid = +q.project;
    const pr = get(`SELECT ext_account, ext_id FROM projects WHERE id = ? AND ext_source = 'vikunja'`, pid);
    if (!pr || !isMember(req.user.id, pid)) throw httpErr(404, 'Not found');
    const a = get(`SELECT * FROM accounts WHERE id = ? AND user_id = ? AND kind = 'vikunja'`, pr.ext_account, req.user.id); if (!a) throw httpErr(404, 'Not found');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpErr(400, 'No file');
    const fileName = String(q.file || 'File').replace(/[\\/\0]/g, '_').slice(0, 200) || 'File';
    let folder = null;
    if (q.folder) { const f = await docFiles(a, 0, pr.ext_id); folder = f.list.flatMap(p => p.folders).find(x => x.id === +q.folder)?.id; if (!folder) throw httpErr(404, 'Folder not found'); }
    const name = String(q.name || '').trim().slice(0, 250);
    if (!folder && !name) throw httpErr(400, 'Name missing');
    try { const r = await uploadFile(a, pr.ext_id, { folder, name, fileName, mime: String(q.mime || '').slice(0, 100), data: req.body }); audit(req, 'files.upload', fileName); return r; }
    catch (e) { throw httpErr(e.status || 502, e.message); }
  });
  app.get('/api/files/:acc/:task/:att', async (req, reply) => {
    const a = get(`SELECT * FROM accounts WHERE id = ? AND user_id = ? AND kind = 'vikunja'`, +req.params.acc, req.user.id); if (!a) throw httpErr(404, 'Not found');
    const f = await docFiles(a, undefined, req.query.p || null), folder = f.list.flatMap(p => p.folders).find(x => x.id === +req.params.task), file = folder?.files.find(x => x.id === +req.params.att);
    if (!file) throw httpErr(404, 'Not found');   // only files of the folders shown
    let r; try { r = await attachment(a, folder.id, file.id); } catch (e) { throw httpErr(e.status || 502, e.message); }
    const mime = (file.mime || r.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    // shown inline only what cannot run as a page of this app (PDF, images except SVG, plain text, audio, video); all else downloads, sandboxed
    const inline = /^(application\/pdf|image\/(png|jpe?g|gif|webp|heic|avif)|text\/plain|audio\/|video\/)/.test(mime) && !req.query.download;
    reply.header('content-type', mime === 'text/plain' ? 'text/plain; charset=utf-8' : inline ? mime : 'application/octet-stream');
    reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    reply.header('x-content-type-options', 'nosniff'); reply.header('cache-control', 'private, max-age=300');
    reply.header('content-security-policy', mime === 'application/pdf' ? "default-src 'none'; frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'");
    const len = r.headers.get('content-length'); if (len) reply.header('content-length', len);
    const { Readable } = await import('node:stream');
    return reply.send(Readable.fromWeb(r.body));
  });
  const resync = new Map();
  app.patch('/api/accounts/:id', async req => {
    const a = get('SELECT * FROM accounts WHERE id = ? AND user_id = ?', +req.params.id, req.user.id); if (!a) throw httpErr(404, 'Not found');
    const st = J(a.state, {}), b = req.body || {};
    if (b.label) run('UPDATE accounts SET label = ? WHERE id = ?', str(b.label, 60), a.id);
    if (b.cfg && a.kind === 'vikunja') {
      // only known settings; the calendar must be one of your writable Google calendars
      const c = {}, x = b.cfg;
      if ('onlyAssigned' in x) c.onlyAssigned = !!x.onlyAssigned;
      if ('schedule' in x) c.schedule = str(x.schedule || 'work', 40);
      if ('plan' in x) c.plan = x.plan !== false;
      if ('user' in x) c.user = str(x.user || '', 100).trim().replace(/^@/, '');
      if ('calendarId' in x) { const id = int(x.calendarId, 0) || null;
        if (id && !get(`SELECT 1 FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND c.user_id = ? AND c.writable = 1 AND a.kind = 'google'`, id, req.user.id)) throw httpErr(400, 'Choose one of your writable Google calendars');
        c.calendarId = id; }
      for (const k of ['skip', 'noPlan']) if (k in x) c[k] = (Array.isArray(x[k]) ? x[k] : []).map(Number).filter(n => n > 0).slice(0, 500);
      for (const k of ['duration', 'prefix', 'projects']) if (k in x) c[k] = x[k];
      st.cfg = { ...st.cfg, ...c }; run('UPDATE accounts SET state = ? WHERE id = ?', JSON.stringify(st), a.id); markDirty(req.user.id, true); forgetFiles(a.id);
    }
    if (b.url && a.kind === 'ics') { try { run('UPDATE accounts SET secret = ? WHERE id = ?', encrypt({ url: normalizeUrl(b.url) }), a.id); } catch (e) { throw httpErr(400, e.message); } }
    // read again in the background, once after a burst of changes; the open apps reload when it is done
    clearTimeout(resync.get(a.id));
    resync.set(a.id, setTimeout(() => { resync.delete(a.id); syncAccount(get('SELECT * FROM accounts WHERE id = ?', a.id), true).catch(() => {}).finally(() => notifyUsers([req.user.id], 'sync')); }, 1500));
    return { ok: true };
  });
  app.delete('/api/accounts/:id', async req => {
    const a = get('SELECT * FROM accounts WHERE id = ? AND user_id = ?', +req.params.id, req.user.id); if (!a) throw httpErr(404, 'Not found');
    if (a.kind === 'vikunja') run(`DELETE FROM projects WHERE ext_source = 'vikunja' AND ext_account = ?`, a.id);
    run('DELETE FROM accounts WHERE id = ?', a.id);
    audit(req, 'account.disconnect', `${a.kind} ${a.label}`);
    const s = settingsOf(req.user.id);
    if (s.plan.calendarId && !get('SELECT 1 FROM calendars WHERE id = ?', s.plan.calendarId)) { s.plan.calendarId = null; saveSettings(req.user.id, s); }
    markDirty(req.user.id); return { ok: true };
  });
  app.post('/api/accounts/:id/sync', async req => {
    const a = get('SELECT * FROM accounts WHERE id = ? AND user_id = ?', +req.params.id, req.user.id); if (!a) throw httpErr(404, 'Not found');
    if (a.status === 'auth') run(`UPDATE accounts SET status = 'ok' WHERE id = ?`, a.id);
    await syncAccount(get('SELECT * FROM accounts WHERE id = ?', a.id), true);
    return get('SELECT status, error, last_sync FROM accounts WHERE id = ?', a.id);
  });
  app.post('/api/accounts/:id/calendar', async req => {
    const a = get(`SELECT * FROM accounts WHERE id = ? AND user_id = ? AND kind = 'google'`, +req.params.id, req.user.id); if (!a) throw httpErr(404, 'Not found');
    const c = await google.createCalendar(a, str(req.body?.name || 'Smart Calendar', 80));
    return { id: c.id };
  });
  // filtered copy of a calendar into a new Google calendar ("<name> filtered")
  app.post('/api/calendars/:id/mirror', async req => {
    const c = get('SELECT * FROM calendars WHERE id = ? AND user_id = ?', +req.params.id, req.user.id); if (!c) throw httpErr(404, 'Not found');
    if (!req.body?.on) { await mirror.clearMirror(c.id); return { ok: true }; }
    await withLock('mirror-setup:' + req.user.id, async () => {   // a second tap while Google is still creating the calendar must not create another one
      if (get('SELECT mirror_to FROM calendars WHERE id = ?', c.id).mirror_to) return;
      const a = get(`SELECT * FROM accounts WHERE user_id = ? AND kind = 'google' AND status = 'ok' ORDER BY id LIMIT 1`, req.user.id); if (!a) throw httpErr(400, 'Connect Google first');
      const name = str(req.body?.name || `${c.name} filtered`, 80);
      const dst = get(`SELECT c.* FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.user_id = ? AND a.kind = 'google' AND c.name = ? AND c.writable = 1 ORDER BY c.id LIMIT 1`, req.user.id, name) || await google.createCalendar(a, name);
      run('UPDATE calendars SET mirror_to = ? WHERE id = ?', dst.id, c.id);
      await mirror.removeDuplicates(req.user.id).catch(() => {});
    });
    const n = await mirror.mirrorCalendar(c.id).catch(e => { throw httpErr(502, e.message); });
    return { ok: true, copied: n };
  });
  app.patch('/api/calendars/:id', async req => {
    const c = get('SELECT * FROM calendars WHERE id = ? AND user_id = ?', +req.params.id, req.user.id); if (!c) throw httpErr(404, 'Not found');
    const b = req.body || {}, words = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 30).map(x => x.slice(0, 40)).join(', ');
    if ('use_busy' in b) run('UPDATE calendars SET use_busy = ? WHERE id = ?', b.use_busy ? 1 : 0, c.id);
    if ('include_words' in b) run('UPDATE calendars SET include_words = ? WHERE id = ?', words(b.include_words), c.id);
    if ('exclude_words' in b) run('UPDATE calendars SET exclude_words = ? WHERE id = ?', words(b.exclude_words), c.id);
    if ('only_mine' in b) run('UPDATE calendars SET only_mine = ? WHERE id = ?', b.only_mine ? 1 : 0, c.id);
    if (c.mirror_to && ('include_words' in b || 'exclude_words' in b || 'only_mine' in b)) mirror.mirrorCalendar(c.id).catch(() => {});
    if ('use_busy' in b) { const a = get('SELECT * FROM accounts WHERE id = ?', c.account_id); syncAccount(a, true).then(() => markDirty(req.user.id)); }
    else markDirty(req.user.id, true);
    return { ok: true };
  });

  // ---------- push ----------
  app.post('/api/push/subscribe', async req => {
    const s = req.body || {};
    if (!s.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw httpErr(400, 'Invalid subscription');
    run(`INSERT INTO push_subs(user_id, endpoint, p256dh, auth, ua, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      req.user.id, str(s.endpoint, 1000), str(s.keys.p256dh, 200), str(s.keys.auth, 100), str(req.headers['user-agent'], 200), Date.now());
    return { ok: true };
  });
  app.post('/api/push/unsubscribe', async req => { run('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?', str(req.body?.endpoint, 1000), req.user.id); return { ok: true }; });
  app.post('/api/mail/test', async req => {
    const to = get('SELECT email FROM users WHERE id = ?', req.user.id)?.email;
    if (!mailReady()) throw httpErr(400, 'E-mail is not set up on this server');
    if (!to) throw httpErr(400, 'Add your e-mail address first');
    try { await sendMail(to, 'Smart Calendar', 'E-mail notifications are working.'); } catch (e) { throw httpErr(502, e.message); }
    return { ok: true };
  });
  app.post('/api/push/test', async req => {
    const r = await sendPush(req.user.id, { title: 'Smart Calendar', body: 'Notifications are working.', url: '/#/now', urgency: 'high' }, true);
    if (!r.devices) throw httpErr(400, 'No device is signed up for push');
    if (!r.sent) throw httpErr(502, `Push was refused: ${r.errors[0] || 'unknown error'}`);
    return r;
  });
  app.get('/api/push/count', async req => ({ n: get('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?', req.user.id).n }));

  // ---------- backup ----------
  // Restore: a Smart Calendar backup (missing projects come back)
  app.post('/api/restore', { bodyLimit: 32 * 1024 * 1024 }, async req => {
    const d = req.body?.backup || {};
    const r = restoreBackup(req.user.id, d); audit(req, 'restore', `${r.projects} projects, ${r.tasks} tasks`); return { kind: 'backup', ...r };
  });
  app.get('/api/export', async (req, reply) => {
    const uid = req.user.id, pids = projectIdsFor(uid);
    const q = pids.map(() => '?').join(',') || 'NULL';
    audit(req, 'export');
    reply.header('content-disposition', `attachment; filename="smart-calendar-${isoDate(Date.now())}.json"`);
    return { exported: Date.now(), settings: settingsOf(uid), projects: all(`SELECT * FROM projects WHERE id IN (${q})`, ...pids), tasks: all(`SELECT * FROM tasks WHERE project_id IN (${q})`, ...pids),
      occurrences: all(`SELECT o.* FROM occurrences o JOIN tasks t ON t.id = o.task_id WHERE t.project_id IN (${q})`, ...pids), work_log: all('SELECT * FROM work_log WHERE user_id = ?', uid), appts: all('SELECT * FROM appts WHERE user_id = ?', uid) };
  });
}
