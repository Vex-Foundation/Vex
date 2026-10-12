/**
 * The agent's flock on the left page print: the Desktop eagle leads, a few
 * far birds keep it company, all of it white pixel blocks on one
 * `aria-hidden` canvas over the sepia plateau. The flock's pose IS the agent
 * state (`agent-state.ts`, the running head's tape word):
 *
 * - idle      the eagle glides (150 wide, cell 4, trail .42 x 12), two far
 *             birds rest ahead of it
 * - live      the eagle with short trails (.26 x 6); four far birds wheel
 *             round one point ahead while 26 loose pixels gather there
 * - running   single file with full trails (.7 x 16), the eagle leading
 *             (104 wide, .62 x 22)
 * - awaiting  frozen and crisp: no trails, no bob, and a dotted hold line
 *             with a stop bar ahead of the lead (the REAL FUNDS hold)
 * - paused    the empty print
 *
 * Layouts: `page` is the 300 wide left page and closes to the spine
 * composition (the eagle alone, small) when the page is narrower than 120;
 * `stage` is the full window print of the unlock and the wizard, one eagle
 * placed as a fraction of the window.
 *
 * Every animal is placed by its visible box (alpha bounds), not by its file
 * box, so the stage pose and the page pose line up during the handoff.
 *
 * The design: `docs/design/V10-SPREAD.md section 6` (the eagle and the flock
 * as the agent state) and `docs/design/V10-SPREAD.md section 10` (reduced
 * motion).
 *
 * Rendering rules: one composed frame first, always. Only live and running
 * move (the flock moves while the system works, never on a timer and never
 * as an idle loop); in motion the trails and the dust are re-seeded every
 * 200ms frame step, the far birds beat their wings on the same step, painting
 * is capped at 30fps and skipped when nothing changed. The loop does not run
 * at all while the window is hidden or the plate is off screen. Under reduced
 * motion or Save-Data the composed frame is the only frame.
 */

import {
  type AlphaBounds,
  type PixelSource,
  type Plotter,
  alphaBounds,
  ditherCell,
  loadImage,
  rng,
} from "../../lib/pixel/core.js";
import {
  type LumaMode,
  type SpriteGrid,
  drawSpriteGrid,
  spriteGrid,
} from "../../lib/pixel/sprite.js";
import type { DeskAgentState } from "./agent-state.js";

/** `page` = the left page (and its spine); `stage` = the full window print. */
export type PlateLayout = "page" | "stage";

/** The shipped art (`public/art/`): the prints, their grain and the sprites. */
export const PLATE_ART = {
  day: "/art/plateau.jpg",
  night: "/art/plateau-night.jpg",
  /** Spelled out again in PrintPlate's class list, where Tailwind can see it. */
  grain: "/art/grain.svg",
  eagle: "/art/eagle.png",
  birds: "/art/birds/",
} as const;

/** A page narrower than this is the closed spine and draws the spine composition. */
export const SPINE_MAX_WIDTH = 120;
/** Trails, dust and wing beats change on this step (the motion token `--frame-step`). */
export const FRAME_STEP_MS = 200;
/** Paint at most this many frames a second. */
export const FPS_CAP = 30;
/** Device pixel ratio ceiling: blocks are big, a third device pixel buys nothing. */
const DPR_CAP = 2;
/** The animals are white blocks on the print, in both themes. */
const INK = "#FFFFFF";

/** The states that move. Every other state paints its one frame and stops. */
export const MOVING_STATES: ReadonlySet<DeskAgentState> = new Set<DeskAgentState>([
  "live",
  "running",
]);

/* ------------------------------------------------------------- glitch */

interface Glitch {
  readonly crisp?: boolean;
  readonly trail: number;
  readonly trailLen: number;
  readonly tear: number;
  readonly drop: number;
  readonly strays: number;
  readonly vert: number;
}

/** A state that draws animals (paused is the empty print). */
type FlyingState = Exclude<DeskAgentState, "paused">;

