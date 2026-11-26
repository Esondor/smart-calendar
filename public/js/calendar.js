import { html, useState, useEffect, useLayoutEffect, useRef, S, api, post, patch, load, toast, openModal, confirmDialog, startOfDay, addDays, hm, DN, SH, dh, isoDate, fromIso, n24 } from './lib.js';
import { openTask } from './taskedit.js';
import { I } from './icons.js';
import { blockTime } from './now.js';
import { openEventSheet, EventFields, googleCals, atTime, AlsoDots } from './eventsheet.js';

const H0 = 0, H1 = 24;   // the whole day, 00:00 to 24:00
const WIN = 63, SHIFT = 28;            // day strip: 9 weeks rendered, moved by 4 weeks near an edge
const MWIN = 30, MSHIFT = 8;           // month: 30 weeks rendered, moved by 8 weeks
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// ISO 8601 calendar week
export const isoWeek = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7); const w1 = new Date(d.getFullYear(), 0, 4); return 1 + Math.round(((d - w1) / 864e5 - 3 + (w1.getDay() + 6) % 7) / 7); };
const firstOfMonth = (ms, n = 0) => { const d = new Date(ms); return +new Date(d.getFullYear(), d.getMonth() + n, 1); };
const monday = d => addDays(startOfDay(d), -((new Date(d).getDay() + 6) % 7));
const dayIdx = (from, d) => Math.round((startOfDay(d) - from) / 864e5);
// a task split into several blocks: its open checklist points are shared out over the blocks in order
const partPoints = (points, part = 1, parts = 1) => { const open = (points || []).filter(p => !p.done); if (parts <= 1) return open; const n = Math.ceil(open.length / parts); return open.slice((part - 1) * n, part * n); };
function lanes(items) {   // side-by-side layout for overlapping items
  items.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], end = 0;
  const flush = () => { const cols = []; cluster.forEach(it => { let c = cols.findIndex(e => e <= it.s); if (c < 0) { c = cols.length; cols.push(0); } cols[c] = it.e; it.lane = c; }); cluster.forEach(it => it.lanes = cols.length); cluster = []; };
  items.forEach(it => { if (it.s >= end && cluster.length) flush(); cluster.push(it); end = Math.max(end, it.e); });
  flush(); return items;
}
export async function newEvent(ms) {
  const cals = googleCals(); if (!cals.length) return toast('Connect Google to add events');
  const r = await openModal(close => { const B = () => { const s0 = ms || Math.ceil(Date.now() / 900000) * 900000;
    const [f, setF] = useState({ title: '', all_day: false, day: isoDate(s0), s: hm(s0), e: hm(s0 + 3600e3), cal: (cals.find(c => c.use_busy) || cals[0]).id, location: '' });
    return html`<div class="modal sm"><h3>New Event</h3><${EventFields} f=${f} set=${x => setF({ ...f, ...x })} cals=${cals}/>
      <div class="acts"><button onClick=${() => close(null)}>Cancel</button><button class="pri" disabled=${!f.title.trim()} onClick=${() => close(f)}>Add</button></div></div>`; }; return html`<${B}/>`; });
  if (!r) return;
  const start = r.all_day ? fromIso(r.day) : atTime(r.day, r.s), end = r.all_day ? addDays(fromIso(r.day), 1) : atTime(r.day, r.e);
  try { await post('/api/events', { calendar_id: r.cal, title: r.title.trim(), start, end, all_day: r.all_day, location: (r.location || '').trim() }); await load(['plan']); toast('Event added'); } catch (e) { toast(e.message); }
}
const store = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const stored = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };

