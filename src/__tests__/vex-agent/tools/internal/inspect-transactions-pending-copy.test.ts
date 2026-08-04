/**
 * G1 — WHAT THE AGENT IS TOLD ABOUT A ROW THAT IS NOT MOVING.
 *
 * The P4 evidence: the agent burned two `loop_defer` cycles and several
 * inference calls trying to work out what had happened to a launch, because a
 * `pending` row says nothing about WHY it is pending. One line could have told
 * it. That is the same blind-retry failure the agent-facing-errors decree exists
 * to stop, applied to a non-error.
 *
 * Two clauses, and the discipline is in what they REFUSE to say:
 *
 * - `in_mempool` is the HEALTHY answer: known to a node, not yet mined. It says
 *   "do not re-broadcast" — re-broadcasting here is how a user pays twice.
 * - `nonce_superseded` says the ORIGINAL HASH appears superseded and that the
 *   replacement's outcome is NOT correlated. It must never say "failed",
 *   "nothing was spent", or "safe to retry": a replacement reusing the nonce may
 *   have carried the same calldata and done the same thing. Correlating it is
 *   strictly more work than the lane does, so no surface may claim more.
 *
 * And `superseded_unproven` — a NON-FAILURE terminal state — must read as
 * "stopped tracking, outcome unproven", never as a failure.
 */

import { describe, it, expect } from "vitest";

const { summarizeTransactionRowForTest } = await import(
  "../../../../vex-agent/tools/internal/inspect-views/transactions.js"
);

function row(over: Record<string, unknown> = {}) {
  return {
    source: "activity",
    kind: "swap",
    status: "pending",
    protocol: "kyberswap",
    namespace: "kyberswap",
    chainId: 8453,
    txHash: "0xabc0000000000000000000000000000000000000000000000000000000000001",
    createdAt: "2026-08-04T00:00:00.000Z",
    ...over,
  } as never;
}

describe("a healthy pending transaction says so", () => {
  it("names the mempool and forbids a re-broadcast", () => {
    const line = summarizeTransactionRowForTest(row({ lastVerificationReason: "in_mempool" }));

    expect(line).toContain("in the mempool");
    expect(line).toContain("do not re-broadcast");
    // It is NOT a stall: we looked and learned something definite.
    expect(line).not.toContain("verification stalled");
  });
});

describe("a superseded hash claims exactly what is proven, and nothing more", () => {
  it("says the outcome is unchecked, and never that it failed or is safe to retry", () => {
    const line = summarizeTransactionRowForTest(row({ lastVerificationReason: "nonce_superseded" }));

    expect(line).toContain("superseded");
    expect(line.toLowerCase()).toContain("has not been checked");
    expect(line.toLowerCase()).not.toContain("nothing was spent");
    expect(line.toLowerCase()).not.toContain("safe to retry");
    expect(line.toLowerCase()).not.toContain("failed");
  });

  it("a TERMINAL superseded_unproven row reads as stopped-tracking, not as a failure", () => {
    const line = summarizeTransactionRowForTest(
      row({ status: "superseded_unproven", lastVerificationReason: "nonce_superseded" }),
    );

    expect(line.toLowerCase()).toContain("no longer tracking");
    expect(line.toLowerCase()).toContain("unproven");
    expect(line.toLowerCase()).not.toContain("failed");
  });
});

describe("it does not invent a cadence it cannot support", () => {
  it("states no check interval, because this view carries no broadcast anchor", () => {
    const line = summarizeTransactionRowForTest(row({ lastVerificationReason: "in_mempool" }));

    // A fixed "every 5s" is FALSE for any row past its fast phase, and this row
    // model carries no `submit_attempted_at` to derive the real one from. Saying
    // nothing is the honest option; saying "5s" is a claim beyond the evidence.
    expect(line).not.toContain("every 5");
    expect(line).not.toContain("5s");
  });
});
