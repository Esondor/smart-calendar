// Move a calendar event (e.g. a missed doctor's appointment) to the next time that fits:
// inside its times (an hours set such as the doctor's opening hours; without one your work and personal hours),
// clear of its own calendar and everything ranked above it (Settings → Calendars → Ranking). Lower-ranked things may be
// overlapped; your planned tasks move out of the way when "Tasks" is ranked below it.
import { all, get } from './db.js';
import { settingsOf } from './models.js';
import { calendarEvents, ranking, busyOf, eventRanker } from './planner.js';
import { isoDate, addDays, at, tm, wd, dayStart } from './time.js';
import { getPlan } from './planner.js';

const ranges = v => !v ? [] : Array.isArray(v[0]) ? v : [v];
const STEP = 15 * 60000;

const parse = r => r && { hours: r.hours || null, win: (() => { try { return r.win ? JSON.parse(r.win) : null; } catch { return null; } })(), rank: r.rank || null };
export const ruleOf = (uid, calId, series) => parse(get('SELECT hours, win, rank FROM event_rules WHERE user_id = ? AND calendar_id = ? AND series = ?', uid, calId, series)) || { hours: null, win: null, rank: null };
export const rulesOf = uid => new Map(all('SELECT calendar_id, series, hours, win, rank FROM event_rules WHERE user_id = ?', uid).map(r => [`${r.calendar_id}:${r.series}`, parse(r)]));

// the windows of one day an event may be placed in: its own window (e.g. Mon–Fri 08:00–11:00), an hours set, or work + personal
function windowsOn(s, set, date, win) {
  if (win) return win.days.includes(wd(date)) && tm(win.e) > tm(win.s) ? [[at(date, tm(win.s)), at(date, tm(win.e))]] : [];
  const names = set && s.hours[set] ? [set] : set === 'all' ? Object.keys(s.hours) : ['work', 'personal'];
  const out = names.flatMap(n => ranges(s.hours[n]?.[wd(date)]).map(([a, b]) => [at(date, tm(a)), at(date, tm(b))]));
  out.sort((a, b) => a[0] - b[0]);
  const merged = [];   // work 09–18 and personal 18:30–21:30 stay apart; overlapping sets join
  for (const w of out) { const l = merged.at(-1); if (l && w[0] <= l[1]) l[1] = Math.max(l[1], w[1]); else merged.push([...w]); }
  return merged;
}

// ev: a row of calendarEvents(); from: earliest start
export function findSlot(uid, ev, from, { days = 60, set, win } = {}) {
  const s = settingsOf(uid), rk = ranking(uid, s), rankOf = eventRanker(uid, s, rk), mine = rankOf(ev), len = ev.end - ev.start;
  const rule = ruleOf(uid, ev.calendar_id, ev.series || ev.ext_id);
  const hours = set !== undefined ? set : rule.hours, own = win !== undefined ? win : (set !== undefined ? null : rule.win);
  const to = dayStart(addDays(isoDate(from), days + 1));
  const block = calendarEvents(uid, from, to, s)
    .filter(e => e.blocks && e.id !== ev.id && !(e.calendar_id === ev.calendar_id && e.ext_id === ev.ext_id) && rankOf(e) <= mine)   // same rank or higher
    .flatMap(e => [[e.start - e.before * 60000, e.end + e.after * 60000]]);
  if (rk.of('tasks') < mine) {   // tasks ranked above this calendar: planned blocks, fixed times and blocked time stay
    try { for (const b of getPlan(uid).blocks) block.push([b.s, b.e]); } catch {}
    for (const b of busyOf(uid, from, to, s)) if (b.kind !== 'event' && b.kind !== 'buffer') block.push([b.s, b.e]);
  }
  block.sort((a, b) => a[0] - b[0]);
  const start0 = Math.ceil(from / STEP) * STEP;
  for (let d = isoDate(start0); dayStart(d) < to; d = addDays(d, 1)) {
    for (const [a, b] of windowsOn(s, hours, d, own)) {
      let t = Math.max(a, start0);
      t = Math.ceil(t / STEP) * STEP;
      while (t + len <= b) {
        const hit = block.find(([x, y]) => x < t + len && y > t);
        if (!hit) return { start: t, end: t + len };
        t = Math.ceil(hit[1] / STEP) * STEP;
      }
    }
  }
  return null;
}
