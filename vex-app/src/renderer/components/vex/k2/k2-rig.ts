/**
 * Where K2 stands in her host (`docs/design/R3-MINIMAL.md section 10`): pure geometry, the host's
 * box size in, her fit out, no DOM. The engine draws her map through one transform
 * (host px = o + s * map).
 *
 * She has two drawings on the same dot screen (pitch 3 at scale k 1):
 *
 * - the wide drawing (`public/art/vex-k2/`): her whole figure over a long beam, laid out on a 900 px
 *   high frame (she spans 1040 to 1442 by 56 to 659 map px, her token at 1252, 652); the pre-shell
 *   print plate (`stage`) shows it, anchored at the share of the height that token has on that
 *   frame (652 of 900), centred, her scale following the plate's height (1 at 900 px) between 0.6
 *   and 1.2. The stage draws its token where the approved wake still puts it (`STAGE_TOKEN`):
 *   larger and lower, under a longer beam;
 * - the app drawing (`public/art/vex-k2/app/`, 487.5 x 651 map px, origin 0, 0): the same K2 with
 *   the emotion maps (`k2-poses.ts`). The Vex sidebar's 280 px plate (`sidebar`) and the welcome's
 *   stage (`welcome`, 240 to 300 px high) show her bust: cut under her necklace (map y 370) through
 *   a 64 px Bayer dissolve, a short beam of dots to a small flat token at the plate's foot, scale
 *   0.6 (her face about 84 px across); with the approval palm the cut drops to 412 (a 44 px
 *   dissolve) and she shrinks to 0.57 so the palm stays above it; while her morning coffee shows
 *   the cut drops under the mug she holds (`MUG_FOOT`, a 33 px dissolve from map y 441) and she
 *   shrinks to fit, so the mug is never dissolved (the engine eases between the two fits). A lower
 *   host shrinks her so her hair stays inside; a narrower one clips the frame's empty edges (they
 *   thin out anyway).
 */
import { MUG_FOOT } from "./k2-coffee.js";
import type { PortraitCut } from "./k2-portrait.js";
import { LIFT } from "./k2-token.js";

/** A box in host px. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export type K2PlacementName = "sidebar" | "welcome" | "stage";

/** Her two drawings: the wide one (the stage) and the app one (the bust, with the emotions). */
export type K2Drawing = "wide" | "app";

/** The token on her map: its resting centre and its face-on diameter (map px). */
export interface MapToken {
  readonly x: number;
  readonly y: number;
  readonly d: number;
}

type Rect = readonly [number, number, number, number];
type Point = readonly [number, number];

/** A drawing's place for her token, her beam and her cut (map px). */
export interface Rig {
  readonly drawing: K2Drawing;
  readonly token: MapToken;
  /** Her topmost dots, and the foot of the flat token with its ring. */
  readonly hairTop: number;
  readonly tokenFoot: number;
  /** Her figure's box and her face's: [left, top, right, bottom]. */
  readonly figure: Rect;
  readonly face: Rect;
  /** The beam: its top (null: where her own drawing dissolves) and its span where it meets her. */
  readonly beam: { readonly top: number | null; readonly left: number; readonly right: number };
  /** The app drawing's cut; null on the wide drawing (it has its own). */
  readonly cut: PortraitCut | null;
  /** The approval palm's lower cut. */
  readonly palm: boolean;
  /** The morning coffee's lower cut (under the mug she holds). */
  readonly coffee: boolean;
  /** The gestures' actors are authored on the wide drawing's frame: wide px = map + shift. */
  readonly shift: Point;
  /** Where she glances away to besides the composer: a passing cloud, the birds. */
  readonly looks: { readonly cloud: Point; readonly birds: Point };
  /**
   * The upright coin (face on: the wake's first beat, the token toggle's rest): its diameter in
   * flat coins (`scale`) and how far its centre sits under the token's point, in its own diameters
   * (`drop`, negative above).
   */
  readonly stand: Stand;
  /** The canvas's box: her, her light, her token and the gestures' actors. */
  readonly canvas: Rect;
}

/** The upright coin's size and place against the flat token (`Rig.stand`). */
export interface Stand {
  readonly scale: number;
  readonly drop: number;
}

/** Her map in the host: host px = o + s * map. */
export interface Fit {
  readonly rig: Rig;
  readonly s: number;
  readonly ox: number;
  readonly oy: number;
}

