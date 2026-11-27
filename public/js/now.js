import { html, useState, useEffect, S, api, post, patch, load, toast, openModal, askMinutes, startOfDay, addDays, hm, minsOf, dayLabel, DN, SH, dh, clock, n24, isoDate, fromIso, when, placeText } from './lib.js';
import { openTask } from './taskedit.js';
import { I } from './icons.js';
import { openEventSheet, finishEvent, ClashCard, AlsoDots } from './eventsheet.js';

export const keyParts = k => { const [t, p] = String(k).split('@'); return { task: +t, period: p == null ? 0 : +p }; };
export function unitOf(plan, key) { return plan.units[key] || plan.nextUnits?.[key] || null; }
export function currentUnit(plan) {
  if (!plan) return null;
  if (plan.active) {
    const k = Object.keys({ ...plan.nextUnits, ...plan.units }).find(k => { const p = keyParts(k); return p.task === plan.active.task_id && p.period === (plan.active.period || 0); });
    if (k) return unitOf(plan, k);
    return { key: String(plan.active.task_id), taskId: plan.active.task_id, period: plan.active.period, title: plan.active.title, points: [], duration: 0, spent: 0 };
  }
  if (plan.paused) {   // paused: stays here until it is resumed, done, postponed or stopped
    const pa = plan.paused, k = Object.keys({ ...plan.nextUnits, ...plan.units }).find(k => { const p = keyParts(k); return p.task === pa.task_id && p.period === (pa.period || 0); });
    if (k) return unitOf(plan, k);
  }
  return plan.nextKeys?.length ? unitOf(plan, plan.nextKeys[0]) : null;
}
const pausedOn = (plan, u) => plan.paused && u && plan.paused.task_id === u.taskId && (plan.paused.period || 0) === (u.period || 0);
const taskOf = id => S.state.tasks.find(t => t.id === id);
const running = (plan, u) => plan.active && u && plan.active.task_id === u.taskId && (plan.active.period || 0) === (u.period || 0);
const usedMin = (plan, u) => (u.spent || 0) + (running(plan, u) ? (Date.now() - plan.active.since) / 60000 : 0);

// tick the clock without re-rendering everything
export function useTick(ms = 15000) { const [, f] = useState(0); useEffect(() => { const t = setInterval(() => f(x => x + 1), ms); return () => clearInterval(t); }, []); }

async function togglePoint(u, i, on) {
  const t = taskOf(u.taskId); const pts = (t?.points || u.points || []).map((p, j) => j === i ? { ...p, done: on } : p);
  await patch('/api/tasks/' + u.taskId, { points: pts });
  if (on && pts.length && pts.every(p => p.done)) { await post(`/api/tasks/${u.taskId}/done`, { period: u.period || 0 }); toast('Completed'); }
  load(['tasks', 'plan']);
}
export function PointList({ u, big }) {
  const t = taskOf(u.taskId), pts = t?.points || u.points || [];
  if (!pts.length) return null;
  return html`<ul class=${'ptk' + (big ? '' : ' sm')}>${pts.map((p, i) => html`<li class=${p.done ? 'ok' : ''}><label><input type="checkbox" checked=${p.done} onChange=${e => togglePoint(u, i, e.target.checked)}/><span>${p.t}</span></label></li>`)}</ul>`;
}
function context(u) {
  const t = taskOf(u.taskId); if (!t) return u.p_name || '';
  const chain = []; let p = t.parent_id && taskOf(t.parent_id);
  while (p) { chain.unshift(p); p = p.parent_id && taskOf(p.parent_id); }
  const warn = chain.map(c => c.meta?.warn).filter(Boolean).pop();
  return { text: [u.p_name, ...chain.map(c => c.meta?.level === 'chapter' && c.meta.num ? `${c.meta.num} ${c.meta.short || c.title}` : c.title)].filter(Boolean).join(' · '), warn, num: t.meta?.n };
}

