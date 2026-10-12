/**
 * A recording 2D canvas for jsdom, which has none.
 *
 * Every canvas gets one fake context. It records what is painted (each
 * `fillRect` and each `clearRect`), and it answers `getImageData` from a
 * pattern function registered for the image last drawn into it, so the real
 * sprite classifier (`lib/pixel/sprite.ts`) and the real alpha bounds run
 * unchanged on synthetic sprites. A horizontal mirror (`translate` then
 * `scale(-1, 1)`) is honoured, because the far birds are flipped that way.
 */

/** RGBA, 0..255, at a point (u, v) in [0, 1) of the sprite. */
export type SpritePattern = (u: number, v: number) => readonly [number, number, number, number];

/** What one canvas has been asked to paint. */
export interface PaintLog {
  readonly rects: [number, number, number, number][];
  /** Where each frame starts in `rects` (one mark per `clearRect`). */
  readonly marks: number[];
  clears: number;
}

/** The blocks of the last frame painted. */
export function lastFrame(log: PaintLog): [number, number, number, number][] {
  return log.rects.slice(log.marks.at(-1) ?? 0);
}

/** The blocks of the first frame painted. */
export function firstFrame(log: PaintLog): [number, number, number, number][] {
  return log.rects.slice(log.marks[0] ?? 0, log.marks[1] ?? log.rects.length);
}

/** The members of CanvasRenderingContext2D the pixel code uses. */
interface FakeContext {
  canvas: HTMLCanvasElement;
  fillStyle: string | CanvasGradient | CanvasPattern;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: ImageSmoothingQuality;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
}

const patterns = new WeakMap<object, SpritePattern>();
const logs = new WeakMap<HTMLCanvasElement, PaintLog>();
const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();

/** A sprite the fake can read: a canvas of the given size whose pixels are `pattern`. */
export function fakeSprite(width: number, height: number, pattern: SpritePattern): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  patterns.set(c, pattern);
  return c;
}

/** The paint log of a canvas (created on first use). */
export function paintLog(canvas: HTMLCanvasElement): PaintLog {
  let log = logs.get(canvas);
  if (log === undefined) {
    log = { rects: [], marks: [], clears: 0 };
    logs.set(canvas, log);
  }
  return log;
}

function contextFor(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const existing = contexts.get(canvas);
  if (existing !== undefined) return existing;
  const log = paintLog(canvas);
  let drawn: { pattern: SpritePattern | undefined; w: number; h: number } | null = null;
  let flip = false;
  const fake: FakeContext = {
    canvas,
    fillStyle: "#000000",
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    fillRect(x, y, w, h) {
      log.rects.push([x, y, w, h]);
    },
    clearRect() {
      log.clears += 1;
      log.marks.push(log.rects.length);
    },
    translate() {
      // Only the mirror's translate is ever issued; `scale(-1, 1)` marks it.
    },
    scale(x) {
      if (x < 0) flip = !flip;
    },
    drawImage(image, _dx, _dy, dw, dh) {
      drawn = { pattern: patterns.get(image), w: dw, h: dh };
    },
    getImageData(_sx, _sy, sw, sh) {
      const data = new Uint8ClampedArray(sw * sh * 4);
      const src = drawn;
      if (src !== null && src.pattern !== undefined) {
        for (let j = 0; j < sh; j++) {
          for (let i = 0; i < sw; i++) {
            let u = (i + 0.5) / src.w;
            const v = (j + 0.5) / src.h;
            if (flip) u = 1 - u;
            const [r, g, b, a] = src.pattern(u, v);
            const k = (j * sw + i) * 4;
            data[k] = r;
            data[k + 1] = g;
            data[k + 2] = b;
            data[k + 3] = a;
          }
        }
      }
      const image: ImageData = { data, width: sw, height: sh, colorSpace: "srgb" };
      return image;
    },
  };
  const ctx = fake as CanvasRenderingContext2D;
  contexts.set(canvas, ctx);
  return ctx;
}

/** Install the fake on every canvas; returns the restore function. */
export function installFakeCanvas(): () => void {
  const proto = HTMLCanvasElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "getContext");
  Object.defineProperty(proto, "getContext", {
    configurable: true,
    writable: true,
    value: function getContext(this: HTMLCanvasElement, kind: string) {
      return kind === "2d" ? contextFor(this) : null;
    },
  });
  return () => {
    if (original !== undefined) Object.defineProperty(proto, "getContext", original);
  };
}

/** An eagle-like sprite: a white body with darker shading, transparent margins. */
export const EAGLE_SPRITE: SpritePattern = (u, v) => {
  const inside = u > 0.1 && u < 0.9 && v > 0.08 && v < 0.92;
  if (!inside) return [0, 0, 0, 0];
  const shade = (u + v) / 2 > 0.6 ? 70 : 245;
  return [shade, shade, shade, 255];
};

/** A far bird: a blue and lavender ellipse (read in the "rg" mode). */
export const BIRD_SPRITE: SpritePattern = (u, v) => {
  const d = ((u - 0.5) / 0.48) ** 2 + ((v - 0.5) / 0.4) ** 2;
  if (d > 1) return [0, 0, 0, 0];
  return d < 0.4 ? [0, 5, 238, 255] : [180, 180, 255, 255];
};
