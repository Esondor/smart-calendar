// Two-way Vikunja sync: open tasks assigned to you become scheduled tasks here; done/undone syncs both ways.
// Pushed: the server adds a webhook to each Vikunja project it reads (needs the app's public https address), so a change
// there is read at once; without it, polling every minute.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { all, get, run, tx, J } from '../db.js';
import { decrypt, derive } from '../crypto.js';
import { publicUrl } from '../serverconf.js';
import { syslog } from '../logs.js';
import { touchProject } from '../actions.js';

const PRI = { 5: 0, 4: 0, 3: 1, 2: 2, 1: 3, 0: 2 };               // Vikunja → here (0 ASAP … 3 low)
const ZERO = d => !d || d.startsWith('0001-');
const day = d => ZERO(d) ? null : localDate(new Date(d));
const localDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const strip = h => String(h || '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();

// duration from a label like "30m", "2h", "1.5h" or a line "est: 90m" / "⏱ 2h" in the description
export function durationOf(t, def) {
  const cands = [...(t.labels || []).map(l => l.title), ...(strip(t.description).match(/(?:est(?:imate)?|dauer|⏱)\s*[:=]?\s*\d+(?:[.,]\d+)?\s*(?:h|m|min)\b/gi) || [])];
  for (const c of cands) {
    const m = String(c).match(/(\d+(?:[.,]\d+)?)\s*(h|m|min)\b/i);
    if (m) { const v = parseFloat(m[1].replace(',', '.')); return Math.max(5, Math.round(m[2].toLowerCase() === 'h' ? v * 60 : v)); }
  }
  return def;
}

// Vikunja behind Authelia: with your sign-in there, the server signs in like a browser and sends the session cookie along
const sessions = new Map();   // account secret → { cookie, at } / { failed }: kept in memory; a restart signs in again
const signinErr = (url, host, status, why) => Object.assign(new Error(why || `a sign-in page${host && host !== new URL(url).host ? ' (' + host + ')' : ''} answers instead of Vikunja (${status}). Add your sign-in for it, or its admin lets ${new URL(url).host}/api/ through`), { status: 502, signin: host || true });

async function authelia(authUrl, target, login) {
  const o = new URL(authUrl).origin;
  const r = await fetch(o + '/api/firstfactor', { method: 'POST', signal: AbortSignal.timeout(15000), redirect: 'manual',
    headers: { 'content-type': 'application/json', accept: 'application/json', origin: o },
    body: JSON.stringify({ username: login.user, password: login.pass, keepMeLoggedIn: true, targetURL: target, requestMethod: 'GET' }) });
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.status !== 'OK') throw Object.assign(new Error(r.status === 401 ? 'username or password not accepted' : r.status === 403 ? 'too many attempts, try again later' : (j?.message || 'HTTP ' + r.status)), { login: true });
  const cookie = (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).filter(c => /=./.test(c)).join('; ');
  if (!cookie) throw Object.assign(new Error('no session came back'), { login: true });
  // no redirect: the password alone is not enough for this address (it asks for a second factor)
  if (!j.data?.redirect) throw Object.assign(new Error('this address needs a second factor besides the password'), { login: true, second: true });
  return cookie;
}

