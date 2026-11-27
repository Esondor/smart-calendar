import { html, useState, useEffect, useRef, S, api, post, patch, del, load, toast, confirmDialog, openModal, when, DN, n24, InviteBox } from './lib.js';
import { I } from './icons.js';
import { rankOrder, PlaceInput } from './eventsheet.js';
import { passkeysSupported, createPasskey, getPasskey } from './passkey.js';
import { BACKGROUNDS, applyBackground } from './backgrounds.js';
import { CalendarSelect, setProjectCalendar } from './board.js';

const putSettings = async p => { try { const s = await api('/api/settings', { method: 'PUT', body: { ...S.state.settings, ...p } }); S.set({ settings: s }); load(['plan', 'tasks']); } catch (e) { toast(e.message); } };
const ORDER = [1, 2, 3, 4, 5, 6, 0];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const rangesTxt = v => !v ? '' : (Array.isArray(v[0]) ? v : [v]).map(r => r.join('–')).join(', ');
const parseRanges = s => { const out = []; for (const part of String(s).split(/[,;]/)) { const m = part.trim().split(/\s*[–-]\s*/); if (m.length !== 2) continue; const a = n24(m[0]), b = n24(m[1]); if (a && b && b > a) out.push([a, b]); } return out.length ? out : null; };
const ask = (title, ph, type = 'text') => openModal(close => { const B = () => { const [v, setV] = useState(''); return html`<div class="modal sm"><h3>${title}</h3>
  <input type=${type} style="width:100%" placeholder=${ph} value=${v} onInput=${e => setV(e.target.value)} onKeyDown=${e => e.key === 'Enter' && close(v)}/>
  <div class="acts"><button onClick=${() => close(null)}>Cancel</button><button class="pri" onClick=${() => close(v)}>OK</button></div></div>`; }; return html`<${B}/>`; });
const Sect = ({ t }) => html`<div class="sect">${t}</div>`;

