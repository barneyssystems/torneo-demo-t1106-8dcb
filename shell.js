'use strict';
const KEYS = ['tos-demo-log-v1', 'tos-demo-log-v2-off', 'tos-demo-log-v2-media', 'tos-demo-log-v2-cup-off', 'tos-demo-log-v2-cup-qf-off']; // every mode's stored demo history
const frames = { familia: document.getElementById('f-familia'), arbitro: document.getElementById('f-arbitro'), papa: document.getElementById('f-papa') };
const LABEL = { familia: 'Ver como', arbitro: 'Árbitro', papa: 'Organizador' };
const panel = document.getElementById('demoPanel'), scrim = document.getElementById('scrim'), menuBtn = document.getElementById('demoMenu');
function sheet(open) { panel.hidden = !open; scrim.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); if (open) { const sel = panel.querySelector('[aria-selected=true]'); if (sel) sel.focus(); } }
function show(role) {
  for (const [r, f] of Object.entries(frames)) f.hidden = r !== role;
  document.querySelectorAll('.bar [data-role]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.role === role)));
  document.getElementById('modeLbl').textContent = LABEL[role];
  const w = frames[role].contentWindow; try { w.scrollTo(0, 0); } catch {} try { Promise.resolve((w.load || w.refresh).call(w)).then(() => { if (role === 'papa' && w.goHomeIfWaiting) w.goHomeIfWaiting(); w.scrollTo(0, 0); }); } catch {} // pick up what the other roles just did
}
document.querySelectorAll('.bar [data-role]').forEach((b) => b.addEventListener('click', () => { show(b.dataset.role); sheet(false); }));
menuBtn.addEventListener('click', () => sheet(panel.hidden));
scrim.addEventListener('click', () => sheet(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { sheet(false); menuBtn.focus(); } });
document.getElementById('reset').addEventListener('click', () => {
  if (!confirm('¿Empezar de nuevo? Se borra lo que hiciste en esta prueba.')) return;
  for (const k of KEYS) localStorage.removeItem(k); try { sessionStorage.removeItem('tos-live-t0'); } catch {} for (const f of Object.values(frames)) f.contentWindow.location.reload(); sheet(false);
});
// ARIA tabs keyboard pattern for the role list (same as ui.js tabKeys; the shell does not load ui.js)
(() => { const nav = document.querySelector('.bar'), tabs = () => [...nav.querySelectorAll('[role=tab]')]; tabs().forEach((t) => { t.setAttribute('aria-controls', 'f-' + t.dataset.role); document.getElementById('f-' + t.dataset.role).setAttribute('role', 'tabpanel'); });
  const sync = () => tabs().forEach((t) => { t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1; }); new MutationObserver(sync).observe(nav, { subtree: true, attributes: true, attributeFilter: ['aria-selected'] }); sync();
  nav.addEventListener('keydown', (e) => { const l = tabs(), i = l.indexOf(document.activeElement); if (i < 0) return; let n = null; if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % l.length; else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i - 1 + l.length) % l.length; else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = l.length - 1; if (n === null) return; e.preventDefault(); l[n].focus(); l[n].click(); }); })();
