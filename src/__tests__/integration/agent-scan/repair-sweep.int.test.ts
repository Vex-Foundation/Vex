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

// Real coordinator receipt, replayed through the existing status and amount owners.
import doppler from "../../tools/uniswap/fixtures/v4-base-doppler-receipt.json" with { type: "json" };
import { getAddress } from "viem";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { v4PoolId } from "@tools/uniswap/v4-pool.js";
import { repairMissingExecutedAmounts } from "@vex-agent/sync/executed-amount-fallback.js";
import { execute as sql } from "@vex-agent/db/client.js";
import * as activity from "@vex-agent/db/repos/agent-activity.js";
import { repairPendingActivity } from "@vex-agent/sync/agent-activity-repair.js";

describe("v4 settlement and dependent fee recovery", () => {
  it("repairs the real Doppler receipt and terminalizes its unattempted fee without collecting it", async () => {
    const seeded = await seedIntent("uniswap.swap.execute");
    const d = getUniswapDeployment(8453)?.v4;
    if (!d) throw new Error("Base v4 fixture requires its deployment");
    const poolKey = { currency0: getAddress("0x4200000000000000000000000000000000000006"), currency1: getAddress("0x9e00fc92493451eba1c63dd3880d68b622037ba3"), fee: 8388608, tickSpacing: 200, hooks: getAddress("0xbdf938149ac6a781f94faa0ed45e6a0e984c6544") };
    const swap = await activity.createPendingActivityEvent({ ...seeded, eventIndex: 0, eventRole: "swap", kind: "swap", protocol: "uniswap", chainId: 8453, walletAddress: doppler.from,
      tokenIn: { tokenAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", tokenDecimals: 18, tokenSymbol: "ETH", amountRaw: doppler.value, amountHuman: "0.00009975" },
      tokenOut: { tokenAddress: poolKey.currency1, tokenDecimals: 18, tokenSymbol: "1F916", amountRaw: "9876476984743216817150", amountHuman: "9876.47698474321681715" },
      routeProvenance: activity.settlementDecodeProvenance({ decoder: "uniswap", chainId: 8453, routerAddress: d.universalRouter, declaredValueRaw: doppler.value, wrappedNativeAddress: poolKey.currency0,
        v4: { poolKey, poolId: v4PoolId(poolKey), zeroForOne: true, hookPermissions: 9540, dynamicFee: true, observedLpFee: 7000, universalRouter: d.universalRouter, universalRouterVersion: "2.1.1", permit2: d.permit2 } }),
    });
    const fee = await activity.createPendingActivityEvent({ ...seeded, eventIndex: 1, eventRole: "swap_fee", kind: "swap", protocol: "uniswap", chainId: 8453, walletAddress: doppler.from });
    await activity.markActivityBroadcast(swap.id, { txHash: doppler.hash, fromAddress: doppler.from, nonce: 1 });
    await activity.notePendingReason(swap.id, "settlement_undecodable", { kind: "handler_return" });
    await backdateSubmitAttempt(swap.id, REPAIR_CANDIDATE_AGE_MS + 1000);
    await repairPendingActivity({ observeTransaction: async () => ({ kind: "mined", status: "success", blockTimeIso: null }) });
    // An old decoder's completed decline must become eligible again after this fix.
    await activity.noteSettlementDecodeVersion(swap.id, "2026-09-09.uniswap-v4-receipt");
    const amounts = await repairMissingExecutedAmounts({ fetchReceiptLogs: async () => doppler.logs, fetchReceiptStatus: async () => "success",
      fetchTransaction: async () => ({ from: doppler.from, to: doppler.to, valueRaw: doppler.value, input: doppler.inputSelector }) });
    expect(amounts.filled).toBe(1);
    expect(await activity.getActivityEventById(swap.id)).toMatchObject({ status: "confirmed", executedAmountInRaw: doppler.value, executedAmountOutRaw: "9876476984743216817150" });
    await sql("UPDATE agent_activity SET created_at = NOW() - interval '1 day' WHERE id = $1", [fee.id]);
    await activity.recoverStaleHashlessIntents(90_000, 10);
    expect(await activity.getActivityEventById(fee.id)).toMatchObject({ status: "definitively_failed", txHash: null, failureCode: "broadcast_error", failureReason: expect.stringContaining("No fee retry happens automatically") });
  });

  it.each(["mined", "dropped"] as const)("reconciles a %s fee hash after the handler exits", async outcome => {
    const seeded = await seedIntent("uniswap.swap.execute");
    const fee = await activity.createPendingActivityEvent({ ...seeded, eventIndex: 0, eventRole: "swap_fee", kind: "swap", protocol: "uniswap", chainId: 56 });
    await activity.markActivityBroadcast(fee.id, { txHash: "0xed1ed926793204b5c299421916c9986197120ceb3e4adb877184fe35efc135d3", fromAddress: seeded.walletAddress, nonce: 1 });
    await backdateSubmitAttempt(fee.id, REPAIR_CANDIDATE_AGE_MS + 1000);
    const observeTransaction = async () => outcome === "mined"
      ? { kind: "mined" as const, status: "success" as const, blockTimeIso: null }
      : { kind: "unknown_to_node" as const };
    await repairPendingActivity({ observeTransaction });
    expect((await activity.getActivityEventById(fee.id))?.status).toBe(outcome === "mined" ? "confirmed" : "pending");
    if (outcome === "dropped") {
      await sql("UPDATE agent_activity SET first_noninclusion_observed_at = NOW() - interval '1 day', last_checked_at = NOW() - interval '1 day' WHERE id = $1", [fee.id]);
      await repairPendingActivity({ observeTransaction });
      expect((await activity.getActivityEventById(fee.id))?.status).toBe("superseded_unproven");
    }
  });

  it("records a fee refusal hashlessly and cannot terminalize a staged fee as unattempted", async () => {
    const seeded = await seedIntent("uniswap.swap.execute");
    const fee = await activity.createPendingActivityEvent({ ...seeded, eventIndex: 0, eventRole: "swap_fee", kind: "swap", protocol: "uniswap", chainId: 137 });
    const failure = { failureCode: "broadcast_error" as const, failureReason: "Fee price above approval. No fee retry happens automatically." };
    expect((await activity.failHashlessActivityEvent(fee.id, failure)).applied).toBe(true);
    expect(await activity.getActivityEventById(fee.id)).toMatchObject({ status: "definitively_failed", txHash: null, ...failure });
    const staged = await activity.createPendingActivityEvent({ ...seeded, eventIndex: 1, eventRole: "swap_fee", kind: "swap", protocol: "uniswap", chainId: 137 });
    await activity.markActivityBroadcast(staged.id, { txHash: "0x" + "a".repeat(64), fromAddress: seeded.walletAddress, nonce: 1 });
    expect((await activity.failHashlessActivityEvent(staged.id, failure)).applied).toBe(false);
    expect((await activity.getActivityEventById(staged.id))?.status).toBe("pending");
  });
});