/**
 * The token sheet's own numbers (`public/art/vex-k2/token.json`): the coin's diameter and a frame's
 * side in css px, the flat face's centre and the half height of its ellipse in the frame. A frame
 * stands centred on the coin's resting centre, 6 css px low.
 */
export const TOKEN_SHEET = { td: 58, box: 80, flatCy: 42.25, flatRy: 9.59 } as const;

/** How far the flat face's centre lies under the coin's resting centre, per css px of coin. */
const FLAT_DROP = (TOKEN_SHEET.flatCy - (TOKEN_SHEET.box / 2 - 6)) / TOKEN_SHEET.td;

/**
 * The upright coin (face on: the wake's first beat, and the token toggle's rest with the hologram
 * off) sits this much of its diameter under the token's point, as the wake's face-on coin rests.
 */
export const STAND_DROP = 0.12;

/**
 * The face-on coin's drawn extent in a sheet frame (css px of the 80 px frame, the coin's centre at
 * 40, 34): the union of every face-on pose in `token-wake-2x.webp` (the coin and its bevelled rim;
 * the sprite draws no shadow under it). Measured from the sheet's alpha.
 */
export const UPRIGHT_INK = { left: 10.4, top: 4.4, right: 69.6, bottom: 63.6 } as const;

/** The face-on coin floats this much of its diameter up and down in an episode (the engine's bob). */
export const STAND_BOB = 0.03;

/**
 * The welcome's upright coin, the token toggle's rest with only the coin left (the owner,
 * 2026-10-18): clearly larger than the flat token, one and a half coins across.
 */
export const WELCOME_STAND_SCALE = 1.5;

/**
 * The upright coin's drawn extent around its centre, per diameter: the rim's ink, the lift under
 * the pointer (it rises and grows a little) and the bob in an episode. Returns [half width, above,
 * below] in diameters.
 */
function uprightReach(): readonly [number, number, number] {
  const q = 1 / TOKEN_SHEET.td;
  const grown = q * (1 + LIFT.grow);
  const cy = TOKEN_SHEET.box / 2 - 6;
  const half = Math.max(TOKEN_SHEET.box / 2 - UPRIGHT_INK.left, UPRIGHT_INK.right - TOKEN_SHEET.box / 2) * grown;
  const above = (cy - UPRIGHT_INK.top) * grown + LIFT.rise + STAND_BOB;
  const below = Math.max((UPRIGHT_INK.bottom - cy) * q, (UPRIGHT_INK.bottom - cy) * grown - LIFT.rise) + STAND_BOB;
  return [half, above, below];
}

/* ------------------------------------------------------------------ the wide drawing */

/** The wide drawing's constants (map px). */
export const DRAWING = {
  /** The frame height she was laid out on. */
  frameH: 900,
  token: { x: 1252, y: 652, d: 58 },
  hairTop: 80,
  tokenFoot: 675,
  figure: [1088, 80, 1440, 562],
  face: [1172, 222, 1316, 332],
  /** Where the beam meets her body: its span. */
  beam: { left: 1090, right: 1470 },
  canvas: [1000, 0, 1520, 700],
} as const;

/** The stage: scale bounds. */
export const STAGE = { sMin: 0.6, sMax: 1.2 } as const;

/* ------------------------------------------------------------------ the app drawing */

/** The app drawing's constants (map px, its `meta.json`). */
export const APP = {
  /** The frame's width (162 cells and half a pitch) and height (217 rows). */
  w: 487.5,
  h: 651,
  /** Her topmost dot on the base drawing. */
  top: 27,
  /** Her face's centre. */
  face: [207.9, 205.2],
  /** The wide drawing is this frame moved by (1030, 55): the gestures' actors are authored there. */
  shift: [1030, 55],
  /** The frame's edges thin out over this much. */
  side: 18,
  /** The token's face-on diameter against the frame's width. */
  coin: 0.2,
} as const;

/**
 * The stage's token (wide map px, at scale 1 css px on a 900 px plate), as the approved wake still
 * draws it (the MK `d1-wake` render: the app drawing's coin at scale 1 over a beam 1.2 coins long):
 * a coin a fifth of the app frame's width (97.5), its foot 124 px over the plate's foot (776 of
 * 900), its flat face 0.34 of a coin over the foot. Her own drawing keeps its place on the frame;
 * only the beam grows to reach the token.
 */
