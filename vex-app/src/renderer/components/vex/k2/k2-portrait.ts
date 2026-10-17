/**
 * K2's portrait on the hex dot screen (`docs/design/R3-MINIMAL.md section 10`): the maps decoded
 * into cells (tone, class, flags, colour, hair tip), the wind's backward map through the fixed
 * screen, the authored eyes, mouths, nose and blush, the hands that rise out of her light, the
 * shoulders, the strands shedding dots, the assembly of the wake, the bust's cut. `emit` turns one
 * frame's state into dots by ink; the engine paints them.
 *
 * Her inks: white dots for skin and tee, the cool ink for hair and lines, a little blue (irises,
 * crown streaks, the vx on her tee); at night the blue and the rim round her hair are periwinkle.
 * Coordinates are her map's px.
 */
import { bayerAt, hash01 } from "./k2-rand.js";
import {
  clamp,
  type EyeMode,
  type FaceState,
  type GazeTarget,
  gustAt,
  lerp,
  type MapName,
  smooth,
} from "./k2-time.js";

/** A map's metadata (the converter's `meta.json`). */
export interface K2Eye {
  readonly top: readonly (readonly [number, number])[];
  readonly bot: readonly (readonly [number, number])[];
  readonly iris: readonly [number, number, number, number];
  readonly pupil: readonly [number, number, number, number];
  readonly hl: readonly [number, number, number];
  readonly hl2: readonly [number, number];
  readonly gmax: readonly [number, number, number];
  readonly lash: number;
  readonly outer: number;
}

export interface K2Meta {
  readonly pitch: number;
  readonly bx: number;
  readonly by: number;
  readonly gw: number;
  readonly gh: number;
  readonly k: number;
  readonly eyes: readonly K2Eye[];
  readonly face: {
    readonly mouth: readonly (readonly [number, number])[];
    readonly lip: readonly (readonly [number, number])[];
    readonly nose: readonly (readonly [number, number])[];
  };
  readonly cls: Readonly<
    Record<
      | "none"
      | "hair"
      | "skin"
      | "tee"
      | "acc"
      | "eye"
      | "cloud"
      | "hand"
      | "line",
      number
    >
  >;
  readonly col: Readonly<Record<"white" | "ink" | "blue_w" | "blue_i", number>>;
  readonly flags: Readonly<Record<"ring" | "strand" | "in", number>>;
  readonly ycut: readonly number[];
  readonly rise: number;
  readonly rest: readonly [number, number];
  readonly glance: readonly [number, number];
  readonly streamMaxX: number;
  /** The shrug line (map px); without it the wide drawing's 372 (at scale k 1). */
  readonly shoulder?: number;
}

/** A decoded map: per cell its tone, class, flags, colour and hair tip. */
export interface K2Map {
  readonly tone: Float32Array;
  readonly cls: Uint8Array;
  readonly flags: Uint8Array;
  readonly col: Uint8Array;
  readonly tip: Float32Array;
}

/** A map PNG's RGBA bytes as cells: R tone, G class (low 4 bits) and flags, B colour and tip. */
export function decodeMap(data: Uint8ClampedArray, n: number): K2Map {
  const tone = new Float32Array(n);
  const cls = new Uint8Array(n);
  const flags = new Uint8Array(n);
  const col = new Uint8Array(n);
  const tip = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    tone[k] = (data[k * 4] ?? 0) / 255;
    const g = data[k * 4 + 1] ?? 0;
    cls[k] = g & 15;
    flags[k] = g >> 4;
    const b = data[k * 4 + 2] ?? 0;
    col[k] = b >> 5;
    tip[k] = (b & 31) / 31;
  }
  return { tone, cls, flags, col, tip };
}

/** The inks a frame's dots are sorted into (painted in this order). */
export const INKS = [
  "ink",
  "white",
  "shade",
  "inkTop",
  "rimHair",
  "blueArea",
  "streak",
  "blue",
  "blush",
  "glint",
] as const;
export type Ink = (typeof INKS)[number];
/** Each ink's place in `INKS` (the dots' hash mixes it in for every dot). */
const INK_AT: ReadonlyMap<Ink, number> = new Map(INKS.map((n, i) => [n, i]));

/** One frame's dots by ink as (x, y, r) triples, with a running hash so an unchanged frame is
 * never repainted (`k2-stamp.ts` stamps them). */
export class Dots {
  readonly lists: Record<Ink, number[]> = {
    ink: [],
    white: [],
    shade: [],
    inkTop: [],
    rimHair: [],
    blueArea: [],
    streak: [],
    blue: [],
    blush: [],
    glint: [],
  };
  hash = 2166136261;
  count = 0;
  add(ink: Ink, x: number, y: number, r: number): void {
    this.lists[ink].push(x, y, r);
    let h = this.hash ^ (INK_AT.get(ink) ?? -1);
    h = Math.imul(h ^ Math.round(x * 4), 16777619);
    h = Math.imul(h ^ Math.round(y * 4), 16777619);
    h = Math.imul(h ^ Math.round(r * 8), 16777619);
    this.hash = h >>> 0;
    this.count++;
  }
}

/** The blue streaks in her hair: 85% of the dot at 70% of the blue, quieter than her irises. */
export const STREAK = { r: 0.85, alpha: 0.7 } as const;

/** The theme's inks (CSS colours) and the white dots' alpha. */
export interface Palette {
  readonly white: string;
  readonly wA: number;
  readonly ink: string;
  readonly blue: string;
  readonly blueArea: string;
  readonly rimHair: string;
  readonly rimTone: number;
  readonly blush: string;
}

