/**
 * The lock screen's one tuning knob (`kimm-lock-tuning.ts`; owner decision 2026-11-16).
 *
 * Regressions this catches:
 *   - intensity 1 drifting from the first lively pass, or a value that does not scale with the knob;
 *   - a capped value (the field's flow, flicker, glow and pulse, the knob itself) passing its cap;
 *   - a module that keeps its own copy of a number instead of reading the knob;
 *   - a depth shift that outgrows its layer's bleed at any intensity the knob allows (an edge would show);
 *   - a parameter the bold rig pushes past the model's own limits, under any input.
 */

import { describe, expect, test } from "vitest";
import { KIMM_FIELD_LIVELY } from "../kimm-field.js";
import { KIMM_LIVE_BLEED } from "../kimm-fit.js";
import {
  clampKimmParam,
  KIMM_LOCK,
  KIMM_LOCK_BASE,
  KIMM_LOCK_INTENSITY,
  KIMM_LOCK_MAX_INTENSITY,
  KIMM_PARAM_LIMITS,
  kimmLockTuning,
} from "../kimm-lock-tuning.js";
import { KIMM_MOTES } from "../kimm-motes.js";
import { KIMM_PARALLAX } from "../kimm-parallax.js";
import { createKimmRig, KIMM_LIFE, KIMM_LIVELY, KIMM_REACT } from "../kimm-rig.js";

/** The field's bleed past the panel (kimm.css). */
const FIELD_BLEED = 12;

describe("the tuning knob", () => {
  test("at 1 it is the first lively pass", () => {
    const one = kimmLockTuning(1);
    expect(one.sway).toBe(KIMM_LOCK_BASE.sway);
    expect(one.bobPx).toBe(KIMM_LOCK_BASE.bobPx);
    expect(one.greetHop).toBe(0.7);
    expect(one.leanZoom).toBe(0.04);
    expect(one.parallax).toEqual({ field: 3, motes: 6, figure: 10 });
    expect(one.actGapMs).toEqual([1400, 3200]);
    expect(one.fieldLively.speed).toBeCloseTo(1.8, 9);
    expect(one.fieldLively.flow).toBeCloseTo(0.85, 9);
    expect(one.fieldLively.pulse).toBeCloseTo(0.45, 9);
    for (const gentle of [one.drift, one.lookGain, one.face, one.blink, one.motesDay]) expect(gentle).toBe(1);
  });

  test("scales every amplitude with the one number, and the pause between moments against it", () => {
    const one = kimmLockTuning(1);
    const two = kimmLockTuning(2);
    for (const key of [
      "sway",
      "bobPx",
      "hop",
      "greetHop",
      "greetTilt",
      "leanBody",
      "leanHead",
      "leanZoom",
      "gesture",
      "shakeDeg",
      "avertTilt",
      "hoverTilt",
    ] as const) {
      expect({ key, value: two[key] }).toEqual({ key, value: one[key] * 2 });
    }
    expect(two.parallax).toEqual({ field: 6, motes: 12, figure: 20 });
    for (const key of ["drift", "lookGain", "face", "blink", "motesDay"] as const) expect(two[key]).toBeGreaterThan(one[key]);
    expect(two.actGapMs[0]).toBeLessThan(one.actGapMs[0]);
    expect(two.actGapMs[1]).toBeLessThan(one.actGapMs[1]);
    expect(two.fieldLively.speed).toBeGreaterThan(one.fieldLively.speed);
  });

  test("holds its caps, and the knob itself between 0 and its ceiling", () => {
    const top = kimmLockTuning(99);
    expect(top.intensity).toBe(KIMM_LOCK_MAX_INTENSITY);
    expect(top.fieldLively.flow).toBeLessThanOrEqual(2);
    expect(top.fieldLively.flicker).toBeLessThanOrEqual(1);
    expect(top.fieldLively.glow).toBeLessThanOrEqual(2);
    expect(top.fieldLively.pulse).toBeLessThanOrEqual(1);
    expect(kimmLockTuning(-5).intensity).toBe(0);
    expect(kimmLockTuning(-5).sway).toBe(0);
  });

  test("never shifts a layer past its bleed, at any intensity the knob allows", () => {
    const top = kimmLockTuning(KIMM_LOCK_MAX_INTENSITY);
    expect(top.parallax.figure).toBeLessThan(KIMM_LIVE_BLEED);
    expect(top.parallax.field).toBeLessThan(FIELD_BLEED);
  });

  test("is the one source: the rig, the depth, the field and the motes read it", () => {
    expect(KIMM_LOCK).toEqual(kimmLockTuning(KIMM_LOCK_INTENSITY));
    expect(KIMM_LIVELY.sway).toBe(KIMM_LOCK.sway);
    expect(KIMM_LIVELY.bobPx).toBe(KIMM_LOCK.bobPx);
    expect(KIMM_LIVELY.actGapMs).toBe(KIMM_LOCK.actGapMs);
    expect(KIMM_LIVELY.fps).toBe(30);
    expect(KIMM_REACT.shakeDeg).toBe(KIMM_LOCK.shakeDeg);
    expect(KIMM_REACT.avertTilt).toBe(KIMM_LOCK.avertTilt);
    expect(KIMM_REACT.hoverTilt).toBe(KIMM_LOCK.hoverTilt);
    expect(KIMM_LIFE.greetHop).toBe(KIMM_LOCK.greetHop);
    expect(KIMM_LIFE.leanZoom).toBe(KIMM_LOCK.leanZoom);
    expect(KIMM_LIFE.nightActGapMs).toBe(KIMM_LOCK.nightActGapMs);
    expect(KIMM_PARALLAX.figure).toBe(KIMM_LOCK.parallax.figure);
    expect(KIMM_FIELD_LIVELY).toBe(KIMM_LOCK.fieldLively);
    expect(KIMM_MOTES.pace.day).toBe(KIMM_LOCK.motesDay);
  });

});

