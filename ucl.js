'use strict';
// Champions-style media screens (Night 7): generated crests (SVG), Videoteca, Fototeca, highlight chip on match cards, media on the match page.
// Pure DOM building (no innerHTML, no inline styles: CSP). Links open the organizer-approved Veo/album URL in a new tab; nothing is fetched or embedded.
const SVGNS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs, ...kids) => { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v)); for (const c of kids.flat()) if (c) n.append(c); return n; };
const PAL = [['#f2b705', '#7a1030'], ['#e5484d', '#0b1b4d'], ['#ff7a18', '#101010'], ['#18a0d8', '#ffffff'], ['#8892b0', '#1a2147'], ['#12b76a', '#052e1c'], ['#7c4dff', '#f2b705'], ['#ffffff', '#c1121f'], ['#0ea5a4', '#10244f'], ['#d946ef', '#3b0764'], ['#84cc16', '#1a2e05'], ['#fb7185', '#4c0519']];
const hash = (s) => { let h = 5381; for (const c of String(s || '?')) h = ((h * 33) ^ c.codePointAt(0)) >>> 0; return h; };
// A crest = 4 independent choices (colour pair × shape × pattern × emblem), all derived from the team's slot in the tournament (TEAMIDX), or from its name for an unknown team.
// Within one tournament no two teams share more than one choice, so the badges read as different clubs. Invented marks only: no logos, no IP.
const SHAPES = ['M18 2 31 6v12c0 8-6 13-13 16C11 31 5 26 5 18V6z', 'M18 2a16 16 0 100 32 16 16 0 000-32z', 'M18 2l14 8v16l-14 8-14-8V10z', 'M5 4h26v16c0 8-8 12-13 14C13 32 5 28 5 20z', 'M18 2l15 14-15 18L3 16z', 'M4 5l14-3 14 3v14c0 9-8 13-14 15C12 32 4 28 4 19z'];
const PATTERNS = [() => null, (b) => sv('path', { d: 'M18 0h20v40H18z', fill: b, opacity: '.28' }), (b) => sv('path', { d: 'M0 15h40v8H0z', fill: b, opacity: '.3' }), (b) => sv('path', { d: 'M-2 30L22 -2l8 0L6 36z', fill: b, opacity: '.3' }),
  (b) => sv('g', { fill: b, opacity: '.28' }, sv('path', { d: 'M0 8h40v5H0z' }), sv('path', { d: 'M0 22h40v5H0z' })), (b) => sv('path', { d: 'M0 20l18-12 18 12v8L18 16 0 28z', fill: b, opacity: '.3' })];
const EMBLEMS = [(f) => sv('path', { d: 'M18 9l2.6 5.6 6 .7-4.4 4.1 1.2 6L18 22.5 12.6 25.4l1.2-6-4.4-4.1 6-.7z', fill: f }), (f) => sv('path', { d: 'M20 7L11 20h6l-2 9 10-14h-6z', fill: f }), (f) => sv('path', { d: 'M22 8a10 10 0 100 20 8 8 0 010-20z', fill: f }),
  (f) => sv('path', { d: 'M8 25l2-12 5 5 3-8 3 8 5-5 2 12z', fill: f }), (f) => sv('g', { fill: f }, sv('circle', { cx: 18, cy: 18, r: 8 }), sv('path', { d: 'M18 13l4 3-1.5 4.5h-5L14 16z', fill: '#06103a', opacity: '.7' })),
  (f) => sv('g', { fill: f }, sv('rect', { x: 9, y: 9, width: 4, height: 18 }), sv('rect', { x: 16, y: 9, width: 4, height: 18 }), sv('rect', { x: 23, y: 9, width: 4, height: 18 })), (f) => sv('path', { d: 'M9 13l9 7 9-7v6l-9 7-9-7z', fill: f }),
  (f) => sv('g', { fill: 'none', stroke: f, 'stroke-width': 3 }, sv('circle', { cx: 18, cy: 18, r: 8 }), sv('circle', { cx: 18, cy: 18, r: 2.5, fill: f }))];
const crestParts = (name) => { const own = Object.prototype.hasOwnProperty.call(TEAMIDX, name), h = hash(name), i = own ? TEAMIDX[name] : h % 12;
  return { pal: i % 12, shape: i % SHAPES.length, pattern: own ? Math.floor(i / 2) % PATTERNS.length : (h >>> 5) % PATTERNS.length, emblem: i % EMBLEMS.length }; };
let _cid = 0;
function crestSvg(name, attrs) {
  const c = crestParts(name), [a, b] = PAL[c.pal], shape = SHAPES[c.shape], id = 'cl' + (_cid++), pat = PATTERNS[c.pattern](b);
  return sv('svg', { viewBox: '0 0 36 36', role: 'img', 'aria-hidden': 'true', ...(attrs || {}) }, sv('defs', {}, sv('clipPath', { id }, sv('path', { d: shape }))), sv('path', { d: shape, fill: a }), pat ? sv('g', { 'clip-path': `url(#${id})` }, pat) : null,
    sv('path', { d: 'M5 5h26v7H5z', fill: '#fff', opacity: '.14', 'clip-path': `url(#${id})` }), EMBLEMS[c.emblem](b), sv('path', { d: shape, fill: 'none', stroke: b, 'stroke-opacity': '.55', 'stroke-width': '1.5' }));
}
// T-1106 (founder decision 2026-11-06): photos and videos ON as LINKS ONLY (Veo/YouTube highlights, shared albums) that the organizer adds; no upload, no files stored.
// The screens come from media-ui/ucl-media.js; without it (a build with --no-media) these fall back to one honest line.
const NO_MEDIA_LINE = 'Todavía no hay videos ni fotos.';
const mediaOff = (title) => [el('h2', { class: 'pageT' }, title), el('div', { class: 'empty calm', id: 'noMedia' }, NO_MEDIA_LINE)];
const vidChip = (f) => (window.UclMedia ? window.UclMedia.vidChip(f) : null);
const matchMedia = (f) => (window.UclMedia ? window.UclMedia.matchMedia(f) : []);
const UCL_R = { videos: () => (window.UclMedia ? window.UclMedia.videos() : mediaOff('Videoteca')), fotos: () => (window.UclMedia ? window.UclMedia.fotos() : mediaOff('Fototeca')) };
