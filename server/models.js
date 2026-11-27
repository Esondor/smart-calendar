import { all, get, run, J } from './db.js';

export const DEFAULT_SETTINGS = {
  hours: {
    work: { 0: null, 1: ['09:00', '18:00'], 2: ['09:00', '18:00'], 3: ['09:00', '18:00'], 4: ['09:00', '18:00'], 5: ['09:00', '18:00'], 6: null },
    personal: { 0: [['10:00', '19:00']], 1: [['18:30', '21:30']], 2: [['18:30', '21:30']], 3: [['18:30', '21:30']], 4: [['18:30', '21:30']], 5: [['17:00', '21:00']], 6: [['10:00', '19:00']] },
  },
  chunk: 30,
  dFree: 60,
  horizonDays: 62,
  fixed: [{ id: 'lunch', t: 'Lunch', days: [0, 1, 2, 3, 4, 5, 6], s: '12:00', e: '12:45' }],
  plan: { calendarId: null, days: 14, logOn: true, logCalendarId: null },
  notify: { before: 5, start: true, morning: '07:30', partner: true, deadline: true },
};

export function settingsOf(u) {
  const s = J(typeof u === 'object' ? u.settings : get('SELECT settings FROM users WHERE id = ?', u)?.settings, {});
  const d = structuredClone(DEFAULT_SETTINGS);
  const out = Object.assign(d, s);
  out.hours = Object.assign(structuredClone(DEFAULT_SETTINGS.hours), s.hours || {});
  out.plan = Object.assign(structuredClone(DEFAULT_SETTINGS.plan), s.plan || {});
  out.notify = Object.assign(structuredClone(DEFAULT_SETTINGS.notify), s.notify || {});
  return out;
}
export const saveSettings = (uid, s) => run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(s), uid);

export const publicUser = u => u && ({ id: u.id, username: u.username, name: u.name, color: u.color, is_admin: !!u.is_admin, totp_on: !!u.totp_on, email: u.email || '' });   // only ever sent to the user themself
export const allUsers = () => all('SELECT id, username, name, color, is_admin FROM users ORDER BY id');
// the people a user may see and pick: themselves, whoever shares a project with them, whoever they invited or was invited by
export const contactsOf = uid => all(`SELECT id, username, name, color, is_admin FROM users WHERE id = ?
  OR id IN (SELECT y.user_id FROM project_members x JOIN project_members y ON x.project_id = y.project_id WHERE x.user_id = ?)
  OR id IN (SELECT used_by FROM invites WHERE created_by = ? AND used_by IS NOT NULL)
  OR id IN (SELECT created_by FROM invites WHERE used_by = ?) ORDER BY id`, uid, uid, uid, uid);

export const projectIdsFor = uid => all('SELECT project_id FROM project_members WHERE user_id = ?', uid).map(r => r.project_id);
export const isMember = (uid, pid) => !!get('SELECT 1 FROM project_members WHERE user_id = ? AND project_id = ?', uid, pid);
export const membersOf = pid => all('SELECT u.id, u.name, u.color, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.id', pid);

// places of a project (chores are grouped by them and must have one); the household project has Keller, Garage, Wohnung unless set otherwise
export const DEFAULT_PLACES = ['Keller', 'Garage', 'Wohnung'];
export function projectPlaces(p) {
  const m = typeof p.meta === 'string' ? J(p.meta, {}) : (p.meta || {});
  if (Array.isArray(m.places)) return m.places.length ? m.places : null;
  return /haus|household|home|wohnung/i.test(p.name || '') ? DEFAULT_PLACES : null;
}
export function projectRow(p) {
  return { ...p, columns: J(p.columns, []), meta: J(p.meta, {}), archived: !!p.archived, members: membersOf(p.id), places: projectPlaces(p) };
}
export function taskRow(t) {
  return { ...t, recur: J(t.recur, null), points: J(t.points, []), meta: J(t.meta, {}), auto: !!t.auto };
}
export const taskById = id => { const t = get('SELECT * FROM tasks WHERE id = ?', id); return t ? taskRow(t) : null; };
export function canEditTask(uid, tid) {
  const t = get('SELECT project_id FROM tasks WHERE id = ?', tid);
  return t && isMember(uid, t.project_id) ? t.project_id : null;
}
export function logActivity(pid, uid, text) {
  run('INSERT INTO activity(project_id, user_id, at, text) VALUES (?, ?, ?, ?)', pid, uid, Date.now(), text);
}
