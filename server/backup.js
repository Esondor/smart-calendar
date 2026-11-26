// Daily backup of the entire database: a consistent copy (VACUUM INTO) per day into the backup folder,
// the last N days are kept (folder, days and time: Administration → Overview → Backups). Restore: stop the container, copy a backup over data/smart-calendar.db, start again.
import fs from 'node:fs';
import path from 'node:path';
import { db, kvGet, kvSet } from './db.js';
import { config } from './config.js';
import { serverConf } from './serverconf.js';
import { syslog } from './logs.js';

const pad = n => String(n).padStart(2, '0');
// Backup folder, as the admin enters it: a name (subfolder of the app's NAS folder, default "backups" next to data)
// or a full NAS path. NAS paths inside the app folder are mapped to the container; any other path must be mounted
// into the container at the same path (docker-compose.yml).
export function resolveBackupDir(folder = serverConf().backupFolder) {
  const host = config.storeHost;
  if (!path.isAbsolute(folder)) return path.join(config.storeDir, folder);
  if (host && (folder === host || folder.startsWith(host + '/'))) return path.join(config.storeDir, folder.slice(host.length));
  return folder;
}
export const backupDir = () => resolveBackupDir();
// what the admin sees: the folder as the NAS sees it
const shownDir = folder => path.isAbsolute(folder) ? folder : path.join(config.storeHost || config.storeDir, folder);
// can the app write there? (checked before the admin's choice is saved)
export function checkBackupDir(folder) {
  const dir = resolveBackupDir(folder);
  try { fs.mkdirSync(dir, { recursive: true }); const t = path.join(dir, '.write-test'); fs.writeFileSync(t, ''); fs.rmSync(t); return null; }
  catch (e) { return e.code === 'EACCES' || e.code === 'EPERM' ? 'no-permission' : 'not-reachable'; }
}
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function listBackups() {
  try { return fs.readdirSync(backupDir()).filter(f => /^smart-calendar-\d{4}-\d\d-\d\d.*\.db$/.test(f)).sort().reverse()
    .map(f => { const st = fs.statSync(path.join(backupDir(), f)); return { file: f, size: st.size, at: st.mtimeMs }; }); } catch { return []; }
}
export function backupNow(reason = 'daily') {
  const d = new Date(), dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `smart-calendar-${stamp(d)}${reason === 'daily' ? '' : '-' + pad(d.getHours()) + pad(d.getMinutes())}.db`), tmp = file + '.part';
  try { fs.rmSync(tmp, { force: true }); db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); fs.renameSync(tmp, file); }
  catch (e) { fs.rmSync(tmp, { force: true }); kvSet('lastBackup', { at: Date.now(), error: e.message }); syslog('error', 'backup', `Backup failed: ${e.message}`); throw e; }
  // keep the last N days (manual copies included)
  const cutoff = Date.now() - serverConf().backupKeep * 864e5;
  for (const b of listBackups()) if (b.at < cutoff) fs.rmSync(path.join(dir, b.file), { force: true });
  const size = fs.statSync(file).size;
  kvSet('lastBackup', { at: Date.now(), file: path.basename(file), size });
  syslog('info', 'backup', `Backup ${path.basename(file)} (${Math.round(size / 1024)} KB)`);
  return { file: path.basename(file), size };
}
export const backupStatus = () => { const c = serverConf(); return { folder: c.backupFolder, dir: shownDir(c.backupFolder), def: shownDir('backups'), keep: c.backupKeep, hour: c.backupHour, last: kvGet('lastBackup'), files: listBackups().slice(0, 40) }; };
// once a day after BACKUP_HOUR (checked every 10 minutes, also catches up after downtime)
export function startBackups() {
  const tick = () => {
    const last = kvGet('lastBackup'), d = new Date();
    if (d.getHours() < serverConf().backupHour) return;
    if (last?.at && !last.error && stamp(new Date(last.at)) === stamp(d)) return;
    try { backupNow('daily'); } catch {}
  };
  setTimeout(tick, 60000); setInterval(tick, 10 * 60000).unref();
}
