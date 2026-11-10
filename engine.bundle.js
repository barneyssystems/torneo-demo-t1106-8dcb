(function(){var defs={},cache={};
defs["/engine/state"]=function(module,exports,require){'use strict';
const MEDIA_MOD = require('./flags').MEDIA ? require('./media') : null;
// Event-sourced tournament state.
// - Append-only log; each event's hash is an HMAC-SHA256 (server secret key) over the event + prevHash, so events cannot be
//   forged, edited, reordered or re-hashed without the key (A4-01/A4-05).
// - ROLLBACK{toSeq} means "the effective state is exactly what it was right after event toSeq". It deletes nothing; a later
//   rollback to a sequence AFTER an earlier rollback restores that later state (rollback-of-rollback = redo) (A4-08).
// - The organizer audit is built from the RAW log: every approval, correction and rollback stays visible, with what it voided.
const crypto = require('node:crypto');
const { computeGroupTable } = require('./standings');
const { koWinner, koShapeError, resolveSlot, lockedPositions, maxGroupRank } = require('./bracket');

const GENESIS = '0'.repeat(64);
function hashEvent(e, key) {
  if (!key) throw new Error('missing chain key');
  const { hash, ...rest } = e;
  return crypto.createHmac('sha256', key).update(JSON.stringify(rest)).digest('hex');
}
function append(log, type, actor, payload, ts, key) {
  const prev = log.length ? log[log.length - 1].hash : GENESIS;
  const e = { seq: log.length + 1, ts: ts || new Date().toISOString(), type, actor, payload, prevHash: prev };
  e.hash = hashEvent(e, key);
  log.push(e);
  return e;
}
function verifyChain(log, key) {
  if (!Array.isArray(log)) return { ok: false, at: 0 };
  let prev = GENESIS;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (!e || typeof e !== 'object' || e.seq !== i + 1 || e.prevHash !== prev || typeof e.hash !== 'string' || hashEvent(e, key) !== e.hash) return { ok: false, at: i + 1 };
    prev = e.hash;
  }
  return { ok: true, length: log.length, head: prev };
}

// Effective event sets as persistent linked lists: eff[k] = events in effect right after event k.
function effectiveNodes(log) {
  const eff = [null];
  for (const e of log) eff.push(e.type === 'ROLLBACK' ? eff[e.payload.toSeq] : { seq: e.seq, prev: eff[e.seq - 1] });
  return eff;
}
function seqsOf(node) { const out = []; for (let n = node; n; n = n.prev) out.push(n.seq); return out.reverse(); }

const M = () => Object.create(null); // prototype-free maps: ids like "__proto__" cannot poison state
function fresh() { return { tournament: null, rules: null, teams: M(), players: M(), fixtures: M(), reports: M(), approved: M(), corrected: M(), waiver: null, waivers: M(), consents: M(), signLinks: M(), voided: M(), format: null, withdrawn: M(), publicNames: null }; }

// Both directions of a rollback in the effective event graph, including setup. Organizer-only.
const KIND_OF = { TOURNAMENT_SET: 'setup', RULES_SET: 'setup', FORMAT_SET: 'setup', TEAM_ADDED: 'setup', TEAM_WITHDRAWN: 'setup', PLAYER_ADDED: 'setup', FIXTURE_ADDED: 'setup', REPORT_APPROVED: 'result', REPORT_SUBMITTED: 'report', FIXTURE_SCHEDULED: 'schedule', FIXTURES_SWAPPED: 'schedule', FIXTURE_REFEREE_SET: 'schedule', WAIVER_PUBLISHED: 'consent', SIGN_LINK_ISSUED: 'consent', WAIVER_SIGNED: 'consent', MEDIA_CONSENT_GRANTED: 'consent', MEDIA_CONSENT_REVOKED: 'consent', CONSENT_VERIFIED: 'consent' };
// T1109-R1-02: how many consents would this rollback nominally restore but the durable tomb keeps off? From RAW history: a preview must warn even when an earlier rollback already removed the revocation.
function revocationsKept(log, targetNode) {
  const lastRev = Object.create(null), grants = Object.create(null);
  for (const e of log) if (e.type === 'MEDIA_CONSENT_REVOKED') lastRev[e.payload.playerId] = e.seq;
  for (const s of seqsOf(targetNode)) { const e = log[s - 1]; if (e.type === 'MEDIA_CONSENT_GRANTED') grants[e.payload.playerId] = s; else if (e.type === 'MEDIA_CONSENT_REVOKED') delete grants[e.payload.playerId]; }
  return Object.keys(grants).filter((pid) => lastRev[pid] > grants[pid]).length;
}
function rollbackImpact(log, toSeq) {
  const eff = effectiveNodes(log), n = log.length, before = seqsOf(eff[n]), bset = new Set(before), after = new Set(seqsOf(eff[toSeq]));
  const team = {}, fix = {}; for (const e of log) { if (e.type === 'TEAM_ADDED') team[e.payload.id] = e.payload.name; if (e.type === 'FIXTURE_ADDED') fix[e.payload.id] = e.payload; }
  const tn = (id) => team[id] || id, fl = (id) => { const f = fix[id]; return f ? (f.stage === 'group' ? `${tn(f.home)} vs ${tn(f.away)}` : f.round || id) : id; };
  const label = (e) => { const p = e.payload; switch (e.type) {
    case 'TOURNAMENT_SET': return `El torneo «${p.name}»`; case 'RULES_SET': return 'Las reglas del torneo'; case 'FORMAT_SET': return 'El formato (rondas y duración)';
    case 'TEAM_ADDED': return `Equipo ${p.name}`; case 'TEAM_WITHDRAWN': return `El retiro de ${tn(p.teamId)}`; case 'PLAYER_ADDED': return `Jugador #${p.number} de ${tn(p.teamId)}`;
    case 'FIXTURE_ADDED': return `Partido ${fl(p.id)}`; case 'REPORT_APPROVED': { const r = (log[p.version - 1] || {}).payload; const rep = r && r.report; return `Resultado aprobado: ${fl(p.fixtureId)}${rep ? ' ' + rep.hg + '-' + rep.ag : ''}`; }
    case 'REPORT_SUBMITTED': return `Marcador enviado por un árbitro: ${fl(p.fixtureId)}`; case 'FIXTURE_SCHEDULED': case 'FIXTURES_SWAPPED': case 'FIXTURE_REFEREE_SET': return 'Un cambio de horario, cancha o árbitro';
    default: return KIND_OF[e.type] === 'consent' ? 'Un permiso o una firma' : 'Otro cambio'; } };
  const visible = (s) => MEDIA_MOD || KIND_OF[log[s - 1].type] || log[s - 1].type === 'NAMES_PUBLIC_SET';
  const leaving = before.filter((s) => !after.has(s) && visible(s)).map((seq) => { const e = log[seq - 1]; return { seq, type: e.type, kind: KIND_OF[e.type] || 'other', label: label(e) }; });
  const restoring = [...after].filter((s) => !bset.has(s) && visible(s)).map((seq) => { const e = log[seq - 1]; return { seq, type: e.type, kind: KIND_OF[e.type] || 'other', label: label(e) }; });
  function summarize(items) {
    const count = (t) => items.filter((x) => x.type === t).length, plural = (c, one, many) => `${c} ${c === 1 ? one : many}`;
    const summary = []; const add = (c, text) => { if (c) summary.push({ text }); };
    if (items.some((x) => x.type === 'TOURNAMENT_SET')) summary.push({ text: 'el torneo (nombre y fecha)' }); if (items.some((x) => x.type === 'RULES_SET')) summary.push({ text: 'las reglas' }); if (items.some((x) => x.type === 'FORMAT_SET')) summary.push({ text: 'el formato' });
    add(count('TEAM_ADDED'), plural(count('TEAM_ADDED'), 'equipo', 'equipos')); add(count('PLAYER_ADDED'), plural(count('PLAYER_ADDED'), 'jugador', 'jugadores')); add(count('FIXTURE_ADDED'), plural(count('FIXTURE_ADDED'), 'partido', 'partidos'));
    add(count('REPORT_APPROVED'), plural(count('REPORT_APPROVED'), 'resultado aprobado', 'resultados aprobados')); add(count('REPORT_SUBMITTED'), plural(count('REPORT_SUBMITTED'), 'marcador enviado por árbitros', 'marcadores enviados por árbitros'));
    const sch = items.filter((x) => x.kind === 'schedule').length, con = items.filter((x) => x.kind === 'consent').length, oth = items.filter((x) => x.kind === 'other' || x.type === 'TEAM_WITHDRAWN').length;
    add(sch, plural(sch, 'cambio de horario', 'cambios de horario')); add(con, plural(con, 'permiso o firma', 'permisos y firmas')); add(oth, plural(oth, 'otro cambio', 'otros cambios'));
    return summary;
  }
  return { toSeq, head: n, revocationsKept: revocationsKept(log, eff[toSeq]), effective: before.filter(visible).length, leaving, restoring, summary: summarize(leaving), restoringSummary: summarize(restoring), deletesSetup: leaving.some((x) => x.kind === 'setup') };
}
function syncConsent(st, pid) {
  const c = st.consents[pid], pl = st.players[pid];
  if (!pl) return;
  st.players[pid] = { ...pl, consent: { mediaVerified: !!(c && c.active && c.verifiedSeq && c.scope.includes('perfil')), scope: c && c.active && c.verifiedSeq ? c.scope : [] } };
}
const waiverOk = (st, pid) => !st.waiver || (st.waivers[pid] || []).some((w) => w.version === st.waiver.version && w.textHash === st.waiver.textHash);

// Pure state transition (validation happens BEFORE, in rules.checkEvent).
function apply(st, e) {
  const p = e.payload;
  switch (e.type) {
    case 'TOURNAMENT_SET': st.tournament = p; break;
    case 'RULES_SET': st.rules = p; break;
    case 'TEAM_ADDED': st.teams[p.id] = p; break;
    case 'FORMAT_SET': { const keep = p.slotMinutes || (st.format && st.format.slotMinutes); st.format = { rounds: p.rounds, ...(keep ? { slotMinutes: keep } : {}) }; break; } // an omitted length keeps the saved one // R2-03: the competition format the organizer CHOSE (never inferred)
    case 'TEAM_WITHDRAWN': st.withdrawn[p.teamId] = { seq: e.seq, reason: p.reason || null }; break;
    case 'PLAYER_ADDED': st.players[p.id] = { ...p, consent: { mediaVerified: false } }; break;
    // Media consent: a minor's identity/media is public ONLY while a guardian consent is ACTIVE, covers 'perfil', and the organizer verified
    // THAT grant in person. Revocation (family or organizer) takes effect at once; a new grant needs a new verification.
    case 'WAIVER_PUBLISHED': st.waiver = { version: p.version, text: p.text, textHash: crypto.createHash('sha256').update(p.text).digest('hex'), seq: e.seq }; break;
    case 'SIGN_LINK_ISSUED': st.signLinks[p.id] = { playerId: p.playerId, tokenHash: p.tokenHash, seq: e.seq }; break;
    case 'WAIVER_SIGNED': (st.waivers[p.playerId] = st.waivers[p.playerId] || []).push({ version: p.version, textHash: p.textHash, signerName: p.signerName, relation: p.relation, seq: e.seq, ts: e.ts, by: e.actor }); break;
    case 'MEDIA_CONSENT_GRANTED': st.consents[p.playerId] = { active: true, scope: p.scope, signerName: p.signerName, relation: p.relation, grantSeq: e.seq, verifiedSeq: null, revokedSeq: null, history: [...((st.consents[p.playerId] || {}).history || []), { action: 'otorgado', seq: e.seq, ts: e.ts, by: e.actor, scope: p.scope }] }; syncConsent(st, p.playerId); break;
    case 'MEDIA_CONSENT_REVOKED': { const c = st.consents[p.playerId]; if (c) { c.active = false; c.revokedSeq = e.seq; c.history = [...c.history, { action: 'revocado', seq: e.seq, ts: e.ts, by: e.actor }]; } syncConsent(st, p.playerId); break; }
    case 'CONSENT_VERIFIED': { const c = st.consents[p.playerId]; if (c && c.active && c.grantSeq === p.consentSeq) { c.verifiedSeq = e.seq; c.history = [...c.history, { action: 'verificado', seq: e.seq, ts: e.ts, by: e.actor }]; } syncConsent(st, p.playerId); break; }
    case 'FIXTURE_ADDED': st.fixtures[p.id] = p; break;
    case 'FIXTURES_SWAPPED': { const fa = st.fixtures[p.a], fb = st.fixtures[p.b]; st.fixtures[p.a] = { ...fa, kickoff: fb.kickoff, pitch: fb.pitch, refereeId: fb.refereeId }; st.fixtures[p.b] = { ...fb, kickoff: fa.kickoff, pitch: fa.pitch, refereeId: fa.refereeId }; break; }
    case 'NAMES_PUBLIC_SET': st.publicNames = { adults: p.adults }; break; // organizer's explicit choice; default = nobody is named
    case 'FIXTURE_REFEREE_SET': { const f = st.fixtures[p.fixtureId]; st.fixtures[p.fixtureId] = { ...f, refereeId: p.refereeId }; break; }
    case 'FIXTURE_SCHEDULED': { const f = st.fixtures[p.fixtureId]; st.fixtures[p.fixtureId] = { ...f, ...(p.kickoff !== undefined ? { kickoff: p.kickoff } : {}), ...(p.pitch !== undefined ? { pitch: p.pitch } : {}), ...(p.refereeId !== undefined ? { refereeId: p.refereeId } : {}) }; break; }
    case 'REPORT_SUBMITTED': (st.reports[p.fixtureId] = st.reports[p.fixtureId] || []).push({ ...p.report, participants: p.participants, version: e.seq, by: e.actor }); break;
    case 'REPORT_APPROVED': {
      const rep = st.reports[p.fixtureId].find((r) => r.version === p.version);
      if (st.approved[p.fixtureId]) st.corrected[p.fixtureId] = true;
      st.approved[p.fixtureId] = { ...rep, approvedSeq: e.seq };
      break;
    }
    default: if (MEDIA_MOD) MEDIA_MOD.apply(st, e); break; // media events exist only when the build flag is on
  }
  // Invalidation, in causal order (D205 S1b, review D205-TOURN-S1-R2 F1). 1) DIRECT invalidations caused by this event, then 2) the KO
  // cascade to a fixed point, so a downstream result can never be checked against a feeder this same event is about to void.
  // 1) D205 R1-P1-1: a standing W.O. (group OR KO) must satisfy the CURRENT walkover rule; otherwise it is voided durably.
  if (e.type === 'RULES_SET') {
    const wg = st.rules && st.rules.walkoverGoals;
    for (const [fid, r] of Object.entries(st.approved)) if (r.wo && !(wg && (r.wo === 'h' ? r.ag : r.hg) === wg && (r.wo === 'h' ? r.hg : r.ag) === 0)) {
      st.voided[fid] = { ...r, voidedSeq: e.seq, reason: 'cambió la regla de W.O.' }; delete st.approved[fid];
    }
  }
  // 2) W2-B-03: a KO approval that becomes invalid is VOIDED durably (moved out of `approved`, kept in `voided`), so a later rule reversal or
  // upstream re-correction can never silently resurrect it; only a NEW report + explicit approval restores a result. Each pass either voids
  // at least one approved KO or stops, so it terminates within (number of KO fixtures + 1) passes.
  // R3-02: anything that can change a group's membership, completeness or ranking also re-checks every approved knockout result (durable void + tombstone)
  if (['RULES_SET', 'REPORT_APPROVED', 'FIXTURE_ADDED', 'FORMAT_SET', 'TEAM_WITHDRAWN', 'TEAM_ADDED'].includes(e.type)) cascade(st, e.seq);
  return st;
}
function cascade(st, seq) {
  const maxPasses = Object.values(st.fixtures).filter((f) => f.stage === 'ko').length + 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    if (!Object.values(st.fixtures).some((f) => f.stage === 'ko' && st.approved[f.id])) break;
    const v = view(st);
    let voidedAny = false;
    for (const b of v.bracket) if (b.invalidated && st.approved[b.id]) { st.voided[b.id] = { ...st.approved[b.id], voidedSeq: seq, reason: b.invalidated }; delete st.approved[b.id]; voidedAny = true; }
    if (!voidedAny) break;
  }
}
function foldSeqs(log, seqs) { const st = fresh(); for (const s of seqs) apply(st, log[s - 1]); return st; }

// D205 S1b (review D205-TOURN-S1B-R1, class "a void is a durable fact"): voids are recorded from the RAW history in a tombstone ledger that
// no rewind can erase. Every ROLLBACK (including rollback-of-rollback and a same-history prefix import, which commits a ROLLBACK) re-applies
// the ledger to the folded state: an approval or report version that was ever voided cannot stand again; only a NEW report + approval can.
// Ordinary corrections are not voids, so exact rollback of corrections and setup (A4-08) is unchanged.
const tombLedger = () => Object.create(null);
// T-1109 (TOR-T1106-02, P0): a revoked consent is a durable privacy fact too. The newest revocation seen in the RAW history, per player, lives here (a Symbol key: a fixture id can never collide with it).
const CONSENT_TOMBS = Symbol('consentTombs');
function recordTombs(st, tomb) {
  const ct = tomb[CONSENT_TOMBS] || (tomb[CONSENT_TOMBS] = Object.create(null));
  for (const [pid, c] of Object.entries(st.consents)) if (c.revokedSeq && (ct[pid] || 0) < c.revokedSeq) ct[pid] = c.revokedSeq;
  for (const [fid, v] of Object.entries(st.voided)) {
    const t = tomb[fid] || (tomb[fid] = { approvals: new Set(), versions: new Set() });
    t.approvals.add(v.approvedSeq); t.versions.add(v.version);
  }
}
function overlayTombs(st, tomb, seq) {
  for (const [fid, r] of Object.entries(st.approved)) {
    const t = tomb[fid];
    if (t && (t.approvals.has(r.approvedSeq) || t.versions.has(r.version))) { st.voided[fid] = { ...r, voidedSeq: seq, reason: 'ya había sido anulado; deshacer no lo revive' }; delete st.approved[fid]; }
  }
  cascade(st, seq); // a tombstoned feeder can invalidate downstream knockouts
  // T-1109: a consent granted BEFORE a revocation in the raw history can never stand again, whatever the rollback did. Only a new guardian grant (a later seq) plus a new verification counts.
  const ct = tomb[CONSENT_TOMBS]; if (ct) for (const [pid, c] of Object.entries(st.consents)) if (c.active && ct[pid] > c.grantSeq) { c.active = false; c.verifiedSeq = null; c.revokedSeq = ct[pid]; syncConsent(st, pid); }
  st.tombs = tomb;
}
function rewind(log, eff, e, tomb) { const st = foldSeqs(log, seqsOf(eff[e.seq])); overlayTombs(st, tomb, e.seq); recordTombs(st, tomb); return st; }

// Full replay: current effective state + raw audit (organizer-only).
function replay(log) {
  const eff = effectiveNodes(log);
  const effSet = new Set(seqsOf(eff[log.length]));
  const audit = [];
  const tomb = tombLedger();
  let st = fresh(); st.tombs = tomb;
  const voidRows = (e) => { for (const [fid, vd] of Object.entries(st.voided)) if (vd.voidedSeq === e.seq) {
    audit.push({ seq: e.seq, ts: e.ts, action: 'VOIDED', fixtureId: fid, approvedSeq: vd.approvedSeq, version: vd.version, cause: vd.reason, trigger: e.type, by: e.actor, active: effSet.has(e.seq) }); } };
  for (const e of log) {
    if (e.type === 'ROLLBACK') {
      const before = new Set(seqsOf(eff[e.seq - 1])), after = new Set(seqsOf(eff[e.seq]));
      audit.push({ seq: e.seq, ts: e.ts, action: 'ROLLBACK', toSeq: e.payload.toSeq, reason: e.payload.reason, by: e.actor,
        voided: [...before].filter((s) => !after.has(s)), restored: [...after].filter((s) => !before.has(s)) });
      st = rewind(log, eff, e, tomb);
      voidRows(e); // a rewind that meets a tombstone records it, so Historial says why the old result did not come back
      continue;
    }
    if (['WAIVER_PUBLISHED', 'SIGN_LINK_ISSUED', 'WAIVER_SIGNED', 'MEDIA_CONSENT_GRANTED', 'CONSENT_VERIFIED', 'MEDIA_CONSENT_REVOKED'].includes(e.type)) {
      const p = e.payload;
      // R3-B-03: snapshot WHO the row concerns at the time of the event, so a later rollback that removes the player keeps the audit readable.
      const pl = p.playerId ? st.players[p.playerId] : null;
      const subject = pl ? { number: pl.number, displayName: pl.displayName, teamId: pl.teamId, teamName: st.teams[pl.teamId] ? st.teams[pl.teamId].name : null } : null;
      const c = p.playerId ? st.consents[p.playerId] : null;
      audit.push({ seq: e.seq, ts: e.ts, action: e.type, playerId: p.playerId || null, subject, by: e.actor, active: effSet.has(e.seq),
        detail: { version: p.version ?? null, scope: p.scope || null, signerName: p.signerName || null, relation: p.relation || null, consentSeq: p.consentSeq ?? null, linkId: p.id || null,
          revokesGrantSeq: e.type === 'MEDIA_CONSENT_REVOKED' && c && c.active ? c.grantSeq : null } });
    }
    if (e.type === 'FIXTURES_SWAPPED') { // R5-05: a day-changing action is in the organizer history, with both matches before and after
      const fa = st.fixtures[e.payload.a] || {}, fb = st.fixtures[e.payload.b] || {}, pick = (f) => ({ kickoff: f.kickoff || null, pitch: f.pitch || null, refereeId: f.refereeId || null });
      audit.push({ seq: e.seq, ts: e.ts, action: 'SWAPPED', a: { id: e.payload.a, from: pick(fa), to: pick(fb) }, b: { id: e.payload.b, from: pick(fb), to: pick(fa) }, undoOf: e.payload.undoSeq || null, by: e.actor, active: effSet.has(e.seq) });
    }
    if (e.type === 'FIXTURE_SCHEDULED') { // D205 O1: every (re)schedule is in the organizer history, with what it replaced
      const f = st.fixtures[e.payload.fixtureId] || {};
      audit.push({ seq: e.seq, ts: e.ts, action: 'SCHEDULED', fixtureId: e.payload.fixtureId, from: { kickoff: f.kickoff || null, pitch: f.pitch || null },
        to: { kickoff: e.payload.kickoff ?? f.kickoff ?? null, pitch: e.payload.pitch ?? f.pitch ?? null }, by: e.actor, active: effSet.has(e.seq) });
    }
    if (e.type === 'REPORT_APPROVED') {
      const prev = st.approved[e.payload.fixtureId];
      const rep = (st.reports[e.payload.fixtureId] || []).find((r) => r.version === e.payload.version) || {};
      audit.push({ seq: e.seq, ts: e.ts, fixtureId: e.payload.fixtureId, action: prev ? 'CORRECTED' : 'APPROVED',
        from: prev ? { hg: prev.hg, ag: prev.ag, version: prev.version } : null, to: { hg: rep.hg, ag: rep.ag, version: rep.version },
        reason: e.payload.reason || null, by: e.actor, active: effSet.has(e.seq) });
    }
    apply(st, e); recordTombs(st, tomb);
    // R3-B-02: a KO approval voided by THIS event (rule change, upstream correction, new fixture) gets its own audit row.
    voidRows(e);
  }
  // An approval row is `standing` only if it is the result that counts NOW (not voided, not replaced, not rolled back).
  const valid = view(st).validApproved;
  for (const a of audit) if (a.action === 'APPROVED' || a.action === 'CORRECTED') a.standing = !!(valid[a.fixtureId] && valid[a.fixtureId].approvedSeq === a.seq);
  st.audit = audit;
  if (MEDIA_MOD) MEDIA_MOD.decorate(st); // organizer-only hint: why a media item is hidden
  return st;
}

function participantsOf(st, f, bracketById) {
  if (f.stage === 'group') return { home: f.home, away: f.away };
  const b = bracketById[f.id];
  return { home: b ? b.home.teamId : null, away: b ? b.away.teamId : null };
}

function view(st) {
  const groups = {}, wd = st.withdrawn || {};
  for (const t of Object.values(st.teams)) if (t.groupId && !wd[t.id]) (groups[t.groupId] = groups[t.groupId] || []).push(t.id); // withdrawn teams leave the table and the expected games
  const tables = {}, complete = {}, rounds = (st.format && st.format.rounds) || 1; // unset format = one round
  for (const [g, ids] of Object.entries(groups)) {
    const fx = Object.values(st.fixtures).filter((f) => f.stage === 'group' && f.groupId === g && !wd[f.home] && !wd[f.away]);
    const ms = fx.filter((f) => st.approved[f.id]).map((f) => { const r = st.approved[f.id];
      return { id: f.id, home: f.home, away: f.away, hg: r.hg, ag: r.ag, cards: r.wo ? [] : r.cards, invasion: r.invasion }; });
    tables[g] = computeGroupTable(ids.sort(), ms, st.rules || {});
    // R2-03: complete = the fixtures are EXACTLY the expected games for the chosen format and every one is approved.
    // rounds 1: each unordered pair once. rounds 2: each ordered pair once (ida y vuelta). Missing, extra or duplicated games keep the group open.
    const want = {}, sorted = ids.slice().sort();
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) { if (rounds === 2) { want[sorted[i] + '>' + sorted[j]] = 1; want[sorted[j] + '>' + sorted[i]] = 1; } else want[[sorted[i], sorted[j]].sort().join('|')] = 1; }
    const got = {}; for (const f of fx) { const k = rounds === 2 ? f.home + '>' + f.away : [f.home, f.away].sort().join('|'); got[k] = (got[k] || 0) + 1; }
    const exact = Object.keys(want).length > 0 && Object.keys(want).every((k) => got[k] === 1) && Object.keys(got).every((k) => want[k]);
    complete[g] = fx.length > 0 && exact && fx.every((f) => st.approved[f.id]);
  }
  const locked = lockedPositions(tables, complete, (st.rules && st.rules.qualifiersPerGroup) || null);
  const koLevel = (st.rules && st.rules.koLevel) || 'PENDIENTE';
  const koWinners = {};
  const ko = Object.values(st.fixtures).filter((f) => f.stage === 'ko').sort((a, b) => a.order - b.order);
  const bracket = ko.map((f) => {
    const home = resolveSlot(f.homeSource, locked, koWinners), away = resolveSlot(f.awaySource, locked, koWinners);
    const r = st.approved[f.id];
    // A4-03/A4-06: an approved KO result only stands if it was played by the teams that occupy the slots NOW and has the
    // shape the CURRENT rule requires. Otherwise it is voided in every view (kept in audit) until re-entered and re-approved.
    let invalid = null;
    const q = (st.rules && st.rules.qualifiersPerGroup) || null;
    const ineligible = maxGroupRank(f) > 0 && (!q || maxGroupRank(f) > q) ? (q ? `con la regla actual solo clasifican ${q} por grupo` : 'la regla de clasificación no está confirmada') : null;
    if (r && ineligible) invalid = 'cambió la regla de clasificación';
    else if (r) {
      if (!r.participants || r.participants.home !== home.teamId || r.participants.away !== away.teamId) invalid = 'cambiaron los equipos de este partido';
      else if (koShapeError(r, koLevel)) invalid = 'cambió la regla de eliminatoria';
    }
    if (!r && st.voided[f.id]) invalid = st.voided[f.id].reason;
    const valid = r && !invalid;
    const w = valid && home.teamId && away.teamId ? koWinner(home.teamId, away.teamId, r, koLevel) : null;
    koWinners[f.id] = w;
    return { id: f.id, round: f.round, home, away, result: valid ? { hg: r.hg, ag: r.ag, et: r.et || null, pens: r.pens || null, wo: r.wo || null } : null,
      invalidated: invalid, sourceIneligible: ineligible, winner: w, status: w ? 'Final' : 'Por definir' };
  });
  const qualifiers = (st.rules && st.rules.qualifiersPerGroup) || null;
  for (const [g, t] of Object.entries(tables)) for (const row of t) {
    row.edge = !qualifiers || !complete[g] || row.shared ? 'En disputa' : row.position <= qualifiers ? 'Clasificado' : 'Eliminado';
  }
  const bracketById = Object.fromEntries(bracket.map((b) => [b.id, b]));
  // Which approved results are currently valid (group results always; KO per the check above).
  const validApproved = {};
  for (const [fid, r] of Object.entries(st.approved)) if (st.fixtures[fid].stage === 'group' || (bracketById[fid] && bracketById[fid].result)) validApproved[fid] = r;
  return { tables, complete, bracket, bracketById, koLevel, validApproved };
}

