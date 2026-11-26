// Order view: the order a project is worked through (for a thesis: the writing order), in phases.
// Drag a section or task by its handle to move it, a phase by its handle to move the whole phase. The planner follows this order.
import { html, useState, useEffect, useRef, S, api, load, toast, dh, SH, DN, openModal } from './lib.js';
import { I } from './icons.js';

const uid = () => Math.random().toString(36).slice(2, 9);
const day = ms => `${DN[new Date(ms).getDay()]} ${SH(ms)}`;
const ask = (title, value = '') => openModal(close => { const B = () => { const [v, setV] = useState(value); return html`<div class="modal sm"><h3>${title}</h3>
  <input type="text" style="width:100%" value=${v} onInput=${e => setV(e.target.value)} onKeyDown=${e => e.key === 'Enter' && close(v)}/>
  <div class="acts"><button onClick=${() => close(null)}>Cancel</button><button class="pri" onClick=${() => close(v)}>OK</button></div></div>`; }; return html`<${B}/>`; });

export default function OrderView({ p }) {
  const st = S.state, ref = useRef(), dragging = useRef(false);
  const [phases, setPhases] = useState(null), [drag, setDrag] = useState(null);
  const fetchOrder = () => api(`/api/projects/${p.id}/order`).then(r => { if (!dragging.current) setPhases(r.phases.map(ph => ({ k: uid(), name: ph.name, units: ph.units }))); }).catch(e => toast(e.message));
  useEffect(() => { fetchOrder(); }, [p.id, st.tasks]);
  if (!phases) return html`<div class="wo"></div>`;

  // what each unit is: its leaves (items), work left, when it is planned
  const all = st.tasks.filter(t => t.project_id === p.id), byId = new Map(all.map(t => [t.id, t]));
  const kids = id => all.filter(t => t.parent_id === id);
  const leaves = t => { const k = kids(t.id); return k.length ? k.flatMap(x => kids(x.id).length ? kids(x.id) : [x]) : [t]; };
  const info = id => {
    const t = byId.get(id); if (!t) return null;
    const L = leaves(t), open = L.filter(x => x.status !== 'done');
    const left = open.reduce((a, x) => a + Math.max(0, (x.duration || 0) - (x.spent || 0)), 0);
    const firsts = open.map(x => x.sched?.first).filter(Boolean), ends = open.map(x => x.sched?.end).filter(Boolean);
    const ch = t.parent_id && byId.get(t.parent_id), chName = ch && (ch.meta?.short || ch.title);
    const num = t.meta?.sid || (t.meta?.level === 'chapter' ? t.meta?.num : '');
    return { t, num, ch: chName, done: !open.length, left, first: firsts.length ? Math.min(...firsts) : null, end: ends.length ? Math.max(...ends) : null, late: open.some(x => x.sched?.late), parts: [L.length - open.length, L.length] };
  };

  // flat list of rows: "p:<phase>" headers and "u:<id>" units; dragging reorders it live
  const flat = phases.flatMap(ph => ['p:' + ph.k, ...ph.units.map(id => 'u:' + id)]);
  const list = drag?.list || flat;
  const unflat = L => { const out = []; for (const k of L) { if (k.startsWith('p:')) out.push({ ...phases.find(ph => ph.k === k.slice(2)), units: [] }); else out[out.length - 1].units.push(+k.slice(2)); } return out; };
  const save = async next => {
    setPhases(next);
    try { await api(`/api/projects/${p.id}/order`, { method: 'PUT', body: { phases: next.map(ph => ({ name: ph.name, units: ph.units })) } }); load(['tasks', 'plan']); }
    catch (e) { toast(e.message); fetchOrder(); }
  };
  const blockOf = (L, k) => { if (!k.startsWith('p:')) return [k]; const i = L.indexOf(k); let j = i + 1; while (j < L.length && !L[j].startsWith('p:')) j++; return L.slice(i, j); };
  const down = k => e => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); dragging.current = true; setDrag({ key: k, list: flat, block: blockOf(flat, k) }); };
  const move = e => {
    if (!drag) return;
    const sc = ref.current, b = sc.getBoundingClientRect();
    if (e.clientY < b.top + 48) sc.scrollTop -= 14; else if (e.clientY > b.bottom - 48) sc.scrollTop += 14;
    const rows = [...sc.querySelectorAll('[data-k]')].filter(r => !drag.block.includes(r.dataset.k));
    const raw = rows.filter(r => { const x = r.getBoundingClientRect(); return x.top + x.height / 2 < e.clientY; }).length;
    const R = drag.list.filter(k => !drag.block.includes(k));
    let idx;
    if (drag.key.startsWith('p:')) {   // a phase lands between phases
      const cand = [...R.map((k, j) => k.startsWith('p:') ? j : -1).filter(j => j >= 0), R.length];
      idx = cand.reduce((a, c) => Math.abs(c - raw) < Math.abs(a - raw) ? c : a, cand[0]);
    } else idx = Math.max(1, raw);       // a unit always belongs to a phase
    const L = [...R.slice(0, idx), ...drag.block, ...R.slice(idx)];
    if (L.join() !== drag.list.join()) setDrag({ ...drag, list: L });
  };
  const up = () => { if (!drag) return; const L = drag.list; setDrag(null); dragging.current = false; if (L.join() !== flat.join()) save(unflat(L)); };
  const handle = (k, label) => html`<button class="icon handle" aria-label=${'Move ' + label} onPointerDown=${down(k)} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}>${I('menu', 16)}</button>`;

  const rename = async ph => { const n = await ask('Phase', ph.name); if (n?.trim()) save(phases.map(x => x === ph ? { ...x, name: n.trim() } : x)); };
  const remove = ph => { const i = phases.indexOf(ph), into = i > 0 ? i - 1 : 1; if (phases.length < 2) return;
    save(phases.map((x, j) => j === into ? { ...x, units: into < i ? [...x.units, ...ph.units] : [...ph.units, ...x.units] } : x).filter(x => x !== ph)); };
  const addPhase = async () => { const n = await ask('New Phase'); if (n?.trim()) save([...phases, { k: uid(), name: n.trim(), units: [] }]); };

  // render the (possibly reordered) list grouped by phase
  const groups = []; let n = 0;
  for (const k of list) { if (k.startsWith('p:')) groups.push({ ph: phases.find(x => x.k === k.slice(2)), units: [] }); else groups[groups.length - 1]?.units.push(+k.slice(2)); }
  return html`<div class="wo" ref=${ref}>
    ${groups.map(({ ph, units }) => {
      const I_ = units.map(info).filter(Boolean), left = I_.reduce((a, x) => a + x.left, 0);
      const f = I_.map(x => x.first).filter(Boolean), e = I_.map(x => x.end).filter(Boolean), span = f.length ? (day(Math.min(...f)) + (Math.max(...e) - Math.min(...f) > 864e5 ? ' – ' + day(Math.max(...e)) : '')) : '';
      const done = I_.length && I_.every(x => x.done);
      return html`<div class=${'wo-ph' + (drag?.block.includes('p:' + ph.k) ? ' drag' : '') + (done ? ' done' : '')}>
        <div class="wo-h" data-k=${'p:' + ph.k} key=${'p:' + ph.k}>
          <button class="wo-name" onClick=${() => rename(ph)}>${ph.name}</button>
          <span class="hint">${done ? 'Done' : [left ? dh(left) : '', span].filter(Boolean).join(' · ')}</span>
          <span class="grow"></span>
          ${!units.length && phases.length > 1 && html`<button class="icon" title="Remove" aria-label="Remove phase" onClick=${() => remove(ph)}>${I('x', 14)}</button>`}
          ${handle('p:' + ph.k, ph.name)}
        </div>
        <div class="wo-list">${I_.map(x => { n++; const k = 'u:' + x.t.id;
          return html`<div class=${'wo-u' + (drag?.key === k ? ' drag' : '') + (x.done ? ' done' : '')} data-k=${k} key=${k}>
            <span class="wo-n">${x.done ? I('check', 14) : n}</span>
            <span class="wo-t"><b>${x.num ? x.num + ' ' : ''}${x.t.title}</b>${x.ch && html`<em>${x.ch}</em>`}</span>
            <span class="wo-m">${x.done ? '' : html`${dh(x.left)}${x.first ? html`<i class=${x.late ? 'late' : ''}>${day(x.first)}</i>` : ''}`}</span>
            ${handle(k, x.t.title)}</div>`; })}</div>
      </div>`; })}
    <button class="ghost wo-add" onClick=${addPhase}>${I('plus', 15)}Add Phase</button>
  </div>`;
}
