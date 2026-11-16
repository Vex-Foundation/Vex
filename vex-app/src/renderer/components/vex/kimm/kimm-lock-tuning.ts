/**
 * THE LOCK SCREEN'S ONE TUNING KNOB (owner decision 2026-11-16: "she moves but i want more obvious moves"). Every
 * amplitude and cadence of the lock screen's lively Kimm comes from here, scaled by one number, `intensity`:
 * 1 is the first lively pass (2026-11-15), `KIMM_LOCK_INTENSITY` is what the app ships. To tune her, change that one
 * number; MOTION-POLICY.md "The lock screen's lively Kimm" lists what each value becomes.
 *
 * How each scales with `a` (the intensity, held between 0 and `KIMM_LOCK_MAX_INTENSITY`):
 *   - straight with `a`: her sway, her bob, the greeting's hop and tilt, the moments' hops and angles, the lean's
 *     angles and step closer, the reactions' head shake and tilts, the depth's three distances;
 *   - gentler, `1 + k (a - 1)`: the gaze's drift (0.5), how far the pointer turns her head (0.4), the smiles (0.3),
 *     the blink rate (0.3), the motes' day pace (0.4); the pause between moments divides by `1 + 0.5 (a - 1)`;
 *   - the field's lively tempo grows from the calm field toward its caps (flow 2, flicker 1, glow 2, pulse 1);
 *   - her breath (`ParamBreath`) already swings through the model's whole range at 1: it cannot grow, so her bob
 *     carries the bigger breath.
 * Whatever the intensity, the rig clamps every parameter to the model's own limits (`KIMM_PARAM_LIMITS`, read from the
 * shipped moc), and her layer's bleed (`KIMM_LIVE_BLEED` 32, the field's 12) stays wider than the largest depth shift
 * the knob allows, so no edge of the panel ever shows. The 30 fps cap and every gate are not part of the knob.
 *
 * Off the lock screen nothing here applies: the Vex card keeps Cloud's calm rig.
 */

/** The intensity the app ships (1 is the first lively pass). */
export const KIMM_LOCK_INTENSITY = 1;

/** The knob's ceiling: above it the depth would outgrow her layer's bleed. */
export const KIMM_LOCK_MAX_INTENSITY = 3;

/** The values at intensity 1 (the first lively pass, 2026-11-15). */
export const KIMM_LOCK_BASE = {
  sway: 1.8,
  bobPx: 2.4,
  hop: 1,
  greetHop: 0.7,
  greetTilt: 8,
  leanBody: 7,
  leanHead: 4,
  leanZoom: 0.04,
  gesture: 1,
  shakeDeg: 12,
  avertTilt: 7,
  hoverTilt: 5,
  actGapMs: [1400, 3200] as const,
  nightActGapMs: [2600, 6000] as const,
  parallax: { field: 3, motes: 6, figure: 10 } as const,
  fieldLively: { speed: 1.8, flow: 0.85, flicker: 0.32, glow: 0.4, pulse: 0.45 } as const,
} as const;

export interface KimmLockTuning {
  readonly intensity: number;
  /** The lively sway, as a multiple of Cloud's calm sway. */
  readonly sway: number;
  /** Her bob on each breath, in px at its top. */
  readonly bobPx: number;
  /** The gaze's slow drift around centre, as a multiple of Cloud's (60 by 24 px). */
  readonly drift: number;
  /** How far the pointer turns her head, as a multiple of Cloud's 28 degrees per 520 px. */
  readonly lookGain: number;
  /** The multiple of every hop she makes in lively mode (the moments, the wake, the unlock's beat). */
  readonly hop: number;
  readonly greetHop: number;
  readonly greetTilt: number;
  readonly leanBody: number;
  readonly leanHead: number;
  readonly leanZoom: number;
  /** The multiple of the moments' head and body angles. */
  readonly gesture: number;
  /** The multiple of the moments' and greeting's smiles (clamped at the model's 1). */
  readonly face: number;
  /** The multiple of her blink rate. */
  readonly blink: number;
  readonly shakeDeg: number;
  readonly avertTilt: number;
  readonly hoverTilt: number;
  readonly actGapMs: readonly [number, number];
  readonly nightActGapMs: readonly [number, number];
  readonly parallax: { readonly field: number; readonly motes: number; readonly figure: number };
  readonly fieldLively: {
    readonly speed: number;
    readonly flow: number;
    readonly flicker: number;
    readonly glow: number;
    readonly pulse: number;
  };
  /** The motes' pace by day. */
  readonly motesDay: number;
}