export const STAGE_TOKEN = (() => {
  const d = APP.coin * APP.w;
  const foot = DRAWING.frameH - 124;
  const flatCy = foot - 0.34 * d;
  return { x: DRAWING.token.x, y: flatCy - FLAT_DROP * d, d, foot } as const;
})();

const WIDE_RIG: Rig = {
  drawing: "wide",
  token: { x: STAGE_TOKEN.x, y: STAGE_TOKEN.y, d: STAGE_TOKEN.d },
  hairTop: DRAWING.hairTop,
  tokenFoot: STAGE_TOKEN.foot,
  figure: DRAWING.figure,
  face: DRAWING.face,
  beam: { top: null, left: DRAWING.beam.left, right: DRAWING.beam.right },
  cut: null,
  palm: false,
  coffee: false,
  shift: [0, 0],
  looks: { cloud: [900, 140], birds: [300, 600] },
  stand: { scale: 1, drop: STAND_DROP },
  // down to the face-on token's frame under the foot, as it floats and turns flat
  canvas: [DRAWING.canvas[0], DRAWING.canvas[1], DRAWING.canvas[2], STAGE_TOKEN.foot + 44],
};

/** Where her eyes go in an emotion (`k2-poses.ts` `MoodLook`), on the app drawing. */
export const APP_LOOKS = {
  you: [APP.face[0] + 70, APP.face[1] + 4],
  composer: [APP.face[0] - 150, APP.face[1] + 420],
  upSide: [APP.face[0] - 260, APP.face[1] - 420],
  work: [APP.face[0] - 140, APP.face[1] + 300],
  aside: [APP.face[0] - 700, APP.face[1] + 90],
} as const;

/**
 * The bust: the cut under her necklace (palm: lower, a shorter dissolve), scale 0.6 (palm 0.57),
 * the flat face half a coin and half its ellipse under the cut, the token's foot 0.34 of a coin
 * under the flat face's centre; air over her hair and under the token's foot, css px.
 */
export const BUST = {
  cut: { y: 370, band: 64 },
  palmCut: { y: 412, band: 44 },
  /** Under the coffee's mug: its dissolve begins a row under the mug's foot. */
  coffeeCut: { y: MUG_FOOT + 3 + 33, band: 33 },
  s: 0.6,
  palmS: 0.57,
  gap: 0.5,
  foot: 0.34,
  padTop: 4,
  padBottom: 8,
  /** Never so small her dots blur away. */
  sMin: 0.2,
} as const;

/**
 * A bust's rig. `standScale` sizes the upright coin: at 1 (the Vex sidebar) it rests a little under
 * the token's point as the wake's coin does; larger (the welcome) it stands on the flat coin's foot,
 * its whole drawn coin (rim, lift, bob) above that foot, so the host and a stage cut to the coin
 * never clip it.
 */
function bustRig(palm: boolean, standScale = 1, coffee = false): Rig {
  const { y, band } = palm ? BUST.palmCut : coffee ? BUST.coffeeCut : BUST.cut;
  const W = APP.w;
  const cut: PortraitCut = {
    top: () => y - band,
    band,
    gain: 1.02,
    shrink: 0,
    side: APP.side,
    width: W,
    bottom: y,
  };
  const d = APP.coin * W;
  const q = d / TOKEN_SHEET.td;
  const flatCy = y + d * BUST.gap + TOKEN_SHEET.flatRy * q * 0.5;
  const cx = W / 2;
  const half = 0.36 * W;
  const foot = flatCy + d * BUST.foot;
  const ty = flatCy - FLAT_DROP * d;
  const sd = d * standScale;
  const [, , below] = uprightReach();
  const drop = standScale === 1 ? STAND_DROP : (foot - below * sd - ty) / sd;
  // the upright coin's drawn foot (the token toggle's rest)
  const stand = ty + drop * sd + below * sd;
  return {
    drawing: "app",
    token: { x: cx, y: ty, d },
    hairTop: APP.top,
    tokenFoot: foot,
    figure: [0, APP.top, W, y],
    face: [APP.face[0] - 64, APP.face[1] - 60, APP.face[0] + 76, APP.face[1] + 66],
    beam: { top: y - band - 10, left: cx - half, right: cx + half },
    cut,
    palm,
    coffee: coffee && !palm,
    shift: APP.shift,
    looks: { cloud: APP_LOOKS.upSide, birds: APP_LOOKS.aside },
    stand: { scale: standScale, drop },
    // the bird comes in at the frame's right edge; down to the upright coin's foot
    canvas: [-8, 0, W + 8, Math.max(foot + BUST.padBottom, stand)],
  };
}