// an appointment: where and how to join; one you are in can be tracked (Start, Pause) and finished (Done). Tracked past its
// end it keeps its time, 30 min more each time, until Done
function ApptCard({ ev, lab, next }) {
  const tr = ev.track, on = !!tr?.since, used = (tr?.spent || 0) + (on ? (Date.now() - tr.since) / 60000 : 0), planned = Math.max(1, (ev.end - ev.start) / 60000);
  const act = async (fn, msg) => { try { await fn(); await load(['plan']); if (msg) toast(msg); } catch (e) { toast(e.message); } };
  return html`<div class=${'focus appt' + (next ? ' next' : '')} onClick=${e => { if (!e.target.closest('a, button')) openEventSheet(ev); }}>
    <div class=${'lab' + (next ? '' : ' live')}>${on ? 'In progress · until ' + hm(ev.end) : lab}</div>
    <div class="ft">${ev.title} <${AlsoDots} ev=${ev}/></div>
    <div class="ctx">${hm(ev.start)}–${hm(ev.end)}${placeText(ev.location) ? ' · ' + placeText(ev.location) : ''} · ${ev.cal}${ev.travel?.there && ev.before && ev.start > Date.now() ? html` · <span class="way" title=${`${dh(ev.travel.min)} by ${ev.travel.mode}`}>${I(ev.travel.mode, 12)}${hm(ev.start - ev.before * 60000)}</span>` : ''}</div>
    ${!next && tr && html`<div class="timer"><span class="clk">${clock(used)}</span><span class="of">of ${dh(planned)}</span><div class="bar"><i style=${{ width: Math.min(100, 100 * used / planned) + '%' }}></i></div></div>`}
    ${(ev.join || !next) && html`<div class="btns">${ev.join && html`<a class="join" href=${ev.join} target="_blank" rel="noopener">Join</a>`}
      ${!next && (on ? html`<button onClick=${() => act(() => post(`/api/events/${ev.id}/pause`))}>${I('pause', 16, { w: 2.4 })}Pause</button>`
        : html`<button class="go" onClick=${() => act(() => post(`/api/events/${ev.id}/start`))}>${I('play', 16, { w: 2 })}${tr ? 'Resume' : 'Start'}</button>`)}
      ${!next && html`<button class="ok" onClick=${e => { e.stopPropagation(); finishEvent(ev, 'now'); }}>${I('check', 16, { w: 2.4 })}Done</button>`}</div>`}</div>`;
}
export function FocusCard({ plan, big = true }) {
  useTick(10000);
  const u0 = currentUnit(plan), nowMs = Date.now();
  const appts = (plan.events || []).filter(e => e.blocks && !e.hidden && !e.all_day && e.end - e.start < 864e5 && e.end > nowMs).sort((a, b) => a.start - b.start);
  const curAppt = appts.find(e => e.start <= nowMs), nextAppt = appts.find(e => e.start > nowMs && e.start < nowMs + 864e5);
  const taskRuns = u0 && running(plan, u0);
  if (curAppt && !taskRuns) return html`<${ApptCard} ev=${curAppt} lab=${'Now · until ' + hm(curAppt.end)}/>${u0 && html`<div class="focus next"><div class="lab">Then · ${u0.first ? when(u0.first) : ''}</div><div class="ft" onClick=${() => openTask(u0.taskId)}>${u0.title}</div></div>`}`;
  if (nextAppt && !taskRuns && (!u0 || !u0.first || nextAppt.start < u0.first))
    return html`<div class="focus idle"><div class="lab">Now</div><div class="ft">Free</div><div class="ctx">Until ${when(nextAppt.start)}</div></div><${ApptCard} ev=${nextAppt} lab=${'Next · ' + when(nextAppt.start)} next/>`;
  const u = u0;
  if (!u) return html`<div class="focus idle"><div class="ft">Nothing planned</div></div>`;
  const run = running(plan, u), rs = run && plan.active.mode === 'r', used = usedMin(plan, u), planned = Math.max(u.duration || 0, 1);
  const pz = !run && pausedOn(plan, u);
  const startsLater = !run && !pz && u.first && u.first > Date.now() + 60000;
  // forgot to start: from the planned time, 30 min more each time, until Done; shown a minute into the block, also if the plan was not reloaded
  const due = !run && !pz && (plan.late?.key === u.key ? plan.late : (plan.blocks || []).find(b => b.key === u.key && b.s <= nowMs && b.e > nowMs));
  const late = due && due.s < nowMs - 60000 ? due : null;
  const ctx = context(u);
  const act = async (fn, msg) => { try { await fn(); await load(['plan', 'tasks']); if (msg) toast(msg); } catch (e) { toast(e.message); } };
  const p = { task: u.taskId, period: u.period || 0 };
  // nothing right now: the free time is what matters; the next task follows, smaller
  if (startsLater) return html`
    <div class="focus idle"><div class="lab">Now</div><div class="ft">Free</div><div class="ctx">Until ${when(u.first)}</div></div>
    <div class="focus next">
      <div class="lab">Next · ${when(u.first)}</div>
      ${ctx.text && html`<div class="ctx">${ctx.text}</div>`}
      <div class="ft" onClick=${() => openTask(u.taskId)}>${ctx.num ? html`<span style="color:var(--muted)">${ctx.num} </span>` : ''}${u.title}</div>
      <div class="btns"><button onClick=${() => act(() => post('/api/timer/start', p))}>${I('play', 16, { w: 2 })}Start Now</button><button onClick=${() => moveDialog(u)}>Postpone</button></div>
    </div>`;
  return html`<div class="focus">
    <div class=${'lab' + (run ? ' live' : '')}>${rs ? 'Research' + (plan.active.note ? ' · ' + plan.active.note : '') : run ? 'In progress' + (plan.active.until ? ' · until ' + hm(plan.active.until) : '') : pz ? 'Paused · ' + hm(plan.paused.at) : startsLater ? 'Next · ' + when(u.first) : 'Up now'}</div>
    ${ctx.text && html`<div class="ctx">${ctx.text}</div>`}
    <div class="ft" onClick=${() => openTask(u.taskId)}>${ctx.num ? html`<span style="color:var(--muted)">${ctx.num} </span>` : ''}${u.title}</div>
    ${big ? html`<${PointList} u=${u} big/>` : (u.points?.length ? html`<div class="hint">${u.points.filter(x => x.done).length} of ${u.points.length}</div>` : '')}
    ${big && u.notes && html`<div class="notes">${u.notes.slice(0, 600)}</div>`}
    ${big && ctx.warn && html`<div class="w">${I('warn', 15)}${ctx.warn}</div>`}
    ${u.late && html`<div class="w late">${I('warn', 15)}Misses its deadline</div>`}
    <div class="timer"><span class="clk">${clock(used)}</span><span class="of">of ${dh(planned)}</span><div class="bar"><i style=${{ width: Math.min(100, 100 * used / planned) + '%' }}></i></div></div>
    <div class="btns">
      ${run && !rs ? html`<button onClick=${() => act(() => post('/api/timer/stop'))}>${I('pause', 16, { w: 2.4 })}Pause</button>` : html`<button class="go" onClick=${() => act(() => post('/api/timer/start', p))}>${I('play', 16, { w: 2 })}${rs || pz ? 'Resume' : 'Start'}</button>`}
      ${pz && html`<button onClick=${() => act(() => post('/api/timer/drop'))}>Stop</button>`}
      ${!run && late && html`<button onClick=${() => act(() => post('/api/timer/start', { ...p, planned: true }))}>${I('play', 16, { w: 2 })}Start from ${hm(late.s)}</button>`}
      ${rs && html`<button onClick=${() => act(() => post('/api/timer/stop'))}>${I('pause', 16, { w: 2.4 })}Stop</button>`}
      <button class="ok" onClick=${() => act(() => post(`/api/tasks/${u.taskId}/done`, { period: u.period || 0 }), 'Completed')}>${I('check', 16, { w: 2.4 })}Done</button>
      <button onClick=${() => act(() => post('/api/timer/more', { task: u.taskId, minutes: 30 }), '30 min added')}>+30 min</button>
      <button onClick=${() => moveDialog(u)}>Postpone</button>
    </div>
  </div>`;
}

