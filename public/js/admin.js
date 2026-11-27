// Admin panel: server setup, users + roles, access policy, IP bans, audit log, system log, status.
import { html, useState, useEffect, useRef, S, api, post, patch, del, load, toast, confirmDialog, openModal, when, Avatar , copyText, CopyRow, dh } from './lib.js';
import { I } from './icons.js';

const TABS = [['overview', 'Overview'], ['users', 'Users'], ['displays', 'Displays'], ['access', 'Security'], ['server', 'Server'], ['audit', 'Audit Log'], ['logs', 'System Log']];
const ago = ms => { if (!ms) return '–'; const s = (Date.now() - ms) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const bytes = n => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' kB';
const dur = ms => { const h = Math.floor(ms / 3600e3); return h > 48 ? `${Math.floor(h / 24)} days` : `${h} h ${Math.floor(ms / 60000) % 60} min`; };
const ask = (title, fields) => openModal(close => { const B = () => { const [v, setV] = useState(Object.fromEntries(fields.map(f => [f.k, f.v ?? '']))); return html`<div class="modal sm"><h3>${title}</h3>
  ${fields.map(f => html`<label style="display:block;margin:6px 0"><span class="hint">${f.l}</span><input style="width:100%" type=${f.t || 'text'} autocomplete="off" value=${v[f.k]} onInput=${e => setV({ ...v, [f.k]: e.target.value })}/></label>`)}
  <div class="acts"><button onClick=${() => close(null)}>Cancel</button><button class="pri" onClick=${() => close(v)}>OK</button></div></div>`; }; return html`<${B}/>`; });
const act = async (fn, msg, reload) => { try { const r = await fn(); if (msg) toast(msg); reload && reload(); return r; } catch (e) { toast(e.message); } };

// daily copy of the whole database into the backups folder
function Backups() {
  const [b, setB] = useState(null), [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/admin/backups').then(setB).catch(() => {}); }, []);
  if (!b) return null;
  const set = async (body, e) => { try { setB(await api('/api/admin/backups', { method: 'PUT', body })); toast('Saved'); } catch (x) { toast(x.message); if (e) e.target.value = b.dir; } };
  const last = b.last, kb = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
  return html`<div class="sect">Backups</div><div class="box">
    <div class="cell"><span>Last backup</span>${last?.error ? html`<span class="chip late" title=${last.error}>Failed</span>` : html`<span class="hint">${last ? when(last.at) + ' · ' + kb(last.size) : 'None yet'}</span>`}
      <button class="ghost" disabled=${busy} onClick=${async () => { setBusy(true); try { setB(await post('/api/admin/backups', {})); toast('Backup saved'); } catch (e) { toast(e.message); } finally { setBusy(false); } }}>Back Up Now</button></div>
    <div class="cell stack"><span>Folder</span><input style="width:320px" value=${b.dir} placeholder=${b.def}
      onChange=${e => set({ folder: e.target.value.trim() || 'backups' }, e)}/>${b.dir !== b.def && html`<button class="ghost" onClick=${() => set({ folder: 'backups' })}>Default</button>`}</div>
    <div class="cell"><span>Time</span><select value=${b.hour} onChange=${e => set({ hour: +e.target.value })}>${Array.from({ length: 24 }, (_, h) => html`<option value=${h}>${String(h).padStart(2, '0')}:00</option>`)}</select></div>
    <div class="cell"><span>Keep</span><select value=${b.keep} onChange=${e => set({ keep: +e.target.value })}>${[7, 14, 30, 60, 90, 180, 365].concat([7, 14, 30, 60, 90, 180, 365].includes(b.keep) ? [] : [b.keep]).map(d => html`<option value=${d}>${d} days</option>`)}</select></div>
    ${b.files.length > 0 && html`<details class="cell" style="display:block"><summary>${b.files.length} backups</summary>
      <table style="width:100%;margin-top:6px">${b.files.map(f => html`<tr><td><code style="font-size:13px">${f.file}</code></td><td class="hint" style="text-align:right">${kb(f.size)}</td></tr>`)}</table></details>`}
  </div>`;
}
function Overview({ go }) {
  const [s, setS] = useState(null);
  useEffect(() => { api('/api/admin/status').then(setS).catch(e => toast(e.message)); }, []);
  if (!s) return null;
  const proxyOk = s.socketIp !== s.yourIp || !/^(::ffff:)?(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(s.yourIp) || !s.forwardedFor;
  return html`
    <div class="kpis">
      <div class="kpi"><div class="v">${s.counts.users}</div><div class="l">Users</div></div>
      <div class="kpi"><div class="v">${s.counts.tasks}</div><div class="l">Tasks</div></div>
      <div class="kpi" style="cursor:pointer" onClick=${() => go('logs')}><div class=${'v' + (s.errors24h ? ' late' : ' ok')}>${s.errors24h}</div><div class="l">Errors today</div></div>
      <div class="kpi" style="cursor:pointer" onClick=${() => go('audit')}><div class=${'v' + (s.failedLogins24h > 5 ? ' late' : '')}>${s.failedLogins24h}</div><div class="l">Failed sign-ins</div></div>
      <div class="kpi" style="cursor:pointer" onClick=${() => go('access')}><div class="v">${s.counts.ip_bans}</div><div class="l">Blocked IPs</div></div>
      <div class="kpi"><div class="v">${s.counts.push_subs}</div><div class="l">Push devices</div></div>
    </div>
    <div class="sect">Server</div><div class="box"><table>
      <tr><td class="hint">Version</td><td>${s.version} · up ${dur(s.uptime)}</td></tr>
      <tr><td class="hint">Address</td><td>${s.baseUrl || '–'} ${s.https ? '' : html`<span class="chip warn">HTTP</span>`}</td></tr>
      <tr><td class="hint">Google</td><td>${s.google ? 'Active' : html`<a href="#" onClick=${e => { e.preventDefault(); go('server'); }}>Set up</a>`}</td></tr>
      <tr><td class="hint">Database</td><td>${bytes(s.dbSize)} · ${s.tz}</td></tr>
      <tr><td class="hint">Sync</td><td>Google: this week every ${s.sync.nearSec} s, next ${s.sync.farDays} days every ${s.sync.farSec / 60} min · ICS every ${s.sync.icsSec} s · Vikunja every ${s.sync.vikunjaSec} s</td></tr>
      <tr><td class="hint">Your IP</td><td>${s.yourIp} ${proxyOk ? '' : html`<span class="chip late">Proxy address – check TRUST_PROXY</span>`}</td></tr>
    </table></div>
    <${Backups}/>
    <div class="sect">Connections</div><div class="box">
      ${s.accounts.length ? html`<table style="width:100%">${s.accounts.map(a => html`<tr><td>${a.user}</td><td>${a.kind}</td><td>${a.label}</td>
        <td>${a.status === 'ok' ? '' : html`<span class="chip late" title=${a.error}>${a.status}</span>`}</td><td class="hint">${ago(a.last_sync)}</td></tr>
        ${a.status !== 'ok' && a.error ? html`<tr><td></td><td colspan="4" class="hint err">${a.error}</td></tr>` : ''}`)}</table>` : html`<p class="hint" style="margin:0">None</p>`}</div>`;
}

function Users() {
  const me = S.state.me, [list, setList] = useState([]), [open, setOpen] = useState(null), [sess, setSess] = useState([]);
  const reload = () => api('/api/admin/users').then(setList).then(() => load(['boot']));
  useEffect(() => { reload(); }, []);
  useEffect(() => { if (open) api(`/api/admin/users/${open}/sessions`).then(setSess); }, [open]);
  const add = async () => { const v = await ask('New User', [{ k: 'username', l: 'Username' }, { k: 'name', l: 'Name' }, { k: 'password', l: 'Password', t: 'password' }]);
    if (v) act(() => post('/api/admin/users', v), 'User created', reload); };
  return html`<div class="box"><div class="row"><span class="grow"></span><button class="pri" onClick=${add}>${I('plus', 15)}Add User</button></div>
    <table style="width:100%;border-collapse:collapse">
      <tr class="hint"><td></td><td>Name</td><td>Role</td><td>2FA</td><td>Last Sign-In</td><td>Sessions</td><td>Calendars</td><td></td></tr>
      ${list.map(u => html`<tr style=${{ borderTop: '1px solid var(--line)', opacity: u.disabled ? .55 : 1 }}>
        <td style="padding:6px 4px"><${Avatar} id=${u.id}/></td>
        <td><b>${u.name}</b> <span class="hint">@${u.username}</span>${u.id === me.id ? html` <span class="hint">· You</span>` : ''}${u.disabled ? html` <span class="chip late">Disabled</span>` : ''}</td>
        <td>${u.is_admin ? 'Administrator' : 'User'}</td>
        <td>${u.totp_on ? 'On' : ''}</td><td class="hint">${ago(u.last_login)}</td><td>${u.sessions}</td>
        <td class="hint">${(u.accounts || '').split(',').filter(Boolean).map(a => a.split(':')).map(([k, s]) => html`<span class=${'chip' + (s === 'ok' ? '' : ' late')}>${k}</span> `)}</td>
        <td style="text-align:right"><button class="ghost" onClick=${() => setOpen(open === u.id ? null : u.id)}>${open === u.id ? 'Done' : 'Edit'}</button></td></tr>
      ${open === u.id && html`<tr><td></td><td colspan="7" style="padding:6px 0 12px">
        <div class="row">
          ${u.id !== me.id && html`<button onClick=${() => act(() => patch('/api/admin/users/' + u.id, { is_admin: !u.is_admin }), u.is_admin ? 'Role changed' : 'Role changed', reload)}>${u.is_admin ? 'Make regular user' : 'Make admin'}</button>`}
          <button onClick=${async () => { const v = await ask(`New password for ${u.name}`, [{ k: 'password', l: 'Password', t: 'password' }]); if (v) act(() => post(`/api/admin/users/${u.id}/password`, v), 'Password set', reload); }}>Reset password</button>
          ${u.totp_on ? html`<button onClick=${async () => { if (await confirmDialog(`Reset 2FA for ${u.name}?`)) act(() => post(`/api/admin/users/${u.id}/reset-2fa`), '2FA reset', reload); }}>Reset 2FA</button>` : ''}
          <button onClick=${() => act(() => post(`/api/admin/users/${u.id}/revoke-sessions`), 'Signed out everywhere', () => { reload(); api(`/api/admin/users/${u.id}/sessions`).then(setSess); })}>Sign out everywhere</button>
          ${u.id !== me.id && html`<button onClick=${() => act(() => patch('/api/admin/users/' + u.id, { disabled: !u.disabled }), u.disabled ? 'Enabled' : 'Disabled', reload)}>${u.disabled ? 'Enable' : 'Disable'}</button>
            <button class="danger" onClick=${async () => { if (await confirmDialog(`Delete ${u.name}? Shared projects are kept.`, 'Delete', true)) act(() => del('/api/admin/users/' + u.id), 'Deleted', () => { setOpen(null); reload(); }); }}>Delete</button>`}
        </div>
        ${sess.length ? html`<ul class="feed" style="margin-top:8px">${sess.map(x => html`<li><time>${ago(x.last_seen)}</time><span class="grow">${x.ua?.replace(/\(.*?\)/, '').slice(0, 70) || 'Unknown'}</span><span class="hint">${x.ip || ''}</span></li>`)}</ul>` : html`<p class="hint">No active sessions.</p>`}
      </td></tr>`}`)}
    </table></div>`;
}

function Access() {
  const [p, setP] = useState(null), [bans, setBans] = useState([]), [allow, setAllow] = useState('');
  const reload = () => { api('/api/admin/policy').then(x => { setP(x); setAllow(x.allowlist.join(', ')); }); api('/api/admin/bans').then(setBans); };
  useEffect(() => { reload(); }, []);
  if (!p) return null;
  const save = q => act(() => api('/api/admin/policy', { method: 'PUT', body: q }), null, reload);
  const num = (k, w = 70) => html`<input type="number" value=${p[k]} style=${{ width: w + 'px' }} onChange=${e => save({ [k]: +e.target.value })}/>`;
  return html`
    <div class="sect">Sign-In</div><div class="box">
      <div class="cell"><span>Session length</span>${num('sessionDays')}<span class="hint">days</span></div>
      <div class="cell"><span>Minimum password length</span>${num('minPassword')}</div>
    </div>
    <div class="sect">Registration</div><div class="box">
      <div class="cell stack"><span>Registration password</span><input style="width:220px" placeholder="Off" value=${p.regPassword || ''} onChange=${e => save({ regPassword: e.target.value })}/>
        <button class="ghost" onClick=${() => { const A = 'abcdefghjkmnpqrstuvwxyz23456789'; save({ regPassword: Array.from(crypto.getRandomValues(new Uint8Array(12)), x => A[x % A.length]).join('').replace(/(.{4})(?=.)/g, '$1-') }); }}>New</button>
        ${p.regPassword && html`<button class="pri" onClick=${() => copyText(p.regPassword)}>Copy</button>`}</div>
      ${p.regPassword && html`<${CopyRow} label="Sign-up link" value=${location.origin + '/#/join'}/>`}
    </div>
    <div class="sect">Brute-Force Protection</div><div class="box">
      <div class="cell"><span>Failed attempts</span>${num('banAfter')}</div>
      <div class="cell"><span>Within</span>${num('banWindowMin')}<span class="hint">min</span></div>
      <div class="cell"><span>Block for</span>${num('banHours')}<span class="hint">h (0 = permanent)</span></div>
      <div class="cell stack"><span>Never block</span><input style="width:300px" placeholder="192.168.178." value=${allow} onInput=${e => setAllow(e.target.value)} onChange=${() => save({ allowlist: allow.split(',').map(x => x.trim()).filter(Boolean) })}/></div>
    </div>
    <div class="sect" style="display:flex;align-items:center">Blocked IPs<span class="grow"></span>
      <button class="ghost" style="text-transform:none" onClick=${async () => { const v = await ask('Block IP', [{ k: 'ip', l: 'IP address' }, { k: 'hours', l: 'Hours (0 = permanent)', v: '0' }, { k: 'reason', l: 'Reason' }]); if (v) act(() => post('/api/admin/bans', { ...v, hours: +v.hours }), 'Blocked', reload); }}>${I('plus', 15)}Block</button></div>
    <div class="box">${bans.length ? html`<table style="width:100%">${bans.map(b => html`<tr style="border-top:1px solid var(--line)"><td style="padding:7px 0"><code>${b.ip}</code></td><td class="hint">${b.reason}</td>
        <td class="hint">${b.until ? 'until ' + when(b.until) : 'permanent'}</td><td class="hint">${b.hits} requests</td>
        <td style="text-align:right"><button class="ghost" onClick=${() => act(() => del('/api/admin/bans/' + encodeURIComponent(b.ip)), 'Unblocked', reload)}>Unblock</button></td></tr>`)}</table>`
      : html`<p class="hint" style="margin:0">None</p>`}</div>`;
}

function LogTable({ kind }) {
  const [rows, setRows] = useState([]), [f, setF] = useState(''), [more, setMore] = useState(true);
  const url = before => kind === 'audit' ? `/api/admin/audit?limit=200${f ? '&kind=' + encodeURIComponent(f) : ''}${before ? '&before=' + before : ''}` : `/api/admin/logs?limit=300${f ? '&level=' + f : ''}${before ? '&before=' + before : ''}`;
  const reload = () => api(url()).then(r => { setRows(r); setMore(r.length >= 200); });
  useEffect(() => { reload(); }, [f]);
  const KINDS = [['', 'All'], ['login', 'Sign-ins'], ['login.fail', 'Failed'], ['user', 'Users'], ['ip', 'Bans'], ['policy', 'Policy'], ['account', 'Calendars']];
  const LV = [['', 'All'], ['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Info']];
  return html`<div class="box">
    <div class="filters"><div class="seg">${(kind === 'audit' ? KINDS : LV).map(([k, l]) => html`<button class=${f === k ? 'on' : ''} onClick=${() => setF(k)}>${l}</button>`)}</div><span class="grow"></span><button class="icon" title="Refresh" onClick=${reload}>${I('repeat', 16)}</button></div>
    <table style="width:100%;font-size:13.5px;border-collapse:collapse">
      ${rows.map(r => kind === 'audit' ? html`<tr style="border-top:1px solid var(--line)"><td class="hint" style="white-space:nowrap;padding:4px 8px 4px 0">${when(r.at)}</td>
          <td><span class=${'chip' + (/fail|^ip\.ban|disable|delete|blocked/.test(r.kind) ? ' late' : '')}>${r.kind}</span></td><td>${r.actor || ''}${r.target && r.target !== r.actor ? html` · <b>${r.target}</b>` : ''}</td><td class="hint">${r.detail}</td><td class="hint"><code>${r.ip || ''}</code></td></tr>`
        : html`<tr style="border-top:1px solid var(--line)"><td class="hint" style="white-space:nowrap;padding:4px 8px 4px 0">${when(r.at)}</td>
          <td><span class=${'chip' + (r.level === 'error' ? ' late' : r.level === 'warn' ? ' warn' : '')}>${r.level}</span></td><td class="hint">${r.src}</td><td>${r.msg}</td><td class="hint">${r.user || ''}</td></tr>`)}
    </table>
    ${!rows.length && html`<p class="hint">No entries</p>`}
    ${more && rows.length > 0 && html`<p><button class="ghost" onClick=${() => api(url(rows[rows.length - 1].at)).then(r => { setRows([...rows, ...r]); setMore(r.length >= 200); })}>Load More</button></p>`}
    </div>`;
}

// a real search with the saved key: suggestions, the address of the first hit, travel time from your home
function MapsTest({ save, dirty }) {
  const [q, setQ] = useState('Rathaus'), [r, setR] = useState(null), [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { if (dirty) await save(); setR(await post('/api/admin/maps/test', { q })); } catch (e) { setR({ ok: false, error: e.message }); } finally { setBusy(false); } };
  return html`<div class="cell"><span>Test</span><input value=${q} onInput=${e => setQ(e.target.value)} style="flex:0 1 160px"/><button class="ghost" disabled=${busy} onClick=${run}>Search</button></div>
    ${r && html`<div class="cell" style="display:block;font-size:14px">${r.ok
      ? html`<div>${r.suggestions.length} suggestions${r.suggestions[0] ? ': ' + r.suggestions.slice(0, 3).map(s => s.title).join(', ') : ''}</div>
          ${r.place && html`<div class="hint">${r.place.text}</div>`}
          ${r.travel ? html`<div class="hint">From home: ${r.travel.car ? 'car ' + dh(r.travel.car.min) : ''}${r.travel.bike ? ' · bike ' + dh(r.travel.bike.min) : ''}</div>` : html`<div class="hint">Travel time: set your Home in Settings → Planning</div>`}`
      : html`<div class="err" style="color:var(--late)">${r.error}</div>`}</div>`}`;
}
// each group saves only its own fields, so a password manager filling other fields never changes them
const NOFILL = { autocomplete: 'off', 'data-bwignore': 'true', 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-form-type': 'other' };
function ServerBox() {
  const st = S.state;
  const [c, setC] = useState(null), [f, setF] = useState(null);
  const init = x => ({ baseUrl: x.baseUrl || location.origin, contact: x.contact || '', googleClientId: x.googleClientId || '', googleClientSecret: '', mapsKey: '' });
  const reload = () => api('/api/admin/server').then(x => { setC(x); setF(init(x)); });
  useEffect(() => { reload(); }, []);
  if (!c || !f) return null;
  const base = init(c), changed = keys => keys.some(k => f[k] !== base[k]);
  const saveOnly = async keys => {
    const body = Object.fromEntries(keys.filter(k => f[k] !== base[k]).map(k => [k, f[k]]));
    try { await api('/api/admin/server', { method: 'PUT', body }); await load(['boot']); await reload(); toast('Saved'); } catch (e) { toast(e.message); }
  };
  const undo = keys => setF({ ...f, ...Object.fromEntries(keys.map(k => [k, base[k]])) });
  const bar = keys => changed(keys) && html`<div class="cell"><span></span><button class="ghost" onClick=${() => undo(keys)}>Undo</button><button class="pri" onClick=${() => saveOnly(keys)}>Save</button></div>`;
  const ADDR = ['contact', 'baseUrl'], MAPS = ['mapsKey'], GOOGLE = ['googleClientId', 'googleClientSecret'];
  const redirect = (f.baseUrl || location.origin).replace(/\/$/, '') + '/api/google/callback';
  const step = (n, link, label, rest) => html`<div class="cell"><span class="hint" style="flex:none;width:18px">${n}</span><span><a href=${link} target="_blank" rel="noopener">${label}</a>${rest || ''}</span></div>`;
  const inp = (k, props = {}) => html`<input ...${NOFILL} ...${props} value=${f[k]} onInput=${e => setF({ ...f, [k]: e.target.value })}/>`;
  return html`<div class="sect">Address</div><div class="box">
    <div class="cell stack"><span>Contact e-mail</span>${inp('contact', { type: 'text', inputmode: 'email' })}</div>
    <div class="cell"><span>Homepage</span><a href="/about" target="_blank">/about</a><span class="hint">·</span><a href="/privacy" target="_blank">/privacy</a></div>
    <div class="cell stack"><span>Public URL</span>${inp('baseUrl', { disabled: c.fromEnv.baseUrl })}${!c.https && html`<span class="chip warn">HTTP</span>`}</div>
    ${bar(ADDR)}</div>
  <div class="sect">Google Maps</div><div class="box">
    <div class="cell stack"><span>API key</span>${inp('mapsKey', { type: 'password', placeholder: c.hasMapsKey ? 'Saved' : 'Places API and Routes API' })}</div>
    ${bar(MAPS)}
    <${MapsTest} save=${() => saveOnly(MAPS)} dirty=${changed(MAPS)}/>
    ${step('', 'https://console.cloud.google.com/google/maps-apis/api-list', 'Enable Places API (New) and Routes API', html` <span class="hint">then Credentials → API key</span>`)}</div>
  <div class="sect">Google Sign-In ${st.google ? html`<span class="chip ok" style="text-transform:none">${I('check', 13, { w: 2.4 })}Active</span>` : ''}</div><div class="box">
    ${step(1, 'https://console.cloud.google.com/projectcreate', 'Create project')}
    ${step(2, 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', 'Enable Calendar API')}
    ${step(3, 'https://console.cloud.google.com/auth/branding', 'Consent screen', html` <span class="hint">External · then Audience → Publish</span>`)}
    ${step(4, 'https://console.cloud.google.com/auth/clients/create', 'Create client', html` <span class="hint">Web application</span>`)}
    <${CopyRow} label="Redirect URI" value=${redirect}/>
    <div class="cell stack"><span>Client ID</span>${inp('googleClientId', { placeholder: '….apps.googleusercontent.com', disabled: c.fromEnv.google })}</div>
    <div class="cell stack"><span>Client Secret</span>${inp('googleClientSecret', { type: 'password', placeholder: c.hasSecret ? 'Saved' : '', disabled: c.fromEnv.google })}</div>
    ${(c.fromEnv.google || c.fromEnv.baseUrl) && html`<p class="hint">Set by environment variables.</p>`}
    ${bar(GOOGLE)}
  </div>`;
}

// outgoing e-mail for notifications
function Smtp() {
  const [f, setF] = useState(null), [pass, setPass] = useState(''), [to, setTo] = useState(S.state.me.email || ''), [res, setRes] = useState(null);
  const [o, setO] = useState(null), got = x => { setF(x); setO(x); };
  useEffect(() => { api('/api/admin/smtp').then(got).catch(() => {}); }, []);
  if (!f) return null;
  const KEYS = ['host', 'port', 'security', 'user', 'from'], dirty = !!pass || KEYS.some(k => (f[k] || '') !== (o[k] || ''));
  const save = async () => { try { got(await api('/api/admin/smtp', { method: 'PUT', body: { ...Object.fromEntries(KEYS.map(k => [k, f[k]])), ...(pass ? { pass } : {}) } })); setPass(''); await load(['boot']); toast('Saved'); } catch (e) { toast(e.message); } };
  const test = async () => { setRes(null); try { if (dirty) { got(await api('/api/admin/smtp', { method: 'PUT', body: { ...Object.fromEntries(KEYS.map(k => [k, f[k]])), ...(pass ? { pass } : {}) } })); setPass(''); } setRes(await post('/api/admin/smtp/test', { to })); } catch (e) { setRes({ ok: false, error: e.message }); } };
  const inp = (k, w, ph, t = 'text') => html`<input style=${{ width: w + 'px' }} type=${t} value=${f[k] || ''} placeholder=${ph} onInput=${e => setF({ ...f, [k]: e.target.value })}/>`;
  return html`<div class="sect">E-mail</div><div class="box">
    <div class="cell"><span>Server</span>${inp('host', 220, 'smtp.example.com')}<input style="width:70px" type="number" value=${f.port || ''} placeholder=${f.security === 'ssl' ? '465' : '587'} onInput=${e => setF({ ...f, port: +e.target.value })}/></div>
    <div class="cell"><span>Provider</span><div class="seg">${[['iCloud', { host: 'smtp.mail.me.com', port: 587, security: 'starttls' }], ['Gmail', { host: 'smtp.gmail.com', port: 587, security: 'starttls' }], ['Outlook', { host: 'smtp.office365.com', port: 587, security: 'starttls' }]].map(([l, v]) => html`<button class=${f.host === v.host ? 'on' : ''} onClick=${() => setF({ ...f, ...v })}>${l}</button>`)}</div></div>
    <div class="cell"><span>Security</span><div class="seg">${[['starttls', 'STARTTLS'], ['ssl', 'SSL/TLS'], ['none', 'None']].map(([v, l]) => html`<button class=${f.security === v ? 'on' : ''} onClick=${() => setF({ ...f, security: v })}>${l}</button>`)}</div></div>
    <div class="cell stack"><span>User</span>${inp('user', 240, '')}</div>
    <div class="cell stack"><span>Password</span><input style="width:240px" type="password" autocomplete="new-password" value=${pass} placeholder=${f.hasPass ? 'Saved' : ''} onInput=${e => setPass(e.target.value)}/></div>
    <div class="cell stack"><span>Sender</span>${inp('from', 240, 'Smart Calendar <calendar@example.com>')}</div>
    <div class="cell stack"><span>Test to</span><input style="width:240px" type="email" value=${to} onInput=${e => setTo(e.target.value)}/><button class="ghost" disabled=${!f.host || !f.from} onClick=${test}>Send</button></div>
    ${res && html`<div class="cell" style="display:block;font-size:14px;color:${res.ok ? 'var(--done)' : 'var(--late)'}">${res.ok ? 'Login works, message sent. Check the inbox.' : res.step === 'login' ? 'Login refused: ' + res.error : res.step === 'send' ? 'Login works, but sending was refused: ' + res.error : res.error}</div>`}
    ${dirty && html`<div class="cell"><span></span><button class="ghost" onClick=${() => { setF(o); setPass(''); }}>Undo</button><button class="pri" onClick=${save}>Save</button></div>`}
    ${f.host && !dirty && html`<div class="cell"><span></span><button class="ghost danger" onClick=${async () => { if (await confirmDialog('Remove the e-mail setup?', 'Remove', true)) { got(await api('/api/admin/smtp', { method: 'PUT', body: { clear: true } })); load(['boot']); } }}>Remove</button></div>`}
  </div>`;
}

function Displays() {
  const [L, setL] = useState([]), [users, setUsers] = useState([]), [made, setMade] = useState(null), [conf, setConf] = useState(null);
  const reload = () => { api('/api/admin/displays').then(setL); api('/api/admin/server').then(setConf); };
  useEffect(() => { reload(); api('/api/admin/users').then(u => setUsers(u.filter(x => !x.disabled))); }, []);
  const base = (conf?.baseUrl || location.origin).replace(/\/$/, '');
  const create = async () => {
    const v = await openModal(close => { const B = () => { const [n, setN] = useState('Hallway'), [sel, setSel] = useState(users.map(u => u.id)); return html`<div class="modal sm"><h3>New Display</h3>
      <input style="width:100%" placeholder="Name" value=${n} onInput=${e => setN(e.target.value)}/>
      <div style="margin:12px 0">${users.map(u => html`<label class="calrow"><input type="checkbox" class="sq" checked=${sel.includes(u.id)} onChange=${e => setSel(e.target.checked ? [...sel, u.id] : sel.filter(x => x !== u.id))}/><${Avatar} id=${u.id}/>${u.name}</label>`)}</div>
      <div class="acts"><button onClick=${() => close(null)}>Cancel</button><button class="pri" disabled=${!sel.length} onClick=${() => close({ name: n, users: sel })}>Create</button></div></div>`; }; return html`<${B}/>`; });
    if (v) { const r = await act(() => post('/api/admin/displays', v)); if (r) { setMade(`${base}/wall#key=${r.token}`); reload(); } }
  };
  const copy = t => navigator.clipboard?.writeText(t).then(() => toast('Copied'));
  // Household: everyone who shares a project with the display's owner, also people added later
  const people = async d => {
    const v = await openModal(close => { const B = () => { const [hh, setHh] = useState(!d.users.length), [sel, setSel] = useState(d.users.length ? d.users : users.map(u => u.id)); return html`<div class="modal sm"><h3>${d.name}</h3>
      <label class="calrow"><input type="checkbox" class="sq" checked=${hh} onChange=${e => setHh(e.target.checked)}/>Household</label>
      ${!hh && html`<div style="margin:8px 0 12px">${users.map(u => html`<label class="calrow"><input type="checkbox" class="sq" checked=${sel.includes(u.id)} onChange=${e => setSel(e.target.checked ? [...sel, u.id] : sel.filter(x => x !== u.id))}/><${Avatar} id=${u.id}/>${u.name}</label>`)}</div>`}
      <div class="acts"><button onClick=${() => close(null)}>Cancel</button><button class="pri" disabled=${!hh && !sel.length} onClick=${() => close({ users: hh ? [] : sel })}>Save</button></div></div>`; }; return html`<${B}/>`; });
    if (v) act(() => api('/api/admin/displays/' + d.id, { method: 'PUT', body: v }), null, reload);
  };
  return html`
    ${made && html`<div class="box"><div class="cell"><code style="user-select:all;word-break:break-all;flex:1">${made}</code><button class="ghost" onClick=${() => copy(made)}>Copy</button></div>
      <p class="hint" style="margin:6px 0 0">Shown once. Open on the tablet, or use it in Home Assistant.</p></div>`}
    <div class="box">${L.map(d => html`<div class="cell"><span>${d.name} <span class="hint">${d.users.length ? d.users.map(id => (users.find(u => u.id === id) || {}).name).filter(Boolean).join(', ') : 'Household'}</span></span>
        <span class="hint">${d.last_used ? ago(d.last_used) : 'Never used'}</span>
        <button class="icon" title="People" onClick=${() => people(d)}>${I('people', 15)}</button>
        <button class="icon" title="Remove" onClick=${async () => { if (await confirmDialog(`Remove “${d.name}”? The tablet stops working.`, 'Remove', true)) act(() => del('/api/admin/displays/' + d.id), null, reload); }}>${I('trash', 15)}</button></div>`)}
      ${!L.length && html`<p class="hint" style="margin:0 0 6px">No displays</p>`}
      <div class="cell"><button class="ghost" style="padding-left:0" onClick=${create}>${I('plus', 15)}New Display</button></div></div>
    ${conf && html`<div class="sect">Home Assistant</div><div class="box">
      <div class="cell stack"><span>Home Assistant address</span><input style="width:300px" placeholder="http://homeassistant.local:8123" value=${(conf.embedOrigins || []).join(', ')}
        onChange=${e => act(() => api('/api/admin/server', { method: 'PUT', body: { embedOrigins: e.target.value.split(',').map(x => x.trim()).filter(Boolean) } }), 'Saved', reload)}/></div></div>`}`;
}

export default function AdminView() {
  const r = (location.hash.split('/')[2] || 'overview').split('?')[0];
  const [tab, setTab] = useState(TABS.some(t => t[0] === r) ? r : 'overview');
  const go = t => { setTab(t); history.replaceState(null, '', '#/admin/' + t); };
  // password managers (Bitwarden, 1Password, LastPass) leave every field of the admin area alone
  const root = useRef();
  useEffect(() => {
    const el = root.current; if (!el) return;
    const mark = () => el.querySelectorAll('input:not([data-bwignore])').forEach(i => { for (const [k, v] of Object.entries(NOFILL)) i.setAttribute(k, v); });
    mark(); const mo = new MutationObserver(mark); mo.observe(el, { childList: true, subtree: true }); return () => mo.disconnect();
  }, []);
  if (!S.state.me.is_admin) return html`<div class="empty">Admins only.</div>`;
  return html`<div class="set" style="max-width:1100px" ref=${root}>
    <div class="filters" style="margin-bottom:14px"><div class="seg adm-tabs">${TABS.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => go(k)}>${l}</button>`)}</div>
      <select class="adm-pick" value=${tab} onChange=${e => go(e.target.value)}>${TABS.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></div>
    ${tab === 'overview' ? html`<${Overview} go=${go}/>` : tab === 'users' ? html`<${Users}/>` : tab === 'access' ? html`<${Access}/>` : tab === 'server' ? html`<${ServerBox}/><${Smtp}/>` : tab === 'displays' ? html`<${Displays}/>` : html`<${LogTable} kind=${tab === 'audit' ? 'audit' : 'logs'} key=${tab}/>`}
  </div>`;
}