// which events of a calendar block time: title must contain one of "only" words, none of "except" words
// the tag the app writes into shared calendars (#JD-blocked): the first "Only with" word unless set, else your initials
const tagGuess = () => { for (const c of S.state.accounts.flatMap(a => a.calendars || [])) { const w = (c.include_words || '').split(',').map(x => x.trim().replace(/^"|"$/g, '')).find(x => /^[\p{L}\p{N}_-]+$/u.test(x)); if (w) return w; } return initials(S.state.me.name) || (S.state.me.username || '').toUpperCase(); };
const initials = n => { const w = String(n || '').trim().split(/[\s.-]+/).map(x => x.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean); return (w.length > 1 ? w.map(x => x[0]).join('').slice(0, 4) : (w[0] || '').slice(0, 2)).toUpperCase(); };
function Filter({ c, run, open, busy }) {
  const save = (k, v) => { if ((c[k] || '') !== v.trim()) run(() => patch('/api/calendars/' + c.id, { [k]: v })); };
  if (!open) return null;
  const google = S.state.accounts.some(a => a.kind === 'google' && a.status === 'ok'), copy = c.mirror_to && S.state.accounts.flatMap(a => a.calendars).find(x => x.id === c.mirror_to);
  const mirror = on => run(async () => { const r = await post(`/api/calendars/${c.id}/mirror`, { on, name: /group|gruppe|exchange/i.test(c.name) ? 'Group calendar filtered' : `${c.name} filtered` }); if (on) toast(`${r.copied ?? 0} events copied`); });
  return html`${google && (c.include_words || c.exclude_words || c.mirror_to) && html`<label class="cell" style="margin:0 0 4px 30px"><span>Filtered copy${copy ? html` <span class="hint">· ${copy.name}</span>` : ''}</span>
      <input type="checkbox" checked=${!!c.mirror_to} disabled=${busy} onChange=${e => mirror(e.target.checked)}/></label>`}
    <div class="row" style="margin:0 0 6px 30px;gap:6px;flex-wrap:nowrap">
    <input style="flex:1;min-width:0;font-size:14px;padding:5px 9px" placeholder='Mine: JD, "Group"' title='Comma-separated. "Quoted" = exact case' value=${c.include_words || ''} onChange=${e => save('include_words', e.target.value)}/>
    <input style="flex:1;min-width:0;font-size:14px;padding:5px 9px" placeholder="Others: AB, CD, Robin" title='Comma-separated. "Quoted" = exact case' value=${c.exclude_words || ''} onChange=${e => save('exclude_words', e.target.value)}/></div>
    ${c.include_words && html`<label class="cell" style="margin:0 0 6px 30px"><span>Only mine</span><input type="checkbox" checked=${!!c.only_mine} onChange=${e => run(() => patch('/api/calendars/' + c.id, { only_mine: e.target.checked }))}/></label>`}`;
}
// Ranking: drag your blocking calendars and "Tasks" into order. Higher wins: in clashes, when an event is moved to
// a new time, and tasks are only kept out of calendars ranked above "Tasks" (same order as the server, see planner.js)
function Ranking() {
  const st = S.state, s = st.settings, ref = useRef();
  const { order, cal: byKey } = rankOrder();
  if (!byKey.size) return null;
  const [drag, setDrag] = useState(null), list = drag?.list || order;
  const down = k => e => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); setDrag({ key: k, list: order }); };
  const move = e => {
    if (!drag) return;
    const rows = [...ref.current.querySelectorAll('.rk')].filter(r => r.dataset.k !== drag.key);
    const idx = rows.filter(r => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 < e.clientY; }).length;
    const L = drag.list.filter(k => k !== drag.key); L.splice(idx, 0, drag.key);
    if (L.join() !== drag.list.join()) setDrag({ ...drag, list: L });
  };
  const up = () => { if (!drag) return; const L = drag.list; setDrag(null); if (L.join() !== order.join()) putSettings({ plan: { ...s.plan, rank: L } }); };
  return html`<${Sect} t="Ranking"/><div class="box rank" ref=${ref}>
    ${list.map((k, i) => { const c = byKey.get(k);
      return html`<div class=${'cell rk' + (drag?.key === k ? ' drag' : '') + (k === 'tasks' ? ' tasks' : '')} data-k=${k} key=${k}>
        <span class="row" style="gap:10px;min-width:0;flex-wrap:nowrap"><span class="hint" style="width:16px;text-align:right;flex:none">${i + 1}</span>${c ? html`<span class="sw" style=${{ background: c.color }}></span>` : I('list', 15)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c ? c.name : 'Tasks'}</span></span>
        <button class="icon handle" aria-label=${'Move ' + (c ? c.name : 'Tasks')} onPointerDown=${down(k)} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}>${I('menu', 16)}</button></div>`; })}
  </div>`;
}
function Calendars() {
  const st = S.state, s = st.settings, accs = st.accounts;
  const [ics, setIcs] = useState(''), [vk, setVk] = useState({ url: '', token: '', user: '', pass: '', gate: false }), [busy, setBusy] = useState(false), [add, setAdd] = useState('');
  const [openF, setOpenF] = useState(null);
  useEffect(() => { load(['accounts']); }, []);
  const writable = accs.filter(a => a.kind === 'google').flatMap(a => a.calendars.filter(c => c.writable).map(c => ({ ...c, acc: a.label })));
  const run = async (fn, msg) => { setBusy(true); try { await fn(); await load(['accounts', 'plan']); if (msg) toast(msg); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const stat = a => a.status === 'ok' ? html`<span class="hint">${a.last_sync ? when(a.last_sync) : ''}</span>` : html`<span class="chip late" title=${a.error || ''}>${a.status === 'auth' ? 'Sign in again' : 'Error'}</span>`;
  const remove = a => html`<button class="icon" title="Remove" onClick=${async () => { if (await confirmDialog(`Remove ${a.label}?`, 'Remove', true)) run(() => del('/api/accounts/' + a.id)); }}>${I('trash', 16)}</button>`;
  const sync = a => html`<button class="icon" title="Sync now" disabled=${busy} onClick=${() => run(() => post(`/api/accounts/${a.id}/sync`))}>${I('repeat', 16)}</button>`;
  return html`<${Sect} t="Accounts"/><div class="box">
    ${accs.filter(a => a.kind === 'google').map(a => html`<div class="acct"><div class="row"><b class="grow">${a.label}</b>${a.live ? html`<span class="hint">Live</span>` : ''}${stat(a)}
        ${a.status === 'auth' && html`<button class="pri" onClick=${() => { location.href = '/api/google/connect'; }}>Sign In</button>`}${sync(a)}${remove(a)}</div>
      ${a.calendars.map(c => html`<div class="calrow"><input type="checkbox" class="sq" checked=${!!c.use_busy} onChange=${e => run(() => patch('/api/calendars/' + c.id, { use_busy: e.target.checked }))}/><span class="sw" style=${{ background: c.color || '#999' }}></span><span class="grow">${c.name}</span>
          ${c.include_words || c.exclude_words ? html`<span class="hint">Filtered</span>` : ''}${c.is_plan ? html`<span class="hint">Plan</span>` : ''}
          ${c.use_busy && !c.is_plan ? html`<button class="icon" title="Filter" onClick=${() => setOpenF(openF === c.id ? null : c.id)}>${I(openF === c.id ? 'down' : 'right', 15)}</button>` : ''}</div>
        ${c.use_busy && !c.is_plan ? html`<${Filter} c=${c} run=${run} busy=${busy} open=${openF === c.id}/>` : ''}`)}
      ${a.lastPush?.err && html`<div class="hint err">${a.lastPush.err}</div>`}</div>`)}
    ${accs.filter(a => a.kind !== 'google').map(a => html`<div class="acct"><div class="row"><b class="grow">${a.label}</b><span class="hint">${a.kind === 'ics' ? 'Exchange' : 'Vikunja'}${a.live ? ' · Live' : ''}</span>${stat(a)}${sync(a)}${remove(a)}</div>
      ${a.kind === 'ics' && html`<div class="calrow"><input type="checkbox" class="sq" checked=${!!a.calendars[0]?.use_busy} onChange=${e => run(() => patch('/api/calendars/' + a.calendars[0].id, { use_busy: e.target.checked }))}/><span class="grow">Blocks time</span>
          ${a.calendars[0]?.include_words || a.calendars[0]?.exclude_words ? html`<span class="hint">Filtered</span>` : ''}
          ${a.calendars[0]?.use_busy ? html`<button class="icon" title="Filter" onClick=${() => setOpenF(openF === a.calendars[0].id ? null : a.calendars[0].id)}>${I(openF === a.calendars[0].id ? 'down' : 'right', 15)}</button>` : ''}</div>
        ${a.calendars[0]?.use_busy ? html`<${Filter} c=${a.calendars[0]} run=${run} busy=${busy} open=${openF === a.calendars[0].id}/>` : ''}`}
      ${a.kind === 'vikunja' && a.cfg && html`<div class="row" style="margin-top:6px">
        <label class="row" style="gap:8px"><input type="checkbox" class="sq" checked=${a.cfg.onlyAssigned} onChange=${e => run(() => patch('/api/accounts/' + a.id, { cfg: { onlyAssigned: e.target.checked } }))}/>Assigned to</label>
        <input style="width:120px" value=${a.cfg.user || ''} placeholder=${a.me?.username || 'Username'} disabled=${!a.cfg.onlyAssigned} onChange=${e => run(() => patch('/api/accounts/' + a.id, { cfg: { user: e.target.value.trim() } }))}/>
        <span class="grow"></span><select value=${a.cfg.schedule} onChange=${e => run(() => patch('/api/accounts/' + a.id, { cfg: { schedule: e.target.value } }))}>${Object.keys(s.hours).map(n => html`<option value=${n}>${cap(n)}</option>`)}</select></div>
      <div class="row" style="margin-top:6px">
        <label class="row" style="gap:8px"><input type="checkbox" class="sq" checked=${a.cfg.plan !== false} onChange=${e => run(() => patch('/api/accounts/' + a.id, { cfg: { plan: e.target.checked } }))}/>Plan automatically</label>
        <span class="grow"></span><select value=${String(a.cfg.calendarId || '')} onChange=${e => run(() => patch('/api/accounts/' + a.id, { cfg: { calendarId: +e.target.value || null } }))}>
          <option value="">Plan calendar</option>${writable.map(c => html`<option value=${String(c.id)}>${c.name}</option>`)}</select>
        ${(a.vprojects || []).length > 0 && html`<button class="icon" title="Projects" onClick=${() => setOpenF(openF === 'vk' + a.id ? null : 'vk' + a.id)}>${I(openF === 'vk' + a.id ? 'down' : 'right', 15)}</button>`}</div>
      ${openF === 'vk' + a.id && html`<${VkProjects} a=${a}/>`}`}</div>`)}
    ${!accs.length && html`<p class="hint" style="margin:0">No calendars</p>`}
    <div class="row" style="margin-top:12px">
      ${st.google ? html`<button onClick=${() => { location.href = '/api/google/connect'; }}>${I('plus', 15)}Google</button>` : ''}
      <button onClick=${() => setAdd(add === 'ics' ? '' : 'ics')}>${I('plus', 15)}Exchange</button>
      <button onClick=${() => setAdd(add === 'vk' ? '' : 'vk')}>${I('plus', 15)}Vikunja</button></div>
    ${add === 'ics' && html`<div class="row" style="margin-top:10px"><input type="url" class="grow" placeholder="ICS link" value=${ics} onInput=${e => setIcs(e.target.value)}/>
      <button class="pri" disabled=${busy || !ics} onClick=${() => run(async () => { const r = await post('/api/accounts/ics', { label: 'Exchange', url: ics }); if (r.status !== 'ok') throw new Error(r.error); setIcs(''); setAdd(''); })}>Add</button></div>`}
    ${add === 'vk' && html`<div class="row" style="margin-top:10px"><input type="url" placeholder="https://vikunja…" value=${vk.url} class="grow" onInput=${e => setVk({ ...vk, url: e.target.value })}/>
      <input type="password" placeholder="API token" value=${vk.token} style="width:180px" onInput=${e => setVk({ ...vk, token: e.target.value })} autocomplete="off"/>
      <button class="pri" disabled=${busy || !vk.url || !vk.token || (vk.gate && !(vk.user && vk.pass))} onClick=${() => run(async () => {
        try { const r = await post('/api/accounts/vikunja', { label: 'Vikunja', url: vk.url, token: vk.token, ...(vk.gate ? { login: { user: vk.user, pass: vk.pass } } : {}) }); if (r.status !== 'ok') throw new Error(r.error); }
        catch (e) { if (/sign-in/i.test(e.message)) setVk(v => ({ ...v, gate: true })); throw e; }
        setVk({ url: '', token: '', user: '', pass: '', gate: false }); setAdd(''); await load(['projects', 'tasks']); })}>Connect</button></div>
      ${vk.gate && html`<div class="row" style="margin-top:8px"><span class="hint grow">Sign-in page</span>
        <input placeholder="Username" value=${vk.user} style="width:140px" autocomplete="off" onInput=${e => setVk({ ...vk, user: e.target.value })}/>
        <input type="password" placeholder="Password" value=${vk.pass} style="width:140px" autocomplete="new-password" onInput=${e => setVk({ ...vk, pass: e.target.value })}/></div>`}`}
  </div>
  ${writable.length > 0 && html`<${Sect} t="Plan"/><div class="box">
    <div class="cell"><span>Calendar</span><select value=${s.plan.calendarId || ''} onChange=${e => putSettings({ plan: { ...s.plan, calendarId: +e.target.value || null } })}>
      <option value="">None</option>${writable.map(c => html`<option value=${c.id}>${c.name}</option>`)}</select></div>
    ${st.projects.filter(p => !p.archived).map(p => html`<div class="cell"><span class="row" style="gap:8px;min-width:0"><span class="sw" style=${{ background: p.color }}></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.name}</span>${p.meta?.sharedCal ? I('people', 14) : ''}</span>
      <${CalendarSelect} value=${String(s.plan.projectCalendars?.[p.id] || '')} name=${p.name} onChange=${v => run(() => setProjectCalendar(p, v, !!p.meta?.sharedCal && v))}/></div>`)}
    <div class="cell"><span>Buffer around events</span><select value=${s.plan.eventBuffer ?? 15} onChange=${e => putSettings({ plan: { ...s.plan, eventBuffer: +e.target.value } })}>
      ${[0, 5, 10, 15, 20, 30].map(m => html`<option value=${m}>${m ? m + ' min' : 'None'}</option>`)}</select></div>
    ${[['allDay', 'All-day events'], ['multiDay', 'Events over several days']].map(([k, l]) => html`<div class="cell"><span>${l}</span><select value=${s.plan[k] || 'busy'} onChange=${e => putSettings({ plan: { ...s.plan, [k]: e.target.value } })}>
      <option value="busy">Block when busy</option><option value="always">Always block</option><option value="never">Never block</option></select></div>`)}
    <div class="cell"><span>Your tag</span><input style="width:110px" value=${s.plan.tag || ''} placeholder=${tagGuess()} onChange=${e => putSettings({ plan: { ...s.plan, tag: e.target.value.trim() } })}/></div>
    <div class="cell"><span>Days ahead</span><input type="number" min="1" max="60" value=${s.plan.days} style="width:70px" onChange=${e => putSettings({ plan: { ...s.plan, days: +e.target.value } })}/></div>
    <label class="cell"><span>Show as busy</span><input type="checkbox" checked=${!!s.plan.busy} onChange=${e => putSettings({ plan: { ...s.plan, busy: e.target.checked } })}/></label>
    <label class="cell"><span>Log sessions and breaks</span><input type="checkbox" checked=${s.plan.logOn} onChange=${e => putSettings({ plan: { ...s.plan, logOn: e.target.checked } })}/></label>
  </div>`}`;
}

function Hours() {
  const s = S.state.settings, names = Object.keys(s.hours);
  const setDay = (n, d, txt) => { const hours = structuredClone(s.hours); hours[n][d] = txt.trim() ? parseRanges(txt) : null; putSettings({ hours }); };
  return html`<${Sect} t="Hours"/><div class="box">
    <table style="width:100%"><tr><td></td>${names.map(n => html`<td class="hint" style="padding-bottom:6px">${cap(n)}${!['work', 'personal'].includes(n) ? html` <button class="icon" onClick=${() => { const h = { ...s.hours }; delete h[n]; putSettings({ hours: h }); }}>${I('x', 12)}</button>` : ''}</td>`)}</tr>
      ${ORDER.map(d => html`<tr><td style="width:50px">${DN[d]}</td>${names.map(n => html`<td><input type="text" style="width:100%;max-width:200px" value=${rangesTxt(s.hours[n][d])} placeholder="Off" onChange=${e => setDay(n, d, e.target.value)}/></td>`)}</tr>`)}</table>
    <button class="ghost" style="margin-top:8px" onClick=${async () => { const n = await ask('New Hours', 'Name'); if (n && /^[\w -]{1,30}$/.test(n) && !s.hours[n.toLowerCase()]) putSettings({ hours: { ...s.hours, [n.toLowerCase()]: { ...s.hours.personal } } }); }}>${I('plus', 15)}Add Hours</button>
  </div>`;
}

// home: where travel times start (Google Maps) and what place suggestions are near; a picked place keeps its coordinates
function Home() {
  const s = S.state.settings, cur = s.plan.home?.address || '', typed = useRef(null);
  const save = home => putSettings({ plan: { ...S.state.settings.plan, home } });
  const commit = () => { const v = typed.current; typed.current = null; if (v == null || v.trim() === cur) return; save(v.trim() ? { address: v.trim() } : null); };
  return html`<${Sect} t="Travel"/><div class="box">
    <div class="cell" onFocusOut=${commit}><span>Home</span>${S.state.maps
      ? html`<${PlaceInput} value=${cur} placeholder="Address" onChange=${(v, d) => { if (d) { typed.current = null; save({ address: d.address || d.text, lat: d.lat, lng: d.lng }); } else typed.current = v; }}/>`
      : html`<input value=${cur} placeholder="Address" onInput=${e => { typed.current = e.target.value; }}/>`}</div>
    ${S.state.maps && html`<div class="cell"><span>By bike up to</span><select value=${s.plan.bikeMax ?? 25} onChange=${e => putSettings({ plan: { ...S.state.settings.plan, bikeMax: +e.target.value } })}>
      ${[0, 10, 15, 20, 25, 30, 45, 60].map(m => html`<option value=${m}>${m ? m + ' min' : 'Never'}</option>`)}</select></div>`}
  </div>
  <${Places}/>`;
}
// a Vikunja account's projects: Sync and Plan per project. The boxes switch at once; the choice is saved shortly after
// the last click and Vikunja is read again in the background.
function VkProjects({ a }) {
  const [cfg, setCfg] = useState({ skip: a.cfg.skip || [], noPlan: a.cfg.noPlan || [] }), timer = useRef(), cur = useRef(cfg);
  const flip = (k, id, on) => {
    const n = { ...cur.current, [k]: on ? cur.current[k].filter(x => x !== id) : [...cur.current[k].filter(x => x !== id), id] };
    cur.current = n; setCfg(n);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => patch('/api/accounts/' + a.id, { cfg: cur.current }).catch(e => toast(e.message)), 500);
  };
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); patch('/api/accounts/' + a.id, { cfg: cur.current }).catch(() => {}); } }, []);
  const planAll = a.cfg.plan !== false;
  return html`<div class="vkprojs">
    <div class="row hint" style="gap:8px;margin:8px 0 2px"><span class="grow">Project</span><span style="width:44px;text-align:center">Sync</span><span style="width:44px;text-align:center">Plan</span></div>
    ${a.vprojects.map(p => { const skip = cfg.skip.includes(p.id), noPlan = cfg.noPlan.includes(p.id);
      return html`<div class="row" style="gap:8px;padding:3px 0"><span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.title}</span>
        <span style="width:44px;text-align:center"><input type="checkbox" class="sq" checked=${!skip} onChange=${e => flip('skip', p.id, e.target.checked)}/></span>
        <span style="width:44px;text-align:center"><input type="checkbox" class="sq" checked=${!skip && !noPlan && planAll} disabled=${skip || !planAll} onChange=${e => flip('noPlan', p.id, e.target.checked)}/></span></div>`; })}
  </div>`;
}
// place rules: a room code in an event (B03 1-161) stands for where you go (North Campus)
function Places() {
  const P = S.state.settings.plan.places || [];
  const save = list => putSettings({ plan: { ...S.state.settings.plan, places: list } });
  const upd = (i, p) => save(P.map((r, j) => j === i ? { ...r, ...p } : r)), typed = useRef({});
  const commit = i => { const v = typed.current[i]; delete typed.current[i]; if (v != null && v.trim() !== (P[i]?.place || '')) upd(i, { place: v.trim(), lat: null, lng: null }); };
  return html`<${Sect} t="Places"/><div class="box">
    ${P.map((r, i) => html`<div class="cell fxcell" onFocusOut=${() => commit(i)}>
      <input type="text" class="fxname" style="font-family:ui-monospace,monospace" value=${r.match} placeholder="B## #-###" onChange=${e => upd(i, { match: e.target.value.trim() })}/>
      <span class="hint">→</span>
      ${S.state.maps ? html`<${PlaceInput} key=${i + ':' + r.place} value=${r.place} placeholder="Place" onChange=${(v, d) => { if (d) { delete typed.current[i]; upd(i, { place: d.text || d.address, lat: d.lat ?? null, lng: d.lng ?? null }); } else typed.current[i] = v; }}/>`
        : html`<input value=${r.place} placeholder="Place" onChange=${e => upd(i, { place: e.target.value.trim(), lat: null, lng: null })}/>`}
      ${r.lat != null && html`<a class="icon" title=${`${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`} href=${`https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}`} target="_blank" rel="noopener">${I('pin', 14)}</a>`}
      <button class="icon" title="Remove" onClick=${() => save(P.filter((_, j) => j !== i))}>${I('x', 14)}</button></div>`)}
    <div class="cell"><button class="ghost" style="padding-left:0" onClick=${() => save([...P, { match: '', place: '' }])}>${I('plus', 15)}Add</button></div>
  </div>`;
}
function Fixed() {
  const s = S.state.settings, F = s.fixed || [];
  const upd = (i, p) => putSettings({ fixed: F.map((f, j) => j === i ? { ...f, ...p } : f) });
  return html`<${Sect} t="Fixed Times"/><div class="box">
    ${F.map((f, i) => html`<div class="cell fxcell">
      <input type="text" class="fxname" value=${f.t} onChange=${e => upd(i, { t: e.target.value })}/>
      <span class="row" style="gap:6px;flex:none"><input class="t24" value=${f.s} onChange=${e => { const v = n24(e.target.value); if (v) upd(i, { s: v }); }}/>–<input class="t24" value=${f.e} onChange=${e => { const v = n24(e.target.value); if (v) upd(i, { e: v }); }}/></span>
      <div class="seg days">${ORDER.map(d => html`<button class=${f.days.includes(d) ? 'on' : ''} onClick=${() => upd(i, { days: f.days.includes(d) ? f.days.filter(x => x !== d) : [...f.days, d] })}>${DN[d].slice(0, 2)}</button>`)}</div>
      <div class="seg fxmode">${[[true, 'Loose', 'Moves for appointments and to close gaps; ASAP tasks may move it too'], ['asap', 'ASAP', 'Stays, only ASAP tasks may move it'], [false, 'Firm', 'Never moves']].map(([v, l, t]) =>
        html`<button title=${t} class=${(f.flex === v || (v === true && f.flex !== false && f.flex !== 'asap')) ? 'on' : ''} onClick=${() => upd(i, { flex: v })}>${l}</button>`)}</div>
      <button class="icon" title="Remove" onClick=${() => putSettings({ fixed: F.filter((_, j) => j !== i) })}>${I('x', 14)}</button></div>`)}
    <div class="cell"><button class="ghost" style="padding-left:0" onClick=${() => putSettings({ fixed: [...F, { id: 'f' + Date.now().toString(36), t: 'Break', days: [1, 2, 3, 4, 5], s: '15:30', e: '15:45' }] })}>${I('plus', 15)}Add</button></div>
  </div>
  <${Sect} t="Durations"/><div class="box">
    <div class="cell"><span>Minimum block</span><input type="number" min="5" step="5" value=${s.chunk} style="width:70px" onChange=${e => putSettings({ chunk: +e.target.value })}/><span class="hint">min</span></div>
    <div class="cell"><span>Default duration</span><input type="number" min="5" step="5" value=${s.dFree} style="width:70px" onChange=${e => putSettings({ dFree: +e.target.value })}/><span class="hint">min</span></div>
    <div class="cell"><span>Look ahead</span><input type="number" min="14" max="120" value=${s.horizonDays} style="width:70px" onChange=${e => putSettings({ horizonDays: +e.target.value })}/><span class="hint">days</span></div>
  </div>`;
}