export default function CalendarView() {
  const st = S.state;
  const mobile = matchMedia('(max-width:860px)').matches, GUT = mobile ? 44 : 52;
  const [mode, setMode] = useState(() => stored('cal-mode', mobile ? 'day' : 'week'));
  const month = mode === 'month', n = mode === 'day' ? 1 : mobile ? 3 : 7;
  const [who, setWho] = useState(st.me.id);
  const [collapse, setCollapse] = useState(() => stored('cal-collapse', '1') === '1');
  const target0 = d => month ? monday(firstOfMonth(d)) : mode === 'week' && !mobile ? monday(d) : startOfDay(d);
  const [focus, setFocus] = useState(() => month ? firstOfMonth(Date.now()) : target0(Date.now()));   // first visible day / the visible month
  const lastDay = useRef(null);
  useEffect(() => { if (!month) lastDay.current = focus; }, [focus, month]);
  const [from, setFrom] = useState(() => month ? addDays(monday(firstOfMonth(Date.now())), -70) : addDays(target0(Date.now()), -21));
  const sc = useRef(), pending = useRef({ day: target0(Date.now()) }), [size, setSize] = useState({ w: 0, h: 0 });
  // pinch to zoom (phone): the hour height, kept between visits
  const [zoom, setZoom] = useState(() => Math.min(2.2, Math.max(0.45, +stored('cal-zoom', '1') || 1)));
  const hh = Math.round((n === 1 ? 96 : 46) * (mobile ? zoom : 1));
  const cw = size.w ? (size.w - GUT) / n : 0, rowH = size.h ? (size.h - 28) / 5 : 0;
  const span = month ? MWIN * 7 : WIN, to = addDays(from, span);
  const [plan, setPlan] = useState(null);
  useEffect(() => { api(`/api/plan?from=${from}&to=${to}&user=${who}`).then(setPlan).catch(e => toast(e.message)); }, [from, mode, who, st.plan]);
  useEffect(() => { const el = sc.current; if (!el) return; const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); return () => ro.disconnect(); }, [mode]);

  // scroll position: slide to a day; keep the view still when the rendered window moves
  const unit = month ? rowH : cw;
  // the rendered window only moves while nothing is animating or under a finger (moving it mid-slide sent the slide on
  // to the old place, past the next edge, and on and on)
  const anim = useRef(null), touch = useRef(null), busy = () => !!anim.current || touch.current?.axis === 'x';
  // phone: the days are moved sideways by the app (a transform of the strip, the hours column held in place), not
  // through the scroller's sideways position: iOS resets that one while you scroll up or down, which jumped weeks back
  // and, put back every frame, flickered. The scroller itself only scrolls up and down.
  const want = useRef(null), guard = mobile && !month && matchMedia('(pointer:coarse)').matches, track = useRef();
  const applyX = () => { const t = track.current; if (!guard || !t) return; const x = want.current || 0;
    t.style.transform = `translate3d(${-x}px,0,0)`; t.querySelectorAll(':scope > .crow > .corner, :scope > .ctop > .crow > .corner').forEach(c => { c.style.transform = `translate3d(${x}px,0,0)`; }); };
  const setLeft = (el, v) => { if (guard) { want.current = Math.max(0, v); applyX(); onScroll(); } else el.scrollLeft = v; };   // no scroll event here: tell the title
  const getLeft = el => guard ? want.current || 0 : el.scrollLeft;
  useLayoutEffect(applyX);
  const prevCw = useRef(0);   // turned the phone: the same day at the new width
  useLayoutEffect(() => { const el = sc.current; if (guard && el && want.current != null && prevCw.current && cw && prevCw.current !== cw) setLeft(el, Math.round(want.current / prevCw.current) * cw); prevCw.current = cw; }, [cw]);
  const slide = (to, v) => {   // our own ease-out slide (phone): starts at the finger's speed v (px/ms), stops where a finger catches it
    const el = sc.current; if (!el) return;
    const from0 = getLeft(el), d = to - from0; if (Math.abs(d) < 1) { setLeft(el, to); return; }
    const ms = v ? Math.min(450, Math.max(200, 3 * Math.abs(d) / Math.max(Math.abs(v), 0.3))) : Math.min(380, Math.max(200, Math.abs(d) / (cw || 1) * 140));
    const t0 = performance.now(), me = {}; anim.current = me;
    const step = t => { if (anim.current !== me) return;
      const k = Math.min(1, (t - t0) / ms); setLeft(el, from0 + d * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step); else { anim.current = null; onScroll(); } };
    requestAnimationFrame(step);
  };
  const go = (day, smooth) => {
    const t = month ? monday(day) : day, i = month ? dayIdx(from, t) / 7 : dayIdx(from, t);
    const max = month ? MWIN - 5 : WIN - n;
    if (i < 5 || i > max - 5) { anim.current = null; pending.current = { day: t, now: false }; setFrom(month ? addDays(t, -70) : addDays(t, -21)); return; }   // too near an edge: re-centre first
    if (guard) return smooth ? slide(i * unit) : setLeft(sc.current, i * unit);
    if (smooth && !month && mobile) return slide(i * unit);
    sc.current?.scrollTo({ [month ? 'top' : 'left']: i * unit, behavior: smooth ? 'smooth' : 'auto' });
  };
  useLayoutEffect(() => {
    const el = sc.current, p = pending.current; if (!el || !unit || !p) return;
    pending.current = null;
    if (p.keep != null) { if (guard) setLeft(el, p.keep); else el.scrollTo({ [month ? 'top' : 'left']: p.keep, behavior: 'auto' }); return; }
    const i = month ? dayIdx(from, monday(p.day)) / 7 : dayIdx(from, p.day);
    if (guard) setLeft(el, i * unit); else el.scrollTo({ [month ? 'top' : 'left']: i * unit, behavior: 'auto' });
    if (!month && p.now !== false) el.scrollTop = Math.max(0, (new Date().getHours() - H0 - 1.5) * hh);
  });
  // phone, like a calendar app: the days follow the finger sideways and settle on the day that shows the most when
  // let go; a quick flick turns one day; up and down scrolls the hours; two fingers zoom.
  // The direction is fixed by the first few points of movement, so a scroll never turns into a page turn halfway.
  useEffect(() => {
    const el = sc.current; if (!el || month || !mobile) return;
    const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const settle = () => { if (cw) slide(Math.round(getLeft(el) / cw) * cw); };
    const start = e => {
      if (e.touches.length === 2) { anim.current = null; const r = el.getBoundingClientRect(), my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
        touch.current = { pinch: true, d0: dist(e.touches), z0: zoom, hours: (el.scrollTop + my) / hh, my }; return; }
      if (e.touches.length !== 1) return;
      const caught = !!anim.current; anim.current = null;   // a finger stops a slide where it is
      touch.current = e.target.closest('.ev.sel, .ev.drag') ? null   // a selected block is being moved, not the days
        : { x: e.touches[0].clientX, y: e.touches[0].clientY, sl: getLeft(el), st: el.scrollTop, axis: null, caught, t0: e.timeStamp, pts: [[e.touches[0].clientX, e.timeStamp]] };
    };
    const move = e => {
      const g = touch.current; if (!g) return;
      if (g.pinch) {
        if (e.touches.length !== 2) return;
        e.preventDefault();
        const z = Math.min(2.2, Math.max(0.45, g.z0 * dist(e.touches) / g.d0)); g.z = z; setZoom(z);
        const nh = Math.round((n === 1 ? 96 : 46) * z); el.scrollTop = Math.max(0, g.hours * nh - g.my);   // keep the hour under the fingers
        return;
      }
      const p = e.touches[0], dx = p.clientX - g.x, dy = p.clientY - g.y;
      // one direction per gesture: decided after the first few points; once the browser scrolls up or down by itself
      // (the move can't be held back any more), it stays up/down. Sideways, the hours stay exactly where they were.
      if (!g.axis) {
        if (Math.hypot(dx, dy) < 7) return;
        g.axis = Math.abs(dx) > Math.abs(dy) * 1.2 && e.cancelable ? 'x' : 'y';
      }
      if (g.axis !== 'x') return;
      if (e.cancelable) e.preventDefault();
      if (el.scrollTop !== g.st) el.scrollTop = g.st;
      setLeft(el, g.sl - dx);
      g.pts.push([p.clientX, e.timeStamp]); if (g.pts.length > 6) g.pts.shift();
    };
    const end = e => {
      const g = touch.current; if (!g) return;
      if (g.pinch) { if (e.touches.length === 0) { touch.current = null; if (g.z) store('cal-zoom', String(g.z)); } return; }
      if (e.touches.length) return;
      touch.current = null;
      if (g.axis !== 'x' || !cw) { if (g.caught || g.axis !== 'y') settle(); return; }   // never left between two days
      const q = g.pts, [x1, t1] = q[q.length - 1], [x0, t0] = q[0], v = t1 > t0 ? (x1 - x0) / (t1 - t0) : 0;   // px per ms, + = finger to the right
      // a quick swipe: in day view exactly one day, with several days on screen as far as its speed carries, one to
      // n days (one page at most); a slower drag, where the days follow the finger, ends on the day that shows the most
      const i0 = Math.round(g.sl / cw), pos = getLeft(el), quick = t1 - g.t0 < 300 && Math.abs(v) > 0.2 && Math.abs(pos - g.sl) > 10;
      let i = Math.round(pos / cw);
      if (quick) { const dir = pos > g.sl ? 1 : -1, far = Math.round(Math.abs(pos - v * 180 - g.sl) / cw);
        i = i0 + dir * Math.max(1, Math.min(n, far)); }
      i = Math.max(0, Math.min(span - n, i));
      slide(i * cw, v);
    };
    el.addEventListener('touchstart', start, { passive: true }); el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end, { passive: true }); el.addEventListener('touchcancel', end, { passive: true });
    return () => { el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', end); el.removeEventListener('touchcancel', end); };
  }, [month, mobile, zoom, hh, focus, cw, from]);
  const ticking = useRef(false);
  // more days/weeks are rendered only once scrolling has come to rest: on a phone the momentum (and the snapping in
  // month view) carries on after the finger lifts, and moving the window under it sent it scrolling on without end
  const live = useRef({}), idle = useRef(null);
  live.current = { from, unit, month, n, getLeft };
  useEffect(() => () => clearTimeout(idle.current), []);
  function onScroll() {
    if (ticking.current || !unit) return; ticking.current = true;
    requestAnimationFrame(() => {
      ticking.current = false; const el = sc.current; if (!el) return;
      const pos = month ? el.scrollTop : getLeft(el), i = Math.round(pos / unit);
      if (month) { const mid = firstOfMonth(addDays(from, (i + 2) * 7 + 3)); if (mid !== focus) setFocus(mid); }
      else if (!busy()) { const f = addDays(from, i); if (f !== focus) setFocus(f); }   // the title follows once the days stand still: no redraw mid-slide
      clearTimeout(idle.current); idle.current = setTimeout(edge, 200);
    });
  }
  function edge() {
    const el = sc.current, L = live.current; if (!el || !L.unit) return;
    if (busy() || touch.current || pending.current) { idle.current = setTimeout(edge, 200); return; }
    const pos = L.month ? el.scrollTop : L.getLeft(el), i = Math.round(pos / L.unit);
    const max = L.month ? MWIN - 5 : WIN - L.n, sh = L.month ? MSHIFT : SHIFT, stepDays = L.month ? sh * 7 : sh;
    if (i < 4) { pending.current = { keep: pos + sh * L.unit }; setFrom(addDays(L.from, -stepDays)); }
    else if (i > max - 4) { pending.current = { keep: pos - sh * L.unit }; setFrom(addDays(L.from, stepDays)); }
  }
  // the day to keep when switching: from month, the day last shown in day/week if it is in this month, else today if it is,
  // else the 1st; into month, today's month if today is on screen
  const switchMode = m => { if (m === mode) return; store('cal-mode', m); setSel(null);
    const now = startOfDay(Date.now()), sameM = d => new Date(d).getMonth() === new Date(focus).getMonth() && new Date(d).getFullYear() === new Date(focus).getFullYear();
    const day = month ? (sameM(lastDay.current) ? lastDay.current : sameM(now) ? now : focus) : now >= focus && now <= addDays(focus, n - 1) ? now : focus;
    const f = m === 'month' ? monday(firstOfMonth(day)) : m === 'week' && !mobile ? monday(day) : startOfDay(day);
    pending.current = { day: f }; setFocus(m === 'month' ? firstOfMonth(day) : f); setFrom(addDays(f, m === 'month' ? -70 : -21)); setSize({ w: 0, h: 0 }); setMode(m); };
  const openDay = d => { store('cal-mode', 'day'); pending.current = { day: d }; setFocus(d); setFrom(addDays(d, -21)); setSize({ w: 0, h: 0 }); setMode('day'); };
  const today = () => go(month ? monday(firstOfMonth(Date.now())) : target0(Date.now()), true);
  const step = k => go(month ? monday(firstOfMonth(focus, k)) : addDays(focus, k * n), true);

  const partners = st.users.filter(u => u.id !== st.me.id && st.projects.some(p => p.members.some(m => m.id === u.id)));
  const top = ms => ((ms - startOfDay(ms)) / 3600e3 - H0) * hh;
  const toggleCollapse = () => { store('cal-collapse', collapse ? '0' : '1'); setCollapse(!collapse); };

  const dayItems = d0 => {
    const d1 = addDays(d0, 1), out = [], allDay = [], mini = [];
    if (!plan) return { out, allDay, mini };
    plan.events.filter(e => e.end + e.after * 60000 > d0 && e.start - e.before * 60000 < d1).forEach(e => {
      if (e.all_day || e.end - e.start >= 864e5) { if (e.end > d0 && e.start < d1) allDay.push({ t: e.title, cal: e.cal, free: !e.blocks, color: e.color, ev: e }); return; }
      const x = { kind: 'event', ev: e, s: Math.max(e.start - e.before * 60000, d0), e: Math.min(e.end + e.after * 60000, d1), s0: Math.max(e.start, d0), e0: Math.min(e.end, d1), t: e.title, cal: e.cal, free: !e.blocks, color: e.color };
      (collapse && (!e.blocks || e.hidden) ? mini : out).push(x);
    });
    plan.busy.filter(b => b.e > d0 && b.s < d1).forEach(b => out.push({ kind: b.kind === 'fixed' ? 'fixed' : 'appt', s: Math.max(b.s, d0), e: Math.min(b.e, d1), t: b.t, id: b.id }));
    plan.blocks.filter(b => b.e > d0 && b.s < d1).forEach(b => { const u = plan.units[b.key]; if (u) out.push({ kind: 'block', s: b.s, e: b.e, b, u }); });
    // done and tracked: kept as it happened (timer sessions; a task ticked off without one, as the quarter hour before)
    const log = plan.log || [];
    log.filter(l => l.end > d0 && l.start < d1).forEach(l => out.push({ kind: 'past', s: Math.max(l.start, d0), e: Math.min(l.end, d1), s1: l.start, e1: l.end, t: l.title || 'Session', c: l.color, p: l.p_name, done: !!l.done, task: l.task_id, research: l.kind === 'research' }));
    (plan.done || []).filter(x => x.at >= d0 && x.at < d1 && !log.some(l => l.task_id === x.id && l.start <= x.at + 300000 && l.end >= x.at - 300000))
      .forEach(x => out.push({ kind: 'past', s: Math.max(d0, x.at - 900000), e: x.at, s1: x.at, e1: x.at, t: x.title, c: x.color, done: true, task: x.id, tick: true }));
    return { out: lanes(out.filter(x => !x.nolane)).concat(out.filter(x => x.nolane)), allDay, mini };
  };

  // first tap selects a block (then it can be dragged / resized), a second tap opens it; scrolling never moves anything
  const drag = useRef(null), [sel, setSel] = useState(null);
  const selKey = it => it.b.key + ':' + it.b.s;
  const onDown = (e, it) => {
    const el = e.currentTarget;
    if (who !== st.me.id || sel !== selKey(it)) { drag.current = { it, tap: true, x0: e.clientX, y0: e.clientY }; return; }
    drag.current = { it, el, x0: e.clientX, y0: e.clientY, cw: el.parentElement.getBoundingClientRect().width, moved: false, dm: 0, dd: 0, resize: !!e.target.closest('.rs'), h0: el.offsetHeight };
    el.setPointerCapture(e.pointerId);
  };
  const onCancel = () => { const g = drag.current; drag.current = null; if (g?.el) { g.el.style.transform = ''; g.el.style.height = ''; g.el.classList.remove('drag'); } };
  const onMove = e => {
    const g = drag.current; if (!g) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (g.tap) { if (Math.hypot(dx, dy) > 8) drag.current = null; return; }
    if (!g.moved && Math.hypot(dx, dy) < 6) return;
    g.moved = true; g.el.classList.add('drag');
    g.dm = Math.round(dy / hh * 4) * 15; g.dd = g.resize ? 0 : Math.round(dx / g.cw);
    if (g.resize) { g.dm = Math.max(g.dm, 15 - (g.it.e - g.it.s) / 60000); g.el.style.height = (g.h0 + g.dm / 60 * hh) + 'px'; g.el.querySelector('.em').textContent = `${hm(g.it.s)}–${hm(g.it.e + g.dm * 60000)}`; return; }
    g.el.style.transform = `translate(${g.dd * g.cw}px, ${g.dm / 60 * hh}px)`;
    g.el.querySelector('.em').textContent = `${hm(g.it.s + g.dm * 60000 + g.dd * 864e5)}–${hm(g.it.e + g.dm * 60000 + g.dd * 864e5)}`;
  };
  const onUp = async () => {
    const g = drag.current; drag.current = null; if (!g) return;
    const isEv = g.it.kind === 'event';
    if (g.tap) return who !== st.me.id ? (isEv ? null : openTask(g.it.u.taskId)) : isEv && !g.it.ev.editable ? eventSheet(g.it.ev) : setSel(selKey(g.it));
    if (!g.moved) { setSel(null); return isEv ? eventSheet(g.it.ev) : blockSheet(g.it); }
    setSel(null);
    const shift = g.dm * 60000 + g.dd * 864e5;
    if (!shift) { g.el.style.transform = ''; g.el.style.height = ''; g.el.classList.remove('drag'); return; }
    if (isEv) {
      const ev = g.it.ev, body = { start: g.resize ? ev.start : ev.start + shift, end: ev.end + shift };
      if (ev.recurring && !(await confirmDialog(`Move only this “${ev.title}”?`, 'This Event'))) { g.el.style.transform = ''; g.el.style.height = ''; g.el.classList.remove('drag'); return; }
      try { await patch('/api/events/' + ev.id, body); await load(['plan']); } catch (err) { toast(err.message); g.el.style.transform = ''; g.el.style.height = ''; }
      return;
    }
    try { await post(`/api/tasks/${g.it.u.taskId}/pin`, { period: g.it.u.period || 0, oldStart: g.it.s, s: g.resize ? g.it.s : g.it.s + shift, e: g.it.e + shift }); await load(['plan', 'tasks']); }
    catch (err) { toast(err.message); g.el.style.transform = ''; }
  };
  const moved = it => (plan?.moved || []).some(m => m.task_id === it.u.taskId && m.period === (it.u.period || 0));
  const blockSheet = async it => {
    if (!it.b.pinned && !moved(it)) return openTask(it.u.taskId);
    const v = await openModal(close => html`<div class="modal sm"><h3>${it.u.title}</h3><div class="hint" style="margin:-4px 0 12px">${hm(it.s)}–${hm(it.e)} · ${it.u.p_name}</div>
      <div class="menu"><button onClick=${() => close('auto')}>${I('repeat')}Auto-schedule</button><button onClick=${() => close('open')}>${I('list')}Open Task</button></div>
      <div class="acts"><button onClick=${() => close(null)}>Cancel</button></div></div>`);
    if (v === 'open') openTask(it.u.taskId);
    if (v === 'auto') { try { await post(`/api/tasks/${it.u.taskId}/auto`, { period: it.u.period || 0 }); await load(['plan', 'tasks']); } catch (e) { toast(e.message); } }
  };
  const eventSheet = ev => { if (who === st.me.id) openEventSheet(ev); };
  const clickEmpty = async (e, d0) => {
    if (e.target !== e.currentTarget) return;
    if (sel) return setSel(null);
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top, ms = d0 + Math.floor((y / hh + H0) * 4) * 900000;
    const v = await openModal(close => html`<div class="modal sm"><h3>${DN[new Date(ms).getDay()]} ${SH(ms)}, ${hm(ms)}</h3>
      <div class="menu"><button onClick=${() => close('task')}>${I('plus')}New Task</button>${googleCals().length > 0 && html`<button onClick=${() => close('event')}>${I('calendar')}New Event</button>`}<button onClick=${() => close('block')}>${I('block')}Block Time</button></div>
      <div class="acts"><button onClick=${() => close(null)}>Cancel</button></div></div>`);
    if (v === 'block') blockTime(ms);
    if (v === 'event') newEvent(ms);
    if (v === 'task') { const t = await openTask('new'); if (t?.id) { await post(`/api/tasks/${t.id}/pin`, { period: t.period || 0, s: ms, e: ms + (t.duration || 30) * 60000 }); load(['plan']); } }
  };

  const nowMs = Date.now(), t0 = startOfDay(nowMs);
  const lastVis = addDays(focus, n - 1);
  const title = month ? `${MONTHS[new Date(focus).getMonth()]} ${new Date(focus).getFullYear()}` : n === 1 ? `${DN[new Date(focus).getDay()]} ${SH(focus)}` : `${SH(focus)} – ${SH(lastVis)}`;
  const wk = isoWeek(focus) + (!month && isoWeek(lastVis) !== isoWeek(focus) ? '–' + isoWeek(lastVis) : '');
  const days = Array.from({ length: span }, (_, i) => addDays(from, i));

  const renderCol = d0 => { const { out, mini } = dayItems(d0);
    return html`<div class=${'daycol' + (d0 === t0 ? ' today' : '')} key=${d0} onClick=${e => clickEmpty(e, d0)}>
      ${out.map(x => {
        const style = { top: top(x.s) + 'px', height: Math.max(14, (x.e - x.s) / 3600e3 * hh - 2) + 'px' };
        if (x.lanes > 1) { style.left = `calc(${100 * x.lane / x.lanes}% + 2px)`; style.width = `calc(${100 / x.lanes}% - 4px)`; style.right = 'auto'; }
        if (x.kind === 'past') return html`<div class=${'ev past' + (x.done ? ' dn' : '')} style=${{ ...style, '--c': x.c || 'var(--done)' }} title=${`${x.t}${x.p ? '\n' + x.p : ''}\n${x.tick ? 'Done ' + hm(x.e1) : hm(x.s1) + '–' + hm(x.e1)}`} onClick=${x.task ? () => openTask(x.task) : null}>
          <span class="et">${x.done ? html`<span class="kind">${I('check', 12)}</span>` : ''}${x.research ? 'Research · ' : ''}${x.t}</span><span class="em">${x.tick ? 'Done ' + hm(x.e1) : `${hm(x.s1)}–${hm(x.e1)}`}${n === 1 && x.p ? ' · ' + x.p : ''}</span></div>`;
        if (x.kind === 'block') { const cur = plan.active && plan.active.task_id === x.u.taskId, fit = Math.floor(((x.e - x.s) / 3600e3 * hh - 44) / 16), pts = n === 1 && fit > 0 ? partPoints(x.u.points, x.b.part, x.b.parts).slice(0, fit) : [];   // only as many points as fit
          return html`<div class=${'ev block' + (x.b.pinned ? ' pinned' : '') + (x.u.late ? ' late' : '') + (cur ? ' cur' : '') + (sel === selKey(x) ? ' sel' : '')} style=${{ ...style, background: x.u.p_color }}
            onPointerDown=${e => onDown(e, x)} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onCancel} title=${`${x.u.title}\n${x.u.p_name}${x.u.late ? '\nAfter deadline' : ''}`}>
            <span class="et">${x.u.meta?.win ? html`<span class="kind">${I('flex', 12)}</span>` : ''}${x.u.title}</span><span class="em">${hm(x.s)}–${hm(x.e)}${x.b.parts > 1 ? ` · ${x.b.part}/${x.b.parts}` : ''}${n === 1 && x.u.p_name ? ' · ' + x.u.p_name : ''}</span>
            ${pts.length > 0 && html`<ul class="epts">${pts.map(p => html`<li>${p.t}</li>`)}</ul>`}<div class="rs"></div></div>`; }
        if (x.kind === 'event') {
          const ev = x.ev, part = (s0, e0) => ({ ...style, top: top(s0) + 'px', height: Math.max(4, (e0 - s0) / 3600e3 * hh - (e0 === x.e ? 2 : 0)) + 'px' });
          const bc = { '--bc': x.color || 'var(--faint)' }, open = () => eventSheet(ev);
          return html`
            ${x.s < x.s0 && html`<div class="ev buf b" style=${{ ...part(x.s, x.s0), ...bc }} onClick=${open} title=${ev.travel?.there ? `${dh(ev.travel.min)} by ${ev.travel.mode}` : dh(ev.before) + ' before'}>${(x.s0 - x.s) / 3600e3 * hh > 14 ? html`${ev.travel?.there ? html`<span class="way">${I(ev.travel.mode, 11)}</span>` : ''}${dh(ev.before)}` : ''}</div>`}
            ${(() => { const it = { kind: 'event', ev, s: ev.start, e: ev.end, b: { key: 'e' + ev.id, s: ev.start } };
              return html`<div class=${'ev busy' + (x.free ? ' free' : '') + (ev.before || ev.after ? ' hasb' : '') + (sel === selKey(it) ? ' sel' : '')} style=${{ ...part(x.s0, x.e0), ...bc, ...(x.color && !x.free ? { borderLeft: `3px solid ${x.color}` } : {}) }} title=${`${x.t}\n${x.cal}`}
                onPointerDown=${e => onDown(e, it)} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onCancel}>
                <span class="et"><span class="kind">${I('pin', 12)}</span>${x.t}<${AlsoDots} ev=${ev}/></span><span class="em">${hm(ev.start)}–${hm(ev.end)} · ${x.cal}</span>${ev.editable && html`<div class="rs"></div>`}</div>`; })()}
            ${x.e > x.e0 && html`<div class="ev buf a" style=${{ ...part(x.e0, x.e), ...bc }} onClick=${open} title=${ev.travel?.home ? `Home: ${dh(ev.travel.min)} by ${ev.travel.mode}` : dh(ev.after) + ' after'}>${(x.e - x.e0) / 3600e3 * hh > 14 ? html`${ev.travel?.home ? html`<span class="way">${I(ev.travel.mode, 11)}</span>` : ''}${dh(ev.after)}` : ''}</div>`}`;
        }
        return html`<div class=${'ev ' + x.kind} style=${style} title=${x.t}
          onClick=${x.id ? async () => { if (await confirmDialog(`Remove “${x.t}”?`, 'Remove', true)) { await api('/api/appts/' + x.id, { method: 'DELETE', body: {} }); load(['plan']); } } : null}>
          <span class="et">${x.t}</span><span class="em">${hm(x.s)}–${hm(x.e)}</span></div>`;
      })}
      ${mini.map(x => html`<div class="ev mini" style=${{ top: top(x.s0) + 'px', height: Math.max(6, (x.e0 - x.s0) / 3600e3 * hh - 2) + 'px', '--c': x.color || 'var(--faint)' }} title=${`${x.t}\n${hm(x.ev.start)}–${hm(x.ev.end)} · ${x.cal}`} onClick=${() => eventSheet(x.ev)}></div>`)}
      ${d0 === t0 && html`<div class="nowl" style=${{ top: top(nowMs) + 'px' }}></div>`}
    </div>`; };

  return html`<div class="cal" style=${{ '--hh': hh + 'px', '--cw': cw + 'px', '--gut': GUT + 'px', '--rowh': rowH + 'px' }}>
    <div class="ptools" style="padding-bottom:8px">
      <b style="font-size:17px;min-width:150px">${title}</b>
      <div class="seg">${[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([k, l]) => html`<button class=${mode === k ? 'on' : ''} onClick=${() => switchMode(k)}>${l}</button>`)}</div>
      <span class="grow"></span>
      <button class="icon calnav" title="Previous" onClick=${() => step(-1)}>${I('left')}</button>
      <button onClick=${today}>Today</button>
      <button class="icon calnav" title="Next" onClick=${() => step(1)}>${I('right')}</button>
      <button class=${'icon' + (collapse ? '' : ' on')} title=${collapse ? 'Show non-blocking events' : 'Minimise non-blocking events'} onClick=${toggleCollapse}>${I(collapse ? 'eyeoff' : 'eye', 18)}</button>
      ${partners.length > 0 && html`<select value=${who} onChange=${e => setWho(+e.target.value)}><option value=${st.me.id}>${st.me.name}</option>${partners.map(u => html`<option value=${u.id}>${u.name}</option>`)}</select>`}
    </div>
    ${month ? html`
      ${mobile && html`<div class="mtitle">${MONTHS[new Date(focus).getMonth()]} <span>${new Date(focus).getFullYear()}</span></div>`}
      <div class="mscroll" ref=${sc} onScroll=${onScroll} key="m">
        <div class="mhead"><div></div>${[1, 2, 3, 4, 5, 6, 0].map(d => html`<div>${mobile ? DN[d].charAt(0) : DN[d]}</div>`)}</div>
        ${rowH > 0 && Array.from({ length: MWIN }, (_, w) => html`<${MonthRow} key=${addDays(from, w * 7)} w0=${addDays(from, w * 7)} plan=${plan} focusM=${new Date(focus).getMonth()} openDay=${openDay} mobile=${mobile} collapse=${collapse}/>`)}
      </div>` : html`
      <div class="cscroll" ref=${sc} onScroll=${onScroll} key=${'d' + n}>
        ${cw > 0 && html`<div class="ctrack" ref=${track} style=${{ width: GUT + span * cw + 'px' }}>
          <div class="ctop">
            <div class="crow chead"><div class="corner wk">W${wk}</div>${days.map(d => { const m = plan ? plan.blocks.filter(b => b.s >= d && b.s < addDays(d, 1)).reduce((a, b) => a + (b.e - b.s) / 60000, 0) : 0;
              return html`<div class=${'dh' + (d === t0 ? ' today' : '')} key=${d}>${DN[new Date(d).getDay()]} <b>${new Date(d).getDate()}</b><div class="stat">${m ? dh(m) : ''}</div></div>`; })}</div>
            <div class="crow callday"><div class="corner"></div>${days.map(d => html`<div class="adcell" key=${d}>${dayItems(d).allDay.map(x => collapse && x.free
              ? html`<div class="ev admini" style=${{ '--c': x.color || 'var(--faint)' }} title=${x.t} onClick=${() => eventSheet(x.ev)}></div>`
              : html`<div class=${'ev busy' + (x.free ? ' free' : '')} title=${x.cal} onClick=${() => eventSheet(x.ev)}>${x.t}</div>`)}</div>`)}</div>
          </div>
          <div class="crow cbody" style=${{ height: (H1 - H0) * hh + 'px' }}>
            <div class="corner hours">${Array.from({ length: H1 - H0 }, (_, i) => html`<div>${i ? String(H0 + i).padStart(2, '0') + ':00' : ''}</div>`)}</div>
            ${days.map(renderCol)}
          </div>
        </div>`}
      </div>`}
  </div>`;
}