/** Each ink's colour and alpha for the stamps (skin in shade lets the print show through a little). */
export function inkStyles(
  pal: Palette,
): Record<Ink, { color: string; alpha: number }> {
  return {
    ink: { color: pal.ink, alpha: 1 },
    white: { color: pal.white, alpha: pal.wA },
    shade: { color: pal.white, alpha: pal.wA * 0.8 },
    inkTop: { color: pal.ink, alpha: 1 },
    rimHair: { color: pal.rimHair, alpha: 1 },
    blueArea: { color: pal.blueArea, alpha: 1 },
    // the hair streaks, a little quieter than the irises
    streak: { color: pal.blue, alpha: STREAK.alpha },
    blue: { color: pal.blue, alpha: 1 },
    blush: { color: pal.blush, alpha: 1 },
    // the eye highlight sits on top of the iris
    glint: { color: pal.white, alpha: 1 },
  };
}

/** A face mark: an ink dot, a shaded skin dot, or a shaded skin dot with a small ink dot on it. */
interface Mark {
  readonly kind: "ink" | "shade" | "shadeTop";
  r: number;
  /** Gives way to the grin in the hover dissolve. */
  readonly rest: boolean;
}

/**
 * The app drawing's cut (`k2-rig.ts`): below a line her bust dissolves into the beam through the
 * Bayer dissolve on her own screen, and the frame's edges thin out. Without it (the wide drawing)
 * her old cumulus line and the merge band apply.
 */
export interface PortraitCut {
  /** Where the dissolve begins at x (map px). */
  readonly top: (x: number) => number;
  /** Its depth (map px): no dot stays below top + band. */
  readonly band: number;
  /** The Bayer threshold's gain across the band, and how much the dots shrink. */
  readonly gain: number;
  readonly shrink: number;
  /** Dots thin out within `side` map px of the frame's edges (x 0 and `width`). */
  readonly side: number;
  readonly width: number;
  /** Her lowest dot (the assembly rises from it). */
  readonly bottom: number;
}

/** One frame of her, as the engine composes it from the clock and the inputs. */
export interface PortraitFrame {
  readonly t: number;
  readonly still: boolean;
  readonly dark: boolean;
  /** The hover's dissolve and the peace hand's rise (rows still to rise). */
  readonly hp: number;
  readonly rise: number;
  /** The gesture or the wake (the drawing's dissolve already reduced by the hover). */
  readonly face: FaceState;
  readonly gp: number;
  readonly smirk: boolean;
  readonly gust: number;
  /** The hum's sway of her free hair, -1..1. */
  readonly sway: number;
  readonly lid: number;
  readonly eyes: EyeMode | null;
  readonly gaze: GazeTarget;
  /** The assembly of the wake (1 when she is whole). */
  readonly asm: number;
  /** The app drawing's cut; null on the wide drawing. */
  readonly cut: PortraitCut | null;
  /** The eyes keep their mode in a still frame (an app mood shows under reduced motion too). */
  readonly held?: boolean;
}

/** Which cells a pass draws: all of them, only those a settled frame never changes, or the rest. */
export type Pass = "all" | "static" | "dynamic";

/**
 * Her drawing on its map: built once from the metadata and the decoded maps; `emit` writes one
 * frame's dots.
 */
export class Portrait {
  readonly meta: K2Meta;
  readonly #maps: Partial<Record<MapName, K2Map>>;
  readonly #B: K2Map;
  readonly #H: K2Map;
  readonly #N: number;
  readonly X: Float32Array;
  readonly Y: Float32Array;
  readonly #tipD: Float32Array;
  /** Her cumulus line over each cell (`ycutAt` of its centre, read for every cell of a frame). */
  readonly #ycutK: Float64Array;
  readonly #sources: number[] = [];
  readonly #eyes: { readonly e: K2Eye; readonly cells: number[] }[];
  readonly #static: Uint8Array;
  readonly #mouths: Record<
    "calm" | "smile" | "pucker" | "o",
    Map<number, Mark>
  > & {
    readonly smirk: Map<number, Mark>;
    readonly soft: Map<number, Mark>;
  };
  /** The app's mood mouths: never in the idle life, so a settled frame keeps their cells. */
  readonly #moodMouths: Record<"frown" | "pout", Map<number, Mark>>;
  readonly #nose = new Map<number, Mark>();
  readonly #blush = new Map<number, number>();
  readonly #shoulder: number;
  readonly #rmax: number;
  readonly #rmin: number;

