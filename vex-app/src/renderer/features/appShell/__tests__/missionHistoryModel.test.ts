/**
 * Mission History display model — pure functions. The key invariant under
 * test: `missionDisplayOutcome` maps a deadline-reached run to the neutral
 * "timeBoxed" outcome (never "failed"), and that outcome counts as a
 * completion for win-rate purposes — deadline semantics stay out of SQL and
 * UI components, living ONLY in this one pure mapper.
 */

import { describe, it, expect } from "vitest";
import type { MissionResultDto } from "@shared/schemas/mission.js";
import {
  computeWinRate,
  formatDurationS,
  formatEth,
  isCompletionLike,
  missionDisplayOutcome,
  pnlUsd,
  sumPnlEth,
} from "../missionHistoryModel.js";
import { NO_CONSTRAINTS } from "./_missionResultFixture.js";

function result(over: Partial<MissionResultDto> = {}): MissionResultDto {
  return {
    missionRunId: "run-1",
    sessionId: "00000000-0000-4000-8000-000000000001",
    seqNo: 1,
    goalSnippet: "grow ETH",
    goalFull: "grow ETH",
    missionTitle: null,
    constraints: NO_CONSTRAINTS,
    startedAt: "2026-07-12T18:00:00.000Z",
    endedAt: "2026-07-12T19:00:00.000Z",
    durationS: 3600,
    bankrollStartEth: 0.01,
    bankrollEndEth: 0.011,
    pnlEth: 0.001,
    pnlPct: 10,
    ethPriceUsdEnd: 3000,
    trades: 2,
    // Prose is irrelevant to this mapper — it only ever reads the numbers.
    stopSummary: null,
    outcome: "completed",
    stopReason: "goal_reached",
    openPositionsCount: 0,
    ...over,
  };
}

describe("missionDisplayOutcome", () => {
  it("maps a deadline-reached, non-completed run to the neutral timeBoxed outcome", () => {
    expect(
      missionDisplayOutcome({ outcome: "failed", stopReason: "deadline_reached" }),
    ).toBe("timeBoxed");
  });

  it("does not remap deadline_reached when the outcome is already completed", () => {
    expect(
      missionDisplayOutcome({ outcome: "completed", stopReason: "deadline_reached" }),
    ).toBe("completed");
  });

  it("passes through every other (outcome, stopReason) pair unchanged", () => {
    expect(missionDisplayOutcome({ outcome: "completed", stopReason: "goal_reached" })).toBe("completed");
    expect(missionDisplayOutcome({ outcome: "cancelled", stopReason: "user_stopped" })).toBe("cancelled");
    expect(missionDisplayOutcome({ outcome: "failed", stopReason: "system_error" })).toBe("failed");
    expect(missionDisplayOutcome({ outcome: "stopped", stopReason: "user_stopped" })).toBe("stopped");
    expect(missionDisplayOutcome({ outcome: "running", stopReason: null })).toBe("running");
    expect(missionDisplayOutcome({ outcome: "failed", stopReason: null })).toBe("failed");
  });
});

describe("isCompletionLike", () => {
  it("is true for completed and timeBoxed only", () => {
    expect(isCompletionLike("completed")).toBe(true);
    expect(isCompletionLike("timeBoxed")).toBe(true);
    expect(isCompletionLike("cancelled")).toBe(false);
    expect(isCompletionLike("failed")).toBe(false);
    expect(isCompletionLike("stopped")).toBe(false);
    expect(isCompletionLike("running")).toBe(false);
  });
});

describe("computeWinRate", () => {
  it("counts a deadline_reached (timeBoxed) run as a completion in the win-rate population", () => {
    const results = [
      result({ missionRunId: "a", outcome: "completed", stopReason: "goal_reached", pnlEth: 0.002 }),
      result({ missionRunId: "b", outcome: "failed", stopReason: "deadline_reached", pnlEth: -0.001 }),
    ];
    // Both are completion-like (timeBoxed counts) -> population of 2, 1 win.
    expect(computeWinRate(results)).toBe(50);
  });

  it("excludes cancelled/stopped/running/failed(non-deadline) runs from the population", () => {
    const results = [
      result({ missionRunId: "a", outcome: "completed", pnlEth: 0.001 }),
      result({ missionRunId: "b", outcome: "cancelled", pnlEth: null }),
      result({ missionRunId: "c", outcome: "stopped", pnlEth: null }),
      result({ missionRunId: "d", outcome: "running", pnlEth: null }),
      result({ missionRunId: "e", outcome: "failed", stopReason: "system_error", pnlEth: -0.005 }),
    ];
    expect(computeWinRate(results)).toBe(100); // only "a" is eligible
  });

  it("is null when no run is eligible", () => {
    expect(computeWinRate([result({ outcome: "running", pnlEth: null })])).toBeNull();
    expect(computeWinRate([])).toBeNull();
  });

  it("excludes a completion-like run with unknown (null) PnL from the population", () => {
    const results = [result({ outcome: "completed", pnlEth: null })];
    expect(computeWinRate(results)).toBeNull();
  });
});

describe("sumPnlEth", () => {
  it("sums known PnL and ignores nulls", () => {
    const results = [
      result({ pnlEth: 0.002 }),
      result({ pnlEth: -0.001 }),
      result({ pnlEth: null }),
    ];
    expect(sumPnlEth(results)).toBeCloseTo(0.001, 9);
  });

  it("is zero for an empty list", () => {
    expect(sumPnlEth([])).toBe(0);
  });
});

describe("formatEth", () => {
  it("formats unsigned by default", () => {
    expect(formatEth(0.0012)).toBe("0.0012");
    expect(formatEth(-0.0012)).toBe("0.0012");
  });
  it("signs positive/negative/zero when requested", () => {
    expect(formatEth(0.001, { signed: true })).toBe("+0.0010");
    expect(formatEth(-0.001, { signed: true })).toBe("-0.0010");
    expect(formatEth(0, { signed: true })).toBe("0.0000");
  });
  it("renders an em dash for null/non-finite", () => {
    expect(formatEth(null)).toBe("—");
    expect(formatEth(Number.NaN)).toBe("—");
  });
});

describe("pnlUsd", () => {
  it("multiplies pnlEth by the close price", () => {
    expect(pnlUsd(0.001, 3000)).toBeCloseTo(3, 9);
  });
  it("is null when either input is unknown", () => {
    expect(pnlUsd(null, 3000)).toBeNull();
    expect(pnlUsd(0.001, null)).toBeNull();
  });
});

describe("formatDurationS", () => {
  it("formats seconds/minutes/hours", () => {
    expect(formatDurationS(42)).toBe("42s");
    expect(formatDurationS(125)).toBe("2m");
    expect(formatDurationS(3725)).toBe("1h 02m");
  });
  it("renders an em dash for null/negative/non-finite", () => {
    expect(formatDurationS(null)).toBe("—");
    expect(formatDurationS(-5)).toBe("—");
  });
});
