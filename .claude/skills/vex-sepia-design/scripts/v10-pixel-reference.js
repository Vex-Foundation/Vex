// V10 Sepia Counter: shared helpers. Deterministic (seeded), canvas 2D + inline SVG only.
(function () {
  const DPR = 2;
  const ART = './art/';
  const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('load ' + src)); i.src = src; });
  function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

  // full-frame (or element-sized) canvas at DPR 2
  function makeCanvas(el) {
    const w = el.clientWidth, h = el.clientHeight;
    el.width = Math.round(w * DPR); el.height = Math.round(h * DPR);
    const ctx = el.getContext('2d', { willReadFrequently: true });
    return { ctx, W: el.width, H: el.height, w, h };
  }

  // Photo, cover-fitted. zoom >1 crops in; fx/fy pick the crop window (0..1). blur in CSS px.
  async function photo(canvas, o) {
    const { ctx, W, H } = makeCanvas(canvas);
    const img = await load(o.src);
    const zoom = o.zoom || 1, fx = o.fx ?? .5, fy = o.fy ?? .5;
    const scale = Math.max(W / img.width, H / img.height) * zoom;
    const dw = img.width * scale, dh = img.height * scale;
    const dx = (W - dw) * fx, dy = (H - dh) * fy;
    ctx.save();
    if (o.flip) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    if (o.blur) {
      // overscan so the blur never pulls transparent edges in
      const p = o.blur * DPR * 3;
      ctx.filter = `blur(${o.blur * DPR}px)`;
      ctx.drawImage(img, dx - p, dy - p, dw + 2 * p, dh + 2 * p);
    } else {
      ctx.drawImage(img, dx, dy, dw, dh);
    }
    ctx.restore();
    if (o.bright) { // a plain exposure change of the print (no tint): multiply by a neutral grey
      ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = `rgb(${o.bright},${o.bright},${o.bright})`; ctx.fillRect(0, 0, W, H); ctx.restore();
    }
    return { ctx, W, H, img, map: (x, y) => [(x * DPR - dx) / scale, (y * DPR - dy) / scale] };
  }

  // one dithered cell: 4x4 ordered dots, density 0..1. cols/rows restrict to a sub band
  function ditherCell(ctx, x, y, c, dens, o = {}) {
    const p = c / 4, s = Math.max(1, Math.round(p * (o.dot || .62)));
    const u0 = o.u0 ?? 0, u1 = o.u1 ?? 4, v0 = o.v0 ?? 0, v1 = o.v1 ?? 4;
    for (let v = v0; v < v1; v++) for (let u = u0; u < u1; u++) {
      if (BAYER[v][u] < dens * 16) ctx.fillRect(Math.round(x + u * p), Math.round(y + v * p), s, s);
    }
  }

  // A sprite (bird / any RGBA) re-built as white pixel blocks with dithered motion trails (tweet HSA7).
  // o: x,y (css top-left), w (css width), cell (css px per block), flip, seed, color,
  //    trail (prob per row), trailLen (cells), dir (+1 flying right, trails to the left)
  function pixelSprite(ctx, img, o) {
    const cell = o.cell, c = Math.round(cell * DPR);
    const gw = Math.max(4, Math.round(o.w / cell));
    const gh = Math.max(3, Math.round(gw * img.height / img.width));
    const off = document.createElement('canvas'); off.width = gw; off.height = gh;
    const oc = off.getContext('2d', { willReadFrequently: true });
    oc.imageSmoothingEnabled = true; oc.imageSmoothingQuality = 'high';
    if (o.flip) { oc.translate(gw, 0); oc.scale(-1, 1); }
    oc.drawImage(img, 0, 0, gw, gh);
    const d = oc.getImageData(0, 0, gw, gh).data;
    const R = rng(o.seed || 1);
    const X0 = Math.round(o.x * DPR), Y0 = Math.round(o.y * DPR);
    const type = new Uint8Array(gw * gh), dens = new Float32Array(gw * gh);
    const athr = o.athr ?? .42, dark = o.dark ?? .40;
    const lum = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const k = (j * gw + i) * 4, a = d[k + 3] / 255;
      if (a < athr) continue;
      const L = (d[k] + d[k + 1]) / 510;
      lum[j * gw + i] = L;
      if (L < dark) { type[j * gw + i] = 1; }
      else { type[j * gw + i] = 2; dens[j * gw + i] = Math.min(1, .38 + (1 - L) * .55); }
    }
    if (o.lattice) {
      // tweet HSA7 look: the silhouette edge stays solid, highlights open up into gaps
      // (the photo shows through), mid tones become a coarse sparse dither.
      const filled = (i, j) => i >= 0 && j >= 0 && i < gw && j < gh && type[j * gw + i] > 0;
      const t2 = type.slice();
      for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
        const k = j * gw + i; if (!type[k]) continue;
        const edge = !filled(i - 1, j) || !filled(i + 1, j) || !filled(i, j - 1) || !filled(i, j + 1);
        const L = lum[k];
        if (edge) { t2[k] = 1; continue; }
        if (o.natural) {
          // light reads as white: highlights solid, shadows a sparse dither, deepest shadow open
          if (L >= dark) { t2[k] = 1; continue; }
          const h = ((i * 73856093) ^ (j * 19349663)) >>> 0;
          if ((h % 100) / 100 < (o.shadowOpen ?? .35)) { t2[k] = 3; continue; }
          t2[k] = 2; dens[k] = o.shadow ?? .5; continue;
        }
        if (L >= (o.open ?? .72)) { t2[k] = 3; continue; }          // open: gap
        if (L >= dark) { t2[k] = 2; dens[k] = o.mid ?? .42; continue; } // lavender: sparse dither
        t2[k] = 1;
      }
      type.set(t2);
    }
    ctx.fillStyle = o.color || '#FFFFFF';
    const dir = o.dir ?? 1;
    // row tears: shift a few rows by one cell against the motion
    const shift = new Int8Array(gh);
    for (let j = 0; j < gh; j++) if (R() < (o.tear ?? .10)) shift[j] = -dir;
    const drop = o.drop ?? .05;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const t = type[j * gw + i]; if (!t || t === 3) continue;
      const x = X0 + (i + shift[j]) * c, y = Y0 + j * c;
      if (t === 1) {
        if (R() < drop) { ditherCell(ctx, x, y, c, .35); continue; }
        ctx.fillRect(x, y, c, c);
      } else {
        if (R() < drop * .6) continue;
        ditherCell(ctx, x, y, c, dens[j * gw + i]);
      }
    }
    // horizontal dithered motion trails behind the trailing edge
    const trail = o.trail ?? .32, tl = o.trailLen ?? 10;
    for (let j = 0; j < gh; j++) {
      let edge = -1;
      if (dir > 0) { for (let i = 0; i < gw; i++) if (type[j * gw + i]) { edge = i; break; } }
      else { for (let i = gw - 1; i >= 0; i--) if (type[j * gw + i]) { edge = i; break; } }
      if (edge < 0 || R() > trail) continue;
      const L = Math.round(2 + R() * R() * tl * 1.6);
      const half = R() < .35; // some streaks are half a block tall
      const v0 = half ? (R() < .5 ? 0 : 2) : 0, v1 = half ? v0 + 2 : 4;
      for (let t = 1; t <= L; t++) {
        const i = edge - dir * t + shift[j];
        const f = 1 - t / (L + 1);
        ditherCell(ctx, X0 + i * c, Y0 + j * c, c, .12 + .58 * Math.pow(f, .9), { v0, v1 });
      }
    }
    // vertical dotted drips above / below some columns
    const vert = o.vert ?? .10;
    for (let i = 0; i < gw; i++) {
      if (R() > vert) continue;
      let top = -1, bot = -1;
      for (let j = 0; j < gh; j++) if (type[j * gw + i]) { if (top < 0) top = j; bot = j; }
      if (top < 0) continue;
      const up = R() < .5, n = 1 + Math.floor(R() * 3);
      const u0 = Math.floor(R() * 3);
      for (let t = 1; t <= n; t++) {
        const j = up ? top - t : bot + t;
        ditherCell(ctx, X0 + i * c, Y0 + j * c, c, .55 * (1 - t / (n + 1)) + .2, { u0, u1: u0 + 1 });
      }
    }
    // a few stray blocks shaken loose behind the body
    const strays = Math.round((o.strays ?? .006) * gw * gh);
    for (let s = 0; s < strays; s++) {
      for (let tries = 0; tries < 30; tries++) {
        const i = Math.floor(R() * gw), j = Math.floor(R() * gh);
        if (type[j * gw + i] !== 1) continue;
        const di = -dir * (2 + Math.floor(R() * 7)), dj = Math.floor(R() * 5) - 2;
        ctx.fillRect(X0 + (i + di) * c, Y0 + (j + dj) * c, c, c);
        break;
      }
    }
    return { gw, gh, c };
  }

  // Density field from an RGBA ink image (alpha), smoothed. returns sampler(u,v) 0..1 over the image box
  function densityField(img, gw, gh, blurPx) {
    const cv = document.createElement('canvas'); cv.width = gw; cv.height = gh;
    const c = cv.getContext('2d', { willReadFrequently: true });
    // first at 4x, blurred, then down
    const big = document.createElement('canvas'); big.width = gw * 4; big.height = gh * 4;
    const b = big.getContext('2d');
    b.filter = `blur(${blurPx || 6}px)`;
    b.drawImage(img, 0, 0, big.width, big.height);
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    c.drawImage(big, 0, 0, gw, gh);
    const d = c.getImageData(0, 0, gw, gh).data;
    return (i, j) => (i < 0 || j < 0 || i >= gw || j >= gh) ? 0 : d[(j * gw + i) * 4 + 3] / 255;
  }

  // Draw a cover-fitted crop of an image into a box (css px) on ctx. src rect in image px.
  function crop(ctx, img, box, src, o = {}) {
    const [x, y, w, h] = box.map(v => Math.round(v * DPR));
    let [sx, sy, sw, sh] = src;
    const ar = w / h;
    if (sw / sh > ar) { const nw = sh * ar; sx += (sw - nw) / 2; sw = nw; } else { const nh = sw / ar; sy += (sh - nh) / 2; sh = nh; }
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    if (o.blur) ctx.filter = `blur(${o.blur * DPR}px)`;
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    ctx.filter = 'none';
    if (o.bright) { ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = `rgb(${o.bright},${o.bright},${o.bright})`; ctx.fillRect(x, y, w, h); }
    ctx.restore();
  }

  // Dot cloud: the cumulus ink's density re-screened as round dots on a jittered grid.
  // o: x,y,w (css box of the ink image), pitch, rmax, seed, color, state(x,y)-> 'on'|'spent'|'ice'|null
  function dotCloud(ctx, img, o) {
    const h = o.w * img.height / img.width;
    const pitch = o.pitch, gw = Math.ceil(o.w / pitch), gh = Math.ceil(h / pitch);
    const field = densityField(img, gw, gh, o.blur ?? 5);
    const R = rng(o.seed || 7);
    const pts = [];
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const dv = field(i, j);
      if (dv < (o.min ?? .06)) continue;
      const off = (j % 2) * pitch * .5;
      const x = o.x + i * pitch + off + (R() - .5) * pitch * .18;
      const y = o.y + j * pitch + (R() - .5) * pitch * .18;
      const r = o.rmax * Math.sqrt(Math.min(1, dv * (o.gain ?? 1.25)));
      if (r < .55) continue;
      pts.push({ x, y, r });
    }
    for (const p of pts) {
      const st = o.state ? o.state(p.x, p.y, p) : 'on';
      if (!st) continue;
      const X = p.x * DPR, Y = p.y * DPR, r = p.r * DPR;
      ctx.beginPath();
      if (st === 'spent') {
        // spent today: the point shrinks to a small dim dot
        ctx.arc(X, Y, Math.max(1.1, r * (o.spentScale ?? .42)), 0, Math.PI * 2);
        ctx.fillStyle = o.spentColor || 'rgba(255,255,255,.55)';
        ctx.fill();
      } else {
        ctx.arc(X, Y, r, 0, Math.PI * 2);
        ctx.fillStyle = st === 'ice' ? '#A6FEFF' : (o.color || '#F3F4F7');
        ctx.fill();
      }
    }
    return pts;
  }

  // Dotted CLOUD glyph (square with inscribed circle), both strokes drawn as fine dots.
  function cloudGlyph(size, color, o = {}) {
    const sw = o.dot || 2.6, n = o.n || 18; // dots per side
    const s = 100, m = sw; // inset so dots sit inside the box
    const side = s - 2 * m, per = 4 * side, circ = Math.PI * (side);
    return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
      <rect x="${m}" y="${m}" width="${side}" height="${side}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" pathLength="${n * 4 * 2}" stroke-dasharray="0 2"/>
      <circle cx="50" cy="50" r="${side / 2}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" pathLength="${Math.round(n * 3.1416) * 2}" stroke-dasharray="0 2"/>
    </svg>`;
  }

  window.V10 = { DPR, ART, load, rng, makeCanvas, photo, pixelSprite, ditherCell, densityField, crop, dotCloud, cloudGlyph, BAYER };
})();
