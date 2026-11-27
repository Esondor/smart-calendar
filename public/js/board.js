import { html, useState, useEffect, S, api, post, patch, del, load, toast, openModal, confirmDialog, when, dh, Avatar, recurText, SH, fromIso, go, InviteBox } from './lib.js';
import { openTask } from './taskedit.js';
import { I } from './icons.js';
import OutlineView from './outline.js';
import ProjectFocus from './pfocus.js';
import OrderView from './order.js';
import { TeamButton } from './team.js';
import { isLeaf } from './tasks.js';

const COLORS = ['#1971c2', '#0f5f5c', '#c2255c', '#e8590c', '#7048e8', '#2b8a3e', '#e67700', '#0c8599', '#868e96'];

export const writableCals = () => S.state.accounts.filter(a => a.kind === 'google').flatMap(a => a.calendars.filter(c => c.writable));
// project → calendar (per user); shared = every member writes into the same Google calendar
export async function setProjectCalendar(p, cal, shared, name) {
  const r = await post(`/api/projects/${p.id}/calendar`, { calendar: cal || null, shared: !!shared, name: name || p.name });
  S.set({ settings: r.settings });
  if (r.missing?.length) toast(`${r.missing.join(', ')}: connect Google to share`, 5000);
  load(['accounts', 'projects', 'plan']);
  return r;
}
export function CalendarSelect({ value, onChange, name }) {
  const cals = writableCals(), def = S.state.settings?.plan?.calendarId;
  return html`<select value=${value} onChange=${e => onChange(e.target.value)}>
    <option value="">${(cals.find(c => c.id === def) || {}).name || 'Plan calendar'}</option>
    ${cals.filter(c => c.id !== def).map(c => html`<option value=${c.id}>${c.name}</option>`)}
    <option value="new">New Calendar “${name}”</option></select>`;
}
export async function projectSettings(p) {
  const r = await openModal(close => { const B = () => {
    const [f, setF] = useState(p ? { ...p, columns: p.columns.join(', '), wall: p.meta?.wall ?? p.schedule === 'personal', ordered: p.meta?.ordered ?? p.kind === 'outline', places: (p.places || []).join(', '), levels: (p.meta?.levels || []).join(', '), cal: String(S.state.settings?.plan?.projectCalendars?.[p.id] || ''), shared: !!p.meta?.sharedCal } : { name: '', color: '#1971c2', kind: 'board', schedule: 'personal', columns: 'To do, In progress, Done', target_date: '', wall: true, ordered: false });
    const set = x => setF(y => ({ ...y, ...x })), sch = Object.keys(S.state.settings?.hours || {});
    return html`<div class="modal sm"><h3>${p ? 'Project' : 'New Project'}</h3>
      <div style="display:grid;gap:10px">
        <input type="text" placeholder="Name" value=${f.name} onInput=${e => set({ name: e.target.value })}/>
        <div class="row">${COLORS.map(c => html`<button type="button" style=${{ background: c, width: '26px', height: '26px', padding: 0, borderRadius: '6px', outline: f.color === c ? '3px solid var(--ink)' : 'none' }} onClick=${() => set({ color: c })}></button>`)}</div>
        ${html`<label class="row"><span class="hint" style="width:110px">Layout</span><div class="seg"><button type="button" class=${f.kind === 'board' ? 'on' : ''} onClick=${() => set({ kind: 'board' })}>Board</button><button type="button" class=${f.kind === 'outline' ? 'on' : ''} onClick=${() => set({ kind: 'outline' })}>Outline</button></div></label>`}
        <label class="row"><span class="hint" style="width:110px">Hours</span><div class="seg">${sch.map(n => html`<button type="button" class=${f.schedule === n ? 'on' : ''} onClick=${() => set({ schedule: n })}>${n.charAt(0).toUpperCase() + n.slice(1)}</button>`)}</div></label>
        <label class="row"><span class="hint" style="width:110px">Columns</span><input type="text" class="grow" value=${f.columns} onInput=${e => set({ columns: e.target.value })}/></label>
        <label class="row"><span class="hint" style="width:110px">Target</span><input type="date" value=${f.target_date || ''} onInput=${e => set({ target_date: e.target.value })}/></label>
        <label class="row"><span class="hint" style="width:110px">Wall display</span><input type="checkbox" checked=${f.wall} onChange=${e => set({ wall: e.target.checked })}/></label>
        ${f.kind === 'outline' && html`<label class="row"><span class="hint" style="width:110px">Levels</span><input type="text" class="grow" placeholder=${p?.meta?.groups ? 'Chapter, Section' : 'Category, Section'} value=${f.levels || ''} onInput=${e => set({ levels: e.target.value })}/></label>`}
        <label class="row"><span class="hint" style="width:110px">Places</span><input type="text" class="grow" placeholder="Keller, Garage, Wohnung" value=${f.places || ''} onInput=${e => set({ places: e.target.value })}/></label>
        <label class="row"><span class="hint" style="width:110px">Keep order</span><input type="checkbox" checked=${f.ordered} onChange=${e => set({ ordered: e.target.checked })}/></label>
        ${p && writableCals().length > 0 && html`<label class="row"><span class="hint" style="width:110px">Calendar</span><${CalendarSelect} value=${f.cal} name=${f.name || p.name} onChange=${v => set({ cal: v })}/></label>
          ${p.members.length > 1 && f.cal && html`<label class="row"><span class="hint" style="width:110px">Shared</span><input type="checkbox" checked=${f.shared} onChange=${e => set({ shared: e.target.checked })}/></label>`}`}
      </div>
      <div class="acts">${p && html`<button class="danger" style="margin-right:auto" onClick=${() => close({ delete: true })}>${p.owner_id === S.state.me.id ? 'Delete' : 'Leave'}</button>`}
        ${p && html`<button onClick=${() => close({ ...f, archived: !p.archived })}>${p.archived ? 'Unarchive' : 'Archive'}</button>`}
        <button onClick=${() => close(null)}>Cancel</button><button class="pri" onClick=${() => close(f)}>${p ? 'Save' : 'Create'}</button></div></div>`; }; return html`<${B}/>`; });
  if (!r) return;
  try {
    if (r.delete) { if (!(await confirmDialog(p.owner_id === S.state.me.id ? `Delete “${p.name}” with all its tasks for everyone?` : `Leave “${p.name}”?`, 'Yes', true))) return; await del('/api/projects/' + p.id); go('#/tasks'); }
    else {
      const body = { name: r.name || 'Project', color: r.color, schedule: r.schedule, columns: String(r.columns).split(',').map(x => x.trim()).filter(Boolean), target_date: r.target_date || null, kind: r.kind, meta: { ...(p?.meta || {}), wall: !!r.wall, ordered: !!r.ordered, places: String(r.places || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 12), levels: String(r.levels || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 2), ...(r.shared ? {} : { sharedCal: undefined }) }, ...('archived' in r ? { archived: r.archived } : {}) };
      const np = p ? await patch('/api/projects/' + p.id, body) : await post('/api/projects', body);
      if (p && (r.cal !== String(S.state.settings?.plan?.projectCalendars?.[p.id] || '') || (r.shared && !p.meta?.sharedCal))) await setProjectCalendar(p, r.cal, r.shared && r.cal, r.name);
      if (!p) go('#/project/' + np.id);
    }
    await load(['projects', 'tasks', 'plan']);
  } catch (e) { toast(e.message); }
}
async function share(p) {
  const u = await openModal(close => { const B = () => { const [v, setV] = useState(''), [n, setN] = useState('');
    const others = S.state.users.filter(x => !p.members.some(m => m.id === x.id));
    return html`<div class="modal sm"><h3>Share “${p.name}”</h3>
      <ul class="feed">${p.members.map(m => html`<li><${Avatar} id=${m.id}/> <span class="grow">${m.name}${m.role === 'owner' ? html` <span class="hint">Owner</span>` : ''}</span>
        ${m.role !== 'owner' && (p.owner_id === S.state.me.id || m.id === S.state.me.id) ? html`<button class="sk" onClick=${() => close({ remove: m.id })}>Remove</button>` : ''}</li>`)}</ul>
      ${others.length ? html`<div class="row" style="margin-top:10px"><select class="grow" value=${v} onChange=${e => setV(e.target.value)}><option value="">Add Person</option>${others.map(o => html`<option value=${o.id}>${o.name} (@${o.username})</option>`)}</select>
        <button class="pri" disabled=${!v} onClick=${() => close({ add: +v })}>Add</button></div>` : ''}
      <div class="row" style="margin-top:10px"><input type="text" class="grow" placeholder="Username" value=${n} onInput=${e => setN(e.target.value)} onKeyDown=${e => e.key === 'Enter' && n.trim() && close({ username: n.trim() })}/>
        <button disabled=${!n.trim()} onClick=${() => close({ username: n.trim() })}>Add</button></div>
      <div class="box" style="margin:14px 0 0"><${InviteBox} project=${p}/></div>
      <div class="acts"><button onClick=${() => close(null)}>Close</button></div></div>`; }; return html`<${B}/>`; });
  if (!u) return;
  try { if (u.add) await post(`/api/projects/${p.id}/members`, { user_id: u.add }); if (u.username) await post(`/api/projects/${p.id}/members`, { username: u.username }); if (u.remove) await del(`/api/projects/${p.id}/members/${u.remove}`); await load(['boot', 'projects', 'tasks', 'plan']); } catch (e) { toast(e.message); }
}

