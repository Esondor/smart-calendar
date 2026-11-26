// Server-wide setup done once by the admin inside the app (Settings → Server).
// Environment variables still work and take precedence, but none are required.
import { kvGet, kvSet } from './db.js';
import { encrypt, decrypt } from './crypto.js';

let cache = null;
const load = () => cache ??= (kvGet('serverconf') || {});
export function serverConf() {
  const c = load();
  let secret = '', smtpPass = '', mapsKey = '';
  try { mapsKey = c.mapsKey ? decrypt(c.mapsKey).s : ''; } catch {}
  try { secret = c.googleSecret ? decrypt(c.googleSecret).s : ''; } catch {}
  try { smtpPass = c.smtpPass ? decrypt(c.smtpPass).s : ''; } catch {}
  return {
    baseUrl: (process.env.BASE_URL || c.baseUrl || '').replace(/\/$/, ''),
    googleClientId: process.env.GOOGLE_CLIENT_ID || c.googleClientId || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || secret,
    vapidSubject: process.env.VAPID_SUBJECT || c.vapidSubject || 'mailto:admin@localhost',
    embedOrigins: c.embedOrigins || [],
    contact: c.contact || '',      // may show the wall display in an iframe (Home Assistant)
    mapsKey: process.env.GOOGLE_MAPS_KEY || mapsKey,
    smtp: { host: c.smtpHost || '', port: c.smtpPort || 0, security: c.smtpSecurity || 'starttls', user: c.smtpUser || '', pass: smtpPass, from: c.smtpFrom || '' },
    backupFolder: c.backupFolder || 'backups',
    backupKeep: c.backupKeep || 30,       // days
    backupHour: c.backupHour ?? 3,
    fromEnv: { baseUrl: !!process.env.BASE_URL, google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) },
  };
}
export function setServerConf(p) {
  const c = { ...load() };
  if ('baseUrl' in p) c.baseUrl = String(p.baseUrl || '').trim().replace(/\/$/, '');
  if ('googleClientId' in p) c.googleClientId = String(p.googleClientId || '').trim();
  if ('googleClientSecret' in p && p.googleClientSecret) c.googleSecret = encrypt({ s: String(p.googleClientSecret).trim() });
  if (p.clearGoogle) { delete c.googleClientId; delete c.googleSecret; }
  if (Array.isArray(p.embedOrigins)) c.embedOrigins = p.embedOrigins.map(x => { try { return new URL(String(x).trim()).origin; } catch { return null; } }).filter(Boolean).slice(0, 10);
  if ('contact' in p) c.contact = String(p.contact || '').trim().slice(0, 120);
  if ('backupFolder' in p) c.backupFolder = String(p.backupFolder || '').trim().replace(/(.)\/+$/, '$1') || 'backups';
  if ('backupKeep' in p) c.backupKeep = Math.min(365, Math.max(1, Math.round(+p.backupKeep) || 30));
  if ('backupHour' in p) c.backupHour = Math.min(23, Math.max(0, Math.round(+p.backupHour) || 0));
  if (p.smtp && typeof p.smtp === 'object') {
    const m = p.smtp;
    if ('host' in m) c.smtpHost = String(m.host || '').trim().slice(0, 200);
    if ('port' in m) c.smtpPort = Math.max(0, Math.min(65535, Math.round(+m.port) || 0));
    if ('security' in m) c.smtpSecurity = ['starttls', 'ssl', 'none'].includes(m.security) ? m.security : 'starttls';
    if ('user' in m) c.smtpUser = String(m.user || '').trim().slice(0, 200);
    if ('pass' in m && m.pass) c.smtpPass = encrypt({ s: String(m.pass).trim() });   // pasted app passwords often carry a space or line break
    if ('from' in m) c.smtpFrom = String(m.from || '').replace(/[\r\n]/g, '').trim().slice(0, 200);
    if (m.clear) for (const k of ['smtpHost', 'smtpPort', 'smtpSecurity', 'smtpUser', 'smtpPass', 'smtpFrom']) delete c[k];
  }
  if (p.mapsKey) c.mapsKey = encrypt({ s: String(p.mapsKey).trim() });   // an empty field keeps the saved key
  if (p.clearMapsKey) delete c.mapsKey;
  if ('vapidSubject' in p) c.vapidSubject = String(p.vapidSubject || '').trim();
  kvSet('serverconf', c); cache = c;
}
// first visit through the reverse proxy fills in the public address automatically
export function learnBaseUrl(req) {
  const c = load();
  if (process.env.BASE_URL || c.baseUrl) return;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host || /^(localhost|127\.|\[::1\])/.test(host)) return;
  setServerConf({ baseUrl: `${req.protocol}://${host}` });
}
// the public https address other services can reach (push from Google, webhooks from Vikunja); null if there is none
export const publicUrl = path => { const b = serverConf().baseUrl || ''; return /^https:\/\//.test(b) && !/\/\/(localhost|127\.|10\.|192\.168\.)/.test(b) ? b + path : null; };
export const baseUrl = () => serverConf().baseUrl || `http://localhost:${process.env.PORT || 8080}`;
