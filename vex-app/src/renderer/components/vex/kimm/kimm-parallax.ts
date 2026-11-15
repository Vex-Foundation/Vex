/**
 * THE LOCK SCREEN'S DEPTH, THE MODEL (owner decision 2026-11-15; MOTION-POLICY.md "The lock screen's lively Kimm").
 * As the pointer moves over the window, her panel's three layers shift a few pixels against it, the nearer the more,
 * so the scene reads as layered: the glyph field the least, the light motes more, her figure the most. Each shift
 * eases toward its target (a time constant of `tauMs`), and comes home to 0 when the pointer leaves the window.
 * Pure: `use-kimm-parallax.ts` and the tests step the same functions.
 *
 * The shifts never uncover an edge: her live layer and the field bleed past the panel (`KIMM_LIVE_BLEED`,
 * `KIMM_FIELD_BLEED`, kimm.css) by more than their largest shift, and the panel clips them.
 */

/** The largest shift of each layer in CSS px, at the window's edge (x; y is `yShare` of it). */
export const KIMM_PARALLAX = {
  field: 3,
  motes: 6,
  figure: 10,
  /** The vertical shift is this share of the horizontal one (the window is wider than tall). */
  yShare: 0.6,
  /** The easing's time constant. */
  tauMs: 280,
  /** At most this many updates a second, as her own ticker on the lock screen. */
  fps: 30,
} as const;

/** How far the pointer stands from the window's centre, -1 to 1 on each axis. */
export interface KimmParallaxPoint {
  readonly x: number;
  readonly y: number;
}

export const KIMM_PARALLAX_HOME: KimmParallaxPoint = { x: 0, y: 0 };

const clamp = (value: number): number => Math.max(-1, Math.min(1, value));

/** The pointer's place as a share of the window, from its centre. */
export function parallaxTarget(clientX: number, clientY: number, width: number, height: number): KimmParallaxPoint {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return { x: clamp((clientX - w / 2) / (w / 2)), y: clamp((clientY - h / 2) / (h / 2)) };
}

/** One easing step of `dtMs` toward the target (exponential, so a stalled window never overshoots). */
export function easeParallax(current: KimmParallaxPoint, target: KimmParallaxPoint, dtMs: number): KimmParallaxPoint {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / KIMM_PARALLAX.tauMs);
  return { x: current.x + (target.x - current.x) * k, y: current.y + (target.y - current.y) * k };
}

/** Whether the eased point has reached its target (the loop then stops). */
export function parallaxSettled(current: KimmParallaxPoint, target: KimmParallaxPoint): boolean {
  return Math.abs(current.x - target.x) < 0.002 && Math.abs(current.y - target.y) < 0.002;
}

export type KimmParallaxLayer = "field" | "motes" | "figure";

/** A layer's shift in CSS px for an eased point: against the pointer, the nearer layer the more. */
export function parallaxShift(point: KimmParallaxPoint, layer: KimmParallaxLayer): { readonly x: number; readonly y: number } {
  const depth = KIMM_PARALLAX[layer];
  return { x: -point.x * depth, y: -point.y * depth * KIMM_PARALLAX.yShare };
}