export async function moveDialog(u) {
  const v = await openModal(close => html`<div class="modal sm"><h3>${u.title.slice(0, 80)}</h3>
    <div class="menu">
      <button onClick=${() => close('1h')}>${I('clock')}In 1 Hour</button>
      <button onClick=${() => close('tomorrow')}>${I('sun')}Tomorrow</button>
      <button onClick=${() => close('week')}>${I('calendar')}Next Week</button>
      ${u.recur ? html`<button onClick=${() => close('skip')}>${I('forward')}Skip This Time</button>` : html`<button onClick=${() => close('later')}>${I('forward')}Someday</button>`}
    </div><div class="acts"><button onClick=${() => close(null)}>Cancel</button></div></div>`);
  if (!v) return;
  const p = u.period || 0, t0 = startOfDay(Date.now());
  try {
    if (v === '1h') await post(`/api/tasks/${u.taskId}/postpone`, { period: p, until: Date.now() + 3600e3 });
    if (v === 'tomorrow') await post(`/api/tasks/${u.taskId}/postpone`, { period: p, until: addDays(t0, 1) });
    if (v === 'week') await post(`/api/tasks/${u.taskId}/postpone`, { period: p, until: addDays(t0, 7 - ((new Date().getDay() + 6) % 7)) });
    if (v === 'skip') await post(`/api/tasks/${u.taskId}/skip`, { period: p });
    if (v === 'later') await patch('/api/tasks/' + u.taskId, { auto: false });
    await load(['plan', 'tasks']);
  } catch (e) { toast(e.message); }
}

