#!/usr/bin/env node
// V10 "Sepia Counter" master grade. Implements DESIGN.md section 3.2.
// Offline, once per asset. Production never grades photographs at runtime.
//
//   node scripts/grade-sepia.mjs                 grade every job in grade-sepia.config.json
//   node scripts/grade-sepia.mjs --only a,b      only the named jobs (masters or crops)
//   node scripts/grade-sepia.mjs --report out.json   also write the measured zone report
//
// Pipeline per master (3.2, in order):
//   0. optional retouch patches on the source (clone from a neighbour, feathered)
//   1. frame: cover-fit the target aspect with zoom and focal point (fx, fy)
//   2. luminance Y = 0.299R + 0.587G + 0.114B, auto levels with a 1% clip at both ends
//      (levels are measured on the whole source, so every derivative of one source shares one tone)
//   3. print range: Y compressed linearly into luma 32..236
//   4. gradient map through the nine sepia stops (stop i at luma 32 + i * 25.5, linear in sRGB)
//   5. softening: gaussian sigma 3.2px at 3840 wide (deep defocus: 5px), scaled to the output width
//   6. exposure: neutral multiply. "auto" lands the sky zone median near luma 205 (L 0.60, the
//      approved hero) with a factor clamped to 0.85..0.91, or 1.0 when the sky is already that dark
//   7. legibility burn: neutral vertical ramp 1.00 at 60%, 0.62 at 85%, 0.55 at 100% (monotone
//      cubic, feathered), plus optional local burns (soft rectangles) under parameter tables
//   8. vignette: bottom corners only, at most 10%; the sky zone is untouched
//   9. export: JPEG q92 (mozjpeg), quantised once with triangular dither so skies never band
// Crops (product frames, economy tiles, release cards) run steps 0 to 6 on the source, then
// extract and resize; they get no burn and no vignette (a ramp on a small slice reads as a band).
//
// The blur, tone map and multiplies run in Float32 in this file because sharp's typed array raw
// input is quantised to 8 bits; sharp does decode, resize and encode.

import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const CONFIG = path.resolve(ROOT, arg('--config') || 'scripts/grade-sepia.config.json');
const ONLY = arg('--only') ? new Set(arg('--only').split(',')) : null;
const REPORT = arg('--report');

// ---------- the nine sepia stops (DESIGN 2.3 --sepia-900 .. --sepia-100) ----------
const STOPS = ['#282020', '#49352C', '#6C4D38', '#8D6647', '#A87F5A', '#BC997A', '#C7B6A6', '#DBD0C6', '#F3E9DF']
  .map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
const LUT_N = 4096; // gradient map LUT over luma 32..236
const LUT = new Float32Array(LUT_N * 3);
for (let i = 0; i < LUT_N; i++) {
  const t = (i / (LUT_N - 1)) * 8; // stop index space
  const k = Math.min(7, Math.floor(t)), f = t - k;
  for (let c = 0; c < 3; c++) LUT[i * 3 + c] = STOPS[k][c] * (1 - f) + STOPS[k + 1][c] * f;
}

