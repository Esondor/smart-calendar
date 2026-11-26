// Google Maps (Administration → Server → Maps key): place suggestions while you type, the address of a place,
// and travel time by car or bike from your home. The key stays on the server; the app only talks to this server.
import { serverConf, baseUrl } from './serverconf.js';
import { settingsOf } from './models.js';

const PLACES = 'https://places.googleapis.com/v1', ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';
export const mapsReady = () => !!serverConf().mapsKey;
const call = async (url, { method = 'GET', body, fields } = {}) => {
  const key = serverConf().mapsKey; if (!key) throw Object.assign(new Error('Maps is not set up on this server'), { statusCode: 400 });
  // a key limited to websites (e.g. *.example.com) checks where a request comes from: send the app's public address
  const origin = /^https?:\/\//.test(serverConf().baseUrl || '') ? baseUrl().replace(/\/$/, '') + '/' : null;
  const r = await fetch(url, { method, signal: AbortSignal.timeout(8000), body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key, ...(fields ? { 'x-goog-fieldmask': fields } : {}), ...(origin ? { referer: origin } : {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = String(j.error?.message || `HTTP ${r.status}`);
    const hint = /referer|referrer|permission denied/i.test(m) ? ` The key is limited to websites: allow ${serverConf().baseUrl ? new URL(serverConf().baseUrl).host : 'the app\'s address'} under "Website restrictions" (e.g. *.example.de/*), or set "Application restrictions" to None. Also check "API restrictions" includes Places API (New) and Routes API.`
      : /not been used|disabled|SERVICE_DISABLED/i.test(m) ? ' Enable "Places API (New)" and "Routes API" in Google Cloud.'
      : /billing/i.test(m) ? ' Enable billing for the Google Cloud project.'
      : /API key not valid|API_KEY_INVALID/i.test(m) ? ' The key is wrong; copy it again.' : '';
    throw Object.assign(new Error('Google Maps: ' + m + hint), { statusCode: 502 });
  }
  return j;
};

// suggestions for what you type, near where you are (rough device location, if you allowed it), else near your home
export async function suggest(uid, q, session, near) {
  const home = settingsOf(uid).plan.home;
  const ok = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  const c = ok(near) ? near : ok(home) ? home : null;
  const j = await call(`${PLACES}/places:autocomplete`, { method: 'POST', body: { input: String(q).slice(0, 120), sessionToken: session || undefined, languageCode: 'de',
    ...(c ? { locationBias: { circle: { center: { latitude: c.lat, longitude: c.lng }, radius: 30000 } }, origin: { latitude: c.lat, longitude: c.lng } } : {}) } });
  return (j.suggestions || []).map(s => s.placePrediction).filter(Boolean).slice(0, 6).map(p => ({
    id: p.placeId, title: p.structuredFormat?.mainText?.text || p.text?.text || '', sub: p.structuredFormat?.secondaryText?.text || '', km: p.distanceMeters != null ? Math.round(p.distanceMeters / 100) / 10 : null }));
}
// name and address of a picked place
export async function place(id, session) {
  const j = await call(`${PLACES}/places/${encodeURIComponent(id)}${session ? '?sessionToken=' + encodeURIComponent(session) : ''}`, { fields: 'id,displayName,formattedAddress,location' });
  const name = j.displayName?.text || '', addr = j.formattedAddress || '';
  return { id: j.id, name, address: addr, text: name && !addr.startsWith(name) ? `${name}, ${addr}` : addr || name, lat: j.location?.latitude, lng: j.location?.longitude };
}
// a typed address → the address Google knows and its coordinates
export async function locate(text) {
  const j = await call(`${PLACES}/places:searchText`, { method: 'POST', fields: 'places.formattedAddress,places.location', body: { textQuery: String(text).slice(0, 300), languageCode: 'de', pageSize: 1 } });
  const p = j.places?.[0]; return p?.location ? { address: p.formattedAddress || String(text), lat: p.location.latitude, lng: p.location.longitude } : null;
}
// a pin ("lat,lng") goes as coordinates, anything else as an address
const way = to => { const m = String(to).match(/^(-?\d+\.\d+),(-?\d+\.\d+)$/); return m ? { location: { latLng: { latitude: +m[1], longitude: +m[2] } } } : { address: String(to).slice(0, 300) }; };
// minutes from home by car and by bike (cached for a day)
const cache = new Map();
export async function travel(uid, to) {
  const home = settingsOf(uid).plan.home;
  if (!home?.address || !to) return null;
  const k = `${home.address}|${to}`, hit = cache.get(k);
  if (hit && Date.now() - hit.at < 864e5) return hit.v;
  const one = async mode => {
    try {
      const j = await call(ROUTES, { method: 'POST', fields: 'routes.duration,routes.distanceMeters', body: { origin: home.lat != null ? { location: { latLng: { latitude: home.lat, longitude: home.lng } } } : { address: home.address }, destination: way(to), travelMode: mode } });
      const r = j.routes?.[0]; return r ? { min: Math.max(1, Math.round(parseInt(r.duration) / 60)), km: Math.round(r.distanceMeters / 100) / 10 } : null;
    } catch { return null; }
  };
  const [car, bike] = await Promise.all([one('DRIVE'), one('BICYCLE')]);
  const v = { car, bike }; cache.set(k, { at: Date.now(), v });
  return v;
}
