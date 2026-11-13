'use strict';
// Schedule generator (pure). Round-robin per group (circle method), then slots across pitches.
// Greedy slot filling: among unplayed matches pick the one whose teams rested longest, so no team plays two slots in a row when avoidable.
// Everything Dad must still decide is a parameter (never hard-coded truth): rounds, pitches, slotMinutes, start, dayEnd.
// R1 fix round: times are real same-day clock times (never 24:00+), a plan that does not fit the day is REFUSED before anything is created.
const pad = (n) => String(n).padStart(2, '0');
const hm = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const iso = (date, mins) => `${date}T${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
function roundRobin(teamIds) {
  const t = teamIds.slice(); if (t.length % 2) t.push(null);
  const n = t.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const m = [];
    for (let i = 0; i < n / 2; i++) { const a = t[i], b = t[n - 1 - i]; if (a && b) m.push(r % 2 ? [b, a] : [a, b]); }
    rounds.push(m); t.splice(1, 0, t.pop());
  }
  return rounds;
}
// Raw group slots as numbers of minutes (no formatting, so overflow can be detected before a wrong time exists).
function rawGroups(groups, opts) {
  const { start = '09:00', slotMinutes = 60, pitches = ['Cancha 1'], rounds = 1, referees = [] } = opts;
  if (![1, 2].includes(rounds)) throw new Error('rounds 1 o 2');
  const pool = []; let seq = 0;
  for (const [g, ids] of Object.entries(groups)) {
    const rr = roundRobin(ids);
    for (let pass = 0; pass < rounds; pass++) rr.forEach((rd, ri) => rd.forEach(([a, b]) => pool.push({ g, home: pass % 2 ? b : a, away: pass % 2 ? a : b, order: pass * 100 + ri, n: ++seq })));
  }
  pool.sort((x, y) => x.order - y.order || x.n - y.n);
  // T-1113 (Dad: "this team plays after 7"): opts.notBefore = { teamId: 'HH:MM' } = that team's earliest kickoff. Validated in planFits.
  const nb = (id) => { const t = opts.notBefore && Object.prototype.hasOwnProperty.call(opts.notBefore, id) ? hm(opts.notBefore[id]) : NaN; return Number.isNaN(t) ? -1 : t; };
  const lastSlot = {}, out = []; const s0 = hm(start); let slot = 0;
  while (pool.length && slot < 200) {
    const busy = new Set();
    for (let p = 0; p < pitches.length && pool.length; p++) {
      let best = -1, bestScore = Infinity;
      pool.forEach((m, i) => {
        if (busy.has(m.home) || busy.has(m.away)) return;
        const tNow = s0 + slot * slotMinutes; if (nb(m.home) > tNow || nb(m.away) > tNow) return;
        const rest = Math.min(slot - (lastSlot[m.home] ?? -9), slot - (lastSlot[m.away] ?? -9));
        const score = (rest <= 1 ? 1000 : 0) + i; if (score < bestScore) { bestScore = score; best = i; }
      });
      if (best < 0) break;
      const m = pool.splice(best, 1)[0];
      busy.add(m.home); busy.add(m.away); lastSlot[m.home] = slot; lastSlot[m.away] = slot;
      out.push({ id: `m${out.length + 1}`, stage: 'group', groupId: m.g, home: m.home, away: m.away, min: s0 + slot * slotMinutes, pitch: pitches[p], ...(referees.length ? { refereeId: referees[p % referees.length] } : {}) });
    }
    slot++;
  }
  return out;
}
// T-1106 (Dad's answer: knockout from quarterfinals): opts.ko = 'cuartos' builds quarterfinals → semifinals → final.
// 2 groups of 4+ teams: the first 4 of each group go through; 4 groups: the first 2 of each. Anything else: no automatic quarterfinals.
const koShape = (groups, ko) => { const g = Object.values(groups), n = g.length;
  if (ko === 'cuartos') return (n === 2 && g.every((x) => x.length >= 4)) || (n === 4 && g.every((x) => x.length >= 2)) ? 'cuartos' : 'none';
  return n === 1 ? 'final' : n === 2 ? 'semis' : 'none'; };
// How many teams per group must qualify for the chosen knockout (null = the knockout does not draw on a count).
const qualifiersFor = (groups, ko) => { const s = koShape(groups, ko), n = Object.keys(groups).length; return s === 'cuartos' ? (n === 2 ? 4 : 2) : s === 'semis' || s === 'final' ? 2 : null; };
// The whole plan in minutes: group matches + knockout (when the format supports one).
function rawPlan(groups, opts) {
  const pitches = opts.pitches && opts.pitches.length ? opts.pitches : ['Cancha 1'];
  const referees = opts.referees && opts.referees.length ? opts.referees : pitches.map((_, i) => 'ref' + (i + 1));
  const slotMinutes = opts.slotMinutes || 60; const o = { ...opts, pitches, referees, slotMinutes };
  const fx = rawGroups(groups, o); const names = Object.keys(groups);
  let t = fx.reduce((m, f) => Math.max(m, f.min), 0) + slotMinutes; const ref = (i) => referees[i % referees.length];
  const ko = (id, round, order, h, a, m, pi) => fx.push({ id, stage: 'ko', round, order, homeSource: h, awaySource: a, min: m, pitch: pitches[pi % pitches.length], refereeId: ref(pi) });
  const shape = koShape(groups, opts.ko), np = pitches.length;
  if (shape === 'cuartos') {
    const [a, b, c, d] = names;
    const qf = names.length === 2 ? [['1' + a, '4' + b], ['2' + b, '3' + a], ['1' + b, '4' + a], ['2' + a, '3' + b]] : [['1' + a, '2' + b], ['1' + c, '2' + d], ['1' + b, '2' + a], ['1' + d, '2' + c]];
    const round = (list, tag, label, first) => { list.forEach(([h, aw], i) => ko(tag + (i + 1), `${label} ${i + 1}`, first + i, h, aw, t + Math.floor(i / np) * slotMinutes, i % np)); t += Math.ceil(list.length / np) * slotMinutes; };
    round(qf, 'QF', 'Cuartos de final', 1);
    round([['W:QF1', 'W:QF2'], ['W:QF3', 'W:QF4']], 'SF', 'Semifinal', 5);
    ko('F', 'Final', 7, 'W:SF1', 'W:SF2', t, 0);
  } else if (names.length === 2) {
    const [a, b] = names; ko('SF1', 'Semifinal 1', 1, '1' + a, '2' + b, t, 0);
    if (pitches.length > 1) ko('SF2', 'Semifinal 2', 2, '1' + b, '2' + a, t, 1); else { t += slotMinutes; ko('SF2', 'Semifinal 2', 2, '1' + b, '2' + a, t, 0); }
    t += slotMinutes; ko('F', 'Final', 3, 'W:SF1', 'W:SF2', t, 0);
  } else if (names.length === 1) ko('F', 'Final', 1, '1' + names[0], '2' + names[0], t, 0);
  return { fx, slotMinutes, pitches };
}
const clock = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const clock12 = (m) => { const h = Math.floor(m / 60), mm = pad(m % 60); return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? 'a. m.' : 'p. m.'}`; };
// Preflight: does the plan fit one day? Says what a person needs to hear, BEFORE anything is created.
function planFits(groups, opts = {}) {
  const names = Object.keys(groups || {});
  if (!names.length) return { ok: false, matches: 0, message: 'Primero hacen falta los equipos y sus grupos.' };
  if (names.some((g) => (groups[g] || []).length < 2)) return { ok: false, matches: 0, message: 'Cada grupo necesita al menos 2 equipos.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date || '')) return { ok: false, matches: 0, message: 'Falta la fecha del torneo.' };
  if (Number.isNaN(hm(opts.start || '09:00'))) return { ok: false, matches: 0, message: 'La hora del primer partido no es válida.' };
  const all = new Set(names.flatMap((g) => groups[g] || [])), lim = opts.notBefore || {};
  for (const [t, v] of Object.entries(lim)) { if (!all.has(t)) return { ok: false, matches: 0, message: 'Hay una hora mínima para un equipo que no está en los grupos.' }; if (!/^\d{1,2}:\d{2}$/.test(String(v)) || Number.isNaN(hm(v))) return { ok: false, matches: 0, message: 'Una hora mínima no es válida (usa por ejemplo 19:00).' }; }
  const rounds = opts.rounds || 1, np = (opts.pitches && opts.pitches.length) || 1, dayEnd = hm(opts.dayEnd || '22:00');
  const { fx, slotMinutes } = rawPlan(groups, opts);
  const groupMatches = fx.filter((f) => f.stage === 'group').length, endMin = Math.max(...fx.map((f) => f.min)) + slotMinutes, knockout = koShape(groups, opts.ko);
  const base = { matches: fx.length, groupMatches, endsAt: clock(Math.min(endMin, 24 * 60 - 1)), endsAt12: clock12(Math.min(endMin, 24 * 60 - 1)), knockout, rounds };
  if (endMin > dayEnd) return { ok: false, ...base, endsAt: endMin >= 24 * 60 ? 'después de medianoche' : clock(endMin), endsAt12: endMin >= 24 * 60 ? 'después de medianoche' : clock12(endMin),
    message: `Con ${np} cancha${np > 1 ? 's' : ''} no caben ${groupMatches} partidos de grupo (y la fase final) en el día: terminarían ${endMin >= 24 * 60 ? 'después de medianoche' : 'a las ' + clock12(endMin)}. Usa más canchas, una sola vuelta, partidos más cortos o empieza más temprano.${Object.keys(lim).length ? ' Las horas mínimas de algunos equipos (juegan después de las ' + [...new Set(Object.values(lim))].map((x) => clock12(hm(x))).join(', ') + ') también empujan el día.' : ''}` };
  const note = knockout === 'cuartos' ? `Se arman todos los partidos, los cuartos de final (pasan los ${qualifiersFor(groups, opts.ko)} primeros de cada grupo), las semifinales y la final.` : knockout === 'none' ? 'Con 3 o más grupos no se arman solas las semifinales ni la final: eso se decide con Papá. Se arman los partidos de grupo.' : knockout === 'final' ? 'Se arman todos los partidos y la final (1.º contra 2.º).' : 'Se arman todos los partidos, las semifinales cruzadas y la final.';
  return { ok: true, ...base, note, qualifiers: qualifiersFor(groups, opts.ko) };
}
// Group matches only (kept for callers and tests): same arithmetic, refuses overflow instead of printing 25:00.
function generateSchedule(groups, opts = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date || '')) throw new Error('date requerida');
  const raw = rawGroups(groups, opts);
  if (raw.some((f) => f.min >= 24 * 60)) throw new Error('Los partidos no caben en el día (no cabe pasada la medianoche).');
  return raw.map(({ min, ...f }) => ({ ...f, kickoff: iso(opts.date, min) }));
}
// ONE button: group matches + knockout, every match with time, pitch and referee. Throws (before anything is built) if the day is too short.
function buildPlan(groups, opts = {}) {
  const fit = planFits(groups, opts);
  if (!fit.ok) throw new Error(fit.message);
  const { fx } = rawPlan(groups, opts);
  return fx.map(({ min, ...f }) => ({ type: 'FIXTURE_ADDED', payload: { ...f, kickoff: iso(opts.date, min) } }));
}
// What the UI saves: the chosen format FIRST (so completeness is checked against it), then the fixtures.
function planEvents(groups, opts = {}) { return [{ type: 'FORMAT_SET', payload: { rounds: opts.rounds || 1, slotMinutes: opts.slotMinutes || 60 } }, ...buildPlan(groups, opts)]; }
// Real validator. Without `groups` it checks only clashes (team or pitch twice at the same time). With `groups` and `rounds` it also checks the exact
// pairings: round 1 = every pair exactly once; round 2 (ida y vuelta) = every ordered pair exactly once. Anything missing, extra or duplicated fails.
function checkSchedule(fixtures, groups, rounds) {
  const bySlot = {}, played = {}; let backToBack = 0;
  for (const f of fixtures) (bySlot[f.kickoff] = bySlot[f.kickoff] || []).push(f);
  const slots = Object.keys(bySlot).sort();
  for (const k of slots) { const seenT = new Set(), seenP = new Set();
    for (const f of bySlot[k]) { for (const t of [f.home, f.away]) { if (seenT.has(t)) return { ok: false, error: 'equipo dos veces en el mismo horario ' + k }; seenT.add(t); }
      if (f.pitch) { if (seenP.has(f.pitch)) return { ok: false, error: 'cancha ocupada dos veces a las ' + k }; seenP.add(f.pitch); } } }
  slots.forEach((k, i) => { for (const f of bySlot[k]) for (const t of [f.home, f.away]) (played[t] = played[t] || []).push(i); });
  for (const arr of Object.values(played)) for (let i = 1; i < arr.length; i++) if (arr[i] === arr[i - 1] + 1) backToBack++;
  if (groups) {
    const r = rounds || 1, got = {};
    for (const f of fixtures) { const key = r === 2 ? f.home + '>' + f.away : [f.home, f.away].sort().join('|'); got[key] = (got[key] || 0) + 1; }
    const want = new Set();
    for (const ids of Object.values(groups)) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      if (r === 2) { want.add(ids[i] + '>' + ids[j]); want.add(ids[j] + '>' + ids[i]); } else want.add([ids[i], ids[j]].sort().join('|')); }
    for (const k of want) if (got[k] !== 1) return { ok: false, error: (got[k] ? 'partido repetido: ' : 'falta el partido ') + k };
    for (const k of Object.keys(got)) if (!want.has(k)) return { ok: false, error: 'partido de más: ' + k };
  }
  return { ok: true, slots: slots.length, backToBack };
}
// T-1109 (TOR-T1106-05): the knockout needs a saved qualifier count, even when nobody chose rules yet. Saved in the SAME batch, before the matches that draw on it. No rules yet = the July Cup rulebook defaults (3-1-0, straight penalties).
const DEFAULT_RULES = { points: { win: 3, draw: 1, loss: 0 }, tiebreak: ['won', 'gd', 'gf', 'h2h_result', 'fairplay', 'ga_fewest'], walkoverGoals: 3, koLevel: 'PENS' };
function withQualifierRule(plan, rules, need) {
  if (!need) return plan; // group-only shapes
  const rank = (src) => { const m = /^([1-9])/.exec(src || ''); return m ? Number(m[1]) : 0; };
  for (const e of plan) if (e.type === 'FIXTURE_ADDED' && e.payload.stage === 'ko' && Math.max(rank(e.payload.homeSource), rank(e.payload.awaySource)) > need) throw new Error(`Ese calendario usa un puesto que no clasifica: solo clasifican ${need} por grupo.`);
  const r0 = rules || {}; if (r0.points && r0.qualifiersPerGroup === need) return plan;
  const { preset, ...rest } = r0;
  return [{ type: 'RULES_SET', payload: { ...DEFAULT_RULES, ...rest, qualifiersPerGroup: need } }, ...plan];
}
const api = { generateSchedule, checkSchedule, roundRobin, buildPlan, planFits, planEvents, qualifiersFor, withQualifierRule };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else window.Schedule = api;
