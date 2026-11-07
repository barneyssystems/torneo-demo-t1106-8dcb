'use strict';
// Demo mode: every /api/* call is answered inside this browser by the same engine (engine/core.js) over localStorage. No server, no accounts.
(function () {
  const E = window.TosEngine; // R8-03: the stored demo history is keyed by media mode; an OFF build removes older logs (v1 and any media-mode log) so no provider URL stays in this browser
  const KEY = 'tos-demo-log-v2-' + (E.flags && E.flags.MEDIA ? 'media' : 'cup-qf-off'); // «cup»: the Foundation Cup identity; older stored demos (named «Torneo de prueba») are dropped
  if (!(E.flags && E.flags.MEDIA)) { try { localStorage.removeItem('tos-demo-log-v1'); localStorage.removeItem('tos-demo-log-v2-media'); localStorage.removeItem('tos-demo-log-v2-off'); localStorage.removeItem('tos-demo-log-v2-cup-off'); } catch { /* storage unavailable */ } }
  const TOKENS = { 'DEMO-ORG': { role: 'organizador', id: 'org1' }, 'DEMO-REF1': { role: 'arbitro', id: 'ref1' }, 'DEMO-REF2': { role: 'arbitro', id: 'ref2' }, 'DEMO-REF3': { role: 'arbitro', id: 'ref3' } };
  const SECRET = 'demo-only-not-a-secret';
  const store = { load() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }, save(l) { localStorage.setItem(KEY, JSON.stringify(l)); } };
  const core = E.core.createCore({ store, tokens: TOKENS, key: SECRET });
  window.TosDemo = { setRef(t) { sessionStorage.setItem('ref', t); }, ref() { return sessionStorage.getItem('ref'); }, reset() { localStorage.removeItem(KEY); seed(); }, core };
  // T-1106: Dad's format (groups, then knockout from quarterfinals). 12 invented teams in 4 groups of 3; the first 2 of each group go through.
  const TEAMS = { A: [['leones', 'Leones FC'], ['aguilas', 'Águilas'], ['tigres', 'Tigres']], B: [['halcones', 'Halcones'], ['lobos', 'Lobos'], ['pumas', 'Pumas']], C: [['jaguares', 'Jaguares'], ['condores', 'Cóndores'], ['toros', 'Toros']], D: [['potros', 'Potros'], ['delfines', 'Delfines'], ['panteras', 'Panteras']] };
  const NAMES = ['Mateo', 'Santiago', 'Diego', 'Nicolás', 'Samuel', 'Daniel', 'Andrés', 'Camilo'];
  function ev(type, payload) { const r = core.handle('POST', '/api/org/event', 'DEMO-ORG', { type, payload }); if (r.status !== 201) throw new Error('seed ' + type + ' ' + JSON.stringify(r.body)); }
  function seed() {
    if (store.load().length) return;
    ev('TOURNAMENT_SET', { name: "Barney's Foundation Cup", date: '2026-11-21' });
    ev('NAMES_PUBLIC_SET', { adults: true }); // the demo's players are all invented, so their names can be shown; a real tournament starts with names OFF
    ev('RULES_SET', { points: { win: 3, draw: 1, loss: 0 }, tiebreak: ['won', 'gd', 'gf', 'h2h_result', 'fairplay', 'ga_fewest'], walkoverGoals: 3, qualifiersPerGroup: 2, koLevel: 'PENS' }); // the July Cup rulebook: 3/1/0, W.O. 3-0
    let n = 0;
    for (const [g, ts] of Object.entries(TEAMS)) for (const [id, name] of ts) { ev('TEAM_ADDED', { id, name, groupId: g });
      for (let i = 0; i < 3; i++) ev('PLAYER_ADDED', { id: id + '-' + (i + 1), teamId: id, displayName: NAMES[(n++) % NAMES.length] + ' ' + String.fromCharCode(65 + (n % 26)) + '.', number: [9, 10, 7][i], isMinor: false }); }
  }
  // The demo opens on a FILLED fake match day (schedule, five approved results) so the first screen already looks like a real tournament. `?vacio=1` keeps the empty start (used by the scripted journeys).
  function sample() {
    const G = Object.fromEntries(Object.entries(TEAMS).map(([g, ts]) => [g, ts.map((t) => t[0])]));
    const plan = E.schedule.planEvents(G, { date: '2026-11-21', pitches: ['Cancha 1', 'Cancha 2', 'Cancha 3'], start: '08:00', slotMinutes: 100, referees: ['ref1', 'ref2', 'ref3'], ko: 'cuartos' }); // 2 × 40 min + 10 min halftime
    for (const e of plan) ev(e.type, e.payload);
    const grp = plan.filter((e) => e.type === 'FIXTURE_ADDED' && e.payload.stage === 'group').map((e) => e.payload), sc = [[3, 1], [1, 1], [0, 2], [2, 2], [1, 0]];
    const scorers = (team, n, i) => Array.from({ length: n }, (_, k) => ({ playerId: team + '-' + ((k + i) % 3 + 1), minute: 8 + k * 17 + i * 3 })); // invented players: «Mateo B.» style, three per team
    grp.slice(0, 5).forEach((f, i) => { const goals = [...scorers(f.home, sc[i][0], i).map((g) => ({ side: 'h', ...g })), ...scorers(f.away, sc[i][1], i + 1).map((g) => ({ side: 'a', ...g }))]; const r = core.handle('POST', '/api/org/report', 'DEMO-ORG', { fixtureId: f.id, report: { hg: sc[i][0], ag: sc[i][1], goals } }); ev('REPORT_APPROVED', { fixtureId: f.id, version: r.body.version }); });
    if (window.TosDemoMedia) window.TosDemoMedia(ev, grp); // T-1106: sample highlight/album links (invented) for the played games
  }
  const EMPTY = (() => { try { return /[?&]vacio/.test((window.top || window).location.search); } catch { return false; } })();
  seed();
  try { if (!EMPTY && !store.load().some((e) => e.type === 'FIXTURE_ADDED')) sample(); } catch { /* the demo still works empty */ }
  sessionStorage.setItem('org', 'DEMO-ORG'); sessionStorage.setItem('ref', 'DEMO-REF1');
  // DEMO ONLY: one unplayed match is shown «EN VIVO» with a minute that runs (2 s of the demo clock = 1 minute) and a goal at minute 36, so the screens can show a live state.
  // The real engine has no live state: nothing here exists outside this static demo, and it disappears when the match gets an approved result.
  function liveSim(fixtures) {
    let t0 = Number(sessionStorage.getItem('tos-live-t0')); if (!t0) { t0 = Date.now(); sessionStorage.setItem('tos-live-t0', String(t0)); }
    const f = fixtures.filter((x) => x.stage === 'group' && !x.result && x.home && x.away && x.kickoff).sort((a, b) => a.kickoff.localeCompare(b.kickoff))[0]; if (!f) return null;
    const minute = Math.min(80, 31 + Math.floor((Date.now() - t0) / 2000)); // 2 × 40 min // the match moves: 1-0, then 1-1 at 36', then 2-1 at 58'
    const goals = [{ side: 'h', minute: 12 }, { side: 'a', minute: 36 }, { side: 'h', minute: 58 }].filter((g) => g.minute <= minute);
    return { id: f.id, live: { sim: true, minute, hg: goals.filter((g) => g.side === 'h').length, ag: goals.filter((g) => g.side === 'a').length, goals } };
  }
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const u = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!u.pathname.includes('/api/')) return realFetch(input, init);
    if (window.__tosOffline) throw new TypeError('Failed to fetch'); // test hook: simulate no signal
    const path = u.pathname.slice(u.pathname.indexOf('/api/'));
    const h = (init && init.headers) || {}, auth = h.authorization || h.Authorization || '';
    const m = /^Bearer (\S+)$/.exec(auth); let body;
    if (init && init.body) { try { body = JSON.parse(init.body); } catch { body = null; } }
    const r = core.handle((init && init.method) || 'GET', path, m ? m[1] : null, body);
    if (r.status === 200 && path === '/api/public' && !EMPTY && r.body && Array.isArray(r.body.fixtures)) { const lv = liveSim(r.body.fixtures); if (lv) r.body = { ...r.body, fixtures: r.body.fixtures.map((f) => (f.id === lv.id ? { ...f, live: lv.live } : f)) }; }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
})();
