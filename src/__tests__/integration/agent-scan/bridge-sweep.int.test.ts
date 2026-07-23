/**
 * W4 bridge order-status sweep against a REAL local Postgres — the mandatory
 * FIX-ROUND-1 verification suite Codex demanded (`_fixtures.ts` container, full
 * migration chain incl. 046). These exercise the PRODUCTION `BridgeRepairDeps`
 * SQL — `buildProductionBridgeRepairDeps()` — with ONLY the network-touching
 * seams (provider fetch, on-chain verify, in-memory reveal-clear) replaced by
 * deterministic test doubles. Everything that touches SQL (candidate reads with
 * the deposit-hash join, CAS confirm/fail, observed-leg append, idempotent
 * balance enqueue with the 046 unique index, confirm→enqueue recovery,
 * null-order-id recovery) runs against the real database.
 *
 * Covers (card FIX-C #8): official-shaped Relay status (txHashes/inTxHashes)
 * confirms + appends observed fills; mismatched correlation keeps pending; the
 * refund verify→write→terminalize path incl. an evidence-write-failure retry;
 * concurrent enqueue uniqueness; confirm→enqueue failure recovery incl. reveal
 * re-clearing; fairness ordering; null-order-id recovery.
 */
import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, it, expect, vi } from "vitest";

import { execute, query } from "@vex-agent/db/client.js";
import * as repo from "@vex-agent/db/repos/agent-activity.js";
import {
  buildProductionBridgeRepairDeps,
  repairPendingBridges,
  type BridgeRepairDeps,
  type KhalaniOrderView,
  type RelayStatusView,
} from "@vex-agent/sync/bridge-activity-repair.js";

const trackedExecutions: number[] = [];
function track(executionId: number): number {
  trackedExecutions.push(executionId);
  return executionId;
}

// A balances sync job per namespace is the join target for enqueue + the C3
// recovery query. Idempotent — the container is shared across the int run.
beforeAll(async () => {
  await execute(
    `INSERT INTO protocol_sync_jobs (namespace, sync_type) VALUES ('khalani', 'balances'), ('relay', 'balances')
     ON CONFLICT (namespace, sync_type) DO NOTHING`,
  );
});

afterEach(async () => {
  if (trackedExecutions.length === 0) return;
  const ids = trackedExecutions.splice(0, trackedExecutions.length);
  // FK-safe order: sync runs reference executions with no cascade.
  await execute(`DELETE FROM protocol_sync_runs WHERE execution_id = ANY($1::bigint[])`, [ids]);
  await execute(`DELETE FROM agent_activity WHERE protocol_execution_id = ANY($1::bigint[])`, [ids]);
  await execute(`DELETE FROM protocol_executions WHERE id = ANY($1::bigint[])`, [ids]);
});