/** One rig per bust (a fit compares by identity); the welcome's has the larger upright coin. */
const BUST_RIG = bustRig(false);
const BUST_PALM_RIG = bustRig(true);
const WELCOME_RIG = bustRig(false, WELCOME_STAND_SCALE);
const WELCOME_PALM_RIG = bustRig(true, WELCOME_STAND_SCALE);
const BUST_COFFEE_RIG = bustRig(false, 1, true);
const WELCOME_COFFEE_RIG = bustRig(false, WELCOME_STAND_SCALE, true);

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/**
 * Her fit in a host of this size, or null when the host is too small for her dots. `palm`: the
 * approval palm shows (the bust's cut drops); `coffee`: her morning coffee shows (the bust's cut
 * drops under the mug; the palm wins). The stage has neither.
 */
export function fitFor(
  name: K2PlacementName,
  width: number,
  height: number,
  palm = false,
  coffee = false,
): Fit | null {
  if (!(width > 0 && height > 0)) return null;
  if (name === "stage") {
    const s = clamp(height / DRAWING.frameH, STAGE.sMin, STAGE.sMax);
    const ax = width / 2;
    const ay = (height * DRAWING.token.y) / DRAWING.frameH;
    return { rig: WIDE_RIG, s, ox: ax - s * DRAWING.token.x, oy: ay - s * DRAWING.token.y };
  }
  const R =
    name === "welcome"
      ? palm
        ? WELCOME_PALM_RIG
        : coffee
          ? WELCOME_COFFEE_RIG
          : WELCOME_RIG
      : palm
        ? BUST_PALM_RIG
        : coffee
          ? BUST_COFFEE_RIG
          : BUST_RIG;
  const span = R.tokenFoot - R.hairTop;
  const s = Math.min(palm ? BUST.palmS : BUST.s, (height - BUST.padTop - BUST.padBottom) / span);
  if (!(s >= BUST.sMin)) return null;
  return {
    rig: R,
    s,
    ox: Math.round((width - APP.w * s) / 2),
    oy: Math.round(height - BUST.padBottom - R.tokenFoot * s),
  };
}

const mix = (a: number, b: number, q: number): number => a + (b - a) * q;
const mixPts = <T extends readonly number[]>(a: T, b: T, q: number): T =>
  a.map((v, i) => mix(v, b[i] ?? v, q)) as unknown as T;

/**
 * Between two fits of the same drawing, `q` of the way (0..1): her scale, her token, her beam, her
 * cut and her canvas move together while her token's foot keeps its line in the host (the engine
 * eases the bust into the coffee's lower cut and back). The flags (`palm`, `coffee`) switch at the
 * half.
 */
export function mixFit(a: Fit, b: Fit, q: number): Fit {
  if (q <= 0) return a;
  if (q >= 1) return b;
  const A = a.rig;
  const B = b.rig;
  const ca = A.cut;
  const cb = B.cut;
  const cut: PortraitCut | null =
    ca === null || cb === null
      ? (q < 0.5 ? ca : cb)
      : {
          top: (x) => mix(ca.top(x), cb.top(x), q),
          band: mix(ca.band, cb.band, q),
          gain: mix(ca.gain, cb.gain, q),
          shrink: mix(ca.shrink, cb.shrink, q),
          side: mix(ca.side, cb.side, q),
          width: mix(ca.width, cb.width, q),
          bottom: mix(ca.bottom, cb.bottom, q),
        };
  const top =
    A.beam.top === null || B.beam.top === null
      ? (q < 0.5 ? A.beam.top : B.beam.top)
      : mix(A.beam.top, B.beam.top, q);
  const rig: Rig = {
    ...(q < 0.5 ? A : B),
    token: { x: mix(A.token.x, B.token.x, q), y: mix(A.token.y, B.token.y, q), d: mix(A.token.d, B.token.d, q) },
    hairTop: mix(A.hairTop, B.hairTop, q),
    tokenFoot: mix(A.tokenFoot, B.tokenFoot, q),
    figure: mixPts(A.figure, B.figure, q),
    face: mixPts(A.face, B.face, q),
    beam: { top, left: mix(A.beam.left, B.beam.left, q), right: mix(A.beam.right, B.beam.right, q) },
    cut,
    stand: { scale: mix(A.stand.scale, B.stand.scale, q), drop: mix(A.stand.drop, B.stand.drop, q) },
    canvas: mixPts(A.canvas, B.canvas, q),
  };
  // her token's foot and centre move straight between their places in the host (the plate's foot)
  const sc = mix(a.s, b.s, q);
  const footX = mix(a.ox + a.s * A.token.x, b.ox + b.s * B.token.x, q);
  const footY = mix(a.oy + a.s * A.tokenFoot, b.oy + b.s * B.tokenFoot, q);
  return { rig, s: sc, ox: footX - sc * rig.token.x, oy: footY - sc * rig.tokenFoot };
}

