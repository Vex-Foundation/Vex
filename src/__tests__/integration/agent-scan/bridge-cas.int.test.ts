/**
 * Bridge repo primitives (migration 045) against a REAL local Postgres — the
 * `_fixtures.ts` contract. These exercise the CAS/lock/immutability behavior that
 * lives in SQL, so they are integration (not mocked-client) tests.
 *
 * Pins (plan §2 + REVISION 2/3/4):
 *   - createBridgeActivityIntent creates every Vex-signed leg + EXACTLY ONE
 *     pending logical row (R2), route endpoints on every row (R1), the
 *     normalized route + quote/route-id provenance on the logical row (R5), the
 *     order id NOT yet attached;
 *   - attachProviderOrderId (C4): attach → same-id idempotent no-op → different-id
 *     conflict with NO write → not_pending once terminal (immutable);
 *   - confirmBridgeExpectedFill (R2/B4): pending -> confirmed with the fill hash +
 *     evidence, exactly once;
 *   - markBridgeLegObserved (B2): appends an extra observed fill / refund evidence
 *     row, deduplicated by tx hash;
 *   - failActivityEvent with 'bridge_refunded' fails the logical row (money back
 *     != success, R2);
 *   - createBridgePreBroadcastFailure (R15/C1): a single hashless
 *     definitively_failed logical row, no pending legs.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, it, expect } from "vitest";
import { execute } from "../../../vex-agent/db/client.js";

const trackedExecutions: number[] = [];
function track(executionId: number): number {
  trackedExecutions.push(executionId);
  return executionId;
}

afterEach(async () => {
  if (trackedExecutions.length === 0) return;
  const ids = trackedExecutions.splice(0, trackedExecutions.length);
  await execute(`DELETE FROM agent_activity WHERE protocol_execution_id = ANY($1::bigint[])`, [ids]);
  await execute(`DELETE FROM protocol_executions WHERE id = ANY($1::bigint[])`, [ids]);
});

function freshWallet(): string {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`;
}

function baseRoute() {
  return {
    fromChainId: 8453,
    fromChainSlug: "base",
    fromChainFamily: "eip155" as const,
    fromToken: "0xUSDC",
    toChainId: 42161,
    toChainSlug: "arbitrum",
    toChainFamily: "eip155" as const,
    toToken: "0xUSDCe",
  };
}

async function createIntent(repo: typeof import("../../../vex-agent/db/repos/agent-activity.js")) {
  const sessionId = `bridge-cas-${randomUUID()}`;
  const walletAddress = freshWallet();
  const result = await repo.createBridgeActivityIntent({
    toolId: "khalani.bridge",
    namespace: "khalani",
    protocol: "khalani",
    intentParams: { marker: sessionId },
    walletAddress,
    sessionId,
    route: baseRoute(),
    quoteRef: { quoteId: "Q-1", routeId: "R-1" },
    legs: [
      { eventIndex: 0, eventRole: "allowance", chainId: 8453, chainSlug: "base", chainFamily: "eip155", tokenIn: { tokenSymbol: "USDC", amountRaw: "2000000" } },
      { eventIndex: 1, eventRole: "bridge_deposit", chainId: 8453, chainSlug: "base", chainFamily: "eip155", tokenIn: { tokenSymbol: "USDC", amountRaw: "2000000" } },
    ],
    expectedFill: {
      eventIndex: 2,
      chainId: 42161,
      chainSlug: "arbitrum",
      chainFamily: "eip155",
      tokenIn: { tokenSymbol: "USDC", amountRaw: "2000000" },
      tokenOut: { tokenSymbol: "USDC", amountRaw: "1999000" },
      usdInEst: "2.00",
      usdSource: "khalani_token_price",
    },
  });
  if (result.outcome !== "created") throw new Error("expected created outcome");
  track(result.executionId);
  return { result, sessionId, walletAddress };
}

describe("bridge repo — createBridgeActivityIntent", () => {
  it("creates every leg + exactly one pending logical row with route endpoints and pre-sign provenance", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { result } = await createIntent(repo);
    if (result.outcome !== "created") throw new Error("unreachable");

    expect(result.legs).toHaveLength(2);
    for (const leg of result.legs) {
      expect(leg.kind).toBe("bridge");
      expect(leg.status).toBe("pending");
      expect(leg.fromChainId).toBe(8453);
      expect(leg.toChainId).toBe(42161);
      expect(leg.normalizedRoute).toBeNull();
      expect(leg.providerOrderId).toBeNull();
    }
    const fill = result.expectedFill;
    expect(fill.eventRole).toBe("bridge_fill_expected");
    expect(fill.status).toBe("pending");
    expect(fill.normalizedRoute).toBe("eip155:8453:0xusdc->eip155:42161:0xusdce");
    expect(fill.providerOrderId).toBeNull();
    expect(fill.chainId).toBe(42161);
    expect(fill.routeProvenance).toEqual({ quoteId: "Q-1", routeId: "R-1" });
  });
});

describe("bridge repo — attachProviderOrderId (C4)", () => {
  it("attach -> same-id idempotent -> different-id conflict (no write) -> not_pending once terminal", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { result } = await createIntent(repo);
    if (result.outcome !== "created") throw new Error("unreachable");
    const executionId = result.executionId;

    const attached = await repo.attachProviderOrderId({ executionId, providerOrderId: "ORDER-1" });
    expect(attached.outcome).toBe("attached");
    expect(attached.row?.providerOrderId).toBe("ORDER-1");

    const same = await repo.attachProviderOrderId({ executionId, providerOrderId: "ORDER-1" });
    expect(same.outcome).toBe("already_attached_same");
    expect(same.row?.providerOrderId).toBe("ORDER-1");

    const conflict = await repo.attachProviderOrderId({ executionId, providerOrderId: "ORDER-2" });
    expect(conflict.outcome).toBe("conflict_different_id");
    expect(conflict.row?.providerOrderId).toBe("ORDER-1");

    // confirm the logical row, then attach must report the terminal row immutable.
    await repo.confirmBridgeExpectedFill({
      executionId,
      txHash: "0xfill-attach",
      evidenceSource: "khalani_order_status",
    });
    const terminal = await repo.attachProviderOrderId({ executionId, providerOrderId: "ORDER-3" });
    expect(terminal.outcome).toBe("not_pending");
    expect(terminal.row?.providerOrderId).toBe("ORDER-1");
  });
});

describe("bridge repo — confirmBridgeExpectedFill (R2/B4)", () => {
  it("pending -> confirmed with the fill hash + evidence, applied:true exactly once", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { result } = await createIntent(repo);
    if (result.outcome !== "created") throw new Error("unreachable");
    const executionId = result.executionId;

    const first = await repo.confirmBridgeExpectedFill({
      executionId,
      txHash: "0xfill-1",
      evidenceSource: "khalani_order_status",
      providerStatus: "filled",
      executedAmountOutRaw: "1999000",
      executedAmountOutHuman: "1.999",
    });
    expect(first.applied).toBe(true);
    expect(first.row.status).toBe("confirmed");
    expect(first.row.txHash).toBe("0xfill-1");
    expect(first.row.evidenceSource).toBe("khalani_order_status");
    expect(first.row.confirmedAt).not.toBeNull();
    expect(first.row.executedAmountOutRaw).toBe("1999000");

    const second = await repo.confirmBridgeExpectedFill({
      executionId,
      txHash: "0xfill-1-again",
      evidenceSource: "khalani_order_status",
    });
    expect(second.applied).toBe(false);
    expect(second.row.status).toBe("confirmed");
    expect(second.row.txHash).toBe("0xfill-1");
  });
});

describe("bridge repo — markBridgeLegObserved (B2)", () => {
  it("appends an extra observed fill row and dedups by tx hash", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { result } = await createIntent(repo);
    if (result.outcome !== "created") throw new Error("unreachable");
    const executionId = result.executionId;
    await repo.confirmBridgeExpectedFill({ executionId, txHash: "0xfill-main", evidenceSource: "khalani_order_status" });

    const extra = await repo.markBridgeLegObserved({
      executionId,
      eventRole: "bridge_fill_observed",
      protocol: "khalani",
      chainId: 42161,
      chainSlug: "arbitrum",
      chainFamily: "eip155",
      txHash: "0xfill-extra",
      evidenceSource: "khalani_order_status",
      providerStatus: "filled",
    });
    expect(extra.inserted).toBe(true);
    expect(extra.row.eventRole).toBe("bridge_fill_observed");
    expect(extra.row.status).toBe("confirmed");
    expect(extra.row.evidenceSource).toBe("khalani_order_status");
    expect(extra.row.fromChainId).toBe(8453);
    expect(extra.row.toChainId).toBe(42161);

    const dup = await repo.markBridgeLegObserved({
      executionId,
      eventRole: "bridge_fill_observed",
      protocol: "khalani",
      chainId: 42161,
      chainFamily: "eip155",
      txHash: "0xfill-extra",
      evidenceSource: "khalani_order_status",
    });
    expect(dup.inserted).toBe(false);
    expect(dup.row.id).toBe(extra.row.id);
  });

  it("refund: fail the logical row with bridge_refunded + append a confirmed refund evidence row", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { result } = await createIntent(repo);
    if (result.outcome !== "created") throw new Error("unreachable");
    const executionId = result.executionId;

    const failed = await repo.failActivityEvent(result.expectedFill.id, {
      failureCode: "bridge_refunded",
      failureReason: "provider refunded the deposit",
    });
    expect(failed.applied).toBe(true);
    expect(failed.row.status).toBe("definitively_failed");
    expect(failed.row.failureCode).toBe("bridge_refunded");

    const refund = await repo.markBridgeLegObserved({
      executionId,
      eventRole: "bridge_refund",
      protocol: "khalani",
      chainId: 8453,
      chainSlug: "base",
      chainFamily: "eip155",
      txHash: "0xrefund-1",
      evidenceSource: "khalani_order_status",
      providerStatus: "refunded",
    });
    expect(refund.inserted).toBe(true);
    expect(refund.row.eventRole).toBe("bridge_refund");
    expect(refund.row.status).toBe("confirmed");
  });
});

describe("bridge repo — createBridgePreBroadcastFailure (R15/C1)", () => {
  it("creates a single hashless definitively_failed logical row and NO pending legs", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const sessionId = `bridge-cas-pbf-${randomUUID()}`;
    const walletAddress = freshWallet();
    const { executionId, expectedFill } = await repo.createBridgePreBroadcastFailure({
      toolId: "khalani.bridge",
      namespace: "khalani",
      protocol: "khalani",
      intentParams: { marker: sessionId },
      walletAddress,
      sessionId,
      route: baseRoute(),
      tokenIn: { tokenSymbol: "USDC", amountRaw: "2000000" },
      failureCode: "route_not_found",
      failureReason: "empty routes[] — no Khalani route for this pair",
    });
    track(executionId);

    expect(expectedFill.eventRole).toBe("bridge_fill_expected");
    expect(expectedFill.status).toBe("definitively_failed");
    expect(expectedFill.failureCode).toBe("route_not_found");
    expect(expectedFill.txHash).toBeNull();
    expect(expectedFill.normalizedRoute).not.toBeNull();

    const rows = await import("../../../vex-agent/db/client.js").then((c) =>
      c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM agent_activity WHERE protocol_execution_id = $1`,
        [executionId],
      ),
    );
    expect(rows[0]?.count).toBe("1");
  });
});

describe("bridge repo — markActivitySolanaBroadcast (B1 nonce matrix, coordinator addition)", () => {
  async function createSolanaOriginIntent(repo: typeof import("../../../vex-agent/db/repos/agent-activity.js")) {
    const sessionId = `bridge-sol-${randomUUID()}`;
    const walletAddress = freshWallet();
    const result = await repo.createBridgeActivityIntent({
      toolId: "khalani.bridge",
      namespace: "khalani",
      protocol: "khalani",
      intentParams: { marker: sessionId },
      walletAddress,
      sessionId,
      route: {
        fromChainId: 20011000000, fromChainSlug: "solana", fromChainFamily: "solana", fromToken: "So11111111111111111111111111111111111111112",
        toChainId: 8453, toChainSlug: "base", toChainFamily: "eip155", toToken: "0xUSDC",
      },
      quoteRef: { quoteId: "Q-SOL", routeId: "R-SOL" },
      legs: [
        { eventIndex: 0, eventRole: "bridge_deposit", chainId: 20011000000, chainSlug: "solana", chainFamily: "solana", tokenIn: { tokenSymbol: "SOL", amountRaw: "1000000" } },
      ],
      expectedFill: {
        eventIndex: 1, chainId: 8453, chainSlug: "base", chainFamily: "eip155",
        tokenIn: { tokenSymbol: "SOL", amountRaw: "1000000" },
        tokenOut: { tokenSymbol: "USDC", amountRaw: "990000" },
      },
    });
    if (result.outcome !== "created") throw new Error("expected created outcome");
    track(result.executionId);
    return result;
  }

  it("stages a base58 signature + blockhash evidence on a Solana leg with nonce NULL (W5 §2/R2b)", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const result = await createSolanaOriginIntent(repo);
    if (result.outcome !== "created") throw new Error("unreachable");
    const solanaLeg = result.legs[0]!;

    const staged = await repo.markActivitySolanaBroadcast(solanaLeg.id, {
      txHash: "5VfYtdmEZ9kQqvL1Sig58Base58Sig", fromAddress: "SoLFromAddr1111111111111111111111111111111",
      recentBlockhash: "FreshBlockhash1111111111111111111111111111", lastValidBlockHeight: 123456789,
    });
    expect(staged.applied).toBe(true);
    expect(staged.row?.txHash).toBe("5VfYtdmEZ9kQqvL1Sig58Base58Sig");
    expect(staged.row?.nonce).toBeNull();
    // The evidence pair is set atomically in the SAME CAS write (no second write).
    expect(staged.row?.recentBlockhash).toBe("FreshBlockhash1111111111111111111111111111");
    expect(staged.row?.lastValidBlockHeight).toBe(123456789);

    // Second stage attempt: CAS miss (tx_hash already set), never overwrite.
    const again = await repo.markActivitySolanaBroadcast(solanaLeg.id, {
      txHash: "OtherSig", fromAddress: "SoLFromAddr1111111111111111111111111111111",
      recentBlockhash: "OtherBlockhash11111111111111111111111111111", lastValidBlockHeight: 999,
    });
    expect(again.applied).toBe(false);
    expect(again.row?.txHash).toBe("5VfYtdmEZ9kQqvL1Sig58Base58Sig");
    expect(again.row?.recentBlockhash).toBe("FreshBlockhash1111111111111111111111111111");
  });

  it("refuses the Solana CAS on an EVM-family row (predicate miss, no write)", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { result } = await createIntent(repo);
    if (result.outcome !== "created") throw new Error("unreachable");
    const evmLeg = result.legs.find((l) => l.eventRole === "bridge_deposit")!;

    const staged = await repo.markActivitySolanaBroadcast(evmLeg.id, {
      txHash: "5NotAllowedOnEvm", fromAddress: "SoLFromAddr1111111111111111111111111111111",
      recentBlockhash: "FreshBlockhash1111111111111111111111111111", lastValidBlockHeight: 123456789,
    });
    expect(staged.applied).toBe(false);
    expect(staged.row?.txHash).toBeNull();
  });

  it("the EVM CAS on a Solana row is stopped by the 045 nonce CHECK (belt-and-suspenders)", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const result = await createSolanaOriginIntent(repo);
    if (result.outcome !== "created") throw new Error("unreachable");
    const solanaLeg = result.legs[0]!;

    await expect(
      repo.markActivityBroadcast(solanaLeg.id, { txHash: "0xWrongShape", fromAddress: "0xFrom", nonce: 1 }),
    ).rejects.toThrow();
  });
});

describe("bridge repo — abortPlannedEvents exclusive bound (FIX-A blocker 1)", () => {
  it("aborts only Vex-signed planned legs BELOW the bound; the logical expected-fill row stays pending", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { result } = await createIntent(repo);
    if (result.outcome !== "created") throw new Error("unreachable");
    const fill = result.expectedFill;

    // Ambiguous-deposit shape: abort planned rows from index 0 up to (but
    // EXCLUDING) the expected-fill index — the logical row must survive
    // pending so W4's recovery + the in-flight guard stay live.
    await repo.abortPlannedEvents(
      fill.protocolExecutionId, 0, "earlier bridge_deposit ambiguous", fill.eventIndex,
    );

    const { query } = await import("../../../vex-agent/db/client.js");
    const dbRows = (await query<Record<string, unknown>>(
      `SELECT event_index, event_role, status FROM agent_activity
        WHERE protocol_execution_id = $1 ORDER BY event_index`,
      [fill.protocolExecutionId],
    ));
    const byIndex = new Map(
      (dbRows as Array<Record<string, unknown>>).map((r) => [
        Number(r.event_index ?? (r as { eventIndex?: number }).eventIndex),
        String(r.status),
      ]),
    );
    // Legs 0 (allowance) and 1 (deposit was 'ambiguous' — here still planned in
    // this synthetic setup) are below the bound → definitively_failed.
    expect(byIndex.get(0)).toBe("definitively_failed");
    expect(byIndex.get(1)).toBe("definitively_failed");
    // The logical expected-fill row (index 2) is AT the exclusive bound → pending.
    expect(byIndex.get(fill.eventIndex)).toBe("pending");
  });
});

/**
 * R1 Step 3a, test 14 — the PROVIDER-ONLY CLOCK.
 *
 * The handler's own poll can run for about two minutes while the provider fast
 * lane sweeps every 30 s, so a write guarded only by `status='pending'` really
 * can replace a NEWER lane observation with an OLDER handler one. The guard has
 * to compare `provider_status_observed_at` — and it cannot use `last_checked_at`,
 * because three other writers advance that column and any one of them landing
 * between two provider observations would make the FRESHER one look stale.
 *
 * These cases live against a real Postgres because the whole guard is the CAS's
 * `WHERE` clause; a mocked client would assert only that we called our own code.
 */
