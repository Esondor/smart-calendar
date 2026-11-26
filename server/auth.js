import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { config } from './config.js';
import { all, get, run, kvGet, kvSet } from './db.js';
import { hashPassword, verifyPassword, dummyVerify, randomToken, sha256, safeEqual, newTotpSecret, verifyTotp, encrypt, decrypt } from './crypto.js';
import { publicUser, settingsOf } from './models.js';
import { planAll } from './planner.js';
import { audit } from './logs.js';
import { policy, recordFailure, clearFailures } from './policy.js';

const COOKIE = 'sc_session';
const cookieOpts = req => ({ path: '/', httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https', maxAge: policy().sessionDays * 86400 });
const COLORS = ['#0f5f5c', '#c2255c', '#1971c2', '#e8590c', '#7048e8', '#2b8a3e'];

// first start: a one-time setup token (logged + saved in the data volume) is needed to create the admin
export function setupToken() {
  if (get('SELECT 1 FROM users LIMIT 1')) return null;
  let t = kvGet('setupToken');
  if (!t) { t = randomToken(18); kvSet('setupToken', t); }
  try { fs.writeFileSync(path.join(config.dataDir, 'SETUP-TOKEN.txt'), t + '\n', { mode: 0o600 }); } catch {}
  return t;
}

export function createUser({ username, name, password, is_admin = 0 }) {
  username = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) throw httpErr(400, 'Username: 2–32 characters a–z, 0–9, . _ -');
  checkPassword(password);
  if (get('SELECT 1 FROM users WHERE username = ?', username)) throw httpErr(409, 'Username already taken');
  const n = get('SELECT COUNT(*) AS n FROM users').n;
  const id = Number(run('INSERT INTO users(username, name, color, pw_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    username, String(name || username).slice(0, 60), COLORS[n % COLORS.length], hashPassword(password), is_admin ? 1 : 0, Date.now()).lastInsertRowid);
  // everyone gets a personal "Inbox" project
  const pid = Number(run(`INSERT INTO projects(name, color, kind, owner_id, schedule, created_at, sort) VALUES ('Inbox', '#868e96', 'board', ?, 'work', ?, 0)`, id, Date.now()).lastInsertRowid);
  run(`INSERT INTO project_members(project_id, user_id, role) VALUES (?, ?, 'owner')`, pid, id);
  planAll();
  return id;
}
export function checkPassword(pw) { const n = policy().minPassword; if (typeof pw !== 'string' || pw.length < n) throw httpErr(400, `Password: at least ${n} characters`); if (pw.length > 200) throw httpErr(400, 'Password too long'); }
export const httpErr = (code, msg) => Object.assign(new Error(msg), { statusCode: code, expose: true });

export function newSession(req, reply, uid, ua, mfa = false) {
  const tok = randomToken(32), now = Date.now();
  run('INSERT INTO sessions(token_hash, user_id, created_at, expires_at, last_seen, ua, ip, mfa) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', sha256(tok), uid, now, now + policy().sessionDays * 864e5, now, String(ua || '').slice(0, 200), req.ip, mfa ? 1 : 0);
  run('UPDATE users SET last_login = ? WHERE id = ?', now, uid);
  run('DELETE FROM sessions WHERE expires_at < ?', now);
  reply.setCookie(COOKIE, tok, cookieOpts(req));
}
export function userFromRequest(req) {
  const tok = req.cookies?.[COOKIE]; if (!tok) return null;
  const s = get('SELECT * FROM sessions WHERE token_hash = ?', sha256(tok));
  if (!s || s.expires_at < Date.now()) return null;
  if (Date.now() - s.last_seen > 3600e3) run('UPDATE sessions SET last_seen = ?, expires_at = ?, ip = ? WHERE token_hash = ?', Date.now(), Date.now() + policy().sessionDays * 864e5, req.ip, s.token_hash);
  const u = get('SELECT * FROM users WHERE id = ?', s.user_id);
  return u && !u.disabled ? { ...u, session_mfa: !!s.mfa, session_hash: s.token_hash } : null;
}
export const markSessionMfa = req => { if (req.user?.session_hash) run('UPDATE sessions SET mfa = 1 WHERE token_hash = ?', req.user.session_hash); };
// a signed-in session without a second factor may only add the first one, never a further one
export const mayEnroll = u => u.session_mfa || (!u.totp_on && !get('SELECT 1 FROM passkeys WHERE user_id = ?', u.id));

// failed logins: per username + per IP, exponential lockout
const fails = new Map();
const lockedFor = k => { const f = fails.get(k); return f && f.until > Date.now() ? f.until - Date.now() : 0; };
const fail = k => { const f = fails.get(k) || { n: 0, until: 0 }; f.n++; if (f.n >= 5) f.until = Date.now() + Math.min(3600e3, 30000 * 2 ** (f.n - 5)); fails.set(k, f); };

export default async function authRoutes(app) {
  app.get('/api/setup', async () => ({ needed: !get('SELECT 1 FROM users LIMIT 1') }));
  app.post('/api/setup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const t = setupToken();
    if (!t) throw httpErr(409, 'Already set up');
    if (!safeEqual(String(req.body?.token || '').trim(), t)) { recordFailure(req.ip, 'setup token'); audit(req, 'setup.fail'); throw httpErr(403, 'Wrong setup token (see the container log or SETUP-TOKEN.txt in the data volume)'); }
    const id = createUser({ ...req.body, is_admin: 1 });
    kvSet('setupToken', null);
    try { fs.unlinkSync(path.join(config.dataDir, 'SETUP-TOKEN.txt')); } catch {}
    newSession(req, reply, id, req.headers['user-agent']);
    audit(req, 'setup', 'first admin created', id, id);
    return { ok: true };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const username = String(req.body?.username || '').trim().toLowerCase(), pw = String(req.body?.password || '');
    const keyU = 'u:' + username, keyI = 'i:' + req.ip, wait = Math.max(lockedFor(keyU), lockedFor(keyI));
    // still trying while locked out = brute force: counts towards the IP ban
    if (wait) { if (recordFailure(req.ip, 'sign-in')) audit(req, 'login.fail', 'kept trying while locked out → IP banned'); throw httpErr(429, `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.`); }
    const u = get('SELECT * FROM users WHERE username = ?', username);
    const ok = u ? verifyPassword(pw, u.pw_hash) : (dummyVerify(), false);
    if (!ok) { fail(keyU); fail(keyI); const banned = recordFailure(req.ip, 'sign-in'); audit(req, 'login.fail', `user “${username.slice(0, 40)}”${banned ? ' → IP banned' : ''}`, u?.id ?? null); throw httpErr(401, 'Wrong username or password'); }
    if (u.disabled) { audit(req, 'login.blocked', 'account disabled', u.id); throw httpErr(403, 'This account is disabled. Ask the admin.'); }
    if (u.totp_on) {
      if (!req.body?.code) return { needCode: true };
      const sec = decrypt(u.totp_secret), last = kvGet('totp-last:' + u.id) || 0, step = verifyTotp(sec.s, req.body.code, last);
      if (!step) { fail(keyU); fail(keyI); recordFailure(req.ip, '2FA'); audit(req, 'login.fail', 'wrong 2FA code', u.id); throw httpErr(401, 'Wrong 2FA code'); }
      kvSet('totp-last:' + u.id, step);
    }
    fails.delete(keyU); fails.delete(keyI); clearFailures(req.ip);
    newSession(req, reply, u.id, req.headers['user-agent'], !!u.totp_on);   // password + code = two factors
    audit(req, 'login', String(req.headers['user-agent'] || '').slice(0, 120), u.id, u.id);
    return { ok: true };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    const tok = req.cookies?.[COOKIE]; if (tok) { const s = get('SELECT user_id FROM sessions WHERE token_hash = ?', sha256(tok)); run('DELETE FROM sessions WHERE token_hash = ?', sha256(tok)); if (s) audit(req, 'logout', '', s.user_id, s.user_id); }
    reply.clearCookie(COOKIE, { path: '/' }); return { ok: true };
  });

  // ---- own account ----
  app.post('/api/me/password', async req => {
    const u = req.user;
    if (!verifyPassword(String(req.body?.current || ''), u.pw_hash)) { recordFailure(req.ip, 'password check'); throw httpErr(403, 'Current password is wrong'); }
    checkPassword(req.body?.password);
    run('UPDATE users SET pw_hash = ? WHERE id = ?', hashPassword(req.body.password), u.id);
    run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', u.id, sha256(req.cookies[COOKIE]));   // sign out other devices
    audit(req, 'password.change', '', u.id);
    return { ok: true };
  });
  app.patch('/api/me', async req => {
    const b = req.body || {};
    if (b.name) run('UPDATE users SET name = ? WHERE id = ?', String(b.name).slice(0, 60), req.user.id);
    if ('email' in b) {
      const m = String(b.email || '').trim();
      if (m && !/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(m)) throw httpErr(400, 'Not a valid e-mail address');
      run('UPDATE users SET email = ? WHERE id = ?', m.slice(0, 200) || null, req.user.id);
    }
    if (b.color && /^#[0-9a-f]{6}$/i.test(b.color)) run('UPDATE users SET color = ? WHERE id = ?', b.color, req.user.id);
    return publicUser(get('SELECT * FROM users WHERE id = ?', req.user.id));
  });
  app.post('/api/me/totp/start', async req => {
    if (!mayEnroll(req.user)) throw httpErr(403, 'Sign in with your passkey first');
    const s = newTotpSecret();
    run('UPDATE users SET totp_secret = ? WHERE id = ? AND totp_on = 0', encrypt({ s }), req.user.id);
    const uri = `otpauth://totp/Smart%20Calendar:${encodeURIComponent(req.user.username)}?secret=${s}&issuer=Smart%20Calendar`;
    return { secret: s, uri, qr: await QRCode.toString(uri, { type: 'svg', margin: 1 }) };
  });
  app.post('/api/me/totp/enable', async req => {
    const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!u.totp_secret) throw httpErr(400, 'Start the setup first');
    const step = verifyTotp(decrypt(u.totp_secret).s, req.body?.code, 0);
    if (!step) throw httpErr(400, 'Code does not match. Check the time on your phone.');
    if (!mayEnroll(req.user)) throw httpErr(403, 'Sign in with your passkey first');
    run('UPDATE users SET totp_on = 1 WHERE id = ?', u.id); kvSet('totp-last:' + u.id, step); audit(req, '2fa.on', '', u.id); markSessionMfa(req);
    return { ok: true };
  });
  app.post('/api/me/totp/disable', async req => {
    if (!get('SELECT 1 FROM passkeys WHERE user_id = ?', req.user.id)) throw httpErr(400, 'This is your only second factor. Add a passkey first.');
    if (!verifyPassword(String(req.body?.password || ''), req.user.pw_hash)) { recordFailure(req.ip, 'password check'); throw httpErr(403, 'Password is wrong'); }
    run('UPDATE users SET totp_on = 0, totp_secret = NULL WHERE id = ?', req.user.id); audit(req, '2fa.off', '', req.user.id); return { ok: true };
  });
  app.get('/api/me/sessions', async req => { const cur = sha256(req.cookies[COOKIE]); return all('SELECT token_hash, created_at, last_seen, ua, ip FROM sessions WHERE user_id = ? ORDER BY last_seen DESC', req.user.id).map(s => ({ id: s.token_hash.slice(0, 12), current: s.token_hash === cur, created_at: s.created_at, last_seen: s.last_seen, ua: s.ua, ip: s.ip })); });
  app.post('/api/me/sessions/revoke-others', async req => { run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', req.user.id, sha256(req.cookies[COOKIE])); audit(req, 'sessions.revoke', 'own other devices', req.user.id); return { ok: true }; });

  // everyone may see who is on the server (to share projects) – nothing sensitive
  app.get('/api/users', async () => all('SELECT id, username, name, color FROM users WHERE disabled = 0 ORDER BY id'));
}
export { COOKIE };