async function vk(acc, method, path, body, again) {
  const { url, token, login } = decrypt(acc.secret);
  const ses = sessions.get(acc.secret);
  const r = await fetch(url.replace(/\/$/, '') + '/api/v1' + path, { method, signal: AbortSignal.timeout(20000),
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json', ...(ses?.cookie ? { cookie: ses.cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const text = await r.text().catch(() => ''); let j = null; try { j = JSON.parse(text); } catch {}
  // a sign-in page in front of Vikunja (Authelia …) answers instead of Vikunja
  if (j == null || (r.redirected && new URL(r.url).host !== new URL(url).host)) {
    const m = text.match(/href="(https?:\/\/[^"/]+)\/?\?rd=/), authUrl = m?.[1] || (r.redirected ? new URL(r.url).origin : null);
    const host = authUrl ? new URL(authUrl).host : '';
    if (!login?.user || !authUrl || again) throw signinErr(url, host, r.status, again ? 'signed in, but the sign-in page still answers instead of Vikunja' : null);
    // after a failed sign-in, wait 10 minutes: repeated wrong passwords get the account banned there
    if (ses?.failed && Date.now() - ses.failed < 600e3) throw Object.assign(new Error('Sign-in at ' + host + ': ' + ses.why), { status: 502, signin: host });
    try { sessions.set(acc.secret, { cookie: await authelia(authUrl, url.replace(/\/$/, '') + '/api/v1' + path, login), at: Date.now() }); }
    catch (e) { sessions.set(acc.secret, { failed: Date.now(), why: e.message }); throw Object.assign(new Error('Sign-in at ' + host + ': ' + e.message), { status: 502, signin: host }); }
    return vk(acc, method, path, body, true);
  }
  if (!r.ok) { const e = new Error(`Vikunja ${method} ${path}: ${r.status} ${(j && j.message) || ''}`); e.status = r.status; throw e; }
  return j;
}
// who the token belongs to: /user takes only a login session, not an API token (tk_…), so then the owner of most of your projects
export async function vikunjaUser(acc) {
  try { return await vk(acc, 'GET', '/user'); } catch (e) { if (e.status !== 401 && e.status !== 403) throw e; }
  let projs;
  try { projs = await vk(acc, 'GET', '/projects?per_page=500'); }
  catch (e) { if (e.status === 401 || e.status === 403) e.message = `Vikunja ${e.status}: check the token and that it may read projects and tasks and update tasks`; throw e; }
  const n = new Map(); for (const p of projs || []) if (p.owner?.id) { const o = n.get(p.owner.id) || { ...p.owner, c: 0 }; o.c++; n.set(p.owner.id, o); }
  const me = [...n.values()].sort((a, b) => b.c - a.c)[0];
  if (!me) throw Object.assign(new Error('Vikunja: no projects to read with this token'), { status: 400 });
  return { id: me.id, username: me.username };
}

// newer Vikunja lists all your tasks at /tasks (older: /tasks/all; on newer ones "all" is read as a task number → 400)
const listPath = new Map();
async function openTasks(acc) {
  const out = [];
  let base = listPath.get(acc.id) || '/tasks/all', size = 0;
  for (let page = 1; page < 100; page++) {
    const q = `?per_page=200&page=${page}`;
    let j;
    try { j = await vk(acc, 'GET', base + q + '&filter=' + encodeURIComponent('done = false')); }
    catch (e) {
      if (e.status !== 400) throw e;
      if (base === '/tasks/all' && page === 1 && /invalid model/i.test(e.message)) { base = '/tasks'; page--; continue; }
      j = await vk(acc, 'GET', base + q);
    }
    listPath.set(acc.id, base);
    if (!Array.isArray(j) || !j.length) break;
    out.push(...j.filter(t => !t.done));
    // the server may give fewer per page than asked (its own maximum): a shorter page than the first is the last
    if (page === 1) size = j.length; else if (j.length < size) break;
    if (j.length < Math.min(200, size)) break;
  }
  return out;
}

