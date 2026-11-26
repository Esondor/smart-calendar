// Local-time helpers (container TZ, e.g. Europe/Berlin). Dates as 'YYYY-MM-DD' strings, times as ms.
export const pad = n => String(n).padStart(2, '0');
export const isoDate = d => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const D0 = s => new Date(s + 'T12:00:00');
export const addDays = (s, n) => { const d = D0(s); d.setDate(d.getDate() + n); return isoDate(d); };
export const wd = s => D0(s).getDay();
export const tm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
export const hm = m => `${pad(Math.floor(m / 60))}:${pad(Math.round(m % 60))}`;
// ms of a local wall-clock time on a date (DST-safe: built from components)
export const at = (date, min) => { const [y, mo, d] = date.split('-').map(Number); return new Date(y, mo - 1, d, Math.floor(min / 60), min % 60).getTime(); };
export const dayStart = date => at(date, 0);
export const dayEnd = date => at(addDays(date, 1), 0);
export const minOfDay = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
// day number for period math (UTC-based, independent of DST)
export const dayNum = s => Math.round(Date.UTC(...s.split('-').map((x, i) => i === 1 ? x - 1 : +x)) / 864e5);
export const fromDayNum = n => new Date(n * 864e5).toISOString().slice(0, 10);
export const monday = s => addDays(s, -((wd(s) + 6) % 7));

// ---- recurrence periods ----
// recur = { freq: 'day'|'week'|'month', every: n, anchor: 'YYYY-MM-DD', days: [weekday...], window: 'any'|'morning'|'afternoon'|'evening' }
export function periodOf(recur, date) {
  const ev = Math.max(1, recur.every || 1), a = recur.anchor || date;
  if (recur.freq === 'day') return Math.floor((dayNum(date) - dayNum(a)) / ev);
  if (recur.freq === 'month') { const [y1, m1] = a.split('-').map(Number), [y2, m2] = date.split('-').map(Number); return Math.floor(((y2 - y1) * 12 + (m2 - m1)) / ev); }
  return Math.floor((dayNum(monday(date)) - dayNum(monday(a))) / (7 * ev));
}
// [startDate, endDateExclusive] of a period index
export function periodRange(recur, p) {
  const ev = Math.max(1, recur.every || 1), a = recur.anchor;
  if (recur.freq === 'day') { const s = fromDayNum(dayNum(a) + p * ev); return [s, addDays(s, ev)]; }
  if (recur.freq === 'month') {
    const [y, m] = a.split('-').map(Number), mk = k => { const t = (y * 12 + (m - 1)) + k; return `${Math.floor(t / 12)}-${pad(t % 12 + 1)}-01`; };
    return [mk(p * ev), mk((p + 1) * ev)];
  }
  const s = fromDayNum(dayNum(monday(a)) + p * 7 * ev); return [s, addDays(s, 7 * ev)];
}
export const WINDOWS = { any: [0, 1440], morning: [360, 720], afternoon: [720, 1020], evening: [1020, 1380] };
