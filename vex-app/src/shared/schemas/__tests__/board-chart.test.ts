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

describe("the volume histogram's count is checked against the array it counts", () => {
  function seriesResult(
    volumes: readonly (string | null)[],
    volumelessBars: number,
  ): unknown {
    return {
      subject: SUBJECT,
      resolution: "2h",
      outcome: {
        kind: "series",
        series: {
          bars: volumes.map((_, index) => ({
            tMs: 1_787_700_000_000 + index * 7_200_000,
            o: "1.5",
            h: "1.9",
            l: "1.4",
            c: "1.8",
          })),
          lastBarPartial: false,
          coveredRange: {
            fromMs: 1_787_700_000_000,
            toMs: 1_787_700_000_000 + volumes.length * 7_200_000,
          },
          resolution: "2h",
          truncated: false,
        },
        requestedBars: volumes.length,
        providerBars: volumes.length,
        undrawableBars: 0,
        windowedOutBars: 0,
        volumes,
        volumelessBars,
        fetchedAtMs: 1_787_741_000_000,
      },
    };
  }

  it("accepts a count that equals the nulls in `volumes`", () => {
    expect(
      boardChartPollResultSchema.safeParse(
        seriesResult(["10", null, "30", null], 2),
      ).success,
    ).toBe(true);
  });

  it("refuses a count that UNDERSTATES the whitespace the histogram will show", () => {
    expect(
      boardChartPollResultSchema.safeParse(
        seriesResult(["10", null, "30", null], 1),
      ).success,
    ).toBe(false);
  });

  it("refuses a count that overstates it", () => {
    expect(
      boardChartPollResultSchema.safeParse(seriesResult(["10", "20"], 1)).success,
    ).toBe(false);
  });
});

describe("the identity key", () => {
  it("lower-cases both halves, because providers vary case", () => {
    expect(boardChartKey({ chain: "Solana", pairAddress: "AbC" })).toBe("solana:abc");
  });
});
