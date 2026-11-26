import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const DATA_DIR = path.resolve(env.DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// APP_SECRET encrypts integration credentials (Google refresh tokens, ICS links, Vikunja tokens).
// If not given, one is generated once and kept in the data volume.
function loadSecret() {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return env.APP_SECRET;
  const f = path.join(DATA_DIR, 'app-secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

export const config = {
  port: +(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',
  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, 'smart-calendar.db'),
  secret: loadSecret(),
  trustProxy: env.TRUST_PROXY ? (env.TRUST_PROXY === 'true' ? true : env.TRUST_PROXY) : 'loopback,linklocal,uniquelocal',
  sessionDays: +(env.SESSION_DAYS || 30),
  // the app's folder on the NAS (data lives in it); backup folder, days and time are set in Administration
  storeDir: path.resolve(env.STORE_DIR || path.dirname(DATA_DIR)),
  storeHost: (env.STORE_HOST || '').replace(/\/$/, ''),   // the same folder as the NAS sees it, only for display
  sync: {
    nearSec: +(env.SYNC_NEAR_SEC || 60),         // current week: every minute
    farSec: +(env.SYNC_FAR_SEC || 900),          // next 2 months: every 15 min
    farDays: +(env.SYNC_FAR_DAYS || 62),
    icsSec: +(env.SYNC_ICS_SEC || 120),
    vikunjaSec: +(env.SYNC_VIKUNJA_SEC || 60),
  },
};