describe("bridge repo — noteBridgeProviderObservation ordering (R1 Step 3a)", () => {
  it("an OLDER handler observation cannot replace a NEWER lane one, and says why", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { result } = await createIntent(repo);
    if (result.outcome !== "created") throw new Error("unreachable");
    const executionId = result.executionId;

    const newer = new Date().toISOString();
    const older = new Date(Date.parse(newer) - 60_000).toISOString();

    expect(await repo.noteBridgeProviderObservation({
      executionId, providerStatus: "published", observedAt: newer,
    })).toEqual({ applied: true });

    // The slow handler returns with what it read a minute ago.
    expect(await repo.noteBridgeProviderObservation({
      executionId, providerStatus: "created", observedAt: older,
    })).toEqual({ applied: false, reason: "stale_observation" });

    const row = await repo.getActivityEventById(result.expectedFill.id);
    expect(row?.providerStatus).toBe("published");
  });

  it("a NEWER observation still lands after an older one", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { result } = await createIntent(repo);
    if (result.outcome !== "created") throw new Error("unreachable");
    const executionId = result.executionId;

    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date().toISOString();
    await repo.noteBridgeProviderObservation({ executionId, providerStatus: "created", observedAt: older });
    expect(await repo.noteBridgeProviderObservation({
      executionId, providerStatus: "filled", observedAt: newer,
    })).toEqual({ applied: true });

    const row = await repo.getActivityEventById(result.expectedFill.id);
    expect(row?.providerStatus).toBe("filled");
  });

  it("a verification write between two provider observations does NOT make the fresher one stale", async () => {
    // The reason the clock is its own column. `touchLastChecked` is one of the
    // three other writers of `last_checked_at`; ordering on that column would
    // reject the observation below and silently drop a fresher provider status.
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { result } = await createIntent(repo);
    if (result.outcome !== "created") throw new Error("unreachable");
    const executionId = result.executionId;

    await repo.noteBridgeProviderObservation({
      executionId, providerStatus: "created", observedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await repo.touchLastChecked(result.expectedFill.id, "fill_not_mined");

    expect(await repo.noteBridgeProviderObservation({
      executionId, providerStatus: "filled", observedAt: new Date().toISOString(),
    })).toEqual({ applied: true });
    expect((await repo.getActivityEventById(result.expectedFill.id))?.providerStatus).toBe("filled");
  });

  it("refuses to observe a row that is no longer pending, by name", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { result } = await createIntent(repo);
    if (result.outcome !== "created") throw new Error("unreachable");
    const executionId = result.executionId;

    await repo.confirmBridgeExpectedFill({
      executionId, txHash: "0xfill-observe-terminal", evidenceSource: "khalani_order_status",
    });
    expect(await repo.noteBridgeProviderObservation({
      executionId, providerStatus: "filled", observedAt: new Date().toISOString(),
    })).toEqual({ applied: false, reason: "not_pending" });
  });
});
