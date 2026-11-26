// Demo: answers the app's /api requests in the browser from data.json (recorded by scripts/demo.mjs), moved to
// today. What a visitor changes (tick off, edit, add, start a timer, settings) is kept until the page reloads.
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
      if (body.done === false) { t.status = 'todo'; plan().blocks.push(...(gone.get(t.id) || [])); gone.delete(t.id); plan().done = plan().done.filter(x => x.id !== t.id); }
      else { t.status = 'done'; t.done_at = Date.now(); drop(t.id); plan().done.push({ id: t.id, title: t.title, at: Date.now(), color: (D('/api/projects').find(x => x.id === t.project_id) || {}).color }); }
      return t;
    }
    if (p === '/api/timer/start') { const t = taskOf(body.task); plan().active = t ? { task_id: t.id, period: body.period || 0, since: Date.now(), title: t.title } : null; return { ok: true }; }
    if (p === '/api/timer/stop') { const a = plan().active; plan().active = null; return { minutes: a ? Math.round((Date.now() - a.since) / 60000) : 0 }; }
    if (p === '/api/projects' && method === 'POST') { const x = { id: ++nextId, color: '#1971c2', kind: 'board', columns: ['To do', 'In progress', 'Done'], meta: {}, archived: false, members: [{ id: D('/api/bootstrap').me.id, name: D('/api/bootstrap').me.name, role: 'owner' }], owner_id: D('/api/bootstrap').me.id, ...body }; D('/api/projects').push(x); return x; }
    if ((m = p.match(/^\/api\/projects\/(\d+)$/)) && method === 'PATCH') { const x = D('/api/projects').find(y => y.id === +m[1]); return x ? Object.assign(x, body) : {}; }
    if (p === '/api/clashes' && method === 'POST') {   // your choice wins over the automatic one; dismissed ones go
      const c = D('/api/clashes'), x = c.items.find(i => i.key === body.key);
      if (x && (body.dismiss || body.same)) c.items = c.items.filter(i => i !== x); else if (x && body.choice) Object.assign(x, { choice: body.choice, by_me: body.choice === 'auto' ? 0 : 1 });
      return c;
    }
    note();
    return { ok: true };
  }
  function drop(id) { const keep = [], out = []; for (const b of plan().blocks) (plan().units[b.key]?.taskId === id ? out : keep).push(b); plan().blocks = keep; if (out.length) gone.set(id, out); }
  function read(p, q) {
    if (p === '/api/plan') return plan();
    if (p === '/api/activity') return D('/api/activity?project=' + q.get('project')) || [];
    if (p in db) return db[p];
    if (p === '/api/push/count') return { n: 0 };
    if (/^\/api\/(files|places|travel)/.test(p)) return [];
    return {};
  }
  let told = false;
  function note() { if (told) return; told = true; const n = document.createElement('div'); n.className = 'demo-note'; n.textContent = 'This is a demo: calendars, servers and other people are not connected.'; document.body.append(n); setTimeout(() => n.remove(), 5000); }

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
  document.addEventListener('click', e => { const a = e.target.closest?.('a[href^="/api/"]'); if (a) { e.preventDefault(); note(); } }, true);

  const css = document.createElement('style');
  css.textContent = '.demo-pill{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:999;font:600 11px/1 -apple-system,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;padding:6px 10px;border-radius:99px;background:rgba(0,0,0,.55);color:#fff;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);pointer-events:none}'
    + '@media (max-width:860px){.demo-pill{bottom:auto;top:calc(env(safe-area-inset-top) + 8px)}}'
    + '.demo-note{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:999;font:13px/1.35 -apple-system,system-ui,sans-serif;padding:9px 14px;border-radius:10px;background:rgba(0,0,0,.75);color:#fff;max-width:90vw;text-align:center}';
  document.head.append(css);
  addEventListener('DOMContentLoaded', () => { const d = document.createElement('div'); d.className = 'demo-pill'; d.textContent = 'Demo'; document.body.append(d); });
})();