/** The eagle per state: idle glides, live shortens the trail, running streaks, awaiting holds. */
const EAGLE_GLITCH: Readonly<Record<FlyingState, Glitch>> = {
  idle: { trail: 0.42, trailLen: 12, tear: 0.04, drop: 0.025, strays: 0.003, vert: 0.07 },
  live: { trail: 0.26, trailLen: 6, tear: 0.06, drop: 0.04, strays: 0.003, vert: 0.12 },
  running: { trail: 0.62, trailLen: 22, tear: 0.05, drop: 0.03, strays: 0.006, vert: 0.08 },
  awaiting: { crisp: true, trail: 0, trailLen: 0, tear: 0, drop: 0, strays: 0, vert: 0 },
};

/** The far birds: rougher than the eagle, they are small and far. */
const FAR_GLITCH = { tear: 0.1, drop: 0.05, strays: 0.006, vert: 0.1 } as const;

/** How each sprite is classified into cells. */
const EAGLE_GRID = { lumaMode: "luma" as LumaMode, shadowOpen: 0.22, shadow: 0.45 };
const BIRD_GRID = { lumaMode: "rg" as LumaMode, shadowOpen: 0.3, shadow: 0.45 };

/** Bird poses (index n is `bird-(n+1).webp`) whose source faces left, flipped to fly right. */
const POSE_FLIP: readonly boolean[] = [true, true, true, false, true, false, false, false];
/** One wing beat: up, level, down, level. Birds in these poses beat in motion. */
const WING_BEAT: readonly number[] = [5, 6, 7, 6];

/* ------------------------------------------------------------- the compositions */

interface EagleAt {
  readonly src: "eagle";
  /** Centre of the visible box, fractions of the plate. */
  readonly cx: number;
  readonly cy: number;
  /** Visible width, CSS px. */
  readonly vis: number;
  readonly cell: number;
  readonly seed?: number;
}

interface BirdAt {
  readonly src: "bird";
  readonly pose: number;
  /** Left edge and centre line, fractions of the plate. */
  readonly x: number;
  readonly y: number;
  /** Width, CSS px. */
  readonly w: number;
  readonly cell: number;
  readonly seed?: number;
  readonly trail?: number;
  readonly trailLen?: number;
}

interface DustAt {
  /** Centre, fractions of the plate; radii, CSS px. */
  readonly x: number;
  readonly y: number;
  readonly rx: number;
  readonly ry: number;
  readonly n: number;
  readonly cell: number;
  readonly seed: number;
}

interface HoldAt {
  /** Start, fractions of the plate; length, CSS px. */
  readonly x: number;
  readonly y: number;
  readonly len: number;
}

interface Scene {
  readonly animals: readonly (EagleAt | BirdAt)[];
  readonly dust?: DustAt;
  readonly hold?: HoldAt;
  /** Live: the far birds wheel round the dust. */
  readonly wheel?: boolean;
}

/**
 * The left page, authored on the 300 x 900 page: the horizon sits at .572,
 * the band runs .572 to .77. Later animals draw on top.
 */