const relL = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// ---------- source ----------
async function loadSource(file, retouch = []) {
  const { data, info } = await sharp(path.resolve(ROOT, file)).removeAlpha().toColourspace('srgb')
    .raw().toBuffer({ resolveWithObject: true });
  const img = { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
  for (const p of retouch) applyPatch(img, p);
  return img;
}

// Retouch a small rectangle (DESIGN 3.1: no people, posts or structures). Default: clone from
// (x + dx, y + dy) with a feathered edge. mode "hfill": fill each row by interpolating between the
// pixels just left and right of the box (averaged over 3px), which hides thin vertical marks
// without leaving a cloned block; the feather blends it into the print.
function applyPatch(img, { x, y, w, h, dx = 0, dy = 0, feather = 6, mode = 'clone' }) {
  const { data, width } = img;
  const src = mode === 'hfill' ? Uint8ClampedArray.from(data) : data;
  const px = (X, Y, c) => src[(Y * width + X) * 3 + c];
  for (let j = -feather; j < h + feather; j++) {
    const Y = y + j;
    let L = [0, 0, 0], R = [0, 0, 0];
    if (mode === 'hfill') {
      for (let c = 0; c < 3; c++) {
        for (let k = 1; k <= 3; k++) { L[c] += px(x - feather - k, Y, c) / 3; R[c] += px(x + w + feather - 1 + k, Y, c) / 3; }
      }
    }
    for (let i = -feather; i < w + feather; i++) {
      const X = x + i;
      const ax = Math.min(i + feather, w + feather - 1 - i) / feather, ay = Math.min(j + feather, h + feather - 1 - j) / feather;
      const a = Math.min(1, ax) * Math.min(1, ay);
      if (a <= 0) continue;
      const d = (Y * width + X) * 3;
      if (mode === 'hfill') {
        const t = (i + feather + 0.5) / (w + 2 * feather);
        for (let c = 0; c < 3; c++) data[d + c] = data[d + c] * (1 - a) + (L[c] * (1 - t) + R[c] * t) * a;
      } else {
        const s2 = ((Y + dy) * width + X + dx) * 3;
        for (let c = 0; c < 3; c++) data[d + c] = data[d + c] * (1 - a) + data[s2 + c] * a;
      }
    }
  }
}

function levelsOf(img) {
  const { data } = img, n = data.length / 3, hist = new Float64Array(2048);
  for (let i = 0; i < n; i++) {
    const y = 0.299 * data[i * 3] + 0.587 * data[i * 3 + 1] + 0.114 * data[i * 3 + 2];
    hist[Math.min(2047, Math.floor(y * 8))]++;
  }
  const pct = (p) => { let acc = 0; const target = n * p; for (let b = 0; b < 2048; b++) { acc += hist[b]; if (acc >= target) return b / 8; } return 255; };
  return { lo: pct(0.01), hi: pct(0.99) };
}

// ---------- framing ----------
// box = [x, y, w, h] in source px; the box is centre-trimmed to the output aspect (as v10.js crop()).
function frameBox(img, out, o) {
  if (o.box) {
    let [sx, sy, sw, sh] = o.box; const ar = out.w / out.h;
    if (sw / sh > ar) { const nw = sh * ar; sx += (sw - nw) / 2; sw = nw; } else { const nh = sw / ar; sy += (sh - nh) / 2; sh = nh; }
    return [sx, sy, sw, sh];
  }
  const zoom = o.zoom ?? 1, fx = o.fx ?? 0.5, fy = o.fy ?? 0.5;
  const scale = Math.max(out.w / img.width, out.h / img.height) * zoom;
  const cw = out.w / scale, ch = out.h / scale;
  return [(img.width - cw) * fx, (img.height - ch) * fy, cw, ch];
}

async function extractResize(img, box, out) {
  const [x, y, w, h] = box.map(Math.round);
  const { data } = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length),
    { raw: { width: img.width, height: img.height, channels: 3 } })
    .extract({ left: Math.max(0, x), top: Math.max(0, y), width: Math.min(w, img.width - x), height: Math.min(h, img.height - y) })
    .resize(out.w, out.h, { fit: 'fill', kernel: 'lanczos3' })
    .raw().toBuffer({ resolveWithObject: true });
  return data;
}

// ---------- tone: levels -> print range -> gradient map ----------
function toneMap(rgb8, lv) {
  const n = rgb8.length / 3, out = new Float32Array(n * 3), span = Math.max(1, lv.hi - lv.lo);
  for (let i = 0; i < n; i++) {
    const y = 0.299 * rgb8[i * 3] + 0.587 * rgb8[i * 3 + 1] + 0.114 * rgb8[i * 3 + 2];
    const t = Math.min(1, Math.max(0, (y - lv.lo) / span)); // auto levels, 1% clip
    // print range 32..236 maps onto the LUT domain 0..1
    const k = Math.round(t * (LUT_N - 1)) * 3;
    out[i * 3] = LUT[k]; out[i * 3 + 1] = LUT[k + 1]; out[i * 3 + 2] = LUT[k + 2];
  }
  return out;
}

// ---------- separable gaussian on Float32 RGB ----------
function gaussBlur(src, w, h, sigma) {
  if (!(sigma > 0.3)) return src;
  const r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1);
  let s = 0; for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(src.length), dst = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i)), p = (row + xx) * 3, kv = k[i + r];
        a += src[p] * kv; b += src[p + 1] * kv; c += src[p + 2] * kv;
      }
      const q = (row + x) * 3; tmp[q] = a; tmp[q + 1] = b; tmp[q + 2] = c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i)), p = (yy * w + x) * 3, kv = k[i + r];
        a += tmp[p] * kv; b += tmp[p + 1] * kv; c += tmp[p + 2] * kv;
      }
      const q = (y * w + x) * 3; dst[q] = a; dst[q + 1] = b; dst[q + 2] = c;
    }
  }
  return dst;
}