export async function syncVikunja(acc) {
  const st = J(acc.state, {}), cfg = Object.assign({ onlyAssigned: true, projects: [], duration: 60, schedule: 'work', prefix: '' }, st.cfg || {});
  if (!st.me) { const me = await vikunjaUser(acc); st.me = { id: me.id, username: me.username }; }
  const projs = await vk(acc, 'GET', '/projects?per_page=500').catch(() => []);
  const pname = Object.fromEntries((projs || []).map(p => [p.id, p.title]));
  // assigned to me: to your Vikunja user as set in Settings (by name), else to the user the token was found to be
  const meName = String(cfg.user || '').trim().replace(/^@/, '').toLowerCase();
  const mine = t => meName ? (t.assignees || []).some(a => String(a.username || '').toLowerCase() === meName)
    : (t.assignees || []).some(a => a.id === st.me.id) || (!(t.assignees || []).length && t.created_by?.id === st.me.id);
  let tasks = await openTasks(acc);
  // projects switched off (Sync) in Settings: none of their tasks, and the project goes here too
  const skip = new Set((cfg.skip || []).map(Number));
  st.vprojects = (projs || []).filter(p => p.id > 0 && !p.is_archived).map(p => ({ id: p.id, title: p.title })).slice(0, 300);
  for (const p of all(`SELECT id, ext_id FROM projects WHERE ext_source = 'vikunja' AND ext_account = ?`, acc.id)) if (skip.has(+p.ext_id)) run('DELETE FROM projects WHERE id = ?', p.id);
  // tasks in a "Dokumente & Infos" bucket are folders of files (Files panel), not work (list checked at most every 15 min)
  const folders = (await docFiles({ ...acc, state: JSON.stringify({ ...st, cfg }) }, 15 * 60000).catch(() => null))?.ids;
  if (folders?.size) tasks = tasks.filter(t => !folders.has(String(t.id)));
  tasks = tasks.filter(t => !skip.has(+t.project_id) && (!cfg.projects.length || cfg.projects.includes(t.project_id)) &&
    (!cfg.onlyAssigned || mine(t)));
  const uid = acc.user_id, now = Date.now(), seen = new Set(), touched = new Set();
  const projectFor = vpid => {
    let p = get(`SELECT id FROM projects WHERE ext_source = 'vikunja' AND ext_account = ? AND ext_id = ?`, acc.id, String(vpid));
    if (!p) {
      const id = Number(run(`INSERT INTO projects(name, color, kind, owner_id, schedule, ext_source, ext_id, ext_account, created_at, sort) VALUES (?, '#5f3dc4', 'board', ?, ?, 'vikunja', ?, ?, ?, 50)`,
        (cfg.prefix || acc.label) + ' · ' + (pname[vpid] || 'Project ' + vpid), uid, cfg.schedule, String(vpid), acc.id, now).lastInsertRowid);
      run(`INSERT INTO project_members(project_id, user_id, role) VALUES (?, ?, 'owner')`, id, uid);
      return id;
    }
    if (pname[vpid]) { const n = (cfg.prefix || acc.label) + ' · ' + pname[vpid]; if (run('UPDATE projects SET name = ? WHERE id = ? AND name != ?', n, p.id, n).changes) touched.add(p.id); }
    return p.id;
  };
  tx(() => {
    for (const t of tasks) {
      seen.add(String(t.id));
      const pid = projectFor(t.project_id);
      const loc = get(`SELECT id, ext_updated, status FROM tasks WHERE ext_source = 'vikunja' AND ext_account = ? AND ext_id = ?`, acc.id, String(t.id));
      const f = { title: t.title, notes: strip(t.description), deadline: day(t.due_date), start_after: day(t.start_date), priority: PRI[t.priority] ?? 2 };
      if (!loc) {
        run(`INSERT INTO tasks(project_id, title, notes, deadline, start_after, priority, duration, assignee_id, created_by, created_at, updated_at, ext_source, ext_id, ext_account, ext_updated, sort)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'vikunja', ?, ?, ?, ?)`, pid, f.title, f.notes, f.deadline, f.start_after, f.priority, durationOf(t, cfg.duration), uid, uid, now, now, String(t.id), acc.id, t.updated, t.position || t.id);
        touched.add(pid);
      } else if (loc.ext_updated !== t.updated) {
        touched.add(pid);
        run(`UPDATE tasks SET project_id = ?, title = ?, notes = ?, deadline = ?, start_after = ?, priority = ?, duration = ?, ext_updated = ?, updated_at = ?,
          status = CASE WHEN status = 'done' THEN 'todo' ELSE status END, done_at = CASE WHEN status = 'done' THEN NULL ELSE done_at END WHERE id = ?`,
          pid, f.title, f.notes, f.deadline, f.start_after, f.priority, durationOf(t, cfg.duration), t.updated, now, loc.id);
      }
    }
  });
  // done here but still open there (an earlier write-back failed): retry
  for (const l of all(`SELECT * FROM tasks WHERE ext_source = 'vikunja' AND ext_account = ? AND status = 'done'`, acc.id)) {
    if (seen.has(l.ext_id)) await pushDone(l, true).catch(e => console.warn('vikunja write-back', e.message));
  }
  // tasks that left the open list: done in Vikunja → done here; deleted/unassigned → removed here
  for (const l of all(`SELECT id, ext_id, project_id, status FROM tasks WHERE ext_source = 'vikunja' AND ext_account = ? AND status != 'done'`, acc.id)) {
    if (seen.has(l.ext_id)) continue;
    let rt = null; try { rt = await vk(acc, 'GET', '/tasks/' + l.ext_id); } catch (e) { if (e.status !== 404 && e.status !== 403) continue; }
    if (rt && rt.done) run(`UPDATE tasks SET status = 'done', done_at = ?, ext_updated = ? WHERE id = ?`, Date.parse(rt.done_at) || now, rt.updated, l.id);
    else run('DELETE FROM tasks WHERE id = ?', l.id);
    touched.add(l.project_id);
  }
  // webhooks on the projects read (new projects get one too; checked again every 6 h)
  const url = publicUrl(`/api/vikunja/push/${acc.id}`), ids = (cfg.projects.length ? cfg.projects : (projs || []).map(p => p.id)).map(Number).filter(i => !skip.has(i)).sort((a, b) => a - b);
  if (!url) delete st.hooks;
  else if (!st.hooks || st.hooks.url !== url || now - st.hooks.at > 6 * 3600e3 || ids.some(i => !st.hooks.ids.includes(i))) {
    try { await addHooks(acc, ids, url); st.hooks = { url, ids, at: now, ok: true }; }
    catch (e) { if (st.hooks?.ok !== false) syslog('warn', 'vikunja', `live updates not available, checking every minute: ${e.message}`, uid); st.hooks = { url, ids, at: now, ok: false, err: e.message }; }
  }
  run('UPDATE accounts SET state = ? WHERE id = ?', JSON.stringify({ ...st, cfg, count: tasks.length }), acc.id);
  touched.forEach(pid => touchProject(pid));
  return { count: tasks.length };
}