const PAGE: Readonly<Record<FlyingState, Scene>> = {
  idle: {
    animals: [
      { src: "eagle", cx: 0.33, cy: 0.662, vis: 150, cell: 4, seed: 21 },
      { src: "bird", pose: 2, x: 0.64, y: 0.612, w: 40, cell: 3, seed: 7, trail: 0.4, trailLen: 10 },
      { src: "bird", pose: 6, x: 0.84, y: 0.598, w: 26, cell: 3, seed: 9, trail: 0.4, trailLen: 8 },
    ],
  },
  live: {
    animals: [
      { src: "eagle", cx: 0.28, cy: 0.672, vis: 138, cell: 4, seed: 25 },
      { src: "bird", pose: 5, x: 0.56, y: 0.6, w: 34, cell: 3, seed: 11, trail: 0.3, trailLen: 6 },
      { src: "bird", pose: 6, x: 0.82, y: 0.612, w: 30, cell: 3, seed: 13, trail: 0.3, trailLen: 6 },
      { src: "bird", pose: 7, x: 0.77, y: 0.656, w: 28, cell: 3, seed: 15, trail: 0.3, trailLen: 6 },
      { src: "bird", pose: 5, x: 0.55, y: 0.648, w: 26, cell: 3, seed: 17, trail: 0.3, trailLen: 6 },
    ],
    dust: { x: 0.72, y: 0.628, rx: 24, ry: 9, n: 26, cell: 3, seed: 4 },
    wheel: true,
  },
  running: {
    animals: [
      { src: "bird", pose: 6, x: 0.06, y: 0.632, w: 30, cell: 3, seed: 3, trail: 0.7, trailLen: 16 },
      { src: "bird", pose: 7, x: 0.24, y: 0.626, w: 32, cell: 3, seed: 5, trail: 0.7, trailLen: 16 },
      { src: "bird", pose: 5, x: 0.42, y: 0.618, w: 34, cell: 3, seed: 6, trail: 0.7, trailLen: 16 },
      { src: "eagle", cx: 0.78, cy: 0.628, vis: 104, cell: 3, seed: 27 },
    ],
  },
  awaiting: {
    animals: [
      { src: "bird", pose: 0, x: 0.05, y: 0.632, w: 30, cell: 3 },
      { src: "bird", pose: 0, x: 0.18, y: 0.626, w: 32, cell: 3 },
      { src: "bird", pose: 0, x: 0.32, y: 0.619, w: 34, cell: 3 },
      { src: "eagle", cx: 0.58, cy: 0.61, vis: 80, cell: 3 },
    ],
    hold: { x: 0.78, y: 0.609, len: 40 },
  },
};

/** The closed page (the 56 wide spine): the eagle alone, small, in the band. */
const SPINE: Readonly<Record<FlyingState, Scene>> = {
  idle: { animals: [{ src: "eagle", cx: 0.5, cy: 0.645, vis: 42, cell: 2, seed: 21 }] },
  live: {
    animals: [{ src: "eagle", cx: 0.42, cy: 0.65, vis: 38, cell: 2, seed: 25 }],
    dust: { x: 0.86, y: 0.615, rx: 6, ry: 5, n: 8, cell: 2, seed: 4 },
  },
  running: { animals: [{ src: "eagle", cx: 0.5, cy: 0.64, vis: 40, cell: 2, seed: 27 }] },
  awaiting: { animals: [{ src: "eagle", cx: 0.44, cy: 0.64, vis: 36, cell: 2 }] },
};

/** The stage eagle: centre and visible width as fractions of the window. */
export interface StagePose {
  readonly x: number;
  readonly y: number;
  readonly frac: number;
  readonly cell: number;
}

/** The unlock's pose: 288 wide, centred at 288, 567 in a 1440 x 900 window. */
export const STAGE_POSE: StagePose = { x: 0.2, y: 0.63, frac: 0.2, cell: 5 };

/* ------------------------------------------------------------- resolved, in CSS px */

export interface EagleLayer {
  readonly kind: "eagle";
  /** Centre of the visible box and its width. */
  readonly cx: number;
  readonly cy: number;
  readonly vis: number;
  readonly cell: number;
  readonly seed: number;
  readonly glitch: Glitch;
}

export interface BirdLayer {
  readonly kind: "bird";
  readonly pose: number;
  /** Left edge and centre line. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly cell: number;
  readonly seed: number;
  readonly glitch: Glitch;
  /** Beats its wings in motion. */
  readonly beats: boolean;
}

export type Layer = EagleLayer | BirdLayer;

export interface Dust {
  readonly x: number;
  readonly y: number;
  readonly rx: number;
  readonly ry: number;
  readonly n: number;
  readonly cell: number;
  readonly seed: number;
}

export interface Hold {
  readonly x: number;
  readonly y: number;
  readonly len: number;
}

export interface Composition {
  readonly layers: readonly Layer[];
  readonly dust: Dust | null;
  readonly hold: Hold | null;
  /** The point the far birds wheel round (live on the page), or null. */
  readonly wheel: { readonly x: number; readonly y: number } | null;
}

