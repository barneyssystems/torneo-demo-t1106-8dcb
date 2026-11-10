'use strict';
// T-1110-2 (founder 2026-11-10: "Same with the pictures. They should open in the app. With the tournaments watermark.").
// Burns the tournament's mark (crest + name) into a photo ON THE ORGANIZER'S PHONE, before upload, and re-encodes it as a plain JPEG:
// re-drawing on a canvas keeps only the pixels, so location (GPS), camera data and every hidden block are gone. The server re-checks that (server/photo-files.js).
// The same function makes the demo's sample photos (scripts/make-demo-photos.js). Lives in media-ui/: shipped only when media is ON, so what the demo shows is what Dad's upload produces.
(function () {
  const MAX_SIDE = 2048, QUALITY = 0.86;
  const loadImg = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('no_img')); i.src = src; });
  // A phone photo -> something drawable, upright (EXIF orientation applied by the browser before the metadata is dropped).
  async function decode(file) {
    if (window.createImageBitmap) { try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {} }
    const u = URL.createObjectURL(file); try { return await loadImg(u); } finally { setTimeout(() => URL.revokeObjectURL(u), 1000); }
  }
  // The mark: a dark rounded plate in the bottom-right corner with the crest and the tournament name, sized to the photo (readable on a phone, never covering the middle).
  function stamp(ctx, W, H, name, crest) {
    const u = Math.max(14, Math.round(Math.min(W, H) * 0.045)), pad = Math.round(u * 0.45), ch = Math.round(u * 1.9), cw = crest ? Math.round(ch * (crest.width / crest.height)) : 0;
    const text = String(name || 'Torneo').toUpperCase().slice(0, 40);
    ctx.font = `italic 800 ${u}px "Barlow Condensed", "Arial Narrow", sans-serif`; const tw = Math.ceil(ctx.measureText(text).width);
    const w = Math.min(W - 2 * pad, pad * 3 + cw + tw), h = ch + pad * 2, x = W - w - pad, y = H - h - pad, r = Math.round(h * 0.28);
    ctx.save(); ctx.globalAlpha = 0.72; ctx.fillStyle = '#06103a'; ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fill(); ctx.restore();
    if (crest) ctx.drawImage(crest, x + pad, y + pad, cw, ch);
    ctx.save(); ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.95; ctx.textBaseline = 'middle'; ctx.fillText(text, x + pad * 2 + cw, y + h / 2, w - pad * 3 - cw); ctx.restore();
  }
  // source = ImageBitmap | HTMLImageElement | HTMLCanvasElement. Returns a canvas (≤ 2048 px on the long side) with the mark burned in.
  function burn(source, { name, crest } = {}) {
    const sw = source.width, sh = source.height; if (!(sw > 0 && sh > 0)) throw new Error('foto_vacia');
    const k = Math.min(1, MAX_SIDE / Math.max(sw, sh)), W = Math.round(sw * k), H = Math.round(sh * k);
    const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
    ctx.drawImage(source, 0, 0, W, H); stamp(ctx, W, H, name, crest); return c;
  }
  // Browsers add their own blocks to a canvas JPEG (Chrome: an ICC colour profile in APP2). Keep only the image: drop every APP1..APP15 and comment block before upload.
  // The server refuses any JPEG that still has one (server/photo-files.js checkJpeg).
  function clean(u8) { if (u8[0] !== 0xff || u8[1] !== 0xd8) throw new Error('no_jpg'); const keep = [u8.subarray(0, 2)]; let p = 2;
    while (p + 4 <= u8.length) { if (u8[p] !== 0xff) throw new Error('no_jpg'); const m = u8[p + 1]; if (m === 0xda) { keep.push(u8.subarray(p)); break; } const len = (u8[p + 2] << 8) | u8[p + 3];
      if ((m >= 0xe1 && m <= 0xef) || m === 0xfe) { p += 2 + len; continue; } keep.push(u8.subarray(p, p + 2 + len)); p += 2 + len; }
    return new Blob(keep, { type: 'image/jpeg' }); }
  const toJpeg = (canvas) => new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error('no_jpg'))), 'image/jpeg', QUALITY)).then(async (b) => clean(new Uint8Array(await b.arrayBuffer())));
  let CREST = null;
  async function crest() { if (!CREST) { CREST = loadImg('crest.jpg').catch(() => null); } return CREST; }
  async function fonts() { try { if (document.fonts) await document.fonts.load('italic 800 40px "Barlow Condensed"'); } catch {} }
  // One phone photo -> a watermarked, metadata-free JPEG Blob ready to upload.
  async function prepare(file, name) { await fonts(); const [img, c] = await Promise.all([decode(file), crest()]); const cv = burn(img, { name, crest: c }); if (img.close) img.close(); return toJpeg(cv); }
  window.TosMarca = { burn, toJpeg, clean, prepare, crest, fonts, MAX_SIDE };
})();