const gentle = (a: number, k: number): number => 1 + k * (a - 1);

/** Every lock-screen amplitude and cadence at an intensity. */
export function kimmLockTuning(intensity: number): KimmLockTuning {
  const a = Math.max(0, Math.min(KIMM_LOCK_MAX_INTENSITY, intensity));
  const B = KIMM_LOCK_BASE;
  const gap = (range: readonly [number, number]): readonly [number, number] => {
    const pace = Math.max(0.25, gentle(a, 0.5));
    return [Math.round(range[0] / pace), Math.round(range[1] / pace)];
  };
  return {
    intensity: a,
    sway: B.sway * a,
    bobPx: B.bobPx * a,
    drift: Math.max(0, gentle(a, 0.5)),
    lookGain: Math.max(0, gentle(a, 0.4)),
    hop: B.hop * a,
    greetHop: B.greetHop * a,
    greetTilt: B.greetTilt * a,
    leanBody: B.leanBody * a,
    leanHead: B.leanHead * a,
    leanZoom: B.leanZoom * a,
    gesture: B.gesture * a,
    face: Math.max(0, gentle(a, 0.3)),
    blink: Math.max(0.25, gentle(a, 0.3)),
    shakeDeg: B.shakeDeg * a,
    avertTilt: B.avertTilt * a,
    hoverTilt: B.hoverTilt * a,
    actGapMs: gap(B.actGapMs),
    nightActGapMs: gap(B.nightActGapMs),
    parallax: { field: B.parallax.field * a, motes: B.parallax.motes * a, figure: B.parallax.figure * a },
    fieldLively: {
      speed: 1 + 0.8 * a,
      flow: Math.min(2, 0.5 + 0.35 * a),
      flicker: Math.min(1, 0.2 + 0.12 * a),
      glow: Math.min(2, 0.2 + 0.2 * a),
      pulse: Math.min(1, B.fieldLively.pulse * a),
    },
    motesDay: Math.max(0.25, gentle(a, 0.4)),
  };
}

/** What the lock screen runs. */
export const KIMM_LOCK: KimmLockTuning = kimmLockTuning(KIMM_LOCK_INTENSITY);

/**
 * The model's own limits for the parameters her rig writes (read from the shipped `kimm.moc.wasm`, 2026-11-16):
 * the rig clamps to them in lively mode, so no intensity can push a mesh past what was drawn.
 */
export const KIMM_PARAM_LIMITS: Readonly<Record<string, readonly [number, number]>> = {
  ParamAngleX: [-30, 30],
  ParamAngleY: [-30, 30],
  ParamAngleZ: [-30, 30],
  ParamBodyAngleX: [-10, 10],
  ParamBodyAngleY: [-10, 10],
  ParamBodyAngleZ: [-10, 10],
  ParamEyeBallX: [-1, 1],
  ParamEyeBallY: [-1, 1],
  ParamEyeRSmile: [0, 1],
  ParamMouthForm: [-1, 1],
  ParamMouthOpenY: [0, 1],
  ParamBreath: [0, 1],
};

/** A parameter's value held inside the model's limits (unchanged for a parameter without one). */
export function clampKimmParam(id: string, value: number): number {
  const limits = KIMM_PARAM_LIMITS[id];
  return limits === undefined ? value : Math.max(limits[0], Math.min(limits[1], value));
}
