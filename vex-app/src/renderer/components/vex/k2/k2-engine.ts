/**
 * K2's canvas (`docs/design/R3-MINIMAL.md section 10`): one canvas in her host for her portrait,
 * the beam of her token (the sky's own halftone dots), the token and the gestures' actors.
 *
 * - Her clock runs only while she is on screen and the window is shown (`RunGate`) and steps at
 *   10 fps; a frame never advances it by more than 250 ms, so a stall or a hidden window resumes
 *   where it stopped. Each frame is a pure function of that clock and the inputs (the hover, the
 *   clicks, the pointer, the emotion), so the wake and the gestures play the same on every launch.
 * - Her dots in a settled frame (no dissolve, no gesture, no wake) that no wind, blink or mouth
 *   can change are drawn once into a scratch canvas and copied; only the hair in the wind, the
 *   eyes, the face marks and the strands are drawn per frame, and a frame whose dots and light did
 *   not change is never repainted. The ratio is capped at 2.
 * - The emotion (`setEmotion`) is her face (`k2-poses.ts`): a change dissolves on her clock; asleep
 *   and settled nothing of her moves, so she is painted once and left still, the beam and the token
 *   dimmed with her.
 * - Idle, by default she looks at you and now and then glances away; her idle pool (the blow, the
 *   bird, the blush, the whistle, the hum) plays one action at a time; a long hover makes her
 *   blush, a click (`poke`) makes her giggle.
 * - The still frame (reduced motion, Save-Data, or asked by the host) paints once (awake, the
 *   token flat, the beam on and still, no wind, no gestures, the emotion settled) and repaints only
 *   on a hover, a theme, a ground, an emotion or a layout change.
 *
 * The host places her (`k2-rig.ts`, `setFit`); her map's px are drawn through one transform
 * (host = o + s * map). The maps and the token's sprites load from the renderer's own origin
 * (`k2-assets.ts`).
 */
import { RunGate } from "../../../lib/motion/run-gate.js";
import { context2dOf, loadMap, loadMeta, type Scratch, scratchCanvas } from "./k2-assets.js";
import type { K2Emotion } from "./k2-emotion.js";
import {
  Dots,
  INKS,
  inkStyles,
  type K2Map,
  type K2Meta,
  MERGE,
  type Palette,
  type Pass,
  Portrait,
  type PortraitFrame,
} from "./k2-portrait.js";
import { MOOD_MAPS, type MoodChange, type MoodFace, type MoodLook, moodFace } from "./k2-poses.js";
import { noise1 } from "./k2-rand.js";
import {
  APP_LOOKS,
  type Box,
  beamScreen,
  canvasBox,
  type Fit,
  type K2Drawing,
  TOKEN_SHEET,
} from "./k2-rig.js";
import {
  actorPaths,
  type BeamScreen,
  drawBeam,
  drawBird,
  drawCloud,
  drawNotes,
  drawPuff,
  type KeepRect,
} from "./k2-scene.js";
import { type InkStyle, Stamper } from "./k2-stamp.js";
import {
  type ActiveGesture,
  birdState,
  blinkAt,
  canGiggle,
  clamp,
  type FaceState,
  type GazeTarget,
  GestureChain,
  type GestureName,
  type GlanceAway,
  GlanceChain,
  gestureAt,
  gestureState,
  gustAt,
  hoverProgress,
  LONG_HOVER,
  type MapName,
  projector,
  ramp,
  STEP_MS,
  smirking,
  type WakeMode,
  wakeEnd,
  wakeState,
} from "./k2-time.js";
import { type PlacedToken, TokenSprite } from "./k2-token.js";

const DPR_CAP = 2;
/** A frame never advances her clock by more than this, ms. */
export const CLOCK_CAP_MS = 250;
/** The idle actions: all once her gestures' drawings are in, the map-free ones before. */
const ALL: readonly GestureName[] = ["blow", "bird", "giggle", "blush", "whistle", "hum"];
const MAP_FREE: readonly GestureName[] = ["blush", "whistle", "hum"];
/**
 * The beam's ink by the ground under her (`docs/design/R3-MINIMAL.md section 10.4`): white on the
 * print by day at 0.66, a step under the clouds' 0.9 so her tee reads (the web home's value); white
 * at the clouds' night alpha 0.46 at night, also on night paper; on day paper, where white light
 * cannot show, the one blue at 0.4. The blow's cloud keeps the clouds' alpha.
 */
