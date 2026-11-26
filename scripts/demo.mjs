// Builds the demo website: the real web app with invented data, no server needed (GitHub Pages or any static host).
//   node scripts/demo.mjs [out]      → demo-site/ (default)
// The server runs here once, in memory, on invented people, calendars and projects; every page's data is
// recorded into data.json. In the browser demo.js answers the app's requests from it, moved to today's date,
// and keeps what visitors change until they reload.
process.env.TZ = 'UTC';   // the wall-clock times are recorded as UTC and shown as the visitor's local times
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
process.env.DATA_DIR = process.env.DEMO_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'sc-demo-'));   // DEMO_DATA_DIR keeps the database (screenshots of the Mac app)
process.env.LOG_LEVEL = 'silent';
// the demo's moment: 14:20 (UTC wall-clock) today. The morning is done and tracked, the afternoon planned, the
// red now line in the middle; the visitor's clock is set to the same moment (demo.js)
{ const R = Date, real0 = R.now(), d = new R(real0); d.setUTCHours(14, 20, 0, 0); const fake0 = +d;
  globalThis.Date = class extends R { constructor(...a) { a.length ? super(...a) : super(fake0 + R.now() - real0); } static now() { return fake0 + R.now() - real0; } }; }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'demo-site'));
const Fastify = (await import('fastify')).default;
const { run, get, all } = await import('../server/db.js');
const { encrypt } = await import('../server/crypto.js');
const { createUser } = await import('../server/auth.js');
const { saveSettings, settingsOf } = await import('../server/models.js');
const { default: apiRoutes } = await import('../server/api.js');

// ---------- people, calendars, appointments ----------
const day0 = (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return +d; })();
const at = (dayOff, h, m = 0) => day0 + dayOff * 864e5 + (h * 60 + m) * 60000;
const wd = off => new Date(day0 + off * 864e5).getUTCDay();

const me = createUser({ username: 'alex', name: 'Alex Morgan', password: 'demo password 123' });
const sam = createUser({ username: 'sam', name: 'Sam Lee', password: 'demo password 123' });
run('UPDATE users SET is_admin = 0');
const s = settingsOf(me);
s.fixed = [
  { id: 'breakfast', t: 'Breakfast', days: [0, 1, 2, 3, 4, 5, 6], s: '07:30', e: '08:00', flex: true },
  { id: 'lunch', t: 'Lunch', days: [0, 1, 2, 3, 4, 5, 6], s: '12:30', e: '13:15', flex: true },
  { id: 'dinner', t: 'Dinner', days: [0, 1, 2, 3, 4, 5, 6], s: '19:00', e: '19:45', flex: 'asap' },
];
s.plan = { ...s.plan, tag: 'AM', eventBuffer: 10 };
s.onboarded = true;
saveSettings(me, s);

