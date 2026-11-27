// Booking: your links for people outside the app (Settings → Booking), and Find a Time in a shared project.
import { html, useState, useEffect, S, api, post, patch, del, load, toast, openModal, confirmDialog, DN, SH, hm, dh } from './lib.js';
import { I } from './icons.js';
import { SwitchN, hoursOpts, googleCals, Duration } from './eventsheet.js';

const linkUrl = l => `${location.origin}/book/${l.token}`;
const copy = async t => { try { await navigator.clipboard.writeText(t); toast('Link copied'); } catch { prompt('Link', t); } };
const DURS = [15, 30, 45, 60, 90, 120];

// Settings → Booking: a link per kind of meeting; whoever has it sees free times that fit your plan, never your entries
export function BookingLinks() {
  const [L, setL] = useState(null);
  const reload = () => api('/api/booking-links').then(setL).catch(e => toast(e.message));
  useEffect(reload, []);
  return html`<div class="box">
    ${(L || []).map(l => html`<div class="cell"><span class="row" style="gap:8px;min-width:0"><span class=${'dot' + (l.active ? ' on' : '')}></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.title}</span>
      <span class="hint">${l.minutes.map(m => dh(m)).join(', ')}</span></span>
      <span class="row" style="gap:4px;flex:none"><button class="icon" title="Copy link" onClick=${() => copy(linkUrl(l))}>${I('copy', 16)}</button>
        <button class="icon" title="Edit" onClick=${async () => { if (await editLink(l)) reload(); }}>${I('gear', 16)}</button></span></div>`)}
    <button class="cell" style="color:var(--acc)" onClick=${async () => { const l = await editLink(null); if (l) { reload(); copy(linkUrl(l)); } }}><span class="row" style="gap:6px">${I('plus', 15)}New Booking Link</span></button>
  </div>`;
}
async function editLink(l) {
  const cals = googleCals();
  const r = await openModal(close => { const B = () => {
    const [f, setF] = useState(l ? { ...l, calendar_id: l.calendar_id || '' } : { title: '', minutes: [30, 60], days: 21, hours: 'work', calendar_id: cals[0]?.id || '', notice: 120, active: true });
    const set = x => setF({ ...f, ...x }), [tried, setTried] = useState(false), ok = f.title.trim() && f.minutes.length;
    return html`<div class="modal sm appt"><input type="text" class=${'ttl' + (tried && !f.title.trim() ? ' bad' : '')} placeholder="Meeting" value=${f.title} onInput=${e => set({ title: e.target.value })}/>
      <div class="box" style="margin-top:12px">
        <div class=${'cell ncell' + (tried && !f.minutes.length ? ' bad' : '')}><span>Lengths</span><div class="seg ch">${DURS.map(m => html`<button type="button" class=${f.minutes.includes(m) ? 'on' : ''} onClick=${() => set({ minutes: f.minutes.includes(m) ? f.minutes.filter(x => x !== m) : [...f.minutes, m].sort((a, b) => a - b) })}>${m < 60 ? m + 'm' : m / 60 + 'h'}</button>`)}</div></div>
        <div class="cell"><span>In</span><${SwitchN} opts=${hoursOpts()} value=${f.hours} set=${v => set({ hours: v })}/></div>
        <div class="cell"><span>Days ahead</span><input type="number" min="1" max="90" style="width:76px" value=${f.days} onInput=${e => set({ days: +e.target.value || 21 })}/></div>
        <div class="cell"><span>Notice</span><select value=${f.notice} onChange=${e => set({ notice: +e.target.value })}>${[[0, 'None'], [60, '1 hour'], [120, '2 hours'], [1440, '1 day'], [2880, '2 days']].map(([v, t]) => html`<option value=${v}>${t}</option>`)}</select></div>
        ${cals.length > 0 && html`<div class="cell"><span>Calendar</span><select value=${f.calendar_id} onChange=${e => set({ calendar_id: e.target.value })}><option value="">Smart Calendar only</option>${cals.map(c => html`<option value=${c.id}>${c.name}</option>`)}</select></div>`}
        <label class="cell"><span>Active</span><input type="checkbox" checked=${f.active} onChange=${e => set({ active: e.target.checked })}/></label>
      </div>
      <div class="acts">${l && html`<button class="danger" style="margin-right:auto" onClick=${() => close({ del: true })}>Delete</button>`}<button onClick=${() => close(null)}>Cancel</button>
        <button class=${'pri' + (ok ? '' : ' off')} onClick=${() => ok ? close(f) : setTried(true)}>${l ? 'Save' : 'Create'}</button></div></div>`; }; return html`<${B}/>`; });
  if (!r) return null;
  try {
    if (r.del) { if (!(await confirmDialog(`Delete “${l.title}”? The link stops working.`, 'Delete', true))) return null; await del('/api/booking-links/' + l.id); return true; }
    const body = { title: r.title.trim(), minutes: r.minutes, days: r.days, hours: r.hours, calendar_id: +r.calendar_id || null, notice: r.notice, active: r.active };
    return l ? await patch('/api/booking-links/' + l.id, body) : await post('/api/booking-links', body);
  } catch (e) { toast(e.message); return null; }
}

