// Demo: answers the app's /api requests in the browser from data.json (recorded by scripts/demo.mjs), moved to
// today. Every action shows on screen as it would in the app (nothing is sent anywhere); it is kept until the page
// reloads.
(() => {
  const base = new URL('.', document.currentScript.src).href;
  const DAY = 864e5;
  let db = null, days = 0;
  // recorded as UTC wall-clock: shown at the same clock time in the visitor's zone, moved by whole weeks to the week of today
  const t0 = new Date(); const today = Date.UTC(t0.getFullYear(), t0.getMonth(), t0.getDate());
  days = Math.round((today - window.DEMO_DAY) / DAY / 7) * 7;
  // the demo's clock: 14:20 on its day (moved to this week), ticking on from there
  { const R = Date, real0 = R.now(), b = new R(window.DEMO_DAY), fake0 = +new R(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + days, 14, 20);
    window.Date = class extends R { constructor(...a) { a.length ? super(...a) : super(fake0 + R.now() - real0); } static now() { return fake0 + R.now() - real0; } }; }
  const moveMs = v => { const d = new Date(v); return +new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()); };
  const moveIso = v => { const [y, m, d] = v.slice(0, 10).split('-').map(Number), x = new Date(Date.UTC(y, m - 1, d + days)); return x.toISOString().slice(0, 10) + v.slice(10); };
  const move = o => {
    if (Array.isArray(o)) return o.map(move);
    if (o && typeof o === 'object') { const r = {}; for (const [k, v] of Object.entries(o)) r[k] = move(v); return r; }
    if (typeof o === 'number' && o > 1.6e12 && o < 2.2e12) return moveMs(o);
    if (typeof o === 'string' && /^\d{4}-\d\d-\d\d(T[\d:.]+Z?)?$/.test(o)) return o.length === 10 ? moveIso(o) : new Date(moveMs(Date.parse(o))).toISOString();
    return o;
  };
  const ready = fetch(base + 'data.json').then(r => r.json()).then(j => { db = move(j.data); });

  // ---------- a few changes the demo keeps ----------
  let nextId = 100000;
  const D = k => db[k], plan = () => db['/api/plan'], tasks = () => db['/api/tasks'];
  const gone = new Map();   // blocks of a task ticked off, back on undo
  const taskOf = id => tasks().find(t => t.id === +id);
  function write(method, p, body = {}) {
    let m;
    if (p === '/api/settings' && method === 'PUT') { D('/api/bootstrap').settings = { ...D('/api/bootstrap').settings, ...body }; return D('/api/bootstrap').settings; }
    if (p === '/api/me' && method === 'PATCH') return Object.assign(D('/api/bootstrap').me, body);
    if (p === '/api/tasks' && method === 'POST') { const t = { id: ++nextId, status: 'todo', col: 0, priority: 2, duration: 30, points: [], meta: {}, auto: true, notes: '', recur: null, created_at: Date.now(), updated_at: Date.now(), ...body }; tasks().push(t); return t; }
    if ((m = p.match(/^\/api\/tasks\/(\d+)$/))) {
      const t = taskOf(m[1]); if (!t) return {};
      if (method === 'DELETE') { db['/api/tasks'] = tasks().filter(x => x !== t); drop(t.id); return { ok: true }; }
      Object.assign(t, body); for (const u of Object.values(plan().units)) if (u.taskId === t.id) Object.assign(u, ['title', 'points', 'notes', 'priority'].reduce((a, k) => (k in body ? { ...a, [k]: body[k] } : a), {}));
      return t;
    }
    if ((m = p.match(/^\/api\/tasks\/(\d+)\/done$/))) {
      const t = taskOf(m[1]); if (!t) return {};
      if (body.done === false) {   // undo: back where it was
        t.status = 'todo'; const g = gone.get(t.id) || {}; plan().blocks.push(...(g.blocks || [])); plan().nextKeys.unshift(...(g.keys || [])); gone.delete(t.id);
        plan().done = plan().done.filter(x => x.id !== t.id);
      } else {
        if (plan().active?.task_id === t.id) stop(true);   // done while it runs: the session ends with it
        t.status = 'done'; t.done_at = Date.now(); drop(t.id);
        plan().done.push({ id: t.id, title: t.title, at: Date.now(), color: projOf(t).color });
      }
      return t;
    }
    if (p === '/api/timer/start') { stop(false); const t = taskOf(body.task); if (t) { plan().active = { task_id: t.id, period: body.period || 0, since: Date.now(), title: t.title, mode: body.mode || null, note: body.note || null }; if (t.status === 'todo') t.status = 'doing'; } return { ok: true }; }
    if (p === '/api/timer/stop') return { minutes: stop(false) };
    if (p === '/api/timer/more') { for (const u of unitsOf(+body.task)) u.duration = (u.duration || 0) + (+body.minutes || 30); const t = taskOf(body.task); if (t) t.duration = (t.duration || 0) + (+body.minutes || 30); return { ok: true }; }
    if (p === '/api/projects' && method === 'POST') { const x = { id: ++nextId, color: '#1971c2', kind: 'board', columns: ['To do', 'In progress', 'Done'], meta: {}, archived: false, members: [{ id: D('/api/bootstrap').me.id, name: D('/api/bootstrap').me.name, role: 'owner' }], owner_id: D('/api/bootstrap').me.id, ...body }; D('/api/projects').push(x); return x; }
    if (p === '/api/me/claude' && method === 'PUT') { D(p).on = !!body.on; if (!body.on) D(p).connections = []; return { on: D(p).on }; }
    if (/^\/api\/me\/claude\/\d+$/.test(p) && method === 'DELETE') { D('/api/me/claude').connections = []; return { ok: true }; }
    if (/^\/api\/projects\/\d+\/order$/.test(p) && method === 'PUT') { db[p] = { phases: body.phases }; return db[p]; }
    if ((m = p.match(/^\/api\/projects\/(\d+)$/)) && method === 'PATCH') { const x = D('/api/projects').find(y => y.id === +m[1]); return x ? Object.assign(x, body) : {}; }
    if (p === '/api/clashes' && method === 'POST') {   // your choice wins over the automatic one; dismissed ones go
      const c = D('/api/clashes'), x = c.items.find(i => i.key === body.key);
      if (x && (body.dismiss || body.same)) c.items = c.items.filter(i => i !== x); else if (x && body.choice) Object.assign(x, { choice: body.choice, by_me: body.choice === 'auto' ? 0 : 1 });
      return c;
    }
    // ----- the rest: shown on screen as the app would -----
    const H = 3600e3, cal = id => D('/api/accounts').flatMap(x => x.calendars || []).find(c => c.id === +id) || {};
    const evOf = id => plan().events.find(e => e.id === +id);
    if ((m = p.match(/^\/api\/tasks\/(\d+)\/(postpone|skip)$/))) {   // later: off today, back at the chosen time
      const t = taskOf(m[1]); if (!t) return { ok: true };
      if (plan().active?.task_id === t.id) stop(false);
      const bs = plan().blocks.filter(b => plan().units[b.key]?.taskId === t.id); drop(t.id); gone.delete(t.id);
      if (m[2] === 'postpone' && bs.length) { const at = Math.max(+body.until || Date.now() + 864e5, Date.now()), d = bs[0].e - bs[0].s; plan().blocks.push({ ...bs[0], s: at, e: at + d, pinned: false }); }
      return { ok: true };
    }
    if ((m = p.match(/^\/api\/tasks\/(\d+)\/pin$/))) {   // moved in the calendar
      const b = plan().blocks.find(x => plan().units[x.key]?.taskId === +m[1] && (body.oldStart == null || x.s === +body.oldStart));
      if (b) { if (body.s == null) b.pinned = false; else Object.assign(b, { s: +body.s, e: +body.e, pinned: true }); replan(); }
      return { ok: true };
    }
    if ((m = p.match(/^\/api\/tasks\/(\d+)\/auto$/))) { plan().blocks.filter(x => plan().units[x.key]?.taskId === +m[1]).forEach(b => { b.pinned = false; }); return { ok: true }; }
    if ((m = p.match(/^\/api\/tasks\/(\d+)\/next$/))) { const k = plan().nextKeys.find(x => plan().nextUnits[x]?.taskId === +m[1]); if (k) plan().nextKeys = [k, ...plan().nextKeys.filter(x => x !== k)]; return { ok: true }; }
    if (p === '/api/events' && method === 'POST') {
      const c = cal(body.calendar_id), e = { id: ++nextId, title: body.title, start: +body.start, end: +body.end, all_day: !!body.all_day, location: body.location || null, cal: c.name, color: c.color, calendar_id: c.id, blocks: true, before: 10, after: 10, editable: true, alsoIn: [] };
      plan().events.push(e); replan(); return e;
    }
    if ((m = p.match(/^\/api\/events\/(\d+)$/))) {
      const e = evOf(m[1]); if (!e) return { ok: true };
      if (method === 'DELETE') { plan().events = plan().events.filter(x => x !== e); return { ok: true }; }
      Object.assign(e, ['title', 'start', 'end', 'location', 'all_day'].reduce((a, k) => (k in body ? { ...a, [k]: body[k] } : a), {})); replan(); return e;
    }
    if ((m = p.match(/^\/api\/events\/(\d+)\/done$/))) { const e = evOf(m[1]); if (e) { e.done = true; if (body.end) e.end = +body.end; } return { ok: true }; }
    if (p === '/api/appts' && method === 'POST') { const id = ++nextId; plan().busy.push({ kind: 'appt', s: +body.start, e: +body.end, t: body.title || 'Blocked', id }); replan(); return { id }; }
    if ((m = p.match(/^\/api\/appts\/(\d+)$/))) { plan().busy = plan().busy.filter(b => b.id !== +m[1]); return { ok: true }; }
    if (p === '/api/now/break' || p === '/api/now/interrupt') { stop(false); const n = Date.now(); plan().busy.push({ kind: 'appt', s: n, e: n + (+body.minutes || 15) * 60000, t: body.title || 'Break', id: ++nextId }); replan(); return { ok: true }; }
    if (p === '/api/flexible') { const t = { id: ++nextId, title: body.title, status: 'todo', duration: +body.minutes || 30, meta: { win: body.win }, points: [], project_id: (D('/api/projects')[0] || {}).id, created_at: Date.now(), updated_at: Date.now() }; tasks().push(t); return { id: t.id }; }
    if ((m = p.match(/^\/api\/calendars\/(\d+)$/))) { const c = cal(m[1]); Object.assign(c, body); return c; }
    if ((m = p.match(/^\/api\/accounts\/(\d+)$/)) && method === 'PATCH') { const a = D('/api/accounts').find(x => x.id === +m[1]) || {}; a.cfg = { ...(a.cfg || {}), ...body }; return a; }
    if (p === '/api/me/tokens') return { token: 'sc_demo_' + Math.random().toString(36).slice(2, 14) };
    if (p === '/api/invites') { const code = Math.random().toString(36).slice(2, 8).toUpperCase(); return { code, url: location.origin + location.pathname + '#/join/' + code, expires: Date.now() + 14 * 864e5 }; }
    return { ok: true, id: ++nextId, ...body };
  }
  // a task leaves the plan (done): its blocks and its place in "next" are kept for undo
  function drop(id) {
    const keep = [], out = []; for (const b of plan().blocks) (plan().units[b.key]?.taskId === id ? out : keep).push(b); plan().blocks = keep;
    const keys = plan().nextKeys.filter(k => plan().nextUnits[k]?.taskId === id); plan().nextKeys = plan().nextKeys.filter(k => !keys.includes(k));
    gone.set(id, { blocks: out, keys });
  }
  const projOf = t => D('/api/projects').find(x => x.id === t.project_id) || {};
  const unitsOf = id => [...Object.values(plan().units || {}), ...Object.values(plan().nextUnits || {})].filter(u => u.taskId === id);
  // the running timer stops: its minutes count for the task and the session stays in the calendar
  function stop(done) {
    const a = plan().active; if (!a) return 0;
    const end = Date.now(), min = Math.round((end - a.since) / 60000), t = taskOf(a.task_id) || {};
    for (const u of unitsOf(a.task_id)) u.spent = (u.spent || 0) + min;
    if (end - a.since >= 60000) plan().log.push({ task_id: a.task_id, start: a.since, end, title: a.title, color: projOf(t).color, p_name: projOf(t).name, kind: a.mode === 'r' ? 'research' : 'work', done: done ? 1 : 0 });
    plan().active = null; return min;
  }
  // a simple re-plan for the demo: planned blocks (not pinned) that an appointment, a break or blocked time now covers
  // move to the next free time after it, and the blocks behind them follow in their order
  function replan() {
    const P = plan(), fixed = [
      ...P.events.filter(e => e.blocks && !e.all_day && !e.hidden).map(e => [e.start - (e.before || 0) * 60000, e.end + (e.after || 0) * 60000]),
      ...P.busy.map(b => [b.s, b.e]),
      ...P.blocks.filter(b => b.pinned).map(b => [b.s, b.e]),
    ].sort((x, y) => x[0] - y[0]);
    let cur = 0;
    for (const b of P.blocks.filter(b => !b.pinned).sort((x, y) => x.s - y.s)) {
      const d = b.e - b.s; let s = Math.max(b.s, new Date(b.s).toDateString() === new Date(cur).toDateString() ? cur : 0);
      for (let moved = true; moved;) { moved = false; for (const [fs, fe] of fixed) if (fs < s + d && fe > s) { s = fe; moved = true; } }
      b.s = s; b.e = s + d; cur = b.e;
    }
  }
  function read(p, q) {
    if (p === '/api/plan') return plan();
    if (p === '/api/activity') return D('/api/activity?project=' + q.get('project')) || [];
    if (p in db) return db[p];
    if (p === '/api/push/count') return { n: 0 };
    if (/^\/api\/(files|places|travel)/.test(p)) return [];
    return {};
  }

  const real = window.fetch.bind(window);
  window.fetch = async (input, opt = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url, location.href), i = u.pathname.indexOf('/api/');
    if (i < 0) return real(input, opt);
    await ready;
    const p = u.pathname.slice(i), method = (opt.method || 'GET').toUpperCase();
    const body = opt.body ? JSON.parse(opt.body) : {};
    const out = method === 'GET' ? read(p, u.searchParams) : write(method, p, body);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // live updates: nobody else is there
  window.EventSource = class { constructor() { setTimeout(() => this.onmessage?.({ data: '{"what":"hello"}' }), 50); } close() {} };
  if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.resolve();
  // downloads and links into the server
  document.addEventListener('click', e => {   // the backup download: the demo's own data
    const a = e.target.closest?.('a[href^="/api/"]'); if (!a) return; e.preventDefault();
    if (/^\/api\/export/.test(a.getAttribute('href'))) { const u = URL.createObjectURL(new Blob([JSON.stringify({ projects: D('/api/projects'), tasks: tasks() }, null, 2)], { type: 'application/json' })); const l = document.createElement('a'); l.href = u; l.download = 'smart-calendar-demo.json'; l.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); }
  }, true);

  const css = document.createElement('style');
  css.textContent = '.demo-pill{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:999;font:600 11px/1 -apple-system,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;padding:6px 10px;border-radius:99px;background:rgba(0,0,0,.55);color:#fff;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);pointer-events:none}'
    + '@media (max-width:860px){.demo-pill{bottom:auto;top:calc(env(safe-area-inset-top) + 8px)}}';
  document.head.append(css);
  addEventListener('DOMContentLoaded', () => { const d = document.createElement('div'); d.className = 'demo-pill'; d.textContent = 'Demo'; document.body.append(d); });
})();
