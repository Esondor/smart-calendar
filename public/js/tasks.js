import { html, useState, S, post, load, toast, startOfDay, addDays, when, dh, hm, Avatar, projectById, recurText, PRI, SH, fromIso, priColor, isAppt } from './lib.js';
import { openTask } from './taskedit.js';
import { I } from './icons.js';

// a flexible appointment written to its own calendar shows that calendar's color
const calColor = id => id ? S.state.accounts.flatMap(a => a.calendars || []).find(c => c.id === +id)?.color || null : null;
export const isLeaf = t => !['chapter', 'section'].includes(t.meta?.level);
export function TaskRow({ t, showProject = true }) {
  const p = projectById(t.project_id), s = t.sched, done = t.status === 'done';
  const toggle = async e => { e.stopPropagation(); try { await post(`/api/tasks/${t.id}/done`, { period: s?.period ?? t.period ?? 0, done: !done }); await load(['tasks', 'plan']); } catch (x) { toast(x.message); } };
  const dl = t.deadline ? fromIso(t.deadline) : null;
  return html`<div class=${'trow' + (done ? ' done' : '')} onClick=${() => openTask(t.id)}>
    <input type="checkbox" checked=${done} onClick=${toggle}/>
    <span class="tt">${!done && !(p && (p.meta?.ordered ?? p.kind === 'outline')) ? html`<span class="flag" style=${{ background: priColor(s?.pri ?? t.priority) }} title=${PRI[Math.round(s?.pri ?? t.priority)]}></span>` : ''}${t.title}${t.recur ? html`<small>${I('repeat', 13)}</small>` : ''}${t.points?.length ? html`<small>${t.points.filter(x => x.done).length}/${t.points.length}</small>` : ''}</span>
    <span class="meta">
      ${showProject && p && html`<span class="row" style="gap:5px;flex-wrap:nowrap"><span class="flag" style=${{ background: calColor(t.meta?.calendarId) || p.color }}></span>${p.name}</span>`}${isAppt(t.meta) ? html`<span class="kind" title="Appointment">${I('flex', 13)}</span>` : ''}
      <span>${dh(s?.remaining && s.remaining < t.duration ? s.remaining : t.duration)}</span>
      ${dl && html`<span class=${'chip' + (s?.late ? ' late' : dl < addDays(startOfDay(Date.now()), 2) ? ' warn' : '')}>${s?.late ? 'At risk · ' : ''}Due ${SH(dl)}${t.meta?.due && new Date(+t.meta.due).toLocaleDateString('sv') === t.deadline ? ', ' + hm(+t.meta.due) : ''}</span>`}
      ${(s?.user || t.assignee_id) && html`<${Avatar} id=${s?.user || t.assignee_id}/>`}
      <span class=${'when' + (s?.late ? ' late' : '')}>${done ? (t.done_at ? SH(t.done_at) : '') : !t.auto ? 'Someday' : s?.first ? when(s.first) : '–'}</span>
    </span></div>`;
}

export default function TasksView() {
  const st = S.state;
  const [mine, setMine] = useState(true), [q, setQ] = useState(''), [pid, setPid] = useState(''), [showDone, setShowDone] = useState(false);
  let L = st.tasks.filter(isLeaf);
  if (mine) L = L.filter(t => (t.sched?.user ?? t.assignee_id ?? t.created_by) === st.me.id || (t.recur && t.assign_mode === 'rotate' && t.sched?.user === st.me.id));
  if (pid) L = L.filter(t => t.project_id === +pid);
  if (q) { const r = q.toLowerCase(); L = L.filter(t => t.title.toLowerCase().includes(r) || t.notes.toLowerCase().includes(r)); }
  const t0 = startOfDay(Date.now()), t1 = addDays(t0, 1), t2 = addDays(t0, 2), wEnd = addDays(t0, 7 - ((new Date().getDay() + 6) % 7));
  const G = [['Overdue', [], 'late'], ['Today', []], ['Tomorrow', []], ['This Week', []], ['Later', []], ['Someday', []], ['Completed', []]];
  for (const t of L) {
    if (t.status === 'done') { G[6][1].push(t); continue; }
    const f = t.sched?.first;
    // overdue = its own deadline has passed (or a chore round was missed); planned after a target is only shown red in place,
    // so ordered projects keep their order
    if ((t.deadline && fromIso(t.deadline) < t0) || t.sched?.overdue) G[0][1].push(t);
    else if (!t.auto || !f) G[5][1].push(t);
    else if (f < t1) G[1][1].push(t); else if (f < t2) G[2][1].push(t); else if (f < wEnd) G[3][1].push(t); else G[4][1].push(t);
  }
  G.forEach(g => g[1].sort((a, b) => (a.sched?.first || Infinity) - (b.sched?.first || Infinity) || a.priority - b.priority));
  G[6][1].sort((a, b) => (b.done_at || 0) - (a.done_at || 0));
  return html`<div class="list">
    <div class="filters">
      <div class="seg"><button class=${mine ? 'on' : ''} onClick=${() => setMine(true)}>Mine</button><button class=${!mine ? 'on' : ''} onClick=${() => setMine(false)}>Everyone</button></div>
      <select value=${pid} onChange=${e => setPid(e.target.value)}><option value="">All Projects</option>${st.projects.map(p => html`<option value=${p.id}>${p.name}</option>`)}</select>
      <input type="search" placeholder="Search" value=${q} onInput=${e => setQ(e.target.value)} style="flex:1;min-width:140px"/>
    </div>
    ${G.map(([name, items, cls], i) => (items.length && (i < 6 || showDone)) ? html`<div class=${'lgrp ' + (cls || '')}><h3>${name}</h3><span>${items.length} · ${dh(items.reduce((a, t) => a + (t.sched?.remaining ?? t.duration), 0))}</span></div>
      <div class="tgroup">${items.slice(0, i === 4 ? 60 : 300).map(t => html`<${TaskRow} t=${t} key=${t.id}/>`)}</div>${i === 4 && items.length > 60 ? html`<p class="hint">${items.length - 60} more</p>` : ''}` : '')}
    ${G[6][1].length > 0 && html`<p><button class="ghost" onClick=${() => setShowDone(!showDone)}>${showDone ? 'Hide Completed' : 'Show Completed'}</button></p>`}
    ${!L.length && html`<div class="empty">No Tasks</div>`}
  </div>`;
}