  constructor(meta: K2Meta, maps: Partial<Record<MapName, K2Map>>) {
    this.meta = meta;
    this.#maps = maps;
    const B = maps.base;
    const H = maps.hover;
    if (B === undefined || H === undefined)
      throw new Error("K2: base and hover maps");
    this.#B = B;
    this.#H = H;
    const { gw: GW, gh: GH, bx: BX, by: BY, pitch: P } = meta;
    const N = GW * GH;
    this.#N = N;
    this.#rmax = P * 0.52;
    this.#rmin = P * 0.14;
    const C = meta.cls;
    // cell centres: the figure on a near-regular screen, the cumulus with the clouds' own jitter
    this.X = new Float32Array(N);
    this.Y = new Float32Array(N);
    for (let j = 0; j < GH; j++)
      for (let i = 0; i < GW; i++) {
        const k = j * GW + i;
        const jit = B.cls[k] === C.cloud ? 0.18 : 0.05;
        this.X[k] =
          BX + i * P + (j & 1) * P * 0.5 + (hash01(i, j, 5) - 0.5) * P * jit;
        this.Y[k] = BY + j * P + (hash01(i, j, 6) - 0.5) * P * jit;
      }
    this.#ycutK = new Float64Array(N);
    for (let k = 0; k < N; k++) this.#ycutK[k] = this.ycutAt(this.X[k] ?? 0);
    // the tip dilated by two cells: cells beside a free strand learn that it may blow over them
    this.#tipD = new Float32Array(N);
    for (let j = 0; j < GH; j++)
      for (let i = 0; i < GW; i++) {
        let m = 0;
        for (let dj = -2; dj <= 2; dj++)
          for (let di = -2; di <= 2; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= GW || jj >= GH) continue;
            const t = B.tip[jj * GW + ii] ?? 0;
            if (t > m) m = t;
          }
        this.#tipD[j * GW + i] = m;
      }
    // stream sources: free hair on the silhouette, far from the scalp
    for (let k = 0; k < N; k++)
      if (
        B.cls[k] === C.hair &&
        (B.flags[k] ?? 0) & meta.flags.ring &&
        (B.tip[k] ?? 0) > 0.45
      )
        this.#sources.push(k);
    // eyes: geometry from the converter, cells from the maps
    this.#eyes = meta.eyes.map((e) => ({ e, cells: [] as number[] }));
    for (let k = 0; k < N; k++) {
      if (B.cls[k] !== C.eye && H.cls[k] !== C.eye) continue;
      let best = 0;
      let bd = 1e9;
      this.#eyes.forEach(({ e }, n) => {
        const d = Math.abs((this.X[k] ?? 0) - e.iris[0]);
        if (d < bd) {
          bd = d;
          best = n;
        }
      });
      this.#eyes[best]?.cells.push(k);
    }
    // the face below the eyes, authored on the screen
    const soft = this.#mouthMarks("soft");
    this.#mouths = {
      soft,
      smirk: this.#mouthMarks("smirk"),
      calm: this.#mouthMarks("calm"),
      smile: this.#mouthMarks("smile"),
      pucker: this.#pucker(),
      o: this.#oRing(),
    };
    this.#moodMouths = { frown: this.#frown(), pout: this.#poutMarks() };
    {
      const nose = meta.face.nose[0] ?? [0, 0];
      const nj = this.#rowOf(nose[1]);
      const ni = this.#colOf(nj, nose[0]);
      this.#nose.set(nj * GW + ni, { kind: "ink", r: 0.62, rest: false });
      this.#nose.set(
        (nj - 1) * GW + this.#colOf(nj - 1, this.#gx0(nj, ni) - P * 0.5),
        { kind: "shade", r: 1, rest: false },
      );
    }
    this.#buildBlush();
    // the shoulders (gestures only): everything under one line just below the choker
    this.#shoulder = meta.shoulder ?? 372 * meta.k + (1 - meta.k) * BY;
    // a settled frame never changes these cells: the wind cannot move them, no eye, mark or blush
    this.#static = new Uint8Array(N);
    const marked = new Set<number>();
    for (const m of Object.values(this.#mouths))
      for (const k of m.keys()) marked.add(k);
    for (const k of this.#nose.keys()) marked.add(k);
    for (const k of this.#blush.keys()) marked.add(k);
    for (let k = 0; k < N; k++) {
      const eye = B.cls[k] === C.eye || H.cls[k] === C.eye;
      // the strongest gust moves a strand by w * 3.3 cells: below half a cell it never moves
      this.#static[k] =
        (this.#tipD[k] ?? 0) * 3.3 < 0.5 && !eye && !marked.has(k) ? 1 : 0;
    }
  }

  /** A gesture or wake drawing arrived after the first paint. */
  addMap(name: MapName, map: K2Map): void {
    this.#maps[name] = map;
  }

  hasMap(name: MapName): boolean {
    return this.#maps[name] !== undefined;
  }

  /** Whether a cell is lit white on the base (or on the palm, for the bird's outline). */
  lightAt(x: number, y: number, palm = false): boolean {
    const k = this.cellAt(x, y);
    if (k < 0) return false;
    const C = this.meta.cls;
    const W = this.meta.col.white;
    const pm = this.#maps.palm;
    if (palm && pm !== undefined && pm.cls[k] === C.hand)
      return (pm.tone[k] ?? 0) > 0.4 && pm.col[k] === W;
    return (this.#B.tone[k] ?? 0) > 0.5 && this.#B.col[k] === W;
  }

  /* ---------------------------------------------------------------- geometry */

  #rowOf(y: number): number {
    return clamp(
      Math.round((y - this.meta.by) / this.meta.pitch),
      0,
      this.meta.gh - 1,
    );
  }
  #colOf(j: number, x: number): number {
    const { bx, pitch: P, gw } = this.meta;
    return clamp(Math.round((x - bx - (j & 1) * P * 0.5) / P), 0, gw - 1);
  }
  #gx0(j: number, i: number): number {
    const { bx, pitch: P } = this.meta;
    return bx + i * P + (j & 1) * P * 0.5;
  }
  /** The nearest cell to a point, or -1. */
  cellAt(x: number, y: number): number {
    const { bx: BX, by: BY, pitch: P, gw: GW, gh: GH } = this.meta;
    const j0 = Math.round((y - BY) / P);
    let best = -1;
    let bd = 1e9;
    for (let j = j0 - 1; j <= j0 + 1; j++) {
      if (j < 0 || j >= GH) continue;
      const i = Math.round((x - BX - (j & 1) * P * 0.5) / P);
      if (i < 0 || i >= GW) continue;
      const k = j * GW + i;
      const d = ((this.X[k] ?? 0) - x) ** 2 + ((this.Y[k] ?? 0) - y) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  }
  #lineCells(poly: readonly (readonly [number, number])[]): number[] {
    const out: number[] = [];
    for (let n = 1; n < poly.length; n++) {
      const a = poly[n - 1];
      const b = poly[n];
      if (a === undefined || b === undefined) continue;
      const m = Math.max(
        1,
        Math.ceil(
          Math.hypot(b[0] - a[0], b[1] - a[1]) / (this.meta.pitch * 0.4),
        ),
      );
      for (let q = 0; q <= m; q++) {
        const k = this.cellAt(
          a[0] + ((b[0] - a[0]) * q) / m,
          a[1] + ((b[1] - a[1]) * q) / m,
        );
        if (k >= 0 && !out.includes(k)) out.push(k);
      }
    }
    return out;
  }
  #ovalCells(cx: number, cy: number, rx: number, ry: number): number[] {
    const { by: BY, pitch: P, gw: GW } = this.meta;
    const out: number[] = [];
    for (let j = this.#rowOf(cy - ry - P); j <= this.#rowOf(cy + ry + P); j++)
      for (let i = 0; i < GW; i++) {
        const x = this.#gx0(j, i);
        const y = BY + j * P;
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1)
          out.push(j * GW + i);
      }
    return out;
  }
  /** Her cut at x: where her old cumulus began (the beam takes her over below it). */
  ycutAt(x: number): number {
    const yc = this.meta.ycut;
    const n = Math.max(
      0,
      Math.min(
        yc.length - 1,
        Math.round((x - this.meta.bx) / (this.meta.pitch * 0.5)),
      ),
    );
    return yc[n] ?? 0;
  }

  /* ---------------------------------------------------------------- the face marks */

  get #mouthRow(): {
    readonly MJ: number;
    readonly MI0: number;
    readonly MI1: number;
  } {
    const m = this.meta.face.mouth;
    const a = m[0] ?? [0, 0];
    const b = m[1] ?? a;
    const MJ = this.#rowOf((a[1] + b[1]) / 2);
    return { MJ, MI0: this.#colOf(MJ, a[0]), MI1: this.#colOf(MJ, b[0]) };
  }
  /** The mouth's centre, a touch toward her far side, where the edits pucker. */
  get #mouthPt(): readonly [number, number] {
    const m = this.meta.face.mouth;
    const a = m[0] ?? [0, 0];
    const b = m[m.length - 1] ?? a;
    const { MJ } = this.#mouthRow;
    return [(a[0] + b[0]) / 2, this.meta.by + MJ * this.meta.pitch];
  }

  #mouthMarks(shape: "soft" | "calm" | "smirk" | "smile"): Map<number, Mark> {
    const { gw: GW, pitch: P } = this.meta;
    const { MJ, MI0, MI1 } = this.#mouthRow;
    const RC = 0.88;
    const m = new Map<number, Mark>();
    const short = MI1 - MI0 < 5; // a mouth of 4 dots: a gentler taper
    for (let i = MI0; i <= MI1; i++) {
      const e = Math.min(i - MI0, MI1 - i);
      m.set(MJ * GW + i, {
        kind: "ink",
        r:
          RC *
          (e === 0 ? (short ? 0.74 : 0.6) : e === 1 ? (short ? 1 : 0.84) : 1),
        rest: true,
      });
    }
    // a corner: the cell on the row above, half a pitch outward from the end dot
    const corner = (end: number, dir: number) =>
      (MJ - 1) * GW + this.#colOf(MJ - 1, this.#gx0(MJ, end) + dir * P * 0.5);
    const set = (k: number, r: number) => {
      const was = m.get(k);
      if (was !== undefined) was.r = r;
    };
    if (shape === "soft") {
      m.set(corner(MI1, 1), { kind: "shadeTop", r: RC * 0.64, rest: true });
      m.set(corner(MI0, -1), { kind: "shadeTop", r: RC * 0.52, rest: true });
    }
    if (shape === "smirk") {
      m.set(corner(MI1, 1), { kind: "ink", r: RC * 0.6, rest: true });
      set(MJ * GW + MI1, RC * 0.84);
    }
    if (shape === "smile") {
      m.set(corner(MI1, 1), { kind: "ink", r: RC * 0.66, rest: true });
      m.set(corner(MI0, -1), { kind: "ink", r: RC * 0.56, rest: true });
      set(MJ * GW + MI1, RC * 0.84);
      set(MJ * GW + MI0, RC * 0.76);
    }
    // the lower lip: shaded skin one row below, under the mouth
    const lj = MJ + 1;
    const lip = this.meta.face.lip;
    for (
      let i = this.#colOf(lj, lip[0]?.[0] ?? 0);
      i <= this.#colOf(lj, lip[1]?.[0] ?? 0);
      i++
    )
      m.set(lj * GW + i, { kind: "shade", r: 1, rest: true });
    return m;
  }

  #pucker(): Map<number, Mark> {
    const { gw: GW } = this.meta;
    const { MJ } = this.#mouthRow;
    const [MX] = this.#mouthPt;
    const RC = 0.88;
    const m = new Map<number, Mark>();
    const c = this.#colOf(MJ, MX - 2.5);
    for (let i = c - 1; i <= c + 1; i++)
      m.set(MJ * GW + i, {
        kind: "ink",
        r: RC * (i === c ? 1.02 : 0.8),
        rest: true,
      });
    m.set((MJ + 1) * GW + this.#colOf(MJ + 1, MX - 2.5), {
      kind: "shade",
      r: 1,
      rest: true,
    });
    return m;
  }

  /** The frown (Concerned): her row, the corners turned down one row, half a pitch outward. */
  #frown(): Map<number, Mark> {
    const { gw: GW, pitch: P } = this.meta;
    const { MJ, MI0, MI1 } = this.#mouthRow;
    const RC = 0.88;
    const m = new Map<number, Mark>();
    for (let i = MI0; i <= MI1; i++) {
      const e = Math.min(i - MI0, MI1 - i);
      m.set(MJ * GW + i, {
        kind: "ink",
        r: RC * (e === 0 ? (i === MI1 ? 0.8 : 0.74) : e === 1 ? 0.84 : 1),
        rest: true,
      });
    }
    const corner = (end: number, dir: number) =>
      (MJ + 1) * GW + this.#colOf(MJ + 1, this.#gx0(MJ, end) + dir * P * 0.5);
    m.set(corner(MI1, 1), { kind: "ink", r: RC * 0.62, rest: true });
    m.set(corner(MI0, -1), { kind: "ink", r: RC * 0.54, rest: true });
    return m;
  }

  /** The pout (Error): a short full stroke toward her far side, a fuller lip under it. */
  #poutMarks(): Map<number, Mark> {
    const { gw: GW } = this.meta;
    const { MJ } = this.#mouthRow;
    const [MX] = this.#mouthPt;
    const RC = 0.88;
    const m = new Map<number, Mark>();
    const c = this.#colOf(MJ, MX - 2.5);
    for (let i = c - 1; i <= c + 1; i++)
      m.set(MJ * GW + i, {
        kind: "ink",
        r: RC * (i === c ? 1.04 : 0.84),
        rest: true,
      });
    const lc = this.#colOf(MJ + 1, MX - 3);
    m.set((MJ + 1) * GW + lc, { kind: "ink", r: RC * 0.55, rest: true });
    m.set((MJ + 1) * GW + lc + 1, { kind: "shade", r: 1, rest: true });
    return m;
  }

  #oRing(): Map<number, Mark> {
    const [MX, MY] = this.#mouthPt;
    const m = new Map<number, Mark>();
    for (const k of this.#ovalCells(MX - 2.5, MY + 1.5, 4.9, 5.2))
      m.set(k, { kind: "ink", r: 0.9, rest: true });
    m.set(this.cellAt(MX - 2.5, MY + 1.5), { kind: "shade", r: 1, rest: true });
    return m;
  }

  /** The blush: three short `///` hatch strokes per cheek, on the hex grid's own 60 degree step. */
  #buildBlush(): void {
    const KS = this.meta.k;
    for (const e of this.meta.eyes) {
      const bot = Math.max(...e.bot.map((p) => p[1]));
      const xl = e.top[0]?.[0] ?? 0;
      const xr = e.top[e.top.length - 1]?.[0] ?? 0;
      const cx = e.outer > 0 ? lerp(xl, xr, 0.6) : lerp(xl, xr, 0.42);
      const cy = bot + 12.5 * KS;
      const w = (xr - xl) * (e.outer > 0 ? 0.62 : 0.66);
      const sp = Math.max(5.2, w / 3.2);
      for (let s = 0; s < 3; s++) {
        const x = cx + (s - 1) * sp;
        for (const k of this.#lineCells([
          [x - 2.2, cy + 3.6],
          [x + 2.2, cy - 3.6],
        ]))
          this.#blush.set(k, 0.62);
      }
    }
  }

  /** The point she meets the blow's cloud with (her lips). */
  get mouthPoint(): readonly [number, number] {
    const [MX, MY] = this.#mouthPt;
    return [MX - 2.5, MY + 1.5];
  }

  /* ---------------------------------------------------------------- one frame */

  /**
   * Writes one frame's dots into `out`. `pal` gives the rim's tone. A `static` pass draws only the
   * cells a settled frame never changes (the engine caches it), a `dynamic` pass the rest, the eyes
   * and the strands; `all` draws everything (the wake, a gesture, a dissolve).
   */
  emit(fr: PortraitFrame, pal: Palette, out: Dots, pass: Pass): void {
    const meta = this.meta;
    const { gw: GW, gh: GH, bx: BX, by: BY, pitch: P } = meta;
    const KS = meta.k;
    const C = meta.cls;
    const CO = meta.col;
    const FL = meta.flags;
    const B = this.#B;
    const H = this.#H;
    const RMAX = this.#rmax;
    const RMIN = this.#rmin;
    const asm = fr.asm;
    const dark = fr.dark;
    const t = fr.t;
    const hp = fr.hp;
    const gs = fr.face;
    const gp = fr.gp;
    const GMAP = gs.map === null ? null : (this.#maps[gs.map] ?? null);
    const handMap =
      gs.hand !== null && gs.hand.p > 0
        ? (this.#maps[gs.hand.map] ?? null)
        : null;
    const hand = handMap !== null ? gs.hand : null;
    // a mood change: the cells the dissolve has not reached show the drawing it leaves
    const from = gs.from ?? null;
    const AMAP = from === null ? null : (this.#maps[from.map] ?? null);
    const handAMap =
      from !== null && from.hand !== null
        ? (this.#maps[from.hand.map] ?? null)
        : null;
    const handA = handAMap !== null ? (from?.hand ?? null) : null;
    const cut = fr.cut;
    const skinR = RMAX * Math.sqrt(0.95);
    const ASM_SPAN = 540;
    const assembleTop =
      cut !== null ? cut.bottom : meta.by + (600 - 56) * KS;
    const dot = (ink: Ink, x: number, y: number, r: number) => {
      if (r < RMIN) return;
      let yy = y;
      let rr = r;
      let nm = ink;
      if (cut !== null) {
        // the app drawing's cut: the dissolve below her line, the frame's edges thinning out
        const cj = Math.round((y - BY) / P);
        const ci = Math.round((x - BX - (cj & 1) * P * 0.5) / P);
        const q = (y - cut.top(x)) / cut.band;
        if (q > 0) {
          if (q >= 1 || bayerAt(ci, cj) < q * cut.gain) return;
          rr *= 1 - cut.shrink * q;
        }
        const sd = Math.min(x - BX, cut.width - x);
        if (sd < cut.side && bayerAt(ci, cj) < 1 - sd / cut.side) return;
      }
      if (asm < 1) {
        // she assembles bottom up: each dot flies up into place as a white spark
        const arrive = clamp(
          (assembleTop -
            y +
            hash01(Math.round(x * 3), Math.round(y * 3), 11) * 60 * KS) /
            (ASM_SPAN * KS),
          0,
          1,
        );
        const loc = (asm - arrive * 0.8) / 0.2;
        if (loc <= 0) return;
        if (loc < 1) {
          yy += (1 - loc) * (1 - loc) * 46 * KS;
          rr *= 0.55 + 0.45 * loc;
          if (loc < 0.7) nm = "white";
        }
      }
      out.add(nm, x, yy, rr);
    };
    const X = this.X;
    const Y = this.Y;
    // a map cell drawn at (x, y): its colour through the accent; the rim round the hair
    const put = (M: K2Map, s: number, x: number, y: number, scale: number) => {
      const tn = M.tone[s] ?? 0;
      if (tn <= 0.01) return;
      const c = M.col[s];
      if ((M.flags[s] ?? 0) & FL.ring && M.cls[s] === C.hair) {
        dot(
          dark ? "rimHair" : "white",
          x,
          y,
          RMAX * Math.sqrt(pal.rimTone) * scale,
        );
        return;
      }
      const r = RMAX * Math.sqrt(tn) * scale;
      if (c === CO.ink) dot("ink", x, y, r);
      else if (c === CO.blue_w) dot("streak", x, y, r * STREAK.r);
      else if (c === CO.blue_i) dot("blueArea", x, y, r);
      else dot("white", x, y, r);
    };
    // a hand cell (the peace hand, a gesture hand): faded where it is still inside her light
    const putHand = (M: K2Map, s: number, k: number) => {
      const x = X[k] ?? 0;
      const y = Y[k] ?? 0;
      const fy =
        cut !== null
          ? 1
          : clamp((this.ycutAt(x) + 46 * KS - y) / (70 * KS), 0, 1);
      const tn = (M.tone[s] ?? 0) * smooth(fy);
      if (tn <= 0.02) return;
      const c = M.col[s];
      const r = RMAX * Math.sqrt(tn);
      if (c === CO.ink) dot("ink", x, y, r);
      else if (c === CO.blue_i || c === CO.blue_w) dot("blue", x, y, r);
      else dot("white", x, y, r);
    };
    const mouth = this.#mouthFor(fr, hp);
    const faceAt = (k: number) =>
      mouth.get(k) ?? (gs.nose === false ? undefined : this.#nose.get(k));
    const sh = fr.still ? 0 : gs.sh;
    const eyeOn = new Uint8Array(this.#N);
    const gust = fr.gust;
    // the wind (and the hum's sway, never past the strongest gust the cache allows for)
    const amp = clamp(0.7 + 2.6 * gust + 1.6 * fr.sway, -3.3, 3.3);
    const lift = 1.2 * gust;
    const wave0 = t / 1400;
    const want = pass === "static" ? 1 : pass === "dynamic" ? 0 : -1;
    const ST = this.#static;
    const tipD = this.#tipD;
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const k = j * GW + i;
        if (want >= 0 && ST[k] !== want) continue;
        const bay = bayerAt(i, j);
        const useH = hp > bay;
        const useG = !useH && GMAP !== null && gp > bay;
        const M = useH
          ? H.cls[k] !== C.hand
            ? H
            : B
          : useG && GMAP !== null
            ? GMAP.cls[k] !== C.hand
              ? GMAP
              : B
            : AMAP !== null && AMAP.cls[k] !== C.hand
              ? AMAP
              : B;
        const cls = M.cls[k];
        if (cls === C.eye) {
          eyeOn[k] = 1;
          continue;
        }
        // below her cut is the beam's: her old cumulus is not drawn
        if (cls === C.cloud) continue;
        // the hover hand: drawn `rise` rows lower (it comes up out of her light)
        if (hp > 0) {
          const sj = j - fr.rise;
          if (sj >= 0) {
            const s = sj * GW + i;
            if (H.cls[s] === C.hand && hp > bay) {
              putHand(H, s, k);
              continue;
            }
          }
        }
        if (hand !== null && handMap !== null) {
          const sj = j - hand.rise;
          const si = i - hand.di;
          if (sj >= 0 && si >= 0 && si < GW) {
            const s = sj * GW + si;
            if (handMap.cls[s] === C.hand && hand.p > bay) {
              putHand(handMap, s, k);
              continue;
            }
          }
        }
        // the hand of the drawing it leaves sinks back where the dissolve has not reached
        if (handA !== null && handAMap !== null && !useG && !useH) {
          const sj = j - handA.rise;
          const si = i - handA.di;
          if (sj >= 0 && si >= 0 && si < GW) {
            const s = sj * GW + si;
            if (handAMap.cls[s] === C.hand) {
              putHand(handAMap, s, k);
              continue;
            }
          }
        }
        const fo = faceAt(k);
        // the closed mouth clears in the first half of the hover dissolve
        if (fo !== undefined && !(fo.rest && hp > bay * 0.55)) {
          const x = this.#gx0(j, i);
          const y = BY + j * P;
          if (fo.kind === "shade") dot("shade", x, y, skinR);
          else if (fo.kind === "shadeTop") {
            dot("shade", x, y, skinR);
            dot("inkTop", x, y, RMAX * fo.r);
          } else dot("ink", x, y, RMAX * fo.r);
          continue;
        }
        const bl = gs.blush > 0 ? this.#blush.get(k) : undefined;
        if (bl !== undefined && gs.blush > bay) {
          dot("blush", this.#gx0(j, i), BY + j * P, RMAX * bl);
          continue;
        }
        // the shoulders: everything under the neckline moves up `sh` rows as one piece
        let dyS = 0;
        if (sh) {
          if ((Y[k] ?? 0) >= this.#shoulder) dyS = sh * P;
          else if ((Y[k] ?? 0) >= this.#shoulder - sh * P) continue;
        }
        // wind: backward map the hair through the fixed screen, whole cells
        let src = k;
        const w = tipD[k] ?? 0;
        if (w > 0 && !fr.still) {
          const wave = Math.sin(
            (wave0 - (Y[k] ?? 0) / (80 * KS) - (X[k] ?? 0) / (300 * KS)) *
              6.2832,
          );
          const di = Math.round(w * amp * (0.62 + 0.38 * wave));
          const dj = Math.round((-w * lift * (0.5 + 0.5 * wave)) / 2) * 2;
          if (di || dj) {
            const si = i - di;
            const sj = j - dj;
            if (si >= 0 && sj >= 0 && si < GW && sj < GH) {
              const s = sj * GW + si;
              const movedHere = M.cls[s] === C.hair && (M.tip[s] ?? 0) > 0;
              const movedAway = M.cls[k] === C.hair && (M.tip[k] ?? 0) > 0;
              if (movedHere || movedAway) src = s;
            } else if (M.cls[k] === C.hair && (M.tip[k] ?? 0) > 0) continue;
          }
        }
        const sc = M.cls[src];
        if (sc === C.eye || sc === C.hand || sc === C.cloud) continue;
        // her tee and hair dissolve into the beam over the band above her cut
        const q =
          cut !== null
            ? 0
            : ((Y[k] ?? 0) - ((this.#ycutK[k] ?? 0) - MERGE * KS)) /
              ((MERGE + 8) * KS);
        if (q > 0 && (q >= 1 || bay < q)) continue;
        put(M, src, X[k] ?? 0, (Y[k] ?? 0) - dyS, q > 0 ? 1 - 0.35 * q : 1);
      }
    }
    if (pass === "static") return;

    this.#emitEyes(fr, hp, eyeOn, dot, skinR);

    if (gs.tear > 0) {
      const e = meta.eyes[1];
      if (e !== undefined) {
        const x = (e.top[e.top.length - 1]?.[0] ?? 0) - 4 * KS;
        const y = this.#polyAt(e.bot, x) + 2 * KS + gs.tear * 5 * KS;
        const k = this.cellAt(x, y);
        if (k >= 0) dot("glint", X[k] ?? 0, Y[k] ?? 0, RMAX * 0.95);
      }
    }

    // strands shedding streams of dots downwind (more in gusts), snapped to the screen
    if (!fr.still && this.#sources.length > 0 && asm >= 1) {
      const sp: Ink = dark ? "rimHair" : "ink";
      for (let s = 0; s < 8; s++) {
        const per = 2600 + hash01(s, 1, 61) * 1800;
        const off = hash01(s, 2, 61) * per;
        const c = Math.floor((t + off) / per);
        const age = t + off - c * per;
        const start = c * per - off;
        if (hash01(c, s, 62) > 0.3 + 0.7 * gustAt(Math.max(0, start))) continue;
        const k0 =
          this.#sources[Math.floor(hash01(c, s, 63) * this.#sources.length)] ??
          0;
        const x0 = X[k0] ?? 0;
        const y0 = Y[k0] ?? 0;
        // a bust sheds nothing from hair it does not draw
        if (cut !== null && y0 > cut.top(x0)) continue;
        const v = (0.05 + hash01(c, s, 64) * 0.05) * KS;
        const ph = hash01(c, s, 65) * 6.28;
        const life = 1 - age / per;
        const m = 8;
        for (let q = 0; q < m; q++) {
          const a = age - q * 90;
          if (a <= 0) continue;
          const x = x0 + v * a + 0.00001 * KS * a * a;
          const y = y0 + (Math.sin(a / 380 + ph) * 5 - 0.012 * a * lift) * KS;
          const jj = Math.round((y - BY) / P);
          const ii = Math.round((x - BX - (jj & 1) * P * 0.5) / P);
          const sx = BX + ii * P + (jj & 1) * P * 0.5;
          const sy = BY + jj * P;
          if (sx > meta.streamMaxX) continue;
          if (hash01(c * 31 + q, s, 66) > life * 1.1) continue;
          dot(
            sp,
            sx,
            sy,
            RMAX * Math.sqrt(0.55 * (1 - q / m)) * (0.55 + 0.45 * life),
          );
        }
      }
    }
  }

  /** The mouth this frame: a gesture's, the idle smirk, or her own (soft). */
  #mouthFor(fr: PortraitFrame, hp: number): Map<number, Mark> {
    const g = fr.face.mouth;
    if (g !== null && hp < 0.5) {
      if (g === "none") return EMPTY;
      if (g === "rest") return this.#mouths.soft;
      if (g === "frown" || g === "pout") return this.#moodMouths[g];
      return this.#mouths[g];
    }
    return fr.smirk ? this.#mouths.smirk : this.#mouths.soft;
  }

  #polyAt(poly: readonly (readonly [number, number])[], x: number): number {
    const first = poly[0] ?? [0, 0];
    if (x <= first[0]) return first[1];
    for (let n = 1; n < poly.length; n++) {
      const b = poly[n] ?? first;
      if (x <= b[0]) {
        const a = poly[n - 1] ?? first;
        return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
      }
    }
    return (poly[poly.length - 1] ?? first)[1];
  }

  /**
   * The eyes, authored: ink lash line, white sclera, the iris (blue), ink pupil, one white
   * highlight; the lid closes as white skin with the lash line coming down. Gestures: `squeeze`
   * (`> <`), `happy` (arcs), `soft`, the wake's `closed` and `drowsy`; the app's moods: `narrow`,
   * `wide`, `worried` (the lid line tilting up to the inner corner), `half`, `smile`.
   */
  #emitEyes(
    fr: PortraitFrame,
    hp: number,
    eyeOn: Uint8Array,
    dot: (ink: Ink, x: number, y: number, r: number) => void,
    skinR: number,
  ): void {
    const meta = this.meta;
    const P = meta.pitch;
    const KS = meta.k;
    const RMAX = this.#rmax;
    const X = this.X;
    const Y = this.Y;
    const GW = meta.gw;
    const em =
      fr.eyes !== null && hp < 0.5 && (!fr.still || fr.held === true)
        ? fr.eyes
        : null;
    let lid = fr.lid;
    if (em === "closed" || em === "map") lid = 1;
    if (em === "drowsy") lid = Math.max(0.55, lid);
    if (em === "narrow") lid = Math.max(0.36, lid);
    if (em === "worried") lid = Math.max(0.16, lid);
    if (em === "half") lid = Math.max(0.46, lid);
    const tgt = fr.gaze;
    for (const { e, cells } of this.#eyes) {
      const xl = e.top[0]?.[0] ?? 0;
      const xr = e.top[e.top.length - 1]?.[0] ?? 0;
      const live = cells.filter((k) => eyeOn[k] === 1);
      if (em === "squeeze" || em === "happy") {
        const xin = e.outer > 0 ? xl : xr;
        const xout = e.outer > 0 ? xr : xl;
        const ymid =
          (this.#polyAt(e.top, (xl + xr) / 2) +
            this.#polyAt(e.bot, (xl + xr) / 2)) /
          2;
        for (const k of live) {
          const x = X[k] ?? 0;
          const y = Y[k] ?? 0;
          let on = false;
          if (em === "squeeze") {
            // > < : two strokes from the outer corner, meeting at the inner corner
            const wv = Math.min(Math.abs(xout - xin) * 0.82, 23 * KS);
            const ax = xin + Math.sign(xout - xin) * 1.5;
            const ay = ymid + 1;
            const bx = ax + Math.sign(xout - xin) * wv;
            for (const [ex, ey] of [
              [bx, ymid - 7.2 * KS],
              [bx, ymid + 6.4 * KS],
            ] as const) {
              const vx = ex - ax;
              const vy = ey - ay;
              const q = clamp(
                ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy),
                0,
                1,
              );
              if (Math.hypot(x - (ax + vx * q), y - (ay + vy * q)) < P * 0.7)
                on = true;
            }
          } else {
            // ^ ^ : an arc from corner to corner, bulging up (the happy closed eye)
            const hA = (e.outer > 0 ? 8 : 7) * KS;
            let px0 = xl;
            let py0 = this.#polyAt(e.bot, xl) - 1;
            for (let q = 1; q <= 8; q++) {
              const u = q / 8;
              const px1 = lerp(xl, xr, u);
              const py1 =
                lerp(this.#polyAt(e.bot, xl), this.#polyAt(e.bot, xr), u) -
                1 -
                Math.sin(Math.PI * u) * hA;
              const vx = px1 - px0;
              const vy = py1 - py0;
              const w = clamp(
                ((x - px0) * vx + (y - py0) * vy) / (vx * vx + vy * vy),
                0,
                1,
              );
              if (Math.hypot(x - (px0 + vx * w), y - (py0 + vy * w)) < P * 0.66)
                on = true;
              px0 = px1;
              py0 = py1;
            }
          }
          dot(on ? "ink" : "white", x, y, on ? RMAX * 0.94 : skinR);
        }
        continue;
      }
      const g = this.#gazeFor(e, tgt);
      const hlx = e.hl[0] + g.gx;
      const hly = e.hl[1] + g.gy;
      const hl2 = this.cellAt(e.hl2[0] + g.gx, e.hl2[1] + g.gy);
      const lift =
        em === "soft" ? 1.4 : em === "narrow" ? 1.5 : em === "smile" ? 1 : 0;
      const smile = Math.max(hp, lift);
      for (const k of live) {
        const x = X[k] ?? 0;
        const y = Y[k] ?? 0;
        const top = this.#polyAt(e.top, x);
        const bot0 = this.#polyAt(e.bot, x);
        const bot = bot0 - smile * (bot0 - top) * 0.12;
        const lidY = top + lid * (bot - top);
        const lash = e.lash;
        // worried: the lid line tilts up toward the inner corner
        const tilt =
          em === "worried"
            ? (e.outer > 0 ? 1 : -1) *
              ((x - (xl + xr) / 2) / (xr - xl)) *
              3.2 *
              KS
            : 0;
        if (y < lidY - lash + tilt) {
          dot("white", x, y, skinR);
          continue;
        }
        if (y < lidY + tilt + (lid > 0.9 ? lash * 0.35 : 0)) {
          dot("ink", x, y, RMAX * 0.98);
          continue;
        }
        if (y > bot) {
          // the lower lash line on the outer part of the eye, one row under the opening
          const u = (x - xl) / (xr - xl);
          const outer = e.outer > 0 ? u > 0.38 : u < 0.62;
          if (y <= bot + P * 1.05 && lid < 0.9 && outer) {
            dot("ink", x, y, RMAX * 0.7);
            continue;
          }
          dot("white", x, y, skinR);
          continue;
        }
        if (Math.abs(x - hlx) <= P * 0.5 && Math.abs(y - hly) <= P * 0.5) {
          dot("glint", x, y, RMAX * 1.12);
          continue;
        }
        if (k === hl2 && lid < 0.5) {
          dot("glint", x, y, RMAX * 0.72);
          continue;
        }
        const px = e.pupil[0] + g.gx;
        const py = e.pupil[1] + g.gy;
        const dP =
          ((x - px) / Math.max(e.pupil[2], P * 0.85)) ** 2 +
          ((y - py) / Math.max(e.pupil[3], P * 1.15)) ** 2;
        if (dP < 1) {
          dot("ink", x, y, RMAX);
          continue;
        }
        const ix = e.iris[0] + g.gx;
        const iy = e.iris[1] + g.gy;
        const dI = ((x - ix) / e.iris[2]) ** 2 + ((y - iy) / e.iris[3]) ** 2;
        if (dI < 1) {
          if (y < iy - e.iris[3] * 0.5) dot("ink", x, y, RMAX * 0.92);
          else if (y > iy + e.iris[3] * 0.3)
            dot((k + ((k / GW) | 0)) & 1 ? "blue" : "white", x, y, RMAX * 0.6);
          else dot("blue", x, y, RMAX * 0.78);
          continue;
        }
        dot("white", x, y, RMAX * Math.sqrt(0.9));
      }
    }
  }

  /** The gaze offset of one eye toward a target, in whole half cells. */
  #gazeFor(
    e: K2Eye,
    tgt: GazeTarget,
  ): { readonly gx: number; readonly gy: number } {
    const meta = this.meta;
    const KS = meta.k;
    const ex = e.iris[0];
    const ey = e.iris[1];
    const k = (v: number) => clamp(v, -1, 1);
    const rx =
      (k((tgt.x - ex) / (360 * KS)) - k((meta.rest[0] - ex) / (360 * KS))) *
      e.gmax[0] *
      0.75;
    const ry =
      (k((tgt.y - ey) / (260 * KS)) - k((meta.rest[1] - ey) / (260 * KS))) *
      e.gmax[1];
    const q = meta.pitch * 0.5;
    return {
      gx: clamp(Math.round(rx / q) * q, -e.gmax[2], e.gmax[0]),
      gy: clamp(Math.round(ry / q) * q, -e.gmax[1], e.gmax[1]),
    };
  }
}

const EMPTY = new Map<number, Mark>();
/** The band over her cut (map px at scale k 1) her tee dissolves into the beam across. */
export const MERGE = 30;
