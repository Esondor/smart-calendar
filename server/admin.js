// Admin panel API: server setup, users, access policy, IP bans, audit + system log, status.
import fs from 'node:fs';
import { config } from './config.js';
import { all, get, run, tx } from './db.js';
import { hashPassword } from './crypto.js';
import { createUser, checkPassword, httpErr } from './auth.js';
import { backupNow, backupStatus, resolveBackupDir, checkBackupDir } from './backup.js';
import { audit } from './logs.js';
import { policy, setPolicy, listBans, banIp, unbanIp } from './policy.js';
import { serverConf, setServerConf } from './serverconf.js';
import * as google from './sync/google.js';
import { planAll } from './planner.js';
import { syncState } from './sync/loop.js';

const started = Date.now();
const userName = id => id == null ? null : (get('SELECT name FROM users WHERE id = ?', id) || {}).name || `#${id}`;
const adminCount = () => get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0').n;
const int = (v, d) => isNaN(+v) || v === '' || v == null ? d : Math.round(+v);

export default async function adminRoutes(app) {
  app.addHook('onRequest', async req => {
    if (req.url.startsWith('/api/admin/') && !(req.user && req.user.is_admin)) throw httpErr(403, 'Admins only');
  });

  // ---------- status ----------
  app.get('/api/admin/status', async req => {
    let dbSize = 0; for (const f of [config.dbFile, config.dbFile + '-wal']) { try { dbSize += fs.statSync(f).size; } catch {} }
    const c = serverConf();
    return {
      version: '0.3.0', node: process.version, uptime: Date.now() - started, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, dbSize,
      counts: Object.fromEntries(['users', 'projects', 'tasks', 'events', 'push_subs', 'sessions', 'ip_bans'].map(t => [t, get(`SELECT COUNT(*) AS n FROM ${t}`).n])),
      accounts: all(`SELECT a.id, a.kind, a.label, a.status, a.error, a.last_sync, u.name AS user FROM accounts a JOIN users u ON u.id = a.user_id ORDER BY u.id, a.id`),
      errors24h: get(`SELECT COUNT(*) AS n FROM logs WHERE level = 'error' AND at > ?`, Date.now() - 864e5).n,
      failedLogins24h: get(`SELECT COUNT(*) AS n FROM audit WHERE kind = 'login.fail' AND at > ?`, Date.now() - 864e5).n,
      // to verify the reverse proxy passes the real client address (otherwise bans would hit the proxy)
      yourIp: req.ip, forwardedFor: req.headers['x-forwarded-for'] || null, socketIp: req.socket.remoteAddress,
      google: google.enabled(), baseUrl: c.baseUrl, https: c.baseUrl.startsWith('https://'), sync: config.sync, lastRun: syncState().lastRun,
    };
  });

  // ---------- server setup ----------
  app.get('/api/admin/server', async () => {
    const c = serverConf();
    return { hasMapsKey: !!c.mapsKey, contact: c.contact, embedOrigins: c.embedOrigins, baseUrl: c.baseUrl, redirectUri: google.redirectUri(), googleClientId: c.googleClientId, hasSecret: !!c.googleClientSecret, vapidSubject: c.vapidSubject, fromEnv: c.fromEnv, https: c.baseUrl.startsWith('https://') };
  });
  // ---------- Google Maps: try the key with a real search ----------
  app.post('/api/admin/maps/test', async req => {
    const { suggest, place, travel, mapsReady } = await import('./maps.js');
    if (!mapsReady()) throw httpErr(400, 'Paste the API key and save first');
    const q = String(req.body?.q || 'Rathaus').slice(0, 100), out = { query: q };
    try { out.suggestions = await suggest(req.user.id, q, 'admin-test'); } catch (e) { return { ...out, ok: false, error: e.message }; }
    if (out.suggestions[0]) { try { out.place = await place(out.suggestions[0].id, 'admin-test'); } catch (e) { return { ...out, ok: false, error: e.message }; } }
    if (out.place) { try { out.travel = await travel(req.user.id, out.place.address); } catch (e) { out.travelError = e.message; } }
    return { ...out, ok: true };
  });

  // ---------- e-mail (SMTP) ----------
  const smtpOut = () => { const m = serverConf().smtp; return { host: m.host, port: m.port, security: m.security, user: m.user, from: m.from, hasPass: !!m.pass }; };
  app.get('/api/admin/smtp', async () => smtpOut());
  app.put('/api/admin/smtp', async req => {
    const b = req.body || {};
    if (b.from && !/^[^\r\n<>]*<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(String(b.from).trim())) throw httpErr(400, 'Sender: an address like calendar@example.com');
    setServerConf({ smtp: b }); audit(req, 'server.smtp', b.clear ? 'removed' : (b.host || ''));
    return smtpOut();
  });
  app.post('/api/admin/smtp/test', async req => {
    const to = String(req.body?.to || get('SELECT email FROM users WHERE id = ?', req.user.id)?.email || '').trim();
    if (!to) throw httpErr(400, 'Enter an address to send the test to');
    const { testMail } = await import('./mail.js');
    try { return await testMail(to); } catch (e) { throw httpErr(400, e.message); }
  });
  app.put('/api/admin/server', async req => {
    const b = req.body || {};
    if (b.baseUrl) { try { const u = new URL(b.baseUrl); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { throw httpErr(400, 'Public address must look like https://plan.example.com'); } }
    if (b.googleClientId && !/\.apps\.googleusercontent\.com$/.test(String(b.googleClientId).trim())) throw httpErr(400, 'The client ID ends with .apps.googleusercontent.com');
    setServerConf(b);
    audit(req, 'server.config', Object.keys(b).filter(k => b[k] !== '' && b[k] != null).map(k => k === 'googleClientSecret' ? 'google secret' : k).join(', '));
    return { ok: true };
  });

  // ---------- users ----------
  app.get('/api/admin/users', async () => all(`SELECT u.id, u.username, u.name, u.color, u.is_admin, u.disabled, u.totp_on, u.created_at, u.last_login,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions,
      (SELECT GROUP_CONCAT(kind || ':' || status) FROM accounts a WHERE a.user_id = u.id) AS accounts,
      (SELECT COUNT(*) FROM project_members m WHERE m.user_id = u.id) AS projects
    FROM users u ORDER BY u.id`, Date.now()));
  app.post('/api/admin/users', async req => {
    const id = createUser({ ...req.body, is_admin: req.body?.is_admin ? 1 : 0 });
    audit(req, 'user.create', `@${String(req.body?.username).toLowerCase()}${req.body?.is_admin ? ' (admin)' : ''}`, id);
    return { id };
  });
  app.patch('/api/admin/users/:id', async req => {
    const id = +req.params.id, u = get('SELECT * FROM users WHERE id = ?', id), b = req.body || {};
    if (!u) throw httpErr(404, 'No such user');
    if ('is_admin' in b && !b.is_admin && u.is_admin && adminCount() <= 1) throw httpErr(400, 'There must be at least one admin');
    if ('disabled' in b && b.disabled && u.is_admin && adminCount() <= 1) throw httpErr(400, 'You cannot disable the last admin');
    if ('disabled' in b && b.disabled && id === req.user.id) throw httpErr(400, 'You cannot disable yourself');
    if ('name' in b && String(b.name).trim()) { run('UPDATE users SET name = ? WHERE id = ?', String(b.name).trim().slice(0, 60), id); audit(req, 'user.rename', String(b.name).slice(0, 60), id); }
    if ('is_admin' in b && !!b.is_admin !== !!u.is_admin) { run('UPDATE users SET is_admin = ? WHERE id = ?', b.is_admin ? 1 : 0, id); audit(req, b.is_admin ? 'user.promote' : 'user.demote', `@${u.username}`, id); }
    if ('disabled' in b && !!b.disabled !== !!u.disabled) {
      run('UPDATE users SET disabled = ? WHERE id = ?', b.disabled ? 1 : 0, id);
      if (b.disabled) run('DELETE FROM sessions WHERE user_id = ?', id);
      audit(req, b.disabled ? 'user.disable' : 'user.enable', `@${u.username}`, id); planAll();
    }
    return { ok: true };
  });
  app.post('/api/admin/users/:id/password', async req => {
    const id = +req.params.id; checkPassword(req.body?.password);
    run('UPDATE users SET pw_hash = ? WHERE id = ?', hashPassword(req.body.password), id);
    run('DELETE FROM sessions WHERE user_id = ?', id);
    audit(req, 'user.password-reset', '', id); return { ok: true };
  });
  app.post('/api/admin/users/:id/reset-2fa', async req => {
    const id = +req.params.id; run('UPDATE users SET totp_on = 0, totp_secret = NULL WHERE id = ?', id);
    audit(req, 'user.2fa-reset', '', id); return { ok: true };
  });
  app.get('/api/admin/users/:id/sessions', async req => all('SELECT substr(token_hash, 1, 12) AS id, created_at, last_seen, expires_at, ua, ip FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen DESC', +req.params.id, Date.now()));
  app.post('/api/admin/users/:id/revoke-sessions', async req => {
    const id = +req.params.id, n = run('DELETE FROM sessions WHERE user_id = ?', id).changes;
    audit(req, 'sessions.revoke', `${n} session(s)`, id); return { ok: true, n };
  });
  app.delete('/api/admin/users/:id', async req => {
    const id = +req.params.id, u = get('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw httpErr(404, 'No such user');
    if (id === req.user.id) throw httpErr(400, 'You cannot delete yourself');
    if (u.is_admin && adminCount() <= 1) throw httpErr(400, 'You cannot delete the last admin');
    tx(() => {
      // shared projects survive: ownership goes to another member
      all('SELECT id FROM projects WHERE owner_id = ?', id).forEach(p => {
        const m = get('SELECT user_id FROM project_members WHERE project_id = ? AND user_id != ? ORDER BY user_id LIMIT 1', p.id, id);
        if (m) { run('UPDATE projects SET owner_id = ? WHERE id = ?', m.user_id, p.id); run(`UPDATE project_members SET role = 'owner' WHERE project_id = ? AND user_id = ?`, p.id, m.user_id); }
      });
      run('UPDATE tasks SET assignee_id = NULL WHERE assignee_id = ?', id);
      run('DELETE FROM users WHERE id = ?', id);
    });
    audit(req, 'user.delete', `@${u.username}`, id); planAll(); return { ok: true };
  });

  // ---------- access policy + IP bans ----------
  app.get('/api/admin/policy', async () => policy());
  app.put('/api/admin/policy', async req => {
    if (['admins', 'all'].includes(req.body?.require2fa) && !req.user.totp_on && !get('SELECT 1 FROM passkeys WHERE user_id = ?', req.user.id)) throw httpErr(400, 'Add a passkey or 2FA to your own account first');
    const before = policy(), after = setPolicy(req.body || {});
    const changed = Object.keys(after).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (changed.length) audit(req, 'policy.change', changed.map(k => `${k}=${JSON.stringify(after[k])}`).join(', '));
    return after;
  });
  app.get('/api/admin/bans', async () => listBans());
  app.post('/api/admin/bans', async req => {
    const ip = String(req.body?.ip || '').trim();
    if (!/^[0-9a-f.:]{3,45}$/i.test(ip)) throw httpErr(400, 'Enter an IPv4 or IPv6 address');
    if (ip === req.ip) throw httpErr(400, 'That is your own address');
    if (!banIp(ip, String(req.body?.reason || 'banned by admin'), int(req.body?.hours, 0), req.user.id)) throw httpErr(400, 'This address is on the allowlist');
    audit(req, 'ip.ban', `${ip}${req.body?.reason ? ' – ' + String(req.body.reason).slice(0, 100) : ''}`); return listBans();
  });
  app.delete('/api/admin/bans/:ip', async req => { unbanIp(req.params.ip); audit(req, 'ip.unban', req.params.ip); return listBans(); });

  // ---------- logs ----------
  app.get('/api/admin/audit', async req => {
    const q = req.query, where = ['1 = 1'], args = [];
    if (q.kind) { where.push('a.kind LIKE ?'); args.push(String(q.kind) + '%'); }
    if (q.user) { where.push('(a.actor_id = ? OR a.target_id = ?)'); args.push(+q.user, +q.user); }
    if (q.ip) { where.push('a.ip = ?'); args.push(String(q.ip)); }
    if (q.before) { where.push('a.at < ?'); args.push(+q.before); }
    return all(`SELECT a.*, ua.name AS actor, ut.name AS target FROM audit a LEFT JOIN users ua ON ua.id = a.actor_id LEFT JOIN users ut ON ut.id = a.target_id
      WHERE ${where.join(' AND ')} ORDER BY a.at DESC LIMIT ?`, ...args, Math.min(500, int(q.limit, 200)));
  });
  app.get('/api/admin/logs', async req => {
    const q = req.query, where = ['1 = 1'], args = [];
    if (q.level) { where.push('l.level = ?'); args.push(String(q.level)); }
    if (q.src) { where.push('l.src = ?'); args.push(String(q.src)); }
    if (q.before) { where.push('l.at < ?'); args.push(+q.before); }
    return all(`SELECT l.*, u.name AS user FROM logs l LEFT JOIN users u ON u.id = l.user_id WHERE ${where.join(' AND ')} ORDER BY l.at DESC LIMIT ?`, ...args, Math.min(1000, int(q.limit, 300)));
  });
  // ----- database backups -----
  app.get('/api/admin/backups', async () => backupStatus());
  app.put('/api/admin/backups', async req => {
    const b = req.body || {}, p = {};
    if ('folder' in b) {
      const f = String(b.folder || '').trim().replace(/(.)\/+$/, '$1') || 'backups';
      if (f.split('/').some(x => x === '..' || x === '.') || !/^[\w .\/@-]+$/.test(f)) throw httpErr(400, 'Not a valid folder');
      const dir = resolveBackupDir(f);
      if (dir === config.dataDir || dir.startsWith(config.dataDir + '/') || ['/', '/store', '/app', '/tmp'].includes(dir)) throw httpErr(400, 'Choose a folder outside the data folder');
      const err = checkBackupDir(f);
      if (err === 'no-permission') throw httpErr(400, 'The app may not write to this folder. In DSM File Station give Everyone Read & Write on it.');
      if (err) throw httpErr(400, 'The app cannot reach this folder. Use a folder inside the app folder, or add the path to the volumes in docker-compose.yml.');
      p.backupFolder = f;
    }
    if ('keep' in b) p.backupKeep = b.keep;
    if ('hour' in b) p.backupHour = b.hour;
    setServerConf(p); audit(req, 'backup.config', Object.keys(b).join(', '));
    return backupStatus();
  });
  app.post('/api/admin/backups', async req => { const r = backupNow('manual'); audit(req, 'backup', r.file); return backupStatus(); });
}
export { userName };
