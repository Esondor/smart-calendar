// Pure auto-scheduler: fills ordered work items into free time.
// Plan order, chunks, fixed blocks, busy calendars
// with per-item working hours ("schedules"), earliest start, deadlines, pins, day/time-window preferences.
import { isoDate, addDays, wd, tm, at, dayStart, WINDOWS } from './time.js';

const ranges = v => !v ? [] : Array.isArray(v[0]) ? v : [v];   // ['09:00','17:00'] or [['07:00','08:00'],['18:00','22:00']]
const mergeR = L => L.sort((a, b) => a[0] - b[0]).reduce((o, r) => { const l = o[o.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else o.push([...r]); return o; }, []);

// Where an appointment goes inside its window (e.g. a practice open 08:00–11:00): right next to another appointment
// if one touches the window (one trip, no gap), otherwise about an hour before closing, not first thing in the morning.
const STEP = 5 * 60000;
export function smartSlot(free, need, win, appts) {
  const fits = free.filter(([a, b]) => b - a >= need);
  if (!fits.length || !win) return null;
  const [ws, we] = win, prefer = Math.max(ws, we - Math.max(60 * 60000, need));
  const cands = [];
  for (const [a, b] of fits) {
    for (const [x, y] of appts) {   // touching another appointment, before or after it
      if (y >= a && y + need <= b) cands.push({ s: y, adj: true });
      if (x - need >= a && x <= b) cands.push({ s: x - need, adj: true });
    }
    cands.push({ s: Math.min(Math.max(prefer, a), b - need), adj: false });
  }
  const snap = c => ({ ...c, s: c.adj ? c.s : Math.round(c.s / STEP) * STEP });
  const ok = cands.map(snap).filter(c => fits.some(([a, b]) => c.s >= a && c.s + need <= b));
  ok.sort((p, q) => (q.adj - p.adj) || Math.abs(p.s - prefer) - Math.abs(q.s - prefer));
  return ok.length ? ok[0].s : null;
}

function subtract(free, occ) {
  let fr = free;
  for (const [s, e] of occ) {
    const n = [];
    for (const [a, b] of fr) { if (e <= a || s >= b) n.push([a, b]); else { if (s > a) n.push([a, s]); if (e < b) n.push([e, b]); } }
    fr = n; if (!fr.length) break;
  }
  return fr;
}

/**
 * @param {object} o
 * @param {number} o.now                 ms
 * @param {number} o.horizonDays
 * @param {object} o.hours               { scheduleName: { weekday: [s,e] | [[s,e],...] | null } }
 * @param {number} o.chunk               default smallest block (min)
 * @param {Array<{s:number,e:number,soft?:boolean}>} o.busy   ms intervals; soft = gives way to appointments (meal times)
 * @param {Array} o.items   ordered: { key, remaining, minChunk?, schedule, earliest?, deadline?, days?, window?, pins?:[{s,e}], after?: key }
 *                          after: starts only once that earlier item is finished (projects with a fixed order)
 *                          before: try to finish before this time (a later task of the same ordered project was moved there)
 *                          win: { days, s, e } an appointment: one piece, only in this window, placed smartly (see smartSlot)
 *                          stretch: { s, e } minutes of the day: if its hours run out before its deadline, it may go on
 *                          after them until e (bedtime), and on a day without its hours from s on, rather than be late
 */
export function schedule({ now, horizonDays = 62, hours, chunk = 30, busy = [], items }) {
  const start = Math.ceil(now / 300000) * 300000;  // next 5-minute mark
  const today = isoDate(now), lastDay = addDays(today, horizonDays);
  const occ = new Map();                              // date -> [[s,e]] in ms, sorted lazily
  const occAdd = (s, e) => {
    for (let d = isoDate(s); d <= isoDate(e - 1); d = addDays(d, 1)) {
      const a = Math.max(s, dayStart(d)), b = Math.min(e, dayStart(addDays(d, 1)));
      if (b > a) { if (!occ.has(d)) occ.set(d, []); occ.get(d).push([a, b]); }
    }
  };
  // loose breaks (meals): kept free for ordinary tasks; an appointment or an ASAP task may take their time, then the
  // break moves up to an hour earlier or later, and only if there is no room at all it gives way (see bump).
  // For an ASAP task: breakfast or lunch may give way, but not both on one day; dinner never does, it may move up to 2 h later.
  const soft = new Map(), hard = [], breaks = [], pads = new Set();
  // what a loose break has to keep clear of: everything except default buffers around appointments
  const fixedFor = d => (occ.get(d) || []).filter(([a, b]) => !pads.has(a + ':' + b));
  busy.forEach(b => {
    if (!(b.e > b.s)) return;
    if (b.soft) { const x = { id: b.bid, s: b.s, e: b.e, s0: b.s, e0: b.e, d: isoDate(b.s), meal: b.meal || null, asapOnly: b.only === 'asap' }; breaks.push(x); if (!soft.has(x.d)) soft.set(x.d, []); soft.get(x.d).push(x); }
    else { occAdd(b.s, b.e); if (b.pad) pads.add(b.s + ':' + b.e); if (b.kind === 'event' || b.kind === 'buffer' || b.kind === 'appt') hard.push([b.s, b.e]); }
  });
  const softOf = d => (soft.get(d) || []).filter(x => !x.gone).map(x => [x.s, x.e]);
  // ASAP tasks may use any loose break's time, appointments only that of breaks loose for everything
  const softOf2 = (d, f) => (soft.get(d) || []).filter(x => !x.gone && f(x)).map(x => [x.s, x.e]);
  const occOf = (it, d) => (it.important ? (occ.get(d) || []) : it.win ? [...(occ.get(d) || []), ...softOf2(d, x => x.asapOnly)] : [...(occ.get(d) || []), ...softOf(d)]).sort((x, y) => x[0] - y[0]);
  // where a break could go: inside its day, clear of everything else
  const freeFor = x => { const len = x.e - x.s, taken = [...fixedFor(x.d), ...softOf(x.d).filter(([a]) => a !== x.s)];
    return t => t >= dayStart(x.d) && t + len <= dayStart(addDays(x.d, 1)) && !taken.some(([a, b]) => a < t + len && b > t); };
  // the nearest free spot for a break, up to an hour earlier and `late` minutes later (`extra`: time about to be taken)
  const spotFor = (x, late = 60, extra = []) => {
    const len = x.e - x.s, free = freeFor(x), ok = t => free(t) && !extra.some(([a, b]) => a < t + len && b > t);
    for (let off = 5; off <= Math.max(60, late); off += 5) for (const t of [off <= 60 ? x.s0 - off * 60000 : null, off <= late ? x.s0 + off * 60000 : null]) if (t != null && ok(t)) return t;
    return null;
  };
  const lateOf = (x, asap) => asap && x.meal === 'dinner' ? 120 : 60;
  // may this break be left out for an ASAP task? Not dinner; breakfast or lunch only while the other one stays
  const mayGo = (x, going) => {
    if (x.meal === 'dinner') return false;
    if (x.meal !== 'breakfast' && x.meal !== 'lunch') return true;
    const other = (soft.get(x.d) || []).find(o => o.meal === (x.meal === 'lunch' ? 'breakfast' : 'lunch'));
    return !!other && !other.gone && !going.has(other);
  };
  // the first break that could neither move nor give way if an ASAP task took s–e
  const blocker = (s, e) => {
    const going = new Set();
    for (const x of [...(soft.get(isoDate(s)) || [])].sort((a, b) => a.s - b.s)) {
      if (x.gone || x.e <= s || x.s >= e) continue;
      if (spotFor(x, lateOf(x, true), [[s, e]]) != null) continue;
      if (mayGo(x, going)) going.add(x); else return x;
    }
    return null;
  };
  const bump = (s, e, asap = false) => {
    for (const x of soft.get(isoDate(s)) || []) {
      if (x.gone || x.e <= s || x.s >= e || (x.asapOnly && !asap)) continue;
      const len = x.e - x.s, to = spotFor(x, lateOf(x, asap));
      if (to == null) x.gone = true; else { x.s = to; x.e = to + len; }
    }
  };
  // pins are fixed: reserve them first so nothing else lands there
  items.forEach(it => (it.pins || []).forEach(p => occAdd(p.s, p.e)));

  // loose breaks and the fixed day (appointments, buffers, pins): a break on an appointment moves off it, and a break
  // up to an hour from an appointment moves right next to it, so no short gap is left between them (still within ±1 h)
  for (const xs of soft.values()) for (const x of [...xs].sort((a, b) => a.s - b.s)) {
    if (x.s0 < start || x.asapOnly) continue;   // a break that has begun stays where it is; one loose only for ASAP tasks too
    if (fixedFor(x.d).some(([a, b]) => a < x.e && b > x.s)) bump(x.s, x.e);
    if (x.gone) continue;
    const len = x.e - x.s, free = freeFor(x), H = 60 * 60000, fixed = fixedFor(x.d);
    const prev = Math.max(-Infinity, ...fixed.filter(([, b]) => b <= x.s).map(([, b]) => b));
    const next = Math.min(Infinity, ...fixed.filter(([a]) => a >= x.e).map(([a]) => a));
    const ways = [[x.s - prev, prev], [next - x.e, next - len]].filter(([gap, t]) => gap > 0 && gap <= H && t >= start && Math.abs(t - x.s0) <= H && free(t)).sort((a, b) => a[0] - b[0]);
    if (ways.length) { x.s = ways[0][1]; x.e = x.s + len; }
  }

  const blocks = [], info = {};
  // its hours on a day, with the evening up to bedtime added (a day without its hours: from the morning to bedtime)
  const stretched = (it, date, own) => {
    const w = own(it, date, false), bed = at(date, it.stretch.e);
    const lastEnd = w.length ? Math.max(...w.map(([, b]) => b)) : at(date, it.stretch.s);
    return lastEnd < bed ? [...w, [lastEnd, bed]] : w;
  };
  let windowsOf = (it, date, strict) => {
    if (it.win) return it.win.days.includes(wd(date)) ? [[at(date, tm(it.win.s)), at(date, tm(it.win.e))]] : [];
    // "all": all your hours together (work and personal …), merged, so never at night
    let fr = it.schedule === 'all' ? mergeR(Object.values(hours).flatMap(h => ranges((h || {})[wd(date)]).map(([a, b]) => [tm(a), tm(b)])))
      : ranges((hours[it.schedule] || hours.work || {})[wd(date)]).map(([a, b]) => [tm(a), tm(b)]);
    if (strict && it.window && it.window !== 'any') { const [ws, we] = WINDOWS[it.window] || WINDOWS.any; fr = fr.map(([a, b]) => [Math.max(a, ws), Math.min(b, we)]).filter(([a, b]) => b > a); }
    return fr.map(([a, b]) => [at(date, a), at(date, b)]);
  };

  const done = new Set();
  // batching: right after a task at a location, pull in other tasks at the same location
  // that are already allowed to start and fit completely into the free time directly after it
  const cluster = (it, end) => {
    if (!it.loc || !end) return;
    const base = k => String(k).split('@')[0], taken = new Set([base(it.key)]);
    for (const o of items) {
      if (done.has(o) || o === it || o.loc !== it.loc || (o.pins && o.pins.length) || o.after) continue;
      if (taken.has(base(o.key)) || [...done].some(x => x !== o && base(x.key) === base(o.key) && info[x.key]?.first)) continue;   // one instance of a repeating chore per visit
      if ((o.earliest || 0) > end || o.remaining > 180) continue;
      const d = isoDate(end), need = o.remaining * 60000;
      const fr = subtract(windowsOf(o, d, false).map(([a, b]) => [Math.max(a, end), b]).filter(([a, b]) => b > a), occOf(o, d));
      const slot = fr.find(([a, b]) => a - end <= 10 * 60000 && b - a >= need);
      if (!slot) continue;
      const b = { key: o.key, s: slot[0], e: slot[0] + need, part: 1, parts: 1, batched: it.key };
      blocks.push(b); occAdd(b.s, b.e); done.add(o); taken.add(base(o.key));
      info[o.key] = { first: b.s, end: b.e, unplaced: 0, late: !!(o.deadline && b.e > o.deadline), batchedWith: it.key };
      end = b.e;
    }
  };

  for (const it of items) {
    if (done.has(it)) continue;
    done.add(it);
    const mine = [];
    (it.pins || []).forEach(p => mine.push({ key: it.key, s: p.s, e: p.e, pinned: true }));
    let left = Math.max(0, it.remaining - (it.pins || []).reduce((a, p) => a + Math.max(0, p.e - Math.max(p.s, now)) / 60000, 0));
    const ch = it.minChunk || chunk;
    const from = Math.max(start, it.earliest || 0, (it.after && info[it.after]?.end) || 0);
    const fill = (strict, until, cap = Infinity) => {
      for (let d = isoDate(from); left > 0.5 && d <= until && dayStart(d) < cap; d = addDays(d, 1)) {
        if (strict && it.days && it.days.length && !it.days.includes(wd(d))) continue;
        let fr = windowsOf(it, d, strict).map(([a, b]) => [Math.max(a, from), Math.min(b, cap)]).filter(([a, b]) => b > a);
        fr = subtract(fr, occOf(it, d));
        for (const [a, b] of fr) {
          let cur = a;
          while (left > 0.5 && b - cur >= Math.min(ch, left) * 60000) {
            let use = Math.min(left * 60000, b - cur);
            // an ASAP task stops before a meal that can neither move nor be left out, and goes on after it
            const x = it.important && blocker(cur, cur + use);
            if (x) {
              const min = Math.min(ch, left) * 60000, latest = x.s0 + lateOf(x, true) * 60000;   // e.g. dinner pushed to its latest time
              if (latest - cur >= min && latest - cur < use && !blocker(cur, latest)) use = latest - cur;
              else if (x.s - cur >= min) use = x.s - cur; else { cur = Math.max(cur + 5 * 60000, x.e); continue; }
            }
            mine.push({ key: it.key, s: cur, e: cur + use }); occAdd(cur, cur + use); if (it.important) bump(cur, cur + use, true);
            cur += use; left -= use / 60000;
          }
          if (left <= 0.5) break;
        }
      }
    };
    // an appointment (own window): one piece on the first day it fits, at the best place in the window
    if (it.win) {
      const pad = (it.pad || 0) * 60000, need = left * 60000;   // travel there and back is kept free too
      for (let d = isoDate(from); left > 0.5 && d <= lastDay; d = addDays(d, 1)) {
        const w0 = windowsOf(it, d)[0]; if (!w0) continue;
        // the window widened by the travel time: you may leave before opening, the appointment itself stays inside
        const wx = [w0[0] - pad, w0[1] + pad], fr = subtract([[Math.max(wx[0], from - pad), wx[1]]].filter(([a, b]) => b > a), occOf(it, d));
        const s0 = smartSlot(fr, need + 2 * pad, wx, hard), s = s0 == null ? null : s0 + pad;
        if (s != null && s >= Math.max(w0[0], from) && s + need <= w0[1]) {
          mine.push({ key: it.key, s, e: s + need, travel: it.pad || 0 }); occAdd(s - pad, s + need + pad); bump(s - pad, s + need + pad); left = 0;
        }
      }
    }
    const hasPref = (it.days && it.days.length) || (it.window && it.window !== 'any');
    const dl = it.deadline ? isoDate(it.deadline - 1) : lastDay;
    if (it.win) { /* placed above, or not at all */ }
    else if (it.before) fill(false, lastDay, it.before);   // ordered project: fit in before the moved task that comes after it
    if (!it.win && hasPref) fill(true, dl < lastDay ? dl : lastDay);
    // a deadline that its hours cannot meet: before giving up, the evenings up to bedtime (and days off from the morning)
    if (!it.win && it.stretch && it.deadline && left > 0.5) {
      fill(false, dl);
      if (left > 0.5) { const own = windowsOf; windowsOf = (o, d, strict) => o !== it ? own(o, d, strict) : stretched(o, d, own); fill(false, dl); windowsOf = own; }
    }
    if (!it.win && left > 0.5) fill(false, lastDay);
    mine.sort((a, b) => a.s - b.s);
    mine.forEach((b, i) => { b.part = i + 1; b.parts = mine.length; blocks.push(b); });
    const end = mine.length ? mine[mine.length - 1].e : null;
    info[it.key] = { first: mine.length ? mine[0].s : null, end, unplaced: Math.round(left), late: !!(it.deadline && (left > 0.5 || (end && end > it.deadline))) };
    cluster(it, end);
  }
  blocks.sort((a, b) => a.s - b.s);
  return { blocks, info, breaks: breaks.filter(x => x.gone || x.s !== x.s0).map(x => ({ id: x.id, s0: x.s0, s: x.gone ? null : x.s, e: x.gone ? null : x.e })) };
}
