// Files: the attachments of the folders in your Vikunja projects ("Dokumente & Infos" bucket), in a panel on the right.
// A click shows the file (PDF, images, text, audio, video) in a preview; anything else downloads.
import { html, useState, useEffect, useRef, S, api, openModal, toast } from './lib.js';
import { I } from './icons.js';

const size = b => b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? Math.round(b / 1e3) + ' KB' : (b || 0) + ' B';
const kind = m => /^application\/pdf/.test(m) ? 'pdf' : /^image\/(png|jpe?g|gif|webp|heic|avif)/.test(m) ? 'img' : /^text\/plain/.test(m) ? 'text' : /^video\//.test(m) ? 'video' : /^audio\//.test(m) ? 'audio' : null;
const urlOf = (acc, folder, f, vp) => `/api/files/${acc}/${folder}/${f.id}?p=${vp}`;

function preview(acc, folder, f, vp) {
  const u = urlOf(acc, folder, f, vp), k = kind(f.mime);
  if (!k) { location.href = u + '&download=1'; return; }
  openModal(close => html`<div class="modal filepv"><h3>${f.name}</h3>
    <div class="pvbody">${k === 'img' ? html`<img src=${u} alt=""/>` : k === 'video' ? html`<video src=${u} controls></video>` : k === 'audio' ? html`<audio src=${u} controls></audio>` : html`<iframe src=${u} title=${f.name}></iframe>`}</div>
    <div class="acts"><span class="hint grow">${size(f.size)}</span><a class="btn" href=${u} target="_blank" rel="noopener">Open</a><a class="btn" href=${u + '&download=1'}>Download</a><button class="pri" onClick=${() => close()}>Done</button></div></div>`);
}

// a name for the new folder (the item in the files bucket that holds the file)
const askName = def => openModal(close => { const B = () => { const [v, setV] = useState(def); return html`<div class="modal sm"><h3>New Item</h3>
  <input type="text" style="width:100%" value=${v} onInput=${e => setV(e.target.value)} onKeyDown=${e => e.key === 'Enter' && v.trim() && close(v.trim())} ref=${el => el && !el.dataset.f && (el.dataset.f = 1, el.focus(), el.select())}/>
  <div class="acts"><button onClick=${() => close(null)}>Cancel</button><button class="pri" disabled=${!v.trim()} onClick=${() => close(v.trim())}>Upload</button></div></div>`; }; return html`<${B}/>`; });
async function upload(project, file, folder) {
  const name = folder ? '' : await askName(file.name.replace(/\.[^.]+$/, ''));
  if (!folder && !name) return false;
  const q = new URLSearchParams({ project: project.id, file: file.name, mime: file.type || '', ...(folder ? { folder } : { name }) });
  const r = await fetch('/api/files/upload?' + q, { method: 'POST', credentials: 'same-origin', headers: { 'x-sc': '1', 'content-type': 'application/octet-stream' }, body: file });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
  return true;
}

// only on a Vikunja project's page, with that project's files
export function FilesButton({ project }) {
  const [open, setOpen] = useState(false);
  if (project?.ext_source !== 'vikunja') return null;
  return html`<button class="icon" title="Files" onClick=${() => setOpen(!open)}>${I('folder', 20)}</button>${open && html`<${FilesPanel} project=${project} close=${() => setOpen(false)}/>`}`;
}

function FilesPanel({ project, close }) {
  const [data, setData] = useState(null), [shut, setShut] = useState(() => { try { return JSON.parse(localStorage.getItem('files-shut') || '{}'); } catch { return {}; } });
  const get = fresh => api(`/api/files?project=${project.id}` + (fresh ? '&fresh=1' : '')).then(setData).catch(e => { toast(e.message); setData([]); });
  useEffect(() => { get(false); const k = e => e.key === 'Escape' && close(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  const flip = k => { const n = { ...shut, [k]: !shut[k] }; setShut(n); try { localStorage.setItem('files-shut', JSON.stringify(n)); } catch {} };
  const one = (data || []).flatMap(a => a.projects).length <= 1;
  const pickRef = useRef(), into = useRef(null), [busy, setBusy] = useState(false);
  const pick = folder => { into.current = folder; pickRef.current.value = ''; pickRef.current.click(); };
  const picked = async e => { const f = e.target.files?.[0]; if (!f) return;
    setBusy(true); try { if (await upload(project, f, into.current)) { toast('Uploaded'); await get(true); } } catch (x) { toast(x.message); } setBusy(false); };
  return html`<div class="filesbg" onClick=${close}></div><aside class="files">
    <div class="fhead"><b class="grow">Files</b><input type="file" ref=${pickRef} style="display:none" onChange=${picked}/><button class="icon" title="Upload" disabled=${busy} onClick=${() => pick(null)}>${I('plus', 16)}</button><button class="icon" title="Reload" onClick=${() => { setData(null); get(true); }}>${I('repeat', 16)}</button><button class="icon" title="Close" onClick=${close}>${I('x', 16)}</button></div>
    <div class="flist">${data == null ? html`<p class="hint">Loading…</p>` : !data.some(a => a.projects.length) ? html`<p class="hint">${data.find(a => a.error)?.error || 'No files'}</p>`
      : data.map(a => html`${a.projects.map(p => { const pk = a.account + ':' + p.id; return html`
        ${!one && html`<button class="fproj" onClick=${() => flip(pk)}>${I(shut[pk] ? 'right' : 'down', 14)}<span class="grow">${p.title}</span></button>`}
        ${(one || !shut[pk]) && p.folders.map(fo => html`<div class="ffolder"><div class="fname"><span class="grow">${fo.title}</span><button class="icon" title="Add File" disabled=${busy} onClick=${() => pick(fo.id)}>${I('plus', 14)}</button></div>
          ${fo.files.length ? fo.files.map(f => html`<button class="ffile" title=${f.name} onClick=${() => preview(a.account, fo.id, f, p.id)}>
            <span class="fic">${(f.name.split('.').pop() || '').slice(0, 4).toUpperCase()}</span><span class="grow fn">${f.name}</span><span class="hint">${size(f.size)}</span></button>`) : html`<div class="hint" style="padding:2px 8px">Empty</div>`}</div>`)}`; })}`)}</div>
  </aside>`;
}
