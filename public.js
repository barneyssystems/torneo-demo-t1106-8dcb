'use strict';
let DATA = null, TAB = 'partidos', STALE = null;
const view = document.getElementById('view'), banner = document.getElementById('banner');
function setBanner(kind, text) { banner.replaceChildren(text ? el('div', { class: 'banner ' + kind, role: 'status' }, text) : ''); }
function teamOrSource(name, src) { return name ? el('span', {}, name) : el('span', { class: 'tbd' }, srcLabel(src) + ' · Por definir'); }
function matchRow(f) {
  const sc = scoreText(f.result);
  return el('div', { class: 'row', 'data-fixture': f.id },
    el('div', { class: 'team r' }, f.stage === 'group' ? f.home : teamOrSource(f.home, f.homeSource)),
    el('div', { class: 'score' }, sc || el('span', { class: 'tbd' }, 'vs')),
    el('div', { class: 'team' }, f.stage === 'group' ? f.away : teamOrSource(f.away, f.awaySource)));
}
// ---- UCL-structure design (own look): Hoy · Tabla · Cuadro · Goleadores. Text only; CSP forbids inline styles, so colours are classes.
let TEAMIDX = Object.create(null); // null-prototype: a team called «constructor» is just a name
const hue = (name) => { if (name in TEAMIDX) return 'c' + (TEAMIDX[name] % 12); let h = 0; for (const c of String(name || '?')) h = (h * 31 + c.codePointAt(0)) % 12; return 'c' + h; };
const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
// A generated crest: colour (12) × pattern (4) × initials, in a shield shape. Deterministic from the team name; no logos, no IP.
const pat = (name) => { let h = 7; for (const c of String(name || '?')) h = (h * 17 + c.codePointAt(0)) % 4; return 'p' + h; };
const badge = (name) => name ? el('span', { class: 'badge crest svgc', 'aria-hidden': 'true' }, crestSvg(name)) : el('span', { class: 'badge crest empty', 'aria-hidden': 'true' }, el('b', {}, ''));
let FOLLOW = null; try { FOLLOW = localStorage.getItem('miEquipo'); } catch {}
function follow(name) { FOLLOW = FOLLOW === name ? null : name; try { FOLLOW ? localStorage.setItem('miEquipo', FOLLOW) : localStorage.removeItem('miEquipo'); } catch {} render(); }
const hhmm = (k) => (k ? k.slice(11, 16) : '');
const srcName = (src) => { const w = /^W:(.+)$/.exec(src || ''); if (w) { const f = DATA.fixtures.find((x) => x.id === w[1]); return 'Ganador ' + (f && f.round ? f.round : w[1]); } return srcLabel(src); };
// Cuadro: while a group is still being played, a knockout slot shows who is on track for it («va 1º del grupo A»), dimmed, never as if it were decided.
const provisional = (src) => { const m = /^([1-9])(.+)$/.exec(src || ''); if (!m || !DATA.tables || !Object.prototype.hasOwnProperty.call(DATA.tables, m[2])) return null; const t = DATA.tables[m[2]], r = t && t[Number(m[1]) - 1]; return r && t[0].played > 0 && r.played > 0 ? { name: r.team, pos: Number(m[1]), group: m[2] } : null; };
const side = (name, src, right) => el('div', { class: 'side' + (right ? ' right' : '') + (name && name === FOLLOW ? ' mine' : '') }, badge(name), el('span', { class: 'tn' }, name || srcName(src)));
let NEXT = null, MATCH = null, NEWRES = [], LASTRES = null, MOVES = {}, LASTPOS = null, LT = null; // NEWRES: fixtures whose result arrived since the last load; MOVES: places gained/lost in the table since the last change
 // MATCH = id of the match whose page is open (Hoy → «Partido»)
