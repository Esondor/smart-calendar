// First-run setup: install the app, connect calendars, choose chore hours, enable reminders.
import { html, useState, useEffect, S, api, post, patch, load, toast, DN } from './lib.js';
import { I } from './icons.js';

const putSettings = async p => { const s = await api('/api/settings', { method: 'PUT', body: { ...S.state.settings, ...p } }); S.set({ settings: s }); };
const ua = navigator.userAgent, isIos = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1), isAndroid = /Android/.test(ua);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;

// how to put the web app on the home screen (or the dock): it then opens like an app, full screen, and can send reminders
const HOW = {
  ios: ['iPhone / iPad', html`<ol class="how"><li>Open this page in <b>Safari</b>.</li><li>Tap <b>Share</b> (the square with the arrow) at the bottom.</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open Smart Calendar from the home screen and continue there. Reminders only work in the installed app.</li></ol>`],
  android: ['Android', html`<ol class="how"><li>Open this page in <b>Chrome</b>.</li><li>Tap the menu <b>⋮</b> at the top right.</li><li>Choose <b>Install app</b> (or <b>Add to Home screen</b>), then <b>Install</b>.</li><li>Open Smart Calendar from the home screen.</li></ol>`],
  desktop: ['Computer', html`<ol class="how"><li><b>Chrome or Edge:</b> click the install icon at the right of the address bar, then <b>Install</b>.</li><li><b>Safari on a Mac:</b> File → <b>Add to Dock</b>.</li></ol>`],
};
function Install() {
  const [, tick] = useState(0), [os, setOs] = useState(isIos ? 'ios' : isAndroid ? 'android' : 'desktop');
  useEffect(() => { const f = () => tick(x => x + 1); addEventListener('installable', f); return () => removeEventListener('installable', f); }, []);
  if (standalone) return html`<div class="hint">Installed.</div>`;
  const prompt = window.installPrompt;
  return html`<div>
    ${prompt && html`<button class="pri" style="font-size:15px;padding:9px 16px;margin-bottom:10px" onClick=${async () => { await prompt.prompt(); window.installPrompt = null; tick(x => x + 1); }}>${I('plus', 16)}Install</button>`}
    <div class="seg" style="margin-bottom:8px">${Object.entries(HOW).map(([k, [label]]) => html`<button class=${os === k ? 'on' : ''} onClick=${() => setOs(k)}>${label}</button>`)}</div>
    ${HOW[os][1]}
  </div>`;
}

function Step({ n, title, done, children }) {
  return html`<div class="box"><div class="row" style="margin-bottom:${children ? 10 : 0}px">
    <span class="avatar" style=${{ background: done ? 'var(--done)' : 'var(--fill)', color: done ? '#fff' : 'var(--muted)', width: '24px', height: '24px', fontSize: '12px' }}>${done ? I('check', 14, { w: 2.6 }) : n}</span>
    <b style="font-size:16px">${title}</b></div>${children}</div>`;
}

