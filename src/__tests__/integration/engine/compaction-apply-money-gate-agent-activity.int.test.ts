/**
 * Integration: the AGENT-ACTIVITY money-state writers vs the compaction
 * safe-moment gate — TWO REAL POSTGRES CLIENTS, never mocked SQL.
 *
 * Sibling of `compaction-apply-money-gate-interleaving.int.test.ts`; same
 * harness, same contract:
 *
 *   EITHER the gate saw the writer's row and deferred the cutover,
 *   OR the writer's write landed strictly AFTER the cutover committed.
 *
 * SCOPE — both directions across `agent_activity.status = 'pending'`:
 *
 *   INTO pending (the direction that can make the gate WRONG — an unlocked
 *   insert landing just after a `clear` read would let the cutover rewrite a
 *   transcript with a broadcast about to happen):
 *     - `createAgentActivityIntent`
 *     - `createBridgeActivityIntent`
 *     - `createAgentActivityPreBroadcastFailure`
 *   These transactions ALSO create the `protocol_executions` intent row, so
 *   they are where GROUP 2's `createExecutionIntent` takes its lock — there is
 *   one acquisition per transaction, not two. That is asserted here rather than
 *   in the protocol-executions file.
 *
 *   OUT OF pending:
 *     - `confirmActivityEvent`, `failActivityEvent`, `abortPlannedEvents`
 *     - `confirmBridgeExpectedFill`
 *
 * `recoverStaleHashlessIntents` is deliberately NOT a participant — a global,
 * removal-only sweep with no session to key on. Its module header carries the
 * reasoning, and the LAST case here pins the consequence so the exclusion stays
 * a decision rather than an oversight.
 *
 * The first case is the NON-PARTICIPATING BASELINE, proving this file's harness
 * detects a writer that skips the lock.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, getPool, queryOne } from "@vex-agent/db/client.js";
import * as agentActivityRepo from "@vex-agent/db/repos/agent-activity.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";
import { makeSession, resetDb } from "../setup/fixtures.js";
import { raceGateAgainstWriter } from "./money-gate-race-harness.js";

const TOOL_ID = "kyberswap_swap_execute";
const NAMESPACE = "kyberswap";
const WALLET = "0xX";
const CHAIN_ID = 8453;

const TOKEN_IN = {
  address: "0xin",
  symbol: "USDC",
  decimals: 6,
  amountHuman: "1",
  amountRaw: "1000000",
};
const TOKEN_OUT = {
  address: "0xout",
  symbol: "WETH",
  decimals: 18,
  amountHuman: "0.0003",
  amountRaw: "300000000000000",
};

function swapIntentInput(sessionId: string) {
  return {
    toolId: TOOL_ID,
    namespace: NAMESPACE,
    intentParams: { amount: "1" },
    events: [
      {
        eventIndex: 0,
        eventRole: "swap" as const,
        kind: "swap" as const,
        protocol: "kyberswap",
        chainId: CHAIN_ID,
        walletAddress: WALLET,
        sessionId,
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
      },
    ],
  };
}

/**
 * The bridge intent contract: Vex-signed legs PLUS exactly one planned logical
 * row (`expectedFill`). Mirrors `integration/agent-scan/bridge-cas.int.test.ts`.
 */
function bridgeIntentInput(sessionId: string) {
  return {
    toolId: "khalani.bridge",
    namespace: "khalani",
    protocol: "khalani",
    intentParams: { amount: "1" },
    walletAddress: WALLET,
    sessionId,
    route: {
      fromChainId: CHAIN_ID,
      fromChainSlug: "base",
      fromChainFamily: "eip155" as const,
      fromToken: "0xUSDC",
      toChainId: 42161,
      toChainSlug: "arbitrum",
      toChainFamily: "eip155" as const,
      toToken: "0xUSDCe",
    },
    legs: [
      {
        eventIndex: 0,
        eventRole: "bridge_deposit" as const,
        chainId: CHAIN_ID,
        chainSlug: "base",
        chainFamily: "eip155" as const,
        tokenIn: { tokenSymbol: "USDC", amountRaw: "2000000" },
      },
    ],
    expectedFill: {
      eventIndex: 1,
      chainId: 42161,
      chainSlug: "arbitrum",
      chainFamily: "eip155" as const,
      tokenIn: { tokenSymbol: "USDC", amountRaw: "2000000" },
      tokenOut: { tokenSymbol: "USDC", amountRaw: "1999000" },
      usdInEst: "2.00",
      usdSource: "khalani_token_price",
    },
  };
}

/** Seed a pending swap row, bypassing the race — fixture setup. */
async function seedPendingSwap(
  sessionId: string,
): Promise<{ executionId: number; eventId: number }> {
  const created = await agentActivityRepo.createAgentActivityIntent(
    swapIntentInput(sessionId),
  );
  return {
    executionId: created.executionId,
    eventId: created.events[0]!.id,
  };
}

