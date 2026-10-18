/**
 * K2's canvas (`docs/design/R3-MINIMAL.md section 10`): one canvas in her host for her portrait,
 * the beam of her token (the sky's own halftone dots), the token and the gestures' actors.
 *
 * - Her clock runs only while she is on screen and the window is shown (`RunGate`). It steps at
 *   30 fps while an episode plays (the wake, the token toggle's open, the open and close episodes
 *   with the coin's turn, a gesture) and at 10 fps otherwise (`frameTime`, the same numbers as the
 *   web app's K2); her idle life (the blink, the gaze and its glances, the look at you, the wind,
 *   the beam's life, the hover, an emotion other than the waking one) reads the idle step even
 *   inside an episode, so idle looks as it did. A frame never advances her clock by more than
 *   250 ms, so a stall or a hidden window resumes where it stopped. Each frame is a pure function
 *   of that clock and the inputs (the hover, the clicks, the pointer, the emotion), so the wake and
 *   the gestures play the same on every launch.
 * - Her dots in a settled frame (no dissolve, no gesture, no wake) that no wind, blink or mouth
 *   can change are emitted once and kept as a pixel layer; only the hair in the wind, the eyes,
 *   the face marks and the strands are emitted per frame. Every dot is blended in memory and put
 *   on the canvas in one call (`k2-stamp.ts`), a 30 fps frame that repeats its idle step reuses
 *   its dots, beam and pixels, and a frame whose dots, light and coin did not change is never
 *   repainted. The ratio is capped at 2.
 * - The emotion (`setEmotion`) is her face (`k2-poses.ts`): a change dissolves on her clock; asleep
 *   and settled nothing of her moves, so she is painted once and left still, the beam and the token
 *   dimmed with her.
 * - Idle, by default she looks at you and now and then glances away; her idle pool (the blow, the
 *   bird, the blush, the whistle, the hum) plays one action at a time; a long hover makes her
 *   blush, a click (`poke`) makes her giggle.
 * - Out of sleep into idle she wakes again on her clock (the re-wake: she rises, yawns behind her
 *   hand, rubs an eye, blinks, looks at you and smiles); into any other emotion her head simply
 *   comes up, so a working turn never waits on a yawn.
 * - The episodes (`k2-time.ts`): `open` assembles her from the token when the host shows her
 *   (the Vex sidebar's dock from the welcome, or the column shown again); `setClosed` closes her
 *   into the token and opens her again.
 * - The token toggle (`setTokenOnly`, the owner 2026-10-17, as on the web app): a press closes
 *   her back into the token (her assembly backwards, the beam falling, the coin turning upright,
 *   face on), the next opens her again (the wake replayed from the press: asleep, the yawn, the
 *   rub, the blinks, the smile). While she is not shown her gestures, glances and hover face hold;
 *   the upright coin rests (no bob, no tilt) and her dots are not drawn. `onToken` reports each
 *   state (`K2TokenState`). Under the still frame it swaps at once between the two still states.
 *   Face-on, the coin lifts a little under the pointer; asleep it dims with her light.
 * - When she comes back (the wake, an open, the re-wake, an emotion settling back to idle, an idle
 *   action ending, the window shown again after 10 s away) she holds her eyes on you a moment, now
 *   and then with the soft smile or a slow blink (`lookAtYou`).
 * - The still frame (reduced motion, Save-Data, or asked by the host) paints once (awake, the
 *   token flat, the beam on and still, no wind, no gestures, the emotion settled; an open shows
 *   her at once, a close leaves the token alone) and repaints only on a hover, a theme, a ground,
 *   an emotion, an episode or a layout change.
 *
 * The host places her (`k2-rig.ts`, `setFit`); her map's px are drawn through one transform
 * (host = o + s * map). The maps and the token's sprites load from the renderer's own origin
 * (`k2-assets.ts`).
 */
import { RunGate } from "../../../lib/motion/run-gate.js";
import { loadMap, loadMeta } from "./k2-assets.js";
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
import {
  MOOD_DISSOLVE,
  MOOD_MAPS,
  type MoodChange,
  type MoodFace,
  type MoodLook,
  moodFace,
  SLEEP,
  WAKE_FACE,
} from "./k2-poses.js";
import { noise1 } from "./k2-rand.js";
import {
  APP_LOOKS,
  type Box,
  beamScreen,
  canvasBox,
  type Fit,
  type K2Drawing,
  STAND_BOB,
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
  AWAKE,
  birdState,
  blinkAt,
  CLOSE_MS,
  canGiggle,
  clamp,
  type Episode,
  episodeBusy,
  episodeProjector,
  type FaceState,
  frameTime,
  type GazeTarget,
  GestureChain,
  type GestureName,
  type GlanceAway,
  GlanceChain,
  gestureAt,
  gestureState,
  gustAt,
  hoverProgress,
  idleTime,
  inEpisode,
  LONG_HOVER,
  LOOK,
  type LookAtYou,
  lookAtYou,
  type MapName,
  OPEN_LEAD,
  OPEN_MS,
  type Projector,
  projector,
  ramp,
  STEP_MS,
  slowBlink,
  smirking,
  type WakeMode,
  wakeEnd,
  wakeState,
} from "./k2-time.js";
import { liftOf, type PlacedToken, TokenSprite } from "./k2-token.js";

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

