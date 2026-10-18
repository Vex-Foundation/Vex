/**
 * The presence state to K2 emotion map: every state has exactly one emotion,
 * each emotion is shown by exactly one state, the approval hold shows the
 * palm and the rest word shows her idle life.
 */

import { describe, expect, it } from "vitest";
import { K2_EMOTIONS } from "../../../components/vex/k2/k2-emotion.js";
import { poseOf } from "../../../components/vex/k2/k2-poses.js";
import { VEX_EMOTION, vexEmotionOf } from "../vex-emotion.js";
import { VEX_STATES } from "../vex-state.js";

describe("vexEmotionOf", () => {
  it("maps each presence state to her pose", () => {
    expect(VEX_STATES.map((s) => [s, vexEmotionOf(s)])).toEqual([
      ["ready", "idle"],
      ["listening", "listening"],
      ["thinking", "thinking"],
      ["working", "working"],
      ["awaiting", "approval"],
      ["done", "done"],
      ["concerned", "concerned"],
      ["error", "error"],
      ["sleeping", "sleeping"],
      ["waking", "waking"],
    ]);
  });

  it("covers every emotion once and no other", () => {
    const shown = Object.values(VEX_EMOTION);
    expect(new Set(shown).size).toBe(shown.length);
    expect([...shown].sort()).toEqual([...K2_EMOTIONS].sort());
  });

  it("shows the palm while an approval waits and her eyes on the composer while listening", () => {
    expect(poseOf(vexEmotionOf("awaiting"))).toMatchObject({ map: "approve", hand: true });
    expect(poseOf(vexEmotionOf("listening"))).toMatchObject({ look: "composer" });
    expect(poseOf(vexEmotionOf("sleeping"))).toMatchObject({ map: "asleep" });
    expect(poseOf(vexEmotionOf("ready"))).toMatchObject({ map: "base", look: "free" });
  });
});
