/**
 * What stands round K2 on her canvas (`docs/design/R3-MINIMAL.md section 10`): the gestures'
 * actors (the blow's dot cloud and the puff from her lips, the white pixel bird with its dithered
 * motion trail) and the beam of her token, drawn in the sky's own halftone dots, never lines. Map
 * px throughout; every actor keeps out of the blocks its host names (`keepOut`, the blocks in map
 * px with their air).
 */
import { bayerAt, hash01, noise1 } from "./k2-rand.js";
import {
  type BirdFrame,
  type BirdState,
  BLOW,
  clamp,
  cloudCentre,
  lerp,
  ramp,
  smooth,
} from "./k2-time.js";

/** A block of the host on her map: left, top, right, bottom, and the air kept round it. */
export type KeepRect = readonly [number, number, number, number, number];

/** 1 where an actor may show, 0 within a block's air, a 30 px fade beyond. */
export function keepOut(
  rects: readonly KeepRect[],
  x: number,
  y: number,
): number {
  let a = 1;
  for (const [x0, y0, x1, y1, m] of rects) {
    const d = Math.max(x0 - x, x - x1, y0 - y, y - y1);
    a = Math.min(a, clamp((d - m) / 30, 0, 1));
  }
  return a;
}

/** The actors' shapes for one frame. */
export interface ActorPaths {
  readonly cloud: Path2D;
  readonly puff: Path2D;
  readonly puffInk: Path2D;
  readonly white: Path2D;
  readonly ink: Path2D;
}

export function actorPaths(): ActorPaths {
  return {
    cloud: new Path2D(),
    puff: new Path2D(),
    puffInk: new Path2D(),
    white: new Path2D(),
    ink: new Path2D(),
  };
}

/* ------------------------------------------------------------------ the blow */

/** The print's clouds' own screen (the wide pitch). */
const CS = { pitch: 5, rmax: 2.2 } as const;
const BUMPS: readonly (readonly [number, number, number])[] = [
  [-16, 3, 13],
  [-2, -6, 16],
  [14, 0, 13],
  [-6, 9, 12],
  [9, 9, 11],
  [24, 7, 8],
  [-26, 9, 7.5],
];

/**
 * The small cumulus she blows away: wisps gather into it, it drifts toward her face, and its dots
 * leave as the blow's front reaches them, away from her lips and rising.
 */
export function drawCloud(
  g: number,
  age: number,
  mouth: readonly [number, number],
  keep: readonly KeepRect[],
  out: ActorPaths,
): void {
  const form = smooth(ramp(age, 0, BLOW.form));
  const [cx, cy] = cloudCentre(Math.min(age, BLOW.blow));
  const pitch = CS.pitch;
  const rmax = CS.rmax;
  const bumps = BUMPS.map(([bx, by, br], n) => {
    const side = n % 2 ? 1 : -1;
    const off = (1 - form) * (18 + 10 * hash01(n, 7, 401)) * side;
    return [
      bx + off,
      by + (1 - form) * (hash01(n, 8, 401) - 0.5) * 10,
      br * lerp(2.1, 1, form),
      br * lerp(0.32, 1, form),
    ] as const;
  });
  const ox = Math.round(cx / pitch) * pitch;
  const oy = Math.round(cy / pitch) * pitch;
  for (let j = -9; j <= 9; j++)
    for (let i = -10; i <= 10; i++) {
      const lx = i * pitch + (j & 1) * pitch * 0.5;
      const ly = j * pitch;
      const px = ox + lx;
      const py = oy + ly;
      let sd = 1e9;
      for (const [bx, by, rx, ry] of bumps)
        sd = Math.min(sd, Math.hypot((lx - bx) / rx, (ly - by) / ry) - 1);
      const jit = noise1((px + py * 0.7) / 6, 403) * 0.22;
      const d = clamp(-(sd + jit) / 0.55, 0, 1) * lerp(0.45, 1, form);
      if (d <= 0.04) continue;
      if (hash01(i + 40, j + 40, 404) > form * 1.4) continue;
      let x = px;
      let y = py;
      let r = rmax * Math.sqrt(Math.min(1, d * 1.6));
      if (age > BLOW.blow) {
        const dist = Math.hypot(px - mouth[0], py - mouth[1]);
        const a = age - BLOW.blow - dist / 0.38 + 120 + hash01(i, j, 405) * 160;
        if (a > 0) {
          let ux = (px - mouth[0]) / dist;
          let uy = (py - mouth[1]) / dist;
          const ang = (hash01(i, j, 406) - 0.5) * 1.1 + 0.42;
          const c = Math.cos(ang);
          const s = Math.sin(ang);
          [ux, uy] = [ux * c - uy * s, ux * s + uy * c];
          const v = 0.07 + hash01(i, j, 407) * 0.09;
          x = px + ux * (v * a + 0.00011 * a * a);
          y = py + uy * (v * a + 0.00011 * a * a) - 0.00004 * a * a;
          r *= clamp(1 - a / (520 + hash01(i, j, 408) * 380), 0, 1);
          if (r < 0.35) continue;
        }
      }
      r *= keepOut(keep, x, y);
      if (r < 0.35) continue;
      if (g < 1 && bayerAt(i + 40, j + 40) > g) continue;
      out.cloud.moveTo(x + r, y);
      out.cloud.arc(x, y, r, 0, 6.2832);
    }
}