export default function SetupView() {
  const st = S.state, s = st.settings, accs = st.accounts;
  useEffect(() => { load(['accounts']); }, []);
  const g = accs.filter(a => a.kind === 'google'), cals = g.flatMap(a => a.calendars), plan = cals.find(c => c.is_plan);
  const [ics, setIcs] = useState(''), [busy, setBusy] = useState(false), [push, setPush] = useState('');
  useEffect(() => { (async () => { try { const r = await navigator.serviceWorker?.ready; setPush((await r?.pushManager?.getSubscription()) ? 'on' : ''); } catch {} })(); }, []);
  const run = async (fn, msg) => { setBusy(true); try { await fn(); await load(['accounts', 'plan']); if (msg) toast(msg); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const enablePush = async () => {
    try {
      if (await Notification.requestPermission() !== 'granted') return;
      const reg = await navigator.serviceWorker.ready, key = st.vapid.replace(/-/g, '+').replace(/_/g, '/'), raw = atob(key + '='.repeat((4 - key.length % 4) % 4));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from([...raw].map(c => c.charCodeAt(0))) });
      await post('/api/push/subscribe', sub.toJSON()); setPush('on');
    } catch (e) { toast(e.message); }
  };
  const ev = [['18:30', '21:30']], we = [['10:00', '19:00']];
  const PRESETS = [['Evenings & Weekends', { 0: we, 1: ev, 2: ev, 3: ev, 4: ev, 5: ev, 6: we }], ['Weekends', { 0: we, 6: we }], ['Evenings', { 1: ev, 2: ev, 3: ev, 4: ev, 5: ev }]];
  const curPreset = PRESETS.find(([, h]) => JSON.stringify(h) === JSON.stringify(Object.fromEntries(Object.entries(s.hours.personal || {}).filter(([, v]) => v))))?.[0];

  return html`<div class="set" style="max-width:620px">
    <${Step} n="1" title="Install the App" done=${!!standalone}><${Install}/></${Step}>
    <${Step} n="2" title="Google Calendar" done=${g.length > 0}>
      ${!st.google ? html`<p class="hint" style="margin:0">${st.me.is_admin ? html`Not configured. <a href="#/admin/server">Set up</a>` : 'Not configured by the administrator yet.'}</p>`
      : g.length ? html`<div class="hint">${g.map(a => a.label).join(', ')}</div>`
      : html`<button class="pri" style="font-size:15px;padding:9px 16px" onClick=${() => { location.href = '/api/google/connect'; }}>Sign in with Google</button>
        <p class="hint" style="margin:10px 0 0">If Google shows “unverified app”, choose Advanced, then Continue.</p>`}
    </${Step}>
    ${g.length > 0 && html`<${Step} n="3" title="Calendars That Block Time" done=${cals.some(c => c.use_busy)}>
      ${cals.filter(c => !c.is_plan).map(c => html`<label class="calrow"><input type="checkbox" class="sq" checked=${!!c.use_busy} onChange=${e => run(() => patch('/api/calendars/' + c.id, { use_busy: e.target.checked }))}/><span class="sw" style=${{ background: c.color || '#999' }}></span>${c.name}</label>`)}
      ${plan && html`<p class="hint" style="margin:10px 0 0">Planned tasks appear in “${plan.name}”.${isIos || /Mac/.test(navigator.userAgent) ? html` <a href="https://calendar.google.com/calendar/syncselect" target="_blank" rel="noopener">Show in Apple Calendar</a>` : ''}</p>`}
      <div class="row" style="margin-top:12px"><input type="url" class="grow" placeholder="Outlook / Exchange ICS link (optional)" value=${ics} onInput=${e => setIcs(e.target.value)}/>
        <button disabled=${!ics || busy} onClick=${() => run(async () => { const r = await post('/api/accounts/ics', { label: 'Work', url: ics }); if (r.status !== 'ok') throw new Error(r.error); setIcs(''); }, 'Added')}>Add</button></div>
    </${Step}>`}
    <${Step} n=${g.length ? 4 : 3} title="Time for Chores" done=${!!curPreset}>
      <div class="seg">${PRESETS.map(([name, hours]) => html`<button class=${curPreset === name ? 'on' : ''} onClick=${() => run(() => putSettings({ hours: { ...s.hours, personal: hours } }))}>${name}</button>`)}</div>
      ${!curPreset && html`<p class="hint" style="margin:8px 0 0">Custom – see Settings.</p>`}
    </${Step}>
    <${Step} n=${g.length ? 5 : 4} title="Reminders" done=${push === 'on'}>
      ${push === 'on' ? null : isIos && !standalone ? html`<p class="hint" style="margin:0">Install the app first (step 1), then turn reminders on there.</p>`
      : !window.isSecureContext ? html`<p class="hint" style="margin:0">Requires HTTPS.</p>`
      : html`<button onClick=${enablePush}>${I('bell', 16)}Turn On</button>`}
    </${Step}>
    <div class="row" style="justify-content:flex-end"><button class="pri" style="font-size:15px;padding:9px 20px" onClick=${async () => { await putSettings({ onboarded: true }); location.hash = '#/now'; }}>${g.length ? 'Done' : 'Skip'}</button></div>
  </div>`;
}