/**
 * The token toggle's states: `shown` (projected from the flat token), `closing` (dissolving back
 * into it, the coin turning upright), `token` (the hologram off, the coin upright at rest) and
 * `opening` (the wake from the token, or the open episode).
 */
export type K2TokenState = "shown" | "closing" | "token" | "opening";

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
  /** The open episode plays from the token as she first shows (never with the wake). */
  readonly open?: boolean;
  /** She starts closed: the token alone, face-on (`setClosed(false)` opens her). */
  readonly closed?: boolean;
  /** Start with the hologram off: the coin upright, no episode, no wake (`setTokenOnly`). */
  readonly tokenOnly?: boolean;
  /** Each change of the token toggle's state (an episode starting or settling). */
  readonly onToken?: ((state: K2TokenState) => void) | undefined;
}

/** Her returns kept for the look at you chain (the latest one decides). */
const RETURNS_KEPT = 8;

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

/** Everything a frame's dots are emitted from (`Portrait.emit`): the same key, the same dots. */
function dotsKey(fr: PortraitFrame, pass: Pass, epoch: number): string {
  const f = fr.face;
  const h = f.hand;
  const a = f.from;
  const ah = a?.hand;
  return [
    epoch,
    pass,
    fr.t,
    fr.still,
    fr.dark,
    fr.hp,
    fr.rise,
    fr.gp,
    fr.smirk,
    fr.gust,
    fr.sway,
    fr.lid,
    fr.eyes,
    fr.gaze.x,
    fr.gaze.y,
    fr.asm,
    fr.held,
    f.map,
    f.gp,
    h?.map,
    h?.rise,
    h?.di,
    h?.p,
    f.sh,
    f.eyes,
    f.mouth,
    f.blush,
    f.aside,
    f.sway,
    f.nose,
    f.lid,
    f.tear,
    f.dy,
    f.dim,
    f.fade,
    a?.map,
    ah?.map,
    ah?.rise,
    ah?.di,
    ah?.p,
  ].join("|");
}

/** One frame's state (`K2Engine.#frame`): what its paint commits and draws. */
interface K2Frame {
  /** The frame's time (30 fps in an episode) and its idle step (10 fps). */
  readonly t: number;
  readonly ti: number;
  /** An episode plays (the wake, an open, the close, a gesture): the loop paints at 30 fps. */
  readonly episode: boolean;
  readonly fit: Fit;
  readonly portrait: Portrait;
  /** The wake playing hands her over at `awakeAt`; it has (`woken`). */
  readonly awakeAt: number;
  readonly woken: boolean;
  readonly tokenState: K2TokenState;
  /** The close has settled: the coin upright and at rest. */
  readonly rest: boolean;
  readonly pj: Projector;
  readonly mf: MoodFace | null;
  readonly frozen: boolean;
  readonly still: boolean;
  /** The idle pool's hold, and when it began and ended (committed with the paint). */
  readonly hold: boolean;
  readonly holdAt: number;
  readonly unholdAt: number;
  readonly G: ActiveGesture | null;
  /** An idle action ended at this frame: a return (committed with the paint). */
  readonly ended: boolean;
  readonly gs: FaceState;
  readonly gust: number;
  readonly fr: PortraitFrame;
  readonly settled: boolean;
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
  /** Her settled frame's unchanging dots (emitted once per layout, theme, emotion and hover). */
  #cache: { key: string; dots: Dots } | null = null;
  /** The frame the loop computed to ask whether an episode plays (reused by its paint). */
  #pending: K2Frame | null = null;
  /** Bumped when what her dots come from changes outside a frame (a layout, the theme, a drawing). */
  #epoch = 0;
  /** The last frame's dots and the beam's, by what they were made from (a 30 fps frame often repeats them). */
  #dotsMemo: { key: string; dots: Dots } | null = null;
  #beamMemo: { key: string; dots: number[] } | null = null;
  /** What the frame last blended in memory was made of (the same again is put again, not blended). */
  #rasterKey = "";
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
  /** The emotion the host last asked for (a re-wake shows `waking` meanwhile). */
  #asked: K2Emotion | null = null;
  /** Her open or close episode (null: she stands as she is). */
  #episode: Episode | null = null;
  /** When she came back (her clock): each one starts a look at you. */
  readonly #returns: number[] = [];
  /** An idle action played in the last frame (its end is a return). */
  #lastG = false;
  /** The pointer is on the face-on coin, since when, and since when it left (her clock). */
  #overToken = false;
  #liftAt = -1;
  #unliftAt = -1;
  /** When the window was hidden (wall clock), -1 while it shows. */
  #hiddenAt = -1;
  /** The token toggle asked for: the hologram off, the coin upright (`setTokenOnly`, `setClosed`). */
  #want = false;
  /** How she opens once the toggle turns off: the wake from the token, or the open episode. */
  #reopen: "wake" | "episode" = "episode";
  /** When the wake playing began on her clock (0: the gate's), and a re-open's wake mode. */
  #wake0 = 0;
  #rewake: WakeMode | null = null;
  /** The toggle's state, and whether the host has heard the first one (after her first frame). */
  #tokenState: K2TokenState = "shown";
  #reported = false;
  /** The coin's poses were asked for and the answer is in (loaded, or failed: the coin stays flat). */
  #posesTried = false;

