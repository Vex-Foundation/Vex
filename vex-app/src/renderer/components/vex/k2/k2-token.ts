/**
 * The VEX token on K2's canvas: the 3D coin (brand blue enamel, the real vx embossed in white, a
 * bevelled rim) pre-rendered into sprite sheets (`public/art/vex-k2/token-*.webp`), so the app never
 * loads a 3D renderer. Without the wake or an episode she loads the flat coin alone (4 KB); they load
 * every pose: face-on with its tilts, the press, the turn to flat.
 *
 * `frameFor` picks the pose nearest to the projector's state (pure); `TokenSprite` loads the sheets
 * and draws a frame on her map, answering the flat face's ellipse for the cone.
 *
 * The coin's states (`docs/design/R3-MINIMAL.md sections 5.2 and 10.4`): face-on it floats, tilts
 * toward the pointer and lifts a little under it (`liftOf`); it presses like a key and turns to lie
 * flat for her; a close turns it back face-on (the reverse flip, the same poses run backward,
 * `loadPoses`) and it stands upright at rest, the token toggle's coin; asleep it dims with her
 * light (`tokenBrightness`).
 */
import { loadBitmap, loadTokenSheet, type Scratch2D } from "./k2-assets.js";
import type { TokenBase } from "./k2-scene.js";

export interface TokenFrame {
  readonly kind: "tilt" | "press" | "flip" | "flat";
  readonly tiltX: number;
  readonly tiltY: number;
  readonly press: number;
  readonly flip: number;
  /** The face's centre and rim ellipse in the frame's css px. */
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}

export interface TokenSheet {
  /** The coin's diameter and a frame's side, css px; frames per row; device px per css px. */
  readonly td: number;
  readonly box: number;
  readonly cols: number;
  readonly ratios: { readonly "1x": number; readonly "2x": number };
  readonly flat: TokenFrame;
  readonly frames: readonly TokenFrame[];
}

/** The pose drawn for a projector state: -1 for the flat coin, else its index in the wake sheet. */
export function frameFor(
  frames: readonly TokenFrame[],
  flip: number,
  press: number,
  tiltX: number,
  tiltY: number,
): number {
  if (flip >= 1 - 1 / 24) return -1;
  let best = -1;
  let bd = Number.POSITIVE_INFINITY;
  const kind = flip > 1 / 24 ? "flip" : press > 0.125 ? "press" : "tilt";
  frames.forEach((f, n) => {
    if (f.kind !== kind) return;
    const d =
      kind === "flip"
        ? Math.abs(f.flip - flip)
        : kind === "press"
          ? Math.abs(f.press - press)
          : (f.tiltX - tiltX) ** 2 + (f.tiltY - tiltY) ** 2;
    if (d < bd) {
      bd = d;
      best = n;
    }
  });
  return best;
}

/** Face-on under the pointer the coin lifts by this much of its diameter and grows a little. */
export const LIFT = { rise: 0.035, grow: 0.025, up: 220, down: 260 } as const;

/** The lift at a moment: up over 220 ms once the pointer is on the coin, down over 260 ms after. */
export function liftOf(on: boolean, onAge: number, offAge: number): number {
  const out = (q: number): number => 1 - (1 - Math.max(0, Math.min(1, q))) ** 3;
  if (on) return out(onAge / LIFT.up);
  if (offAge < 0) return 0;
  return 1 - out(offAge / LIFT.down);
}

/**
 * Asleep the coin dims with her light: its lighting drops by up to 45%, which reads on the sprite
 * as a brightness of 0.775 at the deepest sleep. `dim` is how deep, 0..1.
 */
export const TOKEN_DIM = 0.45;

export function tokenBrightness(dim: number): number {
  return 1 - 0.5 * TOKEN_DIM * Math.max(0, Math.min(1, dim));
}

/** What painting a coin needs of a 2D context (her canvas's, or a scratch one). */
export type CoinCanvas = Pick<Scratch2D, "drawImage" | "filter" | "save" | "restore">;

/** A coin placed on her map: its pose (-1 flat), its frame box, its face's ellipse. */
export interface PlacedToken {
  readonly n: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly base: TokenBase;
}