const HOOK_EVENTS = ['task.created', 'task.updated', 'task.deleted', 'task.assignee.created', 'task.assignee.deleted', 'project.updated'];
const hookSecret = acc => derive('vikunja-hook:' + acc.id);
async function addHooks(acc, ids, url) {
  for (const id of ids) {
    const have = await vk(acc, 'GET', `/projects/${id}/webhooks`);
    if ((have || []).some(w => w.target_url === url)) continue;
    await vk(acc, 'PUT', `/projects/${id}/webhooks`, { target_url: url, events: HOOK_EVENTS, secret: hookSecret(acc) });
  }
}
// a webhook call: signed with the account's secret (X-Vikunja-Signature = HMAC-SHA256 of the body, hex; base64 accepted)
export function hookValid(acc, raw, sig) {
  const mac = createHmac('sha256', hookSecret(acc)).update(raw).digest(), got = String(sig || '').trim().replace(/^sha256=/, '');
  return [mac.toString('hex'), mac.toString('base64')].some(x => x.length === got.length && timingSafeEqual(Buffer.from(x), Buffer.from(got)));
}

// write-back: done/undone from here → Vikunja (POST replaces the whole task, so read it first)
export async function pushDone(task, done) {
  if (task.ext_source !== 'vikunja') return;
  const acc = get('SELECT * FROM accounts WHERE id = ?', task.ext_account); if (!acc) return;
  const rt = await vk(acc, 'GET', '/tasks/' + task.ext_id);
  if (!!rt.done === !!done) return;
  const res = await vk(acc, 'POST', '/tasks/' + task.ext_id, { ...rt, done: !!done });
  run('UPDATE tasks SET ext_updated = ? WHERE id = ?', res.updated, task.id);
}