function freshWallet(): string {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`;
}

function freshHash(): string {
  return `0x${(randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 64)}`;
}

const IN_TOKEN = "0xInToken0000000000000000000000000000cafe";
const OUT_TOKEN = "0xOutToken000000000000000000000000000beef";

interface SeededBridge {
  executionId: number;
  logicalId: number;
  sessionId: string;
  walletAddress: string;
  depositHash: string;
  normalizedRoute: string;
  orderId: string;
}

/** Seed a real bridge intent with a staged deposit hash; optionally attach a provider order id. */
async function seedBridge(protocol: "khalani" | "relay", attachOrder = true): Promise<SeededBridge> {
  const sessionId = `bridge-sweep-${randomUUID()}`;
  const walletAddress = freshWallet();
  const result = await repo.createBridgeActivityIntent({
    toolId: `${protocol}.bridge`,
    namespace: protocol,
    protocol,
    intentParams: { marker: sessionId },
    walletAddress,
    sessionId,
    route: {
      fromChainId: 8453,
      fromChainSlug: "base",
      fromChainFamily: "eip155",
      fromToken: IN_TOKEN,
      toChainId: 42161,
      toChainSlug: "arbitrum",
      toChainFamily: "eip155",
      toToken: OUT_TOKEN,
    },
    quoteRef: { quoteId: "Q-1", routeId: "R-1" },
    legs: [
      {
        eventIndex: 0,
        eventRole: "bridge_deposit",
        chainId: 8453,
        chainSlug: "base",
        chainFamily: "eip155",
        tokenIn: { tokenAddress: IN_TOKEN, tokenSymbol: "USDC", amountRaw: "2000000" },
      },
    ],
    expectedFill: {
      eventIndex: 1,
      chainId: 42161,
      chainSlug: "arbitrum",
      chainFamily: "eip155",
      tokenIn: { tokenAddress: IN_TOKEN, tokenSymbol: "USDC", amountRaw: "2000000" },
      tokenOut: { tokenAddress: OUT_TOKEN, tokenSymbol: "USDC", amountRaw: "1999000" },
      usdInEst: "2.00",
      usdSource: "test",
    },
  });
  if (result.outcome !== "created") throw new Error("seedBridge: expected created outcome");
  track(result.executionId);

  const depositLeg = result.legs.find((l) => l.eventRole === "bridge_deposit")!;
  const depositHash = freshHash();
  await repo.markActivityBroadcast(depositLeg.id, { txHash: depositHash, fromAddress: walletAddress, nonce: 0 });

  const orderId = `ord-${randomUUID()}`;
  if (attachOrder) {
    const attached = await repo.attachProviderOrderId({ executionId: result.executionId, providerOrderId: orderId });
    if (attached.outcome !== "attached") throw new Error(`seedBridge: attach failed (${attached.outcome})`);
  }

  return {
    executionId: result.executionId,
    logicalId: result.expectedFill.id,
    sessionId,
    walletAddress,
    depositHash,
    normalizedRoute: result.expectedFill.normalizedRoute!,
    orderId,
  };
}

/** A matching-identity Khalani order view for a seeded bridge (correlation passes). */
function khalaniOrderFor(
  seed: SeededBridge,
  status: string,
  transactions: KhalaniOrderView["transactions"] = {},
  overrides: Partial<KhalaniOrderView> = {},
): KhalaniOrderView {
  return {
    id: seed.orderId,
    status,
    fromChainId: 8453,
    toChainId: 42161,
    quoteId: "Q-1",
    routeId: "R-1",
    fromToken: IN_TOKEN,
    toToken: OUT_TOKEN,
    author: seed.walletAddress,
    depositTxHash: seed.depositHash,
    transactions,
    ...overrides,
  };
}

/** A matching-identity official-shaped Relay status view for a seeded bridge. */
function relayStatusFor(seed: SeededBridge, status: string, txHashes?: string[]): RelayStatusView {
  return {
    status,
    txHashes,
    inTxHashes: [seed.depositHash],
    originChainId: 8453,
    destinationChainId: 42161,
  };
}

function depsWith(overrides: Partial<BridgeRepairDeps>): BridgeRepairDeps {
  return { ...buildProductionBridgeRepairDeps(), ...overrides };
}

async function balanceRunCount(executionId: number): Promise<number> {
  const rows = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM protocol_sync_runs r
       JOIN protocol_sync_jobs j ON j.id = r.sync_job_id
      WHERE r.execution_id = $1 AND j.sync_type = 'balances'`,
    [executionId],
  );
  return Number(rows[0]?.count ?? "0");
}

async function rowsByRole(executionId: number, eventRole: string): Promise<Array<Record<string, unknown>>> {
  return query<Record<string, unknown>>(
    `SELECT * FROM agent_activity WHERE protocol_execution_id = $1 AND event_role = $2 ORDER BY event_index ASC`,
    [executionId, eventRole],
  );
}

// ── 1. Official-shaped Relay status confirms + appends observed fills ─────────

