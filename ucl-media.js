'use strict';
// MEDIA UI (videos/albums by link). T-1106: ON in the published build by founder decision 2026-11-06 (adult event). Minors' media stays hidden without verified guardian consent (engine/media.js).
(function () {
const KINDS = { partido: 'Del partido', cancha: 'De la cancha', aficion: 'Afición', equipos: 'Equipos', premios: 'Premiación', dia: 'Todo el día' };
const fxById = (id) => (DATA.fixtures || []).find((f) => f.id === id) || null;
const vTitle = (v) => { const f = fxById(v.fixtureId); return (f ? `${f.home || srcName(f.homeSource)} ${f.result ? L.finalScore(f.result).hg + '–' + L.finalScore(f.result).ag : 'vs'} ${f.away || srcName(f.awaySource)}` : 'Resumen del partido'); };
const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
// T-1109 (TOR-T1106-06): sample media is inert (no link at all) and says so, on every card.
const isSample = (x) => !!(window.TosDemoMedia && window.TosDemoMedia.isSample && window.TosDemoMedia.isSample(x)), linkOf = (x) => (isSample(x) ? null : safeUrl(x.url));
const sampleTag = (x, what) => (isSample(x) ? el('small', { class: 'demoTag' }, `Contenido de demostración — no es ${what} real`) : null);
// Cover art for a highlight: the two crests on a team-colour panel, a play button and the length. (A real frame needs a real file: not built.)
function videoCover(v, big) {
  const f = fxById(v.fixtureId), hn = f && f.home, an = f && f.away;
  const [c1] = PAL[hn ? ((hn in TEAMIDX) ? TEAMIDX[hn] % 12 : hash(hn) % 12) : 4], [c2] = PAL[an ? ((an in TEAMIDX) ? TEAMIDX[an] % 12 : hash(an) % 12) : 4], gid = 'vg' + hash(v.id);
  const art = sv('svg', { class: 'vart', viewBox: '0 0 160 90', preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true' },
    sv('defs', {}, sv('linearGradient', { id: gid, x1: 0, y1: 0, x2: 1, y2: 1 }, sv('stop', { offset: 0, 'stop-color': c1, 'stop-opacity': '.85' }), sv('stop', { offset: 0.5, 'stop-color': '#0a1f7a' }), sv('stop', { offset: 1, 'stop-color': c2, 'stop-opacity': '.85' }))),
    sv('rect', { width: 160, height: 90, fill: `url(#${gid})` }), sv('path', { d: 'M0 62Q80 50 160 62V90H0z', fill: '#06103a', opacity: '.5' }),
    hn ? crestSvg(hn, { x: 28, y: 14, width: 44, height: 44 }) : null, an ? crestSvg(an, { x: 88, y: 14, width: 44, height: 44 }) : null);
  return el('div', { class: 'vthumb' + (big ? ' big' : '') }, art, el('span', { class: 'play', 'aria-hidden': 'true' }), v.duration ? el('span', { class: 'dur' }, v.duration) : null);
}
// T-1110 (founder 2026-11-10: "host the actual video... only see it through the app"): our own file or a YouTube highlight PLAYS HERE, never sends you out.
// Own file = /videos/<id>.mp4 next to the app (the server serves it only while it is public). YouTube = privacy-enhanced embed. Veo has no player we can embed: it stays a link.
const OWN = /^\/videos\/(?:[a-f0-9]{32}|demo-[a-z0-9-]{1,30})\.mp4$/;
const ytId = (u) => { try { const x = new URL(u); if (x.protocol !== 'https:') return null; const h = x.hostname.replace(/^(www|m)\./, ''); let id = null;
  if (h === 'youtu.be') id = x.pathname.slice(1); else if (h === 'youtube.com') id = x.pathname === '/watch' ? x.searchParams.get('v') : (/^\/(?:shorts|embed|live)\/([^/]+)/.exec(x.pathname) || [])[1];
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null; } catch { return null; } };
const playable = (v) => !!v && (OWN.test(v.url || '') || !!ytId(v.url));
function player(v) {
  if (OWN.test(v.url)) { const p = el('video', { class: 'vplayer', src: '.' + v.url, controls: '', playsinline: '', preload: 'metadata', controlslist: 'nodownload', disablepictureinpicture: '', 'aria-label': 'Resumen: ' + vTitle(v), oncontextmenu: (e) => e.preventDefault() });
    p.addEventListener('error', () => p.replaceWith(el('div', { class: 'vplayer vgone' }, 'Este video ya no está disponible.'))); return p; }
  return el('iframe', { class: 'vplayer', src: `https://www.youtube-nocookie.com/embed/${ytId(v.url)}?rel=0&playsinline=1&autoplay=1`, title: 'Resumen: ' + vTitle(v), allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: '', referrerpolicy: 'strict-origin-when-cross-origin', loading: 'lazy' });
}
// Tap the cover: the cover turns into the player in the same spot (one video plays at a time).
const startPlay = (box, v) => { document.querySelectorAll('.vplaying').forEach((n) => { if (n !== box && n._cover) { n.querySelector('.vplayer') && n.querySelector('.vplayer').replaceWith(n._cover); n.classList.remove('vplaying'); } });
  const cov = box.querySelector('.vthumb'); if (!cov) return; box._cover = cov; const pl = player(v); cov.replaceWith(pl); box.classList.add('vplaying');
  if (pl.tagName === 'VIDEO') { const r = pl.play(); if (r && r.catch) r.catch(() => {}); } }; // play() inside the tap itself: iPhones only start a video from the finger's own event
const vlink = (v, kids, label, cls) => { if (playable(v)) { const box = el('div', { class: 'vitem vplay-in' + (cls ? ' ' + cls : ''), role: 'button', tabindex: '0', 'aria-label': (label || 'Ver resumen').replace('Ver', 'Reproducir') }, kids);
    const go = (e) => { if (box.classList.contains('vplaying')) return; if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); e.stopPropagation(); startPlay(box, v); };
    box.addEventListener('click', go); box.addEventListener('keydown', go); return box; }
  const u = linkOf(v); return el(u ? 'a' : 'div', { class: 'vitem' + (cls ? ' ' + cls : ''), ...(u ? { href: u, target: '_blank', rel: 'noopener noreferrer', 'aria-label': label || 'Ver resumen' } : {}) }, kids); };
const videoRow = (v) => vlink(v, [videoCover(v), el('div', { class: 'vtx' }, el('small', {}, (() => { const f = fxById(v.fixtureId); return f ? (f.stage === 'group' ? 'Grupo ' + f.groupId : f.round) + (f.kickoff ? ' · ' + L.t12(f.kickoff) : '') : 'Resumen'; })()), el('b', {}, vTitle(v)), sampleTag(v, 'un video')) ], 'Ver resumen: ' + vTitle(v));
// T-1110-2 (founder 2026-11-10: "Same with the pictures. They should open in the app. With the tournaments watermark."): an album is our own photos
// (/fotos/<id>.jpg, watermark already burned in), opened in a full-screen viewer INSIDE the app. Nothing links out. The server serves a photo only while its album is public.
const OWNP = /^\/fotos\/(?:[a-f0-9]{32}|demo-[a-z0-9-]{1,30})\.jpg$/;
const pics = (a) => (Array.isArray(a.photos) ? a.photos.filter((u) => OWNP.test(u)) : []);
const albumName = (a) => KINDS[a.kind] || 'Álbum';
function openAlbum(a, start) {
  const ps = pics(a); if (!ps.length) return; let i = Math.max(0, Math.min(start || 0, ps.length - 1)); const f = a.fixtureId ? fxById(a.fixtureId) : null, back = document.activeElement;
  const img = el('img', { class: 'pvimg', alt: '', decoding: 'async', draggable: 'false', oncontextmenu: (e) => e.preventDefault() }), count = el('span', { class: 'pvcount', 'aria-live': 'polite' });
  const gone = el('div', { class: 'pvgone', hidden: '' }, 'Esta foto ya no está disponible.');
  img.addEventListener('error', () => { img.hidden = true; gone.hidden = false; }); img.addEventListener('load', () => { img.hidden = false; gone.hidden = true; });
  const thumbs = el('div', { class: 'pvthumbs', role: 'list' }, ps.map((u, k) => el('button', { type: 'button', class: 'pvthumb', role: 'listitem', 'aria-label': `Foto ${k + 1} de ${ps.length}`, onclick: () => show(k) }, el('img', { src: '.' + u, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }))));
  function show(k) { i = (k + ps.length) % ps.length; img.src = '.' + ps[i]; img.alt = `${albumName(a)}, foto ${i + 1} de ${ps.length}`; count.textContent = `${i + 1} / ${ps.length}`;
    thumbs.querySelectorAll('.pvthumb').forEach((t, k2) => t.setAttribute('aria-current', String(k2 === i))); const cur = thumbs.children[i]; if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'center' }); }
  let closed = false; const close = (fromPop) => { if (closed) return; closed = true; box.remove(); document.body.classList.remove('pvopen'); document.removeEventListener('keydown', key); window.removeEventListener('popstate', pop); if (!fromPop && history.state && history.state.tosFoto) history.back(); if (back && back.focus) back.focus(); };
  const pop = () => close(true), key = (e) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') show(i + 1); else if (e.key === 'ArrowLeft') show(i - 1); };
  const box = el('div', { class: 'pview', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Álbum: ' + albumName(a) },
    el('div', { class: 'pvbar' }, el('div', { class: 'pvtitle' }, el('b', {}, albumName(a)), f ? el('small', {}, (f.home || '') + ' vs ' + (f.away || '')) : null, sampleTag(a, 'un álbum')), count, el('button', { type: 'button', class: 'pvclose', 'aria-label': 'Cerrar el álbum', onclick: () => close() }, '×')),
    el('div', { class: 'pvstage' }, img, gone, ps.length > 1 ? el('button', { type: 'button', class: 'pvnav prev', 'aria-label': 'Foto anterior', onclick: () => show(i - 1) }, '‹') : null, ps.length > 1 ? el('button', { type: 'button', class: 'pvnav next', 'aria-label': 'Foto siguiente', onclick: () => show(i + 1) }, '›') : null),
    ps.length > 1 ? thumbs : null);
  let x0 = null; box.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true }); box.addEventListener('touchend', (e) => { if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 45) show(i + (dx < 0 ? 1 : -1)); });
  document.body.append(box); document.body.classList.add('pvopen'); document.addEventListener('keydown', key);
  try { history.pushState({ tosFoto: 1 }, ''); window.addEventListener('popstate', pop); } catch {} // the phone's back button closes the album instead of leaving the app
  show(i); box.querySelector('.pvclose').focus();
}
const albumTile = (a) => { const ps = pics(a), f = a.fixtureId ? fxById(a.fixtureId) : null, gid = 'ag' + hash(a.id);
  const art = ps.length ? el('img', { class: 'aart aimg', src: '.' + ps[0], alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }) : sv('svg', { class: 'aart', viewBox: '0 0 120 160', preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true' }, sv('defs', {}, sv('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, sv('stop', { offset: 0, 'stop-color': PAL[hash(a.id) % 12][0], 'stop-opacity': '.9' }), sv('stop', { offset: 1, 'stop-color': '#06103a' }))), sv('rect', { width: 120, height: 160, fill: `url(#${gid})` }),
    sv('g', { fill: 'none', stroke: '#fff', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: '.9' }, sv('rect', { x: 34, y: 44, width: 52, height: 40, rx: 8 }), sv('circle', { cx: 60, cy: 64, r: 10 }), sv('path', { d: 'M46 44l4-8h20l4 8' })));
  const kids = [art, ps.length ? el('span', { class: 'abadge' }, ps.length + (ps.length === 1 ? ' foto' : ' fotos')) : null, el('div', { class: 'acap' }, albumName(a), f ? el('small', {}, (f.home || '') + ' vs ' + (f.away || '')) : null, sampleTag(a, 'un álbum'))];
  return ps.length ? el('button', { type: 'button', class: 'atile', 'aria-label': `Abrir el álbum: ${albumName(a)} (${ps.length} fotos)`, onclick: () => openAlbum(a, 0) }, kids) : el('div', { class: 'atile' }, kids); };
