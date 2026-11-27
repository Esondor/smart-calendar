import { html, useState, S, api, post, patch, del, load, toast, openModal, confirmDialog, when, dh, DN, PRI, projectById, SH, n24, priColor, fromIso, isoDate, hm } from './lib.js';
import { I } from './icons.js';
import { moveDialog } from './now.js';
import { PlaceInput, googleCals, SwitchN, hoursOpts, atTime } from './eventsheet.js';
let LOCS = null;

const DURS = [15, 30, 45, 60, 90, 120, 180];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

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
  // start and due: a day and, if given, a time (kept in meta.from / meta.due); a new task starts now
  const tOf = (d, ms) => d && +ms && isoDate(+ms) === d ? hm(+ms) : '';
  const now5 = Math.ceil(Date.now() / 300000) * 300000;
  const [f, setF] = useState(() => task ? { ...task, recur: task.recur || null, st: tOf(task.start_after, task.meta?.from), dt: tOf(task.deadline, task.meta?.due), win: !!task.meta?.win } : {
    title: opts.title || '', project_id: defProject, duration: st.settings?.dFree || 60, priority: 2, deadline: '', start_after: isoDate(now5), st: hm(now5), dt: '', assignee_id: st.me.id, win: false,
    auto: true, schedule: null, recur: null, points: [], notes: '', min_chunk: null, assign_mode: 'fixed', parent_id: opts.parent_id || null, col: opts.col || 0, location: '', meta: {} });
  const [busy, setBusy] = useState(false);
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
        meta: { ...(f.meta || {}), followups: (f.meta?.followups || []).filter(x => x.title?.trim()),
          from: f.start_after && f.st ? atTime(f.start_after, f.st) : undefined, due: f.deadline && f.dt ? atTime(f.deadline, f.dt) : undefined, win: f.win ? f.meta?.win || null : undefined } };
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
    <div class="box appt">
      <div class="cell"><span>Project</span><select value=${f.project_id} onChange=${e => set({ project_id: +e.target.value, parent_id: null })}>${st.projects.filter(p => !p.archived).map(p => html`<option value=${p.id}>${p.name}</option>`)}</select></div>
      <div class="cell two"><div><span class="lbl">Start</span><div class="dt">${f.start_after ? html`<input type="date" value=${f.start_after} onInput=${e => set({ start_after: e.target.value })}/><div class="tm"><input class="t24" value=${f.st} placeholder="--:--" onChange=${e => set({ st: n24(e.target.value) || '' })}/></div>`
          : html`<button type="button" class="none" onClick=${() => set({ start_after: isoDate(Date.now()), st: hm(Math.ceil(Date.now() / 300000) * 300000) })}>Now</button>`}</div></div>
        <div><span class="lbl">Due</span><div class="dt">${f.deadline ? html`<input type="date" value=${f.deadline} min=${f.start_after || ''} onInput=${e => set({ deadline: e.target.value })}/><div class="tm"><input class="t24" value=${f.dt} placeholder="--:--" onChange=${e => set({ dt: n24(e.target.value) || '' })}/><button type="button" class="icon" title="No due date" onClick=${() => set({ deadline: '', dt: '' })}>${I('x', 14)}</button></div>`
          : html`<button type="button" class="none" onClick=${() => set({ deadline: f.start_after || isoDate(Date.now()) })}>None</button>`}</div></div></div>
      <div class="cell"><span>Takes</span><span class="stepper"><button type="button" class="mn" title="Less" onClick=${() => set({ duration: Math.max(5, +f.duration - (+f.duration > 15 ? 15 : 5)) })}></button><b>${dh(+f.duration)}</b><button type="button" class="pl" title="More" onClick=${() => set({ duration: Math.min(24 * 60, +f.duration + 15) })}></button></span></div>
      <label class="cell"><span>Certain time window</span><input type="checkbox" checked=${f.win} onChange=${e => set({ win: e.target.checked, meta: { ...(f.meta || {}), win: e.target.checked ? f.meta?.win || { days: [1, 2, 3, 4, 5], s: '08:00', e: '11:00' } : null } })}/></label>
      ${f.win && f.meta?.win ? html`<div class="cell"><span>Between</span><span class="row" style="gap:6px;flex:none">${['s', 'e'].map((k, n) => html`${n ? '–' : ''}<input class="t24" value=${f.meta.win[k]} onChange=${e => set({ meta: { ...f.meta, win: { ...f.meta.win, [k]: n24(e.target.value) || f.meta.win[k] } } })}/>`)}</span></div>
        <div class="cell"><div class="seg days">${[1, 2, 3, 4, 5, 6, 0].map(d => html`<button type="button" class=${f.meta.win.days.includes(d) ? 'on' : ''} onClick=${() => set({ meta: { ...f.meta, win: { ...f.meta.win, days: f.meta.win.days.includes(d) ? f.meta.win.days.filter(x => x !== d) : [...f.meta.win.days, d] } } })}>${DN[d].slice(0, 2)}</button>`)}</div></div>`
      : html`<div class="cell"><span>In</span><${SwitchN} opts=${hoursOpts()} value=${f.schedule || proj?.schedule || 'work'} set=${v => set({ schedule: v })}/></div>`}
      ${(() => { const ord = proj && (proj.meta?.ordered ?? proj.kind === 'outline');
        return html`<div class="cell ncell"><span>Priority</span><div class="seg ch pri">${[3, 2, 1, 0].map(i => html`<button type="button" class=${+f.priority === i ? 'on' : ''} style=${+f.priority === i ? { background: priColor(i), color: '#fff' } : null} onClick=${() => set({ priority: i })}>${PRI[i]}</button>`)}</div></div>
        ${f.deadline && +f.priority > 0 && !ord && html`<div class="cell rise"><span></span><span class="row" style="gap:6px"><i style=${{ background: `linear-gradient(90deg,${priColor(+f.priority)},${priColor(0)})` }}></i>ASAP by ${DN[new Date(fromIso(f.deadline)).getDay()]} ${SH(fromIso(f.deadline))}${f.dt ? ', ' + f.dt : ''}</span></div>`}`; })()}
      <div class="cell"><span>Repeat</span><span class="row" style="gap:6px;flex:none">
        <select value=${r ? r.freq : ''} onChange=${e => e.target.value ? setR({ freq: e.target.value }) : set({ recur: null })}>
          <option value="">Never</option><option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option></select>
        ${r && html`<span class="hint">every</span><input type="number" min="1" max="52" value=${r.every || 1} style="width:56px" onInput=${e => setR({ every: +e.target.value || 1 })}/>
          <span class="hint">${{ day: 'days', week: 'weeks', month: 'months' }[r.freq]}</span>`}</span></div>
      ${r && html`<div class="cell"><div class="seg dows">${[1, 2, 3, 4, 5, 6, 0].map(d => html`<button type="button" class=${(r.days || []).includes(d) ? 'on' : ''} onClick=${() => setR({ days: (r.days || []).includes(d) ? r.days.filter(x => x !== d) : [...(r.days || []), d] })}>${DN[d].slice(0, 2)}</button>`)}</div>
          <select value=${r.window || 'any'} onChange=${e => setR({ window: e.target.value })}><option value="any">Any time</option><option value="morning">Morning</option><option value="afternoon">Afternoon</option><option value="evening">Evening</option></select></div>`}
      ${members.length > 1 && html`<div class="cell"><span>Assignee</span><span class="row" style="gap:8px;flex:none"><select value=${f.assignee_id || ''} onChange=${e => set({ assignee_id: +e.target.value || null })} disabled=${r && f.assign_mode === 'rotate'}>${members.map(m => html`<option value=${m.id}>${m.name}</option>`)}</select>
          ${r && html`<label class="row" style="gap:6px"><input type="checkbox" class="sq" checked=${f.assign_mode === 'rotate'} onChange=${e => set({ assign_mode: e.target.checked ? 'rotate' : 'fixed' })}/>Take turns</label>`}</span></div>`}
      <div class="cell"><span>Place</span>${proj?.places ? html`<div class="seg">${proj.places.map(pl => html`<button type="button" class=${(f.location || '').toLowerCase() === pl.toLowerCase() ? 'on' : ''} onClick=${() => set({ location: pl })}>${pl}</button>`)}</div>`
        : S.state.maps ? html`<${PlaceInput} value=${f.location || ''} placeholder="None" onChange=${v => set({ location: v })}/>`
        : html`<span><input list="sc-locs" placeholder="None" value=${f.location || ''} onInput=${e => set({ location: e.target.value })} style="width:200px"/><datalist id="sc-locs">${(LOCS || []).map(l => html`<option value=${l}/>`)}</datalist></span>`}</div>
      ${googleCals().length > 0 && html`<div class="cell"><span>Calendar</span><select value=${f.meta?.calendarId || ''} onChange=${e => set({ meta: { ...(f.meta || {}), calendarId: +e.target.value || undefined } })}>
          <option value="">Project calendar</option>${googleCals().map(c => html`<option value=${c.id}>${c.name}</option>`)}</select></div>`}
      <label class="cell"><span>Plan automatically</span><input type="checkbox" checked=${f.auto} onChange=${e => set({ auto: e.target.checked })}/></label>
      <div class="cell"><span>Smallest block</span><span class="row" style="gap:6px;flex:none"><input type="number" min="5" step="5" placeholder=${S.state.settings?.chunk || 30} value=${f.min_chunk || ''} style="width:76px" onInput=${e => set({ min_chunk: +e.target.value || null })}/><span class="hint">min</span></span></div>
      <div class="cell" style="align-items:start"><span style="padding-top:8px">Then</span><${Followups} f=${f} set=${set}/></div>
    </div>
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
