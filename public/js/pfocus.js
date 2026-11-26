// Project overview, like the wall display: the task in focus with big buttons on the left, every open task grouped on the right
// (outline: by chapter/category; board: by place if the project has places, otherwise by column). Tap a task to bring it into focus.
import { html, useState, useEffect, useRef, S, post, load, toast, when, dh, hm, startOfDay, addDays } from './lib.js';
import { openTask } from './taskedit.js';
import { I } from './icons.js';
import { PointList, moveDialog, useTick } from './now.js';
import { isLeaf } from './tasks.js';
import { levelNames } from './outline.js';

const clockTxt = m => `${Math.floor(m / 60)}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
function Timer({ since, used, planned }) {
  useTick(1000); const m = used + (Date.now() - since) / 60000;
  return html`<div class="pf-timer"><span>${clockTxt(m)}</span><div class="bar"><i style=${{ width: Math.min(100, 100 * m / Math.max(1, planned)) + '%' }}></i></div><em>of ${dh(planned)}</em></div>`;
}

export default function ProjectFocus({ p }) {
  const st = S.state, plan = st.plan, all = st.tasks.filter(t => t.project_id === p.id);
  const [pick, setPick] = useState(null), idle = useRef(null);
  useEffect(() => () => clearTimeout(idle.current), []);
  const choose = t => { setPick(t ? t.id : null); clearTimeout(idle.current); if (t) idle.current = setTimeout(() => setPick(null), 5 * 60000); };
  const byId = new Map(all.map(t => [t.id, t]));
  const top = t => { let x = t; while (x?.parent_id && byId.get(x.parent_id)) x = byId.get(x.parent_id); return x; };
  const open = all.filter(t => isLeaf(t) && t.status !== 'done' && !['chapter', 'section'].includes(t.meta?.level));
  const done = all.filter(t => isLeaf(t) && t.status === 'done' && !['chapter', 'section'].includes(t.meta?.level)).length;
  const first = t => t.sched?.first || Infinity;
  open.sort((a, b) => first(a) - first(b) || a.grp - b.grp || a.sort - b.sort);

  // groups
  const cols = p.columns?.length ? p.columns : ['To do', 'Done'];
  let groups;
  if (p.kind === 'outline') {
    const chs = all.filter(t => !t.parent_id && t.meta?.level === 'chapter').sort((a, b) => a.sort - b.sort);
    groups = chs.map(c => ({ k: c.id, name: (c.meta?.num && !['A', '+'].includes(c.meta.num) ? c.meta.num + ' · ' : '') + (c.meta?.short || c.title), items: open.filter(t => top(t)?.id === c.id) }));
    const rest = open.filter(t => !chs.includes(top(t)));
    if (rest.length) groups.push({ k: 'other', name: 'Other', items: rest });
  } else if (p.places) {
    groups = p.places.map(pl => ({ k: pl, name: pl, icon: 'pin', items: open.filter(t => (t.location || '').toLowerCase() === pl.toLowerCase()) }));
    const rest = open.filter(t => !p.places.some(pl => (t.location || '').toLowerCase() === pl.toLowerCase()));
    if (rest.length) groups.push({ k: 'other', name: 'Other', items: rest });
  } else groups = cols.slice(0, -1).map((c, i) => ({ k: i, name: c, items: open.filter(t => Math.min(t.col, cols.length - 1) === i) }));
  groups = groups.filter(g => g.items.length);

  const runId = plan?.active?.task_id, running = open.find(t => t.id === runId);
  const cur = (pick && open.find(t => t.id === pick)) || running || open.find(t => t.auto && t.sched?.first) || open[0];
  const isRun = cur && runId === cur.id;
  const period = cur ? (cur.sched?.period ?? cur.period ?? 0) : 0;
  const act = async (fn, after) => { try { await fn(); if (after) after(); await load(['tasks', 'plan']); } catch (e) { toast(e.message); } };
  const ctx = cur ? [top(cur) !== cur && (top(cur)?.meta?.short || top(cur)?.title), cur.parent_id && byId.get(cur.parent_id) !== top(cur) && byId.get(cur.parent_id)?.title, cur.location].filter(Boolean).join(' · ') : '';
  const label = !cur ? '' : isRun ? 'In progress' : pick ? 'Selected' : cur.sched?.first ? (cur.sched.first <= Date.now() ? 'Now' : 'Next · ' + when(cur.sched.first)) : 'Open';
  const t0 = startOfDay(Date.now()), t1 = addDays(t0, 1);
  const today = (plan?.blocks || []).filter(b => b.s < t1 && b.e > t0 && plan.units[b.key]?.project_id === p.id);
  const [L1] = levelNames(p);

  return html`<div class="pf">
    <div class="pf-col">
      ${cur ? html`<div class=${'pf-hero' + (isRun ? ' live' : '')}>
          <div class="lab">${label}</div>${ctx && html`<div class="ctx">${ctx}</div>`}
          <div class="t" onClick=${() => openTask(cur.id)}>${cur.title}</div>
          ${isRun ? html`<${Timer} since=${plan.active.since} used=${cur.spent || 0} planned=${cur.duration}/>` : html`<div class="m">${dh(cur.duration)}${cur.sched?.late ? ' · after deadline' : ''}</div>`}
          <${PointList} u=${{ taskId: cur.id, period, points: cur.points }} big/>
          <div class="acts">
            ${isRun ? html`<button onClick=${() => act(() => post('/api/timer/stop'))}>${I('pause', 24, { w: 2.4 })}Pause</button>` : html`<button class="go" onClick=${() => act(() => post('/api/timer/start', { task: cur.id, period }))}>${I('play', 24, { w: 2 })}Start</button>`}
            <button class="ok" onClick=${() => act(() => post(`/api/tasks/${cur.id}/done`, { period }), () => choose(null))}>${I('check', 24, { w: 2.6 })}Done</button>
            <button onClick=${() => moveDialog({ taskId: cur.id, period, title: cur.title, recur: !!cur.recur })}>${I('forward', 22)}Later</button>
          </div>
          ${pick && !isRun && html`<button class="pf-back" onClick=${() => choose(null)}>Back to plan</button>`}
        </div>` : html`<div class="pf-hero idle"><div class="lab">Project</div><div class="t">All done</div></div>`}
      ${today.length > 0 && html`<div class="pf-sec">${I('calendar', 16)}Today</div><div class="pf-list">${today.map(b => { const u = plan.units[b.key];
        return html`<div class=${'pf-row' + (cur && u.taskId === cur.id ? ' sel' : '')} onClick=${() => choose(byId.get(u.taskId))}><span class="tm">${hm(b.s)}</span><div class="tt"><b>${u.title}</b><span>${dh((b.e - b.s) / 60000)}${b.parts > 1 ? ` · ${b.part}/${b.parts}` : ''}</span></div></div>`; })}</div>`}
    </div>
    <div class="pf-col">
      ${groups.length ? groups.map(g => html`<div class="pf-sec">${I(g.icon || (p.kind === 'outline' ? 'book' : 'list'), 16)}${g.name}<em>${g.items.length}</em></div>
        <div class="pf-list">${g.items.map(t => html`<div class=${'pf-row' + (cur && t.id === cur.id ? ' sel' : '') + (t.id === runId ? ' run' : '') + (t.sched?.late ? ' late' : '')} onClick=${e => { if (!e.target.closest('.chk')) choose(t); }}>
          <button class="chk" aria-label="Done" onClick=${() => act(() => post(`/api/tasks/${t.id}/done`, { period: t.sched?.period ?? t.period ?? 0 }))}></button>
          <div class="tt"><b>${t.title}</b><span>${dh(t.duration)}${t.recur ? ' · repeats' : ''}${!t.auto ? ' · someday' : ''}</span></div>
          <span class="tm">${t.id === runId ? I('play', 16) : t.sched?.first ? when(t.sched.first) : ''}</span></div>`)}</div>`)
      : html`<div class="empty">Nothing open in this project.</div>`}
    </div>
  </div>`;
}
