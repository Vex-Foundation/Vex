/**
 * The per-chain PENDING-STATE table.
 *
 * WHAT THIS PINS. Contract C2.4 makes `pending` the tag a spend may be
 * authorized from, because it is the only tag that subtracts the wallet's own
 * in-flight transactions. WP2-E0 measured that the tag is ACCEPTED on every
 * endpoint a Vex venue reaches; the 2026-09-01 block-hash re-measurement
 * found FOURTEEN of the eighteen answer it with the head block or expose no
 * pending block at all - so on those the tag subtracts
 * nothing and satisfies nothing. This suite holds the table to those
 * measurements and holds it to the venue set, because a chain a venue serves
 * with no row here is a chain whose spendability reads have no basis at all.
 *
 * Structured like `l1-data-fee.test.ts`, its sibling table, because the two
 * answer the same kind of question about the same endpoints.
 */

import { describe, it, expect } from "vitest";

import {
  getPendingBlockCapability,
  listPendingBlockCapabilities,
} from "@tools/evm-chains/pending-block-capability.js";
import { listL1DataFeeCapabilities } from "@tools/evm-chains/l1-data-fee.js";

/**
 * The FOUR endpoints measured as assembling a real pending block, written out
 * rather than derived from the module so that a row silently flipping to
 * `distinct` - which is the direction that WEAKENS the gate, because it skips
 * the compensation entirely - fails here.
 *
 * Everything else is `head_alias` or `absent`. That is twelve of eighteen, not
 * the seven WP2-E0's block-NUMBER proxy reported: two sequential JSON-RPC calls
 * are two moments, so on a fast chain a pure alias reports a positive delta
 * from call latency alone (re-measured 2026-09-01; the same Arbitrum endpoint
 * E0 recorded as `equal` answered `+4`).
 */
const REAL_PENDING_STATE: readonly number[] = [1, 137, 8453, 59144];

describe("the pending-state capability table", () => {
  it("marks exactly the four measured endpoints as having a real pending state", () => {
    const distinct = listPendingBlockCapabilities()
      .filter((row) => row.state === "distinct")
      .map((row) => row.chainId)
      .sort((a, b) => a - b);

    expect(distinct).toEqual([...REAL_PENDING_STATE].sort((a, b) => a - b));
  });

  it("classifies every remaining endpoint as alias or absent, never as unknown-but-fine", () => {
    const rest = listPendingBlockCapabilities().filter((row) => row.state !== "distinct");

    expect(rest.length).toBe(14);
    for (const row of rest) {
      expect(["head_alias", "absent"]).toContain(row.state);
    }
  });

  it("covers exactly the chain set the L1-fee table covers", () => {
    // Both tables answer questions about the SAME endpoints, so a chain in one
    // and missing from the other is a gap that would only show up as a refusal
    // in production.
    const pendingChains = listPendingBlockCapabilities().map((row) => row.chainId).sort();
    const l1Chains = listL1DataFeeCapabilities().map((row) => row.chainId).sort();

    expect(pendingChains).toEqual(l1Chains);
  });

  it("carries the measurement, not a convention, on every row", () => {
    for (const row of listPendingBlockCapabilities()) {
      expect(row.evidence).toContain("measured live");
      // The evidence names the OBSERVATION that decided the row, so a reader
      // can tell a proven alias from an endpoint that merely could not be
      // shown to have a pending state.
      expect(row.evidence).toMatch(/UNSEALED|returned null|canonical block/);
    }
  });

  it("answers UNDEFINED for a chain nobody measured, so the caller can fail closed", () => {
    // The alternative - a default row - would be an assumption about an
    // endpoint's behaviour dressed as a measurement, which is exactly what the
    // L1-fee table's header rejects for the same reason.
    expect(getPendingBlockCapability(1)).toBeDefined();
    expect(getPendingBlockCapability(1337)).toBeUndefined();
  });
});