function Card({ t, cols, onDragStart }) {
  const s = t.sched, roundDone = t.recur && (t.occ || []).some(o => o.period === t.period && o.status === 'done');
  const done = t.status === 'done' || roundDone;
  const check = async e => { e.stopPropagation(); try { await post(`/api/tasks/${t.id}/done`, { period: roundDone ? t.period : (s?.period ?? t.period ?? 0), done: !done }); await load(['tasks', 'plan']); } catch (x) { toast(x.message); } };
  const next = async e => { e.stopPropagation(); await patch('/api/tasks/' + t.id, { col: Math.min(cols - 1, t.col + 1) }); load(['tasks', 'plan']); };
  return html`<div class=${'card' + (done ? ' done' : '')} draggable="true" onDragStart=${e => onDragStart(e, t)} onClick=${() => openTask(t.id)}>
    <div class="ct"><input type="checkbox" checked=${done} onClick=${check}/><span>${t.title}</span><span class=${'flag p' + t.priority}></span></div>
    <div class="cm">
      ${t.recur && html`<span class="chip">${I('repeat', 12)}${recurText(t.recur).replace(/^every /, '')}</span>`}
      <span class="chip">${dh(t.duration)}</span>
      ${t.deadline && html`<span class=${'chip' + (s?.late ? ' late' : '')}>Due ${SH(fromIso(t.deadline))}</span>`}
      ${roundDone ? html`<span class="chip ok">Done this time</span>` : s?.first ? html`<span class=${'chip' + (s.late ? ' late' : '')}>${when(s.first)}</span>` : t.status !== 'done' && !t.auto ? html`<span class="chip">Later</span>` : ''}
      <span class="grow"></span>${(s?.user || t.assignee_id) && html`<${Avatar} id=${s?.user || t.assignee_id}/>`}
      ${!t.recur && t.col < cols - 1 && html`<button class="sk" title="Move right" onClick=${next}>${I('right', 14)}</button>`}
    </div></div>`;
}

