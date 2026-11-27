// The public booking page (/book/<token>): times that fit the person's plan, or a time of your own as a request.
// Nothing of their calendar is shown, only free times.
(() => {
  const tok = location.pathname.split('/')[2] || '', app = document.getElementById('app');
  const api = (p, o = {}) => fetch('/api/book/' + encodeURIComponent(tok) + p, { ...o, headers: { 'content-type': 'application/json', 'x-sc': '1' } })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Something went wrong'); return j; });
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v); } kids.flat().forEach(k => k != null && e.append(k)); return e; };
  const day = ms => new Date(ms).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const hm = ms => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const dur = m => m < 60 ? m + ' min' : m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : m / 60 + ' h';
  let info, st = { minutes: 0, urgent: false, slots: null, pick: null, own: false };

  const render = () => {
    app.replaceChildren(
      el('h1', {}, info.title), el('p', { class: 'sub' }, info.with ? `with ${info.with}` : ''),
      info.minutes.length > 1 ? el('div', { class: 'card' }, el('div', { class: 'lbl' }, 'How long'), el('div', { class: 'seg' }, info.minutes.map(m => el('button', { class: st.minutes === m ? 'on' : '', onclick: () => { st.minutes = m; st.pick = null; slots(); } }, dur(m))))) : '',
      el('div', { class: 'card' }, el('div', { class: 'lbl' }, 'When'),
        el('div', { class: 'seg' }, el('button', { class: !st.urgent ? 'on' : '', onclick: () => { st.urgent = false; st.pick = null; slots(); } }, 'Best fit'), el('button', { class: st.urgent ? 'on' : '', onclick: () => { st.urgent = true; st.pick = null; slots(); } }, 'Soonest')),
        st.own ? ownTime() : times(),
        el('button', { class: 'link', onclick: () => { st.own = !st.own; st.pick = null; render(); } }, st.own ? 'Show suggested times' : 'Another time…')),
      st.pick ? form() : '');
  };
  const times = () => {
    if (!st.slots) return el('p', { class: 'hint' }, 'Finding times…');
    if (!st.slots.length) return el('p', { class: 'hint' }, 'No free time in the next weeks. Try another time.');
    const out = [], byDay = new Map();
    for (const x of st.slots) { const k = new Date(x.s).toDateString(); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(x); }
    for (const L of byDay.values()) out.push(el('div', { class: 'day' }, day(L[0].s)), el('div', { class: 'times' }, L.map(x => el('button', { class: 't ' + x.fit + (st.pick?.s === x.s ? ' on' : ''), onclick: () => { st.pick = { s: x.s, own: false }; render(); } }, hm(x.s)))));
    return el('div', {}, out);
  };
  const ownTime = () => {
    const d = el('input', { type: 'date', min: new Date().toISOString().slice(0, 10) }), t = el('input', { type: 'time', step: 900 });
    const set = () => { if (d.value && t.value) { st.pick = { s: new Date(`${d.value}T${t.value}`).getTime(), own: true }; render(); } };
    d.addEventListener('change', set); t.addEventListener('change', set);
    if (st.pick?.own) { const x = new Date(st.pick.s); d.value = x.toLocaleDateString('sv'); t.value = x.toTimeString().slice(0, 5); }
    return el('div', {}, el('div', { class: 'row', style: 'margin-top:6px' }, d, t), el('p', { class: 'hint' }, 'If it does not fit the plan, it is sent as a request.'));
  };
  const form = () => {
    const n = el('input', { placeholder: 'Your name', autocomplete: 'name' }), m = el('input', { type: 'email', placeholder: 'E-mail (for the confirmation)', autocomplete: 'email' }),
      no = el('textarea', { rows: 2, placeholder: 'Note' }), err = el('div', { class: 'err' }), b = el('button', { class: 'btn' }, `Book ${day(st.pick.s)}, ${hm(st.pick.s)}`);
    b.addEventListener('click', async () => {
      err.textContent = ''; if (!n.value.trim()) { err.textContent = 'Please enter your name'; n.focus(); return; }
      b.disabled = true;
      try { const r = await api('', { method: 'POST', body: JSON.stringify({ name: n.value, email: m.value || null, note: no.value || null, start: st.pick.s, minutes: st.minutes, own: st.pick.own }) }); doneView(r); }
      catch (e) { err.textContent = e.message; b.disabled = false; if (!st.pick.own) { st.pick = null; slots(); } }
    });
    return el('div', { class: 'card' }, el('div', { class: 'lbl' }, `${dur(st.minutes)} · ${day(st.pick.s)}, ${hm(st.pick.s)}`), n, m, no, err, b);
  };
  const doneView = r => app.replaceChildren(el('div', { class: 'done' }, el('h1', {}, r.status === 'confirmed' ? 'Booked' : 'Sent'),
    el('p', { class: 'sub' }, r.status === 'confirmed' ? `${day(r.start)}, ${hm(r.start)}–${hm(r.end)}` : `${info.with || 'They'} will answer your request.`)));
  const slots = async () => { st.slots = null; render(); try { st.slots = await api(`/slots?minutes=${st.minutes}${st.urgent ? '&urgent=1' : ''}`); } catch (e) { st.slots = []; } render(); };
  api('').then(j => { info = j; st.minutes = j.minutes[0]; document.title = j.title; slots(); }).catch(e => app.replaceChildren(el('div', { class: 'done' }, el('h1', {}, 'Not available'), el('p', { class: 'sub' }, e.message))));
})();
