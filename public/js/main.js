import { html, render, useState, useEffect, useRef, S, useStore, api, post, load, connectStream, toast, Avatar, openModal } from './lib.js';
import NowView, { NowStats } from './now.js';
import CalendarView, { newEvent } from './calendar.js';
import { newFlexible } from './eventsheet.js';
import TasksView from './tasks.js';
import ProjectView, { projectSettings } from './board.js';
import SettingsView from './settings.js';
import SetupView from './setup.js';
import AdminView from './admin.js';
import ProjectsView from './projects.js';
import { Force2fa } from './settings.js';
import { openTask } from './taskedit.js';
import { I } from './icons.js';
import { FilesButton } from './files.js';
import { passkeysSupported, getPasskey } from './passkey.js';

document.documentElement.dataset.theme = 'dark';   // dark only for now (wall display, consistency)
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});

// create an account with an invite (link or code) or the registration password
// + : a task, a fixed appointment (an event in one of your calendars) or a flexible appointment (planned inside its window)
async function newMenu(opts) {
  const google = S.state.accounts.some(a => a.kind === 'google' && a.status === 'ok');
  const v = await openModal(close => html`<div class="modal sm"><h3>New</h3><div class="menu">
    <button onClick=${() => close('task')}>${I('list')}Task</button>
    ${google && html`<button onClick=${() => close('event')}>${I('calendar')}Appointment</button>`}
    <button onClick=${() => close('flex')}>${I('clock')}Flexible Appointment</button></div>
    <div class="acts"><button onClick=${() => close(null)}>Cancel</button></div></div>`);
  if (v === 'task') openTask('new', opts);
  if (v === 'event') newEvent();
  if (v === 'flex') newFlexible();
}