const t12 = (k) => L.t12(k);
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'justo ahora' : m < 60 ? `hace ${m} min` : m < 24 * 60 ? `hace ${Math.round(m / 60)} h` : fmtTime(iso); };
const open = (id) => { MATCH = id; window.scrollTo(0, 0); render(); };
function card(f) {
  const r = f.result, lv = !r && f.live;
  const fin = r ? L.finalScore(r) : null; const mid = r ? el('div', { class: 'big' }, el('span', {}, fin.hg), el('span', { class: 'dash' }, '–'), el('span', {}, fin.ag)) : lv ? el('div', { class: 'big liveScore' }, el('span', {}, lv.hg), el('span', { class: 'dash' }, '–'), el('span', {}, lv.ag)) : el('div', { class: 'big soon' }, t12(f.kickoff) || 'vs');
  const ps = L.publicState(f), state = lv ? 'EN VIVO ' + lv.minute + "'" : ps.kind === 'todo' && NEXT && NEXT.id === f.id ? 'Siguiente' : ps.label;
  const extra = r && ((r.pens ? ` · Penales ${r.pens.hg}-${r.pens.ag}` : r.et ? ' · En prórroga' : '')) || '';
  return el('div', { class: 'mcard tap' + (lv ? ' isLive' : '') + (NEWRES.includes(f.id) ? ' flashNew' : ''), 'data-fixture': f.id, role: 'button', tabindex: '0', 'aria-label': 'Ver el partido', onclick: () => open(f.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(f.id); } } }, el('div', { class: 'mrow' }, side(f.home, f.homeSource), mid, side(f.away, f.awaySource, true)),
    (r && f.goals && f.goals.some((g) => g.label) ? el('div', { class: 'mgoals' }, '⚽ ' + f.goals.filter((g) => g.label).slice(0, 4).map((g) => `${g.label} (${initials(g.side === 'h' ? f.home : f.away)})${g.minute ? ' ' + g.minute + "'" : ''}`).join(' · ')) : null),
    el('div', { class: 'mfoot' }, el('span', { class: 'chip ' + (r ? 'fin' : lv ? 'live' : 'next') }, state), el('span', {}, [f.pitch, f.stage === 'group' ? 'Grupo ' + f.groupId : f.round].filter(Boolean).join(' · ') + extra + (f.corrected ? ' · resultado corregido' : '') + ' ›')), vidChip(f));
}
const dayLabel = (iso) => new Date(iso.slice(0, 10) + 'T12:00').toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
// T-1105: the match page tells the match as a timeline (kick-off, each goal on its team's side, live minute or full time), the REA match-centre pattern.
function timeline(f, r, lv, gsrc) {
  if (!r) return null;
  const items = [el('li', { class: 'tli mark' }, el('span', { class: 'tm' }, 'Inicio'))];
  const goals = (gsrc || []).slice().sort((a, b) => (a.minute == null ? 1e9 : a.minute) - (b.minute == null ? 1e9 : b.minute));
  let h = 0, a = 0;
  for (const g of goals) { if (g.side === 'h') h++; else a++;
    const team = g.side === 'h' ? f.home : f.away;
    items.push(el('li', { class: 'tli ' + (g.side === 'h' ? 'h' : 'a'), 'data-tl-goal': g.side }, el('span', { class: 'tm' }, g.minute != null ? g.minute + "'" : '⚽'),
      el('span', { class: 'who' }, el('i', { class: 'ico', 'aria-hidden': 'true' }, '⚽'), (g.label || 'Gol') + ' ', el('small', {}, `${team} · ${h}–${a}`)))); }
  const named = goals.some((g) => g.label), total = r.hg + r.ag;
  if (lv) items.push(el('li', { class: 'tli mark now' }, el('span', { class: 'tm' }, 'En vivo ' + lv.minute + "'")));
  else for (const m of L.timelineMarks(r)) items.push(el('li', { class: 'tli mark' }, el('span', { class: 'tm' }, m))); // T-1109 (TOR-T1106-07): regulation, extra time, then the real final score, then penalties
  return el('section', { class: 'tl', id: 'timeline', 'aria-label': 'Minuto a minuto' }, el('h3', { class: 'tlH' }, 'Minuto a minuto'), el('ol', {}, items),
    total > 0 && !goals.length ? el('p', { class: 'tlNote' }, 'Todavía no se anotó quién metió los goles.') : total === 0 ? el('p', { class: 'tlNote' }, 'Sin goles.') : !named && !lv ? el('p', { class: 'tlNote' }, 'El árbitro no anotó los nombres de los goleadores.') : null);
}
const R = {
  partido() { // one match: score, who scored and when (the REA match page)
    const f = DATA.fixtures.find((x) => x.id === MATCH);
    if (!f) { MATCH = null; return R.partidos(); }
    const lv = !f.result && f.live, r = f.result || (lv ? { hg: lv.hg, ag: lv.ag } : null), gsrc = f.result ? f.goals : lv ? lv.goals : null;
    const ps = L.publicState(f), state = lv ? 'EN VIVO ' + lv.minute + "'" : ps.label;
    return [el('button', { class: 'back', id: 'backMatch', onclick: () => { MATCH = null; render(); } }, '‹ Volver'),
      el('div', { class: 'hero', 'data-match-page': f.id }, lv && lv.sim ? el('small', { class: 'simNote' }, 'Demostración: partido simulado') : null, el('div', { class: 'heroMeta' }, [f.stage === 'group' ? 'Grupo ' + f.groupId : f.round, f.kickoff ? dayLabel(f.kickoff) + ' · ' + t12(f.kickoff) : '', f.pitch].filter(Boolean).join(' · ')),
        el('div', { class: 'heroRow' }, el('div', { class: 'hs' }, badge(f.home), el('span', {}, f.home || srcName(f.homeSource))),
          r ? el('div', { class: 'heroScore' }, el('span', {}, (f.result ? L.finalScore(r) : r).hg), el('span', { class: 'dash' }, '–'), el('span', {}, (f.result ? L.finalScore(r) : r).ag)) : el('div', { class: 'heroScore soon' }, t12(f.kickoff) || 'vs'),
          el('div', { class: 'hs' }, badge(f.away), el('span', {}, f.away || srcName(f.awaySource)))),
        el('div', { class: 'heroPill' }, el('span', { class: 'chip ' + (r ? 'fin' : 'next') }, state), r && r.pens ? el('span', { class: 'meta heroX' }, `Penales ${r.pens.hg}-${r.pens.ag}`) : r && r.et ? el('span', { class: 'meta heroX' }, `Con prórroga (${r.et.hg}-${r.et.ag})`) : null),
        !r ? el('p', { class: 'meta center', id: 'noResult' }, ps.kind === 'annulled' ? 'El resultado anterior se anuló y hay que volver a anotarlo: ' + ps.note : ps.kind === 'withdrawn' ? ps.note : 'El resultado aparece aquí cuando el organizador lo aprueba.') : null),
      el('div', { class: 'srOnly', role: 'status', 'aria-live': 'polite', id: 'liveAnn' }),
      timeline(f, r, lv, gsrc),
      ...matchMedia(f), // T-1106: the game's highlight and album (links the organizer added)
      f.stage === 'group' ? el('button', { class: 'btn sec', id: 'toTable', onclick: () => { MATCH = null; TAB = 'grupos'; syncTabs(); render(); } }, 'Ver la tabla del grupo') : el('button', { class: 'btn sec', id: 'toBracket', onclick: () => { MATCH = null; TAB = 'eliminatorias'; syncTabs(); render(); } }, 'Ver el cuadro')];
  },
  partidos() {
    let fx = DATA.fixtures.slice();
    if (!fx.length) return [el('div', { class: 'empty' }, 'Aún no hay calendario. El organizador lo publica pronto.')];
    const out = [];
    const first = fx.find((f) => f.kickoff), st = DATA.stats;
    if (first) out.push(el('div', { class: 'dayHead', id: 'dayHead' }, el('div', { class: 'dayT' }, dayLabel(first.kickoff)), el('div', { class: 'dayS' }, (st ? `${st.played} de ${st.total} partidos jugados` : '') + (() => { const ks = DATA.fixtures.map((f) => f.kickoff).filter(Boolean).sort(); return ks.length ? ` · primer partido ${t12(ks[0])}` : ''; })())));
    if (FOLLOW) out.push(el('div', { class: 'seg' }, el('button', { 'aria-pressed': 'false', onclick: () => follow(FOLLOW) }, 'Ver todos'), el('button', { 'aria-pressed': 'true' }, 'Mi equipo: ' + FOLLOW)));
    if (FOLLOW) fx = fx.filter((f) => f.home === FOLLOW || f.away === FOLLOW);
    fx.sort((a, b) => (a.kickoff || 'z').localeCompare(b.kickoff || 'z') || (a.pitch || '').localeCompare(b.pitch || ''));
    const slots = {}; for (const f of fx) (slots[f.kickoff ? t12(f.kickoff) : 'Por definir'] = slots[f.kickoff ? t12(f.kickoff) : 'Por definir'] || []).push(f);
    const nm = L.nextMatch(fx), next = nm.next; NEXT = next || null;
    { // the day hero: progress of the day, and the LIVE match (minute running, score, who scored) when one is being played
      const liveF = fx.find((f) => !f.result && f.live), pct = st && st.total ? Math.round((st.played / st.total) * 100) : 0, final = DATA.fixtures.find((f) => f.round === 'Final' && f.result);
      const ch = L.champion(DATA); // R14: the champion comes ONLY from the bracket's resolved winner of the approved Final
      if (ch && ch.state === 'champion') out.push(el('div', { class: 'dayHero champ', id: 'dayHero' }, el('small', {}, 'CAMPEÓN DEL TORNEO'), el('div', { class: 'dhChamp' }, badge(ch.team), el('b', {}, ch.team)), el('div', { class: 'dhBar' }, el('i', { class: 'w100' }))));
      else out.push(el('div', { class: 'dayHero', id: 'dayHero' }, el('div', { class: 'dhTop' }, el('small', {}, 'EL DÍA'), el('b', {}, st ? `${st.played} de ${st.total} partidos` : '')), el('div', { class: 'dhBar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, el('i', { class: 'w' + (Math.round(pct / 5) * 5) })), el('small', { class: 'dhNote' }, ch && ch.state === 'pending' ? 'Final pendiente' : liveF ? 'Hay un partido en juego ahora.' : 'Los marcadores se actualizan cuando Papá los aprueba.')));
      if (liveF) { const lv = liveF.live; out.push(el('div', { class: 'liveHero tap', id: 'liveHero', role: 'button', tabindex: '0', 'aria-label': 'Ver el partido en vivo', onclick: () => open(liveF.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(liveF.id); } } },
        el('div', { class: 'lhTop' }, el('span', { class: 'live' }, el('i', { class: 'dot' }), 'EN VIVO'), el('span', { class: 'lmin' }, lv.minute + "'"), el('span', { class: 'lpitch' }, [liveF.pitch, 'Grupo ' + liveF.groupId].filter(Boolean).join(' · '))),
        el('div', { class: 'lhRow' }, side(liveF.home), el('div', { class: 'lhScore' }, el('span', {}, lv.hg), el('span', { class: 'dash' }, '–'), el('span', {}, lv.ag)), side(liveF.away, null, true)),
        el('div', { class: 'lhGoals' }, lv.goals.map((g) => el('span', {}, `⚽ ${g.minute}' ${g.side === 'h' ? liveF.home : liveF.away}`))), lv.sim ? el('small', { class: 'simNote' }, 'Demostración: partido simulado') : null)); }
      if (NEWRES.length) { const nf = DATA.fixtures.find((f) => f.id === NEWRES[NEWRES.length - 1]); if (nf && nf.result) out.push(el('div', { class: 'toastNew', id: 'toastNew', role: 'status' }, el('b', {}, 'Marcador nuevo'), ` ${nf.home} ${L.finalScore(nf.result).hg}–${L.finalScore(nf.result).ag} ${nf.away}`)); } }
    { const up = fx.filter((f) => !f.result && !f.live && f.kickoff && f.home && f.away && L.publicState(f).kind !== 'withdrawn').slice(0, 6); // UCL-style strip of what comes next, crests first
      if (up.length) out.push(el('div', { class: 'nstrip', id: 'nextStrip' }, up.map((f) => el('button', { class: 'nsc', type: 'button', 'aria-label': `Abrir el partido ${f.home} contra ${f.away}, ${t12(f.kickoff)}`, onclick: () => open(f.id) }, el('small', {}, t12(f.kickoff) + ' · ' + (f.pitch || '')), el('div', { class: 'nsr' }, badge(f.home), el('span', {}, f.home)), el('div', { class: 'nsr' }, badge(f.away), el('span', {}, f.away)))))); }
    if (next) out.push((() => { const sameSlot = nm.sameSlot; return el('div', { class: 'nextHero tap', id: 'nextHero', role: 'button', tabindex: '0', onclick: () => open(next.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(next.id); } } }, el('div', { class: 'nh1' }, sameSlot.length > 1 ? 'Siguen' : 'Siguiente partido'), el('div', { class: 'nh2' }, sameSlot.length > 1 ? `${t12(next.kickoff)} · ${sameSlot.length} partidos` : `${t12(next.kickoff)} · ${next.pitch || ''}`), ...sameSlot.map((f) => el('div', { class: 'nh3' }, `${f.home || srcName(f.homeSource)} vs ${f.away || srcName(f.awaySource)}${sameSlot.length > 1 && f.pitch ? ' · ' + f.pitch : ''}`))); })());
    for (const [t, list] of Object.entries(slots)) out.push(el('div', { class: 'slot' }, el('h3', { class: 'slotH' }, t), list.map(card)));
    return out;
  },
  grupos() {
    const out = [], q = DATA.qualifiersPerGroup;
    if (!DATA.rulesConfirmed) out.push(el('div', { class: 'banner warn' }, 'Las reglas de puntos aún no están confirmadas: la tabla no ordena posiciones.'));
    if (DATA.rulesLabel) out.push(el('div', { class: 'banner warn', id: 'rulesLabel' }, 'Reglas: ' + DATA.rulesLabel + '. Provisionales hasta que el organizador las confirme.'));
    const leads = Object.entries(DATA.tables).map(([g, t]) => t[0] && t[0].played > 0 ? `Grupo ${g}: ${t[0].team}` : `Grupo ${g}: aún sin partidos`);
    if (Object.values(DATA.tables).some((t) => t[0] && t[0].played > 0)) out.push(el('div', { class: 'leaders', id: 'leaders' }, el('b', {}, 'Líderes'), el('span', {}, leads.join('  ·  '))));
    for (const [g, t] of Object.entries(DATA.tables)) {
      const rows = [], closed = t.length && t.every((r) => r.edge !== 'En disputa'), showZones = t.length && t.every((r) => r.played > 0);
      t.forEach((r, i) => {
        if (showZones && q && i === 0) rows.push(el('div', { class: 'zone q' }, closed ? 'Clasifican' : 'Clasifican (por ahora)'));
        if (showZones && q && i === q) rows.push(t[i - 1] && t[i].shared && t[i - 1].shared && t[i].position === t[i - 1].position ? el('div', { class: 'zone t' }, 'Empatados por el último lugar que clasifica: lo decide el organizador') : el('div', { class: 'zone e' }, closed ? 'No clasifican' : 'No clasifican (por ahora)'));
        rows.push(el('button', { class: 'trow ' + (r.edge === 'Clasificado' ? 'q' : r.edge === 'Eliminado' ? 'e' : '') + (r.team === FOLLOW ? ' mine' : '') + (showZones && q && i === q - 1 ? ' zl' : ''), onclick: () => follow(r.team), 'aria-label': 'Seguir a ' + r.team },
          el('span', { class: 'pos' }, MOVES[r.team] > 0 ? el('i', { class: 'mv up', 'aria-label': 'subió ' + MOVES[r.team] }, '▲') : MOVES[r.team] < 0 ? el('i', { class: 'mv down', 'aria-label': 'bajó ' + (-MOVES[r.team]) }, '▼') : null, r.played === 0 ? i + 1 : r.shared ? r.position + '=' : r.position), el('span', { class: 'tm' }, badge(r.team), el('span', { class: 'tn' }, r.team)),
          el('span', {}, r.played), el('span', {}, (r.gd > 0 ? '+' : '') + r.gd), el('span', { class: 'pts' }, r.points === null ? '—' : r.points),
          el('span', { class: 'form', 'aria-label': 'Últimos resultados' }, (r.form || []).map((x) => el('i', { class: 'f' + x }, x)))));
      });
      out.push(el('div', { class: 'tcard' }, el('h2', {}, 'Grupo ' + g, q ? el('small', { class: 'zoneHint' }, `Pasan los ${q} primeros`) : null),
        el('div', { class: 'trow thead' }, el('span', { class: 'pos' }, '#'), el('span', { class: 'tm' }, 'Equipo'), el('span', {}, 'Jug.'), el('span', {}, 'Dif.'), el('span', { class: 'pts' }, 'Pts'), el('span', { class: 'form' }, 'Últimos')),
        rows,
        el('div', { class: 'legend' }, el('span', { class: 'lg full' }, 'Jug. partidos jugados · Dif. diferencia de goles · Pts puntos · G ganó, E empató, P perdió'), el('span', { class: 'lg full' }, 'Toca un equipo para seguir sus partidos')),
        t.some((r) => r.flag && r.played > 0) ? el('div', { class: 'meta pad', id: 'tieNote' }, '= Empate que las reglas no resuelven: lo decide el organizador.') : null));
    }
    if (!out.length) out.push(el('div', { class: 'empty' }, 'Todavía no hay grupos.'));
    return out;
  },
  eliminatorias() {
    if (!DATA.bracket.length) return [el('div', { class: 'empty' }, 'Las eliminatorias aún no están programadas.')];
    const rounds = {}, out = [];
    for (const b of DATA.bracket) (rounds[b.round] = rounds[b.round] || []).push(b);
    const fin = DATA.bracket.find((b) => b.round === 'Final');
    if (fin && fin.winner) out.push(el('div', { class: 'champ', id: 'champ' }, el('div', { class: 'champT' }, 'Campeón'), badge(fin.winner), el('div', { class: 'champN' }, fin.winner)));
    if (DATA.qualifiersPerGroup) out.unshift(el('p', { class: 'meta center', id: 'koHint' }, `Pasan los ${DATA.qualifiersPerGroup} primeros de cada grupo.`));
    const fx = (id) => DATA.fixtures.find((x) => x.id === id) || {};
    const statusOf = (b) => b.winner ? 'Avanza: ' + b.winner : b.invalidated ? 'Resultado anulado: ' + b.invalidated + '. Pendiente de volver a anotar.' + (b.sourceIneligible ? ' (' + b.sourceIneligible + ')' : '') : b.sourceIneligible ? 'Por definir (' + b.sourceIneligible + ')' : (b.home && b.away ? 'Por jugar' : 'Por definir');
    const semis = DATA.bracket.filter((b) => /^Semifinal/.test(b.round));
    if (semis.length === 2 && fin) { // a real bracket: two semifinals side by side, joined to the final
      const tc = (b, cls) => el('div', { class: 'tc' + (b.home && b.away ? ' tap' : '') + (cls ? ' ' + cls : ''), 'data-ko': b.id, ...(b.home && b.away ? { role: 'button', tabindex: '0', onclick: () => { TAB = 'partidos'; syncTabs(); open(b.id); }, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); TAB = 'partidos'; syncTabs(); open(b.id); } } } : {}) },
        el('div', { class: 'tcH' }, el('b', {}, b.round), el('span', {}, [fx(b.id).kickoff ? t12(fx(b.id).kickoff) : '', fx(b.id).pitch].filter(Boolean).join(' · '))),
        [[b.home, b.homeSource, b.result && L.finalScore(b.result).hg], [b.away, b.awaySource, b.result && L.finalScore(b.result).ag]].map(([n, src, g]) => { const pv = !n && provisional(src); return el('div', { class: 'tcRow' + (n && b.winner === n ? ' win' : '') + (pv ? ' prov' : '') }, badge(n || (pv && pv.name)), el('span', { class: 'tn' }, n || (pv ? pv.name : srcName(src)), pv ? el('small', {}, `va ${pv.pos}º del grupo ${pv.group}`) : null), el('span', { class: 'tg' }, g === null || g === undefined ? '' : g)); }),
        el('div', { class: 'tcS', 'data-ko-status': b.id }, statusOf(b) + (b.result && b.result.pens ? ` · Penales ${b.result.pens.hg}-${b.result.pens.ag}` : '')));
      if (semis.some((b) => !b.home || !b.away)) out.push(el('p', { class: 'meta center', id: 'koWait' }, 'Los equipos se definen cuando terminan los partidos de grupo.'));
      const qf = DATA.bracket.filter((b) => /^Cuartos/.test(b.round)); // T-1106: Dad's knockout starts at the quarterfinals
      if (qf.length === 4) out.push(el('div', { class: 'treeQF', id: 'treeQF' }, el('h3', { class: 'slotH' }, 'Cuartos de final'), el('div', { class: 'treeSemis' }, tc(qf[0]), tc(qf[1])), el('div', { class: 'treeSemis' }, tc(qf[2]), tc(qf[3])), el('div', { class: 'treeJoin', 'aria-hidden': 'true' }, el('i'), el('i'))));
      out.push(el('div', { class: 'tree' }, qf.length === 4 ? el('h3', { class: 'slotH' }, 'Semifinales y final') : null, el('div', { class: 'treeSemis' }, tc(semis[0]), tc(semis[1])), el('div', { class: 'treeJoin', 'aria-hidden': 'true' }, el('i'), el('i')), el('div', { class: 'treeFinal' }, tc(fin, 'final'))));
      return out;
    }
    return out.concat(Object.entries(rounds).map(([r, list], i) => el('div', { class: 'slot' + (i ? ' next-round' : '') }, i ? el('div', { class: 'advance' }, '▼ Los ganadores pasan a la siguiente ronda') : null, el('h3', { class: 'slotH' }, r, list[0] && fx(list[0].id).kickoff ? el('small', { class: 'slotD' }, dayLabel(fx(list[0].id).kickoff)) : null), list.map((b) => [
      el('div', { class: 'mcard' + (b.home && b.away ? ' tap' : ''), 'data-ko': b.id, ...(b.home && b.away ? { role: 'button', tabindex: '0', onclick: () => { TAB = 'partidos'; syncTabs(); open(b.id); }, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); TAB = 'partidos'; syncTabs(); open(b.id); } } } : {}) }, el('div', { class: 'mrow' }, side(b.home, b.homeSource), b.result ? el('div', { class: 'big' }, el('span', {}, L.finalScore(b.result).hg), el('span', { class: 'dash' }, '–'), el('span', {}, L.finalScore(b.result).ag)) : el('div', { class: 'big soon' }, t12(fx(b.id).kickoff) || 'vs'), side(b.away, b.awaySource, true)),
        el('div', { class: 'mfoot', 'data-ko-status': b.id }, el('span', { class: 'chip ' + (b.winner ? 'fin' : 'next') }, statusOf(b)),
          el('span', {}, [fx(b.id).kickoff && b.result ? t12(fx(b.id).kickoff) : '', fx(b.id).pitch, b.result && b.result.pens ? 'Penales ' + b.result.pens.hg + '-' + b.result.pens.ag : ''].filter(Boolean).join(' · '))))]))));
  },
  goleadores() {
    if (DATA.scorers === null) return [el('div', { class: 'empty', id: 'noscorers' }, 'Los goleadores no se guardan en el teléfono: vuelve a intentarlo con conexión.')];
    const st = DATA.stats, summary = st && st.played ? el('div', { class: 'sumCard', id: 'sumCard' }, el('div', {}, el('b', {}, st.goals), el('span', {}, 'goles')), el('div', {}, el('b', {}, st.played), el('span', {}, 'partidos')), el('div', {}, el('b', {}, String(st.perMatch).replace('.', ',')), el('span', {}, 'goles por partido'))) : null;
    const named = (DATA.scorers || []).reduce((n, x) => n + x.goals, 0), unnamed = st ? st.goals - named : 0;
    const unnamedNote = unnamed > 0 ? el('p', { class: 'meta center', id: 'unnamed' }, `${unnamed} ${unnamed === 1 ? 'gol' : 'goles'} sin autor anotado.`) : null;
    if (!DATA.scorers.length) return [summary, unnamedNote, el('div', { class: 'empty' }, 'Aún no hay goles con nombre. Aparecen cuando el árbitro anota quién metió cada gol.')].filter(Boolean);
    let rank = 0, prev = null;
    return [summary, unnamedNote, el('div', { class: 'tcard' }, el('h2', {}, 'Goleadores'), DATA.scorers.map((x, i) => { if (x.goals !== prev) { rank = i + 1; prev = x.goals; }
      const [who, team] = String(x.label).split(' · '); const soleLeader = DATA.scorers.filter((y) => y.goals === DATA.scorers[0].goals).length === 1;
      return el('div', { class: 'trow sc' + (rank === 1 && soleLeader ? ' lead' : '') }, el('span', { class: 'pos' }, rank), el('span', { class: 'tm' }, badge(team), el('span', { class: 'tn' }, who, el('small', {}, team))), el('span', {}), el('span', {}), el('span', { class: 'pts' }, x.goals), el('span', {})); })),
      null].filter(Boolean);
  },
};
function syncTabs() { document.querySelectorAll('nav.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === TAB))); }
const noLive = (x) => JSON.stringify({ ...x, asOf: 0, fixtures: (x.fixtures || []).map((f) => ({ ...f, live: undefined })) });
function render() {
  if (!DATA) return;
  header();
  view.replaceChildren(...(MATCH ? R.partido() : (R[TAB] || UCL_R[TAB])()));
}
function header() {
  document.getElementById('tname').textContent = DATA.tournament ? DATA.tournament.name : 'Torneo';
  document.getElementById('asof').textContent = [DATA.tournament && DATA.tournament.date ? new Date(DATA.tournament.date + 'T12:00').toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' }) : '', (STALE ? 'Sin conexión · datos de ' + (DATA.asOf ? fmtTime(DATA.asOf) : '—') : 'Actualizado ' + (DATA.asOf ? ago(DATA.asOf) : '—'))].filter(Boolean).join(' · ');
}
// What changed since the last load: new results (flash + toast) and table movement (▲/▼). Memory only; nothing is stored.
function trackChanges(d) {
  const res = new Set((d.fixtures || []).filter((f) => f.result).map((f) => f.id)), pos = {}; for (const t of Object.values(d.tables || {})) for (const r of t) pos[r.team] = r.position;
  if (LASTRES) { const fresh = [...res].filter((id) => !LASTRES.has(id)); if (fresh.length) { NEWRES = fresh; setTimeout(() => { NEWRES = []; render(); }, 9000); } }
  if (LASTPOS) { const mv = {}; let any = false; for (const [t, p] of Object.entries(pos)) if (LASTPOS[t] !== undefined && LASTPOS[t] !== p) { mv[t] = LASTPOS[t] - p; any = true; } if (any) MOVES = mv; }
  LASTRES = res; LASTPOS = pos;
}
async function load() {
  try {
    const r = await fetch('/api/public', { cache: 'no-store' });
    if (r.status === 503) { const j = await r.json(); DATA = null; view.replaceChildren(); setBanner('bad', 'Los resultados no están disponibles en este momento (' + j.detail + '). No mostramos datos que no podamos garantizar.'); document.getElementById('asof').textContent = 'No disponible'; return; }
    if (!r.ok) throw new Error('http ' + r.status);
    const prev = DATA; DATA = await r.json(); STALE = null; setBanner(null); trackChanges(DATA);
    var unchanged = !!prev && noLive(prev) === noLive(DATA); // T-1109: on an open match page a refresh with no news must not replace the page (focus, screen reader)
    { const names = [...new Set(Object.values(DATA.tables || {}).flat().map((x) => x.team))].sort(); TEAMIDX = Object.assign(Object.create(null), Object.fromEntries(names.map((n, i) => [n, i * 5 % 12 + (i >= 12 ? 1 : 0)]))); } // distinct colours: teams are spread over the palette by their order, not by a hash that can collide
    // W2-B-02: the offline copy NEVER contains player identities (consent can be revoked while this phone is offline)
    try { localStorage.setItem('ultimo', JSON.stringify(offlineCopy(DATA))); } catch {}
  } catch (e) {
    const c = localStorage.getItem('ultimo');
    if (c) { DATA = offlineCopy(JSON.parse(c)); STALE = true; setBanner('warn', 'Sin conexión: mostrando la última copia guardada. Puede no estar al día.'); }
    else { DATA = null; view.replaceChildren(); setBanner('bad', 'Sin conexión y sin copia guardada. Intenta de nuevo cuando tengas señal.'); document.getElementById('asof').textContent = 'No disponible'; return; }
  }
  if (unchanged && MATCH) return header();
  render();
}
document.querySelectorAll('nav.tabs button').forEach((b) => b.addEventListener('click', () => {
  TAB = b.dataset.tab; MATCH = null; syncTabs(); render();
}));
load(); setInterval(load, 20000); // while a match is live, refresh every 2 s so the minute runs
setInterval(tickLive, 2000);
function patchLiveMatch(f, lv) {
  const sc = document.querySelector('[data-match-page] .heroScore'); if (!sc) return render();
  const nums = [...sc.querySelectorAll('span')].filter((n) => !n.classList.contains('dash')), now = lv.hg + '-' + lv.ag, was = nums.map((n) => n.textContent).join('-');
  const pill = document.querySelector('[data-match-page] .heroPill .chip'); if (pill) pill.textContent = 'EN VIVO ' + lv.minute + "'";
  const mark = document.querySelector('#timeline .tli.now .tm'); if (mark) mark.textContent = 'En vivo ' + lv.minute + "'";
  if (was !== now && nums.length === 2) { nums[0].textContent = lv.hg; nums[1].textContent = lv.ag;
    const t = document.getElementById('timeline'), nt = timeline(f, { hg: lv.hg, ag: lv.ag }, lv, lv.goals); if (t && nt) t.replaceWith(nt);
    const ann = document.getElementById('liveAnn'); if (ann) ann.textContent = `Gol. ${f.home} ${lv.hg}, ${f.away} ${lv.ag}.`; } // only a real score change is announced
}
// The live minute updates IN PLACE (no re-render, so a tap or a scroll is never interrupted); any other change goes through the normal load().
async function tickLive() {
  if (!DATA || !DATA.fixtures || !DATA.fixtures.some((f) => f.live && !f.result)) return;
  try { const r = await fetch('/api/public', { cache: 'no-store' }); if (!r.ok) return; const d = await r.json(); 
    if (noLive(d) !== noLive(DATA)) return load(); const lf = (d.fixtures || []).find((f) => f.live && !f.result); DATA = d; if (!lf) return load(); const lv = lf.live;
    if (MATCH === lf.id) return patchLiveMatch(lf, lv); // T-1109 (TOR-T1106-10): patched in place so focus and a screen reader's place survive every tick
    const set = (sel, txt) => document.querySelectorAll(sel).forEach((n) => { n.textContent = txt; });
    set('#liveHero .lmin', lv.minute + "'"); const sc = document.querySelector('#liveHero .lhScore'); if (sc) sc.replaceChildren(el('span', {}, lv.hg), el('span', { class: 'dash' }, '–'), el('span', {}, lv.ag));
    const gl = document.querySelector('#liveHero .lhGoals'); if (gl) gl.replaceChildren(...lv.goals.map((g) => el('span', {}, `⚽ ${g.minute}' ${g.side === 'h' ? lf.home : lf.away}`)));
    document.querySelectorAll(`[data-fixture="${lf.id}"] .liveScore`).forEach((n) => n.replaceChildren(el('span', {}, lv.hg), el('span', { class: 'dash' }, '–'), el('span', {}, lv.ag))); document.querySelectorAll(`[data-fixture="${lf.id}"] .chip.live`).forEach((n) => { n.textContent = 'EN VIVO ' + lv.minute + "'"; });
  } catch { /* offline: the next load() shows the usual banner */ }
}
tabKeys(document.querySelector('nav.tabs'), 'view');