describe("W4 sweep — official-shaped Relay success (txHashes/inTxHashes)", () => {
  it("confirms the logical row from txHashes[0], appends the extra fills, enqueues balance, clears the reveal", async () => {
    const seed = await seedBridge("relay");
    const primary = freshHash();
    const extra = freshHash();
    const revealCleared: Array<[string, string]> = [];

    const deps = depsWith({
      fetchRelayStatus: async () => relayStatusFor(seed, "success", [primary, extra]),
      verifyFill: async () => ({ verified: true }),
      clearRelayReveal: (sessionId, routeKey) => revealCleared.push([sessionId, routeKey]),
    });

    const result = await repairPendingBridges(deps);
    expect(result.confirmed).toBe(1);

    const logical = await repo.getActivityEventById(seed.logicalId);
    expect(logical?.status).toBe("confirmed");
    expect(logical?.txHash).toBe(primary);
    expect(logical?.evidenceSource).toBe("relay_intent_status");

    const observedFills = await rowsByRole(seed.executionId, "bridge_fill_observed");
    expect(observedFills).toHaveLength(1);
    expect(observedFills[0]?.tx_hash).toBe(extra);
    expect(observedFills[0]?.status).toBe("confirmed");

    expect(await balanceRunCount(seed.executionId)).toBe(1);
    expect(revealCleared).toEqual([[seed.sessionId, seed.normalizedRoute]]);
  });

  it("only txHashes present, no extras → confirms with no observed rows", async () => {
    const seed = await seedBridge("relay");
    const primary = freshHash();
    const deps = depsWith({
      fetchRelayStatus: async () => relayStatusFor(seed, "success", [primary]),
      verifyFill: async () => ({ verified: true }),
      clearRelayReveal: () => {},
    });
    await repairPendingBridges(deps);
    expect((await repo.getActivityEventById(seed.logicalId))?.status).toBe("confirmed");
    expect(await rowsByRole(seed.executionId, "bridge_fill_observed")).toHaveLength(0);
  });
});

// ── 2. Mismatched correlation keeps pending ──────────────────────────────────

describe("W4 sweep — R6 correlation gate", () => {
  it("a mismatched author (same order id) keeps the logical row pending — never confirms", async () => {
    const seed = await seedBridge("khalani");
    const verifyFill = vi.fn().mockResolvedValue({ verified: true });
    const deps = depsWith({
      fetchKhalaniOrder: async () =>
        khalaniOrderFor(seed, "filled", { fill: { txHash: freshHash(), chainId: 42161 } }, { author: freshWallet() }),
      verifyFill,
    });
    const result = await repairPendingBridges(deps);
    expect(result.confirmed).toBe(0);
    expect(result.stillPending).toBe(1);
    expect(verifyFill).not.toHaveBeenCalled(); // correlation blocks BEFORE on-chain verify
    expect((await repo.getActivityEventById(seed.logicalId))?.status).toBe("pending");
    expect(await balanceRunCount(seed.executionId)).toBe(0);
  });

  it("the stored deposit hash absent from Relay inTxHashes[] keeps pending (deposit_hash mismatch)", async () => {
    const seed = await seedBridge("relay");
    const deps = depsWith({
      fetchRelayStatus: async () => ({
        status: "success",
        txHashes: [freshHash()],
        inTxHashes: [freshHash()], // someone else's deposit
        originChainId: 8453,
        destinationChainId: 42161,
      }),
      verifyFill: async () => ({ verified: true }),
    });
    const result = await repairPendingBridges(deps);
    expect(result.stillPending).toBe(1);
    expect((await repo.getActivityEventById(seed.logicalId))?.status).toBe("pending");
  });
});

// ── 3. Refund verify→write→terminalize + evidence-write-failure retry ─────────

