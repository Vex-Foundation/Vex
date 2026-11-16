/**
 * The lock screen's life in her rig (`KIMM_LIFE`, `KIMM_MOMENTS`; owner decision 2026-11-15), on a manual clock.
 *
 * Regressions this catches:
 *   - a greeting without its hop, smile and tilt, that does not end on the field, outlasts 2.5 s, or that typing does
 *     not interrupt (focus, as the screen opens, must not);
 *   - a lean that does not ease in on focus or typing, overshoots its zoom, or never eases back;
 *   - the priority order broken: Show, a refusal or the unlock must stand her back from the lean and end the greeting;
 *   - moments that repeat back to back, never chain their steps, or start while she greets or is sleepy;
 *   - sleepiness without its half-closed eyes, slower breath and yawns, or a wake without its perk;
 *   - a night that is not calmer than the day;
 *   - any of it reaching the calm card or reduced motion.
 */

import { describe, expect, test } from "vitest";
import { KIMM_MOMENT_NAMES, KIMM_MOMENTS, momentMs, pickMoment } from "../kimm-moments.js";
import { createKimmRig, KIMM_LIFE } from "../kimm-rig.js";

const HOST = { left: 0, top: 0, width: 720, height: 900 };
const FIELD = { x: 1080, y: 495 };

