// Invitations: every user can invite someone (one-time link or code, optionally straight into a project);
// the admin can also set a registration password that anyone may use to create an account.
import { get, run } from './db.js';
import { randomInt } from 'node:crypto';
import { sha256, safeEqual } from './crypto.js';
import { httpErr, createUser, newSession } from './auth.js';
import { policy, recordFailure, clearFailures } from './policy.js';
import { audit } from './logs.js';
import { isMember, logActivity } from './models.js';
import { baseUrl } from './serverconf.js';
import { markDirty } from './planner.js';

const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';               // no 0/O, 1/I
const norm = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const newCode = () => { let s = ''; for (let i = 0; i < 8; i++) s += ABC[randomInt(ABC.length)]; return s.slice(0, 4) + '-' + s.slice(4); };
const findInvite = code => { const n = norm(code); return n.length === 8 ? get('SELECT * FROM invites WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?', sha256(n), Date.now()) : null; };

export default async function inviteRoutes(app) {
  app.post('/api/invites', async req => {
    const pid = req.body?.project_id ? +req.body.project_id : null;
    if (pid && !isMember(req.user.id, pid)) throw httpErr(404, 'Project not found');
    const code = newCode();
    run('INSERT INTO invites(code_hash, created_by, project_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(norm(code)), req.user.id, pid, Date.now(), Date.now() + 14 * 864e5);
    audit(req, 'invite.create', pid ? 'project ' + pid : '');
    return { code, url: `${baseUrl()}/#/join/${code}`, expires: Date.now() + 14 * 864e5 };
  });
  // open: what the join screen shows before signing up
  app.get('/api/auth/invite/:code', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async req => {
    const i = findInvite(req.params.code);
    if (!i) return { valid: false, open: !!policy().regPassword };
    return { valid: true, by: get('SELECT name FROM users WHERE id = ?', i.created_by)?.name, project: i.project_id ? get('SELECT name FROM projects WHERE id = ?', i.project_id)?.name : null };
  });
  app.get('/api/auth/register', async () => ({ open: !!policy().regPassword }));
  app.post('/api/auth/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = req.body || {}, code = String(b.code || '').trim();
    const inv = findInvite(code), reg = policy().regPassword;
    if (!inv && !(reg && safeEqual(code, reg))) { recordFailure(req.ip, 'registration'); audit(req, 'register.fail'); throw httpErr(403, 'Invite code or registration password is not valid'); }
    const id = createUser({ username: b.username, name: b.name, password: b.password });
    if (inv) {
      run('UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ?', id, Date.now(), inv.code_hash);
      if (inv.project_id && get('SELECT 1 FROM projects WHERE id = ?', inv.project_id)) {
        run(`INSERT OR IGNORE INTO project_members(project_id, user_id, role) VALUES (?, ?, 'editor')`, inv.project_id, id);
        logActivity(inv.project_id, id, 'Joined'); markDirty([inv.created_by, id]);
      }
    }
    clearFailures(req.ip); newSession(req, reply, id, req.headers['user-agent']);   // second factor is set up next
    audit(req, 'register', inv ? 'invite' : 'registration password', id, id);
    return { ok: true };
  });
}
