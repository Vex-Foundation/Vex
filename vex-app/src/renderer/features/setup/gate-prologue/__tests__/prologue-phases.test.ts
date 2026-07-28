/**
 * Prologue choreography — act boundaries, progress, and the crossfade ramp.
 *
 * The assertions name the owner's timeline in wall-clock terms (acts end at
 * 0.8s / 2.2s / 3.5s) and check the REAL functions against it, so a retune of
 * the constants that breaks the specified shape fails here.
 */

import { describe, expect, it } from "vitest";

import {
  CONDENSED_TIMELINE,
  FULL_TIMELINE,
  actAt,
  actProgress,
  holdOpacityAt,
  timelineFor,
} from "../prologue-phases.js";

describe("timelineFor", () => {
  it("maps the two play variants to their timelines", () => {
    expect(timelineFor("full")).toBe(FULL_TIMELINE);
    expect(timelineFor("condensed")).toBe(CONDENSED_TIMELINE);
  });

  it("keeps each timeline's totalMs equal to the sum of its acts", () => {
    for (const t of [FULL_TIMELINE, CONDENSED_TIMELINE]) {
      expect(t.fieldMs + t.globeMs + t.signatureMs + t.settleMs).toBe(t.totalMs);
    }
  });

  it("holds the condensed variant to roughly 1.2s", () => {
    expect(CONDENSED_TIMELINE.totalMs).toBeLessThanOrEqual(1200);
  });
});

describe("actAt — full timeline", () => {
  it("walks field → globe → signature → settle → done at the owner's boundaries", () => {
    expect(actAt(FULL_TIMELINE, 0)).toBe("field");
    expect(actAt(FULL_TIMELINE, 799)).toBe("field");
    // 0.8s: the star field converges into the globe.
    expect(actAt(FULL_TIMELINE, 800)).toBe("globe");
    expect(actAt(FULL_TIMELINE, 2199)).toBe("globe");
    // 2.2s: the sphere breaks orbit onto the letterforms.
    expect(actAt(FULL_TIMELINE, 2200)).toBe("signature");
    expect(actAt(FULL_TIMELINE, 3099)).toBe("signature");
    expect(actAt(FULL_TIMELINE, 3100)).toBe("settle");
    // 3.5s: the prologue is over.
    expect(actAt(FULL_TIMELINE, 3500)).toBe("done");
    expect(actAt(FULL_TIMELINE, 99999)).toBe("done");
  });
});

describe("actAt — condensed timeline", () => {
  it("never reports the zero-length field or globe acts", () => {
    expect(actAt(CONDENSED_TIMELINE, 0)).toBe("signature");
    expect(actAt(CONDENSED_TIMELINE, 400)).toBe("signature");
    expect(actAt(CONDENSED_TIMELINE, 900)).toBe("settle");
    expect(actAt(CONDENSED_TIMELINE, 1200)).toBe("done");
  });
});

describe("actProgress", () => {
  it("reports normalised progress inside the current act", () => {
    expect(actProgress(FULL_TIMELINE, 0)).toEqual({ act: "field", t: 0 });
    expect(actProgress(FULL_TIMELINE, 400)).toEqual({ act: "field", t: 0.5 });
    // 700ms into the 1400ms globe act.
    expect(actProgress(FULL_TIMELINE, 1500)).toEqual({ act: "globe", t: 0.5 });
    expect(actProgress(FULL_TIMELINE, 3300)).toEqual({ act: "settle", t: 0.5 });
  });

  it("reports t=1 once done, and never divides by a zero-length act", () => {
    expect(actProgress(FULL_TIMELINE, 3500)).toEqual({ act: "done", t: 1 });
    const condensedStart = actProgress(CONDENSED_TIMELINE, 0);
    expect(condensedStart.act).toBe("signature");
    expect(Number.isFinite(condensedStart.t)).toBe(true);
    expect(condensedStart.t).toBe(0);
  });
});

describe("holdOpacityAt — the crossfade to the real hold content", () => {
  it("keeps the hold content invisible for the whole cinematic", () => {
    expect(holdOpacityAt(FULL_TIMELINE, 0)).toBe(0);
    expect(holdOpacityAt(FULL_TIMELINE, 2000)).toBe(0);
    // Still hidden at the very end of the signature act.
    expect(holdOpacityAt(FULL_TIMELINE, 3100)).toBe(0);
  });

  it("ramps 0 → 1 across the settle and stays there", () => {
    expect(holdOpacityAt(FULL_TIMELINE, 3300)).toBeCloseTo(0.5, 5);
    expect(holdOpacityAt(FULL_TIMELINE, 3500)).toBe(1);
    expect(holdOpacityAt(FULL_TIMELINE, 9999)).toBe(1);
  });

  it("ramps over the condensed settle too", () => {
    expect(holdOpacityAt(CONDENSED_TIMELINE, 900)).toBe(0);
    expect(holdOpacityAt(CONDENSED_TIMELINE, 1050)).toBeCloseTo(0.5, 5);
    expect(holdOpacityAt(CONDENSED_TIMELINE, 1200)).toBe(1);
  });
});