export const CLOUD_ALPHA = { light: 0.9, dark: 0.46 } as const;
export const PRINT_BEAM_ALPHA = 0.66;
export const PAPER_BEAM_ALPHA = 0.4;
/** The host's blocks keep the actors out by this much air (map px), in order. */
const AIR = [28, 16, 20] as const;
/** A pointer that moved this recently (ms) pulls her eyes from you. */
const POINTER_FRESH = 2500;
/** Each drawing's folder under the art root. */
const DIR: Readonly<Record<K2Drawing, string>> = { wide: "", app: "app/" };
/** The wide drawing has these of the emotions' drawings (the rest show on its base). */
const WIDE_MOOD_MAPS: readonly MapName[] = ["hover", "asleep", "yawn", "rub"];

/** What she stands on: the print, day paper or night paper (the beam's ink follows it). */
export type K2Ground = "print" | "paper" | "night";

export interface K2EngineOptions {
  /** Her host: host px are its box's. */
  readonly host: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly dark: boolean;
  readonly ground: K2Ground;
  readonly still: boolean;
  /** The wake plays from the token. */
  readonly wake: boolean;
  /** The wake has handed her over. */
  readonly onWoken: () => void;
  /** Review: plays that gesture 1 s after she is awake. */
  readonly force?: GestureName | null;
  /** The composer she looks at while listening (by default her look goes down and to the side). */
  readonly composer?: (() => HTMLElement | null) | undefined;
}

function readVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === "" ? fallback : v;
}

/** Her inks, from the static tier of the tokens (no new colour). */
function inks(dark: boolean): Palette {
  const field = readVar("--color-white", "#ffffff");
  const ink = readVar("--color-ink", "#0a0d18");
  const blueHi = readVar("--color-blue-hi", "#0000ff");
  const blue = readVar("--color-blue", "#0000c0");
  const peri = readVar("--color-peri", "#a3abff");
  if (!dark)
    return {
      white: field,
      wA: 0.96,
      ink,
      blue: blueHi,
      blueArea: blue,
      rimHair: field,
      rimTone: 0.4,
      blush: ink,
    };
  return {
    white: field,
    wA: 0.9,
    ink,
    blue: peri,
    blueArea: peri,
    rimHair: peri,
    rimTone: 0.52,
    blush: peri,
  };
}

/** The beam's ink by the ground under her. */
export function beamInk(ground: K2Ground, dark: boolean, pal: Palette): InkStyle {
  if (ground === "paper" && !dark)
    return { color: readVar("--color-blue", "#0000c0"), alpha: PAPER_BEAM_ALPHA };
  if (dark || ground === "night") return { color: pal.white, alpha: CLOUD_ALPHA.dark };
  return { color: pal.white, alpha: PRINT_BEAM_ALPHA };
}

export class K2Engine {
  readonly #o: K2EngineOptions;
  readonly #ac = new AbortController();
  readonly #token = new TokenSprite();
  readonly #stamper = new Stamper();
  readonly #portraits: Partial<Record<K2Drawing, Portrait>> = {};
  readonly #loading = new Set<K2Drawing>();
  #fit: Fit | null = null;
  #keep: readonly Box[] = [];
  #dark: boolean;
  #ground: K2Ground;
  #pal: Palette;
  #gate: RunGate | null = null;
  #raf = 0;
  #clock = 0;
  #last = -1;
  #stepT = -1;
  #stopped = false;
  #started = false;
  #woken = false;
  /** The canvas's box in host px and its device ratio. */
  #box = { x: 0, y: 0, w: 1, h: 1 };
  #dpr = 1;
  #cache: { key: string; canvas: Scratch } | null = null;
  #lastSig = -1;
  #gestures = false;
  readonly #chain: GestureChain;
  readonly #giggles: number[] = [];
  /** When long hovers ended (each one makes her blush). */
  readonly #blushes: number[] = [];
  #hover = false;
  #hoverAt = -1;
  #unhoverAt = -1;
  #hold = false;
  #holdAt = -1;
  #unholdAt = -1;
  #pointer: { x: number; y: number } | null = null;
  /**
   * When the pointer last moved (her clock): a moving pointer pulls her eyes from you; a still one
   * starts the whistle's wait.
   */
  #pointerAt = Number.NEGATIVE_INFINITY;
  /** Her glances away from you (built for the wake's end). */
  #glances: { readonly awakeAt: number; readonly chain: GlanceChain } | null = null;
  /** Her emotion and when it last changed (null until the host sets one). */
  #mood: MoodChange | null = null;
  /** The last frozen frame painted (asleep and settled): the next identical one is skipped. */
  #frozen: string | null = null;

