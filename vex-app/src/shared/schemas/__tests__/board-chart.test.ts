/**
 * The chart channel's wire contract.
 *
 * TWO THINGS ARE PROVEN HERE and neither is a formality.
 *
 * FIRST, the pill vocabulary is PINNED TO THE BOARD'S OWN RESOLUTION LIST
 * rather than spelled from convention. Rule 10 makes a hand-written wire name a
 * defect even when it happens to be correct, and this contract's four members
 * are the four the provider vocabulary carries.
 *
 * SECOND, the input is a POSITIVE PICK. A subtractive rule would let every
 * field added to the board's pool shape later become admissible on a channel
 * that has no business carrying it, which is exactly how the model's `analysis`
 * prose nearly crossed a live poll boundary.
 */

import { describe, expect, it } from "vitest";
import { BOARD_CHART_RESOLUTIONS } from "@vex-lib/board/index.js";
import {
  BOARD_CHART_PILL_RESOLUTIONS,
  boardChartKey,
  boardChartPollInputSchema,
  boardChartPollResultSchema,
} from "../board-chart.js";

const SUBJECT = {
  chain: "solana",
  pairAddress: "22CfmLna8Bsh7xrbyvGSs6NdD31iFj1UFVnwB7EberWU",
};

describe("the pill vocabulary comes from the board's resolution list", () => {
  it.each(BOARD_CHART_PILL_RESOLUTIONS)(
    "%s is a member of BOARD_CHART_RESOLUTIONS",
    (resolution) => {
      expect(BOARD_CHART_RESOLUTIONS).toContain(resolution);
    },
  );

  it("is exactly the four pills of the mockup, in pill order", () => {
    expect(BOARD_CHART_PILL_RESOLUTIONS).toEqual(["1m", "15m", "2h", "8h"]);
  });
});

describe("the input accepts the four pills and refuses everything else", () => {
  it.each(BOARD_CHART_PILL_RESOLUTIONS)("accepts %s", (resolution) => {
    expect(
      boardChartPollInputSchema.safeParse({ subject: SUBJECT, resolution }).success,
    ).toBe(true);
  });

  it.each(
    BOARD_CHART_RESOLUTIONS.filter(
      (resolution) =>
        !(BOARD_CHART_PILL_RESOLUTIONS as readonly string[]).includes(resolution),
    ),
  )("refuses the non-pill board resolution %s", (resolution) => {
    // Fourteen of the board's eighteen resolutions are refused here. Nobody
    // sized a window, a cadence or a politeness budget for them.
    expect(
      boardChartPollInputSchema.safeParse({ subject: SUBJECT, resolution }).success,
    ).toBe(false);
  });

  it.each([
    ["the agent's caption", { caption: "deepest pool" }],
    ["the model's assessment", { analysis: "Looks clean." }],
  ])("refuses a pool document field beside the identity: %s", (_label, extra) => {
    expect(
      boardChartPollInputSchema.safeParse({
        subject: { ...SUBJECT, ...extra },
        resolution: "1m",
      }).success,
    ).toBe(false);
  });

  it.each([
    ["a bar count", { countBack: 999 }],
    ["a deadline", { timeoutMs: 1 }],
    ["a transport", { transport: "feed_ws" }],
  ])("refuses a main-owned knob: %s", (_label, extra) => {
    expect(
      boardChartPollInputSchema.safeParse({
        subject: SUBJECT,
        resolution: "1m",
        ...extra,
      }).success,
    ).toBe(false);
  });
});

describe("the result carries the resolution it was read at", () => {
  it("refuses a result with no resolution echo", () => {
    expect(
      boardChartPollResultSchema.safeParse({
        subject: SUBJECT,
        outcome: { kind: "absent", reason: "no_drawable_bars" },
      }).success,
    ).toBe(false);
  });

  it("accepts an unavailable outcome as an ordinary answer", () => {
    expect(
      boardChartPollResultSchema.safeParse({
        subject: SUBJECT,
        resolution: "2h",
        outcome: { kind: "unavailable", reason: "cancelled" },
      }).success,
    ).toBe(true);
  });
});

describe("the identity key", () => {
  it("lower-cases both halves, because providers vary case", () => {
    expect(boardChartKey({ chain: "Solana", pairAddress: "AbC" })).toBe("solana:abc");
  });
});
