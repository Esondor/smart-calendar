// Web Push (works for the installed web app on iOS 16.4+, Android, macOS)
import * as webpush from 'web-push';
import { all, get, run, kvGet, kvSet } from './db.js';
import { serverConf } from './serverconf.js';
import { syslog } from './logs.js';

let keys = kvGet('vapid');
if (!keys) { keys = webpush.generateVAPIDKeys(); kvSet('vapid', keys); }

export const vapidPublicKey = () => keys.publicKey;

// Apple's push service answers 403 (BadJwtToken) to a sender ID like mailto:admin@localhost:
// it must be a real https address or e-mail. The public address of the app is used, else the contact e-mail.
export function vapidSubject() {
  const c = serverConf(), ok = s => /^https:\/\/[^/]+\.[^/]+/.test(s) || /^mailto:[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s) && !/@(localhost|example\.(com|org))$/i.test(s);
  if (ok(c.vapidSubject)) return c.vapidSubject;
  if (/^https:\/\//.test(c.baseUrl)) return c.baseUrl;
  if (c.contact && ok('mailto:' + c.contact)) return 'mailto:' + c.contact;
  return c.baseUrl ? c.baseUrl.replace(/^http:/, 'https:') : 'mailto:push@example.net';
}
export async function sendPush(uid, payload, detail = false) {
  webpush.setVapidDetails(vapidSubject(), keys.publicKey, keys.privateKey);
  const subs = all('SELECT * FROM push_subs WHERE user_id = ?', uid), errors = [];
  let sent = 0;
  await Promise.all(subs.map(async s => {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: payload.urgency || 'normal' }); sent++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { run('DELETE FROM push_subs WHERE id = ?', s.id); return; }
      const why = `${e.statusCode || ''} ${String(e.body || e.message || '').replace(/\s+/g, ' ').slice(0, 160)}`.trim();
      errors.push(why); syslog('warn', 'push', `delivery failed (${why}) to ${new URL(s.endpoint).host}`, uid);
    }
  }));
  return detail ? { devices: subs.length, sent, errors } : sent;
}