const b64 = s => { const p = '='.repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); };
function Notify() {
  const s = S.state.settings, n = s.notify;
  const [state, setState] = useState('');
  const check = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setState('unsupported');
    const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    setState(sub ? 'on' : Notification.permission === 'denied' ? 'denied' : 'off');
  };
  useEffect(() => { check(); }, []);
  const enable = async () => {
    try {
      if (await Notification.requestPermission() !== 'granted') return check();
      const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(S.state.vapid) });
      await post('/api/push/subscribe', sub.toJSON()); check();
    } catch (e) { toast(e.message); }
  };
  const off = async () => { const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription(); if (sub) { await post('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); } check(); };
  const setN = p => putSettings({ notify: { ...n, ...p } });
  const me = S.state.me, mail = S.state.mail && !!me.email;
  const ch = k => chOf(n, k), setCh = (k, v) => setN({ ch: { ...(n.ch || {}), [k]: v } });
  const mins = (k, def) => html`<input type="number" min="0" max="120" value=${n[k] ?? def} onChange=${e => setN({ [k]: +e.target.value })}/><span class="hint">min</span>`;
  const extra = { start: mins('before', 5), event: mins('eventBefore', 10),
    morning: html`<input class="t24" value=${n.morning || '07:30'} onChange=${e => { const v = n24(e.target.value); if (v) setN({ morning: v }); }}/>` };
  return html`<${Sect} t="Delivery"/><div class="box">
    <div class="cell"><span>Push on this device</span>
      ${state === 'on' ? html`<button class="ghost" onClick=${() => post('/api/push/test').then(r => toast(r.sent > 1 ? `Sent to ${r.sent} devices` : 'Sent'), e => toast(e.message))}>Test</button><input type="checkbox" checked onChange=${off}/>`
      : state === 'off' ? html`<input type="checkbox" onChange=${enable}/>`
      : html`<span class="hint">${state === 'denied' ? 'Blocked in browser' : state === 'unsupported' ? (window.isSecureContext ? 'Add to Home Screen first' : 'Requires HTTPS') : ''}</span>`}</div>
    <div class="cell"><span>E-mail</span>${S.state.mail ? html`<input type="email" value=${me.email} placeholder="name@example.com" onChange=${async e => { try { S.set({ me: await patch('/api/me', { email: e.target.value.trim() }) }); toast('Saved'); } catch (x) { toast(x.message); } }}/>
      ${me.email && html`<button class="ghost" onClick=${() => post('/api/mail/test').then(() => toast('Sent'), x => toast(x.message))}>Test</button>`}` : html`<span class="hint">Not set up</span>`}</div>
  </div>
  <${Sect} t="Notify Me"/><div class="box">
    ${NOTIFY.map(([k, label]) => html`<div class="cell ncell"><span>${label}</span>${ch(k) !== 'off' && extra[k] ? html`<span class="nx">${extra[k]}</span>` : ''}
      <div class="seg ch">${CHANNELS.map(([v, l]) => html`<button class=${ch(k) === v ? 'on' : ''} disabled=${(v === 'email' || v === 'both') && !mail && ch(k) !== v} onClick=${() => setCh(k, v)}>${l}</button>`)}</div></div>`)}
  </div>`;
}
// every notification the app sends; each one: Off, Push, E-mail or Both (same defaults as the server)
const NOTIFY = [['start', 'Task starts'], ['event', 'Event starts'], ['deadline', 'Deadlines'], ['morning', 'Daily summary'], ['clash', 'Clashes'], ['partner', 'Shared projects'], ['ready', 'Follow-ups ready'], ['sync', 'Connection problems']];
const CHANNELS = [['off', 'Off'], ['push', 'Push'], ['email', 'E-mail'], ['both', 'Both']];
const DEF_CH = { start: 'push', event: 'off', deadline: 'push', morning: 'push', clash: 'both', partner: 'push', ready: 'push', sync: 'push' };
const chOf = (n, k) => n.ch?.[k] || (((k === 'start' && n.start === false) || (k === 'morning' && !n.morning) || (k === 'partner' && n.partner === false) || (k === 'deadline' && n.deadline === false)) ? 'off' : DEF_CH[k]);

function Account() {
  const st = S.state, me = st.me;
  const [pw, setPw] = useState(null), [totp, setTotp] = useState(null), [code, setCode] = useState('');
  return html`<div class="box">
    <div class="cell"><span>Name</span><input type="text" value=${me.name} onChange=${async e => { S.set({ me: await patch('/api/me', { name: e.target.value }) }); load(['boot']); }}/>
      <input type="color" title="Color" value=${me.color} onChange=${async e => { S.set({ me: await patch('/api/me', { color: e.target.value }) }); load(['boot']); }}/></div>
    <div class="cell"><span>ID</span><span class="hint">${me.username}</span></div>
    <${Passkeys}/>
    <div class="cell"><span>Password</span><button class="ghost" onClick=${() => setPw(pw ? null : { current: '', password: '' })}>Change</button></div>
    ${pw && html`<div class="row" style="padding:0 0 10px"><input type="password" placeholder="Current" autocomplete="current-password" value=${pw.current} onInput=${e => setPw({ ...pw, current: e.target.value })}/>
      <input type="password" placeholder="New" autocomplete="new-password" value=${pw.password} onInput=${e => setPw({ ...pw, password: e.target.value })}/>
      <button class="pri" disabled=${!pw.current || !pw.password} onClick=${async () => { try { await post('/api/me/password', pw); setPw(null); toast('Password changed'); } catch (e) { toast(e.message); } }}>Save</button></div>`}
    <div class="cell"><span>Two-factor authentication</span>
      ${me.totp_on ? html`<span class="hint">On</span><button class="ghost" onClick=${async () => { const p = await ask('Turn Off 2FA', 'Password', 'password'); if (!p) return; try { await post('/api/me/totp/disable', { password: p }); await load(['boot']); } catch (e) { toast(e.message); } }}>Turn Off</button>`
        : html`<button class="ghost" onClick=${async () => setTotp(totp ? null : await post('/api/me/totp/start'))}>Set Up</button>`}</div>
    ${totp && !me.totp_on && html`<div class="row" style="align-items:flex-start;padding:4px 0 10px;gap:16px"><div class="qr" dangerouslySetInnerHTML=${{ __html: totp.qr }}></div>
      <div style="display:grid;gap:8px"><code style="word-break:break-all">${totp.secret}</code><input inputmode="numeric" autocomplete="one-time-code" placeholder="Code" value=${code} onInput=${e => setCode(e.target.value)} style="width:140px"/>
        <button class="pri" onClick=${async () => { try { await post('/api/me/totp/enable', { code }); setTotp(null); await load(['boot']); } catch (e) { toast(e.message); } }}>Verify</button></div></div>`}
  </div>`;
}
function Appearance() {
  const st = S.state;
  return html`<div class="box"><div class="cell"><span>Background</span>
    <div class="swatches">${Object.entries(BACKGROUNDS).map(([k, b]) => html`<button class=${(st.settings.view?.bg || 'dusk') === k ? 'on' : ''} title=${b[0]} aria-label=${b[0]}
      style=${{ background: `linear-gradient(160deg,${b[1]},${b[2]} 55%,${b[3]})` }} onClick=${() => { applyBackground(k); putSettings({ view: { ...(st.settings.view || {}), bg: k } }); }}></button>`)}</div></div></div>
`;
}
export async function addPasskey() {
  try {
    const opts = await post('/api/passkeys/register/options');
    const credential = await createPasskey(opts);
    await post('/api/passkeys/register/verify', { credential });
    return true;
  } catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast(e.name === 'InvalidStateError' ? 'This device already has a passkey' : e.message); return false; }
}
function Passkeys() {
  const [L, setL] = useState([]); const reload = () => api('/api/passkeys').then(setL);
  useEffect(() => { reload(); }, []);
  return html`${L.map(k => html`<div class="cell"><span>Passkey <span class="hint">${k.name}</span></span><span class="hint">${k.last_used ? when(k.last_used) : ''}</span>
      <button class="icon" title="Remove" onClick=${async () => { if (await confirmDialog(`Remove passkey “${k.name}”?`, 'Remove', true)) { await del('/api/passkeys/' + encodeURIComponent(k.id)); reload(); } }}>${I('x', 14)}</button></div>`)}
    <div class="cell"><span>${L.length ? 'Add Passkey' : 'Passkey'}</span>${passkeysSupported() ? html`<button class="ghost" onClick=${async () => { if (await addPasskey()) { reload(); load(['boot']); } }}>${L.length ? 'Add' : 'Set Up'}</button>` : html`<span class="hint">Requires HTTPS</span>`}</div>`;
}
function Tokens() {
  const [L, setL] = useState([]), [shown, setShown] = useState(null); const reload = () => api('/api/me/tokens').then(setL);
  useEffect(() => { reload(); }, []);
  return html`<${Sect} t="Access Tokens"/><div class="box">
    ${L.map(t => html`<div class="cell"><span>${t.name}</span><span class="hint">${t.last_used ? when(t.last_used) : 'Never used'}</span>
      <button class="icon" title="Revoke" onClick=${async () => { if (await confirmDialog(`Revoke “${t.name}”?`, 'Revoke', true)) { await del('/api/me/tokens/' + t.id); reload(); } }}>${I('trash', 15)}</button></div>`)}
    ${shown && html`<div class="cell" style="flex-wrap:wrap"><code style="user-select:all;word-break:break-all;flex:1">${shown}</code><button class="ghost" onClick=${() => navigator.clipboard?.writeText(shown).then(() => toast('Copied'))}>Copy</button></div>`}
    <div class="cell"><button class="ghost" style="padding-left:0" onClick=${async () => { const n = await ask('New Token', 'Home Assistant, Mac…'); if (n) { const r = await post('/api/me/tokens', { name: n }); setShown(r.token); reload(); } }}>${I('plus', 15)}New Token</button></div>
  </div>`;
}
// Claude connector: off until you turn it on; claude.ai then connects with your own Claude account and only reaches your projects
function Claude() {
  const [c, setC] = useState(null); const reload = () => api('/api/me/claude').then(setC);
  useEffect(() => { reload(); }, []);
  if (!c) return null;
  const toggle = async on => {
    if (!on && c.connections.length && !(await confirmDialog('Turn off Claude and disconnect it?', 'Turn Off', true))) return reload();
    try { await api('/api/me/claude', { method: 'PUT', body: { on } }); } catch (e) { toast(e.message); } reload();
  };
  return html`<div class="box">
    <label class="cell"><span>Allow Claude</span><input type="checkbox" checked=${c.on} onChange=${e => toggle(e.target.checked)}/></label>
    ${c.on && html`<div class="cell" style="flex-wrap:wrap"><code style="user-select:all;word-break:break-all;flex:1">${c.url}</code><button class="ghost" onClick=${() => navigator.clipboard?.writeText(c.url).then(() => toast('Copied'))}>Copy</button></div>`}
  </div>
  ${c.on && c.connections.length > 0 && html`<${Sect} t="Connected"/><div class="box">${c.connections.map(x => html`<div class="cell"><span>${x.name}</span><span class="hint">${x.last_used ? when(x.last_used) : 'Never used'}</span>
    <button class="icon" title="Disconnect" onClick=${async () => { if (await confirmDialog(`Disconnect “${x.name}”?`, 'Disconnect', true)) { await del('/api/me/claude/' + x.id); reload(); } }}>${I('trash', 15)}</button></div>`)}</div>`}`;
}
// Mac menu bar app: download, then hand it the address and a new token through its link (it asks before it connects)
const isMac = /Macintosh/.test(navigator.userAgent) && !navigator.maxTouchPoints;
function MacBar() {
  const connect = async () => { const r = await post('/api/me/tokens', { name: 'Mac menu bar' }); location.href = `smartcalendar://connect?url=${encodeURIComponent(location.origin)}&token=${encodeURIComponent(r.token)}`; };
  return html`<${Sect} t="Mac Menu Bar"/><div class="box grp-links">
    <a class="cell" href="/mac/SmartCalendarBar.dmg" download><span>Download</span>${I('download', 15)}</a>
    <button class="cell" onClick=${connect}><span>Connect this Mac</span>${I('right', 15)}</button>
  </div>`;
}
function Sessions() {
  const [L, setL] = useState([]); const reload = () => api('/api/me/sessions').then(setL);
  useEffect(() => { reload(); }, []);
  const dev = ua => { ua = ua || ''; return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device'; };
  const br = ua => /Edg\//.test(ua) ? 'Edge' : /Firefox/.test(ua) ? 'Firefox' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '';
  return html`${L.map(s => html`<div class="cell"><span>${dev(s.ua)} <span class="hint">${br(s.ua || '')}</span>${s.current ? html` <span class="hint">· This device</span>` : ''}</span><span class="hint">${s.ip || ''}</span><span class="hint" style="min-width:90px;text-align:right">${when(s.last_seen)}</span></div>`)}
    ${L.length > 1 && html`<button class="ghost danger" style="margin-top:6px" onClick=${async () => { await post('/api/me/sessions/revoke-others'); reload(); }}>Sign Out Other Devices</button>`}`;
}
// required by the administrator: nothing else is reachable until 2FA is on
// a session without a second factor: with a passkey → sign in with it; nothing yet → add a passkey (authenticator app as alternative)
export function Force2fa() {
  const why = S.state.must2fa, [t, setT] = useState(null), [code, setCode] = useState(''), [err, setErr] = useState('');
  const viaPasskey = async () => { setErr(''); try { const opts = await api('/api/auth/passkey/options', { method: 'POST', body: {}, noAuth: true }); const credential = await getPasskey(opts);
    await api('/api/auth/passkey/verify', { method: 'POST', body: { flow: opts.flow, credential }, noAuth: true }); location.reload(); } catch (x) { if (x.name !== 'NotAllowedError' && x.name !== 'AbortError') setErr(x.message); } };
  const out = html`<div class="acts" style="justify-content:center"><button class="ghost" onClick=${async () => { await post('/api/auth/logout'); location.reload(); }}>Sign Out</button></div>`;
  if (why === 'passkey') return html`<div class="login"><div class="modal sm" style="text-align:center"><h3>Confirm with Passkey</h3>
    ${passkeysSupported() ? html`<button class="pri" style="width:100%;justify-content:center;margin:8px 0" onClick=${viaPasskey}>Sign In with Passkey</button>` : html`<p class="hint">Use a device with your passkey, or sign in with password and authenticator code.</p>`}
    ${err && html`<div class="err" style="font-size:14px">${err}</div>`}${out}</div></div>`;
  return html`<div class="login"><div class="modal sm" style="text-align:center"><h3>Second Factor</h3>
    ${passkeysSupported() && html`<button class="pri" style="width:100%;justify-content:center;margin:8px 0 14px" onClick=${async () => { if (await addPasskey()) location.reload(); }}>Add Passkey</button>`}
    ${!t ? html`<button class="ghost" style="margin:0 auto" onClick=${() => post('/api/me/totp/start').then(setT).catch(e => toast(e.message))}>Use Authenticator App</button>` : html`
      <div class="qr" dangerouslySetInnerHTML=${{ __html: t.qr }}></div><p><code style="word-break:break-all">${t.secret}</code></p>
      <div class="row" style="justify-content:center"><input inputmode="numeric" autocomplete="one-time-code" placeholder="Code" value=${code} onInput=${e => setCode(e.target.value)} style="width:140px;font-size:17px;text-align:center"/>
        <button class="pri" onClick=${async () => { try { await post('/api/me/totp/enable', { code }); location.reload(); } catch (e) { toast(e.message); } }}>Verify</button></div>`}
    ${out}</div></div>`;
}

// Backup (download your data) and Restore (a Smart Calendar backup brings back missing projects)
function Data() {
  const [busy, setBusy] = useState(false);
  const restore = e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    f.text().then(async txt => {
      let d; try { d = JSON.parse(txt); } catch { return toast('Not a backup file'); }
      if (!(await confirmDialog(`Restore from “${f.name}”? Missing projects come back; nothing is overwritten.`, 'Restore'))) return;
      setBusy(true);
      try { const r = await post('/api/restore', { backup: d }); await load(['boot', 'projects', 'tasks', 'plan', 'accounts']);
        toast(`${r.projects} projects, ${r.tasks} tasks restored`, 5000); }
      catch (x) { toast(x.message); } finally { setBusy(false); } }); };
  return html`<div class="box">
    <div class="cell"><span>Backup</span><a class="btnlink" href="/api/export" download>Download</a></div>
    <div class="cell"><span>Restore</span><label class=${'btnlink' + (busy ? ' off' : '')}>Choose File<input type="file" accept=".json,application/json" hidden onChange=${restore}/></label></div>
  </div>`;
}

// settings in groups that unfold (state remembered on this device)
const openSet = () => { try { return JSON.parse(localStorage.getItem('set-open') || '[]'); } catch { return []; } };
function Group({ id, icon, color, title, sub, children }) {
  const [o, setO] = useState(() => openSet().includes(id));
  const toggle = () => { const L = openSet().filter(x => x !== id); if (!o) L.push(id); try { localStorage.setItem('set-open', JSON.stringify(L)); } catch {} setO(!o); };
  return html`<div class=${'grp' + (o ? ' open' : '')}>
    <button class="grp-h" aria-expanded=${o} onClick=${toggle}><span class="grp-i" style=${{ background: color }}>${I(icon, 18)}</span>
      <span class="grp-t"><b>${title}</b>${sub && html`<span>${sub}</span>`}</span><span class="grp-c">${I('right', 16)}</span></button>
    ${o && html`<div class="grp-b">${children}</div>`}</div>`;
}
// the commands you can type into a calendar entry's title or notes, in any calendar app
const HELP = [
  ['Planned blocks', [['/done', 'Done'], ['/later', 'Plan again later'], ['/skip', 'Skip this round']]],
  ['Any event', [['/block', 'Blocks, even when Free'], ['/free', 'Never blocks'], ['/hide', 'Never blocks, not copied']]],
  ['New from the calendar', [['/flex 30', 'Flexible: 30 min within the event\'s time'], ['/task', 'Planned task, as long as the event'], ['/task 45', 'Planned task, 45 min']]],
];
function Help() {
  return html`${HELP.map(([t, rows]) => html`<${Sect} t=${t}/><div class="box">${rows.map(([c, d]) => html`<div class="cell"><code class="cmd">${c}</code><span class="hint" style="text-align:right">${d}</span></div>`)}</div>`)}
    <p class="hint" style="margin:12px 4px 0">Title or notes, any calendar app. Removed after use.</p>`;
}
export default function SettingsView() {
  const st = S.state; if (!st.settings) return null;
  const s = st.settings, cals = st.accounts.length, bg = (BACKGROUNDS[s.view?.bg || 'dusk'] || [])[0];
  const today = (s.hours?.work || {})[new Date().getDay()], hrs = today ? (Array.isArray(today[0]) ? today : [today]).map(r => r.join('–')).join(', ') : 'Off today';
  return html`<div class="set">
    <${Group} id="account" icon="people" color="#5e5ce6" title=${st.me.name} sub=${'@' + st.me.username + ' · Password, passkeys'}><${Account}/></${Group}>
    <${Group} id="invite" icon="plus" color="#bf5af2" title="Invite" sub="Link or code for someone new"><div class="box"><${InviteBox}/></div></${Group}>
    <${Group} id="cal" icon="calendar" color="#ff375f" title="Calendars" sub=${cals ? `${cals} connected` : 'Connect Google, Exchange, Vikunja'}><${Calendars}/><${Ranking}/></${Group}>
    <${Group} id="plan" icon="clock" color="#0a84ff" title="Planning" sub=${'Work ' + hrs}><${Hours}/><${Home}/><${Fixed}/></${Group}>
    <${Group} id="notify" icon="bell" color="#ff9f0a" title="Notifications"><${Notify}/></${Group}>
    <${Group} id="look" icon="sun" color="#30b0c7" title="Appearance" sub=${bg}><${Appearance}/></${Group}>
    <${Group} id="devices" icon="shield" color="#34c759" title="Devices & Access" sub="Signed-in devices, tokens"><${Sect} t="Devices"/><div class="box"><${Sessions}/></div>${isMac && html`<${MacBar}/>`}<${Tokens}/></${Group}>
    <${Group} id="claude" icon="bolt" color="#d97757" title="Claude"><${Claude}/></${Group}>
    <${Group} id="data" icon="folder" color="#8e8e93" title="Backup & Restore"><${Data}/></${Group}>
    <${Group} id="help" icon="book" color="#64d2ff" title="Commands" sub="/done, /flex 30 …"><${Help}/></${Group}>
    <div class="box grp-links">
      <a class="cell" href="#/setup"><span>Setup Assistant</span>${I('right', 15)}</a>
      ${st.me.is_admin && html`<a class="cell" href="#/admin"><span>Administration</span>${I('right', 15)}</a>`}
      <button class="cell danger" onClick=${async () => { await post('/api/auth/logout'); location.reload(); }}><span>Sign Out</span>${I('logout', 16)}</button>
    </div>
  </div>`;
}

