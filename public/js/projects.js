// Projects overview (main entry on the phone)
import { html, S, Avatar, go } from './lib.js';
import { I } from './icons.js';
import { projectSettings } from './board.js';

export default function ProjectsView() {
  const st = S.state, open = st.tasks.filter(t => t.status !== 'done' && !['chapter', 'section'].includes(t.meta?.level));
  const P = st.projects.filter(p => !p.archived), A = st.projects.filter(p => p.archived);
  const row = p => { const n = open.filter(t => t.project_id === p.id).length, late = open.filter(t => t.project_id === p.id && t.sched?.late).length;
    return html`<a class="prow" href=${'#/project/' + p.id}>
      <span class="pdot" style=${{ background: p.color }}>${I(p.kind === 'outline' ? 'list' : 'board', 16)}</span>
      <span class="grow"><b>${p.name}</b>${p.ext_source === 'vikunja' ? html`<span class="hint"> · Vikunja</span>` : ''}</span>
      ${p.members.length > 1 ? html`<span class="avs">${p.members.slice(0, 3).map(m => html`<${Avatar} id=${m.id}/>`)}</span>` : ''}
      ${late ? html`<span class="chip late">${late}</span>` : ''}<span class="hint" style="min-width:24px;text-align:right">${n || ''}</span>${I('right', 16)}</a>`; };
  return html`<div class="list" style="max-width:720px">
    <div class="tgroup">${P.map(row)}</div>
    <button class="ghost" style="margin:10px 4px" onClick=${() => projectSettings(null)}>${I('plus', 16)}New Project</button>
    ${A.length > 0 && html`<div class="lgrp"><h3>Archived</h3></div><div class="tgroup">${A.map(row)}</div>`}
  </div>`;
}
