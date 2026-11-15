/**
 * THE LOCK SCREEN'S LIGHT MOTES, THE MODEL (owner decision 2026-11-15; MOTION-POLICY.md "The lock screen's lively
 * Kimm"). A few soft points of light rise slowly behind her figure, over her glyph field, swaying a little and
 * twinkling, so the lock screen is never quite still while her live figure stands there. Drawn by our own code on
 * one 2D canvas (`KimmMotes.tsx`), no library. Pure: the component and the tests step the same functions.
 *
 * Positions are shares of the box (0 to 1, top to bottom), so a resize never scatters them. A mote that rises past
 * the top comes back in at the foot at a new place.
 */

/** The motes' measures. */
export const KIMM_MOTES = {
  /** How many float at once. */
  count: 14,
  /** The cap on their redraws, as her own ticker's on the lock screen. */
  fps: 30,
  /** Rise speed, in box heights per second (a mote takes about 30 to 80 s to cross). */
  rise: [0.012, 0.032] as const,
  /** Radius in CSS px. */
  radius: [0.8, 2.2] as const,
  /** Peak opacity. */
  alpha: [0.14, 0.42] as const,
  /** Sideways sway, in box widths, and its period range in seconds. */
  sway: 0.012,
  swayS: [5, 11] as const,
  /** Twinkle period range in seconds. */
  twinkleS: [2.5, 6] as const,
  /**
   * Their light: the glyph field's own pale blue and near white (`KIMM_FIELD_RECIPE`'s palette, which the field
   * mixes in its own colour space too), never a sheet token, since the canvas draws them.
   */
  colors: ["#a5d8ff", "#f6f8ff"] as const,
  /** Their pace by the lock screen's: the day's, the night's, sleepy. */
  pace: { day: 1, night: 0.7, drowsy: 0.45 } as const,
} as const;

export interface KimmMote {
  /** Centre, as shares of the box. */
  x: number;
  y: number;
  readonly r: number;
  readonly rise: number;
  readonly alpha: number;
  readonly swayS: number;
  readonly twinkleS: number;
  readonly phase: number;
  readonly color: string;
}

const between = (range: readonly [number, number], u: number): number => range[0] + (range[1] - range[0]) * u;

function mote(random: () => number, y: number): KimmMote {
  return {
    x: random(),
    y,
    r: between(KIMM_MOTES.radius, random()),
    rise: between(KIMM_MOTES.rise, random()),
    alpha: between(KIMM_MOTES.alpha, random()),
    swayS: between(KIMM_MOTES.swayS, random()),
    twinkleS: between(KIMM_MOTES.twinkleS, random()),
    phase: random() * Math.PI * 2,
    color: KIMM_MOTES.colors[random() < 0.7 ? 0 : 1],
  };
}

/** The motes, spread over the whole box. */
export function createMotes(random: () => number = Math.random, count: number = KIMM_MOTES.count): KimmMote[] {
  return Array.from({ length: count }, () => mote(random, random()));
}

/** Advances them by `dt` seconds (at most a tenth of a second, so a stalled window resumes without a jump). */
export function stepMotes(motes: KimmMote[], dt: number, random: () => number = Math.random): void {
  const step = Math.min(0.1, Math.max(0, dt));
  for (let i = 0; i < motes.length; i += 1) {
    const current = motes[i];
    if (current === undefined) continue;
    current.y -= current.rise * step;
    if (current.y < -0.04) motes[i] = mote(random, 1.04);
  }
}

/** Where a mote is drawn at time `t` (seconds), in the box's CSS px, and how bright: its sway, its twinkle, and a fade in and out at the box's foot and top. */
export function motePose(
  m: KimmMote,
  t: number,
  width: number,
  height: number,
): { readonly x: number; readonly y: number; readonly alpha: number } {
  const sway = KIMM_MOTES.sway * Math.sin((t * 2 * Math.PI) / m.swayS + m.phase);
  const twinkle = 0.55 + 0.45 * Math.sin((t * 2 * Math.PI) / m.twinkleS + m.phase);
  const edge = Math.min(1, Math.max(0, Math.min(m.y, 1 - m.y) / 0.12));
  return { x: (m.x + sway) * width, y: m.y * height, alpha: m.alpha * twinkle * edge };
}

/** Whether a frame at `now` is due under the cap, `last` being the last drawn frame's time (ms). */
export function moteFrameDue(now: number, last: number, fps: number = KIMM_MOTES.fps): boolean {
  return last === 0 || now - last >= 1000 / fps - 1;
}