/** The sprite file of a far bird pose (index n is `bird-(n+1).webp`). */
const birdUrl = (pose: number) => `${PLATE_ART.birds}bird-${pose + 1}.webp`;

/** The paused print: nothing on it. */
const EMPTY: Composition = { layers: [], dust: null, hold: null, wheel: null };

/**
 * The composed frame of a state on a plate W x H (CSS px). Pure: this is the
 * still frame, and the frame every motion starts from.
 */
export function compositionFor(
  state: DeskAgentState,
  layout: PlateLayout,
  W: number,
  H: number,
  stagePose: StagePose = STAGE_POSE,
): Composition {
  if (state === "paused") return EMPTY;
  if (layout === "stage") {
    return {
      layers: [
        {
          kind: "eagle",
          cx: stagePose.x * W,
          cy: stagePose.y * H,
          vis: stagePose.frac * W,
          cell: stagePose.cell,
          seed: 21,
          glitch: EAGLE_GLITCH[state],
        },
      ],
      dust: null,
      hold: null,
      wheel: null,
    };
  }
  const scene = (W < SPINE_MAX_WIDTH ? SPINE : PAGE)[state];
  const moving = MOVING_STATES.has(state);
  const layers = scene.animals.map((a, n): Layer => {
    if (a.src === "eagle") {
      return {
        kind: "eagle",
        cx: a.cx * W,
        cy: a.cy * H,
        vis: a.vis,
        cell: a.cell,
        seed: a.seed ?? 21,
        glitch: EAGLE_GLITCH[state],
      };
    }
    return {
      kind: "bird",
      pose: a.pose,
      x: a.x * W,
      y: a.y * H,
      w: a.w,
      cell: a.cell,
      seed: 31 + n * 7 + (a.seed ?? 0),
      glitch: {
        ...FAR_GLITCH,
        crisp: state === "awaiting",
        trail: a.trail ?? 0.4,
        trailLen: a.trailLen ?? 8,
      },
      beats: moving && WING_BEAT.includes(a.pose),
    };
  });
  const d = scene.dust;
  const dust: Dust | null =
    d === undefined
      ? null
      : { x: d.x * W, y: d.y * H, rx: d.rx, ry: d.ry, n: d.n, cell: d.cell, seed: d.seed };
  const h = scene.hold;
  const hold: Hold | null = h === undefined ? null : { x: h.x * W, y: h.y * H, len: h.len };
  const wheel = scene.wheel === true && dust !== null ? { x: dust.x, y: dust.y } : null;
  return { layers, dust, hold, wheel };
}

/**
 * The sprite files a state needs on a layout, in motion or still. A page can
 * close to the spine and open again on a resize, so both compositions count.
 */
export function spritesFor(
  state: DeskAgentState,
  layout: PlateLayout,
  moving: boolean,
): string[] {
  const urls = new Set<string>();
  // The open page, the spine; the stage has one composition at any size.
  const widths = layout === "stage" ? [1440] : [300, 56];
  for (const W of widths) {
    for (const l of compositionFor(state, layout, W, 900).layers) {
      if (l.kind === "eagle") {
        urls.add(PLATE_ART.eagle);
        continue;
      }
      urls.add(birdUrl(l.pose));
      if (moving && l.beats) for (const p of WING_BEAT) urls.add(birdUrl(p));
    }
  }
  return [...urls];
}

/* ------------------------------------------------------------- motion */

/** One wheel turn of the live far birds. */
const WHEEL_PERIOD_MS = 12_000;
/** The wheel is an ellipse this flat (the authored birds sit on it). */
const WHEEL_ASPECT = 0.6;
/** Bob amplitude, CSS px. */
const BOB_PX = 2;

