import { html, useState, S, api, post, patch, del, load, toast, openModal, confirmDialog, when, dh, DN, PRI, projectById, SH, n24, priColor, fromIso } from './lib.js';
import { I } from './icons.js';
import { moveDialog } from './now.js';
import { PlaceInput, googleCals } from './eventsheet.js';
let LOCS = null;

const DURS = [15, 30, 45, 60, 90, 120, 180];
const scheduleNames = () => Object.keys(S.state.settings?.hours || { work: 1, personal: 1 });
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// an appointment window, e.g. a practice open Mon–Fri 08:00–11:00: the task is planned in one piece inside it,
// as soon as possible, next to another appointment or about an hour before closing (meals give way)
function Window({ f, set }) {
  const w = f.meta?.win, setW = x => set({ meta: { ...(f.meta || {}), win: x } });
  const time = (k, ph) => html`<input class="t24" placeholder=${ph} value=${w?.[k] || ''} onChange=${e => {
    const v = n24(e.target.value), nw = { days: w?.days || [1, 2, 3, 4, 5], s: w?.s || '', e: w?.e || '', [k]: v || '' };
    setW(nw.s || nw.e ? nw : null); }}/>`;
  return html`<div style="display:grid;gap:8px"><div class="row" style="gap:6px">${time('s', '08:00')}–${time('e', '11:00')}${w && html`<button type="button" class="icon" title="Remove" onClick=${() => setW(null)}>${I('x', 14)}</button>`}</div>
    ${w && html`<div class="seg dows">${[1, 2, 3, 4, 5, 6, 0].map(d => html`<button type="button" class=${w.days.includes(d) ? 'on' : ''} onClick=${() => setW({ ...w, days: w.days.includes(d) ? w.days.filter(x => x !== d) : [...w.days, d] })}>${DN[d].slice(0, 2)}</button>`)}</div>`}</div>`;
}
export async function openTask(idOrNew, opts = {}) {
  let t = null;
  if (idOrNew && idOrNew !== 'new') {
    t = S.state.tasks.find(x => x.id === +idOrNew);
    if (!t) { try { t = (await api('/api/tasks')).find(x => x.id === +idOrNew); } catch {} }
    if (!t) return toast('Task not found');
  }
  if (!LOCS) { try { LOCS = (await api('/api/locations')).map(l => l.name); } catch { LOCS = []; } }
  return openModal(close => html`<${Editor} task=${t} opts=${opts} close=${close}/>`);
}