/** The puff: a short cone of tiny dots from her lips toward the cloud; ink where it crosses her skin. */
export function drawPuff(
  g: number,
  age: number,
  mouth: readonly [number, number],
  keep: readonly KeepRect[],
  light: (x: number, y: number) => boolean,
  out: ActorPaths,
): void {
  const a0 = age - BLOW.blow;
  if (a0 < 0 || a0 > 1300) return;
  const [cx, cy] = cloudCentre(BLOW.blow);
  const base = Math.atan2(cy - mouth[1], cx - mouth[0]);
  const NP = 30;
  for (let n = 0; n < NP; n++) {
    const born = (n / NP) * 900 + hash01(n, 1, 411) * 40;
    const a = a0 - born;
    if (a < 0 || a > 420) continue;
    const ang = base + (hash01(n, 2, 411) - 0.5) * 0.5;
    const v = 0.27 + hash01(n, 3, 411) * 0.12;
    const life = 1 - a / 420;
    for (let q = 0; q < 3; q++) {
      const s = Math.max(0, v * a - q * 3.2) + 5;
      const x = mouth[0] + Math.cos(ang) * s;
      const y = mouth[1] + Math.sin(ang) * s;
      let r = (q === 0 ? 1.05 : q === 1 ? 0.8 : 0.6) * (0.5 + 0.5 * life);
      r *= keepOut(keep, x, y);
      if (r < 0.35 || (g < 1 && hash01(n, q, 412) > g)) continue;
      const p = light(x, y) ? out.puffInk : out.puff;
      p.moveTo(x + r, y);
      p.arc(x, y, r, 0, 6.2832);
    }
  }
}

/* ------------------------------------------------------------------ the bird */

/** '#' a solid block, '+' Bayer dither (half), 'e' ink eye, 'k' ink beak, 'l' ink leg; facing left. */
const BIRD: Readonly<Record<BirdFrame, readonly string[]>> = {
  up: [
    "...........##.....",
    "..........###.....",
    ".........####.....",
    "........####......",
    ".......####.......",
    "..##..#####.......",
    ".#e#######........",
    "k##########++.....",
    "..##########++....",
    "....######...+....",
  ],
  mid: [
    "..................",
    "..................",
    "......#######.....",
    "..##.#########....",
    ".#e#########......",
    "k##########++.....",
    "..##########++....",
    "....######...+....",
    "..................",
    "..................",
  ],
  down: [
    "..................",
    "..................",
    "..##..............",
    ".#e#######........",
    "k##########++.....",
    "..##########++....",
    "....#######..+....",
    "......#####.......",
    ".......####.......",
    "........###.......",
  ],
  flare: [
    "..........##....",
    ".........###....",
    "....###.####....",
    "...#####+##.....",
    "..##e###++......",
    ".k######+.......",
    "...######.......",
    "..##+++###......",
    "...#++++##......",
    "....#+++###.....",
    ".....#####.++...",
    ".....l...l......",
  ],
  perch: [
    "....###.........",
    "...#####........",
    "..##e###........",
    ".k######........",
    "...#####........",
    "...######.......",
    "..###+++##......",
    "..##+++++##.....",
    "...#++++++##....",
    "....#+++++###...",
    ".....######.+++.",
    "......l..l...++.",
  ],
  peck: [
    "................",
    "................",
    "..###...........",
    ".#####..........",
    ".#e####.........",
    "k########.......",
    "...####+##......",
    "..##+++++##.....",
    "...#++++++##....",
    "....#+++++###...",
    ".....######.+++.",
    "......l..l...++.",
  ],
};

/** Map px per block (the far birds of the print). */
const BC = 3;
/** A block in Bayer dither: 2 x 2 sub dots. */
const B2 = [0, 2, 3, 1] as const;
function ditherBlock(
  p: Path2D,
  x: number,
  y: number,
  c: number,
  dens: number,
  v0 = 0,
  v1 = 2,
): void {
  const q = c / 2;
  for (let v = v0; v < v1; v++)
    for (let u = 0; u < 2; u++)
      if ((B2[v * 2 + u] ?? 4) < dens * 4)
        p.rect(x + u * q, y + v * q, q * 0.8, q * 0.8);
}