// Highlight chip shown on a match card when a video is linked to it (like the UCL fixture card).
const vidChip = (f) => { const v = (DATA.videos || []).find((x) => x.fixtureId === f.id); if (!v) return null; if (playable(v)) return el('span', { class: 'vchip' }, el('span', { class: 'vplay', 'aria-hidden': 'true' }), isSample(v) ? 'Resumen de demostración' : 'Ver el resumen aquí', v.duration ? el('b', {}, v.duration) : null); if (isSample(v)) return el('span', { class: 'vchip' }, el('span', { class: 'vplay', 'aria-hidden': 'true' }), 'Resumen de demostración', v.duration ? el('b', {}, v.duration) : null); const u = safeUrl(v.url); return u ? el('a', { class: 'vchip', href: u, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation(), 'aria-label': 'Ver el resumen de este partido' }, el('span', { class: 'vplay', 'aria-hidden': 'true' }), 'Resumen del partido', v.duration ? el('b', {}, v.duration) : null) : null; };
function matchMedia(f) { const vs = (DATA.videos || []).filter((x) => x.fixtureId === f.id), as = (DATA.albums || []).filter((x) => x.fixtureId === f.id);
  return [...(vs.length ? [el('h3', { class: 'secT' }, 'Resumen'), ...vs.map((v) => (playable(v) ? vlink(v, [el('div', { class: 'vfeat' }, videoCover(v, true), el('div', { class: 'vtx' }, el('small', {}, isSample(v) ? 'DEMOSTRACIÓN' : 'RESUMEN'), el('b', {}, vTitle(v)), sampleTag(v, 'un video')))], 'Ver resumen: ' + vTitle(v), 'vfeatlink') : el('div', { class: 'card vcard' }, videoRow(v))))] : []), ...(as.length ? [el('h3', { class: 'secT' }, 'Fotos'), el('div', { class: 'agrid' }, as.map(albumTile))] : [])]; }
