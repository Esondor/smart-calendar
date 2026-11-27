import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fstatic from '@fastify/static';
import { config } from './config.js';
import { all } from './db.js';
import authRoutes, { userFromRequest, setupToken } from './auth.js';
import apiRoutes from './api.js';
import adminRoutes from './admin.js';
import extRoutes from './ext.js';
import passkeyRoutes from './passkeys.js';
import inviteRoutes from './invites.js';
import oauthRoutes from './oauth.js';
import mcpRoutes from './mcp.js';
import { startBackups } from './backup.js';
import publicPages from './public-pages.js';
import { serverConf } from './serverconf.js';
import { isBanned, needs2fa } from './policy.js';
import { syslog } from './logs.js';
import { startSync, googlePushed, vikunjaPushed } from './sync/loop.js';
import * as google from './sync/google.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, trustProxy: config.trustProxy, bodyLimit: 1024 * 1024 });

await app.register(cookie);
await app.register(helmet, {
  contentSecurityPolicy: { useDefaults: false, directives: {
    'default-src': ["'self'"], 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:'],
    'connect-src': ["'self'"], 'font-src': ["'self'"], 'object-src': ["'none'"], 'base-uri': ["'none'"], 'frame-ancestors': ["'none'"],
    'form-action': ["'self'"], 'worker-src': ["'self'"], 'manifest-src': ["'self'"] } },
  crossOriginEmbedderPolicy: false,
  frameguard: false,   // framing is controlled by CSP frame-ancestors (wall display may be embedded in Home Assistant)
  hsts: { maxAge: 15552000, includeSubDomains: false },   // browsers ignore it on plain http
  referrerPolicy: { policy: 'same-origin' },
});
await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

// auth gate + CSRF guard for the API
const OPEN = new Set(['/api/setup', '/api/auth/login', '/api/health', '/api/auth/passkey/options', '/api/auth/passkey/verify', '/api/auth/register']);
// banned IPs (brute force) get nothing at all, not even the login page
app.addHook('onRequest', async (req, reply) => {
  const ban = isBanned(req.ip);
  if (ban) return reply.code(403).type('text/plain').send(`Access from ${req.ip} is blocked${ban.until ? ' until ' + new Date(ban.until).toLocaleString('en-GB') : ''}.`);
});
const OPEN_2FA = new Set(['/api/bootstrap', '/api/auth/logout', '/api/me/totp/start', '/api/me/totp/enable', '/api/stream', '/api/passkeys/register/options', '/api/passkeys/register/verify']);
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return;
  if (req.url === '/api/google/push') { delete req.headers['content-type']; return; }   // no body; the channel token is checked in the route
  if (req.url.startsWith('/api/vikunja/push/')) return;                                   // signed body, checked in the route
  if (req.url.startsWith('/api/ext/') || req.url.startsWith('/api/wall')) return;   // token auth inside the routes, no cookies → no CSRF
  if (req.url.startsWith('/api/book/')) { if (req.method !== 'GET' && req.headers['x-sc'] !== '1') return reply.code(403).send({ error: 'Missing request header' }); return; }   // public booking page: the link's token
  const p = req.url.split('?')[0];
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-sc'] !== '1') return reply.code(403).send({ error: 'Missing request header' });
  if (OPEN.has(p) || p.startsWith('/api/auth/invite/')) return;
  req.user = userFromRequest(req);
  if (!req.user) return reply.code(401).send({ error: 'Not signed in' });
  // policy: 2FA required → only the 2FA setup is reachable until it is on
  const why = needs2fa(req.user);
  if (why && !OPEN_2FA.has(p)) return reply.code(403).send({ error: why === 'passkey' ? 'Sign in with your passkey' : 'Add a second factor first', code: 'need2fa', reason: why });
});
app.setErrorHandler((err, req, reply) => {
  const code = err.statusCode || 500;
  if (code >= 500) { req.log.error(err); syslog('error', 'http', `${req.method} ${req.url.split('?')[0]}: ${err.message}`, req.user?.id); }
  reply.code(code).send({ error: code >= 500 && !err.expose ? 'Server error' : err.message });
});

