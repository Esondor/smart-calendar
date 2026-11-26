// Claude connector, part 1: OAuth 2.1 so a Claude app (claude.ai, the Claude apps, Claude Code) can act for one user.
// Off for everyone until a user turns it on for their own account (Settings → Claude). Nothing about Claude is stored
// on the server: each user connects from their own Claude account, and every connection only reaches that user's projects.
//   /.well-known/oauth-protected-resource   where to sign in (RFC 9728)
//   /.well-known/oauth-authorization-server  endpoints (RFC 8414)
//   /oauth/register   dynamic client registration (RFC 7591), only Claude's callback or a loopback address
//   /oauth/authorize  consent page, needs a signed-in session with two factors if the account has them
//   /oauth/token      code (PKCE S256) → access token (1 h) + refresh token (60 days, rotated)
import crypto from 'node:crypto';
import { all, get, run } from './db.js';
import { randomToken, sha256, safeEqual, derive } from './crypto.js';
import { userFromRequest, httpErr } from './auth.js';
import { needs2fa, recordFailure } from './policy.js';
import { settingsOf, saveSettings } from './models.js';
import { audit } from './logs.js';
import { serverConf, baseUrl } from './serverconf.js';
import { page, esc } from './public-pages.js';

const ACCESS_MS = 3600e3, REFRESH_MS = 60 * 864e5, CODE_MS = 5 * 60e3, SCOPE = 'plan';

export const claudeOn = uid => settingsOf(uid).claude === true;
export const issuer = req => serverConf().baseUrl || `${req.protocol}://${req.host}`;
export const resourceUrl = req => issuer(req) + '/mcp';

// where a code may be sent: Claude's own callback, or this computer (Claude Code / Claude Desktop)
export function okRedirect(u) {
  try {
    const x = new URL(u);
    if (x.hash || x.username || x.password) return false;
    if (x.protocol === 'https:' && ['claude.ai', 'claude.com'].includes(x.hostname) && !x.port && x.pathname === '/api/mcp/auth_callback') return true;
    if (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)) return true;
  } catch {}
  return false;
}
const s256 = v => crypto.createHash('sha256').update(v).digest('base64url');

// the user behind "Authorization: Bearer …" on /mcp, or null
export function userFromBearer(req) {
  const h = req.headers.authorization || '', tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!tok) return null;
  const t = get('SELECT * FROM oauth_tokens WHERE access_hash = ?', sha256(tok));
  if (!t || t.access_exp < Date.now()) { if (!t) recordFailure(req.ip, 'Claude token'); return null; }
  const u = get('SELECT * FROM users WHERE id = ? AND disabled = 0', t.user_id);
  if (!u || !claudeOn(u.id)) return null;
  if (!t.last_used || Date.now() - t.last_used > 60000) run('UPDATE oauth_tokens SET last_used = ?, ip = ? WHERE id = ?', Date.now(), req.ip, t.id);
  return { u, grant: t };
}
export const forgetClaude = uid => { run('DELETE FROM oauth_tokens WHERE user_id = ?', uid); run('DELETE FROM oauth_codes WHERE user_id = ?', uid); };

function issue(row) {
  const access = 'sca_' + randomToken(32), refresh = 'scr_' + randomToken(32), now = Date.now();
  run('UPDATE oauth_tokens SET access_hash = ?, access_exp = ?, refresh_hash = ?, refresh_exp = ? WHERE id = ?', sha256(access), now + ACCESS_MS, sha256(refresh), now + REFRESH_MS, row);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_MS / 1000, refresh_token: refresh, scope: SCOPE };
}
const oerr = (reply, code, error, desc) => reply.code(code).header('cache-control', 'no-store').send({ error, ...(desc ? { error_description: desc } : {}) });

// client authentication at the token endpoint: public clients send only their id, confidential ones a secret too
function clientOf(req) {
  let id = req.body?.client_id, secret = req.body?.client_secret;
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) { const [a, b] = Buffer.from(h.slice(6), 'base64').toString().split(':'); id = decodeURIComponent(a || ''); secret = decodeURIComponent(b || ''); }
  const c = id && get('SELECT * FROM oauth_clients WHERE id = ?', String(id));
  if (!c) return null;
  if (c.secret_hash && !(secret && safeEqual(sha256(String(secret)), c.secret_hash))) return null;
  return c;
}

const csrfFor = req => derive('oauth-consent:' + req.user.session_hash);
const consentPage = (title, body) => page(title, `<img src="/icon.svg" alt="">${body}`).replace('</style>', `
form{display:flex;gap:12px;margin-top:28px}button{font:inherit;font-weight:600;border:0;border-radius:12px;padding:11px 22px;cursor:pointer}
.allow{background:#007aff;color:#fff}.deny{background:color-mix(in srgb,CanvasText 10%,transparent);color:inherit}.who{font-size:15px;opacity:.6}</style>`);

