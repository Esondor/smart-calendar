// A shared project: when the other members are planned to work on its tasks. Only this project's blocks,
// nothing else of their calendars; and nothing of it goes into your own calendar.
import { html, useState, useEffect, S, api, toast, Avatar, DN, SH, userById } from './lib.js';
import { openTask } from './taskedit.js';
import { I } from './icons.js';

const hm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dayKey = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return +d; };

export function TeamButton({ p }) {
  const [open, setOpen] = useState(false);
  if (!p || p.members.length < 2) return null;
  return html`<button class=${'icon' + (open ? ' on' : '')} title="Others' Plan" aria-label="Others' plan" onClick=${() => setOpen(!open)}>${I('eye', 20)}</button>
    ${open && html`<${TeamPanel} p=${p} close=${() => setOpen(false)}/>`}`;
}

function TeamPanel({ p, close }) {
  const [data, setData] = useState(null);
  useEffect(() => { api(`/api/projects/${p.id}/team`).then(setData).catch(e => { toast(e.message); setData({ blocks: [] }); }); }, [p.id, S.state.plan]);
  useEffect(() => { const k = e => e.key === 'Escape' && close(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  const days = [];
  for (const b of data?.blocks || []) { const k = dayKey(b.start); let d = days.find(x => x.k === k); if (!d) days.push(d = { k, items: [] }); d.items.push(b); }
  const today = dayKey(Date.now());
  return html`<div class="filesbg" onClick=${close}></div><aside class="files team">
    <div class="fhead"><b class="grow">Others' Plan</b><button class="icon" title="Close" onClick=${close}>${I('x', 16)}</button></div>
    <div class="flist">${data == null ? '' : !days.length ? html`<p class="hint">Nothing planned</p>`
      : days.map(d => html`<div class="tday">${d.k === today ? 'Today' : d.k === today + 864e5 ? 'Tomorrow' : `${DN[new Date(d.k).getDay()]} ${SH(d.k)}`}</div>
        ${d.items.map(b => html`<button class="ffile" onClick=${() => openTask(b.task)}>
          <${Avatar} id=${b.user}/><span class="grow fn">${b.title}</span><span class="hint">${hm(b.start)}–${hm(b.end)}</span></button>`)}`)}</div>
  </aside>`;
}
