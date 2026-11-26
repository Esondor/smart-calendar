import crypto from 'node:crypto';
import { config } from './config.js';

const KEY = crypto.createHash('sha256').update('smart-calendar:enc:' + config.secret).digest();

// AES-256-GCM for credentials at rest
export function encrypt(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
export function decrypt(s) {
  const [v, iv, tag, data] = String(s).split('.');
  if (v !== 'v1') throw new Error('bad ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8'));
}

// scrypt password hashing (N=2^15, r=8, p=1, 64-byte key)
const SC = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw).normalize('NFKC'), salt, 64, SC);
  return `scrypt$${SC.N}$${SC.r}$${SC.p}$${salt.toString('base64url')}$${h.toString('base64url')}`;
}
export function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, h] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(h, 'base64url');
    const got = crypto.scryptSync(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64url'), want.length, { N: +N, r: +r, p: +p, maxmem: SC.maxmem });
    return crypto.timingSafeEqual(want, got);
  } catch { return false; }
}
// constant-time dummy check so unknown usernames take as long as wrong passwords
const DUMMY = hashPassword(crypto.randomBytes(8).toString('hex'));
export const dummyVerify = () => verifyPassword('x', DUMMY);

// a stable secret for one purpose, derived from the server's key (nothing to store)
export const derive = label => crypto.createHmac('sha256', KEY).update(label).digest('hex');
export const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');
export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
export const safeEqual = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) { let bits = 0, v = 0, out = ''; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(v << (5 - bits)) & 31]; return out; }
function unbase32(s) { let bits = 0, v = 0; const out = []; for (const c of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function hotp(key, counter) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(b).digest(), o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
export const newTotpSecret = () => base32(crypto.randomBytes(20));
export function verifyTotp(secret, code, lastStep) {
  const key = unbase32(secret), step = Math.floor(Date.now() / 30000), c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  for (const d of [0, -1, 1]) { const s = step + d; if (s > (lastStep || 0) && safeEqual(hotp(key, s), c)) return s; }
  return null;
}