  constructor(o: K2EngineOptions) {
    this.#o = o;
    this.#dark = o.dark;
    this.#ground = o.ground;
    this.#pal = inks(o.dark);
    const f = o.force;
    const force = f === "blow" || f === "bird" || f === "blush" || f === "hum" ? f : null;
    this.#chain = new GestureChain(this.#awakeAt(), force);
    if (f === "giggle") this.#giggles.push(this.#awakeAt() + 1000);
    if (o.tokenOnly === true) {
      this.#want = true;
      this.#reopen = "wake";
      this.#episode = { kind: "close", at: -1e9 };
      this.#tokenState = "token";
    } else if (!o.wake) {
      if (o.closed === true) {
        this.#want = true;
        this.#episode = { kind: "close", at: -1e9 };
        this.#tokenState = "token";
      } else if (o.open === true) {
        this.#episode = { kind: "open", at: 0 };
        this.#return(OPEN_MS);
      }
    }
  }

  /* ---------------------------------------------------------------- the host's inputs */

  /** Where the host placed her, and its blocks the actors keep out of (host px). */
  setFit(fit: Fit, keep: readonly Box[] = []): void {
    const prev = this.#fit;
    this.#fit = fit;
    this.#keep = keep;
    this.#epoch++;
    this.#layout();
    if (prev?.rig.drawing !== fit.rig.drawing && this.#started)
      void this.#loadDrawing(fit.rig.drawing);
    this.#repaintIdle();
  }

  setDark(dark: boolean): void {
    if (dark === this.#dark) return;
    this.#dark = dark;
    this.#pal = inks(dark);
    this.#invalidate();
    this.#frozen = null;
    this.#repaintIdle();
  }

  setGround(ground: K2Ground): void {
    if (ground === this.#ground) return;
    this.#ground = ground;
    // the beam's ink changes: no blended frame of the old ground is put again
    this.#invalidate();
    this.#frozen = null;
    this.#repaintIdle();
  }

  setHover(on: boolean): void {
    if (on === this.#hover) return;
    this.#hover = on;
    const now = this.#now();
    if (on) this.#hoverAt = now;
    else {
      // a long hover, once it ends, makes her blush (not while she is the coin's)
      if (
        !this.#o.still &&
        !this.#want &&
        now - this.#hoverAt >= LONG_HOVER &&
        now >= this.#awakeAt()
      ) {
        this.#blushes.push(now);
        if (this.#blushes.length > 8) this.#blushes.shift();
      }
      this.#unhoverAt = now;
    }
    this.#repaintIdle();
  }

  /**
   * The agent's state as her face. The first emotion she starts in is settled at once (a wake
   * plays from now); every later change dissolves on her clock. Out of sleep into idle she wakes
   * again (the re-wake), then looks at you; back to idle from any other emotion she looks at you
   * once the dissolve is done.
   */
  setEmotion(emotion: K2Emotion): void {
    const was = this.#asked;
    if (was === emotion) return;
    this.#asked = emotion;
    const cur = this.#mood;
    const now = this.#now();
    const rewake = was === "sleeping" && emotion === "idle" && cur !== null && !this.#o.still;
    const to: K2Emotion = rewake ? "waking" : emotion;
    if (cur?.to === to) return;
    this.#mood = {
      from: cur?.to ?? to,
      to,
      at: cur === null && to !== "waking" ? -1e9 : now,
    };
    if (rewake) this.#return(now + WAKE_FACE);
    else if (emotion === "idle" && cur !== null) this.#return(now + MOOD_DISSOLVE);
    this.#repaintIdle();
  }

  /**
   * Closes her into the token (the close episode) or opens her from it (the open episode, then a
   * look at you). Under the still frame the change is instant.
   */
  setClosed(closed: boolean): void {
    this.#toggle(closed, "episode");
  }

  /**
   * The token toggle: `true` closes her back into the token (the coin upright), `false` opens her
   * again (the wake from the token). A close asked for while she opens starts at once from where
   * she is; an open asked for while she closes starts when the close has settled. Asked before her
   * first frame she simply starts there, with no episode. Under the still frame the swap is
   * instant.
   */
  setTokenOnly(on: boolean): void {
    this.#toggle(on, "wake");
  }

  #toggle(on: boolean, reopen: "wake" | "episode"): void {
    if (on === this.#want) return;
    this.#want = on;
    this.#reopen = reopen;
    if (!this.#started) {
      this.#episode = on ? { kind: "close", at: -1e9 } : null;
      this.#tokenState = on ? "token" : "shown";
      return;
    }
    this.#frozen = null;
    this.#lastSig = -1;
    // the coin's turns need its poses; until they are in, the toggle waits for them
    void this.#token.loadPoses().then(() => {
      this.#posesTried = true;
      if (this.#stopped) return;
      this.#advance(this.#now());
      this.#repaintIdle();
    });
    this.#repaintIdle();
  }

  /** A click or a tap on her: a giggle, once she is awake, idle and its cooldown is over. */
  poke(): void {
    if (this.#o.still) return;
    // the coin alone has no one to giggle
    if (this.#episode?.kind === "close") return;
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
    const coin = fit.rig.token.d * fit.rig.stand.scale * fit.s;
    const density = (Math.min(window.devicePixelRatio || 1, DPR_CAP) * coin) / TOKEN_SHEET.td;
    // the coin's poses for the wake, the episodes and the upright coin (a still open shows her
    // whole, flat coin)
    const poses = this.#o.wake || this.#want || (this.#o.open === true && !this.#o.still);
    await Promise.all([this.#loadDrawing(fit.rig.drawing), this.#token.load(poses, density)]);
    if (this.#stopped) return;
    if (poses) this.#posesTried = true;
    this.#started = true;
    this.#paint(0, true);
    this.#o.host.dataset["vexK2Ready"] = "";
    // the toggle's state she starts in (later changes report as they happen)
    this.#reported = true;
    this.#o.onToken?.(this.#tokenState);
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
      this.#invalidate();
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
          this.#epoch++;
        } catch {
          // that emotion stays on the base drawing
        }
      }),
    );
    if (this.#stopped || names.length === 0) return;
    this.#invalidate();
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
      this.#epoch++;
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
      this.#invalidate();
    this.#box = box;
    this.#dpr = dpr;
    this.#lastSig = -1;
    this.#frozen = null;
  }

  /** Drops her cached dots: the settled frame's, and every memo of a frame's (`#epoch`). */
  #invalidate(): void {
    this.#cache = null;
    this.#epoch++;
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
    return this.#wake0 + wakeEnd(this.#mode());
  }

  /** The wake playing: a re-open's, else the gate's (none when she starts awake or as a coin). */
  #mode(): WakeMode {
    if (this.#o.still) return "none";
    if (this.#rewake !== null) return this.#rewake;
    return this.#o.wake && this.#o.tokenOnly !== true ? "full" : "none";
  }

  /* ---------------------------------------------------------------- the token toggle */

  /** The projector she stands on at t while she is not closed: a wake's, an open's, or awake. */
  #shownProjector(t: number): Projector {
    const mode = this.#mode();
    const ep = this.#episode;
    if (ep?.kind === "open" && t >= this.#wake0 + wakeEnd(mode))
      return episodeProjector(ep, t, this.#o.still);
    return projector(t - this.#wake0, mode);
  }

  /** Starts the episode the toggle asks for, when it can start (at t, her clock). */
  #advance(t: number): void {
    const still = this.#o.still;
    const ep = this.#episode;
    if (this.#want && ep?.kind !== "close") {
      this.#episode = { kind: "close", at: t, from: still ? AWAKE : this.#shownProjector(t) };
    } else if (!this.#want && ep?.kind === "close") {
      if (!still && t - ep.at < CLOSE_MS) return;
      if (!still && !this.#token.posed && !this.#posesTried) return;
      if (this.#reopen === "wake" && !still) {
        // the wake replayed from the press, then a look at you
        this.#episode = null;
        this.#rewake = "full";
        this.#wake0 = t - OPEN_LEAD;
        this.#return(this.#wake0 + wakeEnd("full"));
      } else if (this.#reopen === "wake") this.#episode = null;
      else {
        this.#episode = { kind: "open", at: t };
        this.#return(t + OPEN_MS);
      }
    } else return;
    this.#invalidate();
    this.#frozen = null;
    this.#lastSig = -1;
  }

  /** The token toggle's state at t (awakeAt: the wake playing hands her over then). */
  #tokenAt(t: number, awakeAt: number): K2TokenState {
    const ep = this.#episode;
    if (ep?.kind === "close")
      return this.#o.still || t - ep.at >= CLOSE_MS ? "token" : "closing";
    if (this.#rewake !== null && t < awakeAt) return "opening";
    return ep?.kind === "open" && t >= awakeAt && episodeBusy(ep, t) ? "opening" : "shown";
  }

  /** She came back at `at` (her clock): a look at you starts then. */
  #return(at: number): void {
    this.#returns.push(at);
    if (this.#returns.length > RETURNS_KEPT) this.#returns.shift();
  }

  #listen(): void {
    const signal = this.#ac.signal;
    // the window shown again after 10 s or more away: she looks at you
    document.addEventListener(
      "visibilitychange",
      () => {
        const wall = performance.now();
        if (document.hidden) {
          this.#hiddenAt = wall;
          return;
        }
        if (this.#hiddenAt >= 0 && wall - this.#hiddenAt >= LOOK.away) this.#return(this.#now());
        this.#hiddenAt = -1;
      },
      { signal },
    );
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
      // 30 fps while an episode plays, the idle step (10 fps) otherwise
      this.#pending = null;
      const t = frameTime(this.#clock, this.#stepT, this.#episodeAt);
      if (t !== null) {
        this.#stepT = t;
        this.#paint(t, false);
      }
      this.#pending = null;
    };
    this.#raf = requestAnimationFrame(tick);
  }

  /** Whether an episode plays at t (the frame it computes is kept for the paint that follows). */
  readonly #episodeAt = (t: number): boolean => {
    const f = this.#frame(t);
    this.#pending = f;
    return f?.episode === true;
  };

  /** A paint outside the loop: a still frame, or a change while she rests off screen. */
  #repaintIdle(): void {
    if (!this.#started) return;
    if (this.#o.still || this.#gate?.running !== true)
      this.#paint(this.#o.still ? 0 : Math.max(0, this.#stepT), true);
  }

  /* ---------------------------------------------------------------- one frame */

  /**
   * One frame's state at t, written to nothing but the toggle (an episode it starts here) and the
   * glances' cache: an episode (the wake, an open, the close, a gesture) reads t, her idle life
   * (the blink, the gaze, the glances, the look at you, the wind, the beam's life, the hover, an
   * emotion other than the waking one) reads t's idle step.
   */
  #frame(t: number): K2Frame | null {
    const fit = this.#fit;
    if (fit === null) return null;
    const portrait = this.#portraits[fit.rig.drawing];
    if (portrait === undefined || !this.#token.ready) return null;
    const meta = portrait.meta;
    const R = fit.rig;
    // the token toggle: an episode it asked for starts once the coin's poses are in
    if (
      this.#want !== (this.#episode?.kind === "close") &&
      (this.#o.still || this.#token.posed || this.#posesTried)
    )
      this.#advance(t);
    const ti = idleTime(t);
    const mode = this.#mode();
    const awakeAt = this.#wake0 + wakeEnd(mode);
    const glance = { x: meta.glance[0], y: meta.glance[1] };
    // closed (or closing) she is the coin's: her face, her gestures and her hover hold
    const ep = this.#episode;
    const veiled = ep?.kind === "close";
    const rest = ep?.kind === "close" && (this.#o.still || t - ep.at >= CLOSE_MS);
    // the wake's projector (the gate's, or a re-open's), then an open episode's, or the close's
    const opened = ep?.kind === "open" && t >= awakeAt ? ep : null;
    const pj =
      veiled || opened !== null
        ? episodeProjector(ep, t, this.#o.still)
        : projector(t - this.#wake0, mode);
    const opening = episodeBusy(opened, t);
    const busy = veiled || opening;
    const WS = veiled ? null : wakeState(t - this.#wake0, mode, meta.pitch, meta.k, glance);
    // the emotion, after the wake: one set while she woke dissolves in from her waking smile when
    // the wake hands her over (a wake already played is not played again)
    const mood: MoodChange | null =
      this.#mood !== null && awakeAt > 0 && this.#mood.at < awakeAt
        ? { from: "idle", to: this.#mood.to === "waking" ? "idle" : this.#mood.to, at: awakeAt }
        : this.#mood;
    // an emotion is her idle life (the idle step); the waking emotion's beats are an episode (t)
    const mf: MoodFace | null =
      WS === null && mood !== null
        ? moodFace(mood, mood.to === "waking" ? t : ti, {
            rise: meta.rise,
            pitch: meta.pitch,
            k: meta.k,
            glance,
            still: this.#o.still,
          })
        : null;
    // asleep and settled nothing of her moves: she is painted as a still frame (an episode
    // playing over her sleep keeps the frame live)
    const frozen = mf?.frozen === true && !busy;
    const still = this.#o.still || frozen;

    // what holds the idle pool back: a hover, an episode, a wake, any emotion but idle (settled);
    // a slot due meanwhile is skipped, never shown half way
    const hold = this.#hover || busy || t < awakeAt || (mf !== null && !mf.gestures);
    const changed = hold !== this.#hold;
    const holdAt = changed && hold ? t : this.#holdAt;
    const unholdAt = changed && !hold ? t : this.#unholdAt;
    const G: ActiveGesture | null =
      WS === null && !busy && (mf === null || mf.gestures)
        ? gestureAt(this.#chain, {
            t,
            allowed: still ? [] : this.#gestures ? ALL : MAP_FREE,
            awakeAt,
            giggles: this.#giggles,
            blushes: this.#blushes,
            stillSince: this.#pointerAt,
            hold,
            holdAge: hold ? t - holdAt : -1,
            unholdAge: !hold && unholdAt >= 0 ? t - unholdAt : -1,
          })
        : null;
    // an idle action that ends is a return: she looks at you from this frame
    const ended = this.#lastG && G === null && !hold && WS === null;
    const returns = ended ? [...this.#returns, t] : this.#returns;
    let gs: FaceState = WS ?? (G !== null || mf === null ? gestureState(G) : mf.face);
    const giggle = G !== null && G.name === "giggle" ? G.age : -1;
    const gigW = giggle >= 0 ? ramp(giggle, 0, 150) * (1 - ramp(giggle, 1800, 2000)) : 0;
    let { hp, rp } = hoverProgress(
      this.#hover,
      this.#hover ? ti - this.#hoverAt : -1,
      !this.#hover && this.#unhoverAt >= 0 ? ti - this.#unhoverAt : -1,
      still,
    );
    // no hover while she wakes or an episode plays, nor in an emotion that holds her face
    if (t < awakeAt || busy || (mf !== null && !mf.gestures)) {
      hp = 0;
      rp = 0;
    }
    hp *= 1 - gigW;
    rp *= 1 - gigW;
    // by default she looks at you; now and then she glances away (never in an action or a hover)
    if (this.#glances?.awakeAt !== awakeAt)
      this.#glances = { awakeAt, chain: new GlanceChain(awakeAt) };
    // when she comes back she holds her eyes on you first (a moving pointer wins over it)
    const free = !still && !busy && G === null && WS === null && !this.#hover && hp === 0;
    const moving = this.#pointer !== null && this.#now() - this.#pointerAt < POINTER_FRESH;
    const atYou: LookAtYou | null =
      free && !moving && (mf === null || mf.gestures) ? lookAtYou(ti, returns) : null;
    if (atYou?.smile === true) gs = { ...gs, eyes: "soft", mouth: "smile" };
    const away: GlanceAway | null = free && atYou === null ? this.#glances.chain.at(ti) : null;
    const rise = Math.round((1 - rp) ** 3 * meta.rise);
    const gp = gs.gp * (1 - hp);
    const smirk =
      G === null && WS === null && !veiled && !still && !this.#hover && hp === 0 && smirking(ti);
    const gust = still ? 0 : gustAt(ti);
    const em = gs.eyes !== null && hp < 0.5 && !still ? gs.eyes : null;
    let lid = still ? 0 : em === "soft" ? Math.max(0.22, blinkAt(ti)) : blinkAt(ti);
    if (WS !== null && WS.lid > 0) lid = Math.max(lid, WS.lid);
    if (atYou?.blink === true) lid = Math.max(lid, slowBlink(atYou));
    // the gestures look at their actors on the wide drawing's frame (`k2-rig.ts` shift)
    const [sx, sy] = R.shift;
    const seen =
      G !== null && gs.gaze !== null
        ? { ...gs, gaze: { x: gs.gaze.x - sx, y: gs.gaze.y - sy } }
        : gs;
    const look = this.#moodLook(fit, G === null ? mf?.look : undefined, glance, meta);
    const gaze = this.#gaze(fit, seen, hp, away, glance, meta, look);
    const fr: PortraitFrame = {
      // the wind and the strands live on the idle step
      t: ti,
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
    // an emotion whose dissolve is done and whose hand is up settles like her own face; a blush
    // draws no other drawing (its cells, like the eyes and the marks, are all of the dynamic pass),
    // so she settles under it too
    const moodSettled = mf !== null && G === null && mf.settled;
    const settled =
      pj.asm >= 1 &&
      (moodSettled || (gp === 0 && !(gs.hand !== null && gs.hand.p > 0))) &&
      gs.sh === 0 &&
      gs.dy === 0 &&
      gs.dim === 1 &&
      (hp === 0 || (hp === 1 && rise === 0));
    return {
      t,
      ti,
      episode: inEpisode({
        still: this.#o.still,
        waking: (!veiled && t < awakeAt) || mf?.wake === true || opening,
        closing: veiled && !rest,
        gesture: G !== null,
      }),
      fit,
      portrait,
      awakeAt,
      woken: mode !== "none" && t >= awakeAt,
      tokenState: this.#tokenAt(t, awakeAt),
      rest,
      pj,
      mf,
      frozen,
      still,
      hold,
      holdAt,
      unholdAt,
      G,
      ended,
      gs,
      gust,
      fr,
      settled,
    };
  }

  /** Paints the frame at t: its state (`#frame`), its callbacks, returns and holds, then its pixels. */
  #paint(t: number, force: boolean): void {
    const pending = this.#pending;
    this.#pending = null;
    const f = pending !== null && pending.t === t ? pending : this.#frame(t);
    if (f === null) return;
    if (f.woken && !this.#woken) {
      this.#woken = true;
      // a re-open's wake left its own return; the gate's wake tells its host
      if (this.#rewake === null) this.#return(f.awakeAt);
      if (this.#o.wake) this.#o.onWoken();
    }
    if (f.tokenState !== this.#tokenState) {
      this.#tokenState = f.tokenState;
      if (this.#reported) this.#o.onToken?.(f.tokenState);
    }
    if (f.ended) this.#return(t);
    this.#lastG = f.G !== null;
    this.#hold = f.hold;
    this.#holdAt = f.holdAt;
    this.#unholdAt = f.unholdAt;
    if (!force && f.frozen) {
      const fit = f.fit;
      const R = fit.rig;
      const key = [R.drawing, R.palm, fit.s, fit.ox, fit.oy, this.#dark, this.#ground, this.#mood?.to]
        .map(String)
        .join("|");
      if (key === this.#frozen) return;
      this.#frozen = key;
    } else this.#frozen = null;
    this.#draw(f, force);
  }

  /** A frame's pixels: her dots and her beam's (blended in memory), the actors and the token. */
  #draw(f: K2Frame, force: boolean): void {
    const { fit, portrait, t, ti, pj, gs, G, fr, settled, still, mf, rest } = f;
    const meta = portrait.meta;
    const R = fit.rig;
    const pal = this.#pal;
    const pass: Pass = settled ? "dynamic" : "all";
    // the same inputs emit the same dots (a 30 fps frame often repeats its idle step's)
    const dk = `${dotsKey(fr, pass, this.#epoch)}|${pj.asm > 0}`;
    let dots: Dots;
    if (this.#dotsMemo?.key === dk) dots = this.#dotsMemo.dots;
    else {
      dots = new Dots();
      // closed into the token there is nothing of her to draw
      if (pj.asm > 0) portrait.emit(fr, pal, dots, pass);
      this.#dotsMemo = { key: dk, dots };
    }

    // the token: face-on, pressed, turning flat, flat; it tilts to the pointer while face-on in a
    // wake or an open; upright after a close it rests (no bob, no tilt)
    const T = R.token;
    const p = this.#pointerMap(fit);
    const fl = pj.flip;
    // face on, the coin takes its upright size (the welcome's is larger: `Rig.stand`) and turns
    // back to the flat token's size as it lies down
    const td = T.d * (1 + (R.stand.scale - 1) * (1 - fl));
    const calm = still || rest;
    const ptx =
      p !== null && !calm
        ? clamp((p[0] - T.x) / (td * 6), -1, 1)
        : calm
          ? 0
          : noise1(t / 2600, 7) * 0.25;
    const pty =
      p !== null && !calm
        ? clamp((p[1] - T.y) / (td * 6), -1, 1)
        : calm
          ? 0
          : noise1(t / 3100, 8) * 0.2;
    const bob = calm ? 0 : Math.sin((t / 3400) * 6.2832) * td * STAND_BOB;
    const float = (bob - td * R.stand.drop) * (1 - fl);
    // face-on, the coin lifts a little under the pointer
    const over =
      p !== null && !still && fl < 0.5 && Math.hypot(p[0] - T.x, p[1] - (T.y - float)) < td * 0.55;
    if (over !== this.#overToken) {
      this.#overToken = over;
      if (over) this.#liftAt = t;
      else this.#unliftAt = t;
    }
    const lift = still
      ? 0
      : liftOf(over, t - this.#liftAt, this.#unliftAt >= 0 ? t - this.#unliftAt : -1) * (1 - fl);
    const placed: PlacedToken | null = this.#token.place(T.x, T.y, td, -float, {
      flip: fl,
      press: still ? 0 : pj.press,
      tiltX: ptx * (1 - fl),
      tiltY: pty * (1 - fl),
      lift,
    });

    const actors = G !== null && gs.actors !== null && !still;
    // the beam: the sky's own dots, from the token up into her (under her); its life on the idle
    // step, its growth (the wake, the close) on the frame's time
    const base = placed?.base ?? null;
    const bk =
      base === null
        ? ""
        : `${this.#epoch}|${ti}|${pj.cone}|${still}|${base.cx}|${base.cy}|${base.rx}|${base.ry}`;
    const memo = this.#beamMemo?.key === bk ? this.#beamMemo.dots : null;
    const beam: number[] = memo ?? [];
    if (base !== null && memo === null) {
      const sc = beamScreen(fit);
      const screen: BeamScreen = { pitch: sc.pitch / fit.s, rmax: sc.rmax / fit.s };
      const merge = MERGE * meta.k;
      const top = R.beam.top;
      drawBeam(
        beam,
        base,
        {
          // on the bust the beam rises to the top of her cut; on the wide drawing to her own
          yAt: top !== null ? () => top : (x) => portrait.ycutAt(x) - merge,
          left: R.beam.left,
          right: R.beam.right,
        },
        screen,
        pj.cone,
        ti,
        still,
      );
      this.#beamMemo = { key: bk, dots: beam };
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
        f.gust,
        this.#keepRects(fit),
        (x, y) => portrait.lightAt(x, y),
      );
    const coneMoves = !still && pj.cone > 0;
    let sig = dots.hash ^ (settled ? 1 : 2);
    if (coneMoves) sig = Math.imul(sig ^ ti, 16777619) ^ Math.round(pj.cone * 65536);
    if (actors) sig = Math.imul(sig ^ t, 16777619);
    // her light and her rows down (the wake's rise and brightening, a sleeping dim)
    sig = Math.imul(sig ^ Math.round(gs.dim * 4096), 16777619);
    sig = Math.imul(sig ^ gs.dy, 16777619);
    sig = Math.imul(sig ^ Math.round((mf?.light ?? 1) * 4096), 16777619);
    // the coin's pose and place (it bobs, lifts and glides while it turns; at rest it holds)
    sig = Math.imul(sig ^ ((placed?.n ?? -2) * 7919), 16777619);
    if (placed !== null)
      for (const v of [placed.x, placed.y, placed.w, placed.h])
        sig = Math.imul(sig ^ Math.round(v * 16), 16777619);
    sig >>>= 0;
    if (!force && sig === this.#lastSig) return;
    this.#lastSig = sig;

    const canvas = this.#o.canvas;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // her dots and her beam's are stamped in device px, blended in memory (k2-stamp.ts)
    this.#stamper.build(this.#styles(pal));
    const { k, ox, oy } = this.#device(fit);
    // asleep the beam and the token dim with her
    const light = mf?.light ?? 1;
    const static0 = settled ? this.#cached(portrait, fr, fit, pal) : null;
    // the same dots, beam and notes as the frame blended last: put it again (only the coin or an
    // actor moved)
    const rk = `${dk}|${bk}|${light}|${this.#cache?.key}|${notes.length > 0 ? t : -1}|${k}|${ox}|${oy}|${gs.dy}|${gs.dim}`;
    const W = canvas.width;
    const H = canvas.height;
    if (rk !== this.#rasterKey || !this.#stamper.again(ctx, W, H)) {
      this.#stamper.begin(W, H);
      // her: the settled frame's unchanging dots (kept as pixels) and this frame's changes, or
      // every dot
      if (static0 !== null) {
        const lk = `${this.#cache?.key}|${k}|${ox}|${oy}|${W}x${H}`;
        if (!this.#stamper.restore(lk)) {
          this.#stamper.stamp(ctx, static0, INKS, k, ox, oy);
          this.#stamper.keep(lk);
        }
        this.#stamper.stamp(ctx, dots, INKS, k, ox, oy);
      } else this.#stamper.stamp(ctx, dots, INKS, k, ox, oy + gs.dy * k, gs.dim);
      // her beam under her (her tee dissolves into it), the notes over her
      this.#stamper.stampInk(ctx, "beam", beam, k, ox, oy, light, true);
      this.#stamper.stampInk(ctx, "beam", notes, k, ox, oy);
      this.#stamper.stampInk(ctx, "ink", notesInk, k, ox, oy);
      this.#stamper.end(ctx);
      this.#rasterKey = rk;
    }
    this.#toMap(ctx, fit);

    // the gestures' actors: the blow's cloud and puff, the bird (authored on the wide frame)
    const [sx, sy] = R.shift;
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
        // its wings and trail keep their own steps (10 fps); it flies on the frame's time
        if (b !== null)
          drawBird(
            b,
            g,
            Math.floor(ti / STEP_MS),
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
    // asleep the coin dims with her light
    if (placed !== null) this.#token.paint(ctx, placed, (1 - light) / (1 - SLEEP.light));
  }

  /** Her settled frame's unchanging dots, emitted once per layout, theme, rig, emotion and hover. */
  #cached(portrait: Portrait, fr: PortraitFrame, fit: Fit, pal: Palette): Dots {
    const R = fit.rig;
    const key = [R.drawing, R.palm, this.#dark, fr.hp, fit.s, fit.ox, fit.oy, this.#mood?.to ?? ""]
      .map(String)
      .join("|");
    if (this.#cache?.key === key) return this.#cache.dots;
    const d = new Dots();
    portrait.emit(fr, pal, d, "static");
    this.#cache = { key, dots: d };
    return d;
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