const acc = Number(run(`INSERT INTO accounts(user_id, kind, label, secret, status, last_sync) VALUES (?, 'google', 'alex@example.com', ?, 'ok', ?)`, me, encrypt({ refresh_token: 'demo' }), Date.now()).lastInsertRowid);
const cal = (ext, name, color, busy, writable) => Number(run(`INSERT INTO calendars(account_id, user_id, ext_id, name, color, use_busy, writable) VALUES (?, ?, ?, ?, ?, ?, ?)`, acc, me, ext, name, color, busy, writable).lastInsertRowid);
const work = cal('work@demo', 'Work', '#4285f4', 1, 1), home = cal('home@demo', 'Personal', '#33b679', 1, 1), fam = cal('family@demo', 'Family', '#f4511e', 1, 0), hol = cal('holidays@demo', 'Holidays', '#8e24aa', 0, 0);
let n = 0;
const ev = (c, s0, e0, title, x = {}) => run(`INSERT INTO events(calendar_id, ext_id, start, end, title, location, link, descr, all_day, free, series) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  c, 'd' + ++n, s0, e0, title, x.loc || null, x.link || null, x.descr || '', x.allDay ? 1 : 0, x.free ? 1 : 0, x.series || null);
for (let d = -21; d <= 35; d++) {
  const w = wd(d);
  if (w >= 1 && w <= 5) ev(work, at(d, 9, 15), at(d, 9, 30), 'Team standup', { link: 'https://meet.google.com/abc-defg-hij', series: 'standup' });
  if (w === 1) ev(work, at(d, 14), at(d, 15), 'Design review', { loc: 'Office, Room 2.14', series: 'review' });
  if (w === 3) ev(work, at(d, 10), at(d, 10, 45), '1:1 with Jordan', { link: 'https://meet.google.com/xyz-abcd-efg', series: 'oneone' });
  if (w === 4) ev(work, at(d, 16), at(d, 17), 'Client call', { link: 'https://teams.microsoft.com/l/meetup-join/demo', series: 'client' });
  if (w === 2 || w === 4) ev(home, at(d, 18, 30), at(d, 20), 'Climbing', { loc: 'Boulder gym', series: 'climb' });
  if (w === 6) ev(fam, at(d, 10), at(d, 11, 30), 'Farmers market', { free: true, series: 'market' });
  if (w === 0) ev(fam, at(d, 17), at(d, 19), 'Dinner at Mum\'s', { series: 'mum' });
}
// one-off appointments on fitting weekdays: next(2) = the coming Tuesday (or today, if it is one), +7 for the week after
const next = (w, plus = 0) => ((w - wd(0) + 7) % 7) + plus;
ev(home, at(next(5), 8, 30), at(next(5), 9), 'Dentist', { loc: 'Dr. Miller, Hauptstr. 5' });
ev(work, at(next(2), 11), at(next(2), 12), 'Workshop: onboarding flow', { loc: 'Office, Room 1.02' });
ev(work, at(next(4), 13, 30), at(next(4), 15), 'Sprint planning', { link: 'https://meet.google.com/plan-demo' });
ev(fam, at(next(6), 15), at(next(6), 16), 'Kids\' football match', { loc: 'Sports ground' });
ev(work, at(next(4, 7), 0), at(next(4, 7) + 2, 0), 'Product conference', { allDay: true, loc: 'Congress Center' });
ev(hol, at(next(1, 14), 0), at(next(1, 14) + 1, 0), 'Public holiday', { allDay: true, free: true });
ev(work, at(next(2, -7), 15), at(next(2, -7), 16, 30), 'Quarterly review');
// a shared team calendar: only entries with your initials (or "Team") are yours. Where one overlaps an appointment of
// your own, Smart Calendar decides which one wins (work in working hours, otherwise yours) and you can overrule it
const team = cal('team@demo', 'Team', '#e67c73', 1, 1);
run(`UPDATE calendars SET include_words = 'AM, Team', exclude_words = 'JD, Robin, Sam' WHERE id = ?`, team);
// the noise of a shared calendar: other people's entries, filtered out (the eye in the calendar shows them small)
for (let d = -14; d <= 28; d++) { const w = wd(d); if (w === 0 || w === 6) continue;
  if (w === 1) ev(team, at(d, 11), at(d, 12), 'JD – Customer visit');
  if (w === 2) ev(team, at(d, 13), at(d, 17), 'Robin – Home office');
  if (w === 4) ev(team, at(d, 9), at(d, 10, 30), 'Sam – Recruiting');
  if (w === 5) ev(team, at(d, 14), at(d, 15), 'JD, Robin – Budget'); }
ev(team, at(next(5), 16), at(next(5), 17), 'AM, JD – Release retro');
ev(home, at(next(5), 16), at(next(5), 16, 45), 'Physio', { loc: 'Physio Lindner' });
ev(team, at(next(2, 7), 19), at(next(2, 7), 21), 'Team dinner', { loc: 'Trattoria Roma' });
ev(team, at(next(3), 15), at(next(3), 15, 30), 'AM – Interview debrief');

// ---------- projects and tasks, through the real API ----------
const app = Fastify({ logger: false });
await app.register((await import('@fastify/cookie')).default);
let asUser = me;
app.addHook('onRequest', async req => { req.user = get('SELECT * FROM users WHERE id = ?', asUser); });
await app.register(apiRoutes); await app.ready();
const call = async (method, url, payload) => { const r = await app.inject({ method, url, payload, headers: { 'x-sc': '1' } }); if (r.statusCode >= 400) throw new Error(`${method} ${url}: ${r.body}`); return r.json(); };
const iso = off => new Date(day0 + off * 864e5).toISOString().slice(0, 10);
const proj = (b) => call('POST', '/api/projects', b);
const task = (pid, b) => call('POST', '/api/tasks', { project_id: pid, ...b });

const web = await proj({ name: 'Website Relaunch', color: '#1971c2', schedule: 'work', target_date: iso(18) });
const hh = await proj({ name: 'Household', color: '#2f9e44', schedule: 'personal' });
await call('PATCH', `/api/projects/${hh.id}`, { meta: { ...hh.meta, places: ['Basement', 'Garage', 'Flat'] } });
const book = await proj({ name: 'Field Guide', color: '#e8590c', kind: 'outline', schedule: 'work' });
const errands = await proj({ name: 'Errands', color: '#ae3ec9', schedule: 'personal' });
await call('POST', `/api/projects/${hh.id}/members`, { username: 'sam' }).catch(() => run(`INSERT INTO project_members(project_id, user_id, role) VALUES (?, ?, 'member')`, hh.id, sam));

const W = {};
W.audit = await task(web.id, { title: 'Content audit of the old site', duration: 120, priority: 1, points: [{ t: 'List all pages' }, { t: 'Mark outdated content' }, { t: 'Collect analytics' }] });
W.wire = await task(web.id, { title: 'Wireframes for the new navigation', duration: 180, priority: 1, deadline: iso(6), min_chunk: 60 });
W.copy = await task(web.id, { title: 'Write the About page', duration: 90, priority: 2, deadline: iso(10) });
W.img = await task(web.id, { title: 'Pick hero images', duration: 45, priority: 3 });
W.seo = await task(web.id, { title: 'Redirects and SEO check', duration: 60, priority: 2, start_after: iso(7) });
W.qa = await task(web.id, { title: 'Accessibility pass', duration: 120, priority: 2, deadline: iso(15), points: [{ t: 'Contrast' }, { t: 'Keyboard navigation' }, { t: 'Screen reader labels' }] });
W.launch = await task(web.id, { title: 'Launch checklist', duration: 60, priority: 0, deadline: iso(18) });
W.call = await task(web.id, { title: 'Call the hosting provider', duration: 15, priority: 0 });

const anchor = iso(-7);
await task(hh.id, { title: 'Laundry', duration: 30, location: 'Basement', recur: { freq: 'week', every: 1, days: [3, 6], anchor }, assign_mode: 'rotate' });
await task(hh.id, { title: 'Water the plants', duration: 10, location: 'Flat', recur: { freq: 'day', every: 3, anchor } });
await task(hh.id, { title: 'Vacuum the flat', duration: 40, location: 'Flat', recur: { freq: 'week', every: 1, days: [6], anchor }, assign_mode: 'rotate' });
await task(hh.id, { title: 'Take the bins out', duration: 10, location: 'Garage', recur: { freq: 'week', every: 1, days: [2], anchor, window: 'evening' } });
await task(hh.id, { title: 'Clean out the garage shelf', duration: 90, location: 'Garage', priority: 3 });

await task(errands.id, { title: 'Pick up the parcel', duration: 20, priority: 1, location: 'Post office' });
await task(errands.id, { title: 'Renew passport', duration: 45, priority: 2, deadline: iso(20) });
await task(errands.id, { title: 'Buy a birthday present for Robin', duration: 30, priority: 1, deadline: iso(8) });
await task(errands.id, { title: 'Sort old photos', duration: 60, auto: false });

// a team that works in Vikunja: its projects come in through the Vikunja API, with the tasks assigned to you
const vk = Number(run(`INSERT INTO accounts(user_id, kind, label, secret, state, status, last_sync) VALUES (?, 'vikunja', 'Team', ?, ?, 'ok', ?)`, me, encrypt({ url: 'https://tasks.example.com', token: 'demo' }),
  JSON.stringify({ me: { id: 7, username: 'alex' }, cfg: { onlyAssigned: true, user: 'alex', projects: [], skip: [], noPlan: [], duration: 60, schedule: 'work', prefix: 'Team' },
    vprojects: [{ id: 11, title: 'Product Roadmap' }, { id: 12, title: 'Customer Support' }, { id: 13, title: 'Marketing' }], count: 3 }), Date.now()).lastInsertRowid);
const road = await proj({ name: 'Team · Product Roadmap', color: '#5f3dc4', schedule: 'work' });
run(`UPDATE projects SET ext_source = 'vikunja', ext_id = '11', ext_account = ? WHERE id = ?`, vk, road.id);
for (const [i, b] of [{ title: 'Export to CSV', duration: 120, priority: 1, deadline: iso(9) }, { title: 'Fix login on Safari', duration: 60, priority: 0 }, { title: 'Release notes 2.4', duration: 45, priority: 2, deadline: iso(12) }].entries()) {
  const t = await task(road.id, b); run(`UPDATE tasks SET ext_source = 'vikunja', ext_id = ?, ext_account = ? WHERE id = ?`, String(100 + i), vk, t.id);
}

// an outline project: chapters → sections → items with points
const chapters = [
  ['Getting started', [['Why a field guide', ['Motivation', 'Who it is for']], ['How to use this book', ['Symbols', 'Reading paths']]]],
  ['Birds', [['Garden birds', ['Sparrows and finches', 'Tits']], ['Water birds', ['Ducks', 'Herons']]]],
  ['Trees', [['Broadleaf', ['Oak', 'Beech', 'Lime']], ['Conifers', ['Pine', 'Spruce']]]],
];
const outline = [];
for (const [ci, [ct, secs]] of chapters.entries()) {
  const ch = await task(book.id, { title: ct, auto: false, duration: 30, sort: ci, grp: ci, meta: { level: 'chapter', num: String(ci + 1), short: ct, thread: '', role: '' } });
  for (const [si, [st, items]] of secs.entries()) {
    const sec = await task(book.id, { title: st, parent_id: ch.id, auto: false, duration: 30, sort: si, grp: ci, meta: { level: 'section', sid: `${ci + 1}.${si + 1}` } });
    for (const [ii, it] of items.entries()) outline.push(await task(book.id, { title: it, parent_id: sec.id, auto: true, duration: 90, sort: ii, grp: ci, meta: { level: 'item', n: '' }, points: [{ t: 'Draft' }, { t: 'Photos' }, { t: 'Edit' }] }));
  }
}

// ---------- what was done: sessions and ticked-off tasks in the past days ----------
const sess = (t, d, h, m, mins, done = 0) => run(`INSERT INTO work_log(user_id, task_id, period, kind, start, end, done) VALUES (?, ?, 0, 'work', ?, ?, ?)`, me, t.id, at(d, h, m), at(d, h, m) + mins * 60000, done);
const finish = async (t, d, h, m) => { await call('POST', `/api/tasks/${t.id}/done`, { period: 0 }); run('UPDATE tasks SET done_at = ? WHERE id = ?', at(d, h, m), t.id); };
for (let d = -10; d < 0; d++) { const w = wd(d); if (w === 0 || w === 6) continue;
  sess(outline[(d + 10) % 4], d, 10, 0, 75); sess(W.audit, d, 13, 30, 60); }
sess(W.audit, -1, 15, 0, 45, 1); await finish(W.audit, -1, 15, 45);
await finish(W.call, -2, 9, 40);
sess(outline[0], -3, 15, 0, 90, 1); await finish(outline[0], -3, 16, 30);
await finish(outline[1], -1, 11, 20);
run('UPDATE tasks SET spent = 240 WHERE id = ?', outline[2].id);
// this morning: two sessions, an errand ticked off, and a task running since 14:05
sess(W.wire, 0, 9, 40, 80); sess(outline[2], 0, 11, 5, 70);
sess(W.seo, 0, 13, 20, 25, 1); await finish(W.seo, 0, 13, 45);
await finish(await task(errands.id, { title: 'Return the library books', duration: 15, priority: 2 }), 0, 8, 50);
await call('POST', '/api/timer/start', { task: W.copy.id, period: 0 }); run('UPDATE active SET since = ? WHERE user_id = ?', at(0, 14, 5), me);

// clashes as the server finds them (writing the note into Google is left out: nothing leaves this build)
globalThis.fetch = async () => { throw new Error('offline'); };
await (await import('../server/conflicts.js')).checkClashes(me).catch(e => console.error('clashes:', e.message));

// ---------- record every page ----------
const snap = {};
const rec = async (key, url = key, empty) => { snap[key] = await call('GET', url).catch(e => { if (empty === undefined) throw e; return empty; }); };
await rec('/api/bootstrap'); await rec('/api/projects'); await rec('/api/tasks'); await rec('/api/accounts'); await rec('/api/stats');
await rec('/api/clashes'); await rec('/api/locations'); // served by other parts of the server (sign-in, tokens): nothing to show in a demo
snap['/api/me/tokens'] = []; snap['/api/me/sessions'] = [{ id: 'demo', created_at: Date.now(), last_seen: Date.now(), ua: 'This browser', current: true }]; snap['/api/passkeys'] = [];
await rec('/api/plan', `/api/plan?from=${at(-28, 0)}&to=${at(42, 0)}`);
for (const p of snap['/api/projects']) await rec('/api/activity?project=' + p.id);
Object.assign(snap['/api/bootstrap'], { version: 'demo', must2fa: false });
await app.close();
if (process.env.DEMO_DATA_DIR) { const { newToken } = await import('../server/ext.js'); fs.writeFileSync(path.join(process.env.DEMO_DATA_DIR, 'demo-token'), newToken(me, 'api', 'Mac'));
  fs.writeFileSync(path.join(process.env.DEMO_DATA_DIR, 'display-token'), newToken(me, 'display', 'Kitchen', [])); }

// ---------- the site: the app as it is, plus demo.js ----------
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true, filter: f => !f.includes(`${path.sep}mac`) && !f.endsWith('wall.html') });
fs.mkdirSync(path.join(OUT, 'vendor'));
const vendor = { 'preact.mjs': 'preact/dist/preact.mjs', 'hooks.mjs': 'preact/hooks/dist/hooks.mjs', 'htm.mjs': 'htm/dist/htm.mjs' };
for (const [name, file] of Object.entries(vendor)) fs.writeFileSync(path.join(OUT, 'vendor', name),
  fs.readFileSync(path.join(ROOT, 'node_modules', file), 'utf8').replace(/from\s*["']preact["']/g, 'from"/vendor/preact.mjs"').replace(/\/\/# sourceMappingURL=.*$/m, ''));
fs.writeFileSync(path.join(OUT, 'data.json'), JSON.stringify({ day: day0, data: snap }));
fs.writeFileSync(path.join(OUT, 'demo.js'), `window.DEMO_DAY = ${day0};\n` + fs.readFileSync(path.join(ROOT, 'scripts', 'demo-shim.js'), 'utf8'));
// paths relative to the page, so it works in a sub-folder (user.github.io/smart-calendar/)
let page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
  .replace(/(href|src)="\/(?!\/)/g, '$1="./')
  .replace('<script type="module"', '<script type="importmap">{"imports":{"/js/":"./js/","/vendor/":"./vendor/"}}</script>\n<script src="./demo.js"></script>\n<script type="module"');
fs.writeFileSync(path.join(OUT, 'index.html'), page);
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
const man = path.join(OUT, 'manifest.webmanifest'); fs.writeFileSync(man, fs.readFileSync(man, 'utf8').replace(/"\/(?!\/)/g, '"./'));
fs.rmSync(path.join(OUT, 'sw.js'), { force: true });
for (const f of fs.readdirSync(path.join(OUT, 'js'))) {   // the few absolute picture links
  const p = path.join(OUT, 'js', f); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/src="\/icon\.svg"/g, 'src="./icon.svg"'));
}
console.log(`Demo: ${OUT} (${Object.keys(snap).length} pages of data)`);
process.exit(0);
