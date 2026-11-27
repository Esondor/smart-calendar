// The notification center: a bell at the top, a panel like Files. Requests to answer (a guest's own time, a time a
// project member booked for you, a project invitation) with Accept / Decline, clashes to decide, and things to know.
// Clear All takes away what needs no answer.
import { html, useState, useEffect, S, post, load, toast, go, when } from './lib.js';
import { I } from './icons.js';
import { ClashCard } from './eventsheet.js';

export const inboxCount = st => { const x = st.inbox; return x ? x.items.length + x.requests.length + (x.clashes?.items?.length || 0) : (st.requests || []).length; };

export function InboxButton() {
  const [open, setOpen] = useState(false), n = inboxCount(S.state);
  return html`<button class=${'icon inboxb' + (open ? ' on' : '')} title="Notifications" aria-label="Notifications" onClick=${() => { setOpen(!open); if (!open) load(['inbox']); }}>
      ${I('bell', 20)}${n > 0 && html`<i class="badge">${n > 9 ? '9+' : n}</i>`}</button>
    ${open && html`<${Panel} close=${() => setOpen(false)}/>`}`;
}

function Panel({ close }) {
  const x = S.state.inbox, [busy, setBusy] = useState(false);
  useEffect(() => { const k = e => e.key === 'Escape' && close(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  const act = async fn => { if (busy) return; setBusy(true); try { const r = await fn(); if (r && r.items) S.set({ inbox: r }); else await load(['inbox']); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const answer = (it, yes) => act(async () => { const r = await post('/api/inbox/' + it.id, { yes }); load(['plan']); return r; });
  const drop = it => act(() => post('/api/inbox/' + it.id, {}));
  const invite = (r, accept) => act(async () => { const y = await post('/api/requests/' + r.id, { accept }); await load(['requests', 'boot', 'projects', 'tasks', 'plan']); if (y.joined) { close(); go('#/project/' + y.joined); } });
  const ask = x ? [...x.requests.map(r => ({ inv: r })), ...x.items.filter(i => i.kind === 'booking' || i.kind === 'hold')] : [];
  const info = x ? x.items.filter(i => i.kind !== 'booking' && i.kind !== 'hold') : [];
  const clashes = x?.clashes?.items || [], empty = x && !ask.length && !info.length && !clashes.length;
  const row = (ic, title, sub, at, btns) => html`<div class="nrow">${I(ic, 17)}<div class="nt"><b>${title}</b>${sub && html`<span>${sub}</span>`}${at && html`<time>${when(at)}</time>`}</div>${btns}</div>`;
  return html`<div class="filesbg" onClick=${close}></div><aside class="files inbox">
    <div class="fhead"><b class="grow">Notifications</b>${(info.length > 0 || clashes.length > 0) && html`<button class="clearall" disabled=${busy} onClick=${() => act(() => post('/api/inbox/clear'))}>Clear All</button>`}
      <button class="icon" title="Close" onClick=${close}>${I('x', 16)}</button></div>
    <div class="flist">
      ${x == null ? '' : empty ? html`<p class="hint" style="padding:8px">Nothing new</p>` : ''}
      ${ask.length > 0 && html`<div class="tday">To answer</div><div class="tgroup">${ask.map(it => it.inv
        ? row('people', `${it.inv.from_name} invites you to ${it.inv.project}`, '', it.inv.created_at, html`<div class="nbtn"><button onClick=${() => invite(it.inv, false)}>Decline</button><button class="pri" onClick=${() => invite(it.inv, true)}>Accept</button></div>`)
        : row(it.kind === 'hold' ? 'people' : 'calendar', it.title, it.body, it.at, html`<div class="nbtn"><button onClick=${() => answer(it, false)}>Decline</button><button class="pri" onClick=${() => answer(it, true)}>${it.kind === 'hold' ? 'Keep' : 'Accept'}</button></div>`))}</div>`}
      ${clashes.length > 0 && html`<div class="tday">Clashes</div>${clashes.map(c => html`<${ClashCard} c=${c} tag=${x.clashes.tag} onChange=${() => load(['inbox', 'plan'])}/>`)}`}
      ${info.length > 0 && html`<div class="tday">New</div><div class="tgroup">${info.map(it => row('bell', it.title, it.body, it.at, html`<button class="icon" title="Remove" onClick=${() => drop(it)}>${I('x', 14)}</button>`))}</div>`}
    </div></aside>`;
}