describe("W4 sweep — refund evidence (Blocker 8)", () => {
  it("verifies the refund, writes the evidence row, THEN terminalizes bridge_refunded", async () => {
    const seed = await seedBridge("khalani");
    const refundHash = freshHash();
    const deps = depsWith({
      fetchKhalaniOrder: async () => khalaniOrderFor(seed, "refunded", { refund: { txHash: refundHash, chainId: 8453 } }),
      verifyFill: async () => ({ verified: true }),
    });
    const result = await repairPendingBridges(deps);
    expect(result.refunded).toBe(1);

    const logical = await repo.getActivityEventById(seed.logicalId);
    expect(logical?.status).toBe("definitively_failed");
    expect(logical?.failureCode).toBe("bridge_refunded");

    const refundRows = await rowsByRole(seed.executionId, "bridge_refund");
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]?.tx_hash).toBe(refundHash);
    expect(refundRows[0]?.status).toBe("confirmed");
  });

  it("an evidence-write failure keeps the row pending, then a later sweep completes it (no permanent loss)", async () => {
    const seed = await seedBridge("khalani");
    const refundHash = freshHash();

    // Pass 1: the evidence write throws — the row must stay pending, no refund row.
    const failingDeps = depsWith({
      fetchKhalaniOrder: async () => khalaniOrderFor(seed, "refunded", { refund: { txHash: refundHash, chainId: 8453 } }),
      verifyFill: async () => ({ verified: true }),
      appendRefundEvidence: async () => {
        throw new Error("transient write failure Authorization: Bearer SECRET");
      },
    });
    const firstResult = await repairPendingBridges(failingDeps);
    expect(firstResult.refunded).toBe(0);
    expect(firstResult.stillPending).toBe(1);
    expect((await repo.getActivityEventById(seed.logicalId))?.status).toBe("pending");
    expect(await rowsByRole(seed.executionId, "bridge_refund")).toHaveLength(0);

    // Pass 2: the real evidence write succeeds — now it terminalizes.
    const realDeps = depsWith({
      fetchKhalaniOrder: async () => khalaniOrderFor(seed, "refunded", { refund: { txHash: refundHash, chainId: 8453 } }),
      verifyFill: async () => ({ verified: true }),
    });
    const secondResult = await repairPendingBridges(realDeps);
    expect(secondResult.refunded).toBe(1);
    expect((await repo.getActivityEventById(seed.logicalId))?.status).toBe("definitively_failed");
    expect(await rowsByRole(seed.executionId, "bridge_refund")).toHaveLength(1);
  });

  it("an unverifiable refund hash keeps the whole row pending (no evidence, no terminalize)", async () => {
    const seed = await seedBridge("khalani");
    const deps = depsWith({
      fetchKhalaniOrder: async () => khalaniOrderFor(seed, "refunded", { refund: { txHash: freshHash(), chainId: 8453 } }),
      verifyFill: async () => ({ verified: false, reason: "not_yet_confirmed" }),
    });
    const result = await repairPendingBridges(deps);
    expect(result.refunded).toBe(0);
    expect(result.stillPending).toBe(1);
    expect((await repo.getActivityEventById(seed.logicalId))?.status).toBe("pending");
    expect(await rowsByRole(seed.executionId, "bridge_refund")).toHaveLength(0);
  });
});

// ── 4. Concurrent enqueue uniqueness (migration 046) ─────────────────────────

describe("W4 sweep — idempotent balance enqueue (migration 046 unique index)", () => {
  it("concurrent enqueues for the same execution produce EXACTLY ONE run", async () => {
    const seed = await seedBridge("khalani");
    const deps = buildProductionBridgeRepairDeps();
    // Fire many concurrent enqueues — the partial unique index + ON CONFLICT make
    // all but one a no-op instead of duplicating the run.
    await Promise.all(
      Array.from({ length: 8 }, () => deps.enqueueBalanceRefresh({ namespace: "khalani", executionId: seed.executionId })),
    );
    expect(await balanceRunCount(seed.executionId)).toBe(1);
  });
});

// ── 5. Confirm→enqueue failure recovery incl. reveal re-clearing ─────────────