/** The bird at one moment: its blocks, a fine ink outline where it sits on her white, its trail. */
export function drawBird(
  st: BirdState,
  g: number,
  step: number,
  keep: readonly KeepRect[],
  light: (x: number, y: number) => boolean,
  out: ActorPaths,
): void {
  const spr = BIRD[st.frame];
  const gh = spr.length;
  const gw = spr[0]?.length ?? 0;
  const flip = st.dir > 0;
  const ox = Math.round(st.x - (gw * BC) / 2);
  const oy = Math.round(
    st.feet ? st.y - gh * BC + BC * 0.5 : st.y - (gh * BC) / 2,
  );
  const at = (i: number, j: number) =>
    i < 0 || j < 0 || i >= gw || j >= gh
      ? "."
      : (spr[j]?.[flip ? gw - 1 - i : i] ?? ".");
  const vis = (x: number, y: number) => keepOut(keep, x, y) > 0.5;
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const ch = at(i, j);
      const x = ox + i * BC;
      const y = oy + j * BC;
      if (!vis(x, y)) continue;
      if (g < 1 && bayerAt(i, j) > g) continue;
      if (ch === "#") out.white.rect(x, y, BC, BC);
      else if (ch === "+") ditherBlock(out.white, x, y, BC, 0.5);
      else if (ch === "e" || ch === "k" || ch === "l")
        out.ink.rect(x, y, BC, BC);
      else if (st.outline > 0 && bayerAt(i, j) < st.outline) {
        let n = false;
        for (const [di, dj] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const)
          if ("#+ek".includes(at(i + di, j + dj)) && at(i + di, j + dj) !== ".")
            n = true;
        if (n && light(x + 1, y + 1))
          out.ink.rect(x + 0.5, y + 0.5, BC - 1, BC - 1);
      }
    }
  if (!st.fly) return;
  // the dithered motion trail behind the trailing edge, re-seeded every frame (the flicker)
  let seed = (step * 2654435761) >>> 0;
  const R = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    return seed / 4294967296;
  };
  for (let j = 0; j < gh; j++) {
    let edge = -1;
    if (st.dir < 0) {
      for (let i = gw - 1; i >= 0; i--)
        if ("#+".includes(at(i, j))) {
          edge = i;
          break;
        }
    } else {
      for (let i = 0; i < gw; i++)
        if ("#+".includes(at(i, j))) {
          edge = i;
          break;
        }
    }
    if (edge < 0 || R() > 0.42) continue;
    const Ln = Math.round(2 + R() * R() * 7 * 1.6);
    const half = R() < 0.35;
    const v0 = half ? (R() < 0.5 ? 0 : 1) : 0;
    for (let s = 1; s <= Ln; s++) {
      const i = edge - st.dir * s;
      const x = ox + i * BC;
      const y = oy + j * BC;
      if (!vis(x, y)) continue;
      ditherBlock(
        out.white,
        x,
        y,
        BC,
        0.18 + 0.62 * (1 - s / (Ln + 1)) ** 0.9,
        v0,
        half ? v0 + 1 : 2,
      );
    }
  }
}

/* ------------------------------------------------------------------ the light */

/** The flat token's face on her map: its centre and the ellipse of its rim. */
export interface TokenBase {
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}

/** Where the beam meets her: the line her tee dissolves along, and her body's span there. */
export interface BeamTop {
  /** The merge line's height at x (her cut, raised into her tee). */
  readonly yAt: (x: number) => number;
  readonly left: number;
  readonly right: number;
}

/** The beam's screen in map px: the clouds' (pitch 5) at her scale. */
export interface BeamScreen {
  readonly pitch: number;
  readonly rmax: number;
}

const smoothstep = (a: number, b: number, x: number): number =>
  smooth(clamp((x - a) / (b - a), 0, 1));

/**
 * The beam of her token: no lines, the sky's own material. Round points on the clouds' hex
 * screen (the ink by the ground under her, `k2-engine.ts`), the dot's area by density: densest
 * just above the token,
 * widening upward into a cone to her body's span, thinning as it rises and merging into her lower
 * body (her tee dissolves into it). It lives a little: a slow stepped shimmer rising through it,
 * a few dots rising along it (re-seeded per cycle from the clock), the edges breathing; a still
 * frame holds it. `grow` builds it from the token up (the wake), dot by dot.
 */
