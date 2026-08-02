/**
 * Staged broadcast durability (plan §11.1, Blocker A) — hardened by Codex
 * spine-review round 1, finding 10 ("the activated W0 contracts are not a
 * trustworthy gate"), bound in `agents_dm/agent-scan-factory.md`
 * "Coordinator addendum 1" as C6/C7/C13.
 *
 * FIX-W0 delta (this revision — finding 10 verbatim):
 *   - (1) rewritten to exercise the REPO API's real state machine instead of
 *     a locally invented `stagedExecute()`/`broadcast()` stub that proved
 *     nothing. It now drives the REAL `createAgentActivityIntent` (the
 *     atomic intent+event transaction §11.1 step 1 actually uses) with an
 *     input that fails INSIDE the transaction, and asserts the whole
 *     transaction rolled back — zero `protocol_executions` rows exist for
 *     that attempt. That is the real fail-closed property behind "activity
 *     persistence failure => zero broadcasts": a caller can never obtain an
 *     execution id to broadcast against if the intent transaction failed.
 *   - (3) the ambiguous-RPC case now spies on the REAL `failActivityEvent`
 *     export and asserts it was NEVER called (not merely that the row
 *     "happens to" still read pending) — driven through the REAL repair
 *     seam (`repairPendingActivity` with a `checkReceiptByHash` that resolves
 *     `null`, the documented ambiguous-outcome contract). The spy is restored
 *     afterward.
 *   - (4) duplicate-repair now asserts `applied:false` EXACTLY (C7's
 *     `{applied, row}` return), not `>= 1` call-count. One real sweep pass
 *     confirms the row (candidacy achieved via `_fixtures.ts#backdateSubmitAttempt`,
 *     not a fake timer — repair reads real Postgres `NOW()`); a direct
 *     second `confirmActivityEvent` call against the now-terminal row (the
 *     concrete race a second concurrent sweep would hit) must return
 *     `applied:false`.
 *   - (5) unchanged in spirit but seeded via C13 fixtures.
 *   - C13: every case seeds a REAL `protocol_executions` row via
 *     `_fixtures.ts#seedIntent`; `afterEach` cleans up every row created.
 *
 * Write protocol under test (§11.1 verbatim):
 *   1. create the `protocol_executions` intent row + initial `agent_activity`
 *      event row(s) BEFORE any allowance/swap broadcast (atomically);
 *   2. sign locally, compute the tx hash from the signed payload, PERSIST
 *      tx_hash/from/nonce/submit_attempted_at — THEN broadcast;
 *   3. finalize via CAS (`pending -> confirmed | definitively_failed`); an
 *      RPC-submit timeout / ambiguous outcome stays `pending`, never calls
 *      `failActivityEvent`;
 *   4. the repair sweep re-checks pending rows by persisted hash later.
 *
 * The exact SIGN → PERSIST → SUBMIT crash-boundary tests (a real unified
 * sender does not exist yet) remain W2a/W2b acceptance gates per Codex's
 * closing note — this suite proves the shared `agent-activity.ts` repo
 * primitives those handlers MUST call in the right order.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, it, expect, vi } from "vitest";
import { getBySession } from "../../../vex-agent/db/repos/executions.js";
import { seedIntent, cleanupSeeded, backdateSubmitAttempt } from "./_fixtures.js";
import { REPAIR_CANDIDATE_AGE_MS } from "../../../vex-agent/sync/agent-activity-repair.js";

afterEach(async () => {
  await cleanupSeeded();
});

describe("staged broadcast durability", () => {
  it("(1) a failed agent_activity insert rolls back the WHOLE intent transaction — zero rows persisted", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const sessionId = `w0-fix-1-${randomUUID()}`;

    await expect(
      repo.createAgentActivityIntent({
        toolId: "kyberswap.swap.execute",
        namespace: "kyberswap",
        intentParams: { marker: sessionId },
        events: [
          {
            eventIndex: 0,
            // @ts-expect-error — deliberately outside the closed event_role
            // vocabulary to force the DB CHECK to reject the WHOLE transaction.
            eventRole: "not_a_real_role",
            kind: "swap",
            protocol: "kyberswap",
            chainId: 8453,
            walletAddress: "0xWALLET",
            sessionId,
          },
        ],
      }),
    ).rejects.toThrow();

    // Nothing about this attempt survived — no intent row exists for a
    // sessionId that was used for NOTHING else, proving there is no
    // partially-created state a real handler could ever broadcast against.
    const executions = await getBySession(sessionId);
    expect(executions).toHaveLength(0);
  });

  it("(2) crash after hash persist, before submit: leaves a repairable pending row with tx_hash + submit_attempted_at", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    // Persist the signed hash BEFORE broadcasting (§11.1 step 2) — then the
    // process crashes; the RPC submit call never happens (markBroadcastAccepted
    // is never called, so broadcast_at stays null).
    await repo.markActivityBroadcast(event.id, {
      txHash: "0xSIGNED_HASH", fromAddress: walletAddress, nonce: 5,
    });
    const persisted = await repo.getActivityEventById(event.id);
    expect(persisted?.status).toBe("pending");
    expect(persisted?.txHash).toBe("0xSIGNED_HASH");
    expect(persisted?.submitAttemptedAt).not.toBeNull();
    expect(persisted?.broadcastAt).toBeNull();
  });

  it("(3) an ambiguous RPC/repair outcome never calls failActivityEvent — the row stays pending", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const repairModule = await import("../../../vex-agent/sync/agent-activity-repair.js");
    const failSpy = vi.spyOn(repo, "failActivityEvent");
    try {
      const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
      const event = await repo.createPendingActivityEvent({
        protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
        protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
      });
      await repo.markActivityBroadcast(event.id, { txHash: "0xHASH", fromAddress: walletAddress, nonce: 1 });
      await backdateSubmitAttempt(event.id, REPAIR_CANDIDATE_AGE_MS + 1_000);

      // The documented ambiguous outcome (receipt-guard.ts:29 semantics,
      // C1): a missing receipt / RPC error resolves the lookup to `null`.
      await repairModule.repairPendingActivity({
        checkReceiptByHash: vi.fn().mockResolvedValue(null),
      });

      expect(failSpy).not.toHaveBeenCalled();
      const stillPending = await repo.getActivityEventById(event.id);
      expect(stillPending?.status).toBe("pending");
    } finally {
      failSpy.mockRestore();
    }
  });

  it("(4) a duplicate finalize attempt against an already-repaired row returns applied:false EXACTLY", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const repairModule = await import("../../../vex-agent/sync/agent-activity-repair.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    await repo.markActivityBroadcast(event.id, { txHash: "0xHASH", fromAddress: walletAddress, nonce: 1 });
    await backdateSubmitAttempt(event.id, REPAIR_CANDIDATE_AGE_MS + 1_000);

    const sweepResult = await repairModule.repairPendingActivity({
      checkReceiptByHash: vi.fn().mockResolvedValue({ status: "success" }),
    });
    expect(sweepResult.confirmed).toBe(1);
    const afterFirstSweep = await repo.getActivityEventById(event.id);
    expect(afterFirstSweep?.status).toBe("confirmed");

    // The concrete race a SECOND concurrent sweep would hit: it also reads
    // this row before the first sweep's UPDATE commits, then attempts the
    // same CAS finalize. The repo's compare-and-set must report this as a
    // miss, not a second application.
    const duplicate = await repo.confirmActivityEvent(event.id, {
      executedAmountInRaw: "999", executedAmountOutRaw: "999",
    });
    expect(duplicate.applied).toBe(false);
    expect(duplicate.row.status).toBe("confirmed");
  });

  it("(5) event_role vocabulary is allowance_reset | allowance | swap, unique per (protocol_execution_id, event_index)", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const allowanceReset = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "allowance_reset", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    const allowance = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 1, eventRole: "allowance", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    const swap = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 2, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    expect([allowanceReset.eventRole, allowance.eventRole, swap.eventRole]).toEqual([
      "allowance_reset", "allowance", "swap",
    ]);

    // A duplicate (protocol_execution_id, event_index) is rejected, not
    // silently overwritten — the idempotency key the write protocol relies on
    // to survive a capture-side retry without duplicating rows.
    await expect(
      repo.createPendingActivityEvent({
        protocolExecutionId, eventIndex: 2, eventRole: "swap", kind: "swap",
        protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
      }),
    ).rejects.toThrow();

    await expect(
      repo.createPendingActivityEvent({
        protocolExecutionId, eventIndex: 3,
        // @ts-expect-error — deliberately outside the closed event_role vocabulary.
        eventRole: "refund",
        kind: "swap", protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
      }),
    ).rejects.toThrow();
  });
});
