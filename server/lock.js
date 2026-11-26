// tiny async mutex per key (serialises calendar reads/writes per user so change detection never sees half-written state)
const chains = new Map();
export function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(key, next.finally(() => { if (chains.get(key) === tail) chains.delete(key); }));
  const tail = chains.get(key);
  return next;
}