  constructor(o: K2EngineOptions) {
    this.#o = o;
    this.#dark = o.dark;
    this.#ground = o.ground;
    this.#pal = inks(o.dark);
    const f = o.force;
    const force = f === "blow" || f === "bird" || f === "blush" || f === "hum" ? f : null;
    this.#chain = new GestureChain(this.#awakeAt(), force);
    if (f === "giggle") this.#giggles.push(this.#awakeAt() + 1000);
  }

  /* ---------------------------------------------------------------- the host's inputs */

  /** Where the host placed her, and its blocks the actors keep out of (host px). */
  setFit(fit: Fit, keep: readonly Box[] = []): void {
    const prev = this.#fit;
    this.#fit = fit;
    this.#keep = keep;
    this.#layout();
    if (prev?.rig.drawing !== fit.rig.drawing && this.#started)
      void this.#loadDrawing(fit.rig.drawing);
    this.#repaintIdle();
  }

  setDark(dark: boolean): void {
    if (dark === this.#dark) return;
    this.#dark = dark;
    this.#pal = inks(dark);
    this.#cache = null;
    this.#frozen = null;
    this.#repaintIdle();
  }

  setGround(ground: K2Ground): void {
    if (ground === this.#ground) return;
    this.#ground = ground;
    this.#frozen = null;
    this.#repaintIdle();
  }

  setHover(on: boolean): void {
    if (on === this.#hover) return;
    this.#hover = on;
    const now = this.#now();
    if (on) this.#hoverAt = now;
    else {
      // a long hover, once it ends, makes her blush
      if (!this.#o.still && now - this.#hoverAt >= LONG_HOVER && now >= this.#awakeAt()) {
        this.#blushes.push(now);
        if (this.#blushes.length > 8) this.#blushes.shift();
      }
      this.#unhoverAt = now;
    }
    this.#repaintIdle();
  }

  /**
   * The agent's state as her face. The first emotion she starts in is settled at once (a wake
   * plays from now); every later change dissolves on her clock.
   */
  setEmotion(emotion: K2Emotion): void {
    const cur = this.#mood;
    if (cur?.to === emotion) return;
    this.#mood = {
      from: cur?.to ?? emotion,
      to: emotion,
      at: cur === null && emotion !== "waking" ? -1e9 : this.#now(),
    };
    this.#repaintIdle();
  }

  /** A click or a tap on her: a giggle, once she is awake, idle and its cooldown is over. */
  poke(): void {
    if (this.#o.still) return;
    if (this.#mood !== null && this.#mood.to !== "idle") return;
    const t = this.#now();
    if (canGiggle(t, this.#giggles, this.#awakeAt())) this.#giggles.push(t);
  }

  resize(): void {
    this.#layout();
    this.#repaintIdle();
  }

  /* ---------------------------------------------------------------- life cycle */

  async start(): Promise<void> {
    const fit = this.#fit;
    if (fit === null) return;
    // device px per css px of the sheet's coin
    const coin = fit.rig.token.d * fit.s;
    const density = (Math.min(window.devicePixelRatio || 1, DPR_CAP) * coin) / TOKEN_SHEET.td;
    await Promise.all([
      this.#loadDrawing(fit.rig.drawing),
      this.#token.load(this.#o.wake, density),
    ]);
    if (this.#stopped) return;
    this.#started = true;
    this.#paint(0, true);
    this.#o.host.dataset["vexK2Ready"] = "";
    if (this.#o.still) return;
    this.#listen();
    this.#gate = new RunGate(this.#o.canvas, (run) => {
      if (run) this.#loop();
      else cancelAnimationFrame(this.#raf);
      this.#last = -1;
    });
    const later = (): void => void this.#loadGestures();
    if (typeof window.requestIdleCallback === "function")
      window.requestIdleCallback(later, { timeout: 4000 });
    else window.setTimeout(later, 1500);
  }

  destroy(): void {
    this.#stopped = true;
    cancelAnimationFrame(this.#raf);
    this.#gate?.destroy();
    this.#ac.abort();
  }

  /* ---------------------------------------------------------------- assets */

  async #loadDrawing(drawing: K2Drawing): Promise<void> {
    if (this.#portraits[drawing] !== undefined || this.#loading.has(drawing)) return;
    this.#loading.add(drawing);
    const dir = DIR[drawing];
    try {
      const meta: K2Meta = await loadMeta(dir);
      const n = meta.gw * meta.gh;
      const files: MapName[] = ["base", "hover"];
      if (this.#o.wake && !this.#o.still) files.push("asleep", "yawn", "rub");
      const maps = await Promise.all(files.map((m) => loadMap(`${dir}${m}.png`, n)));
      const set: Partial<Record<MapName, K2Map>> = {};
      files.forEach((m, i) => {
        const map = maps[i];
        if (map !== undefined) set[m] = map;
      });
      if (this.#stopped) return;
      this.#portraits[drawing] = new Portrait(meta, set);
      this.#cache = null;
      this.#frozen = null;
      if (this.#started) this.#repaintIdle();
      void this.#loadMoods(drawing);
    } catch {
      // she stays away rather than half drawn
    } finally {
      this.#loading.delete(drawing);
    }
  }

  /** The emotions' drawings (until one arrives its emotion shows on the base drawing). */
  async #loadMoods(drawing: K2Drawing): Promise<void> {
    const portrait = this.#portraits[drawing];
    if (portrait === undefined || this.#stopped) return;
    const n = portrait.meta.gw * portrait.meta.gh;
    const names = (drawing === "app" ? MOOD_MAPS : WIDE_MOOD_MAPS).filter(
      (m) => !portrait.hasMap(m),
    );
    await Promise.all(
      names.map(async (m) => {
        try {
          portrait.addMap(m, await loadMap(`${DIR[drawing]}${m}.png`, n));
        } catch {
          // that emotion stays on the base drawing
        }
      }),
    );
    if (this.#stopped || names.length === 0) return;
    this.#cache = null;
    this.#frozen = null;
    this.#repaintIdle();
  }

  async #loadGestures(): Promise<void> {
    if (this.#stopped) return;
    const drawing = this.#fit?.rig.drawing ?? "wide";
    const portrait = this.#portraits[drawing];
    if (portrait === undefined) {
      // still loading: ask again; a drawing that failed to load takes no gestures
      if (this.#loading.has(drawing)) window.setTimeout(() => void this.#loadGestures(), 2000);
      return;
    }
    try {
      const n = portrait.meta.gw * portrait.meta.gh;
      const names: MapName[] = ["blow", "palm", "giggle"];
      const maps = await Promise.all(names.map((m) => loadMap(`${DIR[drawing]}${m}.png`, n)));
      names.forEach((m, i) => {
        const map = maps[i];
        if (map !== undefined) portrait.addMap(m, map);
      });
      this.#gestures = true;
    } catch {
      this.#gestures = false;
    }
  }

  /* ---------------------------------------------------------------- layout */

  #layout(): void {
    const fit = this.#fit;
    if (fit === null) return;
    const host = this.#o.host;
    const hw = host.clientWidth;
    const hh = host.clientHeight;
    const c = canvasBox(fit);
    const x0 = Math.max(0, Math.floor(c.left));
    const y0 = Math.max(0, Math.floor(c.top));
    const x1 = Math.min(hw, Math.ceil(c.right));
    const y1 = Math.min(hh, Math.ceil(c.bottom));
    const box = {
      x: x0,
      y: y0,
      w: Math.max(1, x1 - x0),
      h: Math.max(1, y1 - y0),
    };
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const canvas = this.#o.canvas;
    const W = Math.max(1, Math.round(box.w * dpr));
    const H = Math.max(1, Math.round(box.h * dpr));
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    // single CSSOM property writes: allowed under the renderer's CSP (MOTION-POLICY.md)
    canvas.style.left = `${box.x}px`;
    canvas.style.top = `${box.y}px`;
    canvas.style.width = `${box.w}px`;
    canvas.style.height = `${box.h}px`;
    if (
      box.x !== this.#box.x ||
      box.y !== this.#box.y ||
      box.w !== this.#box.w ||
      box.h !== this.#box.h ||
      dpr !== this.#dpr
    )
      this.#cache = null;
    this.#box = box;
    this.#dpr = dpr;
    this.#lastSig = -1;
    this.#frozen = null;
  }

  /** The map transform for a 2D context of the canvas's size. */
  #toMap(ctx: CanvasRenderingContext2D, fit: Fit): void {
    const d = this.#dpr;
    ctx.setTransform(
      d * fit.s,
      0,
      0,
      d * fit.s,
      d * (fit.ox - this.#box.x),
      d * (fit.oy - this.#box.y),
    );
  }

  /* ---------------------------------------------------------------- the loop */

  #now(): number {
    return this.#clock;
  }

  #awakeAt(): number {
    return wakeEnd(this.#mode());
  }

  #mode(): WakeMode {
    return this.#o.wake && !this.#o.still ? "full" : "none";
  }

  #listen(): void {
    const signal = this.#ac.signal;
    window.addEventListener(
      "pointermove",
      (e) => {
        if (e.pointerType === "touch") return;
        this.#pointer = { x: e.clientX, y: e.clientY };
        this.#pointerAt = this.#now();
      },
      { passive: true, signal },
    );
    window.addEventListener(
      "pointerout",
      (e) => {
        if (e.relatedTarget !== null || e.pointerType === "touch") return;
        this.#pointer = null;
      },
      { passive: true, signal },
    );
  }

  #loop(): void {
    const tick = (now: number): void => {
      this.#raf = requestAnimationFrame(tick);
      if (this.#last < 0) this.#last = now;
      this.#clock += Math.min(CLOCK_CAP_MS, now - this.#last);
      this.#last = now;
      const t = Math.floor(this.#clock / STEP_MS) * STEP_MS;
      if (t === this.#stepT) return;
      this.#stepT = t;
      this.#paint(t, false);
    };
    this.#raf = requestAnimationFrame(tick);
  }

  /** A paint outside the loop: a still frame, or a change while she rests off screen. */
  #repaintIdle(): void {
    if (!this.#started) return;
    if (this.#o.still || this.#gate?.running !== true)
      this.#paint(this.#o.still ? 0 : Math.max(0, this.#stepT), true);
  }

  /* ---------------------------------------------------------------- one frame */

  #paint(t: number, force: boolean): void {
    const fit = this.#fit;
    if (fit === null) return;
    const portrait = this.#portraits[fit.rig.drawing];
    if (portrait === undefined || !this.#token.ready) return;
    const meta = portrait.meta;
    const R = fit.rig;
    const mode = this.#mode();
    const awakeAt = wakeEnd(mode);
    if (mode !== "none" && t >= awakeAt && !this.#woken) {
      this.#woken = true;
      this.#o.onWoken();
    }
    const glance = { x: meta.glance[0], y: meta.glance[1] };
    const pj = projector(t, mode);
    const WS = wakeState(t, mode, meta.pitch, meta.k, glance);
    // the emotion, after the wake: one set while she woke dissolves in from her waking smile when
    // the wake hands her over (a wake already played is not played again)
    const mood: MoodChange | null =
      this.#mood !== null && awakeAt > 0 && this.#mood.at < awakeAt
        ? { from: "idle", to: this.#mood.to === "waking" ? "idle" : this.#mood.to, at: awakeAt }
        : this.#mood;
    const mf: MoodFace | null =
      WS === null && mood !== null
        ? moodFace(mood, t, {
            rise: meta.rise,
            pitch: meta.pitch,
            k: meta.k,
            glance,
            still: this.#o.still,
          })
        : null;
    // asleep and settled nothing of her moves: she is painted as a still frame
    const frozen = mf?.frozen === true;
    const still = this.#o.still || frozen;
    if (!force && frozen) {
      const key = [R.drawing, R.palm, fit.s, fit.ox, fit.oy, this.#dark, this.#ground, this.#mood?.to]
        .map(String)
        .join("|");
      if (key === this.#frozen) return;
      this.#frozen = key;
    } else this.#frozen = null;

    // what holds the idle pool back: a hover, any emotion but idle (settled)
    const hold = this.#hover || (mf !== null && !mf.gestures);
    if (hold !== this.#hold) {
      this.#hold = hold;
      if (hold) this.#holdAt = t;
      else this.#unholdAt = t;
    }
    const G: ActiveGesture | null =
      WS === null && (mf === null || mf.gestures)
        ? gestureAt(this.#chain, {
            t,
            allowed: still ? [] : this.#gestures ? ALL : MAP_FREE,
            awakeAt,
            giggles: this.#giggles,
            blushes: this.#blushes,
            stillSince: this.#pointerAt,
            hold,
            holdAge: hold ? t - this.#holdAt : -1,
            unholdAge: !hold && this.#unholdAt >= 0 ? t - this.#unholdAt : -1,
          })
        : null;
    const gs: FaceState = WS ?? (G !== null || mf === null ? gestureState(G) : mf.face);
    const giggle = G !== null && G.name === "giggle" ? G.age : -1;
    const gigW = giggle >= 0 ? ramp(giggle, 0, 150) * (1 - ramp(giggle, 1800, 2000)) : 0;
    let { hp, rp } = hoverProgress(
      this.#hover,
      this.#hover ? t - this.#hoverAt : -1,
      !this.#hover && this.#unhoverAt >= 0 ? t - this.#unhoverAt : -1,
      still,
    );
    // no hover while she wakes, nor in an emotion that holds her face
    if (t < awakeAt || (mf !== null && !mf.gestures)) {
      hp = 0;
      rp = 0;
    }
    hp *= 1 - gigW;
    rp *= 1 - gigW;
    // by default she looks at you; now and then she glances away (never in an action or a hover)
    if (this.#glances?.awakeAt !== awakeAt)
      this.#glances = { awakeAt, chain: new GlanceChain(awakeAt) };
    const away: GlanceAway | null =
      !still && G === null && WS === null && !this.#hover && hp === 0
        ? this.#glances.chain.at(t)
        : null;
    const rise = Math.round((1 - rp) ** 3 * meta.rise);
    const gp = gs.gp * (1 - hp);
    const smirk = G === null && WS === null && !still && !this.#hover && hp === 0 && smirking(t);
    const gust = still ? 0 : gustAt(t);
    const em = gs.eyes !== null && hp < 0.5 && !still ? gs.eyes : null;
    let lid = still ? 0 : em === "soft" ? Math.max(0.22, blinkAt(t)) : blinkAt(t);
    if (WS !== null && WS.lid > 0) lid = Math.max(lid, WS.lid);
    // the gestures look at their actors on the wide drawing's frame (`k2-rig.ts` shift)
    const [sx, sy] = R.shift;
    const seen =
      G !== null && gs.gaze !== null
        ? { ...gs, gaze: { x: gs.gaze.x - sx, y: gs.gaze.y - sy } }
        : gs;
    const look = this.#moodLook(fit, G === null ? mf?.look : undefined, glance, meta);
    const gaze = this.#gaze(fit, seen, hp, away, glance, meta, look);
    const fr: PortraitFrame = {
      t,
      still,
      dark: this.#dark,
      hp,
      rise,
      face: gs,
      gp,
      smirk,
      gust,
      sway: still ? 0 : gs.sway,
      lid,
      eyes: gs.eyes,
      gaze,
      asm: pj.asm,
      cut: R.cut,
      held: mf !== null,
    };
    // an emotion whose dissolve is done and whose hand is up settles like her own face
    const moodSettled = mf !== null && G === null && mf.settled;
    const settled =
      pj.asm >= 1 &&
      (moodSettled || (gp === 0 && !(gs.hand !== null && gs.hand.p > 0))) &&
      gs.sh === 0 &&
      gs.blush === 0 &&
      gs.dy === 0 &&
      gs.dim === 1 &&
      (hp === 0 || (hp === 1 && rise === 0));

    const pal = this.#pal;
    const dots = new Dots();
    const pass: Pass = settled ? "dynamic" : "all";
    portrait.emit(fr, pal, dots, pass);

    // the token: face-on, pressed, turning flat, flat; it tilts to the pointer while face-on
    const T = R.token;
    const td = T.d;
    const p = this.#pointerMap(fit);
    const fl = pj.flip;
    const ptx =
      p !== null && !still
        ? clamp((p[0] - T.x) / (td * 6), -1, 1)
        : still
          ? 0
          : noise1(t / 2600, 7) * 0.25;
    const pty =
      p !== null && !still
        ? clamp((p[1] - T.y) / (td * 6), -1, 1)
        : still
          ? 0
          : noise1(t / 3100, 8) * 0.2;
    const float = still ? 0 : (Math.sin((t / 3400) * 6.2832) * td * 0.03 - td * 0.12) * (1 - fl);
    const placed: PlacedToken | null = this.#token.place(T.x, T.y, td, -float, {
      flip: fl,
      press: still ? 0 : pj.press,
      tiltX: ptx * (1 - fl),
      tiltY: pty * (1 - fl),
    });

    const actors = G !== null && gs.actors !== null && !still;
    // the beam: the sky's own dots, from the token up into her (under her)
    const base = placed?.base ?? null;
    const beam: number[] = [];
    if (base !== null) {
      const sc = beamScreen(fit);
      const screen: BeamScreen = { pitch: sc.pitch / fit.s, rmax: sc.rmax / fit.s };
      const lift = MERGE * meta.k;
      const top = R.beam.top;
      drawBeam(
        beam,
        base,
        {
          // on the bust the beam rises to the top of her cut; on the wide drawing to her own
          yAt: top !== null ? () => top : (x) => portrait.ycutAt(x) - lift,
          left: R.beam.left,
          right: R.beam.right,
        },
        screen,
        pj.cone,
        t,
        still,
      );
    }
    // the whistle's notes: the clouds' white dots (the beam's ink), over her
    const notes: number[] = [];
    const notesInk: number[] = [];
    if (actors && G !== null && gs.actors === "notes")
      drawNotes(
        notes,
        notesInk,
        G.age,
        Math.round(G.start / STEP_MS),
        portrait.mouthPoint,
        gust,
        this.#keepRects(fit),
        (x, y) => portrait.lightAt(x, y),
      );
    const coneMoves = !still && pj.cone > 0;
    const sig =
      (dots.hash ^
        (coneMoves || actors ? t : 0) ^
        ((placed?.n ?? -2) * 7919) ^
        (settled ? 1 : 2)) >>>
      0;
    if (!force && sig === this.#lastSig) return;
    this.#lastSig = sig;

    const ctx = this.#o.canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.#o.canvas.width, this.#o.canvas.height);
    // her dots and her beam's are stamped in device px (k2-stamp.ts)
    this.#stamper.build(this.#styles(pal));
    const { k, ox, oy } = this.#device(fit);
    // asleep the beam and the token dim with her
    const light = mf?.light ?? 1;
    this.#stamper.stampInk(ctx, "beam", beam, k, ox, oy, light);

    // her: the settled frame's cached dots and this frame's changes, or every dot
    if (settled) {
      const cache = this.#cached(portrait, fr, fit, pal);
      if (cache !== null) ctx.drawImage(cache, 0, 0);
      this.#stamper.stamp(ctx, dots, INKS, k, ox, oy);
    } else this.#stamper.stamp(ctx, dots, INKS, k, ox, oy + gs.dy * k, gs.dim);
    this.#stamper.stampInk(ctx, "beam", notes, k, ox, oy);
    this.#stamper.stampInk(ctx, "ink", notesInk, k, ox, oy);
    this.#toMap(ctx, fit);

    // the gestures' actors: the blow's cloud and puff, the bird (authored on the wide frame)
    if (actors && G !== null && gs.actors !== "notes") {
      ctx.translate(-sx, -sy);
      const keep: KeepRect[] = this.#keepRects(fit).map(([a, b, c, d, m]) => [
        a + sx,
        b + sy,
        c + sx,
        d + sy,
        m,
      ]);
      const out = actorPaths();
      const g = gs.fade;
      const mouth: readonly [number, number] = [
        portrait.mouthPoint[0] + sx,
        portrait.mouthPoint[1] + sy,
      ];
      const light2 = (x: number, y: number): boolean => portrait.lightAt(x - sx, y - sy);
      if (gs.actors === "cloud") {
        drawCloud(g, G.age, mouth, keep, out);
        drawPuff(g, G.age, mouth, keep, light2, out);
      } else if (gs.actors === "bird") {
        const b = birdState(G.age);
        if (b !== null)
          drawBird(
            b,
            g,
            Math.floor(t / STEP_MS),
            keep,
            (x, y) => portrait.lightAt(x - sx, y - sy, true),
            out,
          );
      }
      ctx.globalAlpha = CLOUD_ALPHA[this.#dark ? "dark" : "light"];
      ctx.fillStyle = pal.white;
      ctx.fill(out.cloud);
      ctx.globalAlpha = this.#dark ? 0.9 : 0.96;
      ctx.fill(out.puff);
      ctx.globalAlpha = 1;
      ctx.fillStyle = pal.ink;
      ctx.fill(out.puffInk);
      ctx.fill(out.ink);
      ctx.fillStyle = pal.white;
      ctx.globalAlpha = this.#dark ? 0.94 : 1;
      ctx.fill(out.white);
      ctx.globalAlpha = 1;
      ctx.translate(sx, sy);
    }
    if (placed !== null) {
      if (light < 1) ctx.globalAlpha = light;
      this.#token.paint(ctx, placed);
      ctx.globalAlpha = 1;
    }
  }

  /** Her settled frame's unchanging dots, drawn once per layout, theme, rig, emotion and hover. */
  #cached(portrait: Portrait, fr: PortraitFrame, fit: Fit, pal: Palette): Scratch | null {
    const R = fit.rig;
    const key = [R.drawing, R.palm, this.#dark, fr.hp, fit.s, fit.ox, fit.oy, this.#mood?.to ?? ""]
      .map(String)
      .join("|");
    if (this.#cache?.key === key) return this.#cache.canvas;
    const cv = scratchCanvas(this.#o.canvas.width, this.#o.canvas.height);
    const ctx = context2dOf(cv);
    if (ctx === null) return null;
    const d = new Dots();
    portrait.emit(fr, pal, d, "static");
    const { k, ox, oy } = this.#device(fit);
    this.#stamper.stamp(ctx, d, INKS, k, ox, oy);
    this.#cache = { key, canvas: cv };
    return cv;
  }

  /** Her transform in the canvas's device px: device = o + k * map. */
  #device(fit: Fit): {
    readonly k: number;
    readonly ox: number;
    readonly oy: number;
  } {
    const d = this.#dpr;
    return {
      k: d * fit.s,
      ox: d * (fit.ox - this.#box.x),
      oy: d * (fit.oy - this.#box.y),
    };
  }

  /** The stamps' inks: hers, and the beam's by the ground under her. */
  #styles(pal: Palette): Record<string, InkStyle> {
    return {
      ...inkStyles(pal),
      beam: beamInk(this.#ground, this.#dark, pal),
    };
  }

  /** The pointer on her map, or null when it is not over the window. */
  #pointerMap(fit: Fit): readonly [number, number] | null {
    const p = this.#pointer;
    if (p === null) return null;
    const h = this.#o.host.getBoundingClientRect();
    return [(p.x - h.left - fit.ox) / fit.s, (p.y - h.top - fit.oy) / fit.s];
  }

  /**
   * Where she looks, strongest first: the pointer while it hovers her; an emotion's own look; an
   * action's or the wake's own target (unless the pointer is moving): the blow's cloud, the bird, up
   * to the side while she whistles; a moving pointer; a glance away (the composer, a cloud, the
   * birds); and by default you.
   */
  #gaze(
    fit: Fit,
    gs: FaceState,
    hp: number,
    away: GlanceAway | null,
    glance: GazeTarget,
    meta: K2Meta,
    look: GazeTarget | null,
  ): GazeTarget {
    const still = this.#o.still;
    const p = still ? null : this.#pointerMap(fit);
    const moving = p !== null && this.#now() - this.#pointerAt < POINTER_FRESH;
    if (p !== null && (this.#hover || hp > 0)) return { x: p[0], y: p[1] };
    if (look !== null) return look;
    const k = meta.k;
    const own = gs.aside ? { x: glance.x + 100 * k, y: glance.y - 190 * k } : gs.gaze;
    if (own !== null && hp < 0.5 && !moving) return own;
    if (moving && p !== null) return { x: p[0], y: p[1] };
    if (away !== null) {
      const L = fit.rig.looks;
      const [x, y] =
        away.target === "composer" ? meta.rest : away.target === "cloud" ? L.cloud : L.birds;
      return { x, y };
    }
    return glance;
  }

  /**
   * An emotion's look on her map: you, the composer (the element when the host names it), up to
   * the side, the work, away. The points are the app drawing's (`APP_LOOKS`), taken from where she
   * looks at you, so the wide drawing finds them round its own glance.
   */
  #moodLook(
    fit: Fit,
    look: MoodLook | undefined,
    glance: GazeTarget,
    meta: K2Meta,
  ): GazeTarget | null {
    if (look === undefined || look === "free") return null;
    if (look === "you") return glance;
    if (look === "composer") {
      const el = this.#o.composer?.() ?? null;
      if (el !== null) {
        const r = el.getBoundingClientRect();
        const h = this.#o.host.getBoundingClientRect();
        if (r.width > 0 && r.height > 0)
          return {
            x: (r.left + r.width / 2 - h.left - fit.ox) / fit.s,
            y: (r.top + r.height / 2 - h.top - fit.oy) / fit.s,
          };
      }
    }
    const [x, y] = APP_LOOKS[look];
    const [yx, yy] = APP_LOOKS.you;
    return { x: glance.x + (x - yx) * meta.k, y: glance.y + (y - yy) * meta.k };
  }

  /** The host's blocks on her map, each with its air (the actors keep out). */
  #keepRects(fit: Fit): KeepRect[] {
    return this.#keep.map((b, i) => [
      (b.left - fit.ox) / fit.s,
      (b.top - fit.oy) / fit.s,
      (b.right - fit.ox) / fit.s,
      (b.bottom - fit.oy) / fit.s,
      AIR[Math.min(i, AIR.length - 1)] ?? 20,
    ]);
  }
}