// month: weeks scroll continuously and snap to whole rows; week numbers first, all-day bars, then timed items with their start time
function MonthRow({ w0, plan, focusM, openDay, mobile, collapse }) {
  const today = startOfDay(Date.now()), max = mobile ? 3 : 4;
  const items = d0 => {
    const d1 = addDays(d0, 1), all = [], timed = [];
    if (!plan) return { all, timed };
    plan.events.filter(e => e.end > d0 && e.start < d1 && !(collapse && (!e.blocks || e.hidden))).forEach(e => (e.all_day || e.end - e.start >= 864e5 ? all : timed).push({ s: e.start, t: e.title, c: e.color || 'var(--faint)', free: !e.blocks }));
    const seen = new Set();
    plan.blocks.filter(b => b.s >= d0 && b.s < d1).forEach(b => { const u = plan.units[b.key]; if (!u || seen.has(b.key)) return; seen.add(b.key); timed.push({ s: b.s, t: u.title, c: u.p_color, plan: true }); });
    plan.busy.filter(b => b.kind !== 'fixed' && b.s >= d0 && b.s < d1).forEach(b => timed.push({ s: b.s, t: b.t, c: 'var(--now)' }));
    timed.sort((a, b) => a.s - b.s);
    return { all, timed };
  };
  return html`<div class="mrow"><div class="mwk">${isoWeek(w0)}</div>${Array.from({ length: 7 }, (_, i) => { const d = addDays(w0, i), dt = new Date(d), { all, timed } = items(d), list = [...all.map(x => ({ ...x, bar: true })), ...timed], more = list.length - max;
    return html`<div class=${'mday' + (dt.getMonth() !== focusM ? ' out' : '') + (d === today ? ' today' : '') + (dt.getDay() % 6 === 0 ? ' we' : '')} onClick=${() => openDay(d)}>
      <div class="mnum"><b>${dt.getDate() === 1 && !mobile ? `1. ${MONTHS[dt.getMonth()].slice(0, 3)}` : dt.getDate()}</b></div>
      ${list.slice(0, more > 0 ? max - 1 : max).map(x => x.bar
        ? html`<div class=${'mbar' + (x.free ? ' free' : '')} style=${{ '--c': x.c }}>${x.t}</div>`
        : html`<div class=${'mit' + (x.plan ? ' plan' : '')} style=${{ '--c': x.c }}><span>${x.t}</span>${!mobile && html`<time>${hm(x.s)}</time>`}</div>`)}
      ${more > 0 && html`<div class="mmore">+${more + 1} more</div>`}
    </div>`; })}</div>`;
}