// ---------- Kanban: Start puts the task into "In Progress", Done into "Done" (by the buckets' names) ----------
const BUCKET = { progress: /^(in\s*progress|doing|in\s*arbeit|in\s*bearbeitung|l(ä|ae)uft|wip|started)\b/i, done: /^(done|erledigt|fertig|abgeschlossen|finished|completed)\b/i };
export async function moveToBucket(task, kind) {
  if (task?.ext_source !== 'vikunja') return false;
  const acc = get('SELECT * FROM accounts WHERE id = ?', task.ext_account); if (!acc) return false;
  const vt = await vk(acc, 'GET', '/tasks/' + task.ext_id), pid = vt.project_id;
  // newer Vikunja: buckets belong to a project's Kanban view
  let views = null; try { views = await vk(acc, 'GET', `/projects/${pid}/views`); } catch (e) { if (e.status !== 404) throw e; }
  if (Array.isArray(views)) {
    let moved = false;
    for (const v of views.filter(v => v.view_kind === 'kanban' || v.view_kind === 3)) {
      const buckets = await vk(acc, 'GET', `/projects/${pid}/views/${v.id}/buckets`).catch(() => []);
      const b = (kind === 'done' && v.done_bucket_id && buckets.find(x => x.id === v.done_bucket_id)) || buckets.find(x => BUCKET[kind].test(String(x.title || '').trim()));
      if (!b) continue;
      if ((b.tasks || []).some(x => x.id === vt.id)) { moved = true; continue; }
      await vk(acc, 'POST', `/projects/${pid}/views/${v.id}/buckets/${b.id}/tasks`, { task_id: vt.id, bucket_id: b.id, project_view_id: v.id });
      moved = true;
    }
    return moved;
  }
  // older Vikunja: one Kanban per project, the bucket is a field of the task
  const buckets = await vk(acc, 'GET', `/projects/${pid}/buckets`).catch(() => []);
  const b = (Array.isArray(buckets) ? buckets : []).find(x => BUCKET[kind].test(String(x.title || '').trim()));
  if (!b || vt.bucket_id === b.id) return !!b;
  const res = await vk(acc, 'POST', '/tasks/' + vt.id, { ...vt, bucket_id: b.id });
  if (res?.updated) run('UPDATE tasks SET ext_updated = ? WHERE id = ?', res.updated, task.id);
  return true;
}

// ---------- files: the "Dokumente & Infos" bucket holds tasks that are folders; their attachments are the files ----------
export const DOCS = /^(dokumente|documents?|docs?|files?|dateien|ablage|unterlagen|infos?)\b|dokumente\s*&\s*infos/i;
const files = new Map();   // account → { at, list, ids }: kept 5 min (the list), the folder ids keep tasks out of the plan
// a project's Kanban buckets with their tasks (newer Vikunja: from its Kanban view; older: the project's buckets)
async function bucketsOf(acc, pid) {
  let views = null; try { views = await vk(acc, 'GET', `/projects/${pid}/views`); } catch (e) { if (e.status !== 404) throw e; }
  if (Array.isArray(views)) {
    const out = [];
    for (const v of views.filter(v => v.view_kind === 'kanban' || v.view_kind === 3)) {
      const r = await vk(acc, 'GET', `/projects/${pid}/views/${v.id}/tasks?per_page=200`).catch(() => []);
      if (Array.isArray(r)) out.push(...r.filter(b => b && Array.isArray(b.tasks)));
    }
    return out;
  }
  const r = await vk(acc, 'GET', `/projects/${pid}/buckets`).catch(() => []);
  return Array.isArray(r) ? r : [];
}
export async function docFiles(acc, maxAge = 5 * 60000, only = null) {
  const ck = acc.id + ':' + (only || '*'), hit = files.get(ck); if (hit && Date.now() - hit.at < maxAge) return hit;
  const st = J(acc.state, {}), cfg = st.cfg || {}, skip = new Set((cfg.skip || []).map(Number));
  const projs = (st.vprojects || []).filter(p => !skip.has(p.id) && (!only || p.id === +only)).slice(0, 60), list = [], ids = new Set();
  for (const p of projs) {
    const folders = [];
    for (const b of (await bucketsOf(acc, p.id).catch(() => [])).filter(b => DOCS.test(String(b.title || '').trim()))) {
      for (const t of b.tasks) {
        ids.add(String(t.id));
        const att = Array.isArray(t.attachments) ? t.attachments : await vk(acc, 'GET', `/tasks/${t.id}/attachments`).catch(() => []);
        folders.push({ id: t.id, title: t.title, files: (att || []).map(a => ({ id: a.id, name: a.file?.name || 'File', mime: a.file?.mime || '', size: a.file?.size || 0, at: Date.parse(a.created || a.file?.created) || null })) });
      }
    }
    if (folders.length) list.push({ id: p.id, title: p.title, folders });
  }
  const v = { at: Date.now(), list, ids }; files.set(ck, v); return v;
}
export const forgetFiles = id => { for (const k of files.keys()) if (k.startsWith(id + ':')) files.delete(k); };
// one attachment, straight from Vikunja (with the sign-in page's session when there is one)
export async function attachment(acc, taskId, attId) {
  const { url, token } = decrypt(acc.secret);
  await vk(acc, 'GET', '/tasks/' + taskId);   // the task is there and readable; signs in on the sign-in page if needed
  const ses = sessions.get(acc.secret);
  const r = await fetch(`${url.replace(/\/$/, '')}/api/v1/tasks/${taskId}/attachments/${attId}`, { signal: AbortSignal.timeout(60000),
    headers: { authorization: 'Bearer ' + token, ...(ses?.cookie ? { cookie: ses.cookie } : {}) } });
  if (!r.ok) throw Object.assign(new Error('Vikunja: file not found'), { status: r.status === 404 ? 404 : 502 });
  return r;
}