export default async function oauthRoutes(app) {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64 * 1024 }, (req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body))));

  // ---------- discovery ----------
  const prm = req => ({ resource: resourceUrl(req), authorization_servers: [issuer(req)], scopes_supported: [SCOPE], bearer_methods_supported: ['header'] });
  const asm = req => { const i = issuer(req); return { issuer: i, authorization_endpoint: i + '/oauth/authorize', token_endpoint: i + '/oauth/token', registration_endpoint: i + '/oauth/register', revocation_endpoint: i + '/oauth/revoke',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: [SCOPE] }; };
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) app.get(p, async req => prm(req));
  for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration']) app.get(p, async req => asm(req));

  // ---------- registration ----------
  app.post('/oauth/register', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = req.body || {}, uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String).slice(0, 5) : [];
    if (!uris.length || !uris.every(okRedirect)) return oerr(reply, 400, 'invalid_redirect_uri', 'Only Claude can connect to this server');
    const method = ['client_secret_post', 'client_secret_basic'].includes(b.token_endpoint_auth_method) ? b.token_endpoint_auth_method : 'none';
    // registrations nobody used within a day are dropped
    run('DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM oauth_tokens)', Date.now() - 864e5);
    const id = 'scc_' + randomToken(16), secret = method === 'none' ? null : 'scs_' + randomToken(32), name = String(b.client_name || 'Claude').replace(/[\r\n]/g, ' ').slice(0, 60);
    run('INSERT INTO oauth_clients(id, name, redirect_uris, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)', id, name, JSON.stringify(uris), secret ? sha256(secret) : null, Date.now());
    return reply.code(201).header('cache-control', 'no-store').send({ client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}) });
  });

  // ---------- consent ----------
  // checks that need no user; errors here are shown, not sent to a redirect address we cannot trust
  function request(q) {
    const c = q.client_id && get('SELECT * FROM oauth_clients WHERE id = ?', String(q.client_id));
    if (!c) return { bad: 'This connection request is not valid. Start again from Claude.' };
    const uri = String(q.redirect_uri || '');
    if (!JSON.parse(c.redirect_uris).includes(uri)) return { bad: 'This connection request is not valid. Start again from Claude.' };
    const back = (error, extra = {}) => { const u = new URL(uri); u.searchParams.set('error', error); for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v); if (q.state) u.searchParams.set('state', q.state); return u.href; };
    if (q.response_type !== 'code') return { c, uri, redirect: back('unsupported_response_type') };
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge || '')) return { c, uri, redirect: back('invalid_request', { error_description: 'PKCE S256 required' }) };
    return { c, uri, back };
  }
  app.get('/oauth/authorize', async (req, reply) => {
    const q = req.query || {}, r = request(q);
    if (r.bad) return reply.code(400).type('text/html').send(consentPage('Smart Calendar', `<h1>Not Connected</h1><p>${r.bad}</p>`));
    if (r.redirect) return reply.redirect(r.redirect);
    req.user = userFromRequest(req);
    if (!req.user || needs2fa(req.user)) return reply.redirect('/?next=' + encodeURIComponent(req.url));
    if (!claudeOn(req.user.id)) return reply.type('text/html').send(consentPage('Smart Calendar', `<h1>Claude Is Off</h1><p>Turn on Claude for your account in Settings, then connect again.</p><a class="btn" href="/#/settings">Open Settings</a>`));
    const dest = new URL(r.uri), where = dest.protocol === 'https:' ? dest.hostname : 'this computer';
    const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource', 'response_type'].map(k => q[k] != null ? `<input type="hidden" name="${k}" value="${esc(q[k])}">` : '').join('');
    // the browser must be allowed to follow the redirect to Claude after the form is sent
    const csp = reply.getHeader('content-security-policy');
    if (csp) reply.header('content-security-policy', String(csp).replace(/form-action [^;]*/, `form-action 'self' ${dest.origin}`));
    reply.header('cache-control', 'no-store');
    return reply.type('text/html').send(consentPage('Connect Claude', `<h1>Connect ${esc(r.c.name)}</h1>
      <p class="lead">${esc(r.c.name)} will be able to read and change your projects, tasks and plan.</p><p class="who">${esc(req.user.name)} · ${esc(where)}</p>
      <form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="csrf" value="${csrfFor(req)}">
      <button class="deny" name="answer" value="deny">Cancel</button><button class="allow" name="answer" value="allow">Allow</button></form>`));
  });
  app.post('/oauth/authorize', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = req.body || {}, r = request(q);
    if (r.bad) return reply.code(400).type('text/html').send(consentPage('Smart Calendar', `<h1>Not Connected</h1><p>${r.bad}</p>`));
    if (r.redirect) return reply.redirect(r.redirect);
    req.user = userFromRequest(req);
    if (!req.user || needs2fa(req.user) || !safeEqual(String(q.csrf || ''), csrfFor(req))) return reply.code(403).type('text/html').send(consentPage('Smart Calendar', '<h1>Not Connected</h1><p>Start again from Claude.</p>'));
    if (!claudeOn(req.user.id)) return reply.redirect(r.back('access_denied'));
    if (q.answer !== 'allow') return reply.redirect(r.back('access_denied'));
    const code = randomToken(32);
    run('DELETE FROM oauth_codes WHERE expires_at < ?', Date.now());
    run('INSERT INTO oauth_codes(code_hash, client_id, user_id, redirect_uri, challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', sha256(code), r.c.id, req.user.id, r.uri, q.code_challenge, SCOPE, Date.now() + CODE_MS);
    audit(req, 'claude.allow', r.c.name);
    const u = new URL(r.uri); u.searchParams.set('code', code); if (q.state) u.searchParams.set('state', q.state); u.searchParams.set('iss', issuer(req));
    return reply.redirect(u.href);
  });

  // ---------- tokens ----------
  app.post('/oauth/token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = req.body || {}, c = clientOf(req);
    if (!c) { recordFailure(req.ip, 'Claude client'); return oerr(reply, 401, 'invalid_client'); }
    if (b.grant_type === 'authorization_code') {
      const row = get('SELECT * FROM oauth_codes WHERE code_hash = ?', sha256(String(b.code || '')));
      if (row) run('DELETE FROM oauth_codes WHERE code_hash = ?', row.code_hash);   // single use
      if (!row || row.client_id !== c.id || row.expires_at < Date.now() || row.redirect_uri !== String(b.redirect_uri || '') || !safeEqual(s256(String(b.code_verifier || '')), row.challenge)) {
        recordFailure(req.ip, 'Claude code'); return oerr(reply, 400, 'invalid_grant');
      }
      if (!claudeOn(row.user_id)) return oerr(reply, 400, 'invalid_grant', 'Claude is off for this account');
      const id = Number(run('INSERT INTO oauth_tokens(user_id, client_id, created_at, ip) VALUES (?, ?, ?, ?)', row.user_id, c.id, Date.now(), req.ip).lastInsertRowid);
      return reply.header('cache-control', 'no-store').send(issue(id));
    }
    if (b.grant_type === 'refresh_token') {
      const t = get('SELECT * FROM oauth_tokens WHERE refresh_hash = ?', sha256(String(b.refresh_token || '')));
      if (!t || t.client_id !== c.id || t.refresh_exp < Date.now()) { recordFailure(req.ip, 'Claude refresh'); return oerr(reply, 400, 'invalid_grant'); }
      const u = get('SELECT id FROM users WHERE id = ? AND disabled = 0', t.user_id);
      if (!u || !claudeOn(u.id)) { run('DELETE FROM oauth_tokens WHERE id = ?', t.id); return oerr(reply, 400, 'invalid_grant'); }
      return reply.header('cache-control', 'no-store').send(issue(t.id));
    }
    return oerr(reply, 400, 'unsupported_grant_type');
  });
  app.post('/oauth/revoke', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const h = sha256(String(req.body?.token || '')), c = clientOf(req);
    if (c) run('DELETE FROM oauth_tokens WHERE client_id = ? AND (access_hash = ? OR refresh_hash = ?)', c.id, h, h);
    return reply.code(200).send({});
  });

  // ---------- the user's own switch and connections (Settings → Claude) ----------
  app.get('/api/me/claude', async req => ({ on: claudeOn(req.user.id), url: baseUrl() + '/mcp',
    connections: all('SELECT t.id, c.name, t.created_at, t.last_used FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id WHERE t.user_id = ? ORDER BY t.id', req.user.id) }));
  app.put('/api/me/claude', async req => {
    const on = req.body?.on === true, s = settingsOf(req.user.id);
    if (on) s.claude = true; else { delete s.claude; forgetClaude(req.user.id); }
    saveSettings(req.user.id, s); audit(req, on ? 'claude.on' : 'claude.off');
    return { on };
  });
  app.delete('/api/me/claude/:id', async req => {
    const r = run('DELETE FROM oauth_tokens WHERE id = ? AND user_id = ?', +req.params.id, req.user.id);
    if (!r.changes) throw httpErr(404, 'Not found');
    audit(req, 'claude.disconnect'); return { ok: true };
  });
}