// ---------- measurements ----------
function lumaAt(f, i) { return 0.299 * f[i] + 0.587 * f[i + 1] + 0.114 * f[i + 2]; }
function regionStats(f, w, h, [x0, y0, x1, y1]) {
  const v = [];
  const X0 = Math.round(x0 * w), X1 = Math.round(x1 * w), Y0 = Math.round(y0 * h), Y1 = Math.round(y1 * h);
  const step = Math.max(1, Math.round(Math.sqrt(((X1 - X0) * (Y1 - Y0)) / 40000)));
  for (let y = Y0; y < Y1; y += step) for (let x = X0; x < X1; x += step) v.push(lumaAt(f, (y * w + x) * 3));
  v.sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { median: q(0.5), p90: q(0.9), p10: q(0.1), L50: relL(q(0.5)), L90: relL(q(0.9)) };
}

// ---------- multiplies ----------
// Default ramp (3.2 step 7): 1.00 at 60% of the height, 0.62 at 85%, 0.55 at 100%.
// A print whose ground starts lower (a ridge at 80% under a smooth sky) may move the start and the
// knee down so the burn never lands on open sky, where it would read as a gradient band (3.5).
const BURN = { start: 0.6, knee: 0.85, kneeK: 0.62, endK: 0.55 };
function burnCurve(t, b = BURN) {
  // monotone cubic through (start, 1.00, slope 0), (knee, kneeK), (1.00, endK)
  if (t <= b.start) return 1;
  const d1 = (b.kneeK - 1) / (b.knee - b.start), d2 = (b.endK - b.kneeK) / (1 - b.knee), m1 = 2 / (1 / d1 + 1 / d2);
  const herm = (p0, p1, m0, mm1, x0, x1, x) => {
    const hgt = x1 - x0, s = (x - x0) / hgt, s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * hgt * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * hgt * mm1;
  };
  if (t <= b.knee) return herm(1, b.kneeK, 0, m1, b.start, b.knee, t);
  return herm(b.kneeK, b.endK, m1, d2, b.knee, 1, Math.min(1, t));
}

function applyMultiplies(f, w, h, o) {
  const e = o.exposure ?? 1, burn = o.burn !== false, vig = o.vignette ?? 0;
  const ramp = { ...BURN, ...(typeof o.burn === 'object' ? o.burn : {}) };
  const locals = (o.localBurn || []).map((b) => ({ ...b, fp: (b.feather ?? 0.06) * w }));
  const rowK = new Float32Array(h);
  for (let y = 0; y < h; y++) rowK[y] = e * (burn ? burnCurve((y + 0.5) / h, ramp) : 1);
  for (let y = 0; y < h; y++) {
    const ty = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      let k = rowK[y];
      for (const b of locals) {
        const px = x, py = y, X0 = b.x0 * w, X1 = b.x1 * w, Y0 = b.y0 * h, Y1 = b.y1 * h;
        const m = smooth(X0 - b.fp, X0 + b.fp, px) * (1 - smooth(X1 - b.fp, X1 + b.fp, px)) *
          smooth(Y0 - b.fp, Y0 + b.fp, py) * (1 - smooth(Y1 - b.fp, Y1 + b.fp, py));
        k *= 1 - (1 - b.k) * m;
      }
      if (vig > 0 && ty > 0.55) {
        // bottom corners only: two soft ellipses anchored on the bottom corners
        const tx = (x + 0.5) / w;
        const dl = Math.hypot(tx / 0.42, (1 - ty) / 0.5), dr = Math.hypot((1 - tx) / 0.42, (1 - ty) / 0.5);
        const v = Math.max(1 - smooth(0, 1, dl), 1 - smooth(0, 1, dr)) * smooth(0.55, 0.75, ty);
        k *= 1 - vig * v;
      }
      const i = (y * w + x) * 3; f[i] *= k; f[i + 1] *= k; f[i + 2] *= k;
    }
  }
}

// ---------- export ----------
let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
async function writeJpeg(f, w, h, file, quality = 92) {
  const out = Buffer.alloc(w * h * 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(f[i] + (rnd() - rnd()) * 0.75)));
  await mkdir(path.dirname(file), { recursive: true });
  await sharp(out, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality, mozjpeg: true }).toFile(file);
  return out;
}

