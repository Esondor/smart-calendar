// WebAuthn helpers: JSON options from the server ↔ browser credentials (uses native JSON helpers where available).
const b2u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); const r = atob(s + '='.repeat((4 - s.length % 4) % 4)); return Uint8Array.from(r, c => c.charCodeAt(0)).buffer; };
const u2b = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const PKC = window.PublicKeyCredential;
export const passkeysSupported = () => !!PKC && window.isSecureContext;

function toJSON(c) {
  if (typeof c.toJSON === 'function') { try { return c.toJSON(); } catch {} }
  const r = c.response, o = { id: c.id, rawId: u2b(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults?.() || {}, authenticatorAttachment: c.authenticatorAttachment || undefined, response: { clientDataJSON: u2b(r.clientDataJSON) } };
  if (r.attestationObject) { o.response.attestationObject = u2b(r.attestationObject); o.response.transports = r.getTransports?.() || []; }
  if (r.authenticatorData) { o.response.authenticatorData = u2b(r.authenticatorData); o.response.signature = u2b(r.signature); if (r.userHandle) o.response.userHandle = u2b(r.userHandle); }
  return o;
}
export async function createPasskey(opts) {
  const pk = PKC.parseCreationOptionsFromJSON ? PKC.parseCreationOptionsFromJSON(opts)
    : { ...opts, challenge: b2u(opts.challenge), user: { ...opts.user, id: b2u(opts.user.id) }, excludeCredentials: (opts.excludeCredentials || []).map(c => ({ ...c, id: b2u(c.id) })) };
  return toJSON(await navigator.credentials.create({ publicKey: pk }));
}
export async function getPasskey(opts, mediation) {
  const { flow, ...o } = opts;
  const pk = PKC.parseRequestOptionsFromJSON ? PKC.parseRequestOptionsFromJSON(o) : { ...o, challenge: b2u(o.challenge), allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: b2u(c.id) })) };
  return toJSON(await navigator.credentials.get({ publicKey: pk, ...(mediation ? { mediation } : {}) }));
}
