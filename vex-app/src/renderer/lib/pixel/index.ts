/**
 * The pixel animal system: white blocks, 4x4 Bayer dither and dithered motion
 * trails over a sepia print. `core` holds the generator, the dither and the
 * canvas helpers; `sprite` turns an RGBA sprite into a classified grid and
 * draws it. Both touch the canvas only when a sprite is classified or drawn.
 */

export {
  rng,
  BAYER,
  ditherCell,
  BoundsPlotter,
  createCanvas,
  context2d,
  loadImage,
  smoothstep,
  sourceSize,
  alphaBounds,
} from "./core.js";
export type {
  Rng,
  Plotter,
  Ctx2D,
  AnyCanvas,
  PixelSource,
  DitherOptions,
  AlphaBounds,
} from "./core.js";
export { spriteGrid, drawSpriteGrid } from "./sprite.js";
export type {
  LumaMode,
  SpriteGrid,
  SpriteGridOptions,
  SpriteDrawOptions,
} from "./sprite.js";
