'use strict';
// DOM helpers: text only (never innerHTML with data).
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (v === null || v === undefined) continue; if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
// A designed picker: a row of big tap chips instead of a native <select>. opts = [[value, text, disabled?]]. The container keeps `id` so tests and links can find it.
function chips(id, opts, cur, onPick, label, scroll) {
  return el('div', { class: 'chips' + (scroll ? ' scroll' : ''), id, role: 'radiogroup', 'aria-label': label || '' }, opts.map(([v, t, off]) => el('button', { type: 'button', class: 'chip2' + (off ? ' busy' : ''), role: 'radio', 'aria-checked': String(String(v) === String(cur)), 'data-val': String(v), ...(off ? { 'aria-disabled': 'true', disabled: 'disabled' } : {}), onclick: () => onPick(v) }, t)));
}
function srcLabel(s) { const m = /^([1-9])(.+)$/.exec(s || ''); if (m) return `${m[1]}º Grupo ${m[2]}`; const w = /^W:(.+)$/.exec(s || ''); return w ? `Ganador ${w[1]}` : 'Por definir'; }
function scoreText(r) { if (!r) return null; let s = `${r.hg} - ${r.ag}`; if (r.wo) s += ` (W.O.: no se presentó ${r.wo === 'h' ? 'el local' : 'el visitante'})`; if (r.et) s += ` · Prór. ${r.et.hg}-${r.et.ag}`; if (r.pens) s += ` (${r.pens.hg}-${r.pens.ag} pen.)`; return s; }
function fmtTime(iso) { if (!iso) return ''; try { return new Date(iso).toLocaleString('es', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }); } catch { return iso; } }
const ERR_ES = { menor_requiere_tutor: 'para un menor firma su madre, padre o tutor', adulto_firma_por_si_mismo: 'un jugador adulto firma por sí mismo', texto_desactualizado: 'el texto cambió; recarga y vuelve a leerlo', ya_firmado: 'ya estaba firmada', consentimiento_no_vigente: 'no hay un permiso activo para verificar', sin_consentimiento_activo: 'no hay un permiso activo', enlace_no_valido_para_este_jugador: 'enlace no válido', solo_familia: 'este enlace solo sirve para firmar', fuente_no_clasifica: 'esa posición no clasifica con la regla actual', fuente_fuera_de_orden: 'el ganador que alimenta este partido debe ser de una eliminatoria anterior', evento_invalido: 'faltan datos o hay un dato no válido', correccion_sin_motivo: 'escribe el motivo de la corrección', hay_un_reporte_mas_nuevo: 'el árbitro mandó un marcador más nuevo; revísalo y aprueba ese', ya_aprobado: 'ya estaba aprobado', partido_no_asignado: 'este partido no está asignado a ti', equipos_por_definir: 'los equipos aún no están definidos', id_repetido: 'ya existe', equipos_fuera_del_grupo: 'los equipos no son de ese grupo', rollback_invalido: 'número de evento o motivo no válido', respaldo_alterado: 'el respaldo fue alterado', respaldo_truncado: 'el respaldo está incompleto', respaldo_invalido: 'el archivo no es un respaldo', sin_sesion: 'código no válido', solo_organizador: 'solo el organizador puede hacer esto', equipos_cambiaron: 'cambiaron los equipos de este partido; anota el resultado de nuevo', partido_ya_jugado: 'un partido que ya se jugó no se puede cambiar de lugar', partido_cancelado: 'ese partido se canceló porque un equipo se retiró', choque_de_equipo: 'un equipo ya juega a esa hora en otro partido', cancha_ocupada: 'esa cancha ya tiene otro partido a esa hora', orden_de_partidos: 'ese partido debe jugarse después de los que lo alimentan', solo_arbitro: 'solo el árbitro puede hacer esto' };
const errEs = (j, status) => j.detail || ERR_ES[j.error] || 'No pudimos guardar. Intenta otra vez; si sigue igual, no apruebes más resultados.';

// ARIA tabs keyboard pattern: one tab in the tab order (the selected one), the arrow keys, Home and End move focus AND selection, tabs point at their panel. `panelId` = the element that shows the content.
function tabKeys(nav, panelId) {
  if (!nav) return; const tabs = () => [...nav.querySelectorAll('[role=tab]')].filter((t) => t.getClientRects().length > 0), panel = panelId && document.getElementById(panelId);
  if (panel) { panel.setAttribute('role', 'tabpanel'); [...nav.querySelectorAll('[role=tab]')].forEach((t) => t.setAttribute('aria-controls', panelId)); }
  const sync = () => [...nav.querySelectorAll('[role=tab]')].forEach((t) => { t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1; });
  new MutationObserver(sync).observe(nav, { subtree: true, attributes: true, attributeFilter: ['aria-selected'] }); sync();
  nav.addEventListener('keydown', (e) => { const list = tabs(), i = list.indexOf(document.activeElement); if (i < 0) return; let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % list.length; else if (e.key === 'ArrowLeft') n = (i - 1 + list.length) % list.length; else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = list.length - 1;
    if (n === null) return; e.preventDefault(); list[n].focus(); list[n].click(); });
}