// ---------- upload: a file into a folder, or a new folder (a task in the files bucket) named by the user ----------
async function docsBucket(acc, pid) {
  let views = null; try { views = await vk(acc, 'GET', `/projects/${pid}/views`); } catch (e) { if (e.status !== 404) throw e; }
  if (Array.isArray(views)) {
    for (const v of views.filter(v => v.view_kind === 'kanban' || v.view_kind === 3)) {
      const bs = await vk(acc, 'GET', `/projects/${pid}/views/${v.id}/buckets`).catch(() => []);
      const b = (Array.isArray(bs) ? bs : []).find(x => DOCS.test(String(x.title || '').trim()));
      if (b) return { view: v.id, bucket: b.id };
    }
    return null;
  }
  const bs = await vk(acc, 'GET', `/projects/${pid}/buckets`).catch(() => []);
  const b = (Array.isArray(bs) ? bs : []).find(x => DOCS.test(String(x.title || '').trim()));
  return b ? { bucket: b.id } : null;
}
export async function uploadFile(acc, vpid, { folder, name, fileName, mime, data }) {
  let tid = folder;
  if (!tid) {
    const where = await docsBucket(acc, vpid);
    if (!where) throw Object.assign(new Error('This project has no files bucket (e.g. "Dokumente & Infos") in its Kanban'), { status: 400 });
    const t = await vk(acc, 'PUT', `/projects/${vpid}/tasks`, { title: name, ...(where.view ? {} : { bucket_id: where.bucket }) });
    if (where.view) await vk(acc, 'POST', `/projects/${vpid}/views/${where.view}/buckets/${where.bucket}/tasks`, { task_id: t.id, bucket_id: where.bucket, project_view_id: where.view });
    tid = t.id;
  }
  const { url, token } = decrypt(acc.secret);
  if (folder) await vk(acc, 'GET', '/tasks/' + tid);   // the folder is there; signs in on the sign-in page if needed
  const ses = sessions.get(acc.secret), fd = new FormData();
  fd.append('files', new Blob([data], { type: mime || 'application/octet-stream' }), fileName);
  const r = await fetch(`${url.replace(/\/$/, '')}/api/v1/tasks/${tid}/attachments`, { method: 'PUT', body: fd, signal: AbortSignal.timeout(120000),
    headers: { authorization: 'Bearer ' + token, ...(ses?.cookie ? { cookie: ses.cookie } : {}) } });
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.errors?.length) throw Object.assign(new Error('Vikunja: ' + (j?.errors?.[0]?.message || j?.message || 'upload failed (' + r.status + ')')), { status: 502 });
  forgetFiles(acc.id);
  return { folder: tid };
}