app.get('/api/health', async () => ({ ok: true }));
// Google Calendar push: a calendar changed (the channel's secret token is checked; unknown channels get nothing)
// Vikunja webhook: the raw body is needed to check its signature
await app.register(async s => {
  s.removeAllContentTypeParsers(); s.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (req, body, done) => done(null, body));
  s.post('/api/vikunja/push/:acc', async (req, reply) => {
    vikunjaPushed(req.params.acc, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.headers['x-vikunja-signature']);
    return reply.code(200).send();
  });
});
app.post('/api/google/push', async (req, reply) => {
  const h = req.headers;
  googlePushed(h['x-goog-channel-id'], h['x-goog-channel-token'], h['x-goog-resource-state']);
  return reply.code(200).send();
});
// the wall display may be framed by the Home Assistant origins configured by the admin
app.addHook('onSend', async (req, reply, payload) => {
  if (/^\/wall(\.html)?(\?|$)|^\/js\/wall\.js/.test(req.url)) {
    const anc = ["'self'", ...serverConf().embedOrigins].join(' ');
    const csp = String(reply.getHeader('content-security-policy') || '').replace(/frame-ancestors [^;]*/, 'frame-ancestors ' + anc);
    reply.header('content-security-policy', csp);
  }
  return payload;
});
app.get('/wall', (req, reply) => reply.sendFile('wall.html'));
await app.register(authRoutes);
await app.register(apiRoutes);
await app.register((await import('./booking-routes.js')).default);
await app.register(adminRoutes);
await app.register(extRoutes);
await app.register(passkeyRoutes);
await app.register(inviteRoutes);
await app.register(oauthRoutes);   // Claude connector: sign-in, then /mcp (off unless a user turns it on)
await app.register(mcpRoutes);
startBackups();
// flexible appointments made before they had their own project move into "Appointments"
import('./flex.js').then(({ appointmentsProject }) => {
  for (const r of all(`SELECT DISTINCT created_by AS uid FROM tasks WHERE status != 'done' AND json_extract(meta, '$.win') IS NOT NULL AND created_by IS NOT NULL`)) appointmentsProject(r.uid);
}).catch(e => console.warn('appointments', e.message));
await app.register(publicPages);

await app.register(fstatic, { root: path.join(ROOT, 'public'), prefix: '/', index: ['index.html'], cacheControl: false,
  setHeaders: (reply, p) => reply.header('cache-control', /sw\.js$|index\.html$/.test(p) ? 'no-cache' : 'public, max-age=300') });
// vendored ES modules; bare "preact" imports rewritten so no (inline) import map is needed under the strict CSP
const vendor = { 'preact.mjs': 'preact/dist/preact.mjs', 'hooks.mjs': 'preact/hooks/dist/hooks.mjs', 'htm.mjs': 'htm/dist/htm.mjs' };
const vcache = {};
for (const [name, file] of Object.entries(vendor)) app.get('/vendor/' + name, (req, reply) => {
  vcache[name] ??= fs.readFileSync(path.join(ROOT, 'node_modules', file), 'utf8').replace(/from\s*["']preact["']/g, 'from"/vendor/preact.mjs"').replace(/\/\/# sourceMappingURL=.*$/m, '');
  return reply.type('text/javascript').header('cache-control', 'public, max-age=86400').send(vcache[name]);
});

await app.listen({ port: config.port, host: config.host });
const tok = setupToken();
if (tok) app.log.warn(`\n\n  First start: open the app and use this setup token to create the admin account:\n\n      ${tok}\n\n  (also saved as SETUP-TOKEN.txt in the data volume)\n`);
if (!google.enabled()) app.log.info('Google Calendar not set up yet: the admin does it in the app under Settings → Server');
startSync();

for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await app.close(); process.exit(0); });