/**
 * The beam's screen at her scale, css px: pitch 5 on the stage; on the bust pitch 5 at scale 0.96,
 * never under 2.6.
 */
export function beamScreen(f: Fit): { readonly pitch: number; readonly rmax: number } {
  if (f.rig.drawing === "wide") return { pitch: 5, rmax: 2.2 };
  const pitch = Math.max(2.6, (5 * f.s) / 0.96);
  return { pitch, rmax: pitch * 0.44 };
}

/** A point of her map in the host. */
export function toHost(f: Fit, x: number, y: number): readonly [number, number] {
  return [f.ox + f.s * x, f.oy + f.s * y];
}

/** A box of her map in the host. */
export function boxToHost(f: Fit, b: Rect): Box {
  return {
    left: f.ox + f.s * b[0],
    top: f.oy + f.s * b[1],
    right: f.ox + f.s * b[2],
    bottom: f.oy + f.s * b[3],
  };
}

/** The canvas's box in the host: her, her light, her token and the gestures' actors. */
export function canvasBox(f: Fit): Box {
  return boxToHost(f, f.rig.canvas);
}

/* ------------------------------------------------------------------ the token toggle's coin */

/** The upright coin's diameter and centre on her map (the toggle's rest, face on). */
function standOf(f: Fit): { readonly d: number; readonly cy: number } {
  const t = f.rig.token;
  const d = t.d * f.rig.stand.scale;
  return { d, cy: t.y + d * f.rig.stand.drop };
}

/** The upright coin in the host: face on at the token's place (the toggle's rest), its disc. */
export function tokenStand(f: Fit): Box {
  const t = f.rig.token;
  const { d, cy } = standOf(f);
  const r = d / 2;
  return boxToHost(f, [t.x - r, cy - r, t.x + r, cy + r]);
}

/**
 * Everything the upright coin draws in the host: its disc and bevelled rim, lifted and grown under
 * the pointer, bobbing in an episode. A stage cut to the coin contains this box.
 */
export function tokenStandInk(f: Fit): Box {
  const t = f.rig.token;
  const { d, cy } = standOf(f);
  const [half, above, below] = uprightReach();
  return boxToHost(f, [t.x - half * d, cy - above * d, t.x + half * d, cy + below * d]);
}

/** The flat coin in the host: its face's ellipse and its rim, down to the token's foot. */
export function tokenFlat(f: Fit): Box {
  const t = f.rig.token;
  const cy = t.y + FLAT_DROP * t.d;
  const ry = (TOKEN_SHEET.flatRy * t.d) / TOKEN_SHEET.td;
  return boxToHost(f, [t.x - t.d / 2, cy - ry, t.x + t.d / 2, f.rig.tokenFoot]);
}

/**
 * The token's box for its toggle button, and its stage's height while only the coin shows: the
 * flat coin and everything the upright one draws, together (host px).
 */
export function tokenBox(f: Fit): Box {
  const flat = tokenFlat(f);
  const up = tokenStandInk(f);
  return {
    left: Math.min(flat.left, up.left),
    top: Math.min(flat.top, up.top),
    right: Math.max(flat.right, up.right),
    bottom: Math.max(flat.bottom, up.bottom),
  };
}
