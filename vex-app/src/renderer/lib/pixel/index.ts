/**
 * The pixel core: the seeded generator, the 4x4 Bayer dither and the canvas
 * helpers the K2 hologram draws through. It touches the canvas only when one
 * is created or drawn on.
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
