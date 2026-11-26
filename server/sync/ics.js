// Read-only ICS subscription (Exchange/Outlook "Publish calendar", iCloud public links, any webcal feed).
import ical from 'node-ical';
import { get, all, run, tx, J } from '../db.js';
import { decrypt } from '../crypto.js';
import { storeEvents } from './store.js';
import { dayStart, isoDate, addDays } from '../time.js';

export function normalizeUrl(u) {
  u = String(u || '').trim().replace(/^webcals?:\/\//i, 'https://');
  const x = new URL(u);
  if (!/^https?:$/.test(x.protocol)) throw new Error('Only http(s)/webcal links are supported');
  return x.toString();
}

function freeOf(ev) {
  const ms = String(ev['MICROSOFT-CDO-BUSYSTATUS'] || ev['X-MICROSOFT-CDO-BUSYSTATUS'] || '').toUpperCase();
  if (ms) return ms === 'FREE' ? 1 : 0;                         // BUSY, OOF, TENTATIVE, WORKINGELSEWHERE block
  if (String(ev.transparency || '').toUpperCase() === 'TRANSPARENT') return 1;
  return 0;
}

export async function syncIcs(acc, farDays) {
  const { url } = decrypt(acc.secret), st = J(acc.state, {});
  const headers = { 'user-agent': 'smart-calendar/0.1', accept: 'text/calendar, */*' };
  if (st.etag) headers['if-none-match'] = st.etag;
  if (st.lastModified) headers['if-modified-since'] = st.lastModified;
  const ctl = AbortSignal.timeout(30000);
  const r = await fetch(url, { headers, signal: ctl, redirect: 'follow' });
  const cal = get('SELECT * FROM calendars WHERE account_id = ?', acc.id);
  if (r.status === 304 && st.rangeStart && st.rangeStart <= dayStart(isoDate(Date.now())) - 864e5) return { unchanged: true };
  if (!r.ok) throw new Error(`ICS download failed: HTTP ${r.status}`);
  const text = await r.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('The link did not return a calendar (.ics)');
  const data = ical.sync.parseICS(text);
  const from = dayStart(isoDate(Date.now())) - 864e5, to = dayStart(addDays(isoDate(Date.now()), farDays + 1));
  const rows = [];
  for (const ev of Object.values(data)) {
    if (!ev || ev.type !== 'VEVENT' || String(ev.status || '').toUpperCase() === 'CANCELLED') continue;
    let inst = [];
    // expand from earlier by the event's length: a holiday that already started still overlaps the window
    const span = ev.start && ev.end ? Math.min(400 * 864e5, Math.max(0, +new Date(ev.end) - +new Date(ev.start))) : 0;
    try { inst = ical.expandRecurringEvent(ev, { from: new Date(from - span - 864e5), to: new Date(to) }); }
    catch { if (ev.start) inst = [{ start: ev.start, end: ev.end || ev.start, isFullDay: ev.datetype === 'date', summary: ev.summary, event: ev }]; }
    for (const i of inst) {
      // Exchange often writes all-day events as midnight-to-midnight times with an all-day flag
      const allDay = !!i.isFullDay || /^TRUE$/i.test(String((i.event || ev)['MICROSOFT-CDO-ALLDAYEVENT'] || (i.event || ev)['X-MICROSOFT-CDO-ALLDAYEVENT'] || ''));
      const s = allDay ? dayStart(isoDate(i.start)) : +new Date(i.start), e = allDay ? dayStart(isoDate(i.end || i.start)) || s + 864e5 : +new Date(i.end || i.start);
      if (!(e > from && s < to)) continue;
      const src = i.event || ev;
      rows.push([`${ev.uid || ''}:${s}`, ev.uid || `${s}`, s, Math.max(e, allDay ? s + 864e5 : s), allDay ? 1 : 0, String((i.summary && (i.summary.val || i.summary)) || ev.summary || '(busy)'), freeOf(src), String(ev.description || '').slice(0, 2000),
        (src.location || ev.location) ? String((src.location?.val ?? src.location) || (ev.location?.val ?? ev.location)).slice(0, 500) : null, (ev.url?.val ?? ev.url) ? String(ev.url?.val ?? ev.url).slice(0, 500) : null]);
    }
  }
  // only what differs from the cache is written (unchanged events keep their row and id)
  const K = ['ext_id', 'series', 'start', 'end', 'all_day', 'title', 'free', 'descr', 'location', 'link'];
  const changes = storeEvents(cal.id, rows.map(x => Object.fromEntries(K.map((k, i) => [k, x[i]]))));
  run('UPDATE accounts SET state = ? WHERE id = ?', JSON.stringify({ ...st, etag: r.headers.get('etag'), lastModified: r.headers.get('last-modified'), rangeStart: from, count: rows.length }), acc.id);
  return { count: rows.length, unchanged: changes === 0 };
}