function clockAt(start = 1000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

type Rig = ReturnType<typeof createKimmRig>;
type Frame = ReturnType<Rig["frame"]>;

function run(rig: Rig, clock: ReturnType<typeof clockAt>, ms: number, each?: (frame: Frame) => void): Frame {
  let frame = rig.frame(HOST);
  for (let t = 0; t < ms; t += 33) {
    clock.advance(33);
    frame = rig.frame(HOST);
    each?.(frame);
  }
  return frame;
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function livelyRig(options: { idle?: boolean; random?: () => number; reducedMotion?: boolean; lively?: boolean } = {}) {
  const clock = clockAt();
  const rig = createKimmRig({
    now: clock.now,
    lively: options.lively ?? true,
    idle: options.idle ?? false,
    random: options.random ?? seeded(3),
    reducedMotion: options.reducedMotion ?? false,
  });
  rig.frame(HOST);
  return { clock, rig };
}

describe("her greeting", () => {
  test("a hop, a smile, a tilt toward the viewer, then her gaze settles on the field, in about 2 s", () => {
    const { clock, rig } = livelyRig();
    rig.react("greet", FIELD);
    expect(rig.state.greeting).toBe(true);
    let lowest = 0;
    let tilt = 0;
    const early = run(rig, clock, 700, (frame) => {
      lowest = Math.min(lowest, frame.y);
      tilt = Math.max(tilt, frame.params.get("ParamAngleZ") ?? 0);
    });
    expect(lowest).toBeLessThan(-4);
    expect(tilt).toBeGreaterThan(4);
    expect(early.params.get("ParamMouthForm") ?? 0).toBeGreaterThan(0.6);
    // toward the viewer first: the eyes near the middle
    expect(Math.abs(early.params.get("ParamEyeBallX") ?? 1)).toBeLessThan(0.35);
    // then the field, to her side
    const late = run(rig, clock, 1100);
    expect(late.params.get("ParamEyeBallX") ?? 0).toBeGreaterThan(0.6);
    run(rig, clock, 300);
    expect(rig.state.greeting).toBe(false);
    expect(KIMM_LIFE.greetMs).toBeGreaterThanOrEqual(1500);
    expect(KIMM_LIFE.greetMs).toBeLessThanOrEqual(2500);
  });

  test("typing interrupts it at once; the field's focus as the screen opens does not", () => {
    const typed = livelyRig();
    typed.rig.react("greet", FIELD);
    run(typed.rig, typed.clock, 300);
    typed.rig.react("typing", FIELD);
    expect(typed.rig.state.greeting).toBe(false);
    const focused = livelyRig();
    focused.rig.react("greet", FIELD);
    focused.rig.react("focus", FIELD);
    run(focused.rig, focused.clock, 600);
    expect(focused.rig.state.greeting).toBe(true);
    // the lean waits for the greeting
    expect(focused.rig.state.lean).toBeLessThan(0.05);
    run(focused.rig, focused.clock, 2400);
    expect(focused.rig.state.lean).toBeGreaterThan(0.5);
  });

  test("no moment starts while she greets", () => {
    const { clock, rig } = livelyRig({ idle: true });
    rig.react("greet", FIELD);
    run(rig, clock, KIMM_LIFE.greetMs - 100, () => {
      expect(rig.state.act).toBeNull();
    });
  });
});

describe("her lean", () => {
  test("eases in on focus toward the field, a step closer, and eases back on blur", () => {
    const { clock, rig } = livelyRig();
    const before = run(rig, clock, 500);
    rig.react("focus", FIELD);
    let zoom = 1;
    const leaning = run(rig, clock, 1500, (frame) => {
      expect(frame.zoom).toBeGreaterThanOrEqual(zoom - 1e-9);
      zoom = frame.zoom;
    });
    expect(rig.state.lean).toBeGreaterThan(0.9);
    expect(leaning.zoom).toBeGreaterThan(1.03);
    expect(leaning.zoom).toBeLessThanOrEqual(1 + KIMM_LIFE.leanZoom);
    expect((leaning.params.get("ParamBodyAngleX") ?? 0) - (before.params.get("ParamBodyAngleX") ?? 0)).toBeGreaterThan(4);
    rig.react("blur");
    const back = run(rig, clock, 2000);
    expect(rig.state.lean).toBeLessThan(0.05);
    expect(back.zoom).toBeLessThan(1.003);
  });

  test("typing keeps her leaning; a few quiet seconds ease her back", () => {
    const { clock, rig } = livelyRig();
    for (let i = 0; i < 6; i += 1) {
      rig.react("typing", FIELD);
      run(rig, clock, 500);
    }
    expect(rig.state.lean).toBeGreaterThan(0.9);
    run(rig, clock, KIMM_LIFE.leanHoldMs + 2000);
    expect(rig.state.lean).toBeLessThan(0.05);
  });
});

describe("the priority order", () => {
  const leaning = () => {
    const made = livelyRig();
    made.rig.react("focus", FIELD);
    run(made.rig, made.clock, 1500);
    expect(made.rig.state.lean).toBeGreaterThan(0.9);
    return made;
  };

  test("Show stands her back from the lean and looks away; Hide lets her lean again while focused", () => {
    const { clock, rig } = leaning();
    rig.react("shown");
    const away = run(rig, clock, 1500);
    expect(rig.state.lean).toBeLessThan(0.05);
    expect(away.params.get("ParamEyeBallX") ?? 0).toBeLessThan(-0.6);
    rig.react("hidden");
    rig.react("focus", FIELD);
    run(rig, clock, 1500);
    expect(rig.state.lean).toBeGreaterThan(0.9);
  });

  test("a refusal ends the lean and the greeting, with her refused mood", () => {
    const { clock, rig } = leaning();
    rig.react("greet", FIELD);
    rig.react("failed");
    expect(rig.state.greeting).toBe(false);
    expect(rig.state.mood).toBe("no");
    run(rig, clock, 1500);
    expect(rig.state.lean).toBeLessThan(0.05);
    // typing during the refusal does not lean her back in while her arms are crossed
    rig.react("typing", FIELD);
    run(rig, clock, 800);
    expect(rig.state.lean).toBeLessThan(0.05);
  });

  test("the unlock's beat ends the lean, the greeting and Show", () => {
    const { clock, rig } = leaning();
    rig.react("shown");
    rig.react("greet", FIELD);
    rig.react("unlocked");
    expect(rig.state.averted).toBe(false);
    expect(rig.state.greeting).toBe(false);
    expect(rig.state.mood).toBe("v");
    run(rig, clock, 1500);
    expect(rig.state.lean).toBeLessThan(0.05);
  });

  test("a greeting while the password shows is not played", () => {
    const { rig } = livelyRig();
    rig.react("shown");
    rig.react("greet", FIELD);
    expect(rig.state.greeting).toBe(false);
  });
});

describe("her idle moments", () => {
  test("a library of chained moments, each of two steps or more, a few seconds long", () => {
    expect(KIMM_MOMENT_NAMES.length).toBeGreaterThanOrEqual(6);
    for (const name of KIMM_MOMENT_NAMES) {
      expect(momentMs(name)).toBeGreaterThan(2000);
      expect(momentMs(name)).toBeLessThan(5000);
    }
    const chained = KIMM_MOMENT_NAMES.filter((name) => KIMM_MOMENTS[name].length >= 2);
    expect(chained.length).toBe(KIMM_MOMENT_NAMES.length);
  });

  test("never the same one twice in a row, even when chance asks for it", () => {
    for (const random of [() => 0, () => 0.999, seeded(5)]) {
      let last: string | null = null;
      for (let i = 0; i < 200; i += 1) {
        const next = pickMoment(random, last);
        expect(next).not.toBe(last);
        last = next;
      }
    }
  });

  test("the lively rig plays moments step by step, never one back to back, never in the calm card", () => {
    const { clock, rig } = livelyRig({ idle: true, random: seeded(9) });
    const played: string[] = [];
    let steps = 0;
    let previous: string | null = null;
    run(rig, clock, 120_000, () => {
      const act = rig.state.act;
      if (act !== null && act !== previous) played.push(act);
      if ((rig.state.step ?? 0) > 0) steps += 1;
      previous = act;
    });
    expect(played.length).toBeGreaterThan(12);
    for (let i = 1; i < played.length; i += 1) expect(played[i]).not.toBe(played[i - 1]);
    for (const name of played) expect(KIMM_MOMENT_NAMES).toContain(name);
    expect(steps).toBeGreaterThan(0);
    // the calm card keeps Cloud's lone acts
    const calm = livelyRig({ idle: true, lively: false, random: seeded(9) });
    const calmActs = new Set<string>();
    run(calm.rig, calm.clock, 60_000, () => {
      if (calm.rig.state.act !== null) calmActs.add(calm.rig.state.act);
    });
    for (const name of calmActs) expect(KIMM_MOMENT_NAMES).not.toContain(name);
  });
});

describe("sleepy", () => {
  test("half-closed eyes, a slower breath, a yawn-like head drop, no moments; a wake perks her up", () => {
    const { clock, rig } = livelyRig({ idle: true });
    const breaths = (ms: number) => {
      let rises = 0;
      let last = 0;
      run(rig, clock, ms, (frame) => {
        const breath = frame.params.get("ParamBreath") ?? 0;
        if (last < 0.5 && breath >= 0.5) rises += 1;
        last = breath;
      });
      return rises;
    };
    const awake = breaths(20_000);
    rig.react("sleep");
    run(rig, clock, 5000);
    expect(rig.state.sleep).toBeGreaterThan(0.95);
    let lowestNod = 0;
    let shut = 0;
    const asleep = (() => {
      let rises = 0;
      let last = 0;
      run(rig, clock, 20_000, (frame) => {
        expect(rig.state.act).toBeNull();
        const breath = frame.params.get("ParamBreath") ?? 0;
        if (last < 0.5 && breath >= 0.5) rises += 1;
        last = breath;
        lowestNod = Math.min(lowestNod, frame.params.get("ParamAngleY") ?? 0);
        shut = Math.max(shut, frame.shut);
      });
      return rises;
    })();
    expect(asleep).toBeLessThan(awake);
    expect(shut).toBeGreaterThan(KIMM_LIFE.sleepShut - 0.05);
    expect(lowestNod).toBeLessThan(-8);
    rig.react("wake");
    let perk = 0;
    run(rig, clock, 600, (frame) => {
      perk = Math.min(perk, frame.y);
    });
    expect(perk).toBeLessThan(-2.5);
    run(rig, clock, 5000);
    expect(rig.state.sleep).toBeLessThan(0.05);
  });
});

describe("night", () => {
  test("calmer: fewer moments and a slower sway than the day", () => {
    const count = (atNight: boolean) => {
      const { clock, rig } = livelyRig({ idle: true, random: seeded(13) });
      if (atNight) rig.react("night");
      let moments = 0;
      let previous: string | null = null;
      let swayFlips = 0;
      let lastZ = 0;
      run(rig, clock, 120_000, (frame) => {
        const act = rig.state.act;
        if (act !== null && act !== previous) moments += 1;
        previous = act;
        const z = frame.params.get("ParamBodyAngleZ") ?? 0;
        if (Math.sign(z) !== Math.sign(lastZ)) swayFlips += 1;
        lastZ = z;
      });
      return { moments, swayFlips };
    };
    const day = count(false);
    const night = count(true);
    expect(night.moments).toBeLessThan(day.moments);
    expect(night.swayFlips).toBeLessThan(day.swayFlips);
  });
});

describe("off where it must be", () => {
  test("the calm card neither greets, leans nor zooms", () => {
    const { clock, rig } = livelyRig({ lively: false });
    rig.react("greet", FIELD);
    rig.react("focus", FIELD);
    const frame = run(rig, clock, 1500);
    expect(rig.state.greeting).toBe(false);
    expect(rig.state.lean).toBe(0);
    expect(frame.zoom).toBe(1);
  });

  test("reduced motion: no zoom, no bounce", () => {
    const { clock, rig } = livelyRig({ reducedMotion: true });
    rig.react("greet", FIELD);
    rig.react("focus", FIELD);
    run(rig, clock, 3000, (frame) => {
      expect(frame.zoom).toBe(1);
      expect(frame.y).toBe(0);
    });
  });
});
