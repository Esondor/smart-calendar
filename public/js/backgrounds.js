// Background gradients (dark): [top, middle, bottom]
export const BACKGROUNDS = {
  dusk: ['Dusk', '#3f3b62', '#4b3a4e', '#272430'],
  ocean: ['Ocean', '#1e3a5c', '#20384f', '#121a24'],
  forest: ['Forest', '#21443a', '#2a3b34', '#141b19'],
  ember: ['Ember', '#5a3436', '#4a2f41', '#22181e'],
  midnight: ['Midnight', '#23264a', '#1b1e37', '#0e0f1a'],
  graphite: ['Graphite', '#34343a', '#2a2a2f', '#18181b'],
};
export function applyBackground(key) {
  const b = BACKGROUNDS[key] || BACKGROUNDS.dusk, r = document.documentElement.style;
  r.setProperty('--bg1', b[1]); r.setProperty('--bg2', b[2]); r.setProperty('--bg3', b[3]);
  document.querySelectorAll('meta[name=theme-color]').forEach(m => m.setAttribute('content', b[1]));
}

// the page itself never zooms (Safari ignores user-scalable=no): pinch and the trackpad's ctrl+wheel are stopped;
// the calendar's own pinch (hour height) uses touch events and keeps working
if (typeof document !== 'undefined' && !window.__noZoom) {
  window.__noZoom = true;
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, e => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', e => { if (e.scale != null && e.scale !== 1) e.preventDefault(); }, { passive: false });
  window.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
}