module.exports = { rollbackImpact, tombLedger, recordTombs, rewind, waiverOk, append, verifyChain, replay, view, apply, fresh, foldSeqs, effectiveNodes, seqsOf, hashEvent, participantsOf, GENESIS };

};
defs["/engine/rules"]=function(module,exports,require){'use strict';
const MEDIA_MOD = require('./flags').MEDIA ? require('./media') : null;
// THE single source of what an event may be, given the current state. Used for every live write AND for full replay
// validation of a stored log or an imported backup (A4-05): a history that could not have been written live is refused.
const S = require('./state');
const { ORG_EVENTS, FAMILY_EVENTS, validReport, ID, TEXT, isInt, only } = require('./validate');
const { maxGroupRank, parseSource } = require('./bracket');

const err = (status, error, detail) => ({ status, error, detail });
const has = (m, k) => Object.prototype.hasOwnProperty.call(m, k);
const validActor = (a) => only(a, ['role', 'id']) && ['organizador', 'arbitro', 'familia'].includes(a.role) && typeof a.id === 'string' && ID.test(a.id);

// st: effective state BEFORE the event; seq: the sequence number the event will get.
function checkEvent(st, type, actor, payload, seq) {
  if (!validActor(actor)) return err(403, 'actor_invalido');
  if (type === 'REPORT_SUBMITTED') return checkReport(st, actor, payload);
  if (actor.role === 'familia') return checkFamily(st, type, actor, payload);
  if (actor.role !== 'organizador') return err(403, 'solo_organizador');
  if (type === 'ROLLBACK') {
    if (!only(payload, ['toSeq', 'reason']) || !isInt(payload.toSeq, 0, seq - 1) || typeof payload.reason !== 'string' || !TEXT.test(payload.reason)) return err(422, 'rollback_invalido');
    return null;
  }
  const check = has(ORG_EVENTS, type) ? ORG_EVENTS[type] : null;
  if (!check || !check(payload)) return err(422, 'evento_invalido');
  const p = payload;
  if (type === 'TEAM_ADDED' && has(st.teams, p.id)) return err(409, 'id_repetido');
  if (type === 'TEAM_WITHDRAWN' && (!has(st.teams, p.teamId) || has(st.withdrawn || {}, p.teamId))) return err(409, 'equipo_desconocido_o_ya_retirado');
  if (type === 'PLAYER_ADDED' && (has(st.players, p.id) || !has(st.teams, p.teamId))) return err(409, 'id_repetido_o_equipo_desconocido');
  if (type === 'CONSENT_VERIFIED') {
    if (!has(st.players, p.playerId)) return err(409, 'jugador_desconocido');
    const c = has(st.consents, p.playerId) ? st.consents[p.playerId] : null;
    if (!c || !c.active || c.grantSeq !== p.consentSeq) return err(409, 'consentimiento_no_vigente', 'no hay un consentimiento activo con ese número');
  }
  if (type === 'WAIVER_PUBLISHED' && st.waiver && p.version <= st.waiver.version) return err(409, 'version_no_nueva');
  if (type === 'SIGN_LINK_ISSUED' && (!has(st.players, p.playerId) || has(st.signLinks, p.id))) return err(409, 'jugador_desconocido_o_enlace_repetido');
  if (type === 'MEDIA_CONSENT_REVOKED' && !(has(st.consents, p.playerId) && st.consents[p.playerId].active)) return err(409, 'sin_consentimiento_activo');
  // W1R-01: a knockout source must be a QUALIFYING rank under the confirmed rule when the fixture is created.
  const q = (r) => (r && r.qualifiersPerGroup) || null;
  if (type === 'FIXTURE_ADDED' && p.stage === 'ko' && q(st.rules) && maxGroupRank(p) > q(st.rules)) return err(409, 'fuente_no_clasifica', `solo clasifican ${q(st.rules)} por grupo`);
  // A later RULES_SET that lowers the count is allowed (the contract): the view then voids every KO match drawing from a rank that no longer qualifies.
  if (type === 'FIXTURE_SCHEDULED' && !has(st.fixtures, p.fixtureId)) return err(404, 'partido_desconocido');
  // Slots have a LENGTH (saved with the format; 60 min when never saved): two matches that overlap in time cannot share a pitch, a known team or a referee.
  const cancelled = (f) => !!(st.withdrawn && (st.withdrawn[f.home] || st.withdrawn[f.away])); // a game of a withdrawn team: reserves nothing, counts for nothing
  const slot = (st.format && st.format.slotMinutes) || 60, mins = (k) => (k ? Date.parse(k.slice(0, 16) + ':00Z') / 60000 : NaN);
  const overlap = (a, b) => Number.isFinite(mins(a)) && Number.isFinite(mins(b)) && Math.abs(mins(a) - mins(b)) < slot;
  if (type === 'FIXTURE_REFEREE_SET') {
    if (!has(st.fixtures, p.fixtureId)) return err(404, 'partido_desconocido');
    const me = st.fixtures[p.fixtureId];
    if (cancelled(me)) return err(409, 'partido_cancelado', 'Ese partido se canceló porque un equipo se retiró.');
    for (const f of Object.values(st.fixtures)) if (f.id !== me.id && !cancelled(f) && f.refereeId === p.refereeId && overlap(f.kickoff, me.kickoff)) return err(409, 'choque_de_arbitro', 'Ese árbitro ya tiene otro partido a esa hora.');
  }
  // ONE validator for a proposed fixture state (a fixture being ADDED already scheduled, or an existing one being MOVED): known team twice, pitch twice,
  // referee twice (overlapping in time), knockout before the matches that feed it, a feeder at/after what it feeds. Active (non-cancelled) fixtures only.
  const feedersOf = (f, S0 = st) => { const list = []; for (const src of [f.homeSource, f.awaySource]) { const m = /^[1-9](.+)$/.exec(src || ''), w = /^W:(.+)$/.exec(src || '');
    if (w && has(S0.fixtures, w[1])) list.push(S0.fixtures[w[1]]); else if (m) for (const g of Object.values(S0.fixtures)) if (g.stage === 'group' && g.groupId === m[1] && !cancelled(g)) list.push(g); } return list; };
  const feeds = (me, ko) => [ko.homeSource, ko.awaySource].some((src) => { const m = /^[1-9](.+)$/.exec(src || ''), w = /^W:(.+)$/.exec(src || ''); return (w && w[1] === me.id) || (m && me.stage === 'group' && m[1] === me.groupId); });
  const scheduleProblem = (me, S0 = st) => {
    if (cancelled(me)) return err(409, 'partido_cancelado', 'Ese partido se canceló porque un equipo se retiró.');
    const S1 = has(S0.fixtures, me.id) ? S0 : { ...S0, fixtures: { ...S0.fixtures, [me.id]: me } }; // R5-01: a NEW knockout resolves its participants through the state that includes it
    const v = S.view(S1), teamsOf = (f) => { if (f.stage === 'group') return [f.home, f.away].filter(Boolean); const x = S.participantsOf(S1, f, v.bracketById); return [x.home, x.away].filter(Boolean); };
    const mine = new Set(teamsOf(me));
    if (me.kickoff) for (const f of Object.values(S0.fixtures)) {
      if (f.id === me.id || cancelled(f) || !overlap(f.kickoff, me.kickoff)) continue;
      if (teamsOf(f).some((t) => mine.has(t))) return err(409, 'choque_de_equipo', 'Un equipo ya juega a esa hora en otro partido.');
      if (me.pitch && f.pitch === me.pitch) return err(409, 'cancha_ocupada', 'Esa cancha ya tiene otro partido a esa hora.');
      if (me.refereeId && f.refereeId === me.refereeId) return err(409, 'choque_de_arbitro', 'Ese árbitro ya tiene otro partido a esa hora.');
    }
    if (me.kickoff && me.stage === 'ko' && feedersOf(me, S0).some((g) => g.kickoff && g.kickoff >= me.kickoff)) return err(409, 'orden_de_partidos', 'Este partido debe jugarse después de los partidos que lo alimentan.');
    if (me.kickoff) for (const f of Object.values(S0.fixtures)) if (f.stage === 'ko' && f.kickoff && f.id !== me.id && feeds(me, f) && me.kickoff >= f.kickoff) return err(409, 'orden_de_partidos', 'Otro partido depende de este y quedaría a la misma hora o antes.');
    return null;
  };
  if (MEDIA_MOD) { const bad = MEDIA_MOD.check(st, type, p, has, err); if (bad) return bad; }
  if (type === 'FIXTURES_SWAPPED') { // two matches trade time, pitch and referee: validated as the FINAL state of both
    if (!has(st.fixtures, p.a) || !has(st.fixtures, p.b)) return err(404, 'partido_desconocido');
    const fa = st.fixtures[p.a], fb = st.fixtures[p.b];
    if (cancelled(fa) || cancelled(fb)) return err(409, 'partido_cancelado', 'Un equipo de ese partido se retiró.');
    if (has(st.approved, fa.id) || has(st.approved, fb.id)) return err(409, 'partido_ya_jugado', 'Un partido que ya se jugó no se puede cambiar de lugar.');
    if ([fa, fb].some((f) => (has(st.reports, f.id) ? st.reports[f.id] : []).length)) return err(409, 'partido_con_reporte', 'Un partido que ya tiene un resultado enviado no se puede cambiar de lugar.'); // R5-02
    if (p.undoSeq !== undefined) { // R6-04: undo = the inverse of ONE earlier swap, only while both matches still hold the slots that swap gave them
      const rows = (st.audit || []).filter((x) => x.action === 'SWAPPED'), row = rows.find((x) => x.seq === p.undoSeq);
      if (!row || !row.active || row.undoOf || !((row.a.id === p.a && row.b.id === p.b) || (row.a.id === p.b && row.b.id === p.a))) return err(409, 'cambio_no_deshacible', 'Ese cambio no se puede deshacer.');
      if (rows.some((x) => x.undoOf === p.undoSeq && x.active)) return err(409, 'ya_deshecho', 'Ese cambio ya se deshizo.');
      const same = (f, t) => f.kickoff === (t.kickoff || undefined) && f.pitch === (t.pitch || undefined) && f.refereeId === (t.refereeId || undefined), cur = { [row.a.id]: row.a.to, [row.b.id]: row.b.to };
      if (!same(st.fixtures[row.a.id], cur[row.a.id]) || !same(st.fixtures[row.b.id], cur[row.b.id])) return err(409, 'cambio_posterior', 'Después de ese cambio se movió uno de los partidos. Haz el cambio a mano.');
    }
    const na = { ...fa, kickoff: fb.kickoff, pitch: fb.pitch, refereeId: fb.refereeId }, nb = { ...fb, kickoff: fa.kickoff, pitch: fa.pitch, refereeId: fa.refereeId };
    const S1 = { ...st, fixtures: { ...st.fixtures, [fa.id]: na, [fb.id]: nb } };
    const bad = scheduleProblem(na, S1) || scheduleProblem(nb, S1); if (bad) return bad;
  }
  if (type === 'FIXTURE_SCHEDULED') { // R2-02: impossible schedules are refused (no override)
    const me = st.fixtures[p.fixtureId]; const bad = scheduleProblem({ ...me, ...(p.kickoff !== undefined ? { kickoff: p.kickoff } : {}), ...(p.pitch !== undefined ? { pitch: p.pitch } : {}), ...(p.refereeId !== undefined ? { refereeId: p.refereeId } : {}) }); if (bad) return bad;
  }
  // R4-02: a LONGER slot must not retroactively turn a valid calendar into overlapping matches (an omitted length means "keep the saved one")
  if (type === 'FORMAT_SET' && p.slotMinutes !== undefined && p.slotMinutes !== slot) {
    const sched = Object.values(st.fixtures).filter((f) => f.kickoff && !cancelled(f)), v = S.view(st), teamsOf = (f) => { const x = f.stage === 'group' ? { home: f.home, away: f.away } : S.participantsOf(st, f, v.bracketById); return [x.home, x.away].filter(Boolean); };
    for (let i = 0; i < sched.length; i++) for (let j = i + 1; j < sched.length; j++) { const a = sched[i], b = sched[j]; if (!(Math.abs(mins(a.kickoff) - mins(b.kickoff)) < p.slotMinutes)) continue;
      if ((a.pitch && a.pitch === b.pitch) || (a.refereeId && a.refereeId === b.refereeId) || teamsOf(a).some((t) => teamsOf(b).includes(t))) return err(409, 'calendario_con_choques', 'Con partidos de ese largo, el calendario actual se empalma. Cambia primero las horas.'); }
  }
  if (type === 'FIXTURE_ADDED') {
    if (has(st.fixtures, p.id)) return err(409, 'id_repetido');
    // D205 S1b (causal order is structural): the bracket is evaluated by `order`, so a winner source must name an EXISTING knockout fixture
    // with a SMALLER order. A forward or non-KO reference could never resolve and would leave or void a result for the wrong reason.
    if (p.stage === 'ko') for (const src of [p.homeSource, p.awaySource]) {
      const s = parseSource(src);
      if (s && s.kind === 'winner' && !(has(st.fixtures, s.fixtureId) && st.fixtures[s.fixtureId].stage === 'ko' && st.fixtures[s.fixtureId].order < p.order)) return err(409, 'fuente_fuera_de_orden', 'el ganador que alimenta este partido debe ser de una eliminatoria anterior que ya exista');
    }
    if (p.stage === 'group' && !(has(st.teams, p.home) && has(st.teams, p.away) && st.teams[p.home].groupId === p.groupId && st.teams[p.away].groupId === p.groupId)) return err(409, 'equipos_fuera_del_grupo');
    { const bad = scheduleProblem(p); if (bad && bad.error !== 'partido_cancelado') return bad; } // R4-01: a fixture created already scheduled is held to the same rules as a move
  }
  if (type === 'REPORT_APPROVED') {
    const reps = has(st.reports, p.fixtureId) ? st.reports[p.fixtureId] : [];
    const rep = reps.find((r) => r.version === p.version);
    if (!rep) return err(409, 'reporte_desconocido');
    if (reps[reps.length - 1].version !== p.version) return err(409, 'hay_un_reporte_mas_nuevo');
    if (has(st.voided, p.fixtureId) && rep.version < st.voided[p.fixtureId].voidedSeq) return err(409, 'reporte_anulado', 'ese resultado fue anulado; anota uno nuevo');
    // D205 S1b: a report version that was EVER voided (raw history, survives rollback) can never be approved again.
    if (st.tombs && st.tombs[p.fixtureId] && st.tombs[p.fixtureId].versions.has(p.version)) return err(409, 'reporte_anulado', 'ese resultado fue anulado; anota uno nuevo');
    const v = S.view(st), f = st.fixtures[p.fixtureId];
    const cur = S.participantsOf(st, f, v.bracketById);
    // Re-validate the report under the CURRENT participants and rules (A4-03/A4-06): a stale report cannot be approved.
    if (!rep.participants || rep.participants.home !== cur.home || rep.participants.away !== cur.away) return err(409, 'reporte_desactualizado', 'cambiaron los equipos; anota de nuevo');
    const shape = validReport(stripMeta(rep), f, st.players, cur.home, cur.away, v.koLevel, st.rules && st.rules.walkoverGoals);
    if (shape) return err(409, 'reporte_desactualizado', shape);
    if ((rep.goals || []).some((g) => g.playerId && !S.waiverOk(st, g.playerId))) return err(409, 'reporte_desactualizado', 'jugador sin exoneración firmada');
    const standing = has(v.validApproved, p.fixtureId) ? v.validApproved[p.fixtureId] : null;
    if (standing && standing.version === p.version) return err(409, 'ya_aprobado');
    if (standing && !p.reason) return err(422, 'correccion_sin_motivo');
  }
  return null;
}
// A family acts ONLY through a signing link, and only for the player that link was issued for.
function checkFamily(st, type, actor, p) {
  const check = has(FAMILY_EVENTS, type) ? FAMILY_EVENTS[type] : null;
  if (!check || !check(p)) return err(422, 'evento_invalido');
  const link = has(st.signLinks, actor.id) ? st.signLinks[actor.id] : null;
  if (!link || link.playerId !== p.playerId || !has(st.players, p.playerId)) return err(403, 'enlace_no_valido_para_este_jugador');
  const pl = st.players[p.playerId];
  if ((type === 'WAIVER_SIGNED' || type === 'MEDIA_CONSENT_GRANTED') && pl.isMinor && p.relation !== 'tutor') return err(422, 'menor_requiere_tutor', 'para un menor firma su madre, padre o tutor');
  if ((type === 'WAIVER_SIGNED' || type === 'MEDIA_CONSENT_GRANTED') && !pl.isMinor && p.relation !== 'jugador') return err(422, 'adulto_firma_por_si_mismo');
  if (type === 'WAIVER_SIGNED') {
    if (!st.waiver || p.version !== st.waiver.version || p.textHash !== st.waiver.textHash) return err(409, 'texto_desactualizado', 'el texto de la exoneración cambió; vuelve a leerlo');
    if (S.waiverOk(st, p.playerId)) return err(409, 'ya_firmado');
  }
  if (type === 'MEDIA_CONSENT_REVOKED' && !(has(st.consents, p.playerId) && st.consents[p.playerId].active)) return err(409, 'sin_consentimiento_activo');
  return null;
}
function stripMeta(rep) { const { participants, version, by, approvedSeq, ...r } = rep; return r; }

function checkReport(st, actor, payload) {
  { const f0 = payload && typeof payload.fixtureId === 'string' && has(st.fixtures, payload.fixtureId) ? st.fixtures[payload.fixtureId] : null; if (f0 && f0.stage === 'group' && st.withdrawn && (st.withdrawn[f0.home] || st.withdrawn[f0.away])) return err(409, 'partido_cancelado', 'Ese partido se canceló porque un equipo se retiró.'); }
  if (!only(payload, ['fixtureId', 'report', 'participants', 'opKey']) || (payload.opKey !== undefined && !(typeof payload.opKey === 'string' && ID.test(payload.opKey)))) return err(422, 'reporte_invalido');
  const f = typeof payload.fixtureId === 'string' && has(st.fixtures, payload.fixtureId) ? st.fixtures[payload.fixtureId] : null;
  if (actor.role === 'arbitro' && (!f || f.refereeId !== actor.id)) return err(403, 'partido_no_asignado');
  if (!f) return err(404, 'partido_desconocido');
  const v = S.view(st);
  const cur = S.participantsOf(st, f, v.bracketById);
  if (!cur.home || !cur.away) return err(409, 'equipos_por_definir');
  if (!payload.participants || payload.participants.home !== cur.home || payload.participants.away !== cur.away) return err(409, 'participantes_no_coinciden');
  if (actor.role === 'arbitro' && has(v.validApproved, f.id)) return err(409, 'ya_aprobado', 'una corrección la hace el organizador');
  const e = validReport(payload.report, f, st.players, cur.home, cur.away, v.koLevel, st.rules && st.rules.walkoverGoals);
  if (e) return err(422, 'reporte_invalido', e);
  const unsigned = (payload.report.goals || []).filter((g) => g.playerId && !S.waiverOk(st, g.playerId));
  if (unsigned.length) return err(422, 'reporte_invalido', 'jugador sin exoneración firmada');
  return null;
}

// Full semantic validation of a whole history (stored log at startup, or an imported backup).
function validateLog(log, key) {
  const c = S.verifyChain(log, key);
  if (!c.ok) return { ok: false, at: c.at, error: 'cadena_rota' };
  const eff = [null];
  const tomb = S.tombLedger(); // D205 S1b: the same durable-void ledger as replay(), so live and startup/import validation never diverge
  let st = S.fresh(); st.tombs = tomb;
  for (const e of log) {
    if (!only(e, ['seq', 'ts', 'type', 'actor', 'payload', 'prevHash', 'hash']) || typeof e.ts !== 'string') return { ok: false, at: e.seq, error: 'evento_malformado' };
    // Compatibility is limited to inert, shape-checked historical records in the OFF build.
    if (!MEDIA_MOD && require('./legacy-inert').has(e.type)) {
      if (!validActor(e.actor) || e.actor.role !== 'organizador' || !require('./legacy-inert').valid(e.type, e.payload)) return { ok: false, at: e.seq, error: 'evento_legacy_invalido' };
      eff.push({ seq: e.seq, prev: eff[e.seq - 1] }); continue;
    }
    const bad = checkEvent(st, e.type, e.actor, e.payload, e.seq);
    if (bad) return { ok: false, at: e.seq, error: bad.error, detail: bad.detail };
    if (e.type === 'ROLLBACK') { eff.push(eff[e.payload.toSeq]); st = S.rewind(log, eff, e, tomb); }
    else { eff.push({ seq: e.seq, prev: eff[e.seq - 1] }); S.apply(st, e); S.recordTombs(st, tomb); }
  }
  return { ok: true, length: log.length, head: c.head };
}

// T-1109 (TOR-T1106-03): «Publicar» as ONE organizer operation: the report and its approval are written together or not at all. `opKey` makes a retry safe: the same key with the same
// content answers «already done» without writing; the same key with other content is refused. Returns { reply:{status,body} } or { events, version }; each caller commits with its own commitMany.
const canon = (v) => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v));
function planPublish(log, st, body) {
  const reply = (status, b) => ({ reply: { status, body: b } });
  if (!body || !only(body, ['fixtureId', 'report', 'participants', 'opKey']) || typeof body.opKey !== 'string' || !ID.test(body.opKey) || typeof body.fixtureId !== 'string' || !body.participants || !only(body.participants, ['home', 'away']) || typeof body.participants.home !== 'string' || typeof body.participants.away !== 'string') return reply(422, { error: 'cuerpo_invalido' });
  const prior = log.find((e) => e.type === 'REPORT_SUBMITTED' && e.payload.opKey === body.opKey);
  if (prior) {
    if (prior.payload.fixtureId !== body.fixtureId || canon(prior.payload.report) !== canon(body.report)) return reply(409, { error: 'op_repetida', detail: 'Ya se publicó otro marcador con este formulario. Recarga la pantalla.' });
    const standing = S.view(st).validApproved[body.fixtureId];
    return standing && standing.version === prior.seq ? reply(200, { version: prior.seq, repeated: true }) : reply(409, { error: 'publicacion_deshecha', detail: 'Ese marcador ya no está publicado. Anótalo de nuevo.' });
  }
  const f = has(st.fixtures, body.fixtureId) ? st.fixtures[body.fixtureId] : null; if (!f) return reply(404, { error: 'partido_desconocido' });
  const cur = S.participantsOf(st, f, S.view(st).bracketById);
  if (body.participants.home !== cur.home || body.participants.away !== cur.away) return reply(409, { error: 'equipos_cambiaron', detail: 'Cambiaron los equipos de este partido. Anota el resultado de nuevo.' });
  const version = log.length + 1;
  return { version, events: [{ type: 'REPORT_SUBMITTED', payload: { fixtureId: body.fixtureId, report: body.report, participants: cur, opKey: body.opKey } }, { type: 'REPORT_APPROVED', payload: { fixtureId: body.fixtureId, version } }] };
}
module.exports = { checkEvent, validateLog, planPublish };

};
defs["/engine/validate"]=function(module,exports,require){'use strict';
const { koShapeError, parseSource } = require('./bracket');
const { matchesPreset } = require('./presets');
// Closed-list input validation (restrict what input CAN be; never detect what is bad).
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/; // must start alphanumeric: '__proto__'-style keys are not ids
const TEXT = /^[\p{L}\p{N} .,'()\-]{1,60}$/u;
// Closed list of tiebreak criteria: UEFA-style h2h_* and an alternative order (won, gd, gf, h2h_result, fairplay, ga_fewest, sorteo).
const TIEBREAKS = ['h2h_points', 'h2h_gd', 'h2h_gf', 'h2h_result', 'won', 'gd', 'gf', 'fairplay', 'ga_fewest', 'sorteo', 'PENDIENTE'];
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const only = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));
const goals = (s) => isInt(s.hg, 0, 99) && isInt(s.ag, 0, 99);
const score = (s) => only(s, ['hg', 'ag']) && goals(s);