export function drawBeam(
  out: number[],
  g: TokenBase,
  top: BeamTop,
  sc: BeamScreen,
  grow: number,
  t: number,
  still: boolean,
): void {
  if (grow <= 0.001) return;
  const P = sc.pitch;
  const rowH = P;
  const front = smooth(clamp(grow, 0, 1));
  const tYc = top.yAt(g.cx);
  const H = Math.max(1, g.cy - tYc);
  const yMin = Math.min(top.yAt(top.left), top.yAt(top.right), tYc) - P * 2;
  const yMax = g.cy + g.ry * 0.4;
  const j0 = Math.floor(yMin / rowH);
  const j1 = Math.ceil(yMax / rowH);
  const step = still ? 0 : Math.floor(t / 400);
  const breathe = still ? 0 : t / 1700;
  const rise = still ? 0 : t / 700;
  const dotAt = (x: number, y: number, r: number) => {
    out.push(x, y, r);
  };
  for (let j = j0; j <= j1; j++) {
    const y = j * rowH;
    const off = (j & 1) * P * 0.5;
    const i0 = Math.floor((Math.min(top.left, g.cx - g.rx) - P * 2 - off) / P);
    const i1 = Math.ceil((Math.max(top.right, g.cx + g.rx) + P * 2 - off) / P);
    for (let i = i0; i <= i1; i++) {
      const x = i * P + off + (hash01(i, j, 81) - 0.5) * P * 0.18;
      const yy = y + (hash01(i, j, 82) - 0.5) * P * 0.18;
      const yT = top.yAt(x);
      const h = Math.max(1, g.cy - yT);
      const u = (g.cy - yy) / h;
      if (u > 1.08) continue;
      let d = 0;
      if (u < 0) {
        // round the coin's rim: a halo the coin covers but at its edge
        const e =
          ((x - g.cx) / (g.rx * 1.3)) ** 2 + ((yy - g.cy) / (g.ry * 1.7)) ** 2;
        if (e > 1) continue;
        d = 0.85 * (1 - e * 0.5);
      } else {
        const w = u ** 0.85;
        const xl = lerp(g.cx - g.rx * 0.95, top.left, w);
        const xr = lerp(g.cx + g.rx * 0.95, top.right, w);
        const xc = (xl + xr) / 2;
        const half = Math.max(1, (xr - xl) / 2);
        const side = x < xc ? -1 : 1;
        // the edges breathe and fray a little
        const edge =
          1 +
          0.05 * Math.sin(breathe + u * 2.5 + side) +
          0.1 * noise1(u * 7 + side * 9, 83);
        const v = Math.abs(x - xc) / (half * edge);
        const across = 1 - smoothstep(0.5, 1, v);
        if (across <= 0) continue;
        // densest just above the token, thinning as it rises (smaller dots, and fewer); past her
        // line it fades out under her
        if (hash01(i, j, 88) > 1 - 0.5 * Math.min(1, u) ** 1.4) continue;
        const up = 0.62 * (1 - Math.min(1, u)) ** 1.5 + 0.09;
        const past = u > 1 ? 1 - (u - 1) / 0.08 : 1;
        d = across * up * past;
        if (!still) {
          // a slow shimmer rising through it, stepped with the clock
          d *= 0.84 + 0.16 * Math.sin(((g.cy - yy) / 26 - rise) * 6.2832);
          d *= 0.86 + 0.14 * hash01(i, j, 84 + step);
        }
      }
      // the wake builds it from the token up, dot by dot
      if (front < 1) {
        const at = clamp((g.cy - yy) / H, 0, 1);
        if (at > front * 1.06 - hash01(i, j, 85) * 0.08) continue;
      }
      if (d <= 0.04) continue;
      const r = sc.rmax * Math.sqrt(Math.min(1, d * 1.6));
      if (r < sc.rmax * 0.22) continue;
      dotAt(x, yy, r);
    }
  }
  if (still || front < 1) return;
  // a few dots rising along it, snapped to the screen, each re-seeded when it reaches her
  for (let n = 0; n < 10; n++) {
    const per = 1800 + hash01(n, 1, 86) * 1400;
    const off = hash01(n, 2, 86) * per;
    const c = Math.floor((t + off) / per);
    const q = (t + off - c * per) / per;
    const lane = (hash01(c, n, 87) - 0.5) * 1.3;
    const u = q * 0.95;
    const w = u ** 0.85;
    const xl = lerp(g.cx - g.rx * 0.95, top.left, w);
    const xr = lerp(g.cx + g.rx * 0.95, top.right, w);
    const x = (xl + xr) / 2 + (lane * (xr - xl)) / 2;
    const y = g.cy - u * H;
    const j = Math.round(y / rowH);
    const i = Math.round((x - (j & 1) * P * 0.5) / P);
    const r = sc.rmax * (1 - q * 0.6);
    dotAt(i * P + (j & 1) * P * 0.5, j * rowH, r);
  }
}
