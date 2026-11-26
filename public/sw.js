// Service worker: web push + notification actions + offline shell
const SHELL = 'sc-shell-v3';
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(['/', '/app.css', '/icon.svg'])).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok && (u.pathname === '/' || /\.(css|js|mjs|svg|png)$/.test(u.pathname))) { const c = r.clone(); caches.open(SHELL).then(x => x.put(e.request, c)); } return r; }).catch(() => caches.match(e.request)));
});
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'Smart Calendar', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Smart Calendar', { body: d.body || '', tag: d.tag, icon: '/icon-512.png', badge: '/icon-180.png', data: d, actions: d.actions || [] }));
});
self.addEventListener('notificationclick', e => {
  const d = e.notification.data || {}; e.notification.close();
  const api = (path, body) => fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-sc': '1' }, body: JSON.stringify(body) });
  if (e.action === 'start' && d.key) { const [task, period] = d.key.split('@'); e.waitUntil(api('/api/timer/start', { task: +task, period: +(period || 0) })); return; }
  if ((e.action === 'clash-work' || e.action === 'clash-mine') && d.clash) { e.waitUntil(api('/api/clashes', { key: d.clash, choice: e.action === 'clash-mine' ? 'mine' : 'work' })); return; }
  if (e.action === 'join' && d.join && /^https:\/\//.test(d.join)) { e.waitUntil(self.clients.openWindow(d.join)); return; }
  if (e.action === 'later' && d.key) { const [task, period] = d.key.split('@'); e.waitUntil(api(`/api/tasks/${task}/postpone`, { period: +(period || 0), until: Date.now() + 3600e3 })); return; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => new URL(x.url).origin === location.origin);
    if (c) { c.focus(); c.navigate ? c.navigate(d.url || '/#/now') : null; return; }
    return self.clients.openWindow(d.url || '/#/now');
  }));
});