export class TokenSprite {
  #sheet: TokenSheet | null = null;
  #flat: ImageBitmap | null = null;
  #wake: ImageBitmap | null = null;
  #poses: Promise<void> | null = null;
  #res: "1x" | "2x" = "2x";

  /**
   * Loads the flat coin (and, for the wake or an episode, every pose) at the resolution the screen
   * needs: `density` is device px per css px of the sheet's coin.
   */
  async load(poses: boolean, density: number): Promise<void> {
    this.#res = density > 1.3 ? "2x" : "1x";
    const sheet = await loadTokenSheet();
    this.#sheet = sheet;
    const [flat] = await Promise.all([
      loadBitmap(`token-flat-${this.#res}.webp`),
      poses ? this.loadPoses() : Promise.resolve(),
    ]);
    this.#flat = flat;
  }

  /**
   * Every pose of the coin (face-on with its tilts, the press, the turn), for the wake and the
   * episodes; loaded once. Until it arrives the coin is drawn flat.
   */
  loadPoses(): Promise<void> {
    this.#poses ??= loadBitmap(`token-wake-${this.#res}.webp`).then(
      (all) => {
        this.#wake = all;
      },
      () => {
        // the coin stays flat rather than half turned
        this.#poses = null;
      },
    );
    return this.#poses;
  }

  get ready(): boolean {
    return this.#sheet !== null && this.#flat !== null;
  }

  /** Every pose is in (face-on, the press, the turn), not the flat coin alone. */
  get posed(): boolean {
    return this.#wake !== null;
  }

  /**
   * Where the coin stands for a pose: centred at (x, y) of her map, `d` map px across (face-on),
   * `dy` map px lower; with the face's ellipse (the cone's base) on her map. `lift` (0..1) raises
   * and grows it a little under the pointer.
   */
  place(
    x: number,
    y: number,
    d: number,
    dy: number,
    pose: {
      readonly flip: number;
      readonly press: number;
      readonly tiltX: number;
      readonly tiltY: number;
      readonly lift?: number;
    },
  ): PlacedToken | null {
    const sheet = this.#sheet;
    if (sheet === null || this.#flat === null) return null;
    const lift = Math.max(0, Math.min(1, pose.lift ?? 0));
    const q = (d / sheet.td) * (1 + LIFT.grow * lift);
    const n =
      this.#wake === null
        ? -1
        : frameFor(sheet.frames, pose.flip, pose.press, pose.tiltX, pose.tiltY);
    const frame = n < 0 ? sheet.flat : sheet.frames[n];
    if (frame === undefined) return null;
    // the frame box: centred on the coin's resting centre, 6 css px low (token-sprite.mjs)
    const bx = x - (sheet.box / 2) * q;
    const by = y - (sheet.box / 2 - 6) * q + dy - LIFT.rise * d * lift;
    return {
      n,
      x: bx,
      y: by,
      size: sheet.box * q,
      base: {
        cx: bx + frame.cx * q,
        cy: by + frame.cy * q,
        rx: frame.rx * q,
        ry: frame.ry * q,
      },
    };
  }

  /** Draws a placed coin on her map; `dim` (0..1) darkens it with her sleep. */
  paint(ctx: CoinCanvas, p: PlacedToken, dim = 0): void {
    const sheet = this.#sheet;
    if (sheet === null || this.#flat === null) return;
    const fw = Math.round(sheet.box * sheet.ratios[this.#res]);
    const dimmed = dim > 0;
    if (dimmed) {
      ctx.save();
      ctx.filter = `brightness(${tokenBrightness(dim).toFixed(3)})`;
    }
    if (p.n < 0 || this.#wake === null)
      ctx.drawImage(this.#flat, 0, 0, fw, fw, p.x, p.y, p.size, p.size);
    else {
      const col = p.n % sheet.cols;
      const row = Math.floor(p.n / sheet.cols);
      ctx.drawImage(
        this.#wake,
        col * fw,
        row * fw,
        fw,
        fw,
        p.x,
        p.y,
        p.size,
        p.size,
      );
    }
    if (dimmed) ctx.restore();
  }
}