async function askResearch(plan) {
  const u = currentUnit(plan); if (!u) return;
  if (plan.active && plan.active.mode === 'r') { await post('/api/timer/stop'); return load(['plan']); }
  const r = await openModal(close => { const B = () => { const [how, setHow] = useState('now'), [m, setM] = useState(15), [n, setN] = useState('');
    return html`<div class="modal sm"><h3>Research</h3><p class="hint">${u.title.slice(0, 70)}</p>
      <input type="text" style="width:100%" placeholder="Topic (optional)" value=${n} onInput=${e => setN(e.target.value)}/>
      <div class="row" style="margin:10px 0"><label><input type="radio" checked=${how === 'now'} onChange=${() => setHow('now')}/> Start now</label><label><input type="radio" checked=${how === 'past'} onChange=${() => setHow('past')}/> Already done:</label><input type="number" min="5" step="5" value=${m} style="width:70px" onInput=${e => { setM(e.target.value); setHow('past'); }}/> min</div>
      <div class="acts"><button onClick=${() => close(null)}>Cancel</button><button class="pri" onClick=${() => close({ how, m: +m, note: n.trim() })}>OK</button></div></div>`; }; return html`<${B}/>`; });
  if (!r) return;
  if (r.how === 'now') await post('/api/timer/start', { task: u.taskId, period: u.period || 0, mode: 'r', note: r.note });
  else await post('/api/timer/research', { task: u.taskId, period: u.period || 0, minutes: r.m, note: r.note });
  load(['plan']);
}
// Break / Block Time at a time you choose: shown like Lunch, the plan works around it; from the calendar at the time clicked
export async function blockTime(date) {
  const t0 = date && date !== startOfDay(date) ? date : Math.ceil(Date.now() / 900000) * 900000;
  const r = await openModal(close => { const B = () => {
    const [d, setD] = useState(isoDate(date || Date.now())), [s, setS] = useState(hm(t0)), [e, setE] = useState(hm(t0 + 30 * 60000)), [t, setT] = useState('');
    return html`<div class="modal sm"><h3>Break / Block Time</h3>
      <div class="row"><input type="date" value=${d} onInput=${x => setD(x.target.value)}/><input class="t24" value=${s} onChange=${x => setS(n24(x.target.value) || s)}/>–<input class="t24" value=${e} onChange=${x => setE(n24(x.target.value) || e)}/></div>
      <input type="text" style="width:100%;margin-top:8px" placeholder="Break" value=${t} onInput=${x => setT(x.target.value)}/>
      <div class="acts"><button onClick=${() => close(null)}>Cancel</button><button class="pri" onClick=${() => close({ d, s, e, t })}>Add</button></div></div>`; }; return html`<${B}/>`; });
  if (!r) return;
  const base = fromIso(r.d), toMs = x => base + (+x.slice(0, 2) * 60 + +x.slice(3)) * 60000;
  if (toMs(r.e) <= toMs(r.s)) return toast('End must be after start');
  try { await post('/api/appts', { start: toMs(r.s), end: toMs(r.e), title: r.t.trim() || 'Break', kind: 'break' }); load(['plan']); } catch (e) { toast(e.message); }
}
export function IntrBar({ plan, cols }) {
  const go = async (fn) => { try { await fn(); await load(['plan']); } catch (e) { toast(e.message); } };
  return html`<div class="intr" style=${cols ? { gridTemplateColumns: `repeat(${cols},minmax(0,1fr))` } : null}>
    <button onClick=${async () => { const r = await askMinutes('Break', [10, 15, 20, 30, 60], 15); if (r?.m) go(() => post('/api/now/break', { minutes: r.m, title: 'Break' })); }}>${I('cup', 22)}Break</button>
    <button onClick=${() => go(() => post('/api/now/break', { minutes: 45, title: 'Lunch' }))}>${I('fork', 22)}Lunch</button>
    <button onClick=${async () => { const r = await askMinutes('Interruption', [5, 10, 15, 30, 60], 15, 'Reason (optional)'); if (r?.m) go(() => post('/api/now/interrupt', { minutes: r.m, title: r.t })); }}>${I('bolt', 22)}Interrupted</button>
    <button onClick=${() => askResearch(plan)}>${I('book', 22)}Research</button>
  </div>`;
}

