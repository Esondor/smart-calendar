import { html, useState, useEffect, useRef, S, post, patch, del, load, toast, askMinutes, when, dh, openModal, confirmDialog } from './lib.js';
import { openTask } from './taskedit.js';
import { I } from './icons.js';
import { FocusCard, IntrBar, Timeline, FinishLines, currentUnit, moveDialog } from './now.js';
import { projectSettings } from './board.js';

const lvl = t => t.meta?.level || (t.parent_id ? 'item' : 'chapter');
// what the two levels are called in this project (e.g. Chapter / Section, or Category / Section)
export const levelNames = p => [p.meta?.levels?.[0] || (p.meta?.groups ? 'Chapter' : 'Category'), p.meta?.levels?.[1] || 'Section'];
const nameOf = (p, level) => level === 'chapter' ? levelNames(p)[0] : level === 'section' ? levelNames(p)[1] : 'Item';
async function addNode(p, parent, level) {
  const title = await openModal(close => { const B = () => { const [v, setV] = useState(''); return html`<div class="modal sm"><h3>New ${nameOf(p, level)}</h3>
    <input type="text" style="width:100%" value=${v} onInput=${e => setV(e.target.value)} onKeyDown=${e => e.key === 'Enter' && close(v)}/>
    <div class="acts"><button onClick=${() => close(null)}>Cancel</button><button class="pri" onClick=${() => close(v)}>Add</button></div></div>`; }; return html`<${B}/>`; });
  if (!title?.trim()) return;
  const siblings = S.state.tasks.filter(t => t.project_id === p.id && (t.parent_id || null) === (parent?.id || null));
  const n = siblings.length + 1;
  await post('/api/tasks', { project_id: p.id, parent_id: parent?.id || null, title, auto: level === 'item', duration: level === 'item' ? (S.state.settings?.dSub || 90) : 30,
    sort: siblings.length, grp: parent?.grp || 0, meta: level === 'chapter' ? { level, num: String(n), short: title.slice(0, 24), thread: '', role: '' } : level === 'section' ? { level, sid: `${parent.meta?.num || ''}.${n}` } : { level, n: '' } });
  load(['tasks', 'plan']);
}

// rename, describe, reorder or delete a chapter / section
async function editNode(p, node, siblings) {
  const level = lvl(node), isCh = level === 'chapter';
  const r = await openModal(close => { const B = () => {
    const [f, setF] = useState({ title: node.title, short: node.meta?.short || '', thread: node.meta?.thread || '', role: node.meta?.role || '', out: node.meta?.out || '', warn: node.meta?.warn || '', pts: (node.meta?.pts || []).join('\n') });
    const set = x => setF({ ...f, ...x }), i = siblings.indexOf(node);
    const field = (k, ph, area) => area ? html`<textarea placeholder=${ph} value=${f[k]} onInput=${e => set({ [k]: e.target.value })} style="min-height:64px"></textarea>` : html`<input type="text" placeholder=${ph} value=${f[k]} onInput=${e => set({ [k]: e.target.value })}/>`;
    return html`<div class="modal sm tedit"><input class="ttl" placeholder=${nameOf(p, level)} value=${f.title} onInput=${e => set({ title: e.target.value })}/>
      <div class="grid">${isCh ? html`
        <label>Short name</label>${field('short', 'For the list')}
        <label>In one line</label>${field('thread', 'Summary')}
        <label>Purpose</label>${field('role', 'What it is for', true)}
        <label>Leads to</label>${field('out', 'Bridge to the next', true)}` : html`
        <label>Note</label>${field('warn', 'Shown on the section')}
        <label>Key points</label>${field('pts', 'One per line', true)}`}</div>
      <div class="acts"><button class="icon" style="margin-right:auto;color:var(--late)" title="Delete" onClick=${() => close({ del: true })}>${I('trash')}</button>
        <button class="icon" title="Move up" disabled=${i <= 0} onClick=${() => close({ move: -1 })}>${I('up')}</button><button class="icon" title="Move down" disabled=${i >= siblings.length - 1} onClick=${() => close({ move: 1 })}>${I('down')}</button>
        <button class="pri" disabled=${!f.title.trim()} onClick=${() => close(f)}>Save</button></div></div>`; }; return html`<${B}/>`; });
  if (!r) return;
  try {
    if (r.del) {
      const n = S.state.tasks.filter(t => t.parent_id === node.id).length;
      if (!(await confirmDialog(`Delete “${node.title}”${n ? ' with everything in it' : ''}?`, 'Delete', true))) return;
      await del('/api/tasks/' + node.id);
    } else if (r.move) {
      const L = siblings.map((x, k) => ({ id: x.id, sort: k })), i = siblings.indexOf(node), j = i + r.move;
      [L[i].sort, L[j].sort] = [L[j].sort, L[i].sort];
      await post('/api/tasks/reorder', L);
    } else {
      const meta = { ...node.meta, ...(isCh ? { short: r.short.trim() || r.title.slice(0, 24), thread: r.thread.trim(), role: r.role.trim(), out: r.out.trim() } : { warn: r.warn.trim(), pts: r.pts.split('\n').map(x => x.trim()).filter(Boolean) }) };
      await patch('/api/tasks/' + node.id, { title: r.title.trim(), meta });
    }
    await load(['tasks', 'plan']);
  } catch (e) { toast(e.message); }
}