// Public media (videos/albums) lives in engine/media.js and exists ONLY when the build flag is on (engine/flags.js). Default: OFF, the event types do not exist.
const { MEDIA } = require('./flags'), media = MEDIA ? require('./media') : null;
const ORG_EVENTS = {
  TOURNAMENT_SET: (p) => only(p, ['name', 'date']) && TEXT.test(p.name) && (p.date === undefined || /^\d{4}-\d{2}-\d{2}$/.test(p.date)),
  RULES_SET: (p) => only(p, ['points', 'tiebreak', 'koLevel', 'qualifiersPerGroup', 'walkoverGoals', 'preset'])
    && (p.points === undefined || (only(p.points, ['win', 'draw', 'loss']) && ['win', 'draw', 'loss'].every((k) => isInt(p.points[k], 0, 9))))
    && (p.tiebreak === undefined || (Array.isArray(p.tiebreak) && p.tiebreak.length <= 8 && new Set(p.tiebreak).size === p.tiebreak.length && p.tiebreak.every((c) => TIEBREAKS.includes(c))))
    && (p.walkoverGoals === undefined || isInt(p.walkoverGoals, 1, 9))
    && (p.preset === undefined || matchesPreset(p))
    && (p.koLevel === undefined || ['ET_THEN_PENS', 'PENS', 'PENDIENTE'].includes(p.koLevel))
    && (p.qualifiersPerGroup === undefined || isInt(p.qualifiersPerGroup, 1, 8)),
  FORMAT_SET: (p) => only(p, ['rounds', 'slotMinutes']) && (p.rounds === 1 || p.rounds === 2) && (p.slotMinutes === undefined || isInt(p.slotMinutes, 15, 240)),
  FIXTURES_SWAPPED: (p) => only(p, ['a', 'b', 'undoSeq']) && ID.test(p.a) && ID.test(p.b) && p.a !== p.b && (p.undoSeq === undefined || isInt(p.undoSeq, 1, 1e9)),
  NAMES_PUBLIC_SET: (p) => only(p, ['adults']) && typeof p.adults === 'boolean',
  FIXTURE_REFEREE_SET: (p) => only(p, ['fixtureId', 'refereeId']) && ID.test(p.fixtureId) && ID.test(p.refereeId),
  TEAM_WITHDRAWN: (p) => only(p, ['teamId', 'reason']) && ID.test(p.teamId) && (p.reason === undefined || TEXT.test(p.reason)),
  TEAM_ADDED: (p) => only(p, ['id', 'name', 'groupId']) && ID.test(p.id) && TEXT.test(p.name) && (p.groupId === undefined || ID.test(p.groupId)),
  PLAYER_ADDED: (p) => only(p, ['id', 'teamId', 'displayName', 'number', 'isMinor', 'guardianContact']) && ID.test(p.id) && ID.test(p.teamId)
    && TEXT.test(p.displayName) && isInt(p.number, 0, 99) && typeof p.isMinor === 'boolean'
    && (p.guardianContact === undefined || (typeof p.guardianContact === 'string' && p.guardianContact.length <= 80)),
  CONSENT_VERIFIED: (p) => only(p, ['playerId', 'method', 'consentSeq']) && ID.test(p.playerId) && ['firma_tutor_verificada'].includes(p.method) && isInt(p.consentSeq, 1, 1e9),
  WAIVER_PUBLISHED: (p) => only(p, ['version', 'text']) && isInt(p.version, 1, 999) && typeof p.text === 'string' && p.text.length >= 20 && p.text.length <= 4000 && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(p.text),
  SIGN_LINK_ISSUED: (p) => only(p, ['id', 'playerId', 'tokenHash']) && ID.test(p.id) && ID.test(p.playerId) && /^[0-9a-f]{64}$/.test(p.tokenHash),
  MEDIA_CONSENT_REVOKED: (p) => only(p, ['playerId']) && ID.test(p.playerId),
  FIXTURE_ADDED: (p) => only(p, ['id', 'stage', 'groupId', 'home', 'away', 'round', 'order', 'homeSource', 'awaySource', 'refereeId', 'kickoff', 'pitch'])
    && ID.test(p.id) && ['group', 'ko'].includes(p.stage)
    && (p.stage === 'group' ? ID.test(p.groupId) && ID.test(p.home) && ID.test(p.away) && p.home !== p.away
      : TEXT.test(p.round) && isInt(p.order, 1, 999) && parseSource(p.homeSource) !== null && parseSource(p.awaySource) !== null)
    && (p.refereeId === undefined || ID.test(p.refereeId))
    && (p.kickoff === undefined || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p.kickoff))
    && (p.pitch === undefined || TEXT.test(p.pitch)),
  // D205 O1: schedule (date-time and pitch) is a separate, audited, re-schedulable fact; FIXTURE_ADDED stays immutable.
  FIXTURE_SCHEDULED: (p) => only(p, ['fixtureId', 'kickoff', 'pitch', 'refereeId']) && ID.test(p.fixtureId) && (p.kickoff !== undefined || p.pitch !== undefined || p.refereeId !== undefined) && (p.refereeId === undefined || ID.test(p.refereeId))
    && (p.kickoff === undefined || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p.kickoff)) && (p.pitch === undefined || TEXT.test(p.pitch)),
  REPORT_APPROVED: (p) => only(p, ['fixtureId', 'version', 'reason']) && ID.test(p.fixtureId) && isInt(p.version, 1, 1e9) && (p.reason === undefined || TEXT.test(p.reason)),
};