// a planned task block: title, day and time (pins it there), move it, open the task
export async function blockSheet(u, bl) {
  const t = S.state.tasks.find(x => x.id === u.taskId);
  const r = await openModal(close => { const B = () => { const [f, setF] = useState({ title: u.title, day: isoDate(bl.s), s: hm(bl.s), e: hm(bl.e) });
    return html`<div class="modal sm"><input type="text" class="ttl" value=${f.title} onInput=${e => setF({ ...f, title: e.target.value })}/>
      <div class="hint" style="margin:6px 0 10px">${u.p_name}${bl.parts > 1 ? ` · ${bl.part}/${bl.parts}` : ''}</div>
      <div class="box"><div class="cell"><span>Day</span><input type="date" value=${f.day} onInput=${e => setF({ ...f, day: e.target.value })}/></div>
        <div class="cell"><span>Time</span><span class="row" style="gap:6px;flex:none"><input class="t24" value=${f.s} onChange=${e => setF({ ...f, s: n24(e.target.value) || f.s })}/>–<input class="t24" value=${f.e} onChange=${e => setF({ ...f, e: n24(e.target.value) || f.e })}/></span></div></div>
      <div class="sect" style="margin:16px 4px 6px">Move To</div><div class="menu">
        <button onClick=${() => close({ ...f, move: '1h' })}>${I('clock')}In 1 Hour</button>
        <button onClick=${() => close({ ...f, move: 'tomorrow' })}>${I('sun')}Tomorrow</button>
        <button onClick=${() => close({ ...f, move: 'week' })}>${I('calendar')}Next Week</button>
        ${u.recur ? html`<button onClick=${() => close({ ...f, move: 'skip' })}>${I('forward')}Skip This Time</button>` : html`<button onClick=${() => close({ ...f, move: 'later' })}>${I('forward')}Someday</button>`}
        <button onClick=${() => close({ ...f, move: 'open' })}>${I('list')}Open Task</button></div>
      <div class="acts"><button class="ok" style="margin-right:auto" onClick=${() => close({ ...f, move: 'done' })}>${I('check', 16, { w: 2.4 })}Done</button><button onClick=${() => close(null)}>Cancel</button><button class="pri" onClick=${() => close(f)}>Save</button></div></div>`; }; return html`<${B}/>`; });
  if (!r) return;
  const p = u.period || 0, t0 = startOfDay(Date.now());
  try {
    if (r.title.trim() && r.title.trim() !== u.title && t) await patch('/api/tasks/' + u.taskId, { title: r.title.trim() });
    if (r.move === 'open') return openTask(u.taskId);
    if (r.move === 'done') await post(`/api/tasks/${u.taskId}/done`, { period: p });
    else if (r.move === '1h') await post(`/api/tasks/${u.taskId}/postpone`, { period: p, until: Date.now() + 3600e3 });
    else if (r.move === 'tomorrow') await post(`/api/tasks/${u.taskId}/postpone`, { period: p, until: addDays(t0, 1) });
    else if (r.move === 'week') await post(`/api/tasks/${u.taskId}/postpone`, { period: p, until: addDays(t0, 7 - ((new Date().getDay() + 6) % 7)) });
    else if (r.move === 'skip') await post(`/api/tasks/${u.taskId}/skip`, { period: p });
    else if (r.move === 'later') await patch('/api/tasks/' + u.taskId, { auto: false });
    else {
      const s = fromIso(r.day) + (+r.s.slice(0, 2) * 60 + +r.s.slice(3)) * 60000, e = fromIso(r.day) + (+r.e.slice(0, 2) * 60 + +r.e.slice(3)) * 60000;
      if (s !== bl.s || e !== bl.e) { if (!(e > s)) return toast('End must be after start'); await post(`/api/tasks/${u.taskId}/pin`, { period: p, oldStart: bl.s, s, e }); }
    }
    await load(['plan', 'tasks']);
  } catch (e) { toast(e.message); }
}

