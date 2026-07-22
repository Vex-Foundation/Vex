/**
 * Mission finalisation backfills a system-generated summary when the agent
 * never wrote one.
 *
 * The incident this closes: a 6-hour live mission hit a provider error,
 * parked, and timed out without ever calling `mission_stop`. `stop_summary`
 * stayed null, so the card fell back to raw metrics — and never mentioned
 * the position the run had left open with nothing managing it.
 *
 * The load-bearing guarantee is the NEGATIVE one: a real agent-authored
 * summary is never overwritten. That is enforced in SQL
 * (`setStopSummaryIfAbsent`), and asserted here at the seam so a future
 * refactor that moves the guard into JS still has to keep it.
 */

import { describe, it, expect, vi } from "vitest";

import {
  captureMissionFinal,
  type CaptureDeps,
} from "../../../../vex-agent/engine/mission/mission-results-capture.js";
import { SYSTEM_SUMMARY_LABEL } from "../../../../vex-agent/engine/mission/system-summary.js";

const MISSION = {
  id: "mission-1",
  goal: "grow ETH +8% in 60 min",
  allowedChains: ["robinhood"],
  allowedWallets: ["0x9ed25bdedceB28Adf9E3C7fCa34511e78e47C77f"],
};

const OPENED_ROW = {
  bankrollStartEth: 0.01,
  startedAt: "2026-01-01T00:00:00.000Z",
};

function deps(over: Partial<CaptureDeps> = {}): CaptureDeps {
  return {
    getMission: vi.fn(async () => MISSION as never),
    readBankroll: vi.fn(async () => ({
      bankrollEth: 0.0096,
      ethPriceUsd: 1800,
      openPositions: [{ symbol: "PEPE", address: "0xdead", amount: "1" }],
    })) as never,
    openResult: vi.fn(async () => {}),
    closeResult: vi.fn(async () => {}),
    getResult: vi.fn(async () => OPENED_ROW as never),
    countTrades: vi.fn(async () => 1),
    setStopSummaryIfAbsent: vi.fn(async () => true),
    ...over,
  };
}

const ARGS = {
  missionId: "mission-1",
  runId: "run-1",
  sessionId: "s-1",
  outcome: "failed" as const,
  stopReason: "provider_error",
};

/** The summary text handed to the repo on this run, or null if none was. */
function writtenSummary(d: CaptureDeps): string | null {
  const mock = d.setStopSummaryIfAbsent as ReturnType<typeof vi.fn>;
  if (mock.mock.calls.length === 0) return null;
  return mock.mock.calls[0]![1] as string;
}

describe("captureMissionFinal — system summary backfill", () => {
  it("writes a summary for a run that reached a terminal state without mission_stop", async () => {
    const d = deps();

    await captureMissionFinal(ARGS, d);

    expect(d.setStopSummaryIfAbsent).toHaveBeenCalledTimes(1);
    expect(writtenSummary(d)).toBeTruthy();
  });

  it("labels the summary as system-generated", async () => {
    const d = deps();

    await captureMissionFinal(ARGS, d);

    expect(writtenSummary(d)).toContain(SYSTEM_SUMMARY_LABEL);
  });

  it("names the still-open, unmanaged position", async () => {
    const d = deps();

    await captureMissionFinal(ARGS, d);

    const summary = writtenSummary(d)!;
    expect(summary).toContain("PEPE");
    expect(summary).toContain("STILL OPEN");
    expect(summary).toContain("no longer being managed");
  });

  it("delegates the never-overwrite guarantee to the if-absent repo write", async () => {
    // The repo's WHERE clause is the guard. What matters here is that
    // finalisation calls the guarded write and NEVER a blind update — a
    // `mission_stop` landing concurrently must always win.
    const d = deps({ setStopSummaryIfAbsent: vi.fn(async () => false) });

    await captureMissionFinal(ARGS, d);

    const mock = d.setStopSummaryIfAbsent as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]![0]).toBe("run-1");
    // A `false` return (agent prose already present) is a normal outcome,
    // not an error — finalisation must complete regardless.
    expect(d.closeResult).toHaveBeenCalledTimes(1);
  });

  it("derives its figures from the ledger values it just wrote", async () => {
    const d = deps();

    await captureMissionFinal(ARGS, d);

    // start 0.01 -> end 0.0096 = -0.0004 ETH, x $1800 = -$0.72.
    expect(writtenSummary(d)).toContain("-$0.72");
  });

  it("stays fail-soft when the summary write throws", async () => {
    // Bankroll accounting must never break a mission's lifecycle, and a
    // cosmetic backfill least of all.
    const d = deps({
      setStopSummaryIfAbsent: vi.fn(async () => {
        throw new Error("db down");
      }),
    });

    await expect(captureMissionFinal(ARGS, d)).resolves.toBeUndefined();
    expect(d.closeResult).toHaveBeenCalledTimes(1);
  });

  it("does not write a summary when the ledger row was never opened", async () => {
    const d = deps({ getResult: vi.fn(async () => null) });

    await captureMissionFinal(ARGS, d);

    expect(d.setStopSummaryIfAbsent).not.toHaveBeenCalled();
  });
});
