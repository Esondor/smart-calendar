// E-mail via the SMTP server the admin set up (Administration → Server → E-mail)
import nodemailer from 'nodemailer';
import { serverConf } from './serverconf.js';
import { syslog } from './logs.js';

let cached = null, cachedKey = '';
const transport = () => {
  const c = serverConf().smtp; if (!c.host) return null;
  const key = JSON.stringify(c);
  if (key !== cachedKey) {
    let name; try { name = new URL(serverConf().baseUrl).hostname; } catch {}   // introduce ourselves by the app's domain, not the container's random name
    cached = nodemailer.createTransport({ ...(name ? { name } : {}), host: c.host, port: c.port || (c.security === 'ssl' ? 465 : 587), secure: c.security === 'ssl', requireTLS: c.security === 'starttls',
      auth: c.user ? { user: c.user, pass: c.pass } : undefined, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
      disableFileAccess: true, disableUrlAccess: true });
    cachedKey = key;
  }
  return cached;
};
export const mailReady = () => { const c = serverConf().smtp; return !!(c.host && c.from); };
// the setup test: first the login alone, then a real message from the Sender address; says which step failed
export async function testMail(to) {
  const t = transport(); if (!t || !mailReady()) throw new Error('Server and sender are needed');
  try { await t.verify(); } catch (e) { const x = explain(e); return { ok: false, step: 'login', error: x.message }; }
  try { await sendMail(to, 'Smart Calendar', 'The e-mail setup works.'); } catch (e) { return { ok: false, step: 'send', error: e.message }; }
  return { ok: true };
}
const explain = e => {
  const c = serverConf().smtp, auth = e.code === 'EAUTH' || /auth|535|534/i.test(e.message);
  const hint = auth && /mail\.me\.com|icloud/i.test(c.host) ? ' iCloud: User must be your Apple ID address (…@icloud.com / @me.com), the password an app-specific password from appleid.apple.com, and the Sender an address of this iCloud account (own domains under iCloud+ → Custom Email Domain).'
    : auth ? ' Check user and password (many providers need an app password).'
    : /sender|from|553|550|554/i.test(e.message) ? ' The server does not accept this Sender address for this account.'
    : /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ESOCKET/.test(e.code || '') ? ' The server cannot be reached: check server and port (587 STARTTLS or 465 SSL/TLS).' : '';
  return Object.assign(new Error(e.message + hint), { code: e.code });
};
export async function sendMail(to, subject, text) {
  const t = transport(); if (!t || !mailReady() || !to) return false;
  const clean = s => String(s || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
  try { await t.sendMail({ from: serverConf().smtp.from, to, subject: clean(subject), text: String(text || '').slice(0, 20000) }); return true; }
  catch (e) { syslog('warn', 'mail', `sending failed: ${e.message}`); throw explain(e); }
}
