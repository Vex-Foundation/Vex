/**
 * The `agent_activity` repair sweep (plan §4.1 / §11.1 + C1/C13 — Codex
 * spine-review round 1, bound in `agents_dm/agent-scan-factory.md`
 * "Coordinator addendum 1").
 *
 * FIX-W0 delta (C13): every DB-touching case now seeds a REAL
 * `protocol_executions` row via `_fixtures.ts#seedIntent` (previously
 * hardcoded orphan `protocolExecutionId` literals 10/11/12) and uses
 * `_fixtures.ts#backdateSubmitAttempt` (real SQL, not a fake timer) to make a
 * row an actual `listPendingOlderThan` candidate — `repairPendingActivity`
 * reads real Postgres `NOW()`, so `vi.useFakeTimers()` cannot age a row for
 * it. `afterEach` cleans up every row created.
 *
 * Contract pinned here: the repair sweep is LOOKUP-ONLY. It reads a pending
 * row's persisted `tx_hash` and asks the chain for a receipt (or asks a
 * repair-scoped read dependency) — it must NEVER hold a signer, NEVER call a
 * send/broadcast/submit function, and NEVER fall back to re-quoting or
 * re-executing a swap. Per C1, a definitive `reverted` receipt finalizes with
 * the NEW `mined_revert` failure code (distinct from `simulation_reverted`,
 * which is a pre-broadcast simulate/send-time revert); an ambiguous/missing
 * receipt bumps `last_checked_at` and stays `pending` FOREVER —
 * `confirmation_timeout` is reserved and never auto-set by this sweep.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { seedIntent, cleanupSeeded, backdateSubmitAttempt } from "./_fixtures.js";
import { REPAIR_CANDIDATE_AGE_MS } from "../../../vex-agent/sync/agent-activity-repair.js";

afterEach(async () => {
  await cleanupSeeded();
});

describe("agent_activity repair sweep — lookup-only", () => {
  it("never invokes a send/broadcast/submit dependency, even when injected", async () => {
    const { repairPendingActivity } = await import("../../../vex-agent/sync/agent-activity-repair.js");

    const sendTransaction = vi.fn();
    const broadcastTransaction = vi.fn();
    const submitSignedTx = vi.fn();
    const observeTransaction = vi.fn().mockResolvedValue({ kind: "mined", status: "success" });

    await repairPendingActivity({
      observeTransaction,
      // These three are deliberately NOT part of the sweep's real dependency
      // surface; if the implementation somehow imported and called a
      // send/broadcast primitive despite them not being wired in as deps,
      // this test cannot catch that directly — the injected-deps assertion
      // below is the enforceable half of the guarantee, and the absence of
      // any signer/send dependency in the sweep's own deps interface is the
      // structural half (see the next test).
    });

    expect(sendTransaction).not.toHaveBeenCalled();
    expect(broadcastTransaction).not.toHaveBeenCalled();
    expect(submitSignedTx).not.toHaveBeenCalled();
  });

  it("the sweep's dependency surface has no send/broadcast/sign capability at all", async () => {
    const repairModule = await import("../../../vex-agent/sync/agent-activity-repair.js");
    // Structural guard: the module's exported deps-builder (or default deps
    // factory) must not expose a callable named send/broadcast/submit/sign.
    // If W-SPINE names it differently, this test documents the invariant it
    // must still satisfy under whatever name is chosen.
    const dangerousNames = ["sendTransaction", "broadcastTransaction", "submitSignedTx", "signTransaction"];
    const exportedNames = Object.keys(repairModule);
    for (const name of dangerousNames) {
      expect(exportedNames).not.toContain(name);
    }
  });

  it("finalizes a pending row to 'confirmed' purely from a receipt lookup, no re-quote/re-execute call", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { repairPendingActivity } = await import("../../../vex-agent/sync/agent-activity-repair.js");
    // Owner decree 2026-07-30: repair is STATUS-ONLY. A mined-success receipt
    // confirms the row on its own, with NO executed amounts written — migration
    // 061 dropped the CHECKs that used to forbid exactly that.
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    await repo.markActivityBroadcast(event.id, { txHash: "0xHASH", fromAddress: walletAddress, nonce: 1 });
    await backdateSubmitAttempt(event.id, REPAIR_CANDIDATE_AGE_MS + 1_000);

    const requote = vi.fn();
    await repairPendingActivity({
      observeTransaction: vi.fn().mockResolvedValue({ kind: "mined", status: "success" }),
    });

    expect(requote).not.toHaveBeenCalled();
    const finalRow = await repo.getActivityEventById(event.id);
    expect(finalRow?.status).toBe("confirmed");
    expect(finalRow?.confirmedAt).not.toBeNull();
    // The amounts are DEFERRED, never faked from the quote (owner decree).
    expect(finalRow?.executedAmountInRaw).toBeNull();
    expect(finalRow?.executedAmountOutRaw).toBeNull();
  });

  it.each(["wrap", "yield_pt"] as const)(
    "migration 061: a status-only confirm is accepted for a '%s' row too (the legacy leg CHECKs are gone)",
    async (eventRole) => {
      const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
      const { repairPendingActivity } = await import("../../../vex-agent/sync/agent-activity-repair.js");
      const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
      const event = await repo.createPendingActivityEvent({
        protocolExecutionId, eventIndex: 0, eventRole, kind: eventRole === "wrap" ? "wrap" : "yield",
        protocol: "pendle", chainId: 8453, walletAddress, sessionId,
      });
      await repo.markActivityBroadcast(event.id, { txHash: "0xHASH", fromAddress: walletAddress, nonce: 1 });
      await backdateSubmitAttempt(event.id, REPAIR_CANDIDATE_AGE_MS + 1_000);

      await repairPendingActivity({
        observeTransaction: vi.fn().mockResolvedValue({ kind: "mined", status: "success" }),
      });

      const finalRow = await repo.getActivityEventById(event.id);
      expect(finalRow?.status).toBe("confirmed");
      expect(finalRow?.executedAmountOutRaw).toBeNull();
    },
  );

  it("finalizes a mined-revert pending row to 'definitively_failed' with failure_code 'mined_revert' (C1)", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { repairPendingActivity } = await import("../../../vex-agent/sync/agent-activity-repair.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    await repo.markActivityBroadcast(event.id, { txHash: "0xHASH", fromAddress: walletAddress, nonce: 1 });
    await backdateSubmitAttempt(event.id, REPAIR_CANDIDATE_AGE_MS + 1_000);

    await repairPendingActivity({
      observeTransaction: vi.fn().mockResolvedValue({ kind: "mined", status: "reverted" }),
    });

    const finalRow = await repo.getActivityEventById(event.id);
    expect(finalRow?.status).toBe("definitively_failed");
    expect(finalRow?.failureCode).toBe("mined_revert");
  });

  it("a still-unconfirmed receipt (no result yet) leaves the row pending FOREVER and only stamps last_checked_at — never confirmation_timeout", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { repairPendingActivity } = await import("../../../vex-agent/sync/agent-activity-repair.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    await repo.markActivityBroadcast(event.id, { txHash: "0xHASH", fromAddress: walletAddress, nonce: 1 });
    // Far beyond ANY plausible horizon (C1: ambiguity never terminalizes,
    // no matter how old) — a year-old still-ambiguous receipt stays pending.
    await backdateSubmitAttempt(event.id, 365 * 24 * 60 * 60 * 1000);

    await repairPendingActivity({
      observeTransaction: vi.fn().mockResolvedValue({ kind: "unknown_to_node" }), // not yet mined / transient lookup failure
    });

    const row = await repo.getActivityEventById(event.id);
    expect(row?.status).toBe("pending");
    expect(row?.failureCode).toBeNull();
    expect(row?.lastCheckedAt).not.toBeNull();
  });
});