describe("the model's limits", () => {
  test("hold whatever the knob asks", () => {
    expect(clampKimmParam("ParamAngleX", 55)).toBe(30);
    expect(clampKimmParam("ParamBodyAngleX", -14)).toBe(-10);
    expect(clampKimmParam("ParamEyeRSmile", 1.3)).toBe(1);
    expect(clampKimmParam("ParamMouthForm", -2)).toBe(-1);
    expect(clampKimmParam("T7", 1)).toBe(1);
  });

  test("the bold rig never writes a parameter past its limit, under the widest pointer, every reaction and the moments", () => {
    let now = 1000;
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const rig = createKimmRig({ now: () => now, lively: true, random });
    const host = { left: 0, top: 0, width: 720, height: 900 };
    const field = { x: 1080, y: 495 };
    const reactions = [
      "greet",
      "focus",
      "typing",
      "failed",
      "shown",
      "hidden",
      "unlocked",
      "sleep",
      "wake",
      "night",
      "day",
      "blur",
    ] as const;
    for (let t = 0; t < 90_000; t += 33) {
      now += 33;
      if (t % 1500 < 33) rig.pointerMove(t % 3000 < 1500 ? -5000 : 9000, t % 6000 < 3000 ? -4000 : 6000);
      if (t % 2100 < 33) rig.react(reactions[Math.floor(t / 2100) % reactions.length] ?? "blur", field);
      if (t % 4300 < 33) rig.hover(t % 8600 < 4300);
      const { params } = rig.frame(host);
      for (const [id, limits] of Object.entries(KIMM_PARAM_LIMITS)) {
        const value = params.get(id);
        if (value === undefined) continue;
        expect(value, `${id} at ${String(t)}`).toBeGreaterThanOrEqual(limits[0]);
        expect(value, `${id} at ${String(t)}`).toBeLessThanOrEqual(limits[1]);
      }
    }
  });
});