/** A layer where it is at time t (ms). At t = 0 every layer is exactly as composed. */
function layerAt(l: Layer, c: Composition, t: number, frame: number): {
  readonly layer: Layer;
  readonly bob: number;
} {
  if (t <= 0) return { layer: l, bob: 0 };
  // Each animal bobs on its own slow sine; all of them start level.
  const bob = BOB_PX * Math.sin((t / 900) * (0.85 + (l.seed % 7) * 0.05));
  if (l.kind === "eagle") return { layer: l, bob };
  let { x, y, pose } = l;
  if (c.wheel !== null) {
    const bx = x + l.w / 2 - c.wheel.x;
    const by = (y - c.wheel.y) / WHEEL_ASPECT;
    const r = Math.hypot(bx, by);
    const th = Math.atan2(by, bx) + (t / WHEEL_PERIOD_MS) * Math.PI * 2;
    x = c.wheel.x + r * Math.cos(th) - l.w / 2;
    y = c.wheel.y + r * WHEEL_ASPECT * Math.sin(th);
  }
  if (l.beats) {
    const i0 = WING_BEAT.indexOf(l.pose);
    pose = WING_BEAT[(i0 + frame) % WING_BEAT.length] ?? l.pose;
  }
  return { layer: { ...l, x, y, pose }, bob };
}

/* ------------------------------------------------------------- sprites and grids */

const images = new Map<string, Promise<HTMLImageElement>>();

/** The default sprite loader: one decode per URL for the whole window. */
function loadSprite(src: string): Promise<PixelSource> {
  let pending = images.get(src);
  if (pending === undefined) {
    pending = loadImage(src);
    // A failed load may be retried by the next engine, not cached as a hole.
    pending.catch(() => images.delete(src));
    images.set(src, pending);
  }
  return pending;
}

const bounds = new WeakMap<PixelSource, AlphaBounds>();
const grids = new WeakMap<PixelSource, Map<string, SpriteGrid>>();

function boundsOf(img: PixelSource): AlphaBounds {
  let b = bounds.get(img);
  if (b === undefined) {
    b = alphaBounds(img);
    bounds.set(img, b);
  }
  return b;
}

function gridOf(
  img: PixelSource,
  w: number,
  cell: number,
  flip: boolean,
  kind: typeof EAGLE_GRID,
): SpriteGrid {
  let byKey = grids.get(img);
  if (byKey === undefined) {
    byKey = new Map();
    grids.set(img, byKey);
  }
  const key = `${w}|${cell}|${flip ? 1 : 0}|${kind.lumaMode}|${kind.shadowOpen}`;
  let g = byKey.get(key);
  if (g === undefined) {
    g = spriteGrid(img, {
      w,
      cell,
      flip,
      lattice: true,
      natural: true,
      lumaMode: kind.lumaMode,
      shadowOpen: kind.shadowOpen,
      shadow: kind.shadow,
    });
    byKey.set(key, g);
  }
  return g;
}

/** A layer as a grid at a snapped device position. */
interface Placed {
  readonly g: SpriteGrid;
  readonly c: number;
  readonly X0: number;
  readonly Y0: number;
}

/** The eagle by its visible box: centre (cx, cy) and visible width vis, CSS px. */
export function placeEagle(
  box: AlphaBounds,
  l: Pick<EagleLayer, "cx" | "cy" | "vis" | "cell">,
  dpr: number,
): { readonly w: number; readonly c: number; readonly X0: number; readonly Y0: number } {
  const k = l.vis / Math.max(1, box.x1 - box.x0);
  const c = Math.round(l.cell * dpr);
  const ox = l.cx - ((box.x0 + box.x1) / 2) * k;
  const oy = l.cy - ((box.y0 + box.y1) / 2) * k;
  return {
    w: box.fw * k,
    c,
    X0: Math.round((ox * dpr) / c) * c,
    Y0: Math.round((oy * dpr) / c) * c,
  };
}

