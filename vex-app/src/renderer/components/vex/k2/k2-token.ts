/**
 * The VEX token on K2's canvas: the 3D coin (brand blue enamel, the real vx embossed in white, a
 * bevelled rim) pre-rendered into sprite sheets (`public/art/vex-k2/token-*.webp`), so the app never
 * loads a 3D renderer. Without the wake she loads the flat coin alone (4 KB); the wake loads every
 * pose: face-on with its tilts, the press, the turn to flat.
 *
 * `frameFor` picks the pose nearest to the projector's state (pure); `TokenSprite` loads the sheets
 * and draws a frame on her map, answering the flat face's ellipse for the cone.
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
  #res: "1x" | "2x" = "2x";

  /**
   * Loads the flat coin (and, for the wake, every pose) at the resolution the screen needs:
   * `density` is device px per css px of the sheet's coin.
   */
  async load(wake: boolean, density: number): Promise<void> {
    this.#res = density > 1.3 ? "2x" : "1x";
    const sheet = await loadTokenSheet();
    this.#sheet = sheet;
    const [flat, all] = await Promise.all([
      loadBitmap(`token-flat-${this.#res}.webp`),
      wake ? loadBitmap(`token-wake-${this.#res}.webp`) : Promise.resolve(null),
    ]);
    this.#flat = flat;
    this.#wake = all;
  }

  get ready(): boolean {
    return this.#sheet !== null && this.#flat !== null;
  }

  /**
   * Where the coin stands for a pose: centred at (x, y) of her map, `d` map px across (face-on),
   * `dy` map px lower; with the face's ellipse (the cone's base) on her map.
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
    },
  ): PlacedToken | null {
    const sheet = this.#sheet;
    if (sheet === null || this.#flat === null) return null;
    const q = d / sheet.td;
    const n =
      this.#wake === null
        ? -1
        : frameFor(sheet.frames, pose.flip, pose.press, pose.tiltX, pose.tiltY);
    const frame = n < 0 ? sheet.flat : sheet.frames[n];
    if (frame === undefined) return null;
    // the frame box: centred on the coin's resting centre, 6 css px low (token-sprite.mjs)
    const bx = x - (sheet.box / 2) * q;
    const by = y - (sheet.box / 2 - 6) * q + dy;
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

  /** Draws a placed coin on her map. */
  paint(ctx: Scratch2D, p: PlacedToken): void {
    const sheet = this.#sheet;
    if (sheet === null || this.#flat === null) return;
    const fw = Math.round(sheet.box * sheet.ratios[this.#res]);
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
  }
}
