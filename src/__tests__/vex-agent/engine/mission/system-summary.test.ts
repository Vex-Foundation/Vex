/**
 * `buildSystemSummary` — the fallback account of a run that ended without
 * the agent ever calling `mission_stop`.
 *
 * Anchored on a real incident: a 6-hour live mission hit a provider error,
 * parked, and timed out. No `mission_stop`, so no prose, so the card showed
 * raw metrics at the one moment an explanation mattered — and said nothing
 * about the position the run had left open and unmanaged.
 *
 * The honesty constraints are what these tests actually guard. A fallback
 * that quietly passes itself off as the agent's own account, or that
 * invents a rationale the run never recorded, would be worse than the raw
 * metrics it replaces.
 */

import { describe, expect, it } from "vitest";

import {
  SYSTEM_SUMMARY_LABEL,
  buildSystemSummary,
  type SystemSummaryFacts,
} from "../../../../vex-agent/engine/mission/system-summary.js";

/** The incident: provider error, parked, timed out, position left open. */
function abnormalEnd(overrides: Partial<SystemSummaryFacts> = {}): SystemSummaryFacts {
  return {
    outcome: "failed",
    stopReason: "provider_error",
    trades: 1,
    pnlEth: -0.0004,
    ethPriceUsd: 1800,
    openPositionSymbols: ["PEPE"],
    ...overrides,
  };
}

const bullets = (s: string): string[] => s.split("\n");

describe("buildSystemSummary — labelling", () => {
  it("opens with the system-generated label", () => {
    const summary = buildSystemSummary(abnormalEnd());

    expect(bullets(summary)[0]).toBe(`- ${SYSTEM_SUMMARY_LABEL}`);
  });

  it("says plainly that no agent wrote it", () => {
    const summary = buildSystemSummary(abnormalEnd());

    expect(summary).toContain("the agent stopped without writing one");
    expect(summary).toContain("assembled from the run record");
  });

  it("never speaks in the agent's first person", () => {
    const summary = buildSystemSummary(abnormalEnd());

    // The agent's own prose is written as "I looked at / I bought". A
    // fallback that adopts that voice is passing itself off as the agent.
    // Word-bounded: the summary legitimately says "your wallet", which
    // contains a bare "our".
    for (const firstPerson of [/\bI\b/, /\bwe\b/i, /\bmy\b/i, /\bour\b/i, /\bus\b/i]) {
      expect(summary).not.toMatch(firstPerson);
    }
  });

  it("does not invent a thesis or a reason the record does not carry", () => {
    const summary = buildSystemSummary(abnormalEnd({ stopReason: null, outcome: "failed" }));

    expect(summary).toContain("did not record why");
    // No fabricated rationale for the entry.
    for (const invented of ["because", "looked promising", "thesis", "decided", "strategy"]) {
      expect(summary.toLowerCase()).not.toContain(invented);
    }
  });
});

describe("buildSystemSummary — the still-open position", () => {
  it("says the position is still open and unmanaged", () => {
    const summary = buildSystemSummary(abnormalEnd());

    expect(summary).toContain("PEPE");
    expect(summary).toContain("STILL OPEN");
    expect(summary).toContain("no longer being managed");
  });

  it("ranks the open-position warning above the activity and PnL lines", () => {
    const lines = bullets(buildSystemSummary(abnormalEnd()));
    const openIdx = lines.findIndex((l) => l.includes("STILL OPEN"));
    const pnlIdx = lines.findIndex((l) => l.includes("$"));

    expect(openIdx).toBeGreaterThan(-1);
    expect(openIdx).toBeLessThan(pnlIdx);
  });

  it("marks the PnL as provisional while a position is still open", () => {
    const summary = buildSystemSummary(abnormalEnd());

    // A mark-to-market number presented as a settled result is a lie of
    // omission — the position can still move.
    expect(summary).toContain("This is not final");
    expect(summary).toContain("valued at its current price");
  });

  it("names every open symbol, not just the first", () => {
    const summary = buildSystemSummary(abnormalEnd({ openPositionSymbols: ["PEPE", "DEGEN"] }));

    expect(summary).toContain("PEPE");
    expect(summary).toContain("DEGEN");
    expect(summary).toContain("are STILL OPEN");
  });

  it("says nothing about open positions when the run closed everything", () => {
    const summary = buildSystemSummary(abnormalEnd({ openPositionSymbols: [] }));

    expect(summary).not.toContain("STILL OPEN");
    expect(summary).toContain("Overall result:");
  });
});

describe("buildSystemSummary — figures come from the run record", () => {
  it("converts the ledger's ETH PnL at the ledger's ETH price", () => {
    // -0.0004 ETH x $1800 = -$0.72.
    const summary = buildSystemSummary(abnormalEnd({ openPositionSymbols: [] }));

    expect(summary).toContain("-$0.72");
  });

  it("states no figure at all when the record cannot support one", () => {
    const summary = buildSystemSummary(
      abnormalEnd({ pnlEth: null, ethPriceUsd: null, openPositionSymbols: [] }),
    );

    expect(summary).toContain("could not be determined from the record");
    expect(summary).not.toContain("$");
  });

  it("omits the figure when the ETH price is missing, rather than guessing", () => {
    const summary = buildSystemSummary(
      abnormalEnd({ pnlEth: -0.0004, ethPriceUsd: null, openPositionSymbols: [] }),
    );

    expect(summary).not.toContain("$");
  });

  it("reports the trade count from the record", () => {
    expect(buildSystemSummary(abnormalEnd({ trades: 0 }))).toContain("No trades were made");
    expect(buildSystemSummary(abnormalEnd({ trades: 1 }))).toContain("1 trade was made");
    expect(buildSystemSummary(abnormalEnd({ trades: 4 }))).toContain("4 trades were made");
  });
});

describe("buildSystemSummary — why it stopped", () => {
  it.each([
    ["provider_error", "connection to the trading service failed"],
    ["deadline_reached", "reached its time limit"],
    ["max_loss_hit", "maximum loss you allowed"],
    ["capital_depleted", "ran out of funds"],
    ["user_stopped", "You stopped this run"],
  ])("explains %s in plain language", (reason, expected) => {
    expect(buildSystemSummary(abnormalEnd({ stopReason: reason }))).toContain(expected);
  });

  it("falls back honestly on an unrecognised stop reason", () => {
    const summary = buildSystemSummary(
      abnormalEnd({ stopReason: "something_new_we_added_later", outcome: "failed" }),
    );

    expect(summary).toContain("did not record why");
  });
});

describe("buildSystemSummary — shape", () => {
  it("emits `- ` bullets so the card renders it like agent prose", () => {
    for (const line of bullets(buildSystemSummary(abnormalEnd()))) {
      expect(line.startsWith("- ")).toBe(true);
    }
  });
});
