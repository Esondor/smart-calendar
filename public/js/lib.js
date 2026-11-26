import { h, render } from '/vendor/preact.mjs';
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from '/vendor/hooks.mjs';
import htm from '/vendor/htm.mjs';
export const html = htm.bind(h);
export { h, render, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback };
import { applyBackground } from './backgrounds.js';

// ---------- API ----------
export async function api(path, opt = {}) {
  const r = await fetch(path, { method: opt.method || (opt.body ? 'POST' : 'GET'), credentials: 'same-origin',
    headers: { 'x-sc': '1', ...(opt.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined });
  if (r.status === 401 && !opt.noAuth) { S.set({ me: null }); throw new Error('Not signed in'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 403 && j.code === 'need2fa') { S.set({ must2fa: j.reason || 'setup' }); throw new Error(j.error); }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
// actions that can be taken back: a toast with Undo after each of them
const UNDO = [
  [/^\/api\/tasks\/(\d+)\/done$/, b => b.done !== false, 'Completed', (id, b) => post(`/api/tasks/${id}/done`, { period: b.period, done: false })],
  [/^\/api\/tasks\/(\d+)\/skip$/, () => true, 'Skipped', (id, b) => post(`/api/tasks/${id}/done`, { period: b.period, done: false })],
  [/^\/api\/tasks\/(\d+)\/postpone$/, () => true, 'Postponed', (id, b) => post(`/api/tasks/${id}/auto`, { period: b.period || 0 })],
  [/^\/api\/tasks\/(\d+)\/pin$/, b => b.s != null && b.oldStart, 'Moved', (id, b) => post(`/api/tasks/${id}/pin`, { period: b.period || 0, oldStart: b.s, s: null })],
];
export const post = async (p, body = {}) => {
  const r = await api(p, { method: 'POST', body });
  for (const [re, when_, msg, undo] of UNDO) { const m = p.match(re); if (m && when_(body)) { toast(msg, 5000, async () => { try { await undo(m[1], body); await load(['tasks', 'plan']); } catch (e) { toast(e.message); } }); break; } }
  return r;
};
export const patch = (p, body = {}) => api(p, { method: 'PATCH', body });
export const del = p => api(p, { method: 'DELETE', body: {} });

// ---------- store ----------
const subs = new Set();
export const S = {
  state: { me: undefined, settings: null, users: [], projects: [], tasks: [], plan: null, accounts: [], sync: '', route: location.hash || '#/now' },
  set(p) { Object.assign(this.state, p); subs.forEach(f => f()); },
};
// subscribed right in the render (layout effect), so a change that lands before the first paint is not missed
export function useStore() { const [, f] = useState(0); useLayoutEffect(() => { const g = () => f(x => x + 1); subs.add(g); return () => subs.delete(g); }, []); return S.state; }

let loading = {};
export async function load(what = ['projects', 'tasks', 'plan']) {
  const jobs = [];
  const once = (k, fn) => { if (loading[k]) return loading[k]; loading[k] = fn().finally(() => { loading[k] = null; }); jobs.push(loading[k]); };
  if (what.includes('boot')) once('boot', async () => { const b = await api('/api/bootstrap'); applyBackground(b.settings?.view?.bg); S.set({ me: b.me, settings: b.settings, users: b.users, google: b.google, vapid: b.vapid, baseUrl: b.baseUrl, hasAccounts: b.hasAccounts, must2fa: b.must2fa, mail: !!b.mail, maps: !!b.maps }); });
  if (what.includes('projects')) once('projects', async () => S.set({ projects: await api('/api/projects') }));
  if (what.includes('tasks')) once('tasks', async () => S.set({ tasks: await api('/api/tasks') }));
  if (what.includes('plan')) once('plan', async () => { const now = Date.now(), from = startOfDay(now) - 864e5; S.set({ plan: await api(`/api/plan?from=${from}&to=${from + 16 * 864e5}`) }); });
  if (what.includes('accounts')) once('accounts', async () => S.set({ accounts: await api('/api/accounts') }));
  await Promise.all(jobs).catch(e => { if (S.state.me !== null) toast(e.message); });   // no toast on the sign-in screen
}
// live updates from the server (other devices, partner, calendar sync)
let es = null, debounce = null;
export function connectStream() {
  if (es) es.close();
  es = new EventSource('/api/stream');
  es.onmessage = e => {
    const { what } = JSON.parse(e.data);
    if (what === 'hello') return S.set({ sync: 'live' });
    clearTimeout(debounce);
    debounce = setTimeout(() => load(what === 'sync' ? ['plan', 'tasks', 'accounts', 'projects'] : what === 'timer' || what === 'plan' ? ['plan'] : ['plan', 'tasks', 'projects']), 250);
  };
  es.onerror = () => S.set({ sync: 'offline – reconnecting' });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.state.me) load(['plan', 'tasks']); });

// ---------- time + format ----------
export const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return +d; };
export const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return +d; };
export const pad = n => String(n).padStart(2, '0');
export const isoDate = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const fromIso = s => +new Date(s + 'T00:00:00');
export const hm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const minsOf = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
export const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const SH = ms => { const d = new Date(ms); return `${d.getDate()} ${MN[d.getMonth()]}`; };
export const dayLabel = ms => { const t = startOfDay(Date.now()), d = startOfDay(ms); return d === t ? 'today' : d === addDays(t, 1) ? 'tomorrow' : d === addDays(t, -1) ? 'yesterday' : `${DN[new Date(ms).getDay()]} ${SH(ms)}`; };
export const when = ms => ms ? `${dayLabel(ms)} ${hm(ms)}` : '';
export const dh = m => { m = Math.round(m); return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) : ''}` : `${m} min`; };
export const clock = m => `${pad(Math.floor(m / 60))}:${pad(Math.floor(m % 60))}`;
export const n24 = v => { v = String(v || '').trim().replace(/[.h]/, ':'); let h, m;
  if (/^\d{1,2}$/.test(v)) { h = +v; m = 0; } else if (/^\d{3,4}$/.test(v)) { h = +v.slice(0, -2); m = +v.slice(-2); } else { const x = v.match(/^(\d{1,2}):(\d{1,2})$/); if (!x) return null; h = +x[1]; m = +x[2]; }
  return h <= 24 && m < 60 && !(h === 24 && m) ? `${pad(h)}:${pad(m)}` : null; };
export const PRI = ['ASAP', 'High', 'Medium', 'Low'];
// the place without web addresses (a meeting link is shown as the Join button instead)
export const placeText = l => String(l || '').replace(/https?:\/\/\S+/g, '').replace(/^[\s,;·-]+|[\s,;·-]+$/g, '').trim();
export const initials = n => String(n || '?').split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();
export const userById = id => S.state.users.find(u => u.id === id);
export const projectById = id => S.state.projects.find(p => p.id === id);
export const Avatar = ({ id, size }) => { const u = userById(id); return u ? html`<span class="avatar" title=${u.name} style=${{ background: u.color, ...(size ? { width: size, height: size } : {}) }}>${initials(u.name)}</span>` : null; };
export const recurText = r => !r ? '' : `${r.every > 1 ? `every ${r.every} ` : 'every '}${{ day: r.every > 1 ? 'days' : 'day', week: r.every > 1 ? 'weeks' : 'week', month: r.every > 1 ? 'months' : 'month' }[r.freq]}${r.days?.length ? ' · ' + r.days.map(d => DN[d]).join('/') : ''}${r.window && r.window !== 'any' ? ' · ' + r.window : ''}`;

// ---------- toast + dialogs ----------
export function toast(msg, ms = 3500, undo) {
  if (!undo && document.querySelector('.toast.undo') && /^(Completed|Postponed|Skipped|Moved)$/.test(msg)) return;   // the Undo toast already says it
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const d = document.createElement('div'); d.className = 'toast' + (undo ? ' undo' : '');
  const t = document.createElement('span'); t.textContent = msg; d.appendChild(t);
  if (undo) { const b = document.createElement('button'); b.textContent = 'Undo'; b.onclick = () => { d.remove(); undo(); }; d.appendChild(b); }
  document.body.appendChild(d); setTimeout(() => d.remove(), ms);
}
let modalHost = null;
export function openModal(render_) {   // render_(close) → vnode
  return new Promise(res => {
    const host = document.createElement('div'); document.body.appendChild(host);
    let done = false;
    const close = v => { if (done) return; done = true; obs.disconnect(); render(null, host); host.remove(); res(v); };
    host.addEventListener('sc-close', () => close(null));
    // close button (x) in the top corner of every sheet
    const addX = () => { const m = host.querySelector('.modal'); if (!m || m.querySelector(':scope > .mclose')) return;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'mclose icon'; b.title = 'Close'; b.setAttribute('aria-label', 'Close');
      b.innerHTML = '<svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      b.onclick = () => close(null); m.appendChild(b); };
    const obs = new MutationObserver(addX); obs.observe(host, { childList: true, subtree: true });
    // pull the sheet down by its title to close it
    let pull = null;
    host.addEventListener('touchstart', e => { const m = host.querySelector('.modal'); if (!m || e.touches.length !== 1 || e.target.closest('select, textarea, button, .seg')) return;
      const r = m.getBoundingClientRect(); pull = e.touches[0].clientY - r.top < 64 && m.scrollTop <= 0 ? { y: e.touches[0].clientY, m, d: 0 } : null; if (pull) m.style.transition = 'none'; }, { passive: true });
    host.addEventListener('touchmove', e => { if (!pull) return; pull.d = Math.max(0, e.touches[0].clientY - pull.y); pull.m.style.transform = `translateY(${pull.d}px)`; }, { passive: true });
    host.addEventListener('touchend', () => { if (!pull) return; const p = pull; pull = null; p.m.style.transition = 'transform .2s ease-out';
      if (p.d > 90) { p.m.style.transform = 'translateY(100%)'; setTimeout(() => close(null), 160); } else p.m.style.transform = ''; });
    const Wrap = () => html`<div class="modalbg" onMouseDown=${e => { if (e.target === e.currentTarget) close(null); }} onKeyDown=${e => { if (e.key === 'Escape') close(null); }}>${render_(close)}</div>`;
    render(html`<${Wrap} />`, host); addX();
    setTimeout(() => host.querySelector('input:not([type=checkbox]),select,textarea')?.focus(), 30);
  });
}
// small dialog with minutes quick-picks
export function askMinutes(title, vals, def, textHint) {
  return openModal(close => {
    const Body = () => {
      const [m, setM] = useState(def), [t, setT] = useState('');
      const ok = () => close({ m: +m, t: t.trim() });
      return html`<div class="modal sm" onKeyDown=${e => e.key === 'Enter' && ok()}><h3>${title}</h3>
        <div class="seg">${vals.map(v => html`<button type="button" class=${+m === v ? 'on' : ''} onClick=${() => setM(v)}>${v} min</button>`)}</div>
        ${textHint && html`<input type="text" style="width:100%;margin-top:10px" placeholder=${textHint} value=${t} onInput=${e => setT(e.target.value)}/>`}
        <div class="acts"><button onClick=${() => close(null)}>Cancel</button><button class="pri" onClick=${ok}>OK</button></div></div>`;
    };
    return html`<${Body}/>`;
  });
}
export function confirmDialog(text, okLabel = 'OK', danger = false) {
  return openModal(close => html`<div class="modal sm"><p style="margin:0 0 6px">${text}</p><div class="acts"><button onClick=${() => close(false)}>Cancel</button><button class=${danger ? 'danger' : 'pri'} onClick=${() => close(true)}>${okLabel}</button></div></div>`);
}
export const go = hash => { location.hash = hash; };

// copy to clipboard (field fallback for older browsers / plain http)
export async function copyText(text, el) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { if (el) { el.focus(); el.select(); try { document.execCommand('copy'); toast('Copied'); } catch { toast('Select and copy'); } } }
}
// a value to copy, as one row of a box: label · value (monospace, cut off) · copy button
const COPY = html`<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 9.5A1.5 1.5 0 0 1 10.5 8h8A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5v-9Z M15 8V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H9"/></svg>`;
export function CopyRow({ label, value }) {
  const ref = useRef();
  return html`<div class="cell copyrow"><span>${label}</span><input ref=${ref} class="cv" readonly value=${value} onFocus=${e => e.target.select()}/>
    <button class="icon" title="Copy" aria-label=${'Copy ' + label} onClick=${() => copyText(value, ref.current)}>${COPY}</button></div>`;
}
// invite a new person (optionally straight into a project): one-time link or code, 14 days. Renders rows for a .box
export function InviteBox({ project }) {
  const [inv, setInv] = useState(null), [busy, setBusy] = useState(false);
  const make = async () => { setBusy(true); try { setInv(await post('/api/invites', { project_id: project?.id || null })); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  if (!inv) return html`<div class="cell"><span>Invite Link</span><button class="ghost" disabled=${busy} onClick=${make}>Create</button></div>`;
  return html`<${CopyRow} label="Link" value=${inv.url}/><${CopyRow} label="Code" value=${inv.code}/>
    <div class="cell"><span class="hint">Once · 14 days</span>
      ${navigator.share && html`<button class="ghost" onClick=${() => navigator.share({ title: 'Smart Calendar', text: `Join me${project ? ' in “' + project.name + '”' : ''} on Smart Calendar`, url: inv.url }).catch(() => {})}>Share</button>`}
      <button class="ghost" disabled=${busy} onClick=${make}>New</button></div>`;
}
