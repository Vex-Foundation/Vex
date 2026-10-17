/**
 * Where K2 stands in her host (`docs/design/R3-MINIMAL.md section 10`): pure geometry, the host's
 * box size in, her placement out, no DOM.
 *
 * A placement is plain numbers: the token's resting centre in the host (`ax`, `ay`, css px), its
 * face-on diameter `D` (css px) and her scale `s` (css px per map px). `fitOf` turns it into the
 * engine's one transform (host px = o + s * map) with the token and the cut on her map.
 *
 * She is drawn from one map, the wide drawing (pitch 3; her drawn frame spans 1040 to 1442 by 56 to
 * 659 map px, laid out for a 900 px high frame with her token at 1252, 652). Three placements:
 *
 * - `stage`, the pre-shell print plate: her whole drawing with its long beam, the token on the
 *   print's ground at the share of the height it has on its own frame (652 of 900), centred; her
 *   scale follows the plate's height (1 at 900 px) between 0.6 and 1.2;
 * - `sidebar`, the Vex sidebar's print plate (280 px high): a bust at scale 0.6, cut under her
 *   necklace through the Bayer screen, a short beam of dots to a small flat token centred near the
 *   plate's foot; a lower plate shrinks her so her hair stays inside;
 * - `welcome`, the welcome's stage (about 284 px high): the same bust.
 */
import type { K2Cut } from "./k2-portrait.js";

/** A box in host px. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export type K2PlacementName = "sidebar" | "welcome" | "stage";

/** Her place in the host: the token's resting centre and face-on diameter, her scale (css px). */
export interface K2Placement {
  readonly ax: number;
  readonly ay: number;
  readonly D: number;
  readonly s: number;
}

/** The token on her map: its resting centre and its face-on diameter (map px). */
export interface MapToken {
  readonly x: number;
  readonly y: number;
  readonly d: number;
}

/** Her map in the host: host px = o + s * map, with the token and the cut on her map. */
export interface Fit {
  readonly s: number;
  readonly ox: number;
  readonly oy: number;
  readonly token: MapToken;
  readonly cut: K2Cut | null;
}

/** The wide drawing's constants (map px). */
export const DRAWING = {
  /** The frame height she was laid out on, and her token there (centre, face-on diameter). */
  frameH: 900,
  token: { x: 1252, y: 652, d: 58 },
  /** Her topmost dots, and the foot of the flat token with its ring. */
  hairTop: 80,
  tokenFoot: 675,
  /** Her figure's box and her face's: [left, top, right, bottom]. */
  figure: [1088, 80, 1440, 562],
  face: [1172, 222, 1316, 332],
  /** Where the beam meets her body: its span. */
  beam: { left: 1090, right: 1470 },
  /** The canvas's box: her, her light, her token and the gestures' actors. */
  canvas: [1000, 0, 1520, 700],
} as const;

/**
 * The token sheet's own numbers (`public/art/vex-k2/token.json`): the coin's diameter and a frame's
 * side in css px, the flat face's centre and the half height of its ellipse in the frame. A frame
 * stands centred on the coin's resting centre, 6 css px low.
 */
export const TOKEN_SHEET = { td: 58, box: 80, flatCy: 42.25, flatRy: 9.59 } as const;

/** How far the flat face's centre lies under the coin's resting centre, per css px of coin. */
const FLAT_DROP = (TOKEN_SHEET.flatCy - (TOKEN_SHEET.box / 2 - 6)) / TOKEN_SHEET.td;

/**
 * The bust (`sidebar`, `welcome`): scale 0.6; the cut at map y 425 (under her necklace) with a
 * 64 px dissolve band; the coin 96.8 map px across (a fifth of her 484 px source frame), centred
 * under her source frame (x 1272), its flat face's centre half a coin plus half its ellipse under
 * the cut; the token's foot 0.34 of a coin under the flat face's centre, 8 px over the host's foot.
 */
export const BUST = {
  s: 0.6,
  cut: { y: 425, band: 64 },
  coin: 96.8,
  x: 1272,
  gap: 0.5,
  foot: 0.34,
  air: 8,
  /** The least room over her hair, css px. */
  top: 4,
} as const;

/** The stage: scale bounds. */
export const STAGE = { sMin: 0.6, sMax: 1.2 } as const;

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** The bust's token on her map. */
function bustToken(): MapToken {
  const d = BUST.coin;
  const q = d / TOKEN_SHEET.td;
  const flatCentre = BUST.cut.y + BUST.gap * d + (TOKEN_SHEET.flatRy / 2) * q;
  return { x: BUST.x, y: flatCentre - FLAT_DROP * d, d };
}

const BUST_TOKEN = bustToken();

/** The token's resting centre above the host's foot for a bust coin of D css px. */
const bustLift = (D: number): number => BUST.air + (BUST.foot + FLAT_DROP) * D;

/** Her placement in a host of this size. */
export function placementFor(name: K2PlacementName, width: number, height: number): K2Placement {
  if (name === "stage") {
    const s = clamp(height / DRAWING.frameH, STAGE.sMin, STAGE.sMax);
    return {
      ax: width / 2,
      ay: (height * DRAWING.token.y) / DRAWING.frameH,
      D: DRAWING.token.d * s,
      s,
    };
  }
  // the bust: scale 0.6, smaller when the host is too low for her hair to stay inside
  const perS = bustLift(BUST_TOKEN.d) + (BUST_TOKEN.y - DRAWING.hairTop);
  const s = Math.max(0.05, Math.min(BUST.s, (height - BUST.air - BUST.top) / (perS - BUST.air)));
  const D = BUST_TOKEN.d * s;
  return { ax: width / 2, ay: height - bustLift(D), D, s };
}

/** The engine's transform for a placement. */
export function fitOf(name: K2PlacementName, p: K2Placement): Fit {
  const bust = name !== "stage";
  const t = bust ? BUST_TOKEN : DRAWING.token;
  const token: MapToken = { x: t.x, y: t.y, d: p.D / p.s };
  return {
    s: p.s,
    ox: p.ax - p.s * token.x,
    oy: p.ay - p.s * token.y,
    token,
    cut: bust ? BUST.cut : null,
  };
}

/** A point of her map in the host. */
export function toHost(f: Fit, x: number, y: number): readonly [number, number] {
  return [f.ox + f.s * x, f.oy + f.s * y];
}

/** A box of her map in the host. */
export function boxToHost(f: Fit, b: readonly [number, number, number, number]): Box {
  return {
    left: f.ox + f.s * b[0],
    top: f.oy + f.s * b[1],
    right: f.ox + f.s * b[2],
    bottom: f.oy + f.s * b[3],
  };
}

/** The canvas's box in the host: her, her light, her token and the gestures' actors. */
export function canvasBox(f: Fit): Box {
  return boxToHost(f, DRAWING.canvas);
}