// a shared project: a time when the chosen members are all free (only that, nothing else of their calendars), booked for
// each of them; each one keeps or declines it in their notifications
export async function findTime(p) {
  const others = p.members.filter(m => m.id !== S.state.me.id);
  await openModal(close => { const B = () => {
    const [f, setF] = useState({ title: '', members: others.map(m => m.id), minutes: 60, hours: 'all', urgent: false }), set = x => setF({ ...f, ...x });
    const [slots, setSlots] = useState(null), [busy, setBusy] = useState(false), [tried, setTried] = useState(false);
    const find = async () => { setBusy(true); try { setSlots(await post(`/api/projects/${p.id}/slots`, { members: f.members, minutes: f.minutes, hours: f.hours, urgent: f.urgent, days: 14 })); } catch (e) { toast(e.message); } finally { setBusy(false); } };
    useEffect(() => { setSlots(null); }, [f.members.join(), f.minutes, f.hours, f.urgent]);
    const book = async x => {
      if (!f.title.trim()) return setTried(true);
      try { await post(`/api/projects/${p.id}/book`, { title: f.title.trim(), members: f.members, start: x.s, end: x.e }); await load(['plan']); toast(`Booked ${DN[new Date(x.s).getDay()]} ${hm(x.s)}`); close(true); } catch (e) { toast(e.message); find(); }
    };
    const days = []; for (const x of slots || []) { const k = new Date(x.s).toDateString(); let d = days.find(y => y.k === k); if (!d) days.push(d = { k, s: x.s, L: [] }); d.L.push(x); }
    return html`<div class="modal sm appt"><input type="text" class=${'ttl' + (tried && !f.title.trim() ? ' bad' : '')} placeholder="Title" value=${f.title} onInput=${e => setF({ ...f, title: e.target.value })}/>
      <div class="box" style="margin-top:12px">
        <div class="cell ncell"><span>With</span><div class="seg ch">${others.map(m => html`<button type="button" class=${f.members.includes(m.id) ? 'on' : ''} onClick=${() => set({ members: f.members.includes(m.id) ? f.members.filter(x => x !== m.id) : [...f.members, m.id] })}>${m.name}</button>`)}</div></div>
        <div class="cell"><span>Takes</span><${Duration} value=${f.minutes} set=${m => set({ minutes: m })}/></div>
        <div class="cell"><span>In</span><${SwitchN} opts=${hoursOpts()} value=${f.hours} set=${v => set({ hours: v })}/></div>
        <div class="cell"><span>When</span><${SwitchN} opts=${[[false, 'Best fit'], [true, 'Earliest']]} value=${f.urgent} set=${v => set({ urgent: v })}/></div>
      </div>
      ${slots == null ? html`<button class="pri wide" style="width:100%;margin-top:12px;justify-content:center" disabled=${busy || !f.members.length} onClick=${find}>Find Times</button>`
        : !slots.length ? html`<p class="hint" style="margin:12px 4px">No time when everyone is free</p>`
        : html`<div class="slots">${days.map(d => html`<div class="tday">${DN[new Date(d.s).getDay()]} ${SH(d.s)}</div><div class="srow">${d.L.map(x => html`<button class=${'slot ' + x.fit} title=${x.fit === 'best' ? 'Free for everyone' : 'Free; planned tasks move'} onClick=${() => book(x)}>${hm(x.s)}</button>`)}</div>`)}</div>`}
      <div class="acts"><button onClick=${() => close(null)}>Cancel</button></div></div>`; }; return html`<${B}/>`; });
}
