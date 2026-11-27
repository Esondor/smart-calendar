// Every notification goes through here: per type, each user picks Off / Push / E-mail / Both (Settings → Notifications).
// E-mail needs the admin's SMTP setup and an address in your account; without them it falls back to push.
import { all, get, run } from './db.js';
import { getPlan, calendarEvents, joinLink } from './planner.js';
import { isoDate, hm, minOfDay, tm, dayStart, addDays } from './time.js';
import { settingsOf } from './models.js';
import { sendPush } from './push.js';
import { sendMail, mailReady } from './mail.js';
import { baseUrl } from './serverconf.js';

export const NOTIFY_TYPES = ['start', 'event', 'deadline', 'morning', 'clash', 'partner', 'ready', 'sync', 'booking'];
export const DEFAULT_CH = { start: 'push', event: 'off', deadline: 'push', morning: 'push', clash: 'both', partner: 'push', ready: 'push', sync: 'push', booking: 'push' };
const CH = ['off', 'push', 'email', 'both'];
export function channelOf(n, type) {
  const c = n?.ch?.[type];
  if (CH.includes(c)) return c;
  // older settings were on/off switches
  if ((type === 'start' && n?.start === false) || (type === 'morning' && n && !n.morning) || (type === 'partner' && n?.partner === false) || (type === 'deadline' && n?.deadline === false)) return 'off';
  return DEFAULT_CH[type] || 'push';
}

// p: { title, body, url, tag, actions, ... } (the push payload; e-mail gets title, body and the link)
export async function notify(uid, type, p) {
  const ch = channelOf(settingsOf(uid).notify, type);
  if (ch === 'off') return { push: 0, mail: false };
  const email = get('SELECT email FROM users WHERE id = ?', uid)?.email;
  const canMail = mailReady() && !!email;
  const push = ch === 'push' || ch === 'both' || !canMail;
  const out = { push: 0, mail: false };
  if (push) out.push = await sendPush(uid, p).catch(() => 0);
  if (canMail && (ch === 'email' || ch === 'both')) out.mail = await sendMail(email, p.title, [p.body, p.mailExtra, p.url ? baseUrl() + p.url : ''].filter(Boolean).join('\n\n')).catch(() => false);
  return out;
}

// ---------- timed notifications, checked every minute ----------

const once = key => { if (get('SELECT 1 FROM notif_sent WHERE key = ?', key)) return false; run('INSERT INTO notif_sent(key, at) VALUES (?, ?)', key, Date.now()); return true; };
// a reminder that may come again (a task the plan keeps moving while you don't start it): at most 3 a day, 30 min apart
export function again(prefix, now = Date.now(), max = 3, gap = 30 * 60000) {
  const sent = all('SELECT at FROM notif_sent WHERE substr(key, 1, ?) = ?', prefix.length, prefix);
  if (sent.length >= max || sent.some(x => now - x.at < gap)) return false;
  run('INSERT INTO notif_sent(key, at) VALUES (?, ?)', prefix + sent.length, now); return true;
}
const reachable = uid => !!get('SELECT 1 FROM push_subs WHERE user_id = ?', uid) || (mailReady() && !!get(`SELECT 1 FROM users WHERE id = ? AND email IS NOT NULL AND email != ''`, uid));
const atTime = (t, now) => Math.abs(minOfDay(now) - tm(t)) <= 1;