function place(l: Layer, sprites: ReadonlyMap<string, PixelSource>, dpr: number): Placed | null {
  if (l.kind === "eagle") {
    const img = sprites.get(PLATE_ART.eagle);
    if (img === undefined) return null;
    const at = placeEagle(boundsOf(img), l, dpr);
    return { g: gridOf(img, at.w, l.cell, false, EAGLE_GRID), c: at.c, X0: at.X0, Y0: at.Y0 };
  }
  const img = sprites.get(birdUrl(l.pose));
  if (img === undefined) return null;
  const g = gridOf(img, l.w, l.cell, POSE_FLIP[l.pose] ?? false, BIRD_GRID);
  const c = Math.round(l.cell * dpr);
  return {
    g,
    c,
    X0: Math.round((l.x * dpr) / c) * c,
    Y0: Math.round(l.y * dpr - (g.gh * c) / 2),
  };
}

/** Live: loose pixels gather round the point the birds wheel round. */
function drawDust(ctx: Plotter, d: Dust, dpr: number, frame: number): void {
  const R = rng(d.seed + frame * 13);
  const c = Math.round(d.cell * dpr);
  const cx = d.x * dpr;
  const cy = d.y * dpr;
  const rx = d.rx * dpr;
  const ry = d.ry * dpr;
  for (let n = 0; n < d.n; n++) {
    const a = R() * Math.PI * 2;
    const r = Math.pow(R(), 0.7);
    const x = Math.round((cx + Math.cos(a) * rx * r) / c) * c;
    const y = Math.round((cy + Math.sin(a) * ry * r) / c) * c;
    if (R() < 0.55) ctx.fillRect(x, y, c, c);
    else ditherCell(ctx, x, y, c, 0.5);
  }
}

/** Awaiting: a dotted hold line ahead of the lead, ending in a stop bar. */
function drawHold(ctx: Plotter, h: Hold, dpr: number): void {
  const x0 = h.x * dpr;
  const y = Math.round(h.y * dpr);
  const len = h.len * dpr;
  const s = Math.max(2, Math.round(2 * dpr));
  for (let x = 0; x < len; x += s * 3) ctx.fillRect(Math.round(x0 + x), y, s, s);
  ctx.fillRect(Math.round(x0 + len), y - 4 * s, s, 9 * s);
}

/* ------------------------------------------------------------- engine */

export interface FlockEngineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly state: DeskAgentState;
  readonly layout: PlateLayout;
  /** Stage only: where the eagle sits. */
  readonly stagePose?: StagePose;
  /** One composed frame, never another (reduced motion, Save-Data, captures). */
  readonly still: boolean;
  /** Sprite loader; the default decodes each URL once per window. */
  readonly load?: (src: string) => Promise<PixelSource>;
}

/**
 * Paints one plate. `start()` loads the sprites the state needs and paints
 * the composed frame; a moving state then runs its loop while the window is
 * shown and the plate is on screen. `resize()` repaints at the new size;
 * `destroy()` stops everything. A canvas without a 2D context draws nothing.
 */
export class FlockEngine {
  readonly #o: FlockEngineOptions;
  readonly #sprites = new Map<string, PixelSource>();
  #raf = 0;
  #stopped = false;
  #looping = false;
  #onscreen = true;
  #observer: IntersectionObserver | null = null;
  /** Motion time, ms: advances only while the loop runs. */
  #t = 0;
  /** Last loop timestamp; negative = resync on the next tick (no jump after a pause). */
  #last = -1;
  #lastPaint = -Infinity;
  #signature = "";
  #W = 0;
  #H = 0;
  #dpr = 1;
  #comp: Composition = EMPTY;

  constructor(options: FlockEngineOptions) {
    this.#o = options;
  }

  /** Whether this engine animates after its first frame. */
  get moving(): boolean {
    return !this.#o.still && MOVING_STATES.has(this.#o.state);
  }