describe("W4 sweep — confirm→enqueue failure recovery (C3)", () => {
  it("recovers a confirmed-but-unenqueued relay row on the next sweep and re-clears its reveal", async () => {
    const seed = await seedBridge("relay");
    const primary = freshHash();

    // Pass 1: confirm succeeds but the enqueue throws — row confirmed, NO run.
    const revealPass1: Array<[string, string]> = [];
    const crashingDeps = depsWith({
      fetchRelayStatus: async () => relayStatusFor(seed, "success", [primary]),
      verifyFill: async () => ({ verified: true }),
      clearRelayReveal: (s, r) => revealPass1.push([s, r]),
      enqueueBalanceRefresh: async () => {
        throw new Error("enqueue down");
      },
    });
    const first = await repairPendingBridges(crashingDeps);
    expect(first.confirmed).toBe(1);
    expect((await repo.getActivityEventById(seed.logicalId))?.status).toBe("confirmed");
    expect(await balanceRunCount(seed.executionId)).toBe(0); // both the confirm-path AND same-sweep reconcile enqueue failed
    // The reveal is cleared BEFORE the failing enqueue (confirm path), and the
    // same-sweep reconcile clears it again — idempotent, and the row is left
    // recoverable (confirmed, reveal cleared, no run).
    expect(revealPass1).toContainEqual([seed.sessionId, seed.normalizedRoute]);

    // Pass 2: no pending candidate now; the recovery path finds the confirmed row,
    // enqueues (real) AND re-clears the reveal.
    const revealPass2: Array<[string, string]> = [];
    const recoveryDeps = depsWith({
      fetchRelayStatus: async () => null,
      clearRelayReveal: (s, r) => revealPass2.push([s, r]),
    });
    const second = await repairPendingBridges(recoveryDeps);
    expect(second.balanceReconciled).toBe(1);
    expect(await balanceRunCount(seed.executionId)).toBe(1);
    expect(revealPass2).toEqual([[seed.sessionId, seed.normalizedRoute]]);

    // Pass 3: fully settled — nothing left to reconcile.
    const third = await repairPendingBridges(depsWith({ fetchRelayStatus: async () => null, clearRelayReveal: () => {} }));
    expect(third.balanceReconciled).toBe(0);
  });
});

// ── 6. Fairness ordering ─────────────────────────────────────────────────────

describe("W4 sweep — fair scheduling (oldest-touched first)", () => {
  it("processes candidates ordered by COALESCE(last_attempted_at, created_at) ASC", async () => {
    const older = await seedBridge("khalani");
    const middle = await seedBridge("khalani");
    const neverAttempted = await seedBridge("khalani");
    // Backdate two of them; the third keeps last_attempted_at NULL (uses created_at ≈ now → served last).
    await execute(
      `UPDATE agent_activity SET last_attempted_at = NOW() - INTERVAL '2 days'
        WHERE protocol_execution_id = $1 AND event_role = 'bridge_fill_expected'`,
      [older.executionId],
    );
    await execute(
      `UPDATE agent_activity SET last_attempted_at = NOW() - INTERVAL '1 day'
        WHERE protocol_execution_id = $1 AND event_role = 'bridge_fill_expected'`,
      [middle.executionId],
    );

    const fetchOrder: string[] = [];
    const deps = depsWith({
      fetchKhalaniOrder: async (orderId) => {
        fetchOrder.push(orderId);
        return null; // stay pending; we only care about the order candidates are visited
      },
    });
    await repairPendingBridges(deps);
    // Only our three seeds (filter to be robust against any residue from parallel files is unnecessary —
    // afterEach isolates; but assert our three appear oldest-first and contiguous).
    const ours = fetchOrder.filter((id) => [older.orderId, middle.orderId, neverAttempted.orderId].includes(id));
    expect(ours).toEqual([older.orderId, middle.orderId, neverAttempted.orderId]);
  });
});

// ── 7. Null-order-id recovery ────────────────────────────────────────────────

describe("W4 sweep — null-order-id recovery (R5)", () => {
  it("finds a staged deposit with no order id, looks it up, and attaches it", async () => {
    const seed = await seedBridge("khalani", /* attachOrder */ false);
    const recoveredId = `ord-recovered-${randomUUID()}`;
    const deps = depsWith({
      recoverKhalaniOrderId: async () => recoveredId,
    });
    const result = await repairPendingBridges(deps);
    expect(result.recovered).toBe(1);

    const logical = await repo.getActivityEventById(seed.logicalId);
    expect(logical?.providerOrderId).toBe(recoveredId);
    expect(logical?.status).toBe("pending"); // recovery attaches an id; it does not terminalize
  });

  it("no order found yet → stays pending with no order id attached", async () => {
    const seed = await seedBridge("khalani", false);
    const deps = depsWith({ recoverKhalaniOrderId: async () => null });
    const result = await repairPendingBridges(deps);
    expect(result.recovered).toBe(0);
    const logical = await repo.getActivityEventById(seed.logicalId);
    expect(logical?.providerOrderId).toBeNull();
    expect(logical?.status).toBe("pending");
  });
});
