/**
 * `abortPlannedEvents` — finalize downstream planned rows on an early plan
 * abort (FIX2-W0, Codex final-review round 1 finding 3, bound in
 * `agents_dm/agent-scan-factory.md` "Coordinator addendum 2" as C17).
 *
 * Contract (C17 verbatim): once an upstream event in a multi-event plan
 * (allowance_reset → allowance → swap) reverts or goes ambiguous, every
 * REMAINING never-signed planned row must be finalized via
 * `abortPlannedEvents(executionId, fromIndex, reason)` →
 * `definitively_failed` with `failure_code: 'unknown'` and a reason of the
 * shape "not attempted: earlier <role> <reverted|ambiguous>". Both venues are
 * required to call this on EVERY early return + outer catch (W2a/W2b's job);
 * this suite pins the SHARED SPINE PRIMITIVE's own contract in isolation —
 * the exact invariant both venues depend on.
 *
 * Without this, a downstream planned row is left `pending` with no
 * `submit_attempted_at` (nothing was ever staged for it) — the EXACT phantom
 * shape `agent-activity.ts`'s repair candidate query
 * (`listPendingOlderThan`) explicitly excludes (`submit_attempted_at IS NOT
 * NULL`), so it would sit forever, invisible to both the repair sweep and
 * any reader that only looks at "confirmed" activity. This suite asserts
 * BOTH halves: the rows actually finalize, AND they are provably invisible
 * to `listPendingOlderThan` at every point (before AND after the abort call
 * — they were never a repair candidate to begin with).
 *
 * `abortPlannedEvents` does not exist yet — the dynamic `await import()`
 * inside each `it()` body means a "module not found" surfaces as an ordinary
 * failing assertion for THIS test only, not a suite-crashing collection
 * error; this file is a real (non-skipped) contract-first test, matching how
 * the FIX2-W0 handler adversarial suites are written (expected RED today,
 * green once W-SPINE lands the helper).
 */
import { afterEach, describe, expect, it } from "vitest";
import { seedIntent, cleanupSeeded } from "./_fixtures.js";

afterEach(async () => {
  await cleanupSeeded();
});

describe("abortPlannedEvents — C17 downstream finalization", () => {
  it("finalizes remaining never-signed rows as definitively_failed('unknown') after an upstream revert", async () => {
    const repo = await import("@vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();

    // A 3-row plan: allowance_reset (index 0, reverted on-chain — the venue
    // already finalized this one directly), allowance (index 1) and swap
    // (index 2) never got a chance to be signed.
    const resetEvent = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "allowance_reset", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    const allowanceEvent = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 1, eventRole: "allowance", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    const swapEvent = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 2, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    await repo.markActivityBroadcast(resetEvent.id, { txHash: "0xRESET", fromAddress: walletAddress, nonce: 1 });
    await repo.failActivityEvent(resetEvent.id, {
      failureCode: "mined_revert",
      failureReason: "allowance_reset transaction reverted on-chain.",
    });

    // Before the abort call: the downstream rows are exactly the phantom
    // shape — pending, no submit_attempted_at — so they are ALREADY
    // invisible to the repair candidate query (nothing to repair; nothing
    // was ever staged for them).
    const beforeCandidates = await repo.listPendingOlderThan(0);
    expect(beforeCandidates.some((r) => r.id === allowanceEvent.id)).toBe(false);
    expect(beforeCandidates.some((r) => r.id === swapEvent.id)).toBe(false);

    await repo.abortPlannedEvents(protocolExecutionId, 1, "allowance_reset reverted");

    const finalAllowance = await repo.getActivityEventById(allowanceEvent.id);
    const finalSwap = await repo.getActivityEventById(swapEvent.id);
    expect(finalAllowance?.status).toBe("definitively_failed");
    expect(finalAllowance?.failureCode).toBe("unknown");
    expect(finalAllowance?.failureReason).toMatch(/^not attempted: /);
    expect(finalAllowance?.failureReason?.match(/not attempted/gi)).toHaveLength(1);
    expect(finalAllowance?.failureReason).toMatch(/allowance_reset/i);
    expect(finalAllowance?.failureReason).toMatch(/reverted/i);
    expect(finalSwap?.status).toBe("definitively_failed");
    expect(finalSwap?.failureCode).toBe("unknown");

    // No phantom pendings remain — and still invisible to the repair query
    // (they are terminal now, not merely absent-because-unstaged).
    const afterCandidates = await repo.listPendingOlderThan(0);
    expect(afterCandidates.some((r) => r.id === allowanceEvent.id)).toBe(false);
    expect(afterCandidates.some((r) => r.id === swapEvent.id)).toBe(false);

    // The upstream row that was ALREADY finalized directly by the venue is
    // untouched by the abort call (fromIndex excludes it).
    const stillReset = await repo.getActivityEventById(resetEvent.id);
    expect(stillReset?.failureCode).toBe("mined_revert");
  });

  it("finalizes remaining rows after an AMBIGUOUS upstream outcome, with a reason naming 'ambiguous'", async () => {
    const repo = await import("@vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();

    const allowanceEvent = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "allowance", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    const swapEvent = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 1, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    // The allowance event itself stays pending (ambiguous submissions never
    // terminalize — C1/C15); only the DOWNSTREAM never-signed swap row is
    // aborted by this call.
    await repo.markActivityBroadcast(allowanceEvent.id, { txHash: "0xAMBIG", fromAddress: walletAddress, nonce: 1 });

    await repo.abortPlannedEvents(protocolExecutionId, 1, "allowance submission ambiguous");

    const stillAmbiguousAllowance = await repo.getActivityEventById(allowanceEvent.id);
    expect(stillAmbiguousAllowance?.status).toBe("pending");

    const finalSwap = await repo.getActivityEventById(swapEvent.id);
    expect(finalSwap?.status).toBe("definitively_failed");
    expect(finalSwap?.failureCode).toBe("unknown");
    expect(finalSwap?.failureReason).toMatch(/^not attempted: /);
    expect(finalSwap?.failureReason?.match(/not attempted/gi)).toHaveLength(1);
    expect(finalSwap?.failureReason).toMatch(/ambiguous/i);
  });

  it("a fromIndex past the end of the plan is a safe no-op (nothing to abort)", async () => {
    const repo = await import("@vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const swapEvent = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });

    await repo.abortPlannedEvents(protocolExecutionId, 5, "no-op");

    const stillPending = await repo.getActivityEventById(swapEvent.id);
    expect(stillPending?.status).toBe("pending");
  });
});