// sky zone sample box for the auto exposure: away from the print edges and the counter corner
const SKY_BOX = [0.15, 0.1, 0.85, 0.45];
function autoExposure(f, w, h, o) {
  if (typeof o.exposure === 'number') return o.exposure;
  const box = o.skyBox || SKY_BOX;
  const med = regionStats(f, w, h, box).median;
  if (med <= 212) return 1;
  return Math.min(0.91, Math.max(0.85, 205 / med));
}

// ---------- jobs ----------
const sourceCache = new Map();
async function source(job) {
  const key = job.src + JSON.stringify(job.retouch || []);
  if (!sourceCache.has(key)) {
    const img = await loadSource(job.src, job.retouch);
    sourceCache.set(key, { img, lv: levelsOf(img) });
  }
  return sourceCache.get(key);
}

async function gradeOne(job, out, outFile) {
  const { img, lv } = await source(job);
  const box = frameBox(img, out, out.frame || job.frame || {});
  const rgb8 = await extractResize(img, box, out);
  const f = toneMap(rgb8, lv);
  // print softness is fixed on the source: sigma px at 3840 wide of the *framed source region*
  const sigma3840 = job.sigma ?? 3.2;
  const sigma = sigma3840 * (out.w / 3840) * (out.sigmaScale ?? job.sigmaScale ?? 1);
  const g = gaussBlur(f, out.w, out.h, sigma);
  const e = autoExposure(g, out.w, out.h, { ...job, ...out });
  applyMultiplies(g, out.w, out.h, { exposure: e, burn: out.burn ?? job.burn, vignette: out.vignette ?? job.vignette ?? 0.1, localBurn: out.localBurn || [] });
  await writeJpeg(g, out.w, out.h, outFile, out.quality ?? 92);
  const zones = {
    sky: regionStats(g, out.w, out.h, [0.05, 0.05, 0.95, out.h > out.w ? 0.5 : 0.55]),
    band: regionStats(g, out.w, out.h, [0.05, out.h > out.w ? 0.5 : 0.55, 0.95, 0.8]),
    ground: regionStats(g, out.w, out.h, [0.03, 0.8, 0.97, 0.98]),
  };
  return { file: path.relative(ROOT, outFile), w: out.w, h: out.h, exposure: +e.toFixed(3), sigma: +sigma.toFixed(2), levels: lv, zones };
}

async function cropOne(job, c, outFile) {
  // crops: steps 0..6 at the source's own scale, then extract + resize. No burn, no vignette.
  const { img, lv } = await source(job);
  const out = { w: c.w, h: c.h };
  const box = frameBox(img, out, { box: c.box });
  const rgb8 = await extractResize(img, box, out);
  const f = toneMap(rgb8, lv);
  // the print softness of the source (sigma at 3840 source width), carried into the crop's scale
  const sigma = (job.sigma ?? 3.2) * (img.width / 3840) * (out.w / box[2]);
  const g = gaussBlur(f, out.w, out.h, sigma);
  applyMultiplies(g, out.w, out.h, { exposure: c.exposure ?? 1, burn: false, vignette: 0 });
  await writeJpeg(g, out.w, out.h, outFile, c.quality ?? 92);
  return { file: path.relative(ROOT, outFile), w: out.w, h: out.h, exposure: c.exposure ?? 1, sigma: +sigma.toFixed(2), mean: regionStats(g, out.w, out.h, [0, 0, 1, 1]) };
}

const cfg = JSON.parse(await readFile(CONFIG, 'utf8'));
const outRoot = path.resolve(ROOT, cfg.outDir || 'public/art');
const report = [];
for (const job of cfg.masters) {
  for (const out of job.outputs || []) {
    if (ONLY && !ONLY.has(job.name) && !ONLY.has(out.name)) continue;
    const t = Date.now();
    const r = await gradeOne(job, out, path.join(outRoot, out.name));
    report.push({ job: job.name, ...r });
    console.log(`${r.file}  ${r.w}x${r.h}  e=${r.exposure} sigma=${r.sigma}  sky L50=${r.zones.sky.L50.toFixed(3)}  ground L90=${r.zones.ground.L90.toFixed(3)}  ${Date.now() - t}ms`);
  }
  for (const c of job.crops || []) {
    if (ONLY && !ONLY.has(job.name) && !ONLY.has(c.name)) continue;
    const r = await cropOne(job, c, path.join(outRoot, c.name));
    report.push({ job: job.name, ...r });
    console.log(`${r.file}  ${r.w}x${r.h}  e=${r.exposure} sigma=${r.sigma}`);
  }
  sourceCache.clear();
}
if (REPORT) await writeFile(path.resolve(REPORT), JSON.stringify(report, null, 1));