/** Settle the paired `protocol_executions` row so it stops masking the gate. */
async function settleExecutionRow(executionId: number): Promise<void> {
  await execute(
    "UPDATE protocol_executions SET execution_status = 'succeeded' WHERE id = $1",
    [executionId],
  );
}

async function statusOfEvent(eventId: number): Promise<string> {
  const row = await queryOne<{ status: string }>(
    "SELECT status FROM agent_activity WHERE id = $1",
    [eventId],
  );
  return row?.status ?? "missing";
}

describe("agent-activity money-state writers participate in the session control lock", () => {
  let sessionId: string;

  beforeEach(async () => {
    await resetDb();
    sessionId = await makeSession();
  });

  // ── baseline ────────────────────────────────────────────────────────

  it("baseline: a NON-participating activity writer proves the harness detects the failure", async () => {
    // A raw INSERT into `pending` on its own connection, with no lock. It MUST
    // slip past — otherwise the assertions below would pass vacuously.
    const { executionId } = await seedPendingSwap(sessionId);
    const outcome = await raceGateAgainstWriter(sessionId, async () => {
      const client = await getPool().connect();
      try {
        return await client.query(
          `INSERT INTO agent_activity
             (protocol_execution_id, event_index, event_role, kind, protocol,
              chain_id, chain_family, wallet_address, session_id)
           VALUES ($1, 9, 'allowance', 'swap', 'kyberswap', $2, 'eip155', $3, $4)`,
          [executionId, CHAIN_ID, WALLET, sessionId],
        );
      } finally {
        client.release();
      }
    });
    expect(outcome.writerBlockedUntilCommit).toBe(false);
  });

  // ── INTO pending ────────────────────────────────────────────────────

  it("createAgentActivityIntent blocks until the gate transaction commits", async () => {
    const outcome = await raceGateAgainstWriter(sessionId, () =>
      agentActivityRepo.createAgentActivityIntent(swapIntentInput(sessionId)),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    // Strict order: the gate could not see rows that did not exist yet, and
    // they exist only after the cutover committed.
    expect(outcome.gateKinds).toEqual([]);
    // Both rows are now live money state — the NEXT apply attempt must defer.
    const after = await withSessionControlLock(sessionId, (client) =>
      getUnresolvedMoneyStateForSession(client, sessionId),
    );
    expect(after.clear).toBe(false);
    expect(
      after.clear ? [] : after.reasons.map((r) => r.kind).sort(),
    ).toEqual(["agent_activity_pending", "protocol_execution_intent"]);
  });

  it("createBridgeActivityIntent blocks until the gate transaction commits", async () => {
    const outcome = await raceGateAgainstWriter(sessionId, () =>
      agentActivityRepo.createBridgeActivityIntent(bridgeIntentInput(sessionId)),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    expect(outcome.gateKinds).toEqual([]);
  });

  it("createAgentActivityPreBroadcastFailure blocks — it still creates an intent row", async () => {
    // The activity row is born `definitively_failed` (nothing was ever
    // signed), but the transaction ALSO creates the `protocol_executions`
    // intent row, which IS gate money state. So it participates.
    const outcome = await raceGateAgainstWriter(sessionId, () =>
      agentActivityRepo.createAgentActivityPreBroadcastFailure({
        toolId: TOOL_ID,
        namespace: NAMESPACE,
        intentParams: { amount: "1" },
        event: {
          eventIndex: 0,
          eventRole: "swap" as const,
          kind: "swap" as const,
          protocol: "kyberswap",
          chainId: CHAIN_ID,
          walletAddress: WALLET,
          sessionId,
          tokenIn: TOKEN_IN,
          tokenOut: TOKEN_OUT,
          failureCode: "route_not_found" as const,
          failureReason: "no route",
        },
      }),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    expect(outcome.gateKinds).toEqual([]);
    const after = await withSessionControlLock(sessionId, (client) =>
      getUnresolvedMoneyStateForSession(client, sessionId),
    );
    // The activity row is already terminal; only the execution intent blocks.
    expect(
      after.clear ? [] : after.reasons.map((r) => r.kind).sort(),
    ).toEqual(["protocol_execution_intent"]);
  });

  // ── OUT OF pending ──────────────────────────────────────────────────

  it("confirmActivityEvent blocks until the gate transaction commits", async () => {
    const { executionId, eventId } = await seedPendingSwap(sessionId);
    await settleExecutionRow(executionId);
    // A confirmed swap REQUIRES a staged hash (`agent_activity_confirmed_has_hash`).
    await agentActivityRepo.markActivityBroadcast(eventId, {
      txHash: `0x${randomUUID().replace(/-/g, "")}`,
      fromAddress: WALLET,
      nonce: 1,
    });

    const outcome = await raceGateAgainstWriter(sessionId, () =>
      agentActivityRepo.confirmActivityEvent(eventId, {
        executedAmountInHuman: TOKEN_IN.amountHuman,
        executedAmountInRaw: TOKEN_IN.amountRaw,
        executedAmountOutHuman: TOKEN_OUT.amountHuman,
        executedAmountOutRaw: TOKEN_OUT.amountRaw,
      }),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    // The pending row was already live, so the gate correctly deferred.
    expect(outcome.gateKinds).toEqual(["agent_activity_pending"]);
    expect(await statusOfEvent(eventId)).toBe("confirmed");
    // Confirming clears the gate for the NEXT apply attempt.
    const after = await withSessionControlLock(sessionId, (client) =>
      getUnresolvedMoneyStateForSession(client, sessionId),
    );
    expect(after).toEqual({ clear: true });
  });

  it("failActivityEvent blocks until the gate transaction commits", async () => {
    const { executionId, eventId } = await seedPendingSwap(sessionId);
    await settleExecutionRow(executionId);

    const outcome = await raceGateAgainstWriter(sessionId, () =>
      agentActivityRepo.failActivityEvent(eventId, {
        failureCode: "mined_revert",
        failureReason: "execution reverted",
      }),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    expect(outcome.gateKinds).toEqual(["agent_activity_pending"]);
    expect(await statusOfEvent(eventId)).toBe("definitively_failed");
    const after = await withSessionControlLock(sessionId, (client) =>
      getUnresolvedMoneyStateForSession(client, sessionId),
    );
    expect(after).toEqual({ clear: true });
  });

  it("abortPlannedEvents blocks until the gate transaction commits", async () => {
    const { executionId, eventId } = await seedPendingSwap(sessionId);
    await settleExecutionRow(executionId);

    const outcome = await raceGateAgainstWriter(sessionId, () =>
      agentActivityRepo.abortPlannedEvents(executionId, 0, "upstream reverted"),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    expect(outcome.gateKinds).toEqual(["agent_activity_pending"]);
    expect(await statusOfEvent(eventId)).toBe("definitively_failed");
  });

  it("confirmBridgeExpectedFill blocks until the gate transaction commits", async () => {
    const created = await agentActivityRepo.createBridgeActivityIntent(
      bridgeIntentInput(sessionId),
    );
    if (created.outcome !== "created") {
      throw new Error(`fixture: bridge intent not created (${created.outcome})`);
    }
    await settleExecutionRow(created.executionId);

    const outcome = await raceGateAgainstWriter(sessionId, () =>
      agentActivityRepo.confirmBridgeExpectedFill({
        executionId: created.executionId,
        txHash: `0x${randomUUID().replace(/-/g, "")}`,
        evidenceSource: "provider_status",
        executedAmountOutHuman: TOKEN_OUT.amountHuman,
        executedAmountOutRaw: TOKEN_OUT.amountRaw,
      }),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    // TWO pending rows: the Vex-signed deposit leg and the planned logical fill
    // row. Both are live money state until each is finalized on its own path.
    expect(outcome.gateKinds).toEqual([
      "agent_activity_pending",
      "agent_activity_pending",
    ]);
  });

  // ── cross-session ───────────────────────────────────────────────────

  it("does NOT serialize an activity writer for a DIFFERENT session", async () => {
    const otherSession = await makeSession();

    const outcome = await raceGateAgainstWriter(sessionId, () =>
      agentActivityRepo.createAgentActivityIntent(swapIntentInput(otherSession)),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(false);
    expect(outcome.gateKinds).toEqual([]);
  });

  // ── the deliberate non-participant ──────────────────────────────────

  it("recoverStaleHashlessIntents does NOT serialize — a documented, removal-only exclusion", async () => {
    // PINS the exclusion. This global sweep has no session to key on, and it
    // only ever REMOVES rows from the gate's set, so it cannot make the gate
    // wrongly answer `clear`. If it ever gains a transition INTO `pending`,
    // this test must be replaced by a participating one — see the module
    // header of `db/repos/agent-activity/hashless-recovery.ts`.
    const { executionId, eventId } = await seedPendingSwap(sessionId);
    await settleExecutionRow(executionId);
    await execute(
      "UPDATE agent_activity SET created_at = NOW() - interval '2 hours' WHERE id = $1",
      [eventId],
    );

    const outcome = await raceGateAgainstWriter(sessionId, () =>
      agentActivityRepo.recoverStaleHashlessIntents(60_000, 10),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(false);
    // Unblocked, it finalizes INSIDE the gate's window, so the gate no longer
    // sees the pending row. That is the benign direction and the whole reason
    // this writer may stay out: removing money state can only make a cutover
    // proceed that would otherwise have deferred — never the reverse.
    expect(outcome.gateKinds).toEqual([]);
    expect(await statusOfEvent(eventId)).toBe("definitively_failed");
  });
});