// A result report: score, optional extra time / shoot-out, goals [{playerId?, minute, side}].
// homeId/awayId = the teams actually playing (resolved participants); every attributed scorer must belong to the side credited.
function validReport(r, fixture, players, homeId, awayId, koLevel, walkoverGoals) {
  if (!only(r, ['hg', 'ag', 'et', 'pens', 'goals', 'wo', 'cards', 'invasion']) || !goals(r)) return 'marcador inválido';
  // W.O. (reglamento "Puntualidad"): `wo` = the side that did NOT show; only under a confirmed walkoverGoals; official score, no goals.
  if (r.wo !== undefined) {
    if (!['h', 'a'].includes(r.wo)) return 'W.O. inválido';
    if (!walkoverGoals) return 'la regla de W.O. no está confirmada';
    const present = r.wo === 'h' ? r.ag : r.hg, absent = r.wo === 'h' ? r.hg : r.ag;
    if (present !== walkoverGoals || absent !== 0) return `el marcador oficial de un W.O. es ${walkoverGoals}-0`;
    if (r.et || r.pens || (r.goals && r.goals.length) || (r.cards && r.cards.length) || (r.invasion && r.invasion.length)) return 'un W.O. no lleva goles, prórroga, penales ni tarjetas';
  }
  // Cards: present (even empty) = recorded; absent = not recorded (fair play stays unknown, never zero).
  if (r.cards !== undefined) {
    if (!Array.isArray(r.cards) || r.cards.length > 60) return 'tarjetas inválidas';
    for (const c of r.cards) {
      if (!only(c, ['playerId', 'minute', 'side', 'kind']) || !['h', 'a'].includes(c.side) || !['amarilla', 'expulsion'].includes(c.kind) || !isInt(c.minute, 1, 130)) return 'tarjeta inválida';
      if (c.playerId !== undefined) {
        const p = ID.test(c.playerId) && Object.prototype.hasOwnProperty.call(players, c.playerId) ? players[c.playerId] : null;
        if (!p) return 'jugador desconocido';
        if (p.teamId !== (c.side === 'h' ? homeId : awayId)) return 'la tarjeta no es de ese equipo';
      }
    }
  }
  if (r.invasion !== undefined && (r.cards === undefined || !Array.isArray(r.invasion) || r.invasion.length > 2 || !r.invasion.every((x) => ['h', 'a'].includes(x)) || new Set(r.invasion).size !== r.invasion.length)) return 'invasión inválida';
  if (r.et !== undefined && !score(r.et)) return 'prórroga inválida';
  if (r.pens !== undefined && !score(r.pens)) return 'penales inválidos';
  if (fixture.stage !== 'ko') { if (r.et || r.pens) return 'prórroga/penales solo en eliminatorias'; }
  else { const e = koShapeError(r, koLevel); if (e) return e; }
  if (r.goals !== undefined) {
    if (!Array.isArray(r.goals) || r.goals.length > 40) return 'goles inválidos';
    const side = { h: 0, a: 0 };
    for (const g of r.goals) {
      if (!only(g, ['playerId', 'minute', 'side']) || !['h', 'a'].includes(g.side) || (g.minute !== undefined && !isInt(g.minute, 1, 130))) return 'gol inválido'; // the minute is optional (the referee may not know it)
      if (g.playerId !== undefined) {
        const p = ID.test(g.playerId) && Object.prototype.hasOwnProperty.call(players, g.playerId) ? players[g.playerId] : null;
        if (!p) return 'jugador desconocido';
        if (p.teamId !== (g.side === 'h' ? homeId : awayId)) return 'el goleador no es de ese equipo';
      }
      side[g.side]++;
    }
    const regH = r.hg + (r.et ? r.et.hg : 0), regA = r.ag + (r.et ? r.et.ag : 0);
    if (side.h !== regH || side.a !== regA) return 'los goles no cuadran con el marcador';
  }
  return null;
}