  async start(): Promise<void> {
    this.#measure();
    const load = this.#o.load ?? loadSprite;
    const urls = spritesFor(this.#o.state, this.#o.layout, this.moving);
    const loaded = await Promise.all(urls.map((u) => load(u)));
    if (this.#stopped) return;
    urls.forEach((u, i) => {
      const img = loaded[i];
      if (img !== undefined) this.#sprites.set(u, img);
    });
    this.#paint();
    this.#o.canvas.dataset.ready = "";
    if (!this.moving) return;
    document.addEventListener("visibilitychange", this.#onVisibility);
    if (typeof IntersectionObserver !== "undefined") {
      this.#observer = new IntersectionObserver((entries) => {
        this.#onscreen = entries.some((e) => e.isIntersecting);
        if (this.#onscreen) this.#wake();
        else this.#sleep();
      });
      this.#observer.observe(this.#o.canvas);
    }
    this.#looping = true;
    this.#wake();
  }

  /** The plate changed size: re-measure and repaint the current frame. */
  resize(): void {
    if (this.#stopped) return;
    this.#measure();
    this.#signature = "";
    this.#paint();
  }

  destroy(): void {
    this.#stopped = true;
    this.#looping = false;
    this.#sleep();
    document.removeEventListener("visibilitychange", this.#onVisibility);
    this.#observer?.disconnect();
    this.#observer = null;
  }

  #shouldRun(): boolean {
    return this.#looping && !this.#stopped && this.#onscreen && !document.hidden;
  }

  #wake(): void {
    if (!this.#shouldRun() || this.#raf !== 0) return;
    this.#last = -1;
    this.#raf = requestAnimationFrame(this.#tick);
  }

  #sleep(): void {
    if (this.#raf !== 0) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  readonly #onVisibility = (): void => {
    if (document.hidden) this.#sleep();
    else this.#wake();
  };

  readonly #tick = (now: number): void => {
    this.#raf = 0;
    if (!this.#shouldRun()) return;
    if (this.#last < 0) this.#last = now;
    // A stalled frame advances the flock by at most a quarter second.
    this.#t += Math.min(250, Math.max(0, now - this.#last));
    this.#last = now;
    this.#raf = requestAnimationFrame(this.#tick);
    // The cap, with a millisecond of slack for a 60Hz frame that lands early.
    if (now - this.#lastPaint < 1000 / FPS_CAP - 1) return;
    this.#lastPaint = now;
    this.#paint();
  };

  #measure(): void {
    const { canvas, state, layout, stagePose } = this.#o;
    const box = canvas.getBoundingClientRect();
    this.#W = box.width;
    this.#H = box.height;
    this.#dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    canvas.width = Math.max(1, Math.round(this.#W * this.#dpr));
    canvas.height = Math.max(1, Math.round(this.#H * this.#dpr));
    this.#comp = compositionFor(state, layout, this.#W, this.#H, stagePose);
  }

  #paint(): void {
    const ctx = this.#o.canvas.getContext("2d");
    if (ctx === null) return;
    const t = this.moving ? this.#t : 0;
    const frame = Math.floor(t / FRAME_STEP_MS);
    const dpr = this.#dpr;
    const placed: { readonly p: Placed; readonly l: Layer; readonly bob: number }[] = [];
    for (const l0 of this.#comp.layers) {
      const { layer, bob } = layerAt(l0, this.#comp, t, frame);
      const p = place(layer, this.#sprites, dpr);
      if (p === null) continue;
      placed.push({ p, l: layer, bob: Math.round((bob * dpr) / p.c) * p.c });
    }
    // Repaint only when a pixel can differ: the frame step, a moved block.
    const signature = [
      this.#W,
      this.#H,
      frame,
      ...placed.map(({ p, bob }) => `${p.X0},${p.Y0 + bob}`),
    ].join("|");
    if (signature === this.#signature) return;
    this.#signature = signature;
    ctx.clearRect(0, 0, this.#o.canvas.width, this.#o.canvas.height);
    ctx.fillStyle = INK;
    for (const { p, l, bob } of placed) {
      drawSpriteGrid(ctx, p.g, {
        X0: p.X0,
        Y0: p.Y0 + bob,
        c: p.c,
        seed: l.seed + frame,
        dir: 1,
        ...l.glitch,
      });
    }
    if (this.#comp.dust !== null) drawDust(ctx, this.#comp.dust, dpr, frame);
    if (this.#comp.hold !== null) drawHold(ctx, this.#comp.hold, dpr);
  }
}
