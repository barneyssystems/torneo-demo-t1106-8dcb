'use strict';
document.body.classList.add('role-papa'); // Papá's screens have their own look (navy + gold), see app.css
const main = document.getElementById('main');
let TOKEN = sessionStorage.getItem('org') || null, ST = null, TAB = 'cola', NOTE = null, SCHED = null, PLAN = null, SHEET = null, SHEETBUSY = false; // SHEET: the match whose referee sheet Dad is typing (T-1106)
const LINKS = {}; // signing links are shown once, kept only in this page's memory
const dayShort = (k) => new Date(k.slice(0, 10) + 'T12:00').toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' });
const rid = (p) => p + Math.random().toString(36).slice(2, 8);
async function call(method, url, body) {
  const r = await fetch(url, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(errEs(j, r.status)), { status: r.status });
  return j;
}
const ev = (type, payload) => call('POST', '/api/org/event', { type, payload });
function note(kind, text) { NOTE = { kind, text }; }
async function refresh() {
  try { ST = await call('GET', '/api/org/state'); if (ST.state.rules && ST.state.rules.preset) await loadPresets(); if (NOTE && NOTE.net) NOTE = null; }
  catch (e) {
    // T-1110-N: a moment without signal must not empty Dad's screen or stop the refresh: keep what he sees, say so, and keep trying.
    if (!e.status && ST) { if (!NOTE || NOTE.net) NOTE = { kind: 'warn', net: true, text: 'Sin señal. Lo que ves puede estar atrasado; se actualiza solo cuando vuelva.' }; }
    else { if (e.status === 401 || e.status === 403) { TOKEN = null; sessionStorage.removeItem('org'); note('bad', 'Código no válido.'); } else note('bad', 'No disponible: ' + e.message); ST = null; } }
  render();
}
let NOTE_TIMER = null;
async function act(fn, ok) { try { await fn(); note('ok', ok); } catch (e) { if (e.soft) NOTE = null; else if (e.warn) note('warn', e.message); else note('bad', 'No se guardó: ' + e.message); } await refresh();
  if (NOTE && NOTE.kind === 'ok') { window.scrollTo(0, 0); const mine = NOTE; clearTimeout(NOTE_TIMER); NOTE_TIMER = setTimeout(() => { if (NOTE === mine) { NOTE = null; render(); } }, 6000); } }
// T-1110-N: approving publishes to every family, so a double tap must never land on the next game in the queue (it slides under the finger when the first card leaves).
let APPROVING = false, APPROVE_HOLD = 0; const APPROVE_HOLD_MS = 1000;
const approveLocked = () => APPROVING || Date.now() < APPROVE_HOLD;
const lockApprove = (on) => document.querySelectorAll('[data-approve]').forEach((b) => { b.disabled = on; });
const approveAttr = () => (approveLocked() ? { disabled: 'disabled' } : {});
// A lost answer on a weak signal: the approval may have been saved. Look before saying it failed.
async function sendApproval(payload) {
  try { await ev('REPORT_APPROVED', payload); }
  catch (e) { if (e.status) throw e;
    let st = null; try { st = await call('GET', '/api/org/state'); } catch {}
    const a = st && st.view.validApproved[payload.fixtureId]; if (a && a.version === payload.version) return;
    throw Object.assign(new Error('Sin señal: no pude confirmar si se guardó. Cuando vuelva la señal, mira si sigue aquí y tócalo otra vez.'), { warn: true }); }
}
async function approveOnce(payload, ok) {
  if (approveLocked()) return; APPROVING = true; lockApprove(true);
  try { await act(() => sendApproval(payload()), ok); }
  finally { APPROVING = false; APPROVE_HOLD = Date.now() + APPROVE_HOLD_MS; lockApprove(true); setTimeout(() => { if (!approveLocked()) lockApprove(false); }, APPROVE_HOLD_MS + 20); }
}
// R111: the referee's optional written report, shown to the organizer only (text node, never HTML).
const refNote = (r, fid) => (r && typeof r.note === 'string' && r.note ? el('div', { class: 'refNoteView', 'data-ref-note': fid }, el('div', { class: 'step' }, 'Informe del árbitro'), el('p', { class: 'noteText' }, r.note)) : null);
function card(title, ...kids) { return el('div', { class: 'card' }, el('h2', {}, title), el('div', { class: 'pad' }, ...kids)); }
function field(id, labelText, attrs) { return [el('label', { for: id }, labelText), el('input', { id, ...attrs })]; }
const val = (id) => document.getElementById(id).value.trim();
const TB_ES = { h2h_points: 'puntos entre empatados', h2h_gd: 'dif. entre empatados', h2h_gf: 'goles entre empatados', h2h_result: 'resultado entre ambos (solo 2 equipos)', won: 'partidos ganados',
  gd: 'dif. general', gf: 'goles a favor', fairplay: 'juego limpio (tarjetas)', ga_fewest: 'menos goles recibidos', sorteo: 'sorteo del Comité', PENDIENTE: 'pendiente' };
let PRESETS = null;
async function loadPresets() { if (!PRESETS) PRESETS = (await call('GET', '/api/org/presets')).presets; return PRESETS; }
function fxLabel(s, f) { const n = (id) => (s.teams[id] ? s.teams[id].name : '?'); return f.stage === 'group' ? `${n(f.home)} vs ${n(f.away)}` : `${f.round}: ${srcLabel(f.homeSource)} vs ${srcLabel(f.awaySource)}`; }

function login() {
  return [card('Entrar', el('p', { class: 'meta' }, 'Pega el código de organizador.'), ...field('tok', 'Código', { autocomplete: 'off' }),
    el('button', { class: 'btn', id: 'go', onclick: () => { TOKEN = val('tok'); sessionStorage.setItem('org', TOKEN); refresh(); } }, 'Entrar'))];
}
const groupsOf = (s) => [...new Set(Object.values(s.teams).map((t) => t.groupId).filter(Boolean))].sort();
const tname = (id) => (ST.state.teams[id] || {}).name || id;

