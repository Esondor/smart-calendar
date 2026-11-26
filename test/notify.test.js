// Notification channels: Off / Push / E-mail / Both, e-mail through SMTP (a tiny local SMTP server), fallback to push
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-notify-'));

const mails = [];
const smtp = net.createServer(sock => {
  let data = false, buf = '';
  sock.write('220 test\r\n');
  sock.on('data', d => {
    buf += d.toString();
    if (data) { const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return; mails.push(buf.slice(0, i)); buf = buf.slice(i + 5); data = false; sock.write('250 ok\r\n'); }
    let j; while (!data && (j = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, j); buf = buf.slice(j + 2);
      if (/^(EHLO|HELO)/i.test(line)) sock.write('250 test\r\n');
      else if (/^DATA/i.test(line)) { data = true; sock.write('354 go\r\n'); }
      else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    }
  });
});
await new Promise(r => smtp.listen(0, '127.0.0.1', r));
test.after(() => smtp.close());

const { run, get } = await import('../server/db.js');
const { createUser } = await import('../server/auth.js');
const { settingsOf, saveSettings } = await import('../server/models.js');
const { setServerConf } = await import('../server/serverconf.js');
const N = await import('../server/notify.js');
const { isoDate, addDays, at } = await import('../server/time.js');
const uid = createUser({ username: 'jdoe', name: 'S', password: 'long password 123' });
const setCh = ch => { const s = settingsOf(uid); s.notify.ch = { ...s.notify.ch, ...ch }; saveSettings(uid, s); };

test('channels: off, push, e-mail, both, and push when e-mail is not set up', async () => {
  setCh({ clash: 'both' });
  let r = await N.notify(uid, 'clash', { title: 'A', body: 'b', url: '/#/now' });
  assert.equal(r.mail, false, 'no SMTP yet → push only');
  setServerConf({ smtp: { host: '127.0.0.1', port: smtp.address().port, security: 'none', from: 'Calendar <cal@example.com>' } });
  r = await N.notify(uid, 'clash', { title: 'A', body: 'b' });
  assert.equal(r.mail, false, 'no address yet');
  run(`UPDATE users SET email = 'jd@example.com' WHERE id = ?`, uid);
  r = await N.notify(uid, 'clash', { title: 'Clash Mon 10:00', body: 'Team meeting wins', url: '/#/now' });
  assert.equal(r.mail, true); assert.equal(mails.length, 1);
  assert.match(mails[0], /Subject: Clash Mon 10:00/); assert.match(mails[0], /Team meeting wins/); assert.match(mails[0], /#\/now/);
  setCh({ partner: 'off' });
  r = await N.notify(uid, 'partner', { title: 'x' }); assert.equal(mails.length, 1); assert.deepEqual(r, { push: 0, mail: false });
  setCh({ partner: 'email' });
  await N.notify(uid, 'partner', { title: 'Done by Alex' }); assert.equal(mails.length, 2);
  assert.equal(N.channelOf({ start: false }, 'start'), 'off', 'older on/off settings still count');
  assert.equal(N.channelOf({}, 'event'), 'off'); assert.equal(N.channelOf({}, 'clash'), 'both');
});

test('deadline mail at the summary time', async () => {
  const pid = get('SELECT id FROM projects WHERE owner_id = ?', uid).id, now = Date.now(), today = isoDate(now);
  run(`INSERT INTO tasks(project_id, title, duration, created_by, assignee_id, created_at, updated_at, deadline) VALUES (?, 'Hand in report', 60, ?, ?, ?, ?, ?)`, pid, uid, uid, now, now, addDays(today, 1));
  const s = settingsOf(uid); s.notify.morning = '07:30'; s.notify.ch = { deadline: 'email', morning: 'off', start: 'off', event: 'off' }; saveSettings(uid, s);
  const before = mails.length;
  await N.notifyTick(at(today, 7 * 60 + 30));
  assert.equal(mails.length, before + 1); assert.match(mails.at(-1), /Hand in report \(tomorrow\)/);
  await N.notifyTick(at(today, 7 * 60 + 31));
  assert.equal(mails.length, before + 1, 'once a day');
});

test('a refused login explains what iCloud needs', async () => {
  const { sendMail } = await import('../server/mail.js');
  const bad = net.createServer(sock => { sock.write('220 test\r\n'); sock.on('data', d => { const l = d.toString(); if (/^EHLO/i.test(l)) sock.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n'); else if (/^AUTH/i.test(l)) sock.write('535 5.7.8 Authentication failed\r\n'); else if (/^QUIT/i.test(l)) { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 ok\r\n'); }); });
  await new Promise(r => bad.listen(0, '127.0.0.1', r));
  setServerConf({ smtp: { host: '127.0.0.1', port: bad.address().port, security: 'none', user: 'me@example.com', pass: ' app-pass \n', from: 'cal@example.com' } });
  await assert.rejects(() => sendMail('jd@example.com', 'x', 'y'), /Authentication failed.*app password/s);
  const { testMail } = await import('../server/mail.js');
  const r = await testMail('jd@example.com');
  assert.equal(r.ok, false); assert.equal(r.step, 'login', 'the test says the login is the problem');
  const { serverConf } = await import('../server/serverconf.js');
  assert.equal(serverConf().smtp.pass, 'app-pass', 'pasted spaces are trimmed');
  bad.close();
});

test('a task the plan keeps moving is reminded at most 3 times a day, 30 min apart', () => {
  const t0 = Date.now(), k = 'start:test:7:2026-11-24:';
  const at5 = [0, 5, 10, 30, 35, 60, 90, 120].map(m => N.again(k, t0 + m * 60000));
  assert.deepEqual(at5, [true, false, false, true, false, true, false, false]);
});
