// Audit log (who did what, from where) and system log (sync errors, push failures, server errors).
import { all, run } from './db.js';

export function audit(req, kind, detail = '', target = null, actor) {
  try { run('INSERT INTO audit(at, actor_id, target_id, ip, kind, detail) VALUES (?, ?, ?, ?, ?, ?)', Date.now(), actor ?? req?.user?.id ?? null, target, req?.ip ?? null, kind, String(detail).slice(0, 500)); }
  catch (e) { console.error('audit failed', e.message); }
}
export function syslog(level, src, msg, uid = null) {
  const m = String(msg?.message || msg).slice(0, 1000);
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[${src}] ${m}`);
  try { run('INSERT INTO logs(at, level, src, msg, user_id) VALUES (?, ?, ?, ?, ?)', Date.now(), level, src, m, uid); } catch {}
}
// keep 90 days of audit, 30 days / 20 000 rows of system log
export function pruneLogs() {
  run('DELETE FROM audit WHERE at < ?', Date.now() - 90 * 864e5);
  run('DELETE FROM logs WHERE at < ? OR id <= (SELECT MAX(id) - 20000 FROM logs)', Date.now() - 30 * 864e5);
}
setInterval(pruneLogs, 6 * 3600e3).unref();