const TABS = {
  planCard() {
    const s = ST.state, groups = {};
    for (const t of Object.values(s.teams)) if (t.groupId) (groups[t.groupId] = groups[t.groupId] || []).push(t.id);
    const nG = Object.keys(groups).length, nT = Object.values(groups).flat().length;
    if (nT < 4) return el('div', { class: 'card qcard' }, el('h2', {}, 'Armar el calendario'), el('div', { class: 'pad' }, el('p', {}, 'Primero hacen falta los equipos (al menos 4). Se agregan en «Armar».')));
    const O = PLAN || (PLAN = { pitches: 3, start: '08:00', slot: 100, rounds: 1, ko: 'cuartos' }); // T-1106: 2 × 40 min + halftime ≈ 1 h 40 per game; quarterfinals by default (Dad's format)
    const date = (s.tournament && s.tournament.date) || '';
    const pitches = Array.from({ length: O.pitches }, (_, i) => 'Cancha ' + (i + 1));
    const NB = O.nb || (O.nb = Object.assign(Object.create(null), (s.format && s.format.notBefore) || {})), /* T1113-03/04: null-prototype map, restored from the saved format */ opts = { date, start: O.start, slotMinutes: O.slot, rounds: O.rounds, pitches, ko: O.ko === 'cuartos' ? 'cuartos' : undefined, ...(Object.keys(NB).length ? { notBefore: NB } : {}) };
    const fit = date ? Schedule.planFits(groups, opts) : { ok: false, message: 'Falta la fecha del torneo (se pone en «Armar»).' };
    const sel = (id, label, opts2, cur, key, num, scroll) => [el('div', { class: 'step' }, label), chips(id, opts2, cur, (v) => { PLAN[key] = num ? Number(v) : v; render(); }, label, scroll)];
    const times = []; for (let m = 7 * 60; m <= 13 * 60; m += 30) times.push(String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
    // ONE atomic save: either the whole calendar exists or nothing was created.
    const build = () => act(async () => {
      const plan = Schedule.planEvents(groups, opts);
      // T-1106/T-1109: the knockout decides how many go through per group. The rule is saved in the SAME batch, before the matches that draw on it, even when no rules were chosen yet.
      plan.splice(0, plan.length, ...Schedule.withQualifierRule(plan, s.rules, fit.qualifiers));
      try { await call('POST', '/api/org/batch', { events: plan.map((e) => ({ type: e.type, payload: e.payload })) }); }
      catch (e) { // lost answer: the calendar may have been saved. Look before saying it failed.
        if (e.status) throw e;
        try { const st = await call('GET', '/api/org/state'); const have = new Set(Object.keys(st.state.fixtures)); if (plan.filter((x) => x.type === 'FIXTURE_ADDED').every((x) => have.has(x.payload.id)) && st.state.format) return; } catch {}
        throw e; }
    }, 'Listo. El calendario está armado y los árbitros ya pueden anotar. Toca un partido si quieres cambiar su hora o cancha.');
    return el('div', { class: 'card qcard', id: 'planCard' }, el('h2', {}, 'Armar el calendario'), el('div', { class: 'pad' },
      el('p', {}, `${nT} equipos en ${nG} grupo${nG > 1 ? 's' : ''}.`),
      ...sel('pc', '¿Cuántas canchas?', [[1, '1 cancha'], [2, '2 canchas'], [3, '3 canchas'], [4, '4 canchas']], O.pitches, 'pitches', true),
      ...sel('ps', '¿A qué hora es el primer partido?', times.map((t) => [t, L.t12(t)]), O.start, 'start', false, false),
      ...sel('pd', '¿Cuánto dura cada partido? (2 tiempos de 40 + descanso de 10 = 1 h 30)', [[45, '45 min'], [60, '1 hora'], [75, '1 h 15'], [90, '1 h 30'], [100, '1 h 40']], O.slot, 'slot', true),
      ...sel('pk', '¿Desde dónde es la eliminatoria?', [['cuartos', 'Cuartos de final'], ['semis', 'Semifinales']], O.ko, 'ko', false),
      // T-1113 (Dad: "this team plays after 7"): per-team earliest kickoff, applied when the calendar is built
      el('details', { id: 'nbBox', ...(Object.keys(NB).length || O.nbTeam ? { open: 'open' } : {}) }, el('summary', { class: 'step' }, '¿Algún equipo solo puede jugar después de cierta hora?'),
        chips('nbTeam', Object.values(s.teams).filter((t) => t.groupId).sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.id, t.name]), O.nbTeam || null, (v) => { O.nbTeam = v; render(); }, 'Equipo', true),
        O.nbTeam ? chips('nbTime', (() => { const a = []; for (let m = 8 * 60; m <= 21 * 60; m += 30) a.push(String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')); return a; })().map((t) => [t, 'Después de las ' + L.t12(t)]), NB[O.nbTeam] || null, (v) => { NB[O.nbTeam] = v; O.nbTeam = null; render(); }, 'Hora', true) : null,
        Object.keys(NB).length ? el('div', { id: 'nbList' }, Object.entries(NB).map(([t, h]) => el('div', { class: 'row', 'data-nb': t }, el('div', { class: 'team' }, `${tname(t)}: después de las ${L.t12(h)}`), el('button', { class: 'linkbtn', 'data-nb-del': t, 'aria-label': 'Quitar la hora de ' + tname(t), onclick: () => { delete NB[t]; render(); } }, 'Quitar')))) : null),
      ...sel('pr', '¿Cuántas veces juega cada equipo contra los demás de su grupo?', [[1, '1 vez (una vuelta)'], [2, '2 veces (ida y vuelta)']], O.rounds, 'rounds', true),
      fit.ok && !(s.rules && s.rules.points) ? el('p', { class: 'meta', id: 'planRulesNote' }, 'Aún no hay reglas: se usarán las del torneo de julio (3-1-0, empate en eliminatoria a penales). Puedes cambiarlas en «Reglas» antes de los partidos.') : null,
      fit.ok ? el('div', { class: 'banner ok', id: 'planInfo' }, `${fit.matches} partidos · el último a las ${fit.endsAt12} · ${fit.note}`) : el('div', { class: 'banner warn', id: 'planWarn', 'data-nofit': '1' }, fit.message),
      el('button', { class: 'btn big', id: 'buildPlan', ...(fit.ok ? {} : { disabled: 'disabled' }), onclick: build }, 'Armar el calendario')));
  },
  // T-1106 (Dad: «Los marcadores los entregan los árbitros en su hoja de informe» · «Yo actualizo la tabla» · «aprobar primero»):
  // Dad types the score from the referee's paper sheet and publishes it in one go (his own report + his approval). The table and bracket do the rest.
  sheetCard() {
    const f = ST.state.fixtures[SHEET.id]; if (!f) { SHEET = null; return null; }
    const p = L.participants(ST, f), nm = (id) => (ST.state.teams[id] || {}).name || '?', ko = f.stage === 'ko', tie = SHEET.hg === SHEET.ag;
    const step = (key, label) => el('div', { class: 'rcol' }, el('div', { class: 'rname' }, label), el('div', { class: 'stepper v' },
      el('button', { 'aria-label': 'menos ' + label, 'data-sminus': key, onclick: () => { SHEET[key] = Math.max(0, SHEET[key] - 1); render(); } }, '−'), el('output', { id: 'sv-' + key }, SHEET[key]),
      el('button', { 'aria-label': 'más ' + label, 'data-splus': key, onclick: () => { SHEET[key] = Math.min(99, SHEET[key] + 1); render(); } }, '+')));
    const koLevel = (ST.state.rules || {}).koLevel || 'PENDIENTE', { needEt, needPens, report, error } = L.sheetReport(f.stage, koLevel, SHEET);
    // T-1109: one operation on the server (report + approval together), safe to tap twice or retry on a lost answer: the same opKey never writes twice.
    const publish = () => { if (SHEETBUSY) return; if (error) { note('warn', error); return render(); } SHEETBUSY = true; render();
      return act(async () => {
        try { await call('POST', '/api/org/publish', { fixtureId: f.id, report, participants: { home: p.home, away: p.away }, opKey: SHEET.op }); }
        catch (e) { if (e.status) throw e; throw Object.assign(new Error('Se perdió la conexión y no sabemos si se publicó. Toca «Publicar» otra vez: no se publica dos veces.'), { warn: true }); }
        SHEET = null;
      }, `Publicado: ${nm(p.home)} ${SHEET.hg}–${SHEET.ag} ${nm(p.away)}. La tabla ya se actualizó.`).finally(() => { SHEETBUSY = false; render(); }); };
    return el('div', { class: 'card qcard refForm', id: 'sheetCard' }, el('h2', {}, 'Marcador de la hoja del árbitro'), el('div', { class: 'pad' },
      el('p', { class: 'meta' }, [L.title(ST, f), f.kickoff ? L.t12(f.kickoff) : '', f.pitch].filter(Boolean).join(' · ')),
      el('div', { class: 'rgrid' }, step('hg', nm(p.home)), step('ag', nm(p.away))),
      needEt ? el('div', { id: 'sheetEt' }, el('div', { class: 'step' }, 'Empate: goles en la prórroga'), el('div', { class: 'rgrid' }, step('eh', 'Prórroga ' + nm(p.home)), step('ea', 'Prórroga ' + nm(p.away)))) : null,
      needPens ? el('div', { id: 'sheetPens' }, el('div', { class: 'step' }, needEt ? 'Sigue el empate: penales' : 'Empate: penales'), el('div', { class: 'rgrid' }, step('ph', 'Penales ' + nm(p.home)), step('pa', 'Penales ' + nm(p.away)))) : null,
      error && koLevel === 'PENDIENTE' ? el('div', { class: 'banner warn', id: 'sheetRule' }, error) : null,
      el('p', { class: 'meta' }, 'Al publicar, todos lo ven en el link y la tabla se actualiza sola.'),
      el('button', { class: 'btn big', id: 'sheetPublish', ...(SHEETBUSY ? { disabled: 'disabled', 'aria-busy': 'true' } : {}), onclick: publish }, SHEETBUSY ? 'Publicando…' : `Publicar ${SHEET.hg}–${SHEET.ag}`),
      el('button', { class: 'linkbtn', id: 'sheetCancel', onclick: () => { SHEET = null; render(); } }, 'Cancelar')));
  },
  cola() {
    const q = L.pendingQueue(ST), out = [];
    if (SHEET) { const c = TABS.sheetCard(); if (c) return [c]; }
    out.push(el('div', { id: 'queue', class: 'qhead' }, q.length ? el('h2', { class: 'qtitle' }, q.length === 1 ? '1 resultado espera tu OK' : q.length + ' resultados esperan tu OK') : el('h2', { class: Object.keys(ST.state.fixtures).length ? 'qtitle idle' : 'qtitle none' }, Object.keys(ST.state.fixtures).length ? '✓ Nada por aprobar' : 'Aún no hay calendario'),
      q.length ? el('p', { class: 'meta' }, 'Nadie más lo ve hasta que lo apruebes.') : el('p', { class: 'meta' }, Object.keys(ST.state.fixtures).length ? 'Todo al día. Cuando un árbitro mande un marcador, aparece aquí solo.' : 'Ve a «Horario» y arma el calendario.')));
    for (const it of q) {
      const kids = [el('div', { class: 'qteams' }, el('span', {}, it.home || '?'), el('span', {}, it.away || '?')),
        el('div', { class: 'qscore' }, el('span', {}, it.hg), el('span', { class: 'dash' }, '–'), el('span', {}, it.ag)),
        el('div', { class: 'meta center' }, [it.kickoff ? L.t12(it.kickoff) : '', it.pitch].filter(Boolean).join(' · ') + ' · ' + (it.report.by ? 'lo mandó el ' + (it.report.by.role === 'arbitro' ? 'árbitro' : it.report.by.role) : ''))];
      const gl = (it.report.goals || []).map((g) => { const pl = g.playerId && ST.state.players[g.playerId]; return `${g.minute ? g.minute + "' " : ''}${pl ? pl.displayName : 'gol'} (${g.side === 'h' ? it.home : it.away})`; });
      if (gl.length) kids.push(el('div', { class: 'meta center', 'data-goals-line': it.fixtureId }, 'Goles: ' + gl.join(' · ')));
      { const n = refNote(it.report, it.fixtureId); if (n) kids.push(n); }
      if (it.isCorrection) kids.push(el('div', { class: 'banner warn' }, `Corrige el resultado ya aprobado (${it.previous.hg}–${it.previous.ag}). Escribe el motivo.`), ...field('why' + it.version, 'Motivo de la corrección', {}));
      kids.push(el('button', { class: 'btn big', 'data-approve': it.fixtureId, ...approveAttr(), onclick: () => approveOnce(() => ({ fixtureId: it.fixtureId, version: it.version, ...(it.isCorrection ? { reason: val('why' + it.version) } : {}) }), 'Aprobado: ' + it.home + ' ' + it.hg + '–' + it.ag + ' ' + it.away + '. Ya lo ven las familias.') }, `Aprobar ${it.hg}–${it.ag}`),
        el('button', { class: 'btn sec', 'data-wrong': it.fixtureId, onclick: () => { TAB = 'resultados'; syncTabs(); render(); } }, 'No está bien · corregir'));
      out.push(el('div', { class: 'card qcard', 'data-pending': it.fixtureId }, el('h2', {}, it.title), el('div', { class: 'pad' }, ...kids)));
    }
    out.push(...TABS.dia(q));
    return out;
  },
  // The day at a glance (Dad's "Hoy"): progress, what is next, what just finished. Pure reading of state; nothing to learn.
  dia(q) {
    const s = ST.state, pr = L.dayProgress(ST), all = { length: pr.total }, done = pr.doneFixtures;
    if (!Object.keys(s.fixtures).length) return [];
    const next = pr.next.slice(0, 4);
    const last = done.sort((a, b) => ST.view.validApproved[b.id].approvedSeq - ST.view.validApproved[a.id].approvedSeq).slice(0, 3);
    const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
    const out = [el('div', { class: 'card', id: 'dayCard' }, el('h2', {}, 'El día'), el('div', { class: 'pad' }, el('div', { class: 'dayN' }, `${pr.done} de ${pr.total} partidos listos`), el('div', { class: 'bar2', role: 'img', 'aria-label': pct + '% listo' }, el('span', { class: 'fill w' + Math.round(pct / 5) * 5 })), ))];
    if (next.length) out.push(el('div', { class: 'card', id: 'nextCard' }, el('h2', {}, 'Siguen'), next.map((f) => { const p = L.participants(ST, f), ready = p.home && p.away;
      return el('div', { class: 'row' }, el('div', { class: 'team' }, L.title(ST, f), el('div', { class: 'meta' }, [f.kickoff ? L.t12(f.kickoff) : 'sin hora', f.pitch].filter(Boolean).join(' · '))),
        ready ? el('button', { class: 'btn inline', 'data-sheet': f.id, onclick: () => { SHEET = { id: f.id, hg: 0, ag: 0, eh: 0, ea: 0, ph: 0, pa: 0, op: 's' + Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, '0')).join('') }; render(); window.scrollTo(0, 0); } }, 'Anotar') : null); })));
    if (last.length) out.push(el('div', { class: 'card', id: 'lastCard' }, el('h2', {}, 'Ya terminaron'), last.map((f) => { const r = L.finalScore(ST.view.validApproved[f.id]); return el('div', { class: 'row' }, el('div', { class: 'team' }, L.title(ST, f)), el('div', { class: 'score' }, `${r.hg} – ${r.ag}`)); })));
    return out;
  },
  horario() {
    const s = ST.state, out = [];
    const pitches = [...new Set(Object.values(s.fixtures).map((f) => f.pitch).filter(Boolean))].sort();
    const date = (s.tournament && s.tournament.date) || '';
    if (SCHED && s.fixtures[SCHED.id]) {
      const f = s.fixtures[SCHED.id], times = [];
      for (let m = 7 * 60; m <= 21 * 60; m += 30) times.push(String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
      const curT = SCHED.time || (f.kickoff ? f.kickoff.slice(11, 16) : '09:00'), curP = SCHED.pitch || f.pitch || pitches[0] || 'Cancha 1';
      if (!times.includes(curT)) times.push(curT); times.sort();
      const fdate = (f.kickoff ? f.kickoff.slice(0, 10) : date);
      // the referee follows the pitch: the referee of the other games on the target pitch is part of the SAME validated move
      const cnt = {}; for (const g of Object.values(s.fixtures)) if (g.pitch === curP && g.refereeId && g.id !== SCHED.id && !(s.withdrawn && (s.withdrawn[g.home] || s.withdrawn[g.away]))) cnt[g.refereeId] = (cnt[g.refereeId] || 0) + 1;
      const bestRef = Object.entries(cnt).sort((x, y) => y[1] - x[1])[0], targetRef = f.pitch !== curP && bestRef ? bestRef[0] : f.refereeId;
      const conf = L.scheduleConflicts(ST, SCHED.id, fdate + 'T' + curT, curP, targetRef); // live: impossible moves cannot be saved (the engine refuses them too)
      const firstK = Math.min(...Object.values(s.fixtures).filter((g) => g.kickoff && g.id !== SCHED.id).map((g) => Number(g.kickoff.slice(11, 13)) * 60 + Number(g.kickoff.slice(14, 16))), 24 * 60);
      const lastK = Math.max(...Object.values(s.fixtures).filter((g) => g.kickoff && g.id !== SCHED.id).map((g) => Number(g.kickoff.slice(11, 13)) * 60 + Number(g.kickoff.slice(14, 16))), 0);
      const mm = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      const inWin = (t) => mm(t) >= firstK && mm(t) <= lastK + 120; // the tournament window (from the first kick-off to two hours after the last one starts)
      const groupFree = (list) => { const g = [['Antes del primer partido', list.filter((t) => mm(t) < firstK)], ['Durante el torneo', list.filter((t) => mm(t) >= firstK && mm(t) <= lastK)], ['Después del último partido', list.filter((t) => mm(t) > lastK)]].filter(([, l]) => l.length);
        return g.flatMap(([title, l]) => [el('div', { class: 'meta fgTitle' }, title), chips('st' + (title.startsWith('Antes') ? '' : title.startsWith('Durante') ? '-d' : '-a'), l.map((t) => [t, L.t12(t)]), curT, (v) => { SCHED.time = v; render(); }, title)]); };
      const swapList = () => el('div', { class: 'swapList', id: 'swapList' }, el('p', { class: 'meta' }, 'Toca el partido con el que quieres cambiar de lugar. Solo salen los que sí se pueden cambiar sin que un equipo, una cancha o un árbitro se empalme.'),
        ...Object.values(s.fixtures).filter((g) => g.id !== SCHED.id && g.kickoff && !ST.view.validApproved[g.id] && !L.isCancelled(s, g) && !(s.reports[g.id] || []).length).sort((x, y) => x.kickoff.localeCompare(y.kickoff) || (x.pitch || '').localeCompare(y.pitch || '')).filter((g) => !L.swapProblems(ST, SCHED.id, g.id).length).map((g) => el('button', { class: 'sched', 'data-swap': g.id, onclick: () => { const pair = { a: SCHED.id, b: g.id }; act(async () => { const r = await ev('FIXTURES_SWAPPED', pair); pair.undoSeq = r.seq; /* R7-06: the banner undo is THIS swap's targeted inverse, validated by the engine */ SCHED = null; }, 'Listo: los dos partidos cambiaron de lugar.').then(() => { if (NOTE && NOTE.kind === 'ok') { NOTE.undo = pair; render(); } }); } }, el('span', { class: 'st' }, L.title(ST, g)), el('span', { class: 'sm' }, `${L.t12(g.kickoff)} · ${g.pitch || ''}`))));
      const move = () => act(async () => {
        const kickoff = fdate + 'T' + curT, pitch = curP;
        await ev('FIXTURE_SCHEDULED', { fixtureId: SCHED.id, kickoff, pitch, ...(targetRef && targetRef !== f.refereeId ? { refereeId: targetRef } : {}) }); SCHED = null;
      }, 'Horario guardado.');
      const busy = L.busyTimes(ST, SCHED.id, fdate, times, curP, targetRef); busy.delete(curT); const free = times.filter((t) => !busy.has(t)); const freeIn = free.filter((t) => mm(t) >= firstK && mm(t) <= lastK + 120);
      const other = (c) => { const g = ST.state.fixtures[c.other]; return g ? ` (${L.title(ST, g)}, ${g.kickoff ? L.t12(g.kickoff) : ''})` : ''; };
      const why = (c) => c.kind === 'equipo' ? `${c.team} ya juega a esa hora${other(c)}.` : c.kind === 'cancelado' ? 'Este partido se canceló porque un equipo se retiró: no se puede mover.' : c.kind === 'arbitro' ? 'El árbitro de esa cancha ya tiene otro partido a esa hora.' : c.kind === 'orden' ? (c.text === 'antes' ? 'Debe jugarse después de los partidos que lo alimentan.' : 'Otro partido depende de este y quedaría a la misma hora o antes.') : `La ${c.pitch} ya está ocupada a esa hora${other(c)}.`;
      const reasons = [...new Set(conf.map(why))];
      out.push(el('div', { class: 'card qcard', id: 'moveForm' }, el('h2', {}, L.title(ST, f)), el('div', { class: 'pad' },
        el('div', { class: 'cur' }, `${L.t12(curT)} · ${curP}`),
        el('div', { class: 'step' }, 'Cambiar el orden'),
        el('p', { class: 'meta' }, 'Lo más fácil cuando todo está lleno: cambia de lugar con otro partido (se cambian la hora y la cancha).'),
        el('button', { class: 'btn', id: 'swapOpen', onclick: () => { SCHED.swap = !SCHED.swap; render(); } }, SCHED.swap ? 'Ocultar la lista' : 'Intercambiar con otro partido'),
        ...(SCHED.swap ? [swapList()] : []),
        el('div', { class: 'step' }, 'O mover a una hora libre'),
        chips('sp', (pitches.includes(curP) ? pitches : pitches.concat(curP)).map((t) => [t, t]), curP, (v) => { SCHED.pitch = v; SCHED.time = null; render(); }, 'Cancha'),
        ...(free.length ? groupFree(free) : [el('div', { class: 'banner warn', id: 'noFree' }, 'Esta cancha no tiene horas libres. Prueba con otra cancha o intercambia con otro partido.')]),
        ...(reasons.length ? [el('div', { class: 'banner warn', id: 'conflictBox', 'data-conflict': conf[0].kind }, reasons.length === 1 ? reasons[0] : el('ul', { class: 'reasons' }, reasons.map((r) => el('li', {}, r))))] : []),
        conf.length ? el('p', { class: 'meta', id: 'noSave' }, 'Elige otra hora u otra cancha para poder guardar.') : null,
        el('button', { class: 'btn big', id: 'saveMove', ...(conf.length ? { disabled: 'disabled' } : {}), onclick: move }, 'Guardar cambio'),
        el('button', { class: 'btn sec', id: 'closeMove', onclick: () => { SCHED = null; render(); } }, 'Cancelar'))));
    }
    for (const { time, items } of L.scheduleBySlot(s)) {
      out.push(el('h3', { class: 'slotH' }, time === 'Sin hora' ? time : L.t12(time)), ...items.map((f) => { const done = !!ST.view.validApproved[f.id];
        return el('button', { class: 'sched' + (SCHED && SCHED.id === f.id ? ' sel' : '') + (done ? ' played' : ''), 'data-sched-open': f.id, 'data-sched': f.id, ...(done ? { disabled: 'disabled', 'aria-disabled': 'true' } : {}), onclick: () => { SCHED = { id: f.id }; render(); window.scrollTo(0, 0); } },
          el('span', { class: 'st' }, L.title(ST, f)), el('span', { class: 'sm' }, [f.pitch || 'sin cancha', L.isCancelled(s, f) ? 'cancelado (equipo retirado)' : done ? 'ya se jugó' : '›'].filter(Boolean).join(' · '))); }));
    }
    if (!Object.keys(s.fixtures).length) out.unshift(TABS.planCard());
    const active = Object.values(s.teams).filter((t) => !(s.withdrawn && s.withdrawn[t.id]));
    if (active.length && Object.keys(s.fixtures).length) out.push(el('div', { class: 'card', id: 'withdrawCard' }, el('h2', {}, 'Si un equipo se retira'), el('div', { class: 'pad' },
      el('p', { class: 'meta' }, 'Sale de la tabla y sus partidos ya no cuentan. Si fue un error, se puede deshacer en «Armar → Respaldo».'),
      el('label', { for: 'wdTeam' }, 'Equipo'), el('select', { id: 'wdTeam' }, active.map((t) => el('option', { value: t.id }, t.name))),
      el('button', { class: 'btn sec', id: 'withdraw', onclick: () => { const id = document.getElementById('wdTeam').value; if (!window.confirm('¿Retirar a ' + (s.teams[id] || {}).name + ' del torneo?')) return; act(() => ev('TEAM_WITHDRAWN', { teamId: id }), 'Equipo retirado. Ya no sale en la tabla.'); } }, 'Retirar este equipo'))));
    const gone = Object.keys(s.withdrawn || {}); if (gone.length) out.push(el('p', { class: 'meta pad', id: 'withdrawnList' }, 'Retirados: ' + gone.map((id) => (s.teams[id] || {}).name || id).join(', ')));
    return out;
  },
  armar() {
    const s = ST.state, out = [];
    out.push(card('1 · Torneo', s.tournament ? el('p', {}, s.tournament.name + (s.tournament.date ? ' · ' + s.tournament.date : '')) : el('p', { class: 'meta' }, 'Sin nombre todavía.'),
      ...field('tn', 'Nombre del torneo', { value: s.tournament ? s.tournament.name : '' }), ...field('td', 'Fecha', { type: 'date', value: s.tournament && s.tournament.date ? s.tournament.date : '' }),
      el('button', { class: 'btn', id: 'saveT', onclick: () => act(() => ev('TOURNAMENT_SET', { name: val('tn'), ...(val('td') ? { date: val('td') } : {}) }), 'Torneo guardado.') }, 'Guardar torneo')));
    const r = s.rules;
    out.push(card('2 · Reglas', el('p', {}, r && r.points ? `Victoria ${r.points.win} · Empate ${r.points.draw} · Derrota ${r.points.loss}. Desempate: ${r.tiebreak.map((c) => TB_ES[c] || c).join(' → ')}. Eliminatoria: ${({ ET_THEN_PENS: 'prórroga y penales', PENS: 'penales directos', PENDIENTE: 'pendiente' })[r.koLevel]}. Clasifican ${r.qualifiersPerGroup} por grupo.${r.walkoverGoals ? ` W.O.: ${r.walkoverGoals}-0.` : ''}` : 'Reglas pendientes: la tabla no ordena hasta confirmarlas.'),
      r && r.preset && PRESETS && PRESETS[r.preset] ? el('div', { class: 'banner warn', id: 'presetLabel' }, `Reglamento: ${PRESETS[r.preset].label}. Valores provisionales hasta que se confirmen para este torneo.`) : null,
      el('button', { class: 'btn', id: 'uefa', onclick: () => act(() => ev('RULES_SET', { points: { win: 3, draw: 1, loss: 0 }, tiebreak: ['h2h_points', 'h2h_gd', 'h2h_gf', 'gd', 'gf', 'PENDIENTE'], koLevel: 'PENS', qualifiersPerGroup: 2 }), 'Reglas confirmadas.') }, 'Usar reglas estilo UEFA (3-1-0, penales directos, 2 clasifican)'),
      el('button', { class: 'btn sec', id: 'cup', onclick: () => act(async () => { const P = await loadPresets(); await ev('RULES_SET', P.DEMO_REGLAS.rules); }, 'Reglas de ejemplo aplicadas.') }, 'Usar las reglas de ejemplo'),
      el('p', { class: 'meta' }, 'Si un empate no se resuelve con estas reglas, la posición queda compartida y marcada — nunca se decide sola.')));
    const teams = Object.values(s.teams);
    out.push(card('3 · Equipos (' + teams.length + ')', teams.length ? el('div', {}, groupsOf(s).map((g) => el('p', {}, el('b', {}, 'Grupo ' + g + ': '), teams.filter((t) => t.groupId === g).map((t) => t.name).join(', ')))) : el('p', { class: 'meta' }, 'Aún no hay equipos.'),
      ...field('tm', 'Nombre del equipo', {}), ...field('tg', 'Grupo (A, B…)', { maxlength: '2', value: 'A' }),
      el('button', { class: 'btn', id: 'addTeam', onclick: () => act(() => ev('TEAM_ADDED', { id: rid('t'), name: val('tm'), groupId: val('tg').toUpperCase() }), 'Equipo agregado.') }, 'Agregar equipo')));
    const fx = Object.values(s.fixtures);
    const gfx = fx.filter((f) => f.stage === 'group'), kfx = fx.filter((f) => f.stage === 'ko');
    out.push(card('4 · Partidos de grupo (' + gfx.length + ')', ...field('ref', 'Árbitro asignado (código de árbitro)', { value: 'ref1' }),
      el('button', { class: 'btn', id: 'genGroup', onclick: () => act(async () => {
        const have = new Set(gfx.map((f) => [f.home, f.away].sort().join('|')));
        for (const g of groupsOf(s)) { const ids = teams.filter((t) => t.groupId === g).map((t) => t.id);
          for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (!have.has([ids[i], ids[j]].sort().join('|')))
            await ev('FIXTURE_ADDED', { id: rid('f'), stage: 'group', groupId: g, home: ids[i], away: ids[j], refereeId: val('ref') }); }
        await ev('FORMAT_SET', { rounds: 1 });
      }, 'Partidos creados.') }, 'Crear todos contra todos'),
      el('button', { class: 'btn sec', id: 'genGroup2', onclick: () => act(async () => { // D205 O1: "todos contra todos a 2 rondas" (ida y vuelta)
        const have = new Set(gfx.map((f) => f.home + '>' + f.away));
        for (const g of groupsOf(s)) { const ids = teams.filter((t) => t.groupId === g).map((t) => t.id);
          for (let i = 0; i < ids.length; i++) for (let j = 0; j < ids.length; j++) if (i !== j && !have.has(ids[i] + '>' + ids[j]))
            await ev('FIXTURE_ADDED', { id: rid('f'), stage: 'group', groupId: g, home: ids[i], away: ids[j], refereeId: val('ref') }); }
        await ev('FORMAT_SET', { rounds: 2 });
      }, 'Partidos de ida y vuelta creados.') }, 'Crear ida y vuelta (2 rondas)'),
      gfx.length ? el('p', { class: 'meta' }, gfx.map((f) => `${tname(f.home)} vs ${tname(f.away)}`).join(' · ')) : null));
    const allFx = Object.values(s.fixtures);
    if (allFx.length) out.push(card('6 · Programación (fecha, hora y cancha)',
      el('label', { for: 'sf' }, 'Partido'), el('select', { id: 'sf' }, allFx.map((f) => el('option', { value: f.id }, fxLabel(s, f)))),
      ...field('sk', 'Fecha y hora', { type: 'datetime-local' }), ...field('sp', 'Cancha / sede', {}),
      el('button', { class: 'btn', id: 'saveSch', onclick: () => act(() => ev('FIXTURE_SCHEDULED', { fixtureId: val('sf'), ...(val('sk') ? { kickoff: val('sk').slice(0, 16) } : {}), ...(val('sp') ? { pitch: val('sp') } : {}) }), 'Horario guardado (queda en el historial).') }, 'Guardar horario'),
      el('div', { id: 'schedule' }, allFx.filter((f) => f.kickoff || f.pitch).map((f) => el('p', { class: 'meta', 'data-sched': f.id }, `${fxLabel(s, f)} · ${f.kickoff ? dayShort(f.kickoff) + ' ' + L.t12(f.kickoff) : 'sin hora'} · ${f.pitch || 'sin cancha'}`)))));
    const gs = groupsOf(s);
    out.push(card('5 · Eliminatorias (' + kfx.length + ')', kfx.length ? el('p', { class: 'meta' }, kfx.map((f) => `${f.round}: ${srcLabel(f.homeSource)} vs ${srcLabel(f.awaySource)}`).join(' · ')) : null,
      gs.length === 1 || gs.length === 2 ? el('button', { class: 'btn', id: 'genKo', disabled: kfx.length ? 'disabled' : null, onclick: () => act(async () => {
        const ref = val('ref') || undefined;
        if (gs.length === 1) await ev('FIXTURE_ADDED', { id: 'F', stage: 'ko', round: 'Final', order: 1, homeSource: '1' + gs[0], awaySource: '2' + gs[0], refereeId: ref });
        else { const [a, b] = gs;
          await ev('FIXTURE_ADDED', { id: 'SF1', stage: 'ko', round: 'Semifinal', order: 1, homeSource: '1' + a, awaySource: '2' + b, refereeId: ref });
          await ev('FIXTURE_ADDED', { id: 'SF2', stage: 'ko', round: 'Semifinal', order: 2, homeSource: '1' + b, awaySource: '2' + a, refereeId: ref });
          await ev('FIXTURE_ADDED', { id: 'F', stage: 'ko', round: 'Final', order: 3, homeSource: 'W:SF1', awaySource: 'W:SF2', refereeId: ref }); }
      }, 'Eliminatorias creadas.') }, gs.length === 1 ? 'Crear final (1º vs 2º)' : 'Crear semifinales cruzadas y final')
        : el('p', { class: 'meta' }, gs.length ? 'Este formato de grupos aún no tiene eliminatoria automática.' : 'Primero agrega equipos con grupo.')));
    const on = !!(s.publicNames && s.publicNames.adults);
    out.push(card('7 · Nombres en la página de las familias', el('p', {}, on ? 'Ahora los goleadores adultos aparecen con su nombre. Los menores de edad siempre aparecen como «#número · equipo».' : 'Ahora todos los goleadores aparecen como «#número · equipo». Si quieres que los adultos salgan con su nombre, actívalo aquí (si hay exoneración, solo salen quienes la firmaron).'),
      el('button', { class: 'btn' + (on ? ' sec' : ''), id: 'toggleNames', onclick: () => act(() => ev('NAMES_PUBLIC_SET', { adults: !on }), on ? 'Listo: ya nadie sale con nombre.' : 'Listo: los adultos salen con su nombre.') }, on ? 'Ocultar nombres' : 'Mostrar nombres de adultos')));
    return out;
  },
  jugadores() {
    const s = ST.state, out = [];
    const w = s.waiver;
    out.push(card('Exoneración (antes de jugar)', el('p', {}, w ? `Publicada: versión ${w.version}.` : 'Aún no publicada: nadie tiene que firmar todavía.'),
      el('label', { for: 'wt' }, w ? 'Nueva versión del texto (todos tendrán que firmar de nuevo)' : 'Texto de la exoneración'),
      el('textarea', { id: 'wt', rows: '5', class: 'area' }, w ? w.text : 'Declaro que el jugador participa voluntariamente en este torneo sintético de prueba, que conoce los riesgos propios del fútbol y que acepta las reglas del torneo.'),
      el('button', { class: 'btn', id: 'pubW', onclick: () => act(() => ev('WAIVER_PUBLISHED', { version: w ? w.version + 1 : 1, text: document.getElementById('wt').value.trim() }), 'Exoneración publicada.') }, w ? 'Publicar nueva versión' : 'Publicar exoneración')));
    const teams = Object.values(s.teams);
    if (teams.length) out.push(card('Pegar plantel (una línea por jugador)',
      el('label', { for: 'rt' }, 'Equipo'), el('select', { id: 'rt' }, teams.map((t) => el('option', { value: t.id }, t.name))),
      el('label', { for: 'roster' }, 'Formato: dorsal, nombre  ·  agrega «, menor» si es menor de edad'),
      el('textarea', { id: 'roster', rows: '6', class: 'area', placeholder: '9, Nombre Apellido\n10, Otro Nombre, menor' }),
      el('button', { class: 'btn', id: 'pasteR', onclick: () => act(async () => {
        const teamId = val('rt'), taken = new Set(Object.values(s.players).filter((p) => p.teamId === teamId).map((p) => p.number));
        const lines = document.getElementById('roster').value.split('\n').map((l) => l.trim()).filter(Boolean);
        if (!lines.length) throw new Error('pega al menos una línea');
        const rows = lines.map((l, i) => { const m = /^(\d{1,2})\s*,\s*([^,]{1,60}?)\s*(?:,\s*(menor))?$/i.exec(l);
          if (!m) throw new Error(`línea ${i + 1}: usa «dorsal, nombre» o «dorsal, nombre, menor»`);
          const number = Number(m[1]); if (taken.has(number)) throw new Error(`línea ${i + 1}: el dorsal ${number} ya existe en este equipo`); taken.add(number);
          return { number, displayName: m[2], isMinor: !!m[3] }; });
        for (const r of rows) await ev('PLAYER_ADDED', { id: rid('p'), teamId, ...r }); // all lines validated BEFORE anything is sent
        document.getElementById('roster').value = '';
      }, 'Plantel agregado.') }, 'Agregar plantel')));
    out.push(card('Agregar jugador', teams.length ? el('div', {},
      el('label', { for: 'pt' }, 'Equipo'), el('select', { id: 'pt' }, teams.map((t) => el('option', { value: t.id }, t.name))),
      ...field('pn', 'Nombre', {}), ...field('pnum', 'Número', { type: 'number', min: '0', max: '99', inputmode: 'numeric' }),
      el('label', {}, el('input', { type: 'checkbox', id: 'pmin', class: 'chk' }), 'Es menor de edad'),
      ...field('pc', 'Contacto del tutor (privado, nunca se publica)', {}),
      el('button', { class: 'btn', id: 'addP', onclick: () => act(() => ev('PLAYER_ADDED', { id: rid('p'), teamId: val('pt'), displayName: val('pn'), number: Number(val('pnum')), isMinor: document.getElementById('pmin').checked, ...(val('pc') ? { guardianContact: val('pc') } : {}) }), 'Jugador agregado.') }, 'Agregar jugador'))
      : el('p', { class: 'meta' }, 'Primero agrega equipos.')));
    for (const p of Object.values(s.players)) {
      const signed = !w || (s.waivers[p.id] || []).some((x) => x.version === w.version && x.textHash === w.textHash);
      const c = s.consents[p.id];
      const cTxt = !c || !c.active ? 'sin permiso de nombre/imagen' : c.verifiedSeq ? `permiso verificado (${c.scope.join(', ')})` : `permiso dado (${c.scope.join(', ')}) · falta verificar en persona`;
      const kids = [el('p', { 'data-player': p.id }, `${p.isMinor ? 'Menor' : 'Adulto'} · exoneración: ${!w ? 'no publicada' : signed ? 'firmada' : 'FALTA'} · ${cTxt}`)];
      if (LINKS[p.id]) kids.push(el('label', {}, 'Enlace de firma (entrégalo en persona; la app no envía nada)'), el('input', { readonly: 'readonly', value: LINKS[p.id], 'data-link': p.id }));
      else kids.push(el('button', { class: 'btn sec', 'data-mklink': p.id, onclick: () => act(async () => { const r = await call('POST', '/api/org/enlace', { playerId: p.id }); LINKS[p.id] = location.origin + r.url; }, 'Enlace creado: se muestra una sola vez.') }, 'Crear enlace de firma'));
      if (c && c.active && !c.verifiedSeq) kids.push(el('button', { class: 'btn', 'data-verify': p.id, onclick: () => act(() => ev('CONSENT_VERIFIED', { playerId: p.id, method: 'firma_tutor_verificada', consentSeq: c.grantSeq }), 'Permiso verificado.') }, 'Verifiqué en persona la firma del ' + (p.isMinor ? 'tutor' : 'jugador')));
      if (c && c.active) kids.push(el('button', { class: 'btn sec', 'data-revoke': p.id, onclick: () => act(() => ev('MEDIA_CONSENT_REVOKED', { playerId: p.id }), 'Permiso retirado.') }, 'Retirar permiso'));
      out.push(card(`#${p.number} ${p.displayName} · ${(s.teams[p.teamId] || {}).name || ''}`, ...kids));
    }
    return out;
  },
  resultados() {
    const s = ST.state, out = [];
    const fx = Object.values(s.fixtures);
    for (const f of fx) {
      const reps = s.reports[f.id] || [], ap = ST.view.validApproved[f.id] || null;
      if (!ap && !reps.length && !(f.stage === 'ko' && ST.view.bracketById && false)) { const bb = f.stage === 'ko' ? ST.view.bracket.find((x) => x.id === f.id) : null; if (!(bb && bb.invalidated)) continue; } // only matches that have something to look at
      const kids0 = [];
      const b = f.stage === 'ko' ? ST.view.bracket.find((x) => x.id === f.id) : null;
      const title = f.stage === 'group' ? `${tname(f.home)} vs ${tname(f.away)}` : `${f.round}: ${b.home.teamId ? tname(b.home.teamId) : srcLabel(f.homeSource)} vs ${b.away.teamId ? tname(b.away.teamId) : srcLabel(f.awaySource)}`;
      const latest = reps[reps.length - 1];
      const cur = f.stage === 'group' ? { home: f.home, away: f.away } : { home: b.home.teamId, away: b.away.teamId };
      const vd = ST.state.voided[f.id];
      const stale = (r) => !r.participants || r.participants.home !== cur.home || r.participants.away !== cur.away || (vd && r.version < vd.voidedSeq) || (b && b.invalidated && ST.state.approved[f.id] && ST.state.approved[f.id].version === r.version);
      // only the newest report can be approved, and never one played by other teams or voided by a rule change (W1R-03)
      const pending = latest && (!ap || latest.version > ap.version) && !stale(latest) ? [latest] : [];
      if (latest && stale(latest) && b && b.invalidated) kids0.push(el('p', { class: 'meta', 'data-voided': f.id }, 'Reporte anterior ' + scoreText(latest) + ' (histórico, ya no vale: ' + b.invalidated + ').'));
      const kids = [el('p', {}, ap ? 'Aprobado: ' + scoreText(ap) : b && b.invalidated ? 'Resultado anulado (' + b.invalidated + '): hay que volver a anotarlo.' : 'Sin resultado aprobado.'), ...kids0];
      { const n = refNote(ap, f.id); if (n) kids.push(n); } // R111: the note of the approved result stays visible to the organizer
      for (const r of pending) {
        kids.push(el('div', { class: 'row', 'data-pending': f.id }, el('div', { class: 'team' }, 'Reporte ' + scoreText(r) + ' · por ' + r.by.role)));
        { const n = refNote(r, f.id); if (n) kids.push(n); }
        if (ap) kids.push(...field('why' + r.version, 'Motivo de la corrección', {}));
        kids.push(el('button', { class: 'btn', 'data-approve': f.id, ...approveAttr(), onclick: () => approveOnce(() => ({ fixtureId: f.id, version: r.version, ...(ap ? { reason: val('why' + r.version) } : {}) }), ap ? 'Corrección aprobada.' : 'Resultado aprobado.') }, ap ? 'Aprobar corrección' : 'Aprobar resultado'));
      }
      const canEnter = f.stage === 'group' || (b.home.teamId && b.away.teamId);
      if ((ap || (b && b.invalidated)) && !pending.length && canEnter) {
        kids.push(el('details', { open: b && b.invalidated && !ap ? 'open' : null }, el('summary', { class: 'meta' }, ap ? 'Corregir este resultado' : 'Anotar el resultado de nuevo'),
          ...field('ch' + f.id, 'Goles local', { type: 'number', min: '0', max: '99', inputmode: 'numeric' }), ...field('ca' + f.id, 'Goles visitante', { type: 'number', min: '0', max: '99', inputmode: 'numeric' }),
          ...(f.stage === 'ko' ? [...field('ceh' + f.id, 'Prórroga local (si hubo)', { type: 'number', min: '0', inputmode: 'numeric' }), ...field('cea' + f.id, 'Prórroga visitante (si hubo)', { type: 'number', min: '0', inputmode: 'numeric' }),
            ...field('cph' + f.id, 'Penales local (si hubo)', { type: 'number', min: '0', inputmode: 'numeric' }), ...field('cpa' + f.id, 'Penales visitante (si hubo)', { type: 'number', min: '0', inputmode: 'numeric' })] : []),
          el('button', { class: 'btn sec', 'data-correct': f.id, onclick: () => act(() => {
            const report = { hg: Number(val('ch' + f.id)), ag: Number(val('ca' + f.id)) };
            if (f.stage === 'ko' && val('ceh' + f.id) !== '') report.et = { hg: Number(val('ceh' + f.id)), ag: Number(val('cea' + f.id)) };
            if (f.stage === 'ko' && val('cph' + f.id) !== '') report.pens = { hg: Number(val('cph' + f.id)), ag: Number(val('cpa' + f.id)) };
            return call('POST', '/api/org/report', { fixtureId: f.id, report, participants: { home: cur.home, away: cur.away } });
          }, 'Corrección anotada: ahora apruébala con un motivo.') }, 'Anotar corrección')));
      }
      out.push(card(title, ...kids));
    }
    if (!out.length) out.push(card('Resultados', el('p', { class: 'meta' }, Object.keys(s.fixtures).length ? 'Todavía no hay resultados. Cuando apruebes uno, aparece aquí para poder corregirlo.' : 'No hay partidos todavía.')));
    return out;
  },
  historial() {
    const a = ST.state.audit.slice().reverse();
    // D205 R1-P1-3: a VOIDED row shows WHICH report version and WHAT event caused it.
    const TRIGGER_ES = { RULES_SET: 'cambio de reglas', REPORT_APPROVED: 'una corrección aprobada', FIXTURE_ADDED: 'un partido agregado', ROLLBACK: 'un deshacer o una restauración (no revive lo anulado)' };
    const LBL = { WAIVER_PUBLISHED: 'Exoneración publicada', SIGN_LINK_ISSUED: 'Enlace de firma creado', WAIVER_SIGNED: 'Exoneración firmada', MEDIA_CONSENT_GRANTED: 'Permiso dado', CONSENT_VERIFIED: 'Permiso verificado en persona', MEDIA_CONSENT_REVOKED: 'Permiso retirado' };
    // R3-B-03: the subject snapshot from the audit row itself, never the current player map (a rollback may have removed the player).
    const pname = (x) => (x.subject ? `#${x.subject.number} ${x.subject.displayName} · ${x.subject.teamName || ''}` : x.playerId || '');
    const mname = (fid) => (ST.state.fixtures[fid] ? fxLabel(ST.state, ST.state.fixtures[fid]) : 'partido ' + fid); // D205 O1: name the match, never a raw id
    const line = (x) => LBL[x.action]
      ? `#${x.seq} · ${fmtTime(x.ts)} · ${LBL[x.action]}${x.playerId ? ' · ' + pname(x) : ''}${x.detail.version ? ' · v' + x.detail.version : ''}${x.detail.scope ? ' · ' + x.detail.scope.join(', ') : ''}${x.detail.signerName ? ' · firmó ' + x.detail.signerName + ' (' + x.detail.relation + ')' : ''}${x.detail.consentSeq ? ' · permiso #' + x.detail.consentSeq : ''}${x.detail.revokesGrantSeq ? ' · retira el permiso #' + x.detail.revokesGrantSeq : ''} · ${x.by.role}` + (x.active ? '' : ' · (anulado por un deshacer)')
      : x.action === 'ROLLBACK'
      ? `#${x.seq} · ${fmtTime(x.ts)} · Deshacer: volver al evento #${x.toSeq} · Motivo: ${x.reason} · ${x.by.role}` + (x.voided.length ? ` · anuló #${x.voided.join(', #')}` : '') + (x.restored.length ? ` · recuperó #${x.restored.join(', #')}` : '')
      : x.action === 'SCHEDULED'
      ? `#${x.seq} · ${fmtTime(x.ts)} · Horario · ${mname(x.fixtureId)} · ${x.from.kickoff ? dayShort(x.from.kickoff) + ' ' + L.t12(x.from.kickoff) : 'sin hora'} / ${x.from.pitch || 'sin cancha'} → ${x.to.kickoff ? dayShort(x.to.kickoff) + ' ' + L.t12(x.to.kickoff) : 'sin hora'} / ${x.to.pitch || 'sin cancha'} · ${x.by.role}` + (x.active ? '' : ' · (anulado por un deshacer)')
      : x.action === 'SWAPPED'
      ? (() => { const f = (z) => `${z.kickoff ? L.t12(z.kickoff) : 'sin hora'} / ${z.pitch || 'sin cancha'}${z.refereeId ? ' / árbitro ' + z.refereeId : ''}`; return `#${x.seq} · ${fmtTime(x.ts)} · ${x.undoOf ? 'Cambio deshecho (del #' + x.undoOf + ')' : 'Cambio de lugar'} · ${mname(x.a.id)}: ${f(x.a.from)} → ${f(x.a.to)} · ${mname(x.b.id)}: ${f(x.b.from)} → ${f(x.b.to)} · ${x.by.role}` + (x.active ? '' : ' · (anulado por un deshacer)'); })()
      : x.action === 'VOIDED'
      ? `#${x.seq} · ${fmtTime(x.ts)} · Resultado anulado · ${mname(x.fixtureId)} · reporte v${x.version} · aprobación #${x.approvedSeq} · Causa: ${x.cause} · Lo provocó: ${TRIGGER_ES[x.trigger] || x.trigger}` + (x.active ? '' : ' · (anulado por un deshacer)')
      : `#${x.seq} · ${fmtTime(x.ts)} · ${x.action === 'CORRECTED' ? 'Corregido' : 'Aprobado'} · ${mname(x.fixtureId)} · ${x.from ? x.from.hg + '-' + x.from.ag + ' → ' : ''}${x.to.hg}-${x.to.ag}${x.reason ? ' · Motivo: ' + x.reason : ''} · ${x.by.role}`
        + (!x.active ? ' · (anulado por un deshacer)' : x.standing ? ' · vigente' : ' · ya no cuenta (reemplazado o anulado)');
    return [card('Historial (resultados, firmas, permisos, deshacer)', a.length ? a.map((x) => el('p', { 'data-audit': x.action, 'data-active': String(x.active !== false), ...(x.standing !== undefined ? { 'data-standing': String(x.standing) } : {}), ...(x.action === 'VOIDED' ? { 'data-trigger': x.trigger, 'data-version': String(x.version) } : {}) }, line(x),
        // R6-04: undo THIS swap only (the engine refuses if either match has since been reported, played or moved); never a whole-day rollback
        x.action === 'SWAPPED' && x.active && !x.undoOf && !a.some((y) => y.action === 'SWAPPED' && y.undoOf === x.seq && y.active) ? el('button', { class: 'btn sec inline', 'data-undo-swap': String(x.seq), onclick: () => act(() => ev('FIXTURES_SWAPPED', { a: x.a.id, b: x.b.id, undoSeq: x.seq }), 'Listo: los dos partidos volvieron a su lugar.') }, 'Deshacer solo este cambio') : null)) : el('p', { class: 'meta' }, 'Sin cambios todavía.')),
      card('Registro protegido', el('p', { id: 'chain' }, ST.chain.ok ? `Todo en orden · ${ST.chain.length} anotaciones guardadas` : 'Hay un problema con el registro. No apruebes más resultados y avisa a quien organiza el torneo.'))];
  },
  respaldo() {
    return [card('Descargar respaldo', el('p', { class: 'meta' }, 'Guarda una copia de todo el torneo en tu teléfono, por si algo sale mal.'),
      el('button', { class: 'btn', id: 'export', onclick: async () => { const r = await fetch('/api/org/export', { headers: { authorization: 'Bearer ' + TOKEN } }); const blob = await r.blob(); const a = el('a', { href: URL.createObjectURL(blob), download: 'torneo-respaldo.json' }); a.click(); } }, 'Descargar respaldo')),
      card('Restaurar respaldo', el('p', { class: 'meta' }, 'Vuelve a una copia guardada de ESTE torneo. Se revisa que sea auténtica y queda anotado en el historial. Una copia de otro torneo no se acepta.'),
        el('input', { type: 'file', id: 'file', accept: 'application/json' }),
        el('button', { class: 'btn sec', id: 'import', onclick: () => act(async () => { const f = document.getElementById('file').files[0]; if (!f) throw new Error('elige un archivo'); await call('POST', '/api/org/import', JSON.parse(await f.text())); }, 'Respaldo verificado y restaurado (queda anotado en el historial).') }, 'Restaurar')),
      card('Deshacer', el('p', { class: 'meta' }, 'Vuelve a como estaba el torneo antes de un cambio. Nada se borra: queda anotado en el historial.'),
        ...field('to', 'Volver a como estaba después del cambio número', { type: 'number', min: '0', inputmode: 'numeric', value: String(Math.max(0, ST.seq - 1)) }), ...field('rwhy', 'Motivo', {}),
        el('button', { class: 'btn sec', id: 'rollback', onclick: async () => { // R8-02: the impact is computed by the SERVER from the real event graph (setup, results, schedule, permissions), then the organizer confirms with the head he saw
        const to = Number(val('to')), why = val('rwhy'); let imp; try { imp = await call('POST', '/api/org/rollback/preview', { toSeq: to }); } catch (e) { note('bad', 'No se pudo calcular qué se deshace: ' + e.message); return render(); }
        const describe = (items, summary) => (summary.map((x) => x.text).join(', ') || 'nada') + '\n' + items.map((x) => '• ' + x.label).join('\n');
        const returns = imp.restoring.some((x) => ['setup', 'result', 'consent'].includes(x.kind)), kept = imp.revocationsKept ? `\n\n⚠ ${imp.revocationsKept === 1 ? '1 permiso retirado sigue retirado' : imp.revocationsKept + ' permisos retirados siguen retirados'}: deshacer no los devuelve. Hace falta un permiso nuevo de la familia.` : '';
        const msg = `Esto vuelve TODO el torneo al evento #${to}. SE DESACTIVA: ${describe(imp.leaving, imp.summary)}\n\nVUELVE: ${describe(imp.restoring, imp.restoringSummary)}${imp.deletesSetup ? '\n\n⚠ Se desactiva parte del montaje del torneo.' : ''}${returns ? '\n\n⚠ Vuelven equipos, partidos, reglas, resultados o permisos y firmas indicados arriba.' : ''}${kept}\n\nPara deshacer solo un cambio de lugar usa el botón de ese cambio en Historial. ¿Seguro?`;
        if ((!imp.leaving.length && !imp.restoring.length) || !window.confirm(msg)) return;
        act(() => call('POST', '/api/org/rollback', { toSeq: to, reason: why, expectSeq: imp.head }), 'Deshecho.'); } }, 'Deshacer'))];
  },
};
const shiftT = (t, d) => { const m = Math.max(7 * 60, Math.min(21 * 60, Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + d)); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
function centerChips() { document.querySelectorAll('.chips.scroll').forEach((c) => { const a = c.querySelector('[aria-checked=true]'); if (a) c.scrollLeft = a.offsetLeft - c.clientWidth / 2 + a.clientWidth / 2; }); }
function render() {
  const tabs = document.getElementById('tabs');
  const msg = NOTE ? el('div', { class: 'banner ' + NOTE.kind + (NOTE.kind === 'ok' ? ' okpop' : ''), role: 'status', id: 'note', 'data-kind': NOTE.kind }, NOTE.text, NOTE.undo ? el('button', { class: 'btn sec', id: 'undoSwap', onclick: () => { const u = NOTE.undo; NOTE = null; act(() => ev('FIXTURES_SWAPPED', u), 'Deshecho: volvieron a su lugar.'); } }, 'Deshacer') : null) : null;
  if (!TOKEN || !ST) { tabs.hidden = true; main.replaceChildren(...[msg, ...(TOKEN ? [] : login())].filter(Boolean)); return; }
  tabs.hidden = false;
  const nq = L.pendingQueue(ST).length; { const tb = document.querySelector('#tabs [data-tab=cola]'); tb.replaceChildren('Hoy', ...(nq ? [el('span', { class: 'nbadge', 'aria-label': nq + ' por aprobar' }, String(nq))] : [])); }
  { const h1 = document.querySelector('header h1'); if (h1 && window.TosDemo) h1.textContent = 'Papá'; }
  document.getElementById('sub').textContent = (ST.state.tournament ? ST.state.tournament.name : 'Torneo nuevo') + (ST.state.tournament && ST.state.tournament.date ? ' · ' + new Date(ST.state.tournament.date + 'T12:00').toLocaleDateString('es', { day: 'numeric', month: 'long' }) : '');
  main.replaceChildren(...[msg, ...TABS[TAB]()].filter(Boolean));
  centerChips();
}
window.goHomeIfWaiting = () => { if (ST && TAB !== 'cola') { TAB = 'cola'; SCHED = null; syncTabs(); render(); } };
function syncTabs() { document.querySelectorAll('#tabs button').forEach((x) => x.setAttribute('aria-selected', x.dataset.tab === TAB)); }
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { TAB = b.dataset.tab; NOTE = null; window.scrollTo(0, 0); syncTabs(); render(); }));
TOKEN ? refresh() : render();
// New referee reports show up by themselves: refresh every 5 s on the queue/schedule screens when nobody is typing.
setInterval(() => { if (TOKEN && (!ST || TAB === 'cola' || TAB === 'horario') && !(document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName))) refresh(); }, 5000);
tabKeys(document.querySelector('nav.tabs'), 'main');