export function Timeline({ plan, date, head = true }) {
  const [sel, setSel] = useState(null);
  // tap selects an entry, a second tap opens it
  const tap = (key, open) => e => { if (e.target.closest('input,button,a')) return; if (sel === key) { setSel(null); open(); } else setSel(key); };
  const d0 = startOfDay(date), d1 = addDays(d0, 1), isT = d0 === startOfDay(Date.now()), now = Date.now(), cur = currentUnit(plan);
  const items = [];
  (plan.busy || []).filter(b => b.e > d0 && b.s < d1).forEach(b => items.push({ s: b.s, e: b.e, busy: b }));
  (plan.events || []).filter(e => e.blocks && !e.hidden && e.end > d0 && e.start < d1).forEach(e => items.push({ s: e.start, e: e.end, busy: { t: e.title, cal: e.cal, allDay: e.all_day, ev: e } }));
  plan.blocks.filter(b => b.e > d0 && b.s < d1).forEach(b => items.push({ s: b.s, e: b.e, bl: b }));
  if (isT) (plan.done || []).filter(x => x.at >= d0 && x.at < d1).forEach(x => items.push({ s: x.at, e: x.at, done: x }));
  items.sort((a, b) => a.s - b.s || a.e - b.e);
  const tot = items.filter(x => x.bl).reduce((a, x) => a + (x.e - x.s) / 60000, 0);
  const out = []; let placed = false;
  // the red line: inside the entry that is running, as far down as it has got; between entries in free time
  const line = x => { if (!isT || placed || x.done || !(x.s <= now && now < x.e)) return null; placed = true; return html`<i class="nl" style=${{ top: (100 * (now - x.s) / (x.e - x.s)).toFixed(1) + '%' }}></i>`; };
  items.forEach((x, i) => {
    if (isT && !placed && x.s >= now) { out.push(html`<li class="nowline" data-t=${hm(now)}></li>`); placed = true; }
    if (x.busy) out.push(html`<li class=${'busy' + (x.busy.ev && sel === 'e' + x.busy.ev.id ? ' sel' : '') + (x.busy.ev?.done ? ' dn' : '')} onClick=${x.busy.ev ? tap('e' + x.busy.ev.id, () => openEventSheet(x.busy.ev)) : null}>${line(x)}<span class="tm">${x.busy.allDay || (x.s <= d0 && x.e >= d1) ? 'All day' : hm(x.s) + '–' + hm(x.e)}</span><span>${x.busy.ev && isT && x.s <= now && !x.busy.allDay ? html`<input type="checkbox" style="margin-right:6px" checked=${!!x.busy.ev.done} disabled=${!!x.busy.ev.done} onChange=${() => finishEvent(x.busy.ev, x.e > now ? 'now' : 'planned')}/>` : ''}${x.busy.ev ? html`<span class="kind" title="Fixed appointment">${I('pin', 12)}</span>` : ''}${x.busy.t}${x.busy.ev ? html` <${AlsoDots} ev=${x.busy.ev}/>` : ''}${placeText(x.busy.ev?.location) ? html`<span class="hint loc"> · ${placeText(x.busy.ev.location)}</span>` : ''}${x.busy.ev?.travel?.there && x.busy.ev.before ? html`<span class="hint way" title=${`${dh(x.busy.ev.travel.min)} by ${x.busy.ev.travel.mode}`}> · ${I(x.busy.ev.travel.mode, 12)}${hm(x.busy.ev.start - x.busy.ev.before * 60000)}</span>` : ''}</span>
      ${x.busy.ev?.join ? html`<a class="join" href=${x.busy.ev.join} target="_blank" rel="noopener">Join</a>` : x.busy.id ? html`<button class="sk" title="Remove" onClick=${async () => { await api('/api/appts/' + x.busy.id, { method: 'DELETE', body: {} }); load(['plan']); }}>${I('x', 14)}</button>` : html`<span></span>`}</li>`);
    else if (x.done) out.push(html`<li class="dn" style=${{ borderLeftColor: x.done.color }}><span class="tm">${hm(x.s)}</span><span class="tx" onClick=${() => openTask(x.done.id)}>${x.done.title}</span><span></span></li>`);
    else { const u = unitOf(plan, x.bl.key); if (!u) return;
      const k = 'b' + x.bl.key + ':' + x.s;
      out.push(html`<li class=${(cur && cur.key === u.key && isT ? 'cur' : '') + (sel === k ? ' sel' : '')} style=${{ borderLeftColor: u.p_color }} onClick=${tap(k, () => blockSheet(u, x.bl))}>${line(x)}<span class="tm">${hm(x.s)}–${hm(x.e)}</span>
        <span><input type="checkbox" style="margin-right:6px" onChange=${async () => { await post(`/api/tasks/${u.taskId}/done`, { period: u.period || 0 }); load(['plan', 'tasks']); }}/><span class="tx">${u.meta?.win ? html`<span class="kind" title="Flexible appointment">${I('flex', 12)}</span>` : ''}${u.title}</span>${x.bl.parts > 1 ? html` <span class="hint">(${x.bl.part}/${x.bl.parts})</span>` : ''}</span>
        <span class="dur" title="Planned time">${dh(u.duration)}</span></li>`); }
  });
  if (isT && !placed) out.push(html`<li class="nowline" data-t=${hm(now)}></li>`);
  if (!items.length) out.push(html`<li class="busy"><span class="tm"></span><span>Free</span><span></span></li>`);
  return html`${head && html`<div class="tlh"><b>${isT ? 'Today' : `${DN[new Date(d0).getDay()]} ${SH(d0)}`}</b><span>${tot ? dh(tot) : ''}</span></div>`}<ul class="tline">${out}</ul>`;
}