// sticky note: grows with its text; a new line after "- " continues the list
function NoteArea({ id, value, onSave, small }) {
  const ref = useRef();
  const fit = () => { const t = ref.current; if (t) { t.style.height = 'auto'; t.style.height = Math.max(small ? 22 : 60, t.scrollHeight) + 'px'; } };
  useEffect(fit, [value, id]);
  const key = e => { if (e.key !== 'Enter') return; const t = e.target, line = t.value.slice(0, t.selectionStart).split('\n').pop(), m = line.match(/^(\s*[-•*]\s)/);
    if (!m) return; e.preventDefault(); const v = t.value.slice(0, t.selectionStart) + '\n' + m[1] + t.value.slice(t.selectionEnd), pos = t.selectionStart + 1 + m[1].length;
    t.value = v; t.setSelectionRange(pos, pos); onSave(id, v); fit(); };
  return html`<textarea ref=${ref} rows=${small ? 1 : 3} class="sticky-t" placeholder=${small ? 'Note' : 'Ideas, loose thoughts, - bullet points'} value=${value || ''} onInput=${e => { onSave(id, e.target.value); fit(); }} onKeyDown=${key}></textarea>`;
}

export default function OutlineView({ p }) {
  const st = S.state, plan = st.plan;
  const all = st.tasks.filter(t => t.project_id === p.id);
  const kids = id => all.filter(t => (t.parent_id || null) === id).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const [L1, L2] = levelNames(p);
  const loose = kids(null).filter(t => !['chapter', 'section'].includes(t.meta?.level) && !all.some(x => x.parent_id === t.id));
  const chapters = [...kids(null).filter(t => !loose.includes(t)), ...(loose.length ? [{ id: 0, title: 'Other', virtual: true, meta: { level: 'chapter', short: 'Other' }, notes: '' }] : [])];
  const kidsOf = id => id === 0 ? loose : kids(id);
  const itemsOf = sec => kids(sec.id);
  const leavesOf = ch => kidsOf(ch.id).flatMap(s => lvl(s) === 'section' ? itemsOf(s) : [s]);
  const count = ch => { const L = leavesOf(ch); return [L.filter(x => x.status === 'done').length, L.length]; };
  const cu = currentUnit(plan), curTask = cu && all.find(t => t.id === cu.taskId);
  const chapterOf = t => { let x = t; while (x && x.parent_id) x = all.find(y => y.id === x.parent_id); return x; };
  // chapter you are working on: the running/next task if it is in this project, else this project's next planned item
  const nextHere = all.filter(t => t.status !== 'done' && t.sched?.first).sort((a, b) => a.sched.first - b.sched.first)[0];
  const curCh = curTask ? chapterOf(curTask) : nextHere ? chapterOf(nextHere) : null;
  const [sel, setSel] = useState(() => { try { return +localStorage.getItem('ol-sel-' + p.id) || null; } catch { return null; } });
  const allNotes = sel === -1;
  const c = allNotes ? null : chapters.find(x => x.id === sel) || curCh || chapters.find(ch => { const [d, n] = count(ch); return d < n; }) || chapters[0];
  const pick = id => { setSel(id); try { localStorage.setItem('ol-sel-' + p.id, id); } catch {} };
  const ci = chapters.indexOf(c), prev = chapters[ci - 1], next = chapters[ci + 1];
  const [focusSec, setFocusSec] = useState(null);
  const secs = c ? kidsOf(c.id) : [];
  const curSec = secs.find(s => s.id === (curTask || nextHere)?.parent_id);
  const f = curSec || secs.find(s => s.id === focusSec && s.status !== 'done') || secs.find(s => itemsOf(s).some(x => x.status !== 'done'));
  const chap = useRef();
  // desktop: the chapter column scrolls to the current section; phone: the page starts at the top
  useEffect(() => { if (matchMedia('(max-width:860px)').matches) return; const n = chap.current?.querySelector('.step.now'); if (n) n.scrollIntoView({ block: 'center' }); }, [c?.id]);
  const [notes, setNotes] = useState({}); const nt = useRef();
  const saveNote = (id, v) => { setNotes(x => ({ ...x, [id]: v })); clearTimeout(nt.current); nt.current = setTimeout(() => patch('/api/tasks/' + id, { notes: v }).catch(e => toast(e.message)), 600); };

  const togglePt = async (x, i, on) => {
    const pts = x.points.map((q, j) => j === i ? { ...q, done: on } : q);
    await patch('/api/tasks/' + x.id, { points: pts });
    if (pts.every(q => q.done) && x.status !== 'done') await post(`/api/tasks/${x.id}/done`, {});
    else if (!on && x.status === 'done') await post(`/api/tasks/${x.id}/done`, { done: false });
    load(['tasks', 'plan']);
  };
  const ItemRow = ({ x, points }) => {
    const on = x.status === 'done', isCur = curTask && curTask.id === x.id, run = plan?.active?.task_id === x.id;
    const act = async fn => { try { await fn(); await load(['tasks', 'plan']); } catch (e) { toast(e.message); } };
    return html`<li class=${'itm' + (on ? ' done' : '') + (isCur ? ' cur' : '')}>
      <div class="ih"><input type="checkbox" checked=${on} onChange=${e => act(() => post(`/api/tasks/${x.id}/done`, { done: e.target.checked }))}/>
        <span class="in">${x.meta?.n || ''}</span><span class="it" onClick=${() => openTask(x.id)}>${x.title}${run ? html` <span class="chip warn">${plan.active.mode === 'r' ? 'Research' : 'In progress'}</span>` : ''}</span>
        <span class="im">${!on && (x.auto ? (x.sched?.first ? when(x.sched.first) : '') : 'Someday')}
          <span class="dur" onClick=${async () => { const r = await askMinutes(`Planned time for “${x.title.slice(0, 60)}” (used ${dh(x.spent)})`, [60, 90, 120, 150, 180, 240], x.duration); if (r?.m >= 15) act(() => patch('/api/tasks/' + x.id, { duration: r.m })); }}>${dh(x.duration)}</span>
          ${!on && html`<button class="sk" title="Postpone" onClick=${() => moveDialog({ taskId: x.id, period: 0, title: x.title })}>${I('forward', 14)}</button>`}
          ${!on && !isCur && html`<button class="sk" title="Start" onClick=${() => act(async () => { await post(`/api/tasks/${x.id}/next`); await post('/api/timer/start', { task: x.id }); })}>${I('play', 14)}</button>`}
        </span></div>
      ${points && !on && x.points?.length ? html`<ul class="ptk sm">${x.points.map((q, i) => html`<li class=${q.done ? 'ok' : ''}><label><input type="checkbox" checked=${q.done} onChange=${e => togglePt(x, i, e.target.checked)}/><span>${q.t}</span></label></li>`)}</ul>` : ''}
      ${x.meta?.f && !on ? html`<div class="hint" style="margin-left:80px">${x.meta.f}</div>` : ''}
    </li>`;
  };

  const [dAll, nAll] = chapters.reduce((a, ch) => { const [d, n] = count(ch); return [a[0] + d, a[1] + n]; }, [0, 0]);
  return html`<div class="ol">
    <section>
      <div class="row" style="justify-content:space-between;margin-bottom:6px"><h2 style="margin:0">${L1 === 'Category' ? 'Categories' : L1 + 's'}</h2><button class="icon" title="Project Settings" onClick=${() => projectSettings(p)}>${I('gear', 16)}</button></div>
      <div class="hint" style="margin:0 10px 10px">${dAll} of ${nAll}</div>
      ${chapters.map((ch, k) => { const [d, n] = count(ch);
        return html`<button class=${'rc' + (ch === c ? ' sel' : '') + (n && d === n ? ' full' : '') + (ch === curCh ? ' cur' : '')} onClick=${() => pick(ch.id)}>
          <div class="t"><span class="n">${ch.meta?.num}</span><span>${ch.meta?.short || ch.title}<span class="here" title="Current chapter"></span></span><span class="c">${d}/${n}</span></div>
          ${ch.meta?.thread && html`<div class="h">${ch.meta.thread}</div>`}<div class="bar"><i style=${{ width: (n ? 100 * d / n : 0) + '%' }}></i></div></button>`; })}
      <button class=${'rc notes' + (allNotes ? ' sel' : '')} onClick=${() => pick(-1)}><div class="t"><span class="n">${I('list', 14)}</span><span>All Notes</span><span class="c">${chapters.filter(ch => ch.notes?.trim()).length || ''}</span></div></button>
      <p><button class="ghost" onClick=${() => addNode(p, null, 'chapter')}>${I('plus', 15)}Add ${L1}</button></p>
    </section>
    <section class="chap" ref=${chap}>
      <select class="chsel" value=${allNotes ? -1 : c?.id} onChange=${e => pick(+e.target.value)}>${chapters.map(ch => { const [d, n] = count(ch); return html`<option value=${ch.id}>${ch.meta?.num} ${ch.meta?.short || ch.title} (${d}/${n})</option>`; })}<option value="-1">All Notes</option></select>
      <div class="chadd"><button class="ghost" onClick=${() => addNode(p, null, 'chapter')}>${I('plus', 15)}Add ${L1}</button>${c && !c.virtual && html`<button class="ghost" onClick=${() => editNode(p, c, chapters.filter(x => !x.virtual))}>Edit ${L1}</button>`}</div>
      ${allNotes ? html`<h3>Notes</h3>${chapters.filter(ch => !ch.virtual).map(ch => html`<div class="sticky"><div class="sticky-h" onClick=${() => pick(ch.id)}>${ch.meta?.num && ch.meta.num !== '+' ? ch.meta.num + ' · ' : ''}${ch.meta?.short || ch.title}</div>
          <${NoteArea} id=${ch.id} value=${notes[ch.id] ?? ch.notes} onSave=${saveNote}/>
          ${kids(ch.id).filter(x => lvl(x) === 'section' && (notes[x.id] ?? x.notes)?.trim()).map(x => html`<div class="sticky mini has"><div class="sticky-h sm">${x.meta?.sid ? x.meta.sid + ' · ' : ''}${x.title}</div><${NoteArea} id=${x.id} value=${notes[x.id] ?? x.notes} onSave=${saveNote} small/></div>`)}</div>`)}`
      : !c ? html`<div class="empty"><button class="pri" onClick=${() => addNode(p, null, 'chapter')}>${I('plus', 16)}Add ${L1}</button></div>` : html`
      <div class="chh"><h3>${c.meta?.num && c.meta.num !== 'A' && c.meta.num !== '+' ? html`<span class="cn">${L1} ${c.meta.num}</span> · ` : ''}${c.title}</h3>
        ${!c.virtual && html`<button class="icon" title=${'Edit ' + L1} onClick=${() => editNode(p, c, chapters.filter(x => !x.virtual))}>${I('more', 20, { w: 3.4 })}</button>`}</div>
      <ul class="flow">
        ${prev?.meta?.out && html`<li class="in"><b>From ${prev.meta.num} ${prev.meta.short}</b>${prev.meta.out}</li>`}
        ${c.meta?.role && html`<li class="role"><b>Purpose</b>${c.meta.role}</li>`}
        ${c.meta?.out && html`<li class="out"><b>Leads to${next ? ` ${next.meta?.num} ${next.meta?.short}` : ''}</b>${c.meta.out}</li>`}
      </ul>
      ${!c.virtual && html`<div class="sticky"><div class="sticky-h">Notes</div><${NoteArea} id=${c.id} value=${notes[c.id] ?? c.notes} onSave=${saveNote}/></div>`}
      <ol class="steps">${secs.map(s => {
        if (lvl(s) !== 'section') return html`<li class="step"><div class="sdot">•</div><div class="scard"><ul class="items"><${ItemRow} x=${s} points/></ul></div></li>`;
        const L = itemsOf(s), d = L.filter(x => x.status === 'done').length, done = L.length && d === L.length, now = s === f;
        const left = L.filter(x => x.status !== 'done').reduce((a, x) => a + (x.sched?.remaining ?? Math.max(0, x.duration - x.spent)), 0);
        const nx = L.find(x => x.status !== 'done' && x.sched?.first);
        const run = plan?.active && L.some(x => x.id === plan.active.task_id);
        return html`<li class=${'step' + (done ? ' done' : '') + (now ? ' now' : '')} onClick=${e => { if (!e.target.closest('input,button,summary,.it,.dur,label,textarea')) setFocusSec(s.id); }}>
          <div class="sdot">${done ? I('check', 16, { w: 2.6 }) : (s.meta?.sid || '').replace(/^A\./, 'A')}</div>
          <div class="scard">
            <div class="hd"><span class="tt">${s.title}</span><button class="icon sedit" title=${'Edit ' + L2} onClick=${() => editNode(p, s, secs.filter(x => lvl(x) === 'section'))}>${I('more', 18, { w: 3.4 })}</button><span class="meta">${d} of ${L.length}${done ? '' : ' · ' + dh(left)}<br/>${!done && nx ? when(nx.sched.first) : ''}</span></div>
            ${s.meta?.warn && !done && html`<div class="w">${s.meta.warn}</div>`}
            <ul class="items">${L.map(x => html`<${ItemRow} key=${x.id} x=${x} points=${now || !done}/>`)}</ul>
            ${s.meta?.pts?.length ? html`<details class="rtp"><summary>Key Points</summary><ul>${s.meta.pts.map(q => html`<li>${q}</li>`)}</ul></details>` : ''}
            <div class=${'sticky mini' + ((notes[s.id] ?? s.notes) ? ' has' : '')}><${NoteArea} id=${s.id} value=${notes[s.id] ?? s.notes} onSave=${saveNote} small/></div>
            <button class="ghost" style="font-size:12px;color:var(--muted)" onClick=${() => addNode(p, s, 'item')}>Add Item</button>
          </div></li>`; })}</ol>
      <p>${!c.virtual && html`<button class="ghost" onClick=${() => addNode(p, c, 'section')}>${I('plus', 15)}Add ${L2}</button>`}<button class="ghost" onClick=${() => addNode(p, c.virtual ? null : c, 'item')}>${I('plus', 15)}Add Item</button></p>
`}
    </section>
    <section>${plan && html`<${FocusCard} plan=${plan} big=${false}/><${IntrBar} plan=${plan} cols=${3}/><${Timeline} plan=${plan} date=${Date.now()}/><${FinishLines} plan=${plan}/>`}</section>
  </div>`;
}