let VF = 'Todos';
const videosPage = () => { const vs = (DATA.videos || []).slice().reverse(), groups = [...new Set(vs.map((v) => { const f = fxById(v.fixtureId); return f && f.stage === 'group' ? 'Grupo ' + f.groupId : null; }).filter(Boolean))].sort();
  const list = vs.filter((v) => { if (VF === 'Todos') return true; const f = fxById(v.fixtureId); return f && (VF === 'Grupo ' + f.groupId || VF === f.home || VF === f.away); });
  const out = [el('h2', { class: 'pageT' }, 'Videoteca'), el('p', { class: 'meta pageS' }, 'Resúmenes de los partidos')];
  if (!vs.length) return [...out, el('div', { class: 'empty' }, 'Todavía no hay resúmenes. Aparecen aquí cuando el organizador los agrega.')];
  if (groups.length) out.push(chips('vf', ['Todos', ...groups].map((g) => [g, g]), VF, (v) => { VF = v; render(); }, 'Filtrar videos', true));
  const [first, ...rest] = list; if (!first) return [...out, el('div', { class: 'empty' }, 'No hay resúmenes con este filtro.')];
  return [...out, vlink(first, [el('div', { class: 'vfeat' }, videoCover(first, true), el('div', { class: 'vtx' }, el('small', {}, isSample(first) ? 'DEMOSTRACIÓN' : 'NUEVO'), el('b', {}, vTitle(first)), sampleTag(first, 'un video')))], 'Ver resumen: ' + vTitle(first), 'vfeatlink'), rest.length ? el('div', { class: 'card' }, rest.map(videoRow)) : null].filter(Boolean); };
const fotosPage = () => { const as = (DATA.albums || []).slice().reverse(); const out = [el('h2', { class: 'pageT' }, 'Fototeca'), el('p', { class: 'meta pageS' }, 'Álbumes del torneo · se abren aquí, con la marca del torneo')];
  return as.length ? [...out, el('div', { class: 'agrid' }, as.map(albumTile))] : [...out, el('div', { class: 'empty' }, 'Todavía no hay álbumes. Aparecen aquí cuando el organizador los agrega.')]; };
window.UclMedia = { vidChip, matchMedia, videos: videosPage, fotos: fotosPage, openAlbum };
})();
