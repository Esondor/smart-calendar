// The sheet of a calendar event (Calendar and Now): title, day, time, calendar; whether it blocks, travel time;
// the times it may be moved to (an hours set, e.g. a doctor's opening hours) and buttons to move it to the next free time.
import { html, useState, useEffect, useRef, S, api, patch, post, load, toast, openModal, confirmDialog, askMinutes, addDays, hm, DN, SH, dh, isoDate, fromIso, n24, priColor } from './lib.js';
import { I } from './icons.js';

export const googleCals = () => S.state.accounts.filter(a => a.kind === 'google' && a.status === 'ok').flatMap(a => a.calendars.filter(c => c.writable && c.id !== S.state.settings?.plan?.calendarId).map(c => ({ ...c, acc: a.id })));
export const atTime = (day, t) => fromIso(day) + (+t.slice(0, 2) * 60 + +t.slice(3)) * 60000;
// title, day, times and calendar of an event; repeating events: this one or all
export function EventFields({ f, set, cals, recurring, onTravel, travel }) {
  return html`<input type="text" class="ttl" placeholder="Title" value=${f.title} onInput=${e => set({ title: e.target.value })}/>
    <div class="box" style="margin-top:10px">
      <label class="cell"><span>All day</span><input type="checkbox" checked=${f.all_day} onChange=${e => set({ all_day: e.target.checked })}/></label>
      <div class="cell"><span>Day</span><input type="date" value=${f.day} onInput=${e => set({ day: e.target.value })}/></div>
      ${!f.all_day && html`<div class="cell"><span>Time</span><span class="row" style="gap:6px;flex:none"><input class="t24" value=${f.s} onChange=${e => set({ s: n24(e.target.value) || f.s })}/>–<input class="t24" value=${f.e} onChange=${e => set({ e: n24(e.target.value) || f.e })}/></span></div>`}
      <div class="cell"><span>Place</span><${PlaceInput} value=${f.location || ''} onChange=${v => set({ location: v })} onTravel=${onTravel} travel=${travel}/></div>
      ${cals.length > 1 && html`<div class="cell"><span>Calendar</span><select value=${f.cal} onChange=${e => set({ cal: +e.target.value })}>${cals.map(c => html`<option value=${c.id}>${c.name}</option>`)}</select></div>`}
      ${recurring && html`<div class="cell"><span>Change</span><div class="seg"><button type="button" class=${f.scope === 'one' ? 'on' : ''} onClick=${() => set({ scope: 'one' })}>This Event</button><button type="button" class=${f.scope === 'all' ? 'on' : ''} onClick=${() => set({ scope: 'all' })}>All</button></div></div>`}
    </div>`;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const WD = [[1, 'Mo'], [2, 'Tu'], [3, 'We'], [4, 'Th'], [5, 'Fr'], [6, 'Sa'], [0, 'Su']];

// the ranking as the server has it (Settings → Calendars → Ranking): blocking calendars and "tasks", higher first
export function rankOrder() {
  const st = S.state, cals = st.accounts.flatMap(a => (a.calendars || []).filter(c => c.use_busy));
  const has = new Set(cals.map(c => 'cal:' + c.id));
  const order = (st.settings?.plan?.rank || []).filter(k => k === 'tasks' || has.has(k));
  [...cals].sort((a, b) => (b.include_words ? 1 : 0) - (a.include_words ? 1 : 0) || a.name.localeCompare(b.name))
    .forEach(c => { const k = 'cal:' + c.id; if (!order.includes(k)) { const i = order.indexOf('tasks'); order.splice(i < 0 ? order.length : i, 0, k); } });
  if (!order.includes('tasks')) order.push('tasks');
  return { order, cal: new Map(cals.map(c => ['cal:' + c.id, c])) };
}
// this event's place in the ranking: set automatically (work hours / personal time), dragged to change
function EventRank({ ev, value, set }) {
  const { order, cal } = rankOrder(), ref = useRef(), [drag, setDrag] = useState(null);
  // position: before the key it sits above (manual), or by its automatic rank
  const autoAt = order.filter((_, i) => i <= ev.rank).length;
  const at = value ? (value === 'end' ? order.length : Math.max(0, order.indexOf(value))) : autoAt;
  const pos = drag ?? at;
  const rows = order.map(k => ({ k })); rows.splice(pos, 0, { me: true });
  const move = e => {
    if (drag == null) return;
    const others = [...ref.current.querySelectorAll('.rk:not(.me)')];
    const n = others.filter(r => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 < e.clientY; }).length;
    if (n !== drag) setDrag(n);
  };
  const up = () => { if (drag == null) return; const n = drag; setDrag(null); if (n !== at) set(n >= order.length ? 'end' : order[n]); };
  return html`<div class="sect" style="margin:16px 4px 6px">Ranking${value ? html` <button class="ghost" style="float:right;margin-top:-6px;text-transform:none" onClick=${() => set(null)}>Auto</button>` : ''}</div>
    <div class="box rank" ref=${ref}>${rows.map(r => { const c = r.k && cal.get(r.k);
      return r.me ? html`<div class=${'cell rk me' + (drag != null ? ' drag' : '')}><span class="row" style="gap:10px;flex-wrap:nowrap;min-width:0"><span class="sw" style=${{ background: 'var(--acc)' }}></span><b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ev.title}</b>${!value ? html`<span class="hint">Auto</span>` : ''}</span>
          <button class="icon handle" aria-label="Move this event" onPointerDown=${e => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); setDrag(at); }} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}>${I('menu', 16)}</button></div>`
        : html`<div class="cell rk" key=${r.k}><span class="row" style="gap:10px;flex-wrap:nowrap;min-width:0">${c ? html`<span class="sw" style=${{ background: c.color }}></span>` : I('list', 15)}<span class=${c ? '' : 'hint'} style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c ? c.name : 'Tasks'}</span></span></div>`; })}
    </div>`;
}
const OPT = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];
// little dots in the colors of the other calendars that have this appointment
export const AlsoDots = ({ ev }) => (ev.alsoIn || []).length ? html`<span class="also" title=${'Also in ' + ev.alsoIn.map(c => c.name).join(', ')}>${ev.alsoIn.map(c => html`<i style=${{ background: c.color || 'var(--faint)' }}></i>`)}</span>` : '';
// copy the appointment into other calendars of yours, so the people who share them see it too
function AlsoIn({ ev }) {
  const have = new Set([ev.calendar_id, ...(ev.alsoIn || []).map(c => c.id)]);
  const cals = googleCals().filter(c => c.id !== ev.calendar_id);
  const [sel, setSel] = useState([]), [busy, setBusy] = useState(false), [name, setName] = useState('');
  if (!cals.length) return '';
  const copy = async () => { setBusy(true); try { const r = await post(`/api/events/${ev.id}/copy`, { calendars: sel, title: name.trim() || undefined }); toast(r.copied ? `Copied to ${r.copied} calendar${r.copied > 1 ? 's' : ''}` : 'Already there'); setSel([]); setName(''); await load(['plan']); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  return html`<div class="sect" style="margin:16px 4px 6px">Also In</div><div class="box">
    ${cals.map(c => html`<label class="cell"><span class="row" style="gap:10px;flex-wrap:nowrap;min-width:0"><span class="sw" style=${{ background: c.color }}></span><span>${c.name}</span></span>
      <input type="checkbox" checked=${have.has(c.id) || sel.includes(c.id)} disabled=${have.has(c.id)} onChange=${e => setSel(e.target.checked ? [...sel, c.id] : sel.filter(x => x !== c.id))}/></label>`)}
    ${sel.length > 0 && html`<div class="cell"><input type="text" class="grow" placeholder=${ev.title} aria-label="Name of the copy" value=${name} onInput=${e => setName(e.target.value)}/>
      <button class="pri" disabled=${busy} onClick=${copy}>Copy</button></div>`}</div>`;
}

// a clash: both events, the one that wins is marked, the other has a button to choose it instead
export function ClashCard({ c, tag, onChange }) {
  const [x, setX] = useState(c), [busy, setBusy] = useState(false), [gone, setGone] = useState(false);
  const send = async body => { setBusy(true); try { const r = await post('/api/clashes', { key: x.key, ...body }); const n = r.items.find(i => i.key === x.key); if (n) setX(n); else setGone(true); onChange && onChange(r); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const pick = choice => send({ choice });
  if (gone) return null;
  const opt = (choice, title, cal) => html`<div class="cell"><span style="min-width:0"><span>${title}</span>${cal ? html`<span class="hint"> · ${cal}</span>` : ''}</span>
    ${x.choice === choice ? html`<span class="chip ok">${I('check', 13, { w: 2.4 })}Chosen</span>` : html`<button class="pri" disabled=${busy} onClick=${() => pick(choice)}>Choose</button>`}</div>`;
  return html`<div class="box clash"><div class="cell"><span class="hint">${DN[new Date(x.start).getDay()]} ${SH(x.start)}, ${hm(x.start)}–${hm(x.end)}</span>${(x.choice === 'mine' && x.marked) || (x.choice === 'work' && x.m_marked) ? html`<span class="hint">#${tag}-blocked · ${x.choice === 'mine' ? x.g_title : x.m_title}</span>` : ''}</div>
    ${opt('work', x.g_title, x.g_name)}${opt('mine', x.m_title, x.m_name)}
    <div class="cell"><button class="ghost" style="padding-left:0" disabled=${busy} onClick=${() => send({ same: true })}>Same Appointment</button><span class="grow"></span><button class="ghost" disabled=${busy} onClick=${() => send({ dismiss: true })}>Dismiss</button></div></div>`;
}

// Done for an appointment: it ended now, as planned, or at another time; the calendar gets the real end, the plan follows
export async function finishEvent(ev, how) {
  let end = how === 'planned' ? 'planned' : undefined;
  if (how === 'other') {
    const t = await openModal(close => html`<div class="modal sm"><h3>${ev.title}</h3><div class="box"><div class="cell"><span>Ended At</span><input class="t24" id="ev-end" value=${hm(Date.now())}/></div></div>
      <div class="acts"><button onClick=${() => close(null)}>Cancel</button><button class="pri" onClick=${() => close(document.getElementById('ev-end').value)}>Done</button></div></div>`);
    if (!t) return;
    const v = n24(t); if (!v) return toast('Invalid time');
    end = atTime(isoDate(ev.start), v);
  }
  try { await post(`/api/events/${ev.id}/done`, end ? { end } : {}); await load(['plan']); toast('Done'); } catch (e) { toast(e.message); }
}
export async function openEventSheet(ev) {
  let clash = null;
  try { const c = await api('/api/clashes'); const it = c.items.find(i => (i.g_cal === ev.calendar_id && i.g_ext === ev.ext_id) || (i.m_cal === ev.calendar_id && i.m_ext === ev.ext_id)); if (it) clash = { tag: c.tag, it }; } catch {}
  const timed = !ev.all_day && ev.end - ev.start < 864e5, sets = Object.keys(S.state.settings?.hours || {});
  const own = googleCals(), acc = own.find(c => c.id === ev.calendar_id)?.acc, cals = own.filter(c => c.acc === acc);
  const e0 = { title: ev.title, all_day: !timed, day: isoDate(ev.start), s: hm(ev.start), e: hm(ev.end), cal: ev.calendar_id, scope: 'one',
    location: ev.location || '', hours: ev.win ? '*' : ev.hours || '', win: ev.win || { days: [1, 2, 3, 4, 5], s: hm(ev.start), e: hm(ev.end) }, rank: ev.rankSet || null };
  // closed without Save or Discard (×, outside, pulled down, back): changes are saved anyway
  const f0 = { before: ev.before, after: ev.after, block: ev.blocks, ...e0 }, cur = { f: f0 };
  let r = await openModal(close => { const B = () => { const [f, setF] = useState(f0); cur.f = f;
    const pick = k => html`<select value=${f[k]} disabled=${!f.block} onChange=${e => setF({ ...f, [k]: +e.target.value })}>${[...new Set([...OPT, f[k]])].sort((a, b) => a - b).map(m => html`<option value=${m}>${m ? dh(m) : 'None'}</option>`)}</select>`;
    const travelTo = m => { const r = Math.ceil(m / 5) * 5; setF({ ...f, block: true, before: r, after: r }); };
    return html`<div class="modal sm">${ev.editable ? html`<${EventFields} f=${f} set=${x => setF({ ...f, ...x })} cals=${cals} recurring=${ev.recurring} onTravel=${timed ? travelTo : null} travel=${f.before}/><div class="hint" style="margin:6px 0 10px">${ev.cal}${ev.recurring ? ' · Repeats' : ''}${(ev.alsoIn || []).length ? ' · also ' + ev.alsoIn.map(c => c.name).join(', ') : ''}</div>`
      : html`<h3>${ev.title} <${AlsoDots} ev=${ev}/></h3><div class="hint" style="margin:-4px 0 8px">${DN[new Date(ev.start).getDay()]} ${SH(ev.start)}${timed ? `, ${hm(ev.start)}–${hm(ev.end)}` : ''} · ${ev.cal}${ev.recurring ? ' · Repeats' : ''}</div>`}
      ${(ev.join || ev.pin || (ev.location && !ev.editable)) && html`<div class="box" style="margin-bottom:12px">
        ${ev.pin && html`<a class="cell" style="color:inherit;text-decoration:none" href=${ev.pin.url} target="_blank" rel="noopener"><span class="row" style="gap:6px">${I('pin', 14)}${ev.pin.label}</span><span class="hint">Google Maps</span></a>`}
        ${ev.location && !ev.editable && html`<a class="cell" style="color:inherit;text-decoration:none" href=${'https://maps.apple.com/?q=' + encodeURIComponent(ev.location)} target="_blank" rel="noopener"><span>Place</span><span class="hint" style="text-align:right;overflow:hidden;text-overflow:ellipsis">${ev.location}</span></a>`}
        ${ev.join && html`<div class="cell"><span>Online</span><a class="join" href=${ev.join} target="_blank" rel="noopener">Join</a></div>`}</div>`}
      ${ev.hidden && html`<div class="box" style="margin-bottom:12px"><div class="cell"><span class="hint">Hidden for you</span><button class="ghost" onClick=${async () => { try { await post(`/api/events/${ev.id}/show`); await load(['plan']); close(null); } catch (e) { toast(e.message); } }}>Show Again</button></div></div>`}
      ${clash && html`<div class="sect" style="margin:0 4px 6px">Clash</div><${ClashCard} c=${clash.it} tag=${clash.tag} onChange=${() => load(['plan'])}/>`}
      <div class="box"><label class="cell"><span>Blocks time</span><input type="checkbox" checked=${f.block} onChange=${e => setF({ ...f, block: e.target.checked })}/></label>
        ${timed && html`<div class="cell"><span>Before</span>${pick('before')}</div><div class="cell"><span>After</span>${pick('after')}</div>`}
        ${ev.editable && timed && html`<div class="cell"><span>Times</span><select value=${f.hours} onChange=${e => setF({ ...f, hours: e.target.value })}><option value="">Any</option><option value="*">From – To</option>${sets.map(n => html`<option value=${n}>${cap(n)}</option>`)}</select></div>`}
        ${ev.editable && timed && f.hours === '*' && html`<div class="cell"><span>Between</span><span class="row" style="gap:6px;flex:none"><input class="t24" value=${f.win.s} onChange=${e => setF({ ...f, win: { ...f.win, s: n24(e.target.value) || f.win.s } })}/>–<input class="t24" value=${f.win.e} onChange=${e => setF({ ...f, win: { ...f.win, e: n24(e.target.value) || f.win.e } })}/></span></div>
          <div class="cell"><div class="seg days">${WD.map(([d, l]) => html`<button type="button" class=${f.win.days.includes(d) ? 'on' : ''} onClick=${() => setF({ ...f, win: { ...f.win, days: f.win.days.includes(d) ? f.win.days.filter(x => x !== d) : [...f.win.days, d] } })}>${l}</button>`)}</div></div>`}</div>
      ${ev.editable && timed && rankOrder().order.length > 1 && html`<${EventRank} ev=${ev} value=${f.rank} set=${v => setF({ ...f, rank: v })}/>`}
      ${ev.editable && html`<${AlsoIn} ev=${ev}/>`}
      ${timed && ev.start <= Date.now() + 15 * 60000 && (ev.end > Date.now() || ev.track) && !ev.done && html`<div class="sect" style="margin:16px 4px 6px">Track</div><div class="menu">
        ${ev.track?.since ? html`<button onClick=${() => close({ track: 'pause' })}>${I('pause')}Pause</button>` : html`<button onClick=${() => close({ track: 'start' })}>${I('play')}${ev.track ? 'Resume' : 'Start'}</button>`}</div>`}
      ${timed && ev.start <= Date.now() && !ev.done && html`<div class="sect" style="margin:16px 4px 6px">Done</div><div class="menu">
        <button onClick=${() => close({ done: 'now' })}>${I('check')}Ended Now · ${hm(Date.now())}</button>
        ${ev.end <= Date.now() && html`<button onClick=${() => close({ done: 'planned' })}>${I('check')}As Planned · ${hm(ev.end)}</button>`}
        <button onClick=${() => close({ done: 'other' })}>${I('clock')}Other Time…</button></div>`}
      ${ev.editable && timed && html`<div class="sect" style="margin:16px 4px 6px">Move To</div><div class="menu">
        <button onClick=${() => close({ ...f, move: 'now' })}>${I('forward')}Next Free Time</button>
        <button onClick=${() => close({ ...f, move: 'tomorrow' })}>${I('sun')}Tomorrow</button>
        <button onClick=${() => close({ ...f, move: 'week' })}>${I('calendar')}Next Week</button>
        <button onClick=${() => close({ ...f, move: 'auto' })}>${I('repeat')}Auto-schedule</button></div>`}
      <div class="acts">${ev.editable && html`<button class="icon" style="margin-right:auto;color:var(--late)" title="Delete" onClick=${() => close({ ...f, del: true })}>${I('trash')}</button>`}<button onClick=${() => close({ discard: true })}>Discard</button><button class="pri" onClick=${() => close(f)}>Save</button></div></div>`; }; return html`<${B}/>`; });
  if (r?.done) return finishEvent(ev, r.done);
  if (r?.track) { try { await post(`/api/events/${ev.id}/${r.track}`); await load(['plan']); } catch (e) { toast(e.message); } return; }
  if (!r) r = JSON.stringify(cur.f) !== JSON.stringify(f0) ? cur.f : null;
  if (!r || r.discard) return;
  let id = ev.id;
  if (r.del) {
    if (!(await confirmDialog(`Delete “${ev.title}”${ev.recurring && r.scope === 'all' ? ' and all its repeats' : ''}?`, 'Delete', true))) return;
    try { await api(`/api/events/${ev.id}?scope=${r.scope}`, { method: 'DELETE', body: {} }); await load(['plan']); toast('Deleted'); } catch (e) { toast(e.message); } return;
  }
  try {
    const rule = {};
    if (r.hours !== e0.hours || (r.hours === '*' && JSON.stringify(r.win) !== JSON.stringify(e0.win))) { rule.hours = r.hours && r.hours !== '*' ? r.hours : null; rule.win = r.hours === '*' ? r.win : null; }
    if (r.rank !== e0.rank) rule.rank = r.rank;
    if (ev.editable && Object.keys(rule).length) await api(`/api/events/${ev.id}/rule`, { method: 'PUT', body: rule });
    if (r.move === 'auto') {   // becomes a task: planned in its window (Times → From – To, else the event's own span)
      const len = Math.round((ev.end - ev.start) / 60000), m = await askMinutes('Takes', [15, 30, 45, 60, 90, 120], Math.min(len, 60));
      if (!m?.m) return;
      const win = r.hours === '*' ? r.win : null;
      await post(`/api/events/${ev.id}/to-task`, { kind: 'flex', minutes: m.m, win });
      await load(['plan', 'tasks']); toast('Planned automatically'); return;
    }
    if (r.move) {
      const m = await post(`/api/events/${ev.id}/reschedule`, { from: r.move });
      toast(`Moved to ${DN[new Date(m.start).getDay()]} ${SH(m.start)}, ${hm(m.start)}`);
    } else if (ev.editable) {
      const ch = {};
      if (r.title.trim() && r.title !== e0.title) ch.title = r.title.trim();
      if (r.day !== e0.day || r.s !== e0.s || r.e !== e0.e || r.all_day !== e0.all_day) {
        ch.start = r.all_day ? fromIso(r.day) : atTime(r.day, r.s); ch.end = r.all_day ? addDays(fromIso(r.day), Math.max(1, Math.round((ev.end - ev.start) / 864e5))) : atTime(r.day, r.e); ch.all_day = r.all_day;
        if (!(ch.end > ch.start)) return toast('End must be after start');
      }
      if (r.cal !== e0.cal) ch.calendar_id = r.cal;
      if (r.location !== e0.location) ch.location = r.location;
      if (Object.keys(ch).length) { const x = await patch('/api/events/' + ev.id, { ...ch, scope: r.scope }); if (x?.id) id = x.id; }
    }
    const changed = r.before !== ev.before || r.after !== ev.after;
    const body = { block: r.block === ev.blocks && ev.forced == null ? null : r.block,
      before: changed ? r.before : ev.custom ? ev.before : null, after: changed ? r.after : ev.custom ? ev.after : null };
    await api(`/api/events/${id}/buffer`, { method: 'PUT', body });
    await load(['plan']);
  } catch (e) { toast(e.message); }
}

// New → Appointment: one kind, everything in view. A switch: "Time" (at a time you give, written to that calendar) or
// "Planned" (it takes a while and Smart Calendar finds the time). Start and End / Due side by side, the start now unless
// changed. Planned: how long, in which hours or, checked, a window of its own (between times, on some days), and a priority
// that is only where it starts: as the due date comes near it rises by itself.
const PRIS = [[3, 'Low'], [2, 'Medium'], [1, 'High'], [0, 'ASAP']];
// two choices: a switch that slides from the left one to the right one
// several choices in one: the knob slides to the one picked
export const SwitchN = ({ opts, value, set }) => { const i = Math.max(0, opts.findIndex(([v]) => v === value));
  return html`<div class="swn" style=${{ '--n': opts.length, '--i': i }}>${opts.map(([v, l], k) => html`<button type="button" class=${k === i ? 'on' : ''} onClick=${() => set(v)}>${l}</button>`)}</div>`; };
// your hours to plan in: each set of hours, or all of them together ("All day": never at night)
export const hoursOpts = () => [...Object.keys(S.state.settings?.hours || { work: 1, personal: 1 }).map(n => [n, cap(n)]), ['all', 'All day']];
export const Switch2 = ({ a, b, right, set }) => html`<button type="button" class=${'sw2' + (right ? ' r' : '')} onClick=${() => set(!right)}><span>${a}</span><span>${b}</span></button>`;
export const DateTime = ({ d, t, setD, setT, empty }) => html`<div class="dt"><input type="date" value=${d} onInput=${e => setD(e.target.value)}/>${!empty && html`<div class="tm"><input class="t24" value=${t} placeholder="--:--" onChange=${e => setT(n24(e.target.value) || '')}/></div>`}</div>`;
export async function newAppointment(at = null) {
  const cals = googleCals(), names = Object.keys(S.state.settings?.hours || { work: 1, personal: 1 });
  const t0 = at || Math.ceil(Date.now() / 300000) * 300000;
  const r = await openModal(close => { const B = () => {
    const [f, setF] = useState({ title: '', plan: !cals.length, sd: isoDate(t0), st: hm(t0), ed: isoDate(t0 + 3600e3), et: hm(t0 + 3600e3), dd: '', dt: '',
      all_day: false, block: true, minutes: 30, when: names.includes('personal') ? 'personal' : names[0], win: false, days: [1, 2, 3, 4, 5], ws: '08:00', we: '11:00',
      priority: 2, cal: cals.length ? String((cals.find(c => c.use_busy) || cals[0]).id) : '', location: '', travel: 0, notes: '' });
    const set = x => setF({ ...f, ...x }), plan = f.plan;
    // moving the start keeps the length; the end never before the start
    const setStart = x => { const n = { ...f, ...x }; if (!plan) { const len = atTime(f.ed, f.et || '00:00') - atTime(f.sd, f.st || '00:00'), e = atTime(n.sd, n.st || '00:00') + Math.max(len, 15 * 60000); n.ed = isoDate(e); n.et = hm(e); } setF(n); };
    const s = atTime(f.sd, f.st || '00:00'), e = plan ? (f.dd ? atTime(f.dd, f.dt || '23:59') : null) : f.all_day ? fromIso(f.ed) : atTime(f.ed, f.et || '00:00');
    const ok = f.title.trim() && (plan ? f.minutes >= 5 && (!f.win || (f.days.length && f.we > f.ws)) && (!e || e > s) : (f.all_day ? f.ed >= f.sd : e > s));
    const step = k => set({ minutes: Math.max(15, Math.min(12 * 60, f.minutes + k * 15)) });
    return html`<div class="modal sm appt"><input type="text" class="ttl" placeholder="Title" value=${f.title} onInput=${x => set({ title: x.target.value })}/>
      ${cals.length > 0 && html`<div style="margin-top:12px"><${Switch2} a="Time" b="Planned" right=${plan} set=${v => set({ plan: v })}/></div>`}
      <div class="box" style="margin-top:12px">
        <div class="cell two"><div><span class="lbl">Start</span><${DateTime} d=${f.sd} t=${f.st} empty=${!plan && f.all_day} setD=${v => setStart({ sd: v })} setT=${v => setStart({ st: v || f.st })}/></div>
          <div><span class="lbl">${plan ? 'Due' : 'End'}</span>${plan
            ? html`<div class="dt">${f.dd ? html`<input type="date" value=${f.dd} min=${f.sd} onInput=${x => set({ dd: x.target.value })}/><div class="tm"><input class="t24" value=${f.dt} placeholder="--:--" onChange=${x => set({ dt: n24(x.target.value) || '' })}/><button type="button" class="icon" title="No due date" onClick=${() => set({ dd: '', dt: '' })}>${I('x', 14)}</button></div>`
              : html`<button type="button" class="none" onClick=${() => set({ dd: f.sd })}>None</button>`}</div>`
            : html`<${DateTime} d=${f.ed} t=${f.et} empty=${f.all_day} setD=${v => set({ ed: v })} setT=${v => set({ et: v || f.et })}/>`}</div></div>
        ${!plan ? html`
          <label class="cell"><span>All day</span><input type="checkbox" checked=${f.all_day} onChange=${x => set({ all_day: x.target.checked, block: !x.target.checked, ed: x.target.checked ? f.sd : f.ed })}/></label>
          <label class="cell"><span>Blocks time</span><input type="checkbox" checked=${f.block} onChange=${x => set({ block: x.target.checked })}/></label>`
        : html`
          <div class="cell"><span>Takes</span><span class="stepper"><button type="button" class="mn" title="Less" onClick=${() => step(-1)}></button><b>${dh(f.minutes)}</b><button type="button" class="pl" title="More" onClick=${() => step(1)}></button></span></div>
          <label class="cell"><span>Certain time window</span><input type="checkbox" checked=${f.win} onChange=${x => set({ win: x.target.checked })}/></label>
          ${f.win ? html`<div class="cell"><span>Between</span><span class="row" style="gap:6px;flex:none"><input class="t24" value=${f.ws} onChange=${x => set({ ws: n24(x.target.value) || f.ws })}/>–<input class="t24" value=${f.we} onChange=${x => set({ we: n24(x.target.value) || f.we })}/></span></div>
            <div class="cell"><div class="seg days">${WD.map(([d, l]) => html`<button type="button" class=${f.days.includes(d) ? 'on' : ''} onClick=${() => set({ days: f.days.includes(d) ? f.days.filter(x => x !== d) : [...f.days, d] })}>${l}</button>`)}</div></div>`
          : html`<div class="cell"><span>In</span><${SwitchN} opts=${hoursOpts()} value=${f.when} set=${v => set({ when: v })}/></div>`}
          <div class="cell ncell"><span>Priority</span><div class="seg ch pri">${PRIS.map(([i, l]) => html`<button type="button" class=${f.priority === i ? 'on' : ''} style=${f.priority === i ? { background: priColor(i), color: '#fff' } : null} onClick=${() => set({ priority: i })}>${l}</button>`)}</div></div>
          ${f.dd && f.priority > 0 && html`<div class="cell rise"><span></span><span class="row" style="gap:6px"><i style=${{ background: `linear-gradient(90deg,${priColor(f.priority)},${priColor(0)})` }}></i>ASAP by ${DN[new Date(fromIso(f.dd)).getDay()]} ${SH(fromIso(f.dd))}${f.dt ? ', ' + f.dt : ''}</span></div>`}`}
        ${cals.length > 0 && html`<div class="cell"><span>Calendar</span><select value=${f.cal} onChange=${x => set({ cal: x.target.value })}>${plan && html`<option value="">Plan calendar</option>`}${cals.map(c => html`<option value=${c.id}>${c.name}</option>`)}</select></div>`}
        <div class="cell"><span>Place</span><${PlaceInput} value=${f.location} onChange=${v => set({ location: v })} onTravel=${plan ? m => set({ travel: m }) : null} travel=${f.travel}/></div>
        <div class="cell"><textarea rows="2" style="width:100%" placeholder="Notes" value=${f.notes} onInput=${x => set({ notes: x.target.value })}></textarea></div>
      </div>
      <div class="acts"><button onClick=${() => close(null)}>Cancel</button><button class="pri" disabled=${!ok} onClick=${() => close({ ...f, s, e })}>Add</button></div></div>`; }; return html`<${B}/>`; });
  if (!r) return;
  try {
    if (!r.plan) {
      await post('/api/events', { calendar_id: +r.cal, title: r.title.trim(), all_day: r.all_day, start: r.all_day ? fromIso(r.sd) : r.s, end: r.all_day ? addDays(fromIso(r.ed), 1) : r.e,
        location: r.location.trim() || null, notes: r.notes.trim() || null, free: !r.block });
      await load(['plan']);
    } else {
      await post('/api/flexible', { title: r.title.trim(), minutes: r.minutes, win: r.win ? { days: r.days, s: r.ws, e: r.we } : null, schedule: r.win ? null : r.when,
        calendar_id: +r.cal || null, from_at: r.s, due_at: r.dd && r.dt ? r.e : null, deadline: r.dd || null, priority: r.priority, location: r.location.trim(), travel: r.travel || 0, notes: r.notes.trim() });
      await load(['plan', 'tasks']); toast('Planned');
    }
  } catch (x) { toast(x.message); }
}

// a place: Google Maps suggestions while you type (near your home), picking one fills name and address;
// with onTravel, the time by car and by bike from home is shown, a tap uses it as travel time
const sess = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
// rough device location (about 1 km) so suggestions are near you; asked once when you first type a place, nothing changes if you say no
const near = { at: 0, p: null, no: false };
function askNear() {
  if (!navigator.geolocation || near.no || Date.now() - near.at < 30 * 60000) return;
  near.at = Date.now();
  navigator.geolocation.getCurrentPosition(g => { near.p = { lat: Math.round(g.coords.latitude * 100) / 100, lng: Math.round(g.coords.longitude * 100) / 100 }; },
    e => { if (e.code === 1) near.no = true; }, { enableHighAccuracy: false, maximumAge: 30 * 60000, timeout: 10000 });
}
export function PlaceInput({ value, onChange, onTravel, travel: used, placeholder = 'Place' }) {
  const [q, setQ] = useState(value || ''), [list, setList] = useState([]), [tt, setTt] = useState(null), s = useRef(sess()), timer = useRef(), seq = useRef(0);
  const loadTravel = to => { if (!onTravel || !S.state.maps || !to) return setTt(null); api('/api/travel?to=' + encodeURIComponent(to)).then(r => setTt(r.car || r.bike ? r : null)).catch(() => setTt(null)); };
  useEffect(() => { loadTravel(value); }, []);
  const type = v => {
    setQ(v); onChange(v, null);
    clearTimeout(timer.current);
    if (!S.state.maps || v.trim().length < 3) return setList([]);
    const n = ++seq.current;
    timer.current = setTimeout(() => api('/api/places?q=' + encodeURIComponent(v.trim()) + '&s=' + s.current + (near.p ? `&lat=${near.p.lat}&lng=${near.p.lng}` : '')).then(r => { if (n === seq.current) setList(r); })
      .catch(e => { setList([]); if (!PlaceInput.warned) { PlaceInput.warned = true; toast(e.message); } }), 250);
  };
  const pick = async p => {
    setList([]);
    try { const d = await api(`/api/places/${encodeURIComponent(p.id)}?s=${s.current}`); s.current = sess(); setQ(d.text); onChange(d.text, d); loadTravel(d.address || d.text); }
    catch (e) { toast(e.message); }
  };
  const btn = (k, l) => tt?.[k] && html`<button type="button" class=${'ghost' + (used === tt[k].min ? ' on' : '')} onClick=${() => onTravel(used === tt[k].min ? 0 : tt[k].min, k)}>${l} ${dh(tt[k].min)}</button>`;
  return html`<div class="place"><input type="text" value=${q} placeholder=${placeholder} autocomplete="off" onFocus=${() => S.state.maps && askNear()} onInput=${e => type(e.target.value)} onBlur=${() => setTimeout(() => setList([]), 200)}/>
    ${list.length > 0 && html`<ul class="sugg">${list.map(p => html`<li onPointerDown=${e => { e.preventDefault(); pick(p); }}><b>${p.title}</b><span class="hint">${p.sub}${p.km != null ? ` · ${p.km} km` : ''}</span></li>`)}</ul>`}
    ${tt && html`<div class="travel">${btn('car', 'Car')}${btn('bike', 'Bike')}</div>`}</div>`;
}
