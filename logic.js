'use strict';
// Pure organizer logic (browser global `L` and Node module). No DOM. Tested in tests/logic.test.js.
(function (root) {
  const name = (s, id) => (s.teams[id] ? s.teams[id].name : id);
  function srcText(src) { const m = /^([1-9])(.+)$/.exec(src || ''); if (m) return `${m[1]}º Grupo ${m[2]}`; const w = /^W:(.+)$/.exec(src || ''); return w ? `Ganador ${w[1]}` : 'Por definir'; }
  // The two teams actually playing (group: fixed; knockout: from the bracket when resolved).
  function participants(ST, f) {
    if (f.stage === 'group') return { home: f.home, away: f.away };
    const b = (ST.view.bracket || []).find((x) => x.id === f.id);
    return { home: b && b.home ? b.home.teamId || null : null, away: b && b.away ? b.away.teamId || null : null };
  }
  function title(ST, f) {
    const p = participants(ST, f), s = ST.state;
    const h = p.home ? name(s, p.home) : srcText(f.homeSource), a = p.away ? name(s, p.away) : srcText(f.awaySource);
    return f.stage === 'group' ? `${h} vs ${a}` : `${f.round}: ${h} vs ${a}`;
  }
  // Results waiting for Dad's OK: newest report per match, only if it is for the teams playing now, not voided, and not already standing.
  function pendingQueue(ST) {
    const s = ST.state, out = [];
    for (const f of Object.values(s.fixtures)) {
      if (s.withdrawn && (s.withdrawn[f.home] || s.withdrawn[f.away])) continue; // a withdrawn team's matches are not approved
      const reps = (s.reports && s.reports[f.id]) || [];
      const latest = reps[reps.length - 1]; if (!latest) continue;
      const ap = (ST.view.validApproved || {})[f.id] || null;
      if (ap && latest.version <= ap.version) continue;
      const cur = participants(ST, f);
      const vd = s.voided && s.voided[f.id];
      if (!latest.participants || latest.participants.home !== cur.home || latest.participants.away !== cur.away || (vd && latest.version < vd.voidedSeq)) continue;
      out.push({ fixtureId: f.id, version: latest.version, title: title(ST, f), home: cur.home ? name(s, cur.home) : '', away: cur.away ? name(s, cur.away) : '', hg: latest.hg, ag: latest.ag, report: latest,
        isCorrection: !!ap, previous: ap ? { hg: ap.hg, ag: ap.ag } : null, kickoff: f.kickoff || '', pitch: f.pitch || '', stage: f.stage });
    }
    return out.sort((a, b) => (a.kickoff || 'z').localeCompare(b.kickoff || 'z') || a.fixtureId.localeCompare(b.fixtureId));
  }
  // Warnings (never blocks: Dad decides) when moving a match to kickoff/pitch. ST = { state, view } (a bare state also works: knockout teams are then unknown).
  // kinds: equipo (a team already plays then), cancha (pitch busy), orden (a knockout match before the matches that feed it).
  const cancelled = (s, f) => !!(s.withdrawn && (s.withdrawn[f.home] || s.withdrawn[f.away])); // a game of a withdrawn team reserves and counts for nothing
  function scheduleConflicts(ST, fixtureId, kickoff, pitch, refereeId) {
    const wrapped = ST && ST.state ? ST : { state: ST, view: { bracket: [] } }; const s = wrapped.state;
    const me = s.fixtures[fixtureId], out = [];
    if (!me) return out;
    if (cancelled(s, me)) return [{ kind: 'cancelado', other: fixtureId }];
    if (!kickoff) return out;
    const teamsOf = (f) => { const p = participants(wrapped, f); return [p.home, p.away].filter(Boolean); };
    const mine = new Set(teamsOf(me)), slot = (s.format && s.format.slotMinutes) || 60, mn = (k) => (k ? Date.parse(k.slice(0, 16) + ':00Z') / 60000 : NaN);
    for (const f of Object.values(s.fixtures)) {
      if (f.id === fixtureId || cancelled(s, f) || !(Math.abs(mn(f.kickoff) - mn(kickoff)) < slot)) continue;
      const ref = refereeId !== undefined ? refereeId : me.refereeId; if (ref && f.refereeId === ref) out.push({ kind: 'arbitro', other: f.id });
      for (const t of teamsOf(f)) if (mine.has(t)) out.push({ kind: 'equipo', other: f.id, team: name(s, t) });
      if (pitch && f.pitch === pitch) out.push({ kind: 'cancha', other: f.id, pitch });
    }
    // order: a knockout match must come after every match that feeds it ('1A'/'2A' = the group's matches, 'W:id' = that knockout match)
    const feeders = (f) => { const list = []; for (const src of [f.homeSource, f.awaySource]) { const m = /^[1-9](.+)$/.exec(src || ''), w = /^W:(.+)$/.exec(src || '');
      if (w && s.fixtures[w[1]]) list.push(s.fixtures[w[1]]); else if (m) for (const g of Object.values(s.fixtures)) if (g.stage === 'group' && g.groupId === m[1] && !cancelled(s, g)) list.push(g); } return list; };
    if (me.stage === 'ko') { const late = feeders(me).filter((g) => g.kickoff && g.kickoff >= kickoff); if (late.length) out.push({ kind: 'orden', other: late[0].id, text: 'antes' }); }
    for (const f of Object.values(s.fixtures)) if (f.stage === 'ko' && f.kickoff && feeders(f).some((g) => g.id === fixtureId) && kickoff >= f.kickoff) out.push({ kind: 'orden', other: f.id, text: 'despues' });
    return out;
  }
  function scheduleBySlot(s) {
    const slots = {};
    for (const f of Object.values(s.fixtures)) (slots[f.kickoff ? f.kickoff.slice(11, 16) : 'Sin hora'] = slots[f.kickoff ? f.kickoff.slice(11, 16) : 'Sin hora'] || []).push(f);
    return Object.entries(slots).sort(([a], [b]) => (a === 'Sin hora') - (b === 'Sin hora') || a.localeCompare(b)).map(([time, items]) => ({ time, items: items.sort((x, y) => (x.pitch || '').localeCompare(y.pitch || '') || x.id.localeCompare(y.id)) }));
  }
  // Kick-off times (HH:MM) that are NOT free for this match on this pitch with this referee: the picker greys them out so nobody has to guess.
  function busyTimes(ST, fixtureId, date, times, pitch, refereeId) { const out = new Set(); for (const t of times) if (scheduleConflicts(ST, fixtureId, date + 'T' + t, pitch, refereeId).length) out.add(t); return out; }
  // Dad's day at a glance: cancelled games (a team withdrew) are not part of it.
  function dayProgress(ST) {
    const s = ST.state, all = Object.values(s.fixtures).filter((f) => !cancelled(s, f)), standing = ST.view.validApproved || {};
    const done = all.filter((f) => standing[f.id]);
    const waiting = new Set(pendingQueue(ST).map((x) => x.fixtureId));
    const next = all.filter((f) => !standing[f.id] && !waiting.has(f.id)).sort((a, b) => (a.kickoff || 'z').localeCompare(b.kickoff || 'z') || a.id.localeCompare(b.id));
    return { done: done.length, total: all.length, next, doneFixtures: done };
  }
  // 24-hour "HH:MM" (or an ISO date-time) -> "9:00 a. m." / "8:00 p. m." (US families)
  function t12(t) { const m = /(\d{1,2}):(\d{2})/.exec(t || ''); if (!m) return ''; const h = Number(m[1]), mm = m[2]; return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? 'a. m.' : 'p. m.'}`; }
  // R5-04/-06: ONE classification of a public fixture (card, match page, next-match hero all use it). `status` comes from the family projection.
  function publicState(f) {
    const r = f.result, st = f.status || 'Por jugar';
    if (r) return { kind: r.wo ? 'wo' : 'played', label: r.wo ? 'W.O.' : 'Terminado', note: '' };
    if (f.live && !r) return { kind: 'live', label: 'EN VIVO', note: '' };
    if (f.lifecycle === 'unresolved' && !/anulado/i.test(st)) return { kind: 'unresolved', label: 'Por definir', note: 'Todavía no se sabe quién juega este partido.' };
    if (/retirado/i.test(st)) return { kind: 'withdrawn', label: 'Equipo retirado', note: 'Un equipo se retiró: este partido no cuenta.' };
    if (/anulado/i.test(st)) return { kind: 'annulled', label: 'Resultado anulado', note: st.replace(/^Resultado anulado:\s*/i, '') };
    return { kind: 'todo', label: 'Por jugar', note: '' };
  }
  // The next match to be played: scheduled, no result, never a cancelled one; plus the matches at the same kick-off.
  function nextMatch(fx) {
    const open = fx.filter((f) => !f.result && !f.live && f.kickoff && f.home && f.away /* two real teams */ && !['withdrawn', 'unresolved'].includes(publicState(f).kind) && (f.lifecycle === undefined || ['playable', 'annulled'].includes(f.lifecycle)));
    const next = open[0] || null; return { next, sameSlot: next ? open.filter((f) => f.kickoff === next.kickoff) : [] };
  }
  // R5-09: would swapping a and b leave a clash in the FINAL state? Same rules the engine enforces (it still has the last word). Returns the reasons (empty = fine).
  function swapProblems(ST, aId, bId) {
    const wrapped = ST && ST.state ? ST : { state: ST, view: { bracket: [] } }, s = wrapped.state, fa = s.fixtures[aId], fb = s.fixtures[bId]; if (!fa || !fb) return [{ kind: 'desconocido' }];
    if (((s.reports || {})[aId] || []).length || ((s.reports || {})[bId] || []).length) return [{ kind: 'reporte' }];
    const swapped = { ...s, fixtures: { ...s.fixtures, [aId]: { ...fa, kickoff: fb.kickoff, pitch: fb.pitch, refereeId: fb.refereeId }, [bId]: { ...fb, kickoff: fa.kickoff, pitch: fa.pitch, refereeId: fa.refereeId } } };
    const W = { ...wrapped, state: swapped }, na = swapped.fixtures[aId], nb = swapped.fixtures[bId];
    return [...scheduleConflicts(W, aId, na.kickoff, na.pitch, na.refereeId), ...scheduleConflicts(W, bId, nb.kickoff, nb.pitch, nb.refereeId)];
  }
  // The champion shown on Hoy: ONLY the winner the bracket resolved from the approved Final (extra time and penalties included). Never the regulation score, never list order.
  // {state:'champion', team} | {state:'pending'} (a Final exists but has no approved, resolved winner) | null (no Final in this tournament)
  function champion(d) {
    const fin = (d.fixtures || []).find((f) => f.round === 'Final'); if (!fin) return null;
    const b = (d.bracket || []).find((x) => x.id === fin.id); return b && b.result && b.winner ? { state: 'champion', team: b.winner } : { state: 'pending' };
  }
  const api = { champion, swapProblems, publicState, nextMatch, t12, busyTimes, isCancelled: cancelled, dayProgress, pendingQueue, scheduleConflicts, scheduleBySlot, title, participants };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.L = api;
})(typeof window !== 'undefined' ? window : globalThis);