export async function notifyTick(now = Date.now()) {
  run('DELETE FROM notif_sent WHERE at < ?', now - 3 * 864e5);
  for (const u of all('SELECT id, settings FROM users WHERE disabled = 0')) {
    if (!reachable(u.id)) continue;
    const s = settingsOf(u), n = s.notify, on = t => channelOf(n, t) !== 'off';
    let plan; try { plan = getPlan(u.id); } catch { continue; }
    const act = get('SELECT task_id FROM active WHERE user_id = ?', u.id);
    // a planned task starts soon
    if (on('start')) {
      const soon = plan.blocks.find(b => b.s > now && b.s - now <= (n.before ?? 5) * 60000);
      if (soon && plan.units[soon.key] && !(act && plan.units[soon.key].t.id === act.task_id)) {
        const t = plan.units[soon.key].t;
        // the plan moves an unstarted task every few minutes: remind again only a few times, not at each new time
        if (again(`start:${u.id}:${t.id}:${isoDate(soon.s)}:`, now)) await notify(u.id, 'start', { title: `${hm(minOfDay(soon.s))} · ${t.title}`, body: `${Math.round((soon.e - soon.s) / 60000)} min · ${t.p_name}`, tag: 'next', url: '/#/now', actions: [{ action: 'start', title: 'Start' }, { action: 'later', title: 'Later' }], key: soon.key });
      }
    }
    // a calendar event starts soon (your blocking events)
    if (on('event')) {
      const lead = (n.eventBefore ?? 10) * 60000;
      const soon = calendarEvents(u.id, now, now + lead + 60000, s), hid = (await import('./conflicts.js')).hiddenEvents(u.id, soon, s);   // hidden: put aside, or the second copy of one appointment
      for (const e of soon.filter(e => e.blocks && e.timed && !hid.has(e.id) && e.start > now && e.start - now <= lead))
        if (once(`event:${u.id}:${e.calendar_id}:${e.ext_id}:${e.start}`)) { const join = joinLink(e);
          await notify(u.id, 'event', { title: `${hm(minOfDay(e.start))} · ${e.title}`, body: [`${hm(minOfDay(e.start))}–${hm(minOfDay(e.end))}`, e.location, e.cal].filter(Boolean).join(' · '), tag: 'event-' + e.id, url: '/#/now',
            ...(join ? { join, actions: [{ action: 'join', title: 'Join' }], mailExtra: 'Join: ' + join } : {}) }); }
    }
    const morning = n.morning || '07:30', today = isoDate(now);
    // deadlines today or tomorrow, and overdue tasks
    if (on('deadline') && atTime(morning, now) && once(`deadline:${u.id}:${today}`)) {
      const due = all(`SELECT t.title, t.deadline FROM tasks t JOIN project_members m ON m.project_id = t.project_id AND m.user_id = ?
        WHERE t.status != 'done' AND t.deadline IS NOT NULL AND t.deadline <= ? AND (t.assignee_id = ? OR t.assignee_id IS NULL) ORDER BY t.deadline LIMIT 20`, u.id, addDays(today, 1), u.id);
      const late = Object.entries(plan.info || {}).filter(([k, i]) => i.late && plan.units[k]?.hardDeadline).length;   // only own deadlines, not a project's target
      if (due.length || late) {
        const label = d => d < today ? 'overdue' : d === today ? 'today' : 'tomorrow';
        await notify(u.id, 'deadline', { title: due.length ? `${due.length} deadline${due.length > 1 ? 's' : ''} ${due.every(d => d.deadline === addDays(today, 1)) ? 'tomorrow' : 'coming up'}` : `${late} late`,
          body: due.slice(0, 5).map(d => `${d.title} (${label(d.deadline)})`).join(', ') + (late ? `${due.length ? ' · ' : ''}${late} won't make it in time` : ''), tag: 'deadline', url: '/#/now',
          mailExtra: due.length > 5 ? due.slice(5).map(d => `${d.title} (${label(d.deadline)})`).join('\n') : '' });
      }
    }
    // the day in one message
    if (on('morning') && atTime(morning, now) && once(`morning:${u.id}:${today}`)) {
      const end = dayStart(addDays(today, 1)), todays = plan.blocks.filter(b => b.s < end && b.e > now);
      const keys = [...new Set(todays.map(b => b.key))], mins = Math.round(todays.reduce((a, b) => a + b.e - b.s, 0) / 60000);
      if (keys.length) await notify(u.id, 'morning', { title: `Today: ${keys.length} task${keys.length > 1 ? 's' : ''}, ${Math.floor(mins / 60)} h ${mins % 60} min`,
        body: keys.slice(0, 4).map(k => plan.units[k]?.t.title).join(', '), tag: 'morning', url: '/#/now',
        mailExtra: todays.map(b => `${hm(minOfDay(b.s))}–${hm(minOfDay(b.e))}  ${plan.units[b.key]?.t.title || ''}`).join('\n') });
    }
  }
}