// Family (signing-link) events: closed lists. mark = drawn signature as a compact path "M x y L x y ..." (ints).
const MARK = /^(?:[ML] \d{1,4} \d{1,4} ?){2,800}$/;
const SCOPES = ['perfil', 'foto', 'video', 'destacados'];
const FAMILY_EVENTS = {
  WAIVER_SIGNED: (p) => only(p, ['playerId', 'version', 'textHash', 'signerName', 'relation', 'accepted', 'mark']) && ID.test(p.playerId) && isInt(p.version, 1, 999)
    && /^[0-9a-f]{64}$/.test(p.textHash) && TEXT.test(p.signerName) && ['jugador', 'tutor'].includes(p.relation) && p.accepted === true && typeof p.mark === 'string' && p.mark.length <= 8000 && MARK.test(p.mark),
  MEDIA_CONSENT_GRANTED: (p) => only(p, ['playerId', 'scope', 'signerName', 'relation', 'mark']) && ID.test(p.playerId) && Array.isArray(p.scope) && p.scope.length >= 1
    && p.scope.length <= SCOPES.length && p.scope.every((x) => SCOPES.includes(x)) && new Set(p.scope).size === p.scope.length
    && TEXT.test(p.signerName) && ['jugador', 'tutor'].includes(p.relation) && typeof p.mark === 'string' && p.mark.length <= 8000 && MARK.test(p.mark),
  MEDIA_CONSENT_REVOKED: (p) => only(p, ['playerId']) && ID.test(p.playerId),
};

if (media) Object.assign(ORG_EVENTS, media.events({ only, ID, isInt }));
module.exports = { ORG_EVENTS, FAMILY_EVENTS, SCOPES, TIEBREAKS, validReport, ID, TEXT, isInt, only };

};
defs["/engine/bracket"]=function(module,exports,require){'use strict';
// Knockout progression. RULES-GROUPS-KNOCKOUT §3.3-§3.5: no projections; a slot holds a team only when its source
// position is locked; a winner exists only from an approved result whose SHAPE matches the confirmed KO rule.

// What a valid knockout report must look like under the confirmed rule (null = valid).
// et = goals scored in extra time only; pens = shoot-out (never goals).
function koShapeError(r, level) {
  if (!r) return 'sin resultado';
  const tie = r.hg === r.ag;
  if (!tie) return r.et || r.pens ? 'prórroga/penales solo con empate' : null;
  if (level === 'PENS') {
    if (r.et) return 'este torneo no tiene prórroga';
    if (!r.pens) return 'faltan los penales';
    return r.pens.hg === r.pens.ag ? 'los penales no pueden quedar empatados' : null;
  }
  if (level === 'ET_THEN_PENS') {
    if (!r.et) return 'falta la prórroga';
    if (r.et.hg !== r.et.ag) return r.pens ? 'no hay penales si la prórroga tuvo ganador' : null;
    if (!r.pens) return 'faltan los penales';
    return r.pens.hg === r.pens.ag ? 'los penales no pueden quedar empatados' : null;
  }
  return r.et || r.pens ? 'la regla de eliminatoria está pendiente' : null; // PENDIENTE: only the score is recordable
}

// Winner of an approved knockout result, or null ("Por definir").
function koWinner(home, away, r, koLevel) {
  if (!r || koShapeError(r, koLevel)) return null;
  if (r.hg !== r.ag) return r.hg > r.ag ? home : away;
  if (koLevel === 'ET_THEN_PENS' && r.et.hg !== r.et.ag) return r.et.hg > r.et.ag ? home : away;
  if (koLevel === 'ET_THEN_PENS' || koLevel === 'PENS') return r.pens.hg > r.pens.ag ? home : away;
  return null;
}

// R3-B-05: the ONE grammar for a KO slot source, shared by validation and resolution. Ids use the same grammar as every other id.
//   '<rank 1-9><groupId>' (e.g. '1A', '2G-1') = that position of a group · 'W:<fixtureId>' (e.g. 'W:SF-1') = winner of a KO match.
const SRC_ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,31}';
const RANK_SRC = new RegExp(`^([1-9])(${SRC_ID})$`), WIN_SRC = new RegExp(`^W:(${SRC_ID})$`);
function parseSource(label) {
  if (typeof label !== 'string') return null;
  let m = RANK_SRC.exec(label);
  if (m) return { kind: 'rank', rank: Number(m[1]), group: m[2] };
  m = WIN_SRC.exec(label);
  return m ? { kind: 'winner', fixtureId: m[1] } : null;
}

