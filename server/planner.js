// Builds each user's work items + busy time from the database and runs the scheduler.
import { all, get, run } from './db.js';
import { schedule } from './scheduler.js';
import { settingsOf, taskRow, membersOf } from './models.js';
import { isoDate, addDays, wd, tm, at, dayStart, periodOf, periodRange } from './time.js';
import { notifyUsers } from './bus.js';
import { travelMode, physical, placeOf, placeKey, ruleOf, pinUrl } from './travel.js';
import { orderRanks } from './order.js';

const MISSED = new Map();         // uid -> { key, s, e }: the block that should be running now, as first planned (it slides with the clock while nobody starts it)
const STEP = 30 * 60000;
// a session started from the planned time runs to `until`, then 30 min more each time that is reached
export const openEnd = (until, now = Date.now()) => until > now ? until : until + Math.ceil((now - until + 1) / STEP) * STEP;
// the block due now as first planned (also when the plan was not redone since it began), started from: not before today,
// not before your last tracked session. Late: started more than a minute ago and nobody pressed Start.
export function missedStart(uid, now = Date.now(), { late = true } = {}) {
  if (get('SELECT 1 FROM active WHERE user_id = ?', uid)) return null;
  let m = MISSED.get(uid);
  if (!m || m.e <= m.s) { const b = (PLANS.get(uid)?.blocks || []).filter(x => x.s <= now && x.e > now).sort((x, y) => x.s - y.s)[0]; m = b && { key: b.key, s: b.s, e: b.e }; }
  if (!m) return null;
  const last = get('SELECT MAX(end) e FROM work_log WHERE user_id = ? AND end <= ?', uid, now)?.e || 0;
  const s = Math.max(m.s, last, dayStart(isoDate(now)));
  return !late || s < now - 60000 ? { key: m.key, s, e: m.e } : null;
}
const PLANS = new Map();          // uid -> { at, next, sig, blocks, info, items }
const dirty = new Set(), byClock = new Set();   // byClock: re-planned only because time passed
let timer = null;
const listeners = [];
export const onPlanned = fn => listeners.push(fn);

export const keyOf = (taskId, period) => period == null ? String(taskId) : `${taskId}@${period}`;
export const parseKey = k => { const [t, p] = String(k).split('@'); return { taskId: +t, period: p == null ? 0 : +p }; };

export function markDirty(uids, now = false) {
  (Array.isArray(uids) ? uids : [uids]).forEach(u => { dirty.add(u); byClock.delete(u); });
  clearTimeout(timer);
  timer = setTimeout(flush, now ? 0 : 400);
}
function flush() {
  const us = [...dirty]; dirty.clear();
  // a re-plan only because time passed that came out the same: nobody is told, nothing is written
  const changed = us.filter(u => { const was = PLANS.get(u)?.sig, clock = byClock.delete(u);
    try { return planUser(u).sig !== was || !clock; } catch (e) { console.error('plan failed for user', u, e); return false; } });
  if (!changed.length) return;
  notifyUsers(changed, 'plan');
  listeners.forEach(fn => { try { fn(changed); } catch (e) { console.error(e); } });
}
export function getPlan(uid) {
  const p = PLANS.get(uid);
  if (!p || dirty.has(uid) || Date.now() >= p.next) return planUser(uid);
  return p;
}

// Every member user takes part in a project's rotation; the period index picks one.
function rotationUser(t, period) {
  const rot = (t.meta.rotation && t.meta.rotation.length ? t.meta.rotation : membersOf(t.project_id).map(m => m.id));
  if (!rot.length) return t.assignee_id || t.created_by;
  const i = ((period + (t.meta.rotOffset || 0)) % rot.length + rot.length) % rot.length;
  return rot[i];
}
export function assigneeOf(t, period) {
  if (t.recur && t.assign_mode === 'rotate') return rotationUser(t, period);
  return t.assignee_id || t.created_by;
}

