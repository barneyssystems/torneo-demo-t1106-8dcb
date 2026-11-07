'use strict';
// R6-02: scores typed offline must stay reachable when a referee code stops working. Pure helpers over a localStorage-like object (get/set/remove),
// so they are unit-tested in node and used by ref.js in the browser. Nothing here ever deletes an item except `discard` (explicit, confirmed in the UI) and expiry.
(function (root) {
  const QKEY = 'refQueue:', RKEY = 'refRecover', EXPIRY = 36 * 3600 * 1000;
  const read = (st, k, d) => { try { const v = JSON.parse(st.getItem(k) || 'null'); return v === null ? d : v; } catch { return d; } };
  const write = (st, k, v) => { try { st.setItem(k, JSON.stringify(v)); return true; } catch { return false; /* full storage: keep what is there */ } };
  // Remember that namespace `ns` (the hash of the old code) holds unsent scores. Called BEFORE the token is cleared.
  function remember(st, ns) { const list = read(st, RKEY, []); if (!list.includes(ns)) { list.push(ns); write(st, RKEY, list); } }
  // Every unsent item (pending OR failed) in every remembered namespace, not expired.
  function items(st, now) { const out = []; for (const ns of read(st, RKEY, [])) for (const it of read(st, QKEY + ns, [])) if (now - (it.at || 0) < EXPIRY) out.push({ ns, item: it }); return out; }
  // A human-readable, LOSSLESS description of one retained report (R7-04): every part is shown, nothing is reduced to hg-ag.
  function describe(item) {
    const r = item.report || {}, bits = [`${item.title}: ${r.hg} - ${r.ag}`];
    if (r.wo) bits.push(`W.O.: no se presentó ${r.wo === 'h' ? 'el local' : 'el visitante'}`);
    if (r.et) bits.push(`prórroga ${r.et.hg} - ${r.et.ag}`); if (r.pens) bits.push(`penales ${r.pens.hg} - ${r.pens.ag}`);
    if (Array.isArray(r.goals)) bits.push(`${r.goals.length} gol${r.goals.length === 1 ? '' : 'es'} anotados`); if (Array.isArray(r.cards)) bits.push(`${r.cards.length} tarjeta${r.cards.length === 1 ? '' : 's'}`);
    if (Array.isArray(r.invasion) && r.invasion.length) bits.push('invasión de cancha anotada'); return bits.join(' · ');
  }
  // Every part of one report, one line each (R8-04): inspectable on screen, no JSON needed to understand it.
  function detail(item) {
    const r = item.report || {}, side = (s) => (s === 'h' ? 'local' : s === 'a' ? 'visita' : '?'), out = [describe(item)];
    (r.goals || []).forEach((g, i) => out.push(`Gol ${side(g.side)}${g.playerId ? ' · jugador ' + g.playerId : ' · sin jugador'}${g.minute !== undefined && g.minute !== null ? ' · minuto ' + g.minute : ''}`));
    (r.cards || []).forEach((c) => out.push(`Tarjeta ${c.type || ''} ${side(c.side)}${c.playerId ? ' · jugador ' + c.playerId : ''}${c.minute !== undefined && c.minute !== null ? ' · minuto ' + c.minute : ''}`.replace(/\s+/g, ' ').trim()));
    (r.invasion || []).forEach((v) => out.push('Invasión de cancha' + (v && v.minute !== undefined ? ' · minuto ' + v.minute : ''))); return out.join('\n');
  }
  // For «Copiar»: the readable line PLUS the exact data, so nothing is lost even if the screen shows a summary.
  const lines = (list) => list.map(({ item }) => detail(item) + '\n  datos: ' + JSON.stringify(item.report || {})).join('\n');
  // Move all recovered items under a NEW (valid) code's namespace, fresh ids, failure flags cleared, so they are retried. Old namespaces are then removed.
  function migrate(st, toNs, now, newId) {
    const moved = items(st, now); if (!moved.length) return 0;
    const target = read(st, QKEY + toNs, []), ids = moved.map((_, i) => newId(i)); moved.forEach(({ item }, i) => { const { failed, ...rest } = item; target.push({ ...rest, id: ids[i] }); });
    if (!write(st, QKEY + toNs, target)) return -1;
    const back = read(st, QKEY + toNs, []); if (!ids.every((id) => back.some((x) => x.id === id))) return -1; // transactional: the old namespace is removed only after the new one is verified
    for (const ns of read(st, RKEY, [])) if (ns !== toNs) st.removeItem(QKEY + ns); st.removeItem(RKEY); return moved.length;
  }
  // Explicit discard (the UI asks first).
  function discard(st) { for (const ns of read(st, RKEY, [])) st.removeItem(QKEY + ns); st.removeItem(RKEY); }
  const api = { remember, items, describe, detail, lines, migrate, discard, QKEY, RKEY, EXPIRY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Recovery = api;
})(typeof window !== 'undefined' ? window : globalThis);