// Resolve a slot source label (see parseSource).
function resolveSlot(label, lockedPositions, koWinners) {
  const s = parseSource(label);
  const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null); // ids like 'constructor' never hit the prototype
  const t = !s ? null : s.kind === 'rank' ? own(own(lockedPositions, s.group), s.rank) : own(koWinners, s.fixtureId);
  return t ? { teamId: t, label, status: 'locked' } : { teamId: null, label, status: 'Por definir' };
}

// Locked positions: only when the group is COMPLETE, the position is not shared, AND the position qualifies under the CONFIRMED
// qualifiersPerGroup (W1R-01). No confirmed qualifier count = nothing locks (never an early or unconfirmed projection).
function lockedPositions(groupTables, groupComplete, qualifiers) {
  const out = {};
  for (const [g, table] of Object.entries(groupTables)) {
    out[g] = {};
    if (!groupComplete[g] || !qualifiers) continue;
    for (const row of table) if (!row.shared && row.position <= qualifiers) out[g][row.position] = row.teamId;
  }
  return out;
}
// Highest group rank a knockout fixture draws from ('2A' -> 2; 'W:SF1' -> 0).
function maxGroupRank(f) { let m = 0; for (const src of [f.homeSource, f.awaySource]) { const s = parseSource(src); if (s && s.kind === 'rank') m = Math.max(m, s.rank); } return m; }

module.exports = { koWinner, koShapeError, resolveSlot, lockedPositions, maxGroupRank, parseSource };

};
defs["/engine/standings"]=function(module,exports,require){'use strict';
// Deterministic group standings. Pure functions; no I/O.
// Rules (RULES-GROUPS-KNOCKOUT §3): only APPROVED results count; one match counts once (latest approved version);
// unconfirmed criteria are never applied silently -> teams still level share the position and are flagged.

const PENDING = 'PENDIENTE';

function blankRow(teamId) {
  return { teamId, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: null, fairplay: 1000, cardsMissing: 0 };
}
// Fair-play points: start 1000; amarilla −10; expulsión −20; invasión del campo −30.
const FAIRPLAY = { amarilla: 10, expulsion: 20, invasion: 30 };

// matches: [{id, home, away, hg, ag}] already filtered to approved group matches of one group.
function tally(teamIds, matches, pointsRule) {
  const rows = new Map(teamIds.map((t) => [t, blankRow(t)]));
  for (const m of matches) {
    const h = rows.get(m.home), a = rows.get(m.away);
    if (!h || !a) continue;
    h.played++; a.played++;
    h.gf += m.hg; h.ga += m.ag; a.gf += m.ag; a.ga += m.hg;
    if (m.hg > m.ag) { h.won++; a.lost++; } else if (m.hg < m.ag) { a.won++; h.lost++; } else { h.drawn++; a.drawn++; }
    // Missing is never zero: a match without recorded cards makes fair play unknown for both teams.
    if (!Array.isArray(m.cards)) { h.cardsMissing++; a.cardsMissing++; continue; }
    for (const c of m.cards) (c.side === 'h' ? h : a).fairplay -= FAIRPLAY[c.kind] || 0;
    for (const side of m.invasion || []) (side === 'h' ? h : a).fairplay -= FAIRPLAY.invasion;
  }
  for (const r of rows.values()) {
    r.gd = r.gf - r.ga;
    r.points = pointsRule ? r.won * pointsRule.win + r.drawn * pointsRule.draw + r.lost * pointsRule.loss : null;
  }
  return rows;
}

const OVERALL = {
  points: (r) => r.points,
  won: (r) => r.won,
  gd: (r) => r.gd,
  gf: (r) => r.gf,
  ga_fewest: (r) => -r.ga,
  fairplay: (r) => r.fairplay,
};
// Criteria that are never computed: the remaining tied teams share the position, with the reason.
const STOP = {
  PENDIENTE: 'pendiente de confirmar regla',
  sorteo: 'empate: se decide por sorteo del Comité',
};

// Split a list of team ids into ordered buckets by a numeric key (desc). Returns array of arrays.
function splitBy(ids, keyFn) {
  const sorted = [...ids].sort((x, y) => keyFn(y) - keyFn(x));
  const out = [];
  for (const id of sorted) {
    const last = out[out.length - 1];
    if (last && keyFn(last[0]) === keyFn(id)) last.push(id); else out.push([id]);
  }
  return out;
}

// Resolve a set of teams that are level on points (UEFA Art. 30.01 style):
// apply criteria in order; head-to-head criteria use a mini-table of ONLY the tied teams' matches;
// a split by a head-to-head criterion restarts the list on each still-tied subset (Art. 30.01 d); a split by an overall criterion continues with the next one.
// A PENDIENTE criterion stops ordering: the remaining teams share the position and are flagged. Never guessed.
function resolveTie(ids, criteria, ctx) {
  if (ids.length <= 1) return [{ ids, flag: null }];
  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i], rest = criteria.slice(i + 1);
    if (Object.prototype.hasOwnProperty.call(STOP, c)) return [{ ids: [...ids].sort(), flag: STOP[c] }];
    // Reglamento "resultado entre ambos equipos": only defined for TWO teams; 3+ is left to the organizer, never guessed.
    if (c === 'h2h_result' && ids.length !== 2) return [{ ids: [...ids].sort(), flag: 'empate de 3 o más equipos: «resultado entre ambos» no lo resuelve — decide el Comité' }];
    if (c === 'fairplay') {
      const missing = ids.filter((id) => ctx.rows.get(id).cardsMissing > 0);
      if (missing.length) return [{ ids: [...ids].sort(), flag: 'Juego Limpio: faltan tarjetas por registrar — decide el Comité' }];
    }
    let keyFn;
    if (c.startsWith('h2h_')) {
      const set = new Set(ids);
      const mini = tally(ids, ctx.matches.filter((m) => set.has(m.home) && set.has(m.away)), ctx.pointsRule);
      const k = c === 'h2h_result' ? 'points' : c.slice(4);
      keyFn = (id) => OVERALL[k](mini.get(id));
    } else {
      keyFn = (id) => OVERALL[c](ctx.rows.get(id));
    }
    const buckets = splitBy(ids, keyFn);
    // UEFA 30.01 d): only a split produced by a HEAD-TO-HEAD criterion restarts the list for the remaining tied subset.
    // A split produced by an overall criterion continues with the NEXT criterion (A4-02).
    if (buckets.length > 1) return buckets.flatMap((bk) => resolveTie(bk, c.startsWith('h2h_') ? criteria : rest, ctx));
  }
  return [{ ids: [...ids].sort(), flag: 'empate no resuelto por las reglas confirmadas' }];
}

// group: {teamIds}, matches: approved group matches, rules: {points: {win,draw,loss}|null, tiebreak: [..]|null}
function computeGroupTable(teamIds, matches, rules) {
  const pointsRule = rules && rules.points ? rules.points : null;
  const rows = tally(teamIds, matches, pointsRule);
  const criteria = rules && Array.isArray(rules.tiebreak) && rules.tiebreak.length ? rules.tiebreak : [PENDING];
  let buckets;
  if (!pointsRule) {
    buckets = [{ ids: [...teamIds].sort(), flag: 'pendiente de confirmar regla' }]; // G-2 unconfirmed: no points, no order
  } else {
    const ctx = { rows, matches, pointsRule };
    buckets = splitBy(teamIds, (id) => rows.get(id).points).flatMap((bk) => resolveTie(bk, criteria, ctx));
  }
  const table = [];
  let pos = 1;
  for (const b of buckets) {
    for (const id of b.ids) table.push({ ...rows.get(id), position: pos, shared: b.ids.length > 1, flag: b.ids.length > 1 ? b.flag : null });
    pos += b.ids.length;
  }
  return table;
}

