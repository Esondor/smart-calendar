// Travel time as the buffer before an appointment: from home (Settings → Planning → Travel) to the event's place, by bike
// when that takes at most "By bike up to" minutes, else by car. Times are kept per place for 30 days; Google is asked
// only for places of the next two weeks it does not know yet.
import { all, run } from './db.js';
import { settingsOf } from './models.js';
import { mapsReady, travel } from './maps.js';
import { markDirty } from './planner.js';

export const placeKey = loc => String(loc || '').trim().toLowerCase();
// your place rules (Settings → Planning → Travel): a room code like "B03 1-161" in the place or title stands for a place
// ("North Campus"). A rule is a pattern: ## up to two digits (B## matches B3 and B03), * anything, a space or -
// matches either or none; or a /regex/.
const ruleCache = new Map();
export function ruleRegex(m) {
  m = String(m || '').trim(); if (!m) return null;
  if (ruleCache.has(m)) return ruleCache.get(m);
  let re = null;
  try {
    const rx = /^\/(.+)\/$/.exec(m);
    re = rx ? new RegExp(rx[1], 'i') : new RegExp('(^|[^\\p{L}\\p{N}])' + (m.match(/#+|[\s-]+|./g) || []).map(c => c[0] === '#' ? `\\d{1,${c.length}}` : c === '*' ? '.*?' : /^[\s-]+$/.test(c) ? '[\\s-]?' : c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('') + '(?![\\p{L}\\p{N}])', 'iu');
  } catch { re = null; }
  if (ruleCache.size > 200) ruleCache.clear();
  ruleCache.set(m, re); return re;
}
// a real address: a street with a number ("Waldstraße 12", "Am Hafen 3, …") or a postcode
const ADDRESS = /(stra(ß|ss)e|str\.|weg|allee|platz|gasse|ring|damm|ufer|chaussee|street|st\.|road|avenue|lane)\s*\d|\b\d{4,5}\s+\p{L}{3,}|\p{L}{3,}\s+\d+\s?[a-z]?\s*,/iu;
export const isAddress = t => ADDRESS.test(String(t || ''));
// a pin: "53.1468, 8.1650" or a Google Maps link (the exact pin !3d…!4d…, else @lat,lng or ?q=lat,lng)
const okPin = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
export function parsePin(text) {
  const t = String(text || '').trim(); let m;
  if ((m = t.match(/^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/))) return okPin(+m[1], +m[2]);
  if (!/^https?:\/\//.test(t)) return null;
  let u; try { u = decodeURIComponent(t); } catch { u = t; }
  if ((m = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/))) return okPin(+m[1], +m[2]);
  if ((m = u.match(/[?&](?:q|query|ll|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/))) return okPin(+m[1], +m[2]);
  if ((m = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/))) return okPin(+m[1], +m[2]);
  return null;
}
// the name in a Google Maps place link (…/maps/place/Carl+von+Ossietzky+Universität/…)
export const pinName = text => { const m = String(text || '').match(/\/maps\/place\/([^/@?]+)/); try { return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : ''; } catch { return ''; } };
// a short link (maps.app.goo.gl/…): followed to the full one
export async function resolvePin(text) {
  let t = String(text || '').trim();
  for (let i = 0; i < 4 && /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//.test(t); i++) {
    const r = await fetch(t, { redirect: 'manual', signal: AbortSignal.timeout(8000) }).catch(() => null);
    const loc = r?.headers.get('location'); if (!loc) break; t = new URL(loc, t).href;
  }
  return { pin: parsePin(t), name: pinName(t), url: t };
}
export const pinUrl = p => `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
// the rule that applies to an event, if any (see placeOf)
export function ruleOf(e, rules = []) {
  if (isAddress(e.location)) return null;
  for (const r of rules || []) { const re = ruleRegex(r.match); if (re && (r.place || r.lat != null) && (re.test(e.location || '') || re.test(e.title || ''))) return r; }
  return null;
}
// where you actually go for an event: a matching rule's place, else the event's own place. An address in the event's
// place always wins: rules only stand in for room codes and places without one.
// A rule with a pin goes to the pin ("lat,lng").
export function placeOf(e, rules = []) {
  const r = ruleOf(e, rules);
  return r ? (r.lat != null ? `${r.lat},${r.lng}` : r.place) : e.location || null;
}
// a place you go to: not an online meeting, a link or a phone call
const ONLINE = /https?:\/\/|\bwww\.|zoom|teams|webex|skype|meet\.google|jitsi|whereby|bigbluebutton|\bonline\b|virtual|telefon|phone|\bcall\b|anruf/i;
export const physical = loc => { const v = String(loc || '').trim(); return v.length >= 4 && !ONLINE.test(v); };

// the way there: by bike up to the limit, else by car (by bike when there is no car route)
export function travelMode(tv, bikeMax = 25) {
  if (!tv) return null;
  if (tv.bike != null && tv.bike <= bikeMax) return { mode: 'bike', min: tv.bike };
  if (tv.car != null) return { mode: 'car', min: tv.car };
  return tv.bike != null ? { mode: 'bike', min: tv.bike } : null;
}

const busy = new Set();
export async function refreshTravel(uid) {
  const home = settingsOf(uid).plan?.home;
  if (!mapsReady() || !home?.address || busy.has(uid)) return 0;
  busy.add(uid);
  try {
    const now = Date.now();
    const known = new Map(all('SELECT place, at FROM travel_times WHERE user_id = ?', uid).map(r => [r.place, r.at]));
    const places = new Map();
    const rules = settingsOf(uid).plan?.places || [];
    for (const r of all(`SELECT e.location, e.title FROM events e JOIN calendars c ON c.id = e.calendar_id
        WHERE c.user_id = ? AND e.ours = 0 AND e.all_day = 0 AND e.end > ? AND e.start < ?`, uid, now, now + 14 * 864e5)) {
      const p = placeOf(r, rules), k = placeKey(p);
      if (p && physical(p) && !places.has(k) && !(known.get(k) > now - 30 * 864e5)) places.set(k, p.trim());
    }
    let n = 0;
    for (const [k, loc] of [...places].slice(0, 25)) {
      const t = await travel(uid, loc).catch(() => undefined);
      if (t === undefined) break;   // Google is not answering: next round
      run(`INSERT INTO travel_times(user_id, place, car, bike, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, place) DO UPDATE SET car = excluded.car, bike = excluded.bike, at = excluded.at`,
        uid, k, t?.car?.min ?? null, t?.bike?.min ?? null, now);
      n++;
    }
    if (n) markDirty(uid);
    return n;
  } finally { busy.delete(uid); }
}
// a new home: every time is measured again
export function homeChanged(uid) { run('DELETE FROM travel_times WHERE user_id = ?', uid); refreshTravel(uid).catch(() => {}); }
export async function travelTick() { for (const u of all('SELECT id FROM users')) await refreshTravel(u.id).catch(() => {}); }