// open work units (tasks + recurring instances) relevant for a time range; used by planner and views
export function workUnits(uid, now = Date.now(), horizonDays = 62) {
  const today = isoDate(now), end = addDays(today, horizonDays);
  const rows = all(`SELECT t.*, p.schedule AS p_schedule, p.sort AS p_sort, p.target_date AS p_target, p.name AS p_name, p.color AS p_color, p.archived AS p_arch, p.meta AS p_meta, p.kind AS p_kind
    FROM tasks t JOIN projects p ON p.id = t.project_id
    JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
    WHERE t.status != 'done' AND p.archived = 0`, uid);
  const parents = new Set(all(`SELECT DISTINCT parent_id FROM tasks WHERE parent_id IS NOT NULL AND status != 'done'`).map(r => r.parent_id));
  const units = [];
  const ordered = new Map(), ranks = new Map();   // ordered projects: each task's place in the project's order (order.js)
  for (const r of rows) {
    const t = taskRow(r);
    if (!ordered.has(r.project_id)) { let m = {}; try { m = JSON.parse(r.p_meta || '{}'); } catch {} ordered.set(r.project_id, isOrdered(m, r.p_kind));
      if (isOrdered(m, r.p_kind)) ranks.set(r.project_id, orderRanks({ id: r.project_id, meta: r.p_meta })); }
    if (parents.has(t.id) || t.meta.level === 'chapter' || t.meta.level === 'section') continue;   // containers are not scheduled themselves
    if (t.wait_event && !(t.wait_until && t.wait_until <= now)) continue;   // follow-up still waiting for its event
    if (!t.recur) {
      if (assigneeOf(t) !== uid) continue;
      units.push({ t, period: null, key: keyOf(t.id), spent: t.spent, earliest: Math.max(t.start_after ? dayStart(t.start_after) : 0, t.wait_until || 0),
        deadline: t.deadline ? dayStart(addDays(t.deadline, 1)) : (r.p_target ? dayStart(addDays(r.p_target, 1)) : null), hardDeadline: !!t.deadline, ordered: ordered.get(r.project_id), rank: ranks.get(r.project_id)?.get(t.id) });
      continue;
    }
    const rc = { ...t.recur, anchor: t.recur.anchor || isoDate(t.created_at) };
    const occ = new Map(all('SELECT period, status, spent FROM occurrences WHERE task_id = ?', t.id).map(o => [o.period, o]));
    const p0 = periodOf(rc, today);
    // missed previous period does not pile up: it only makes the current instance overdue
    const prev = p0 - 1, [ps] = periodRange(rc, prev);
    const missed = prev >= 0 && ps >= (rc.anchor) && !occ.has(prev);
    for (let p = Math.max(0, p0); p < Math.max(0, p0) + 400; p++) {
      const [s, e] = periodRange(rc, p);
      if (s > end) break;
      if (rc.until && s > rc.until) break;
      if (occ.has(p) && occ.get(p).status !== 'open') continue;
      if (assigneeOf(t, p) !== uid) continue;
      const spent = (get('SELECT COALESCE(SUM(end - start), 0) / 60000.0 AS m FROM work_log WHERE task_id = ? AND period = ?', t.id, p) || {}).m || 0;
      units.push({ t, period: p, key: keyOf(t.id, p), spent, earliest: dayStart(s), deadline: dayStart(e), hardDeadline: true, overdue: p === p0 && missed, periodStart: s, periodEnd: e });
    }
  }
  return units;
}