module.exports = { computeGroupTable, PENDING, tally };

};
defs["/engine/presets"]=function(module,exports,require){'use strict';
// DEMO-ONLY preset: synthetic metadata. The real preset (document fingerprints, event name, source line numbers and quotations) is never bundled.
const REGLAMENTO = { file: 'ejemplo', sha256: null, title: 'Reglas de ejemplo' };
const PRESETS = { DEMO_REGLAS: { label: 'Reglas de ejemplo', source: REGLAMENTO,
  rules: { preset: 'DEMO_REGLAS', points: { win: 3, draw: 1, loss: 0 }, tiebreak: ['won', 'gd', 'gf', 'h2h_result', 'fairplay', 'ga_fewest', 'sorteo'], walkoverGoals: 3, qualifiersPerGroup: 2, koLevel: 'PENS' },
  citations: { points: { section: 'Puntaje', text: 'Victoria 3, empate 1, derrota 0 (ejemplo)' }, tiebreak: { section: 'Desempates', text: 'Orden de ejemplo' }, walkoverGoals: { section: 'Puntualidad', text: 'W.O.: marcador oficial 3-0 (ejemplo)' } } } };
const DEFAULT_PRESET = null;
const canon = (v) => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v));
const matchesPreset = (rules) => !!(rules && typeof rules.preset === 'string' && Object.prototype.hasOwnProperty.call(PRESETS, rules.preset) && canon(rules) === canon(PRESETS[rules.preset].rules));
const presetLabel = (id) => (id && Object.prototype.hasOwnProperty.call(PRESETS, id) ? PRESETS[id].label : null);
module.exports = { PRESETS, DEFAULT_PRESET, presetLabel, matchesPreset, REGLAMENTO };
};
defs["/engine/public"]=function(module,exports,require){'use strict';
const MEDIA_MOD = require('./flags').MEDIA ? require('./media') : null;
const S = require('./state');
const { presetLabel, matchesPreset } = require('./presets');
// The ONLY projection the public may see. Built from an allowlist: anything not copied here is not public.
// Never: player contact, guardian contact, unapproved reports, audit actors. Minors: NEVER named (D205 R3-B-01 strict default,
// head-accepted): a revocable identity cannot be withdrawn from a page already open or saved offline, so it never reaches one.
// Consent is still recorded and verified (organizer-only); relaxing this needs Dad's answer to T31 and a new review.
// R3-05: a name is public only if the player is an adult AND the organizer chose to show adult names AND (when a waiver exists) the player signed it.
// Otherwise «#número · equipo» (a number is enough for a family to follow a scorer).
const isNamed = (st, pid) => { const p = st.players[pid]; return !!(p && !p.isMinor && st.publicNames && st.publicNames.adults === true && S.waiverOk(st, pid)); };
function playerLabel(p, teams, named) {
  if (!p) return 'Jugador';
  const team = teams[p.teamId] ? teams[p.teamId].name : '';
  return named ? `${p.displayName} · ${team}` : `#${p.number} · ${team}`;
}

function publicView(st, v) {
  const teams = st.teams;
  const name = (id) => (teams[id] ? teams[id].name : null);
  const fixtures = Object.values(st.fixtures).map((f) => {
    const r = v.validApproved[f.id]; // only results that stand NOW (KO voided by upstream corrections/rule changes excluded)
    const b0 = f.stage === 'ko' ? v.bracket.find((x) => x.id === f.id) : null;
    const base = { id: f.id, stage: f.stage, groupId: f.groupId || null, round: f.round || null, kickoff: f.kickoff || null, pitch: f.pitch || null };
    if (f.stage === 'group') Object.assign(base, { home: name(f.home), away: name(f.away) });
    else { const b = v.bracket.find((x) => x.id === f.id);
      Object.assign(base, { home: b.home.teamId ? name(b.home.teamId) : null, homeSource: f.homeSource, away: b.away.teamId ? name(b.away.teamId) : null, awaySource: f.awaySource }); }
    const gone = !!((st.withdrawn || {})[f.home] || (st.withdrawn || {})[f.away]); // R2-03: a match of a withdrawn team does not count
    base.result = r && !gone ? { hg: r.hg, ag: r.ag, et: r.et || null, pens: r.pens || null, wo: r.wo || null } : null;
    const voidReason = b0 && b0.invalidated ? b0.invalidated : st.voided[f.id] ? st.voided[f.id].reason : null; // D205 R1-P1-1: group voids too
    base.status = gone ? 'Equipo retirado: este partido no cuenta' : r ? 'Final' : voidReason ? 'Resultado anulado: ' + voidReason + '. Pendiente de volver a anotar.' : 'Por jugar';
    // R6-03: ONE explicit lifecycle, computed from RESOLVED participants (never from raw knockout fields): finished | withdrawn | annulled | unresolved | playable
    { const wd = st.withdrawn || {}, ids = f.stage === 'group' ? [f.home, f.away] : (() => { const b = v.bracket.find((x) => x.id === f.id); return [b.home.teamId, b.away.teamId]; })();
      base.lifecycle = base.result ? 'finished' : (gone || ids.some((t) => t && wd[t])) ? 'withdrawn' : !ids.every(Boolean) ? 'unresolved' /* R7-05: no two teams = never playable, even if a result was annulled */ : voidReason ? 'annulled' : 'playable';
      if (base.lifecycle === 'withdrawn') base.status = 'Equipo retirado: este partido no cuenta'; else if (base.lifecycle === 'unresolved' && !voidReason) base.status = 'Por definir'; /* an annulled result keeps its explanation */ }
    base.corrected = !!st.corrected[f.id];
    if (r && !gone) base.goals = (r.goals || []).map((g) => { const pl = g.playerId ? st.players[g.playerId] : null; const listed = pl && S.waiverOk(st, g.playerId);
      return { side: g.side, minute: g.minute === undefined ? null : g.minute, label: listed ? (isNamed(st, g.playerId) ? pl.displayName : `#${pl.number}`) : null }; }).sort((a, b) => (a.minute === null ? 1e9 : a.minute) - (b.minute === null ? 1e9 : b.minute));
    return base;
  });
  const scorers = new Map();
  for (const [fid, r] of Object.entries(v.validApproved)) for (const g of (((st.withdrawn || {})[(st.fixtures[fid] || {}).home] || (st.withdrawn || {})[(st.fixtures[fid] || {}).away]) ? [] : (r.goals || []))) {
    if (!g.playerId) continue; // unattributed goal: counted in the score, not in the scorer list
    if (!S.waiverOk(st, g.playerId)) continue; // W2-B-04: no credit while the player lacks the CURRENT waiver (score itself unchanged)
    scorers.set(g.playerId, (scorers.get(g.playerId) || 0) + 1);
  }
  const scorerList = [...scorers.entries()].map(([pid, n]) => ({ label: playerLabel(st.players[pid], teams, isNamed(st, pid)), goals: n }))
    .sort((a, b) => b.goals - a.goals || a.label.localeCompare(b.label));
  // form: the last results of each team in its group (oldest first): G ganó, E empató, P perdió. Matches of withdrawn teams never count.
  const wd = st.withdrawn || {}, formOf = {};
  for (const f of Object.values(st.fixtures).filter((x) => x.stage === 'group' && v.validApproved[x.id] && !wd[x.home] && !wd[x.away]).sort((a, b) => (a.kickoff || '').localeCompare(b.kickoff || '') || a.id.localeCompare(b.id))) {
    const r = v.validApproved[f.id]; const res = r.hg === r.ag ? ['E', 'E'] : r.hg > r.ag ? ['G', 'P'] : ['P', 'G'];
    (formOf[f.home] = formOf[f.home] || []).push(res[0]); (formOf[f.away] = formOf[f.away] || []).push(res[1]);
  }
  const live = Object.values(st.fixtures).filter((f) => !wd[f.home] && !wd[f.away]), done = live.filter((f) => v.validApproved[f.id]);
  const goalsN = done.reduce((n, f) => { const r = v.validApproved[f.id]; return n + r.hg + r.ag + (r.et ? r.et.hg + r.et.ag : 0); }, 0);
  const stats = { played: done.length, total: live.length, goals: goalsN, perMatch: done.length ? Math.round((goalsN / done.length) * 10) / 10 : 0 };
  const tables = Object.fromEntries(Object.entries(v.tables).map(([g, t]) => [g, t.map((r) => ({ form: (formOf[r.teamId] || []).slice(-5),
    position: r.position, shared: r.shared, flag: r.flag, team: name(r.teamId), played: r.played, won: r.won, drawn: r.drawn, lost: r.lost,
    gf: r.gf, ga: r.ga, gd: r.gd, points: r.points, edge: r.edge }))]));
  const bracket = v.bracket.map((b) => ({ id: b.id, round: b.round,
    home: b.home.teamId ? name(b.home.teamId) : null, homeSource: b.home.label, away: b.away.teamId ? name(b.away.teamId) : null, awaySource: b.away.label,
    result: b.result, winner: b.winner ? name(b.winner) : null, status: b.status, invalidated: b.invalidated || null, sourceIneligible: b.sourceIneligible || null }));
  return { tournament: st.tournament ? { name: st.tournament.name, date: st.tournament.date || null } : null,
    rulesConfirmed: !!(st.rules && st.rules.points), rulesLabel: matchesPreset(st.rules) ? presetLabel(st.rules.preset) : null, koLevel: v.koLevel, qualifiersPerGroup: (st.rules && st.rules.qualifiersPerGroup) || null, publicNames: !!(st.publicNames && st.publicNames.adults), stats, fixtures, tables, bracket, ...(MEDIA_MOD ? MEDIA_MOD.project(st) : {}), scorers: scorerList };
}
module.exports = { publicView, playerLabel };

};
defs["/engine/schedule"]=function(module,exports,require){'use strict';
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
  const lastSlot = {}, out = []; const s0 = hm(start); let slot = 0;
  while (pool.length) {
    const busy = new Set();
    for (let p = 0; p < pitches.length && pool.length; p++) {
      let best = -1, bestScore = Infinity;
      pool.forEach((m, i) => {
        if (busy.has(m.home) || busy.has(m.away)) return;
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
  const rounds = opts.rounds || 1, np = (opts.pitches && opts.pitches.length) || 1, dayEnd = hm(opts.dayEnd || '22:00');
  const { fx, slotMinutes } = rawPlan(groups, opts);
  const groupMatches = fx.filter((f) => f.stage === 'group').length, endMin = Math.max(...fx.map((f) => f.min)) + slotMinutes, knockout = koShape(groups, opts.ko);
  const base = { matches: fx.length, groupMatches, endsAt: clock(Math.min(endMin, 24 * 60 - 1)), endsAt12: clock12(Math.min(endMin, 24 * 60 - 1)), knockout, rounds };
  if (endMin > dayEnd) return { ok: false, ...base, endsAt: endMin >= 24 * 60 ? 'después de medianoche' : clock(endMin), endsAt12: endMin >= 24 * 60 ? 'después de medianoche' : clock12(endMin),
    message: `Con ${np} cancha${np > 1 ? 's' : ''} no caben ${groupMatches} partidos de grupo (y la fase final) en el día: terminarían ${endMin >= 24 * 60 ? 'después de medianoche' : 'a las ' + clock12(endMin)}. Usa más canchas, una sola vuelta, partidos más cortos o empieza más temprano.` };
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

};
defs["/engine/core"]=function(module,exports,require){'use strict';
// Request handler over a STORE ADAPTER: { load(): log[], save(log) }. Same engine, same validation as server/app.js.
// Used by the in-browser demo (store = localStorage) and by the parity test (store = memory) that compares it with the real server.
// The real server keeps its own persistence + integrity chain checks; this core covers only the routes the three screens use.
const S = require('./state');
const { checkEvent, planPublish } = require('./rules');
const { publicView } = require('./public');
const { only } = require('./validate');
const { PRESETS } = require('./presets');
function createCore({ store, tokens, key, now }) {
  const clock = now || (() => new Date().toISOString());
  const res = (status, body) => ({ status, body });
  function commit(log, type, actor, payload) {
    const st = S.replay(log);
    const bad = checkEvent(st, type, actor, payload, log.length + 1);
    if (bad) return { bad };
    const next = log.slice(); const e = S.append(next, type, actor, payload, clock(), key);
    store.save(next); return { e };
  }
  function commitMany(log, actor, events) {
    const next = log.slice();
    for (let i = 0; i < events.length; i++) {
      const bad = checkEvent(S.replay(next), events[i].type, actor, events[i].payload, next.length + 1);
      if (bad) return { bad, index: i };
      S.append(next, events[i].type, actor, events[i].payload, clock(), key);
    }
    store.save(next); return { count: events.length, seq: next.length };
  }
  const fail = (bad) => res(bad.status, { error: bad.error, ...(bad.detail ? { detail: bad.detail } : {}) });
  function handle(method, pathname, bearer, body) {
    const log = store.load(); const st = S.replay(log);
    if (method === 'GET' && pathname === '/api/public') return res(200, { asOf: log.length ? log[log.length - 1].ts : null, seq: log.length, ...publicView(st, S.view(st)) });
    const actor = bearer && Object.prototype.hasOwnProperty.call(tokens, bearer) ? tokens[bearer] : null;
    if (!actor) return res(401, { error: 'sin_sesion' });
    if (pathname.startsWith('/api/org/') && actor.role !== 'organizador') return res(403, { error: 'solo_organizador' });
    if (pathname.startsWith('/api/ref/') && actor.role !== 'arbitro') return res(403, { error: 'solo_arbitro' });
    if (method === 'GET' && pathname === '/api/ref/fixtures') {
      const v = S.view(st);
      const mine = Object.values(st.fixtures).filter((f) => f.refereeId === actor.id && !(st.withdrawn && (st.withdrawn[f.home] || st.withdrawn[f.away]))).map((f) => {
        const { home, away } = S.participantsOf(st, f, v.bracketById);
        const roster = (t) => Object.values(st.players).filter((p) => p.teamId === t).map((p) => ({ id: p.id, number: p.number, displayName: p.displayName }));
        return { id: f.id, stage: f.stage, round: f.round || null, groupId: f.groupId || null, kickoff: f.kickoff || null, pitch: f.pitch || null,
          home: home ? { id: home, name: st.teams[home].name, roster: roster(home) } : null, away: away ? { id: away, name: st.teams[away].name, roster: roster(away) } : null,
          approved: Object.prototype.hasOwnProperty.call(v.validApproved, f.id), invalidated: f.stage === 'ko' ? v.bracketById[f.id].invalidated : null, submitted: (st.reports[f.id] || []).length };
      });
      return res(200, { koLevel: v.koLevel, walkoverGoals: (st.rules && st.rules.walkoverGoals) || null, fixtures: mine });
    }
    if (method === 'GET' && pathname === '/api/org/state') { const v = S.view(st); return res(200, { seq: log.length, chain: S.verifyChain(log, key), state: st, view: { ...v, bracketById: undefined } }); }
    if (method === 'GET' && pathname === '/api/org/presets') return res(200, { presets: Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, { label: p.label, rules: p.rules, citations: p.citations, source: { file: p.source.file, sha256: p.source.sha256 } }])) });
    if (method !== 'POST') return res(404, { error: 'no_encontrado' });
    if (body === undefined) body = {}; // same as the real server: an empty body is {}
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res(400, { error: 'bad_json' });
    const SHAPE = { '/api/ref/report': ['fixtureId', 'report', 'participants'], '/api/org/report': ['fixtureId', 'report', 'participants'], '/api/org/event': ['type', 'payload'], '/api/org/rollback': ['toSeq', 'reason', 'expectSeq'], '/api/org/rollback/preview': ['toSeq'] };
    if (SHAPE[pathname] && !only(body, SHAPE[pathname])) return res(422, { error: 'cuerpo_invalido' });
    if (pathname === '/api/ref/report' || pathname === '/api/org/report') {
      const f = typeof body.fixtureId === 'string' && Object.prototype.hasOwnProperty.call(st.fixtures, body.fixtureId) ? st.fixtures[body.fixtureId] : null;
      const participants = f ? S.participantsOf(st, f, S.view(st).bracketById) : undefined;
      // R2-01: a report may carry the teams it was played by. If the bracket changed since, refuse it (never silently re-label it with the new teams).
      if (f && f.stage === 'ko' && body.participants === undefined && participants && participants.home && participants.away) return res(422, { error: 'participantes_requeridos', detail: 'Falta saber qué equipos jugaron este partido. Recarga la pantalla.' });
      if (body.participants !== undefined) {
        if (!only(body.participants, ['home', 'away']) || typeof body.participants.home !== 'string' || typeof body.participants.away !== 'string') return res(422, { error: 'cuerpo_invalido' });
        if (participants && (body.participants.home !== participants.home || body.participants.away !== participants.away)) return res(409, { error: 'equipos_cambiaron', detail: 'Cambiaron los equipos de este partido. Anota el resultado de nuevo.' });
      }
      const r = commit(log, 'REPORT_SUBMITTED', actor, { fixtureId: body.fixtureId, report: body.report, participants });
      return r.bad ? fail(r.bad) : res(201, { version: r.e.seq });
    }
    if (pathname === '/api/org/publish') { // T-1109: report + approval as one operation, safe to retry (rules.js planPublish)
      const plan = planPublish(log, st, body); if (plan.reply) return res(plan.reply.status, plan.reply.body);
      const r = commitMany(log, actor, plan.events); return r.bad ? fail(r.bad) : res(201, { version: plan.version });
    }
    if (pathname === '/api/org/event') {
      if (['REPORT_SUBMITTED', 'ROLLBACK', 'SIGN_LINK_ISSUED'].includes(body.type)) return res(422, { error: 'evento_invalido' });
      const r = commit(log, body.type, actor, body.payload); return r.bad ? fail(r.bad) : res(201, { seq: r.e.seq });
    }
    if (pathname === '/api/org/batch') {
      if (!only(body, ['events']) || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 200) return res(422, { error: 'cuerpo_invalido' });
      for (const [i, e] of body.events.entries()) if (!e || !only(e, ['type', 'payload']) || typeof e.type !== 'string' || ['REPORT_SUBMITTED', 'ROLLBACK', 'SIGN_LINK_ISSUED'].includes(e.type)) return res(422, { error: 'evento_invalido', index: i });
      const r = commitMany(log, actor, body.events);
      return r.bad ? res(r.bad.status, { error: r.bad.error, ...(r.bad.detail ? { detail: r.bad.detail } : {}), index: r.index }) : res(201, { count: r.count, seq: r.seq });
    }
    if (pathname === '/api/org/rollback/preview') { if (!Number.isInteger(body.toSeq) || body.toSeq < 0 || body.toSeq > log.length) return res(422, { error: 'rollback_invalido' }); return res(200, S.rollbackImpact(log, body.toSeq)); } // R8-02: the impact, computed here from the real event graph
    if (pathname === '/api/org/rollback' && !Number.isInteger(body.expectSeq)) return res(422, { error: 'historial_requerido', detail: 'Falta el número entero del historial que revisaste. Vuelve a revisar qué se deshace.' });
    if (pathname === '/api/org/rollback' && body.expectSeq !== log.length) return res(409, { error: 'historia_cambio', detail: 'El historial cambió mientras decidías. Vuelve a revisar qué se deshace.' });
    if (pathname === '/api/org/rollback') { const r = commit(log, 'ROLLBACK', actor, { toSeq: body.toSeq, reason: typeof body.reason === 'string' ? body.reason.trim() : body.reason }); return r.bad ? fail(r.bad) : res(201, { seq: r.e.seq }); }
    return res(404, { error: 'no_encontrado' });
  }
  return { handle };
}
// Machine-checked list of the routes the in-browser core implements (everything else is real-mode only: export/import, signing links, family signing).
const CAPABILITIES = ['GET /api/public', 'GET /api/ref/fixtures', 'GET /api/org/state', 'GET /api/org/presets', 'POST /api/org/event', 'POST /api/org/report', 'POST /api/org/publish', 'POST /api/ref/report', 'POST /api/org/rollback', 'POST /api/org/rollback/preview', 'POST /api/org/batch'];
module.exports = { createCore, CAPABILITIES };

};
defs["/engine/flags"]=function(module,exports,require){module.exports={MEDIA:true};
};
defs["/engine/media"]=function(module,exports,require){'use strict';
// PUBLIC MEDIA (videos/albums linked to matches). DISABLED BY DESIGN in every public build (engine/flags.js: MEDIA=false unless the build flag TOS_MEDIA=1).
// Decision 2026-11-04 (TORNEO R8): children's media needs its own consent design and the founder's call (see CONSENTIMIENTO-MEDIA-PLAN.md). T-1106 (founder, 2026-11-06): ON for the adult Nov 21 event, links only. Reviewed rounds R6/R7 found three consent P0s
// (rollback re-publishes revoked consent; `people:'ninguno'` + URL text bypass; ICC metadata). T-1109 closed the first two: `ninguno` is no bypass and a rollback never restores a revoked consent (see mediaGate and state.js overlayTombs). Photo metadata stays the organizer's job: links only, no upload.
function events({ only, ID, isInt }) {
// Media links (Night 7): closed-list URLs. https only, a known host (or its subdomain), no credentials, bounded length. Videos come from Veo/YouTube links, albums from shared-album links.
const VIDEO_HOSTS = ['veo.co', 'veo.com', 'youtube.com', 'youtu.be'], ALBUM_HOSTS = ['icloud.com', 'photos.app.goo.gl', 'photos.google.com', 'drive.google.com', 'dropbox.com', 'flickr.com', 'veo.co', 'veo.com'];
const ALBUM_KINDS = ['partido', 'cancha', 'aficion', 'equipos', 'premios', 'dia'];
const idList = (a) => Array.isArray(a) && a.length <= 60 && new Set(a).size === a.length && a.every((x) => typeof x === 'string' && ID.test(x));
const peopleOk = (p) => p === 'ninguno' || (only(p, ['teams', 'players']) && (p.teams === undefined || idList(p.teams)) && (p.players === undefined || idList(p.players)) && ((p.teams || []).length + (p.players || []).length) >= 1);
const urlOk = (u, hosts) => { if (typeof u !== 'string' || u.length > 200) return false; try { const x = new URL(u); return x.protocol === 'https:' && x.port === '' && !x.username && !x.password && hosts.some((h) => x.hostname === h || x.hostname.endsWith('.' + h)); } catch { return false; } };
return {
  // R6-01 (P0): public media carries NO free text and no person. Labels are generated from the match / a closed `kind`. Who appears is declared in `people`
  // ('ninguno' = nobody identifiable, Dad's attestation; or {teams,players}); a minor who appears needs an ACTIVE, organizer-VERIFIED consent with the right scope, else the item is not public.
  VIDEO_LINKED: (p) => only(p, ['id', 'fixtureId', 'url', 'duration', 'people']) && ID.test(p.id) && ID.test(p.fixtureId) && urlOk(p.url, VIDEO_HOSTS) && (p.duration === undefined || /^\d{1,2}:[0-5]\d$/.test(p.duration)) && peopleOk(p.people),
  VIDEO_UNLINKED: (p) => only(p, ['id']) && ID.test(p.id),
  ALBUM_LINKED: (p) => only(p, ['id', 'kind', 'url', 'count', 'fixtureId', 'people']) && ID.test(p.id) && ALBUM_KINDS.includes(p.kind) && urlOk(p.url, ALBUM_HOSTS) && (p.count === undefined || isInt(p.count, 0, 5000)) && (p.fixtureId === undefined || ID.test(p.fixtureId)) && peopleOk(p.people),
  ALBUM_UNLINKED: (p) => only(p, ['id']) && ID.test(p.id),
};
}

function check(st, type, p, has, err) {
  if (type === 'VIDEO_LINKED' || type === 'ALBUM_LINKED') { // Night 7: media is linked to an existing match; ids are unique per kind
    const pool = type === 'VIDEO_LINKED' ? (st.videos || {}) : (st.albums || {}); if (has(pool, p.id)) return err(409, 'id_repetido');
    if (p.fixtureId !== undefined && !has(st.fixtures, p.fixtureId)) return err(404, 'partido_desconocido');
    if (p.fixtureId !== undefined && st.fixtures[p.fixtureId].stage === 'ko') { const S = require('./state'), c = S.participantsOf(st, st.fixtures[p.fixtureId], S.view(st).bracketById); if (!c.home || !c.away) return err(409, 'partido_sin_equipos', 'Este partido todavía no tiene equipos. Agrega el enlace cuando se sepa quién juega.'); }
    if (p.people !== 'ninguno') { for (const t of p.people.teams || []) if (!has(st.teams, t)) return err(404, 'equipo_desconocido'); for (const x of p.people.players || []) if (!has(st.players, x)) return err(404, 'jugador_desconocido'); }
  }
  if (type === 'VIDEO_UNLINKED' && !has(st.videos || {}, p.id)) return err(404, 'video_desconocido');
  if (type === 'ALBUM_UNLINKED' && !has(st.albums || {}, p.id)) return err(404, 'album_desconocido');
  return null;
}
function apply(st, e) {
  const p = e.payload; st.videos = st.videos || Object.create(null); st.albums = st.albums || Object.create(null);
  switch (e.type) {
    case 'VIDEO_LINKED': st.videos[p.id] = { id: p.id, fixtureId: p.fixtureId, url: p.url, duration: p.duration || null, people: p.people, seq: e.seq }; break;
    case 'VIDEO_UNLINKED': delete st.videos[p.id]; break;
    case 'ALBUM_LINKED': st.albums[p.id] = { id: p.id, kind: p.kind, url: p.url, count: p.count ?? null, fixtureId: p.fixtureId || null, people: p.people, seq: e.seq }; break;
    case 'ALBUM_UNLINKED': delete st.albums[p.id]; break;
    default: break;
  }
}
// T-1109 (TOR-T1106-01, P0): may this media item be PUBLIC right now? Who it could show is decided by the SERVER, not by a label typed in a form:
// the declared people, PLUS both teams actually playing the match (knockout: from the bracket, today), or, for an album of no match, everybody on a roster. `ninguno` is NOT a bypass (it only stays valid so old histories still replay).
// Every MINOR in that set needs an ACTIVE, organizer-VERIFIED consent whose scope includes `scope` ('video' | 'foto'). A knockout with no teams yet, or a roster with nobody on it, stays hidden: nothing is shown on a guess.
// Computed from the CURRENT state, so a revoked consent hides the item at once; rollback keeps it hidden (state.js overlayTombs).
function mediaGate(st, item, scope, bracketById) {
  const roster = (t) => Object.values(st.players).filter((pl) => pl.teamId === t).map((pl) => pl.id);
  const ids = new Set(); if (item.people !== 'ninguno') { for (const x of item.people.players || []) ids.add(x); for (const t of item.people.teams || []) roster(t).forEach((x) => ids.add(x)); }
  let unresolved = false;
  if (item.fixtureId) { const f = st.fixtures[item.fixtureId];
    if (!f) unresolved = true;
    else { const S = require('./state'), c = S.participantsOf(st, f, bracketById || S.view(st).bracketById); if (!c.home || !c.away) unresolved = true; else { roster(c.home).forEach((x) => ids.add(x)); roster(c.away).forEach((x) => ids.add(x)); } }
  } else Object.keys(st.players).forEach((x) => ids.add(x));
  const missing = [...ids].filter((id) => { const pl = st.players[id]; if (!pl || !pl.isMinor) return false; const c = st.consents[id]; return !(c && c.active && c.verifiedSeq && c.scope.includes(scope)); });
  return { visible: !unresolved && ids.size > 0 && missing.length === 0, missing, ...(unresolved ? { unresolved: true } : {}), ...(!unresolved && ids.size === 0 ? { noRoster: true } : {}) };
}
const bracketOf = (st) => require('./state').view(st).bracketById;
function decorate(st) { const b = bracketOf(st); for (const x of Object.values(st.videos || {})) x.gate = mediaGate(st, x, 'video', b); for (const x of Object.values(st.albums || {})) x.gate = mediaGate(st, x, 'foto', b); }
function project(st) { const b = bracketOf(st);
  return { videos: Object.values(st.videos || {}).filter((x) => mediaGate(st, x, 'video', b).visible).map((x) => ({ id: x.id, fixtureId: x.fixtureId, url: x.url, duration: x.duration })),
    albums: Object.values(st.albums || {}).filter((x) => mediaGate(st, x, 'foto', b).visible).map((x) => ({ id: x.id, kind: x.kind, url: x.url, count: x.count, fixtureId: x.fixtureId })) };
}
module.exports = { events, check, apply, decorate, project, mediaGate };

};
defs["node:crypto"]=function(module,exports,require){'use strict';
// Minimal synchronous SHA-256 / HMAC-SHA-256 for the in-browser demo (the engine's log chain uses node:crypto on the server).
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const utf8 = (s) => (typeof s === 'string' ? new TextEncoder().encode(s) : Uint8Array.from(s));
function sha256(data) {
  const msg = utf8(data), l = msg.length, padLen = (((l + 9 + 63) >> 6) << 6), buf = new Uint8Array(padLen);
  buf.set(msg); buf[l] = 0x80; new DataView(buf.buffer).setUint32(padLen - 4, (l * 8) >>> 0); new DataView(buf.buffer).setUint32(padLen - 8, Math.floor((l * 8) / 4294967296));
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), w = new Uint32Array(64), dv = new DataView(buf.buffer);
  const rr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < padLen; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const a = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3), b = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + a + w[i - 7] + b) >>> 0; }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) { const t1 = (h + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0, t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0; h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0; }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32); const odv = new DataView(out.buffer); for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]); return out;
}
const hex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
function hmac(key, data) {
  let k = utf8(key); if (k.length > 64) k = sha256(k); const kp = new Uint8Array(64); kp.set(k);
  const ip = kp.map((b) => b ^ 0x36), op = kp.map((b) => b ^ 0x5c), d = utf8(data);
  const inner = new Uint8Array(64 + d.length); inner.set(ip); inner.set(d, 64);
  const outer = new Uint8Array(96); outer.set(op); outer.set(sha256(inner), 64); return sha256(outer);
}
const acc = (fn) => { let s = ''; return { update(x) { s += typeof x === 'string' ? x : new TextDecoder().decode(x); return this; }, digest(enc) { const u = fn(s); return enc === 'hex' ? hex(u) : u; } }; };
module.exports = { createHash: () => acc(sha256), createHmac: (_a, key) => acc((s) => hmac(key, s)), randomBytes: (n) => { const u = new Uint8Array(n); (globalThis.crypto || {}).getRandomValues ? crypto.getRandomValues(u) : u.forEach((_, i) => (u[i] = Math.random() * 256)); return Object.assign(u, { toString: () => hex(u) }); } };

};
function norm(from,r){if(r==='node:crypto')return r;var p=r.replace(/^\.\//,'/engine/');return p;}
function req(name){if(cache[name])return cache[name].exports;var m={exports:{}};cache[name]=m;defs[name](m,m.exports,function(r){return req(norm(name,r));});return m.exports;}
window.TosEngine={core:req('/engine/core'),schedule:req('/engine/schedule'),state:req('/engine/state'),flags:req('/engine/flags')};})();