function Register({ back }) {
  const code0 = decodeURIComponent((location.hash.match(/^#\/join\/?([^?]*)/) || [])[1] || '');
  const [f, setF] = useState({ code: code0, name: '', username: '', password: '' }), [inv, setInv] = useState(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { if (code0) api('/api/auth/invite/' + encodeURIComponent(code0), { noAuth: true }).then(setInv).catch(() => {}); }, []);
  const set = p => setF(x => ({ ...x, ...p }));
  const submit = async e => { e.preventDefault(); setErr(''); setBusy(true);
    try { await api('/api/auth/register', { method: 'POST', body: f, noAuth: true }); history.replaceState(null, '', '#/setup'); start(); } catch (x) { setErr(x.message); setBusy(false); } };
  return html`<div class="login"><form onSubmit=${submit}>
    <h1><img src="/icon.svg" alt=""/>Create Account</h1>
    ${inv?.valid && html`<p class="hint" style="text-align:center;margin:0">${inv.by ? `${inv.by} invited you` : 'Invitation'}${inv.project ? ` to “${inv.project}”` : ''}</p>`}
    ${!(inv?.valid) && html`<input placeholder="Invite code or registration password" value=${f.code} onInput=${e => set({ code: e.target.value })} autocomplete="off" autocapitalize="off"/>`}
    <input placeholder="Name" value=${f.name} onInput=${e => set({ name: e.target.value })} autocomplete="name"/>
    <input placeholder="Username" value=${f.username} onInput=${e => set({ username: e.target.value.toLowerCase() })} autocomplete="username" autocapitalize="off"/>
    <input type="password" placeholder="Password" value=${f.password} onInput=${e => set({ password: e.target.value })} autocomplete="new-password"/>
    <button class="pri" type="submit" disabled=${busy || !f.code || !f.username || !f.password}>Create Account</button>
    <button class="ghost" type="button" style="margin:0" onClick=${back}>Sign In</button>
    ${err && html`<div class="err" style="text-align:center;font-size:14px">${err}</div>`}
  </form></div>`;
}

function Login() {
  const [reg, setReg] = useState(() => /^#\/join/.test(location.hash));
  const [setup, setSetup] = useState(null), [f, setF] = useState({ username: '', password: '', code: '', token: '', name: '' }), [needCode, setNeedCode] = useState(false), [err, setErr] = useState('');
  const [pw, setPw] = useState(!passkeysSupported());
  useEffect(() => { api('/api/setup', { noAuth: true }).then(r => setSetup(r.needed)).catch(() => setSetup(false)); }, []);
  const set = p => setF(x => ({ ...x, ...p }));
  const submit = async e => {
    e.preventDefault(); setErr('');
    try {
      if (setup) await api('/api/setup', { method: 'POST', body: { token: f.token, username: f.username, name: f.name, password: f.password }, noAuth: true });
      else { const r = await api('/api/auth/login', { method: 'POST', body: { username: f.username, password: f.password, code: f.code || undefined }, noAuth: true }); if (r.needCode) return setNeedCode(true); }
      start();
    } catch (x) { setErr(x.message); }
  };
  const passkey = async () => {
    setErr('');
    try {
      const opts = await api('/api/auth/passkey/options', { method: 'POST', body: {}, noAuth: true });
      const credential = await getPasskey(opts);
      await api('/api/auth/passkey/verify', { method: 'POST', body: { flow: opts.flow, credential }, noAuth: true });
      start();
    } catch (x) { if (x.name !== 'NotAllowedError' && x.name !== 'AbortError') setErr(x.message); }
  };
  if (setup === null) return html`<div class="boot"></div>`;
  if (reg && !setup) return html`<${Register} back=${() => { setReg(false); history.replaceState(null, '', '#/now'); }}/>`;
  return html`<div class="login"><form onSubmit=${submit}>
    <h1><img src="/icon.svg" alt=""/>Smart Calendar</h1>
    ${setup ? html`
      <input placeholder="Setup token" value=${f.token} onInput=${e => set({ token: e.target.value })} autocomplete="off"/>
      <input placeholder="Name" value=${f.name} onInput=${e => set({ name: e.target.value })}/>` : ''}
    ${!setup && !pw ? html`
      <button class="pri" type="button" onClick=${passkey}>Sign In with Passkey</button>
      <button class="ghost" type="button" style="margin:0" onClick=${() => setPw(true)}>Use Password</button>` : html`
      <input placeholder="Username" value=${f.username} onInput=${e => set({ username: e.target.value })} autocomplete="username webauthn" autocapitalize="off"/>
      <input type="password" placeholder="Password" value=${f.password} onInput=${e => set({ password: e.target.value })} autocomplete=${setup ? 'new-password' : 'current-password'}/>
      ${needCode && html`<input inputmode="numeric" placeholder="Verification code" value=${f.code} onInput=${e => set({ code: e.target.value })} autocomplete="one-time-code"/>`}
      <button class="pri" type="submit">${setup ? 'Create Account' : 'Sign In'}</button>
      ${!setup && passkeysSupported() && html`<button class="ghost" type="button" style="margin:0" onClick=${() => setPw(false)}>Use Passkey</button>`}`}
    ${!setup && html`<button class="ghost" type="button" style="margin:0" onClick=${() => setReg(true)}>Create Account</button>`}
    ${err && html`<div class="err" style="text-align:center;font-size:14px">${err}</div>`}
  </form></div>`;
}

const NAV = [['now', 'now', 'Now'], ['calendar', 'calendar', 'Calendar'], ['tasks', 'list', 'Tasks']];
function Shell() {
  const st = useStore(), r = st.route.replace(/^#\/?/, '').split(/[/?]/);
  const [menu, setMenu] = useState(false), [mini, setMini] = useState(() => { try { return localStorage.getItem('side-mini') === '1'; } catch { return false; } });
  const toggle = () => { if (matchMedia('(max-width:860px)').matches) return setMenu(true); setMini(!mini); try { localStorage.setItem('side-mini', mini ? '0' : '1'); } catch {} };
  const page = r[0] || 'now';
  let view, title;
  if (page === 'calendar') { view = html`<${CalendarView}/>`; title = 'Calendar'; }
  else if (page === 'tasks') { view = html`<${TasksView}/>`; title = 'Tasks'; }
  else if (page === 'project') { const p = st.projects.find(x => x.id === +r[1]); view = html`<${ProjectView} id=${r[1]} key=${r[1]}/>`; title = p ? p.name : 'Project'; }
  else if (page === 'settings') { view = html`<${SettingsView}/>`; title = 'Settings'; }
  else if (page === 'projects') { view = html`<${ProjectsView}/>`; title = 'Projects'; }
  else if (page === 'setup') { view = html`<${SetupView}/>`; title = 'Welcome'; }
  else if (page === 'admin' && st.me.is_admin) { view = html`<${AdminView} key=${st.route}/>`; title = 'Administration'; }
  else { view = html`<${NowView}/>`; title = 'Now'; }
  const open = st.tasks.filter(t => t.status !== 'done' && !['chapter', 'section'].includes(t.meta?.level));
  const late = st.tasks.filter(t => t.sched?.late && t.status !== 'done').length;
  const projects = st.projects.filter(p => !p.archived);
  const errs = st.accounts.filter(a => a.status !== 'ok').length;
  const link = (href, ic, label, on, ct, cls) => html`<a href=${href} class=${on ? 'on' : ''} title=${label} onClick=${() => setMenu(false)}>${I(ic)}<span class="lbl">${label}</span>${ct ? html`<span class=${'ct ' + (cls || '')}>${ct}</span>` : ''}</a>`;
  return html`<div class=${'shell' + (mini ? ' mini' : '')}>
    <nav class=${'side' + (menu ? ' open' : '')}>
      <div class="brand"><img src="/icon.svg" alt=""/><span class="lbl">Smart Calendar</span></div>
      ${NAV.map(([k, ic, l]) => link('#/' + k, ic, l, page === k, k === 'tasks' && late ? late : '', 'late'))}
      <div class="sec"><span class="lbl">Projects</span> <button title="New Project" onClick=${() => projectSettings(null)}>${I('plus', 16)}</button></div>
      ${projects.map(p => html`<a href=${'#/project/' + p.id} class=${page === 'project' && +r[1] === p.id ? 'on' : ''} title=${p.name} onClick=${() => setMenu(false)}><span class="dot" style=${{ background: p.color }}></span><span class="lbl">${p.name}</span>
        <span class="ct">${p.members.length > 1 ? I('people', 14) : ''} ${open.filter(t => t.project_id === p.id).length || ''}</span></a>`)}
      <div class="sidebot">
        ${link('#/settings', 'gear', 'Settings', page === 'settings', errs ? I('warn', 14) : '', 'late')}
        ${st.me.is_admin && link('#/admin', 'shield', 'Administration', page === 'admin')}
      </div>
      <div class="foot"><${Avatar} id=${st.me.id}/><span class="lbl">${st.me.name}</span><span class="grow"></span><span class=${'sync' + (st.sync !== 'live' ? ' bad' : '')} title=${st.sync === 'live' ? 'Connected' : 'Reconnecting'}></span></div>
    </nav>
    ${menu && html`<div style="position:fixed;inset:0;z-index:55" onClick=${() => setMenu(false)}></div>`}
    <div class="main">
      <div class="top"><button class="icon" title="Sidebar" onClick=${toggle}>${I('menu', 20)}</button><h1>${title}</h1>${page === 'now' && html`<${NowStats}/>`}
        <div class="r">${page === 'project' && html`<${FilesButton} project=${st.projects.find(x => x.id === +r[1])}/>`}${!['settings', 'admin', 'setup'].includes(page) && html`<button class="pri newtask" title="New Task (N)" onClick=${() => newMenu(page === 'project' ? { project_id: +r[1] } : {})}>${I('plus', 22, { w: 2 })}<span class="lbl">New</span></button>`}</div></div>
      <${Pull}/>
      <div class=${'content' + (page === 'calendar' ? ' fixed' : '')}>${view}</div>
    </div>
    <div class="tabbar">${NAV.map(([k, ic, l]) => html`<a href=${'#/' + k} class=${page === k ? 'on' : ''}>${I(ic, 22)}${l}</a>`)}
      <a href="#/projects" class=${page === 'project' || page === 'projects' ? 'on' : ''}>${I('folder', 22)}Projects</a>
      <a href="#/settings" class=${page === 'settings' ? 'on' : ''}>${I('gear', 22)}Settings</a></div>
  </div>`;
}

// pull down at the top of a page: sync calendars and reload
function Pull() {
  const ind = useRef();
  useEffect(() => {
    const main = ind.current.parentElement, el = () => main.querySelector('.content'), MAX = 70;
    let y0 = null, d = 0, busy = false;
    const show = v => { const n = ind.current; n.style.top = el().offsetTop + 'px'; n.style.opacity = Math.min(1, v / MAX); n.style.transform = `translate(-50%, ${Math.min(v, MAX) - 34}px)`; n.firstChild.style.transform = busy ? '' : `rotate(${v * 5}deg)`; };
    const scrollerOf = t => t.closest('.calbody, .now>section, .ol>section') || el();
    const start = e => {
      if (busy || e.touches.length !== 1 || e.target.closest('.ev, .modalbg, .side, .tabbar, input, textarea, select')) { y0 = null; return; }
      y0 = scrollerOf(e.target).scrollTop <= 0 ? e.touches[0].clientY : null; d = 0;
    };
    const move = e => { if (y0 == null) return; d = e.touches[0].clientY - y0; if (d <= 0 || scrollerOf(e.target).scrollTop > 0) { if (d < 0) y0 = null; show(0); return; } show(d * .5); };
    const end = async () => {
      if (y0 == null) return; y0 = null;
      if (d * .5 < MAX) return show(0);
      busy = true; ind.current.classList.add('spin'); show(MAX);
      const t0 = Date.now();
      try { await post('/api/sync'); await load(['projects', 'tasks', 'plan', 'accounts']); } catch (x) { toast(x.message); }
      await new Promise(r => setTimeout(r, Math.max(0, 700 - (Date.now() - t0))));   // long enough to see it spin
      busy = false; ind.current.classList.remove('spin'); ind.current.style.transition = 'opacity .2s, transform .2s'; show(0);
      setTimeout(() => { if (!busy) ind.current.style.transition = ''; }, 250);
    };
    main.addEventListener('touchstart', start, { passive: true }); main.addEventListener('touchmove', move, { passive: true });
    main.addEventListener('touchend', end); main.addEventListener('touchcancel', end);
    return () => { main.removeEventListener('touchstart', start); main.removeEventListener('touchmove', move); main.removeEventListener('touchend', end); main.removeEventListener('touchcancel', end); };
  }, []);
  return html`<div class="ptr" ref=${ind} aria-hidden="true"><i></i></div>`;
}

function App() {
  const st = useStore();
  if (st.me === undefined) return html`<div class="boot">Loading…</div>`;
  if (!st.me) return html`<${Login}/>`;
  if (st.must2fa) return html`<${Force2fa}/>`;
  return html`<${Shell}/>`;
}

async function start() {
  try { await load(['boot']); } catch {}
  if (!S.state.me) { S.set({ me: null }); return; }
  if (S.state.must2fa) return;
  await load(['projects', 'tasks', 'plan', 'accounts']);
  connectStream();
  const m = location.hash.match(/^#\/task\/(\d+)/); if (m) { location.hash = '#/tasks'; openTask(+m[1]); }
  // first login: go through the setup assistant
  if (!S.state.settings?.onboarded && !S.state.hasAccounts && !/^#\/setup/.test(location.hash)) location.hash = '#/setup';
  const g = location.hash.match(/google=([^&]+)/);
  if (g) { toast(g[1] === 'ok' ? 'Google Calendar connected' : 'Google: ' + decodeURIComponent(g[1]), 6000); history.replaceState(null, '', '#/setup'); load(['accounts', 'plan']); }
}
const toTop = () => { window.scrollTo(0, 0); document.querySelectorAll('.content, .now>section, .ol>section').forEach(x => x.scrollTo(0, 0)); };
window.addEventListener('hashchange', () => { setTimeout(toTop, 0); const m = location.hash.match(/^#\/task\/(\d+)/); if (m) { location.hash = '#/tasks'; return openTask(+m[1]); } S.set({ route: location.hash }); });
document.addEventListener('keydown', e => {
  if (!S.state.me || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.querySelector('.modalbg')) return;
  if (e.key === 'n' || e.key === 'q') { e.preventDefault(); openTask('new'); }
  if (e.key === '1') location.hash = '#/now'; if (e.key === '2') location.hash = '#/calendar'; if (e.key === '3') location.hash = '#/tasks';
});
// swipe in from the left edge = back (closes an open sheet first). Browsers with their own back gesture keep theirs.
{
  const own = !(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
  let g = null;
  document.addEventListener('touchstart', e => { g = !own && e.touches.length === 1 && e.touches[0].clientX < 22 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, dy: 0 } : null; }, { passive: true });
  document.addEventListener('touchmove', e => { if (!g) return; g.dx = e.touches[0].clientX - g.x; g.dy = e.touches[0].clientY - g.y;
    const c = document.querySelector('.modalbg .modal') || document.querySelector('.content'); if (c && g.dx > 0 && g.dx > Math.abs(g.dy)) { c.style.transition = 'none'; c.style.transform = `translateX(${g.dx * .4}px)`; } }, { passive: true });
  document.addEventListener('touchend', () => { if (!g) return; const x = g; g = null;
    const m = [...document.querySelectorAll('.modalbg')].pop(), c = m?.querySelector('.modal') || document.querySelector('.content');
    if (c) { c.style.transition = 'transform .18s ease-out'; c.style.transform = ''; }
    if (!(x.dx > 70 && x.dx > 2 * Math.abs(x.dy))) return;
    if (m) m.parentElement.dispatchEvent(new Event('sc-close')); else if (history.length > 1) history.back(); });
}
// the server says when the plan changes (live connection); this only catches a connection that went quiet
let lastPoll = Date.now();
setInterval(() => { if (S.state.me && document.visibilityState === 'visible' && (S.state.sync !== 'live' || Date.now() - lastPoll > 10 * 60000)) { lastPoll = Date.now(); load(['plan']); } }, 60000);
render(html`<${App}/>`, document.getElementById('app'));
start();