// busy intervals for one user between two ms points
// per-calendar keyword filters on the event title, whole words.
// Syntax: JD → any case · "JD" (in quotes) → exact case
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w, flags) => new RegExp(`(^|[^\\p{L}\\p{N}])(${w.map(esc).join('|')})(?![\\p{L}\\p{N}])`, flags);
export function wordsMatcher(s) {
  const all = String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!all.length) return null;
  const exact = all.filter(x => /^".+"$/.test(x)).map(x => x.slice(1, -1)), loose = all.filter(x => !/^".+"$/.test(x));
  const res = [exact.length && wordRe(exact, 'u'), loose.length && wordRe(loose, 'iu')].filter(Boolean);
  return { test: t => res.some(r => r.test(t)) };
}
const filters = new Map();
// write /hide or /free into an event's notes or title in any calendar app → it never blocks and is not copied;
// /block → it blocks even when set to Free
export const HIDE_TAG = /(?:^|\s)\/(?:hide|free|frei)\b/i;
export const BLOCK_TAG = /(?:^|\s)\/block\b/i;
export function blocks(e) {
  // "Free"/transparent or /free never blocks; /block always blocks
  // (all-day events in Google are "free" by default, so they only block when set to Busy or marked /block)
  if (!e.use_busy) return false;
  const tag = e.title + ' ' + (e.descr || '');
  if (HIDE_TAG.test(tag)) return false;
  if (e.free && !BLOCK_TAG.test(tag)) return false;
  return wordsPass(e, e.title);
}
// all-day events and events over several days follow their own rule (Settings → Plan):
// 'busy' = only when marked Busy (Google marks all-day events Free by default), 'always' = also when Free, 'never'
export const longKind = e => e.end - e.start > 864e5 ? 'multiDay' : e.all_day ? 'allDay' : null;
export function blocksByRule(e, plan = {}) {
  const k = longKind(e), rule = (k && plan[k]) || 'busy';
  if (rule === 'never' && BLOCK_TAG.test(e.title + ' ' + (e.descr || ''))) return blocks(e);   // the event's own tag wins
  return rule === 'never' ? false : rule === 'always' ? blocks({ ...e, free: 0 }) : blocks(e);
}
// keyword filter of a calendar: your words ("Mine") always win, then the other people's words ("Others") hide,
// and an event with none of them blocks too, unless "Only mine" is switched on (better blocked than missed)
export function wordsPass(c, title) {
  const k = (c.include_words || '') + '|' + (c.exclude_words || '');
  if (!filters.has(k)) filters.set(k, [wordsMatcher(c.include_words), wordsMatcher(c.exclude_words)]);
  const [inc, exc] = filters.get(k);
  if (inc && inc.test(title)) return true;
  if (exc && exc.test(title)) return false;
  return !inc || !(c.only_mine ?? 0);
}
// meals by their name: ASAP tasks may skip breakfast or lunch (not both), and only move dinner (scheduler.js)
const mealOf = t => /breakfast|fr(ü|ue)hst(ü|ue)ck/i.test(t) ? 'breakfast' : /lunch|mittag/i.test(t) ? 'lunch' : /dinner|supper|abendessen|abendbrot/i.test(t) ? 'dinner' : null;
// calendar events with what they mean for planning: blocks?, travel/buffer time before and after.
// Rules: a per-event (per series) choice wins; an event with travel time always blocks;
// a blocking timed event at a place you go to gets the way there from home before it (travel.js: by bike or by car);
// every other blocking timed event gets the default buffer (Settings → Plan), but only on a side where no other event is right next to it.
export function calendarEvents(uid, from, to, settings = settingsOf(uid)) {
  const def = Math.max(0, +(settings.plan?.eventBuffer ?? 15) || 0), bikeMax = settings.plan?.bikeMax ?? 25;
  const rows = all(`SELECT e.id, e.calendar_id, e.ext_id, e.series, e.start, e.end, e.all_day, e.title, e.free, e.descr, e.location, e.link, e.dup, c.name AS cal, c.color, c.use_busy, c.include_words, c.exclude_words, c.only_mine,
      b.before AS b_before, b.after AS b_after, b.block AS b_block, (c.writable = 1 AND a.kind = 'google') AS editable, t.ended AS t_ended, t.began AS t_began, t.done_at AS t_done, t.since AS t_since, t.spent AS t_spent
    FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
    LEFT JOIN event_buffers b ON b.user_id = c.user_id AND b.calendar_id = e.calendar_id AND b.series = COALESCE(e.series, e.ext_id)
    LEFT JOIN event_track t ON t.user_id = c.user_id AND t.calendar_id = e.calendar_id AND t.ext_id = e.ext_id
    WHERE c.user_id = ? AND e.ours = 0 AND e.end > ? AND e.start < ? ORDER BY e.start`, uid, from - 864e5, to + 864e5);
  // Start and Done (eventdone.js): a read-only calendar keeps its time, the planning uses the real start (same length) and end
  for (const r of rows) { if (r.t_began) { const d = r.t_began - r.start; r.start += d; r.end += d; } if (r.t_ended && r.t_ended > r.start) r.end = r.t_ended; }
  // tracked and still running past its end: it keeps its time, 30 min more each time, until Done or Pause
  const now = Date.now();
  for (const r of rows) if (r.t_since && !r.t_done && !r.all_day && r.start <= now && r.end <= now + 60000) r.end = openEnd(r.end, now + 60000);
  // where you go for each event (place rules) and the way there from home
  const rules = settings.plan?.places || [], tt = new Map(all('SELECT place, car, bike FROM travel_times WHERE user_id = ?', uid).map(t => [t.place, t]));
  for (const r of rows) { const rule = ruleOf(r, rules); r.pin = rule?.lat != null ? { label: rule.place, url: pinUrl(rule) } : null; r.place = placeOf(r, rules); const t = tt.get(placeKey(r.place)); r.tv_car = t?.car ?? null; r.tv_bike = t?.bike ?? null; }
  const evs = rows.map(r => {
    const custom = r.b_before != null || r.b_after != null, timed = !r.all_day && r.end - r.start < 864e5;
    const block = r.b_block != null ? !!r.b_block : (custom && (r.b_before || r.b_after)) ? true : blocksByRule(r, settings.plan);
    const way = !custom && block && timed && physical(r.place) && (r.tv_car != null || r.tv_bike != null) ? travelMode({ car: r.tv_car, bike: r.tv_bike }, bikeMax) : null;
    // travel: the way there before it (there) and, for the day's last place, home after it (home); minutes rounded up to 5
    const travel = way && way.min >= 3 ? { ...way, before: Math.max(Math.ceil(way.min / 5) * 5, def), there: true, home: false } : null;   // never shorter than the usual buffer
    return { ...r, timed, blocks: block, custom, before: custom ? r.b_before || 0 : travel ? travel.before : 0, after: custom ? r.b_after || 0 : 0, travel, recurring: r.series != null && r.series !== r.ext_id, forced: r.b_block };
  });
  // the way home: after the last appointment of the day at a place you go to (none later at that place or another)
  // and no way there again for a later appointment at the place you are already at that day
  const lastAt = new Map(), key = l => String(l || '').trim().toLowerCase();
  for (const e of evs.filter(e => e.blocks && e.timed && physical(e.place)).sort((a, b) => a.start - b.start)) {
    const d = isoDate(e.start), l = lastAt.get(d);
    if (l && key(l.place) === key(e.place) && e.travel) { e.travel = { ...e.travel, there: false }; e.before = 0; }
    if (!l || e.end > l.end) lastAt.set(d, e);
  }
  for (const e of lastAt.values()) if (e.travel) { e.travel.home = true; e.after = e.travel.before; }
  for (const e of evs) if (e.travel && !e.travel.there && !e.travel.home) e.travel = null;
  if (def) {
    const hard = evs.filter(e => e.blocks && e.timed);
    for (const e of hard) {
      if (e.custom) continue;
      if (!e.travel?.there && !hard.some(o => o !== e && o.end > e.start - def * 60000 && o.start < e.start)) e.before = def;
      if (!e.travel?.home && !hard.some(o => o !== e && o.start < e.end + def * 60000 && o.end > e.end)) e.after = def;
    }
  }
  // buffers of two events that meet in between become one: the gap belongs to the earlier event, full width in the calendar
  const seq = evs.filter(e => e.blocks && e.timed).sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i], b = seq.slice(i + 1).find(x => x.start >= a.end); if (!b) continue;
    // the way to the next place takes the gap
    if (a.end + a.after * 60000 > b.start - b.before * 60000) {
      if (b.travel?.there) { b.before = Math.max(0, Math.min(b.before, (b.start - a.end) / 60000)); a.after = 0; } else { a.after = (b.start - a.end) / 60000; b.before = 0; } }
  }
  return evs.filter(e => e.end + e.after * 60000 > from && e.start - e.before * 60000 < to);
}
// Ranking (Settings → Calendars): a drag-and-drop list of your blocking calendars and "Tasks". What is higher wins:
// tasks are only kept out of events of calendars above "Tasks", a clash goes to the higher calendar, and an event moved
// to a new time only has to avoid what is above it. Not yet ranked: group calendars, then your own, then Tasks.
export function ranking(uid, settings = settingsOf(uid)) {
  const cals = all(`SELECT id, include_words FROM calendars WHERE user_id = ? AND use_busy = 1 ORDER BY (include_words = '') , name`, uid);
  const keys = new Set(cals.map(c => 'cal:' + c.id).concat('tasks'));
  const order = (settings.plan?.rank || []).filter(k => keys.has(k));
  for (const c of cals) if (!order.includes('cal:' + c.id)) { const i = order.indexOf('tasks'); order.splice(i < 0 ? order.length : i, 0, 'cal:' + c.id); }
  if (!order.includes('tasks')) order.push('tasks');
  const pos = new Map(order.map((k, i) => [k, i]));
  return { order, of: k => pos.get(typeof k === 'number' ? 'cal:' + k : k) ?? order.length };
}
// the link to join an online meeting: the event's call link, or a Zoom / Teams / Meet / Webex … link in its place or notes
const MEET = /https:\/\/[^\s<>"')\]]*(zoom\.us|zoom\.com|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|webex\.com|whereby\.com|gotomeeting\.com|meet\.jit\.si|meeting\.uol\.de|bluejeans\.com|chime\.aws|skype\.com)[^\s<>"')\]]*/i;
// a place that is a web address (any provider, e.g. a BigBlueButton room) is an online meeting too
const WEBLOC = /^\s*https:\/\/[^\s<>"')\]]+/i;
export const joinLink = e => (e.link && /^https:\/\//.test(e.link) && (MEET.test(e.link) || /meet|zoom|teams|webex/i.test(e.link)) ? e.link : null)
  || ((String(e.location || '').match(MEET) || String(e.descr || '').match(MEET) || String(e.location || '').match(WEBLOC) || [])[0] || '').trim().replace(/[.,;:!?]+$/, '') || null;
// The rank of one event. Set by hand in its sheet (dragged above some entry of the ranking), or automatic:
// in your work hours it has its calendar's rank; outside them your own events go to the top and group events
// (calendars with "Only with" words) drop below your own calendars, so your evening is yours.
const ranges = v => !v ? [] : Array.isArray(v[0]) ? v : [v];
export const inWorkHours = (s, a, b) => { const d = isoDate(a); return ranges(s.hours.work?.[wd(d)]).some(([x, y]) => at(d, tm(x)) < b && at(d, tm(y)) > a); };
export function eventRanker(uid, settings = settingsOf(uid), rk = ranking(uid, settings)) {
  const rules = new Map(all('SELECT calendar_id, series, rank FROM event_rules WHERE user_id = ? AND rank IS NOT NULL', uid).map(r => [`${r.calendar_id}:${r.series}`, r.rank]));
  const group = new Set(all(`SELECT id FROM calendars WHERE user_id = ? AND include_words != ''`, uid).map(r => r.id));
  const lastOwn = rk.order.reduce((m, k, i) => k.startsWith('cal:') && !group.has(+k.slice(4)) ? i : m, -1);
  return e => {
    const r = rules.get(`${e.calendar_id}:${e.series || e.ext_id}`);
    if (r) return (r === 'end' ? rk.order.length : rk.of(r)) - 0.5;
    const base = rk.of(e.calendar_id);
    if (e.all_day || e.end - e.start >= 864e5 || inWorkHours(settings, e.start, e.end)) return base;
    if (group.has(e.calendar_id)) return Math.max(base, lastOwn + 0.25);
    return -0.5;
  };
}
export function busyOf(uid, from, to, settings = settingsOf(uid)) {
  const out = [], rk = ranking(uid, settings), tasksAt = rk.of('tasks'), rankOf = eventRanker(uid, settings, rk);
  for (const e of calendarEvents(uid, from, to, settings)) {
    if (!e.blocks || rankOf(e) > tasksAt) continue;   // ranked below Tasks: may be planned over
    out.push({ s: e.start, e: e.end, t: e.title, cal: e.cal, kind: 'event', allDay: !!e.all_day });
    // pad: the default buffer (not travel, not set by you); a loose break may use it (a meal right after a meeting)
    if (e.timed && e.before > 0) out.push({ s: e.start - e.before * 60000, e: e.start, t: e.title, kind: 'buffer', pad: !e.custom && !e.travel?.there });
    if (e.timed && e.after > 0) out.push({ s: e.end, e: e.end + e.after * 60000, t: e.title, kind: 'buffer', pad: !e.custom && !e.travel?.home });
  }
  all('SELECT * FROM appts WHERE user_id = ? AND end > ? AND start < ?', uid, from, to).forEach(a => out.push({ s: a.start, e: a.end, t: a.title, kind: a.kind, id: a.id }));
  const skips = new Set(all(`SELECT title FROM appts WHERE user_id = ? AND kind = 'skipfixed' AND end > ? AND start < ?`, uid, from, to).map(a => a.title));
  for (let d = isoDate(from); dayStart(d) < to; d = addDays(d, 1)) {
    (settings.fixed || []).forEach(f => {
      if (!f.days.includes(wd(d)) || skips.has(`${f.id}:${d}`)) return;
      out.push({ s: at(d, tm(f.s)), e: at(d, tm(f.e)), t: f.t, kind: 'fixed', fixedId: f.id, bid: `${f.id}:${d}`, soft: f.flex !== false, only: f.flex === 'asap' ? 'asap' : null, meal: mealOf(f.t) });   // loose (default), loose only for ASAP tasks, or firm
    });
  }
  return out.filter(b => b.kind !== 'skipfixed').sort((a, b) => a.s - b.s);
}

// projects whose tasks must be done in their plan order (outline projects by default)
export const isOrdered = (meta, kind) => (meta && typeof meta.ordered === 'boolean') ? meta.ordered : kind === 'outline';
// ordered projects: keep the project's slots in the global order, but fill them in plan order (group, sort)
function applyProjectOrder(units, actKey) {
  const byP = new Map();
  units.forEach((u, i) => { if (u.ordered && u.period == null && u.t.auto) { if (!byP.has(u.t.project_id)) byP.set(u.t.project_id, []); byP.get(u.t.project_id).push(i); } });
  for (const idx of byP.values()) {
    const L = idx.map(i => units[i]).sort((a, b) => ((b.key === actKey) - (a.key === actKey)) || ((a.t.do_next ? 0 : 1) - (b.t.do_next ? 0 : 1)) || ((a.t.do_next || 0) - (b.t.do_next || 0)) ||
      ((a.rank ?? Infinity) - (b.rank ?? Infinity) || 0) || (a.t.grp - b.t.grp) || (a.t.sort - b.t.sort) || (a.t.id - b.t.id));
    idx.forEach((i, j) => { units[i] = L[j]; L[j].after = j ? L[j - 1].key : null; L[j].chain = L; });
  }
  return units;
}

// the priority it is planned with: its own, rising towards ASAP as its end date comes near (by the days to spare once
// the work left is done, about 4 h of it a day): 3 weeks or more as set, a week → High at most, 2 days → ASAP. Overdue: ASAP.
// Repeating tasks keep theirs (each round has an end), and so do ordered projects (a thesis: worked through in its order).
// 0 = ASAP … 3 = Low, in steps of 0.1 (the color shows it). Close to ASAP, it may also take a loose break's place.
export function effPri(u, now = Date.now()) {
  let p = Math.max(0, Math.min(3, +u.t.priority));
  if (u.overdue) p = 0;
  else if (u.hardDeadline && u.period == null && u.deadline && !u.ordered) {
    const left = Math.max(0, (u.t.duration || 0) - (u.spent || 0)) / 60, slack = (u.deadline - now) / 864e5 - left / 4;
    p = Math.min(p, slack <= 0 ? 0 : slack < 2 ? slack / 2 : slack < 7 ? 1 + (slack - 2) / 5 : slack < 21 ? 2 + (slack - 7) / 14 : 3);
  }
  return Math.round(p * 10) / 10;
}
// a task's own window (an appointment: "the practice is open Mon–Fri 08:00–11:00"); invalid → none
export const winOf = w => w && Array.isArray(w.days) && w.days.length && /^\d\d:\d\d$/.test(w.s) && /^\d\d:\d\d$/.test(w.e) && w.e > w.s ? { days: w.days.map(Number), s: w.s, e: w.e } : null;
export function orderUnits(units, uid) {
  const act = get('SELECT task_id, period FROM active WHERE user_id = ?', uid);
  const actKey = act ? (units.find(u => u.t.id === act.task_id && (u.period || 0) === act.period) || {}).key : null;
  const now = Date.now(); for (const u of units) u.pri = effPri(u, now);
  units.sort((a, b) =>
    ((b.key === actKey) - (a.key === actKey)) ||
    ((a.t.do_next ? 0 : 1) - (b.t.do_next ? 0 : 1)) || ((a.t.do_next || 0) - (b.t.do_next || 0)) ||
    ((winOf(a.t.meta?.win) ? 0 : 1) - (winOf(b.t.meta?.win) ? 0 : 1)) ||   // appointments first: as soon as possible, they take their slot before flexible work
    (a.pri - b.pri) ||
    ((a.hardDeadline ? a.deadline : Infinity) - (b.hardDeadline ? b.deadline : Infinity)) ||
    (a.t.p_sort - b.t.p_sort) || (a.t.project_id - b.t.project_id) ||
    (a.t.grp - b.t.grp) || (a.t.sort - b.t.sort) || (a.t.id - b.t.id) || ((a.period || 0) - (b.period || 0)));
  return applyProjectOrder(units, actKey);
}

export function planUser(uid, now = Date.now()) {
  const s = settingsOf(uid);
  const horizon = s.horizonDays || 62;
  const end = dayStart(addDays(isoDate(now), horizon + 1));
  const units = orderUnits(workUnits(uid, now, horizon), uid);
  const act = get('SELECT * FROM active WHERE user_id = ?', uid);
  run('DELETE FROM overrides WHERE end < ? AND kind = ?', now - 864e5, 'pin');
  run('DELETE FROM overrides WHERE end < ? AND kind = ?', now - 7 * 864e5, 'defer');
  const ov = all('SELECT * FROM overrides WHERE user_id = ?', uid);
  const items = [];
  // Vikunja accounts with planning off: their tasks are not planned, only tracked while you work on them
  // (the whole account, or single projects switched off under Plan)
  const noPlan = new Set(), noPlanProj = new Set();
  for (const a of all(`SELECT id, state FROM accounts WHERE user_id = ? AND kind = 'vikunja'`, uid)) {
    let cfg = {}; try { cfg = JSON.parse(a.state || '{}').cfg || {}; } catch {}
    if (cfg.plan === false) noPlan.add(a.id);
    const off = new Set((cfg.noPlan || []).map(String));
    if (off.size) for (const p of all(`SELECT id, ext_id FROM projects WHERE ext_source = 'vikunja' AND ext_account = ?`, a.id)) if (off.has(String(p.ext_id))) noPlanProj.add(p.id);
  }
  for (const u of units) {
    if (!u.t.auto || (u.t.ext_source === 'vikunja' && (noPlan.has(u.t.ext_account) || noPlanProj.has(u.t.project_id)))) {
      // running without a plan: the session is a block from its start to a little ahead (in the calendar while you work,
      // cut to the real end when you pause or finish); a later start adds the next one
      if (act && act.task_id === u.t.id && (act.period || 0) === (u.period || 0))
        items.push({ key: u.key, remaining: 0, schedule: u.t.schedule || u.t.p_schedule || 'work', pins: [{ s: act.since, e: act.until ? openEnd(act.until, now) : Math.ceil((now + 60000) / 300000) * 300000 }], live: true });
      continue;
    }
    if (act?.until && act.task_id === u.t.id && (act.period || 0) === (u.period || 0)) {
      items.push({ key: u.key, remaining: 0, schedule: u.t.schedule || u.t.p_schedule || 'work', pins: [{ s: act.since, e: openEnd(act.until, now) }], live: true });
      continue;
    }
    const running = act && act.task_id === u.t.id && (act.period || 0) === (u.period || 0) ? (now - act.since) / 60000 : 0;
    const used = u.spent + running;
    const dur = u.t.duration || s.dFree || 60;
    const remaining = Math.max(Math.min(15, dur), dur - used);
    const mine = ov.filter(o => o.task_id === u.t.id && o.period === (u.period || 0));
    const defer = Math.max(0, ...mine.filter(o => o.kind === 'defer').map(o => o.end));
    items.push({ key: u.key, remaining, minChunk: u.t.min_chunk, schedule: u.t.schedule || u.t.p_schedule || 'work', loc: u.t.location ? u.t.location.trim().toLowerCase() : null,
      after: u.after || null, earliest: Math.max(u.earliest || 0, defer), deadline: u.deadline, days: u.t.recur?.days, window: u.t.recur?.window, win: winOf(u.t.meta?.win), pad: Math.max(0, Math.min(180, +u.t.meta?.travel || 0)), important: (u.pri ?? u.t.priority) < 0.5,
      pins: mine.filter(o => o.kind === 'pin' && o.end > now).map(o => ({ s: o.start, e: o.end })) });
  }
  // ordered projects: a moved (pinned) task keeps its place in the order → everything before it should be finished by then
  const byKey0 = new Map(items.map(it => [it.key, it]));
  for (const L of new Set(units.filter(u => u.chain).map(u => u.chain))) {
    let cap = Infinity;
    for (let j = L.length - 1; j >= 0; j--) {
      const it = byKey0.get(L[j].key); if (!it) continue;
      if (cap < Infinity) it.before = cap;
      if (it.pins?.length) cap = Math.min(cap, ...it.pins.map(p => p.s));
    }
  }
  const busy = busyOf(uid, now - 864e5, end, s);
  const res = schedule({ now, horizonDays: horizon, hours: s.hours, chunk: s.chunk, busy, items });
  const byKey = Object.fromEntries(units.map(u => [u.key, u]));
  // loose breaks that moved (or gave way) are shown where they are now
  const moved = new Map((res.breaks || []).map(x => [x.id, x]));
  const shown = busy.flatMap(b => { const m = b.kind === 'fixed' && moved.get(b.bid); return !m ? [b] : m.s == null ? [] : [{ ...b, s: m.s, e: m.e, moved: true }]; });
  // the next moment the plan can change without any change in the data: a block or appointment starts or ends,
  // a postponement or a waiting follow-up runs out, the day changes; a running timer changes it every minute; at most 30 min
  let next = Math.min(now + 30 * 60000, dayStart(addDays(isoDate(now), 1)), act ? now + 60000 : Infinity);
  const edge = t => { if (t > now && t < next) next = t; };
  for (const b of res.blocks) { edge(b.s); edge(b.e); }
  for (const b of shown) { edge(b.s); edge(b.e); }
  for (const o of ov) { edge(o.start); edge(o.end); }
  for (const u of units) edge(u.earliest || 0);
  for (const r of all(`SELECT t.wait_until FROM tasks t JOIN project_members m ON m.project_id = t.project_id AND m.user_id = ? WHERE t.status != 'done' AND t.wait_until > ?`, uid, now)) edge(r.wait_until);
  // remember the block that is due now as first planned: when it is started late, it can start from there
  const mark = Math.ceil(now / 300000) * 300000;
  const cur = act ? null : res.blocks.filter(b => b.s <= mark && b.e > now).sort((a, b) => a.s - b.s)[0];
  const was = MISSED.get(uid);
  if (!cur) MISSED.delete(uid);
  else if (!was || was.key !== cur.key) MISSED.set(uid, { key: cur.key, s: cur.s, e: cur.e });
  const sig = JSON.stringify([res.blocks.map(b => [b.key, b.s, b.e]), shown.map(b => [b.s, b.e, b.t]), res.info]);
  const plan = { at: Date.now(), now, next, sig, blocks: res.blocks, info: res.info, units: byKey, busy: shown, range: [now - 864e5, end] };
  PLANS.set(uid, plan);
  return plan;
}

// busy time as shown: loose breaks where the planner put them (moved off an appointment or next to one), gone when
// they gave way; outside the plan's range as set
export function shownBusy(uid, from, to, plan = getPlan(uid)) {
  const placed = new Map((plan.busy || []).filter(b => b.kind === 'fixed').map(b => [b.bid, b]));
  const inPlan = b => !!plan.range && b.s >= plan.range[0] && b.s < plan.range[1];
  return busyOf(uid, from, to).flatMap(b => b.kind !== 'fixed' || !b.soft ? [b] : placed.has(b.bid) ? [placed.get(b.bid)] : inPlan(b) ? [] : [b]);
}
// a task split into several blocks: its open checklist points are shared out over the blocks in order
export function partPoints(points, part = 1, parts = 1) {
  const open = (points || []).filter(p => !p.done);
  if (parts <= 1) return open;
  const n = Math.ceil(open.length / parts);
  return open.slice((part - 1) * n, part * n);
}

export function planAll() {
  all('SELECT id FROM users').forEach(u => markDirty(u.id));
}
// every minute: only users whose plan can have changed with the time (see next in planUser)
export function planDue(now = Date.now()) {
  const due = all('SELECT id FROM users').map(u => u.id).filter(id => { const p = PLANS.get(id); return !p || now >= p.next; });
  if (!due.length) return;
  markDirty(due); due.forEach(u => byClock.add(u));
}
export const usersOfProject = pid => all('SELECT user_id FROM project_members WHERE project_id = ?', pid).map(r => r.user_id);
