/**
 * Her band rests under 1024 (docs/design/H3-DESKTOP.md section 1.10; VEX
 * Cloud's rule (a)): while a turn runs, a card waits or the composer is in
 * use, with the reason her keys say instead of acting.
 */

import { describe, expect, it } from "vitest";
import { BAND_HOLD_REASONS, bandHoldOf } from "../band-hold.js";
import { VEX_STATES } from "../vex-state.js";

describe("bandHoldOf", () => {
  it("rests through a turn and a waiting card, with Cloud's words", () => {
    expect(bandHoldOf("thinking", false)).toBe("Vex shows her section after this turn.");
    expect(bandHoldOf("working", false)).toBe(BAND_HOLD_REASONS.turn);
    expect(bandHoldOf("awaiting", false)).toBe(BAND_HOLD_REASONS.turn);
  });

  it("rests while the person types, and the turn's reason comes first", () => {
    expect(bandHoldOf("ready", true)).toBe("Vex steps aside while you type.");
    expect(bandHoldOf("awaiting", true)).toBe(BAND_HOLD_REASONS.turn);
  });

  it("stands in every other moment", () => {
    for (const state of VEX_STATES) {
      if (state === "thinking" || state === "working" || state === "awaiting") continue;
      expect(bandHoldOf(state, false), state).toBeNull();
    }
  });
});
