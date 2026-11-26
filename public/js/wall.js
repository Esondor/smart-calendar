// Wall display for household chores (kiosk / Home Assistant iframe). Auth: display key from the URL (#key=…).
// Left: clock and the task in focus with big buttons (Start with timer, Done, Later). Right: every chore, grouped by place.
// Tapping a chore puts it into focus; after a few idle minutes the focus goes back to what is planned now.
import { h, render } from '/vendor/preact.mjs';
import { useState, useEffect, useRef } from '/vendor/hooks.mjs';
import htm from '/vendor/htm.mjs';
import { I } from './icons.js';
import { applyBackground } from './backgrounds.js';
const html = htm.bind(h);

const m = location.hash.match(/key=([\w-]+)/);
if (m) { try { localStorage.setItem('wall-key', m[1]); } catch {} history.replaceState(null, '', location.pathname); }
let KEY = ''; try { KEY = m?.[1] || localStorage.getItem('wall-key') || ''; } catch { KEY = m?.[1] || ''; }
document.documentElement.dataset.theme = 'dark';

const call = async (path, body) => {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + KEY, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error || r.status), { status: r.status });
  return r.json();
};
const pad = n => String(n).padStart(2, '0'), hm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const ini = n => String(n).split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();
const dur = m => m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) : ''}` : `${m} min`;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const day0 = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return +d; };
const when = ms => { if (!ms) return ''; const d = Math.round((day0(ms) - day0(Date.now())) / 864e5); return d <= 0 ? hm(ms) : d === 1 ? 'Tomorrow' : DAYS[new Date(ms).getDay()].slice(0, 3); };
const clockTxt = s => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
const low = s => String(s || '').trim().toLowerCase();

function useTick(ms) { const [, t] = useState(0); useEffect(() => { const i = setInterval(() => t(x => x + 1), ms); return () => clearInterval(i); }, [ms]); }
function Clock() {
  useTick(10000); const d = new Date();
  return html`<div><div class="w-clock">${hm(d)}</div><div class="w-date">${DAYS[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()]}</div></div>`;
}
function Timer({ since, planned }) {
  useTick(1000); const s = (Date.now() - since) / 1000;
  return html`<div class="w-timer"><span>${clockTxt(s)}</span><div class="bar"><i style=${{ width: Math.min(100, 100 * s / 60 / Math.max(1, planned)) + '%' }}></i></div><em>of ${dur(planned)}</em></div>`;
}

// add a chore: title, place, duration, person
function AddSheet({ w, uid, done }) {
  const [f, setF] = useState({ title: '', location: w.places[0] || '', duration: 15, assignee: uid }), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const set = x => setF({ ...f, ...x });
  const save = async () => { if (!f.title.trim()) return; setBusy(true); try { await call(`/api/wall/${uid}/tasks`, f); done(true); } catch (e) { setErr(e.message); setBusy(false); } };
  return html`<div class="w-sheetbg" onClick=${e => { if (e.target === e.currentTarget) done(false); }}><div class="w-sheet">
    <div class="w-sheet-h"><b>New Chore</b><button class="w-x" aria-label="Close" onClick=${() => done(false)}>${I('x', 22)}</button></div>
    <input class="w-in" placeholder="What needs doing?" value=${f.title} onInput=${e => set({ title: e.target.value })} onKeyDown=${e => e.key === 'Enter' && save()}/>
    <div class="w-lab">Place</div><div class="w-seg">${w.places.map(p => html`<button class=${f.location === p ? 'on' : ''} onClick=${() => set({ location: p })}>${p}</button>`)}</div>
    <div class="w-lab">Duration</div><div class="w-seg">${[5, 10, 15, 30, 60].map(m => html`<button class=${f.duration === m ? 'on' : ''} onClick=${() => set({ duration: m })}>${dur(m)}</button>`)}</div>
    ${w.users.length > 1 && html`<div class="w-lab">For</div><div class="w-seg">${w.users.map(u => html`<button class=${f.assignee === u.id ? 'on' : ''} onClick=${() => set({ assignee: u.id })}><span class="avatar" style=${{ background: u.color }}>${ini(u.name)}</span>${u.name}</button>`)}</div>`}
    ${err && html`<div class="w-err">${err}</div>`}
    <button class="w-add" disabled=${busy || !f.title.trim()} onClick=${save}>Add</button>
  </div></div>`;
}

function App() {
  const [w, setW] = useState(null), [err, setErr] = useState(''), [uid, setUid] = useState(() => { try { return +localStorage.getItem('wall-user') || null; } catch { return null; } });
  const [d, setD] = useState(null), [off, setOff] = useState(false), [pick, setPick] = useState(null), [adding, setAdding] = useState(false), idle = useRef(null);
  const load = async (reload) => {
    try {
      let ww = w; if (!ww || reload) { ww = await call('/api/wall'); applyBackground(ww.bg); setW(ww); }
      const u = ww.users.find(x => x.id === uid) ? uid : ww.users[0]?.id; if (u !== uid) setUid(u);
      if (u) setD(await call('/api/wall/' + u)); setOff(false);
    } catch (e) { if (e.status === 401 || e.status === 403) setErr('This display is not authorized.'); else setOff(true); }
  };
  useEffect(() => { if (KEY) load(); const i = setInterval(() => load(true), 60000); return () => clearInterval(i); }, [uid]);
  useEffect(() => { try { if (uid) localStorage.setItem('wall-user', uid); } catch {} }, [uid]);
  const choose = x => { setPick(x ? x.taskId : null); clearTimeout(idle.current); if (x) idle.current = setTimeout(() => setPick(null), 3 * 60000); };
  const act = async (what, item) => { try { await call(`/api/wall/${uid}/${what}`, { task: item.taskId ?? item.id, period: item.period || 0 }); if (what === 'done' || what === 'later') choose(null); await load(); } catch { setOff(true); } };

  if (!KEY || err) return html`<div class="w"><div class="w-empty">${I('shield', 44)}<div>${err || 'No display key.'}</div></div></div>`;
  if (!w || !d) return html`<div class="w"></div>`;
  const now = Date.now(), all = d.chores || [];
  const running = d.active && all.find(x => x.taskId === d.active.task_id);
  const planned = d.today.find(x => x.start && x.start <= now + 5 * 60000) || d.today[0] || all[0];
  const cur = (pick && all.find(x => x.taskId === pick)) || running || planned;
  const isRun = cur && d.active && d.active.task_id === cur.taskId;
  // places in the household's order, then anything else, then chores without a place
  const order = [...w.places, ...new Set(all.map(x => x.location).filter(l => l && !w.places.some(p => low(p) === low(l))))];
  const groups = order.map(p => ({ p, items: all.filter(x => low(x.location) === low(p)) })).filter(g => g.items.length);
  const none = all.filter(x => !x.location || !order.some(p => low(p) === low(x.location)));
  if (none.length) groups.push({ p: 'Other', items: none });
  const label = !cur ? '' : isRun ? 'In progress' : pick ? 'Selected' : cur.start && cur.start <= now ? 'Now' : cur.start ? `Next · ${when(cur.start)}` : 'Open';
  const Row = ({ x }) => html`<div class=${'w-row' + (x.late || x.overdue ? ' late' : '') + (cur && x.taskId === cur.taskId ? ' sel' : '') + (d.active?.task_id === x.taskId ? ' run' : '')} onClick=${e => { if (!e.target.closest('.chk')) choose(x); }}>
    <button class="chk" aria-label="Done" onClick=${() => act('done', x)}></button>
    <div class="tt"><b>${x.title}</b><span>${dur(x.duration)}${x.recur ? ' · repeats' : ''}</span></div>
    <span class="tm">${d.active?.task_id === x.taskId ? I('play', 18) : when(x.start)}</span></div>`;

  return html`<div class="w">
    <div class="w-top"><${Clock}/>
      <button class="w-plus" aria-label="New chore" onClick=${() => setAdding(true)}>${I('plus', 30, { w: 2.2 })}</button>
      <div class="w-people">${w.users.map(u => html`<button class=${u.id === uid ? 'on' : ''} onClick=${() => { if (u.id !== uid) { setUid(u.id); setD(null); choose(null); } }}><span class="avatar" style=${{ background: u.color }}>${ini(u.name)}</span>${u.name}</button>`)}</div></div>
    <div class="w-main">
      <div class="w-col">
        ${cur ? html`<div class=${'w-hero' + (isRun ? ' live' : '')}>
            <div class="lab">${label}${cur.location ? ' · ' + cur.location : ''}</div>
            <div class="t">${cur.title}</div>
            ${isRun ? html`<${Timer} since=${d.active.since} planned=${cur.duration}/>` : html`<div class="m">${dur(cur.duration)}${cur.overdue || cur.late ? ' · overdue' : ''}${cur.project ? ' · ' + cur.project : ''}</div>`}
            <div class="acts">
              ${isRun ? html`<button onClick=${() => act('stop', cur)}>${I('pause', 26, { w: 2.4 })}Pause</button>` : html`<button class="go" onClick=${() => act('start', cur)}>${I('play', 26, { w: 2 })}Start</button>`}
              <button class="ok" onClick=${() => act('done', cur)}>${I('check', 26, { w: 2.6 })}Done</button>
              <button onClick=${() => act('later', cur)}>${I('forward', 24)}Later</button>
            </div>
            ${w.users.length > 1 && html`<div class="w-for">${w.users.map(u => html`<button class=${(cur.assignee || uid) === u.id ? 'on' : ''} disabled=${(cur.assignee || uid) === u.id}
              onClick=${async () => { try { await call(`/api/wall/${uid}/assign`, { task: cur.taskId, user: u.id }); choose(null); await load(); } catch { setOff(true); } }}><span class="avatar" style=${{ background: u.color }}>${ini(u.name)}</span>${u.name}</button>`)}</div>`}
            ${pick && !isRun && html`<button class="w-back" onClick=${() => choose(null)}>Back to plan</button>`}
          </div>`
        : html`<div class="w-hero idle"><div class="lab">Now</div><div class="t">All done</div>${d.doneToday.length ? html`<div class="m">${d.doneToday.length} completed today</div>` : ''}</div>`}
        ${d.today.length > 0 && html`<div class="w-sec">${I('calendar', 18)}Today<em>${dur(d.today.reduce((a, x) => a + (x.duration || 0), 0))}</em></div>
          <div class="w-list w-line">${d.today.map(x => html`<div class=${'w-row' + (cur && x.taskId === cur.taskId ? ' sel' : '') + (x.start && x.start <= now && x.end > now ? ' now' : '')} onClick=${() => choose(x)}>
            <span class="tm">${x.start ? hm(x.start) : ''}</span><div class="tt"><b>${x.title}</b><span>${x.location || ''}${x.location ? ' · ' : ''}${dur(x.duration)}</span></div></div>`)}</div>`}
        ${d.waiting.length > 0 && html`<div class="w-sec">${I('clock', 18)}Waiting</div><div class="w-list">${d.waiting.map(x => html`<div class="w-row waiting">
          <button class="chk" disabled></button><div class="tt"><b>${x.title}</b><span>${x.wait_event ? x.wait_event.replace(/_/g, ' ') : ''}${x.wait_until ? ' · ' + hm(x.wait_until) : ''}</span></div>
          <button class="side" onClick=${() => act('ready', x)}>Ready</button></div>`)}</div>`}
        ${d.doneToday.length > 0 && html`<div class="w-done">${d.doneToday.slice(0, 10).map(x => html`<span>${I('check', 16, { w: 2.4 })}${x.title}</span>`)}</div>`}
      </div>
      <div class="w-col w-over">
        ${groups.length ? groups.map(g => html`<div class="w-sec">${I('pin', 18)}${g.p}<em>${g.items.length}</em></div><div class="w-list">${g.items.map(x => html`<${Row} key=${x.taskId} x=${x}/>`)}</div>`)
          : html`<div class="w-empty">${I('check', 56, { w: 2.2 })}<div>Nothing open</div></div>`}
      </div>
    </div>
    ${off && html`<div class="w-off">Offline – retrying</div>`}
    ${adding && html`<${AddSheet} w=${w} uid=${uid} done=${async ok => { setAdding(false); if (ok) await load(); }}/>`}
  </div>`;
}
render(html`<${App}/>`, document.getElementById('app'));