// whole-project progress (by planned time) and the projected end, against the target date
function Progress({ p }) {
  const st = S.state, L = st.tasks.filter(t => t.project_id === p.id && isLeaf(t) && !['chapter', 'section'].includes(t.meta?.level));
  if (!L.length) return null;
  const tot = L.reduce((a, t) => a + (t.duration || 0), 0) || 1, dn = L.filter(t => t.status === 'done').reduce((a, t) => a + (t.duration || 0), 0) + L.filter(t => t.status !== 'done').reduce((a, t) => a + Math.min(t.spent || 0, t.duration || 0), 0);
  const pct = Math.round(100 * dn / tot), end = st.plan?.projectEnds?.[p.id], tgt = p.target_date ? fromIso(p.target_date) : null, late = end && tgt && end > tgt + 864e5;
  const day = ms => { const d = new Date(ms); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${SH(ms)}`; };
  return html`<div class="pprog" title=${`${L.filter(t => t.status === 'done').length} of ${L.length} tasks done`}>
    <div class="pbar" role="progressbar" aria-valuenow=${pct} aria-valuemin="0" aria-valuemax="100"><i style=${{ width: pct + '%' }}></i></div><b class="pct">${pct}%</b>
    ${end ? html`<span>Ends <b class=${late ? 'late' : ''}>${day(end)}</b></span>` : L.every(t => t.status === 'done') ? html`<span>Done</span>` : ''}
    ${tgt && html`<span class="hint">Target ${SH(tgt)}</span>`}</div>`;
}

export default function ProjectView({ id }) {
  const st = S.state, p = st.projects.find(x => x.id === +id);
  const [feed, setFeed] = useState(null), [over, setOver] = useState(-1);
  useEffect(() => { if (feed) api('/api/activity?project=' + id).then(setFeed).catch(() => {}); }, [st.tasks]);
  const [view, setView] = useState(() => { try { return localStorage.getItem('pv-' + id) || 'overview'; } catch { return 'overview'; } });
  if (!p) return html`<div class="empty">Project not found.</div>`;
  const pick = v => { setView(v); try { localStorage.setItem('pv-' + id, v); } catch {} };
  const seg = html`<div class="seg pvseg"><button class=${view === 'overview' ? 'on' : ''} onClick=${() => pick('overview')}>Overview</button><button class=${view === 'detail' || (view === 'order' && p.kind !== 'outline') ? 'on' : ''} onClick=${() => pick('detail')}>${p.kind === 'outline' ? 'Outline' : 'Board'}</button>${p.kind === 'outline' && html`<button class=${view === 'order' ? 'on' : ''} onClick=${() => pick('order')}>Order</button>`}</div>`;
  if (view === 'overview') return html`<div class="pvwrap"><div class="ptools">${seg}<${Progress} p=${p}/><span class="grow"></span>
    <span class="avs">${p.members.map(m => html`<${Avatar} id=${m.id}/>`)}</span><${TeamButton} p=${p}/><button class="icon" title="Share" aria-label="Share" onClick=${() => share(p)}>${I('people')}</button><button class="icon" title="Project Settings" onClick=${() => projectSettings(p)}>${I('gear')}</button></div><${ProjectFocus} p=${p}/></div>`;
  if (p.kind === 'outline' && view === 'order') return html`<div class="pvwrap"><div class="ptools">${seg}<${Progress} p=${p}/><span class="grow"></span><${TeamButton} p=${p}/></div><${OrderView} p=${p}/></div>`;
  if (p.kind === 'outline') return html`<div class="pvwrap"><div class="ptools">${seg}<${Progress} p=${p}/><span class="grow"></span><${TeamButton} p=${p}/></div><${OutlineView} p=${p}/></div>`;
  const tasks = st.tasks.filter(t => t.project_id === p.id && isLeaf(t));
  const cols = p.columns.length ? p.columns : ['To do', 'Done'];
  const byCol = cols.map((_, i) => tasks.filter(t => (t.status === 'done' && !t.recur ? cols.length - 1 : Math.min(t.col, cols.length - 1)) === i).sort((a, b) => a.sort - b.sort || (a.sched?.first || Infinity) - (b.sched?.first || Infinity)));
  const onDragStart = (e, t) => { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; };
  const drop = async (e, ci) => {
    e.preventDefault(); setOver(-1);
    const tid = +e.dataTransfer.getData('text/plain'), t = tasks.find(x => x.id === tid); if (!t) return;
    const cards = [...e.currentTarget.querySelectorAll('.card')], y = e.clientY;
    const idx = cards.findIndex(c => c.getBoundingClientRect().top + c.offsetHeight / 2 > y);
    const L = byCol[ci].filter(x => x.id !== tid), before = L[idx < 0 ? L.length : idx], after = L[(idx < 0 ? L.length : idx) - 1];
    const sort = before && after ? (before.sort + after.sort) / 2 : before ? before.sort - 1 : after ? after.sort + 1 : 0;
    try { await patch('/api/tasks/' + tid, { col: ci, sort }); await load(['tasks', 'plan']); } catch (x) { toast(x.message); }
  };
  return html`<div style="display:flex;flex-direction:column;height:100%">
    <div class="ptools">${seg}<${Progress} p=${p}/>
      <span class="avs">${p.members.map(m => html`<${Avatar} id=${m.id}/>`)}</span>
      <${TeamButton} p=${p}/>
      <button class="icon" title="Share" aria-label="Share" onClick=${() => share(p)}>${I('people')}</button>
      <button class="icon" title="Project Settings" onClick=${() => projectSettings(p)}>${I('gear')}</button>
      <button onClick=${async () => setFeed(feed ? null : await api('/api/activity?project=' + id))}>${feed ? 'Hide' : 'Activity'}</button>
      ${p.ext_source === 'vikunja' ? html`<span class="hint">Vikunja</span>` : ''}
      <span class="grow"></span>
    </div>
    ${feed && html`<div class="box" style="margin:10px 16px 0;max-height:200px;overflow:auto"><ul class="feed">${feed.map(a => html`<li><time>${when(a.at)}</time><b>${a.user_name || ''}</b> <span>${a.text}</span></li>`)}</ul></div>`}
    <div class="board">${cols.map((c, ci) => html`<div class=${'colm' + (over === ci ? ' over' : '')} onDragOver=${e => { e.preventDefault(); setOver(ci); }} onDragLeave=${() => setOver(-1)} onDrop=${e => drop(e, ci)}>
      <h4>${c} <span>${byCol[ci].length}</span></h4>
      <div class="cards">${byCol[ci].map(t => html`<${Card} key=${t.id} t=${t} cols=${cols.length} onDragStart=${onDragStart}/>`)}</div>
      ${ci < cols.length - 1 && html`<button class="addc" onClick=${() => openTask('new', { project_id: p.id, col: ci })}>${I('plus', 15)}Add</button>`}
    </div>`)}</div>
  </div>`;
}
