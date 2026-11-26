// Passkeys (WebAuthn): sign in with Face ID / Touch ID / device PIN; passwords stay as fallback.
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { all, get, run } from './db.js';
import { httpErr, newSession, markSessionMfa, mayEnroll } from './auth.js';
import { audit } from './logs.js';
import { recordFailure, clearFailures } from './policy.js';
import { randomToken } from './crypto.js';

const challenges = new Map();            // key -> { challenge, uid?, exp }
const keep = (k, v) => { challenges.set(k, { ...v, exp: Date.now() + 5 * 60000 }); for (const [x, c] of challenges) if (c.exp < Date.now()) challenges.delete(x); };
const take = k => { const c = challenges.get(k); challenges.delete(k); return c && c.exp > Date.now() ? c : null; };
const rp = req => { const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost'); return { rpID: host.split(':')[0], origin: `${req.protocol}://${host}` }; };
const b64 = buf => Buffer.from(buf).toString('base64url');


export default async function passkeyRoutes(app) {
  // ----- register a passkey for the signed-in user -----
  app.post('/api/passkeys/register/options', async req => {
    const u = req.user, { rpID } = rp(req);
    if (!mayEnroll(u)) throw httpErr(403, 'Sign in with your passkey first');
    const opts = await generateRegistrationOptions({
      rpName: 'Smart Calendar', rpID, userName: u.username, userDisplayName: u.name, userID: new TextEncoder().encode('u' + u.id),
      attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: all('SELECT id, transports FROM passkeys WHERE user_id = ?', u.id).map(p => ({ id: p.id, transports: p.transports ? p.transports.split(',') : undefined })),
    });
    keep('reg:' + u.id, { challenge: opts.challenge });
    return opts;
  });
  app.post('/api/passkeys/register/verify', async req => {
    const u = req.user, c = take('reg:' + u.id), { rpID, origin } = rp(req);
    if (!c) throw httpErr(400, 'Expired, try again');
    let v; try { v = await verifyRegistrationResponse({ response: req.body?.credential, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID }); }
    catch (e) { throw httpErr(400, 'Passkey could not be verified'); }
    if (!v.verified) throw httpErr(400, 'Passkey could not be verified');
    const cr = v.registrationInfo.credential;
    const name = String(req.body?.name || '').slice(0, 60) || (/iPhone|iPad/.test(req.headers['user-agent']) ? 'iPhone' : /Mac/.test(req.headers['user-agent']) ? 'Mac' : 'Passkey');
    run('INSERT INTO passkeys(id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      cr.id, u.id, b64(cr.publicKey), cr.counter, (cr.transports || []).join(','), name, Date.now());
    audit(req, 'passkey.add', name, u.id); markSessionMfa(req);
    return { ok: true };
  });
  app.get('/api/passkeys', async req => all('SELECT id, name, created_at, last_used FROM passkeys WHERE user_id = ? ORDER BY created_at', req.user.id));
  app.delete('/api/passkeys/:id', async req => {
    if (!req.user.totp_on && get('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?', req.user.id).n <= 1) throw httpErr(400, 'This is your only second factor. Add an authenticator app or another passkey first.');
    run('DELETE FROM passkeys WHERE id = ? AND user_id = ?', req.params.id, req.user.id); audit(req, 'passkey.remove', '', req.user.id); return { ok: true }; });

  // ----- sign in (open endpoints) -----
  app.post('/api/auth/passkey/options', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const { rpID } = rp(req), opts = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    const id = randomToken(16); keep('auth:' + id, { challenge: opts.challenge });
    return { ...opts, flow: id };
  });
  app.post('/api/auth/passkey/verify', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const c = take('auth:' + req.body?.flow), cred = req.body?.credential, { rpID, origin } = rp(req);
    if (!c || !cred?.id) throw httpErr(400, 'Expired, try again');
    const pk = get('SELECT * FROM passkeys WHERE id = ?', cred.id);
    if (!pk) { recordFailure(req.ip, 'passkey'); throw httpErr(401, 'Unknown passkey'); }
    let v; try {
      v = await verifyAuthenticationResponse({ response: cred, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID,
        credential: { id: pk.id, publicKey: Buffer.from(pk.public_key, 'base64url'), counter: pk.counter, transports: pk.transports ? pk.transports.split(',') : undefined } });
    } catch { v = null; }
    if (!v?.verified) { recordFailure(req.ip, 'passkey'); audit(req, 'login.fail', 'passkey', pk.user_id); throw httpErr(401, 'Passkey not accepted'); }
    const u = get('SELECT * FROM users WHERE id = ?', pk.user_id);
    if (!u || u.disabled) throw httpErr(403, 'This account is disabled');
    run('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?', v.authenticationInfo.newCounter, Date.now(), pk.id);
    clearFailures(req.ip); newSession(req, reply, u.id, req.headers['user-agent'], true);   // a passkey is two factors (device + Face ID / PIN)
    audit(req, 'login', 'passkey ' + pk.name, u.id, u.id);
    return { ok: true };
  });
}