function Editor({ task, opts, close }) {
  const st = S.state, isNew = !task;
  const defProject = opts.project_id || (st.projects.find(p => p.name === 'Inbox' && p.owner_id === st.me.id) || st.projects[0] || {}).id;
  const [f, setF] = useState(() => task ? { ...task, recur: task.recur || null } : {
    title: opts.title || '', project_id: defProject, duration: st.settings?.dFree || 60, priority: 2, deadline: '', start_after: '', assignee_id: st.me.id,
    auto: true, schedule: null, recur: null, points: [], notes: '', min_chunk: null, assign_mode: 'fixed', parent_id: opts.parent_id || null, col: opts.col || 0, location: '', meta: {} });
  const [busy, setBusy] = useState(false), [more, setMore] = useState(!!task?.meta?.followups?.length);
  const set = p => setF(x => ({ ...x, ...p }));
  const proj = projectById(+f.project_id), members = proj?.members || [];
  const sch = task?.sched, r = f.recur;
  const setR = p => set({ recur: { freq: 'week', every: 1, days: [], window: 'any', ...(r || {}), ...p } });
  const period = sch?.period ?? task?.period ?? 0;

  const needPlace = proj?.places && !f.meta?.win && !proj.places.some(pl => pl.toLowerCase() === (f.location || '').toLowerCase());   // appointments have an address, not a chore place
  const save = async () => {
    if (!f.title.trim()) return;
    if (needPlace) return toast('Choose a place: ' + proj.places.join(', '));
    setBusy(true);
    try {
      const body = { title: f.title, notes: f.notes, project_id: +f.project_id, duration: +f.duration, priority: +f.priority, deadline: f.deadline || null, start_after: f.start_after || null,
        assignee_id: f.assignee_id ? +f.assignee_id : null, auto: !!f.auto, schedule: f.schedule || null, recur: f.recur, points: f.points.filter(p => p.t.trim()), min_chunk: f.min_chunk || null,
        assign_mode: f.assign_mode, parent_id: f.parent_id, col: f.col, location: f.location || null,
        meta: { ...(f.meta || {}), followups: (f.meta?.followups || []).filter(x => x.title?.trim()) } };
      if (LOCS && f.location && !LOCS.includes(f.location)) LOCS.push(f.location);
      const res = isNew ? await post('/api/tasks', body) : await patch('/api/tasks/' + task.id, body);
      await load(['tasks', 'plan']); close(res);
      if (isNew && res.sched?.first) toast(`Scheduled ${when(res.sched.first)}`);
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const act = async (fn, msg) => { try { await fn(); await load(['tasks', 'plan']); if (msg) toast(msg); close(true); } catch (e) { toast(e.message); } };

  const status = !task ? null : task.wait_event && task.status !== 'done' ? html`<div class="sched">${I('clock', 15)}Waiting for ${task.wait_event.replace(/_/g, ' ')}${task.wait_until ? ' · until ' + when(task.wait_until) : ''}
      <button class="ghost" onClick=${() => act(() => post(`/api/tasks/${task.id}/release`))}>Ready</button></div>`
    : task.status === 'done' ? html`<div class="sched">${I('check', 15)}Completed ${task.done_at ? when(task.done_at) : ''}</div>`
    : !task.auto ? html`<div class="sched">Not scheduled</div>`
    : sch?.first ? html`<div class=${'sched' + (sch.late ? ' late' : '')}>${I(sch.late ? 'warn' : 'calendar', 15)}${when(sch.first)}${sch.late ? ' · after deadline' : ''}${sch.user !== st.me.id ? ` · ${(st.users.find(u => u.id === sch.user) || {}).name || ''}` : ''}
      ${(st.plan?.moved || []).some(m => m.task_id === task.id) && html`<button class="ghost" onClick=${() => act(() => post(`/api/tasks/${task.id}/auto`), 'Auto-scheduled')}>Auto-schedule</button>`}</div>`
    : html`<div class="sched late">${I('warn', 15)}No free time available</div>`;

  return html`<div class="modal tedit" onKeyDown=${e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save(); }}>
    <input class="ttl" placeholder="Title" value=${f.title} onInput=${e => set({ title: e.target.value })} onKeyDown=${e => { if (e.key === 'Enter' && isNew) save(); }}/>
    ${status}
    <div class="grid">
      <label>Project</label>
      <select value=${f.project_id} onChange=${e => set({ project_id: +e.target.value, parent_id: null })}>${st.projects.filter(p => !p.archived).map(p => html`<option value=${p.id}>${p.name}</option>`)}</select>
      <label>Duration</label>
      <div class="row"><div class="seg">${DURS.map(d => html`<button type="button" class=${+f.duration === d ? 'on' : ''} onClick=${() => set({ duration: d })}>${d < 60 ? d + 'm' : d / 60 + 'h'}</button>`)}</div>
        ${!DURS.includes(+f.duration) && html`<span class="hint">${dh(f.duration)}</span>`}</div>
      <label>Priority</label>
      <div class="seg">${[3, 2, 1, 0].map(i => html`<button type="button" class=${+f.priority === i ? 'on' : ''} style=${+f.priority === i ? { background: priColor(i), color: '#fff' } : null} onClick=${() => set({ priority: i })}>${PRI[i]}</button>`)}</div>
      ${f.deadline && +f.priority > 0 && !(proj && (proj.meta?.ordered ?? proj.kind === 'outline')) && html`<div class="rise row" style="gap:6px;font-size:12px;color:var(--muted)"><i style=${{ display: 'inline-block', width: '44px', height: '6px', borderRadius: '3px', background: `linear-gradient(90deg,${priColor(+f.priority)},${priColor(0)})` }}></i>ASAP by ${DN[new Date(fromIso(f.deadline)).getDay()]} ${SH(fromIso(f.deadline))}</div>`}
      <label>Location</label>
      ${proj?.places ? html`<div class="seg">${proj.places.map(pl => html`<button type="button" class=${(f.location || '').toLowerCase() === pl.toLowerCase() ? 'on' : ''} onClick=${() => set({ location: pl })}>${pl}</button>`)}</div>` : S.state.maps ? html`<${PlaceInput} value=${f.location || ''} placeholder="None" onChange=${v => set({ location: v })} onTravel=${m => set({ meta: { ...(f.meta || {}), travel: m || undefined } })} travel=${f.meta?.travel || 0}/>`
      : html`<div><input list="sc-locs" placeholder="None" value=${f.location || ''} onInput=${e => set({ location: e.target.value })} style="width:220px"/>
        <datalist id="sc-locs">${(LOCS || []).map(l => html`<option value=${l}/>`)}</datalist></div>`}
      <label>Due</label>
      <div class="row"><input type="date" value=${f.deadline || ''} onInput=${e => set({ deadline: e.target.value })}/>${f.deadline && html`<button class="icon" title="Clear" onClick=${() => set({ deadline: '' })}>${I('x', 14)}</button>`}</div>
      ${members.length > 1 && html`<label>Assignee</label>
        <div class="row"><select value=${f.assignee_id || ''} onChange=${e => set({ assignee_id: +e.target.value || null })} disabled=${r && f.assign_mode === 'rotate'}>${members.map(m => html`<option value=${m.id}>${m.name}</option>`)}</select>
          ${r && html`<label class="row" style="gap:6px"><input type="checkbox" class="sq" checked=${f.assign_mode === 'rotate'} onChange=${e => set({ assign_mode: e.target.checked ? 'rotate' : 'fixed' })}/>Take turns</label>`}</div>`}
      <label>Repeat</label>
      <div class="row">
        <select value=${r ? r.freq : ''} onChange=${e => e.target.value ? setR({ freq: e.target.value }) : set({ recur: null })}>
          <option value="">Never</option><option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option></select>
        ${r && html`<span class="hint">every</span><input type="number" min="1" max="52" value=${r.every || 1} style="width:56px" onInput=${e => setR({ every: +e.target.value || 1 })}/>
          <span class="hint">${{ day: 'days', week: 'weeks', month: 'months' }[r.freq]}</span>`}
      </div>
      ${r && html`<label>On</label>
        <div class="row"><div class="seg dows">${[1, 2, 3, 4, 5, 6, 0].map(d => html`<button type="button" class=${(r.days || []).includes(d) ? 'on' : ''} onClick=${() => setR({ days: (r.days || []).includes(d) ? r.days.filter(x => x !== d) : [...(r.days || []), d] })}>${DN[d].slice(0, 2)}</button>`)}</div>
          <select value=${r.window || 'any'} onChange=${e => setR({ window: e.target.value })}><option value="any">Any time</option><option value="morning">Morning</option><option value="afternoon">Afternoon</option><option value="evening">Evening</option></select></div>`}
      ${more && html`
        <label>Start after</label><input type="date" value=${f.start_after || ''} onInput=${e => set({ start_after: e.target.value })}/>
        <label>Between</label><${Window} f=${f} set=${set}/>
        ${googleCals().length > 0 && html`<label>Calendar</label><select value=${f.meta?.calendarId || ''} onChange=${e => set({ meta: { ...(f.meta || {}), calendarId: +e.target.value || undefined } })}>
          <option value="">Project calendar</option>${googleCals().map(c => html`<option value=${c.id}>${c.name}</option>`)}</select>`}
        <label>Hours</label>
        <select value=${f.schedule || ''} onChange=${e => set({ schedule: e.target.value || null })}>
          <option value="">${cap(proj?.schedule || 'work')} (project)</option>${scheduleNames().map(n => html`<option value=${n}>${cap(n)}</option>`)}</select>
        <label>Min. block</label><div class="row"><input type="number" min="5" step="5" placeholder=${S.state.settings?.chunk || 30} value=${f.min_chunk || ''} style="width:76px" onInput=${e => set({ min_chunk: +e.target.value || null })}/><span class="hint">min</span></div>
        <label>Schedule</label><label class="row" style="gap:8px"><input type="checkbox" class="sq" checked=${f.auto} onChange=${e => set({ auto: e.target.checked })}/>Automatically</label>
        <label style="align-self:start;padding-top:8px">Then</label><${Followups} f=${f} set=${set}/>`}
    </div>
    ${!more && html`<button class="ghost" style="margin:-6px 0 8px" onClick=${() => setMore(true)}>More Options</button>`}
    <ul class="pts">${f.points.map((p, i) => html`<li class=${p.done ? 'ok' : ''}><input type="checkbox" checked=${p.done} onChange=${e => set({ points: f.points.map((q, j) => j === i ? { ...q, done: e.target.checked } : q) })}/>
      <input type="text" value=${p.t} onInput=${e => set({ points: f.points.map((q, j) => j === i ? { ...q, t: e.target.value } : q) })}/>
      <button class="sk" onClick=${() => set({ points: f.points.filter((q, j) => j !== i) })}>${I('x', 14)}</button></li>`)}
      <li><button class="ghost" style="padding-left:0" onClick=${() => set({ points: [...f.points, { t: '', done: false }] })}>${I('plus', 16)}Checklist Item</button></li></ul>
    <textarea placeholder="Notes" value=${f.notes} onInput=${e => set({ notes: e.target.value })}></textarea>
    <div class="acts">
      ${task && html`<button class="icon" style="margin-right:auto;color:var(--late)" title="Delete" onClick=${async () => { if (await confirmDialog(`Delete “${task.title}”?`, 'Delete', true)) act(() => del('/api/tasks/' + task.id)); }}>${I('trash')}</button>`}
      ${task && task.status !== 'done' && html`
        <button onClick=${() => act(() => post('/api/timer/start', { task: task.id, period }))}>${I('play', 15)}Start</button>
        <button onClick=${() => { close(null); moveDialog({ taskId: task.id, period, title: task.title, recur: !!task.recur }); }}>Postpone</button>
        <button onClick=${() => act(() => post(`/api/tasks/${task.id}/done`, { period, done: true }), 'Completed')}>${I('check', 15, { w: 2.2 })}Done</button>`}
      ${task && task.status === 'done' && html`<button onClick=${() => act(() => post(`/api/tasks/${task.id}/done`, { done: false }))}>Reopen</button>`}
      <button class="pri" disabled=${busy || !f.title.trim() || needPlace} onClick=${save}>${isNew ? 'Add' : 'Save'}</button>
    </div>
  </div>`;
}

// follow-up steps created when this task is done: after a delay and/or when an event arrives (Home Assistant)
function Followups({ f, set }) {
  const L = f.meta?.followups || [];
  const upd = (i, p) => set({ meta: { ...(f.meta || {}), followups: L.map((x, j) => j === i ? { ...x, ...p } : x) } });
  return html`<div style="display:grid;gap:8px">
    ${L.map((x, i) => html`<div class="row" style="gap:6px">
      <input placeholder="Title" value=${x.title} style="flex:1;min-width:140px" onInput=${e => upd(i, { title: e.target.value })}/>
      <input type="number" min="0" step="5" title="After minutes" value=${x.after || ''} placeholder="after" style="width:76px" onInput=${e => upd(i, { after: +e.target.value || 0 })}/><span class="hint">min</span>
      <input placeholder="or event" title="Home Assistant event, e.g. washer_done" value=${x.event || ''} style="width:120px" onInput=${e => upd(i, { event: e.target.value.trim().toLowerCase().replace(/\s+/g, '_') })}/>
      <button class="icon" onClick=${() => set({ meta: { ...(f.meta || {}), followups: L.filter((_, j) => j !== i) } })}>${I('x', 14)}</button></div>`)}
    <button class="ghost" style="justify-self:start;padding-left:0" onClick=${() => set({ meta: { ...(f.meta || {}), followups: [...L, { title: '', after: 0, event: '', duration: 10 }] } })}>${I('plus', 15)}Follow-up</button>
  </div>`;
}
