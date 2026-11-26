// Access policy, set by admins in the admin panel.
import { kvGet, kvSet, get, run, all } from './db.js';
import { syslog } from './logs.js';

export const DEFAULT_POLICY = {
  require2fa: 'none',       // none | admins | all
  sessionDays: 30,
  minPassword: 10,
  banAfter: 10,             // failed sign-ins from one IP …
  banWindowMin: 15,         // … within this many minutes …
  banHours: 24,             // … ban the IP this long (0 = forever)
  allowlist: [],            // IPs / prefixes never banned, e.g. "192.168.178." or "10.0.0.5"
  regPassword: '',          // anyone who knows it can create an account (empty = off; invites always work)
};
let cache = null;
export const policy = () => cache ??= { ...DEFAULT_POLICY, ...(kvGet('policy') || {}) };
export function setPolicy(p) {
  const c = { ...policy() };
  const num = (k, lo, hi) => { if (k in p) c[k] = Math.max(lo, Math.min(hi, Math.round(+p[k] || 0))); };
  if (['none', 'admins', 'all'].includes(p.require2fa)) c.require2fa = p.require2fa;
  num('sessionDays', 1, 365); num('minPassword', 8, 64); num('banAfter', 3, 100); num('banWindowMin', 1, 1440); num('banHours', 0, 24 * 365);
  if ('regPassword' in p) c.regPassword = String(p.regPassword || '').trim().slice(0, 64);
  if (Array.isArray(p.allowlist)) c.allowlist = p.allowlist.map(x => String(x).trim()).filter(x => /^[0-9a-f.:]{2,45}$/i.test(x)).slice(0, 50);
  kvSet('policy', c); cache = c; return c;
}
// two factors for every session: a passkey (device + Face ID / PIN), or password + authenticator code.
// Returns why a session is not enough yet: 'passkey' (sign in with your passkey) or 'setup' (no second factor yet), else false.
export const needs2fa = u => {
  if (u.session_mfa) return false;
  return get('SELECT 1 FROM passkeys WHERE user_id = ?', u.id) || u.totp_on ? 'passkey' : 'setup';
};

// ---------- IP bans ----------
const isLocal = ip => !ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
const allowed = ip => isLocal(ip) || policy().allowlist.some(a => ip === a || ip.startsWith(a) || ip === '::ffff:' + a || ip.startsWith('::ffff:' + a));
export function isBanned(ip) {
  if (allowed(ip)) return null;
  const b = get('SELECT * FROM ip_bans WHERE ip = ?', ip);
  if (!b) return null;
  if (b.until && b.until < Date.now()) { run('DELETE FROM ip_bans WHERE ip = ?', ip); return null; }
  run('UPDATE ip_bans SET hits = hits + 1 WHERE ip = ?', ip);
  return b;
}
export function banIp(ip, reason, hours = policy().banHours, by = null) {
  if (allowed(ip)) return false;
  const until = hours ? Date.now() + hours * 3600e3 : 0;   // 0 = permanent
  run(`INSERT INTO ip_bans(ip, until, reason, created_at, by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET until = excluded.until, reason = excluded.reason, created_at = excluded.created_at, by = excluded.by`,
    ip, until, String(reason).slice(0, 200), Date.now(), by);
  syslog('warn', 'security', `IP ${ip} banned ${hours ? `for ${hours} h` : 'permanently'}: ${reason}`);
  return true;
}
export const unbanIp = ip => run('DELETE FROM ip_bans WHERE ip = ?', ip);
export const listBans = () => all('SELECT * FROM ip_bans ORDER BY created_at DESC');

// failed sign-in attempts per IP (password, 2FA code, setup token) → automatic ban
const fails = new Map();
export function recordFailure(ip, what) {
  if (allowed(ip)) return false;
  const p = policy(), now = Date.now(), win = p.banWindowMin * 60000;
  const L = (fails.get(ip) || []).filter(t => now - t < win); L.push(now); fails.set(ip, L);
  if (L.length >= p.banAfter) { fails.delete(ip); return banIp(ip, `${L.length} failed ${what} attempts within ${p.banWindowMin} min`); }
  return false;
}
export const clearFailures = ip => fails.delete(ip);
setInterval(() => { const now = Date.now(); for (const [ip, L] of fails) if (!L.some(t => now - t < 24 * 3600e3)) fails.delete(ip); }, 3600e3).unref();