function LaterList({ plan }) {
  const L = plan.later || [];
  if (!L.length) return null;
  return html`<div class="later"><div class="tlh"><b>Someday</b><span>${L.length}</span></div><ul>${L.map(u => html`<li>
    <input type="checkbox" onChange=${async () => { await post(`/api/tasks/${u.taskId}/done`, { period: u.period || 0 }); load(['plan', 'tasks']); }}/>
    <span class="tx grow" onClick=${() => openTask(u.taskId)}>${u.title}</span>
    <button class="sk" title="Schedule" onClick=${async () => { await patch('/api/tasks/' + u.taskId, { auto: true }); load(['plan', 'tasks']); }}>${I('calendar', 15)}</button></li>`)}</ul></div>`;
}
export function FinishLines({ plan }) {
  const ps = S.state.projects.filter(p => p.target_date && !p.archived);
  return ps.map(p => { const e = plan.projectEnds?.[p.id], late = e && e > addDays(fromIso(p.target_date), 1);
    return html`<div class="ms"><span>${p.name}</span><span><b class=${late ? 'late' : ''}>${e ? `${DN[new Date(e).getDay()]} ${SH(e)}` : 'Done'}</b> <span class="hint">/ ${SH(fromIso(p.target_date))}</span></span></div>`; });
}
// group event vs. your own event at the same time: pick which one wins (your own → #TAG-blocked in the group event)
function Clashes() {
  const [c, setC] = useState(null);
  useEffect(() => { api('/api/clashes').then(setC).catch(() => {}); }, [S.state.plan]);
  if (!c?.items.length) return null;
  return html`<div class="clashes"><div class="tlh"><b>Clashes</b><span>${c.items.length}</span></div>
    ${c.items.map(x => html`<${ClashCard} key=${x.key + x.choice} c=${x} tag=${c.tag} onChange=${setC}/>`)}</div>`;
}
// in the title row of Now: all time today and this week (work and appointments), the focus project (newest outline project) alone, and when
// each project with a target will be finished
export function NowStats() {
  const [s, setS] = useState(null), plan = S.state.plan;
  useEffect(() => {
    const get = () => { if (document.visibilityState === 'visible') api('/api/stats').then(setS).catch(() => {}); };
    get(); const t = setInterval(get, 60000); return () => clearInterval(t);     // counts on during a meeting or a session
  }, [plan]);
  const ps = plan ? S.state.projects.filter(p => p.target_date && !p.archived) : [];
  const th = s?.focus && S.state.projects.find(p => p.id === s.focus)?.name || 'Focus';
  const it = (v, l, cls = '', title) => html`<span class="ts" title=${title}><b class=${cls}>${v}</b><small>${l}</small></span>`;
  return html`<div class="tstats">${s && html`${it(dh(s.today), 'Today')}${it(dh(s.week), 'Week')}
    ${s.focus && html`${it(dh(s.focusToday), th + ' today')}${it(dh(s.focusWeek), th + ' week')}`}`}
    ${ps.map(p => { const e = plan.projectEnds?.[p.id], late = e && e > addDays(fromIso(p.target_date), 1);
      return it(e ? `${DN[new Date(e).getDay()]} ${SH(e)}` : 'Done', p.name + ' finished', late ? 'late' : '', `${p.name}: target ${SH(fromIso(p.target_date))}`); })}</div>`;
}

export default function NowView() {
  const plan = S.state.plan;
  if (!plan) return html`<div class="empty"></div>`;
  const days = []; let d = addDays(startOfDay(Date.now()), 1);
  for (let g = 0; g < 14 && days.length < 4; g++, d = addDays(d, 1)) if (plan.blocks.some(b => b.s >= d && b.s < addDays(d, 1))) days.push(d);
  return html`<div class="now">
    <section><${FocusCard} plan=${plan}/><${IntrBar} plan=${plan}/><${Timeline} plan=${plan} date=${Date.now()}/></section>
    <section><${Clashes}/>${days.map(x => html`<${Timeline} plan=${plan} date=${x}/>`)}<${LaterList} plan=${plan}/>
      ${(plan.unplaced || []).length ? html`<div class="ms"><b class="late">${plan.unplaced.length} not scheduled</b><span class="hint">no free time</span></div>` : ''}
</section>
  </div>`;
}
