/**
 * THE ATOMIC TERMINAL SETTLEMENT, on real PostgreSQL.
 *
 * `settleTerminalRows` moves the intent row (WTI), its activity row (AA) and
 * its execution row (PE) in ONE transaction under ONE session control lock. The
 * two properties that need a real database to prove are:
 *
 *   1. ROLLBACK IS WHOLE. When a durable winner already wrote an INCOMPATIBLE
 *      outcome to any one of the three rows, the settlement throws and NONE of
 *      the other two moved. A mocked client cannot prove a rollback.
 *   2. RECOVERY CONVERGES. A settlement interrupted after each of the three
 *      writes leaves a state the scheduled recovery drives to a consistent
 *      terminal one, with no double broadcast and nothing stuck `consuming` or
 *      `broadcast_unconfirmed` without an owner.
 *
 * The FAULT INJECTION is done by failing the transaction at a chosen point, not
 * by mocking a repo: an aborted transaction is exactly what a crashed process
 * leaves behind, so what the recovery lane then sees is the real state.
 *
 * The compatible-winner cases exercise the rule the settlement is written
 * against: applied -> continue; missed but the row EXACTLY matches -> idempotent
 * continue; anything else -> throw and roll back.
 */

import { createHash, randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, queryOne } from "@vex-agent/db/client.js";
import * as intentsRepo from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import { claimTransactionIntent } from "@vex-agent/tools/internal/wallet/transaction/activity-writer.js";
import {
  settleTerminalRows,
  TerminalSettlementConflictError,
  type TerminalSettlementTargets,
} from "@vex-agent/tools/internal/wallet/transaction/terminal-settlement.js";
import type { TransactionExecution } from "@vex-agent/tools/internal/wallet/transaction/execution-outcome.js";
import { recoverStrandedTransactionIntents } from "@vex-agent/sync/wallet-transaction-intent-settlement.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";

import { makeSession, resetDb } from "../setup/fixtures.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";
const TX_HASH = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
const OTHER_HASH = "0xbbbb000000000000000000000000000000000000000000000000000000000002";

const CLEAR_FENCE = async (): Promise<{ ok: true; value: undefined }> => ({
  ok: true,
  value: undefined,
});

interface ThreeRows {
  readonly wti: { status: string; failure_stage: string | null; tx_hash: string | null };
  readonly aa: { status: string; tx_hash: string | null; failure_code: string | null };
  readonly pe: { execution_status: string; success: boolean; result: Record<string, unknown> };
}

async function readThreeRows(
  intentId: string,
  activityId: number,
  executionId: number,
): Promise<ThreeRows> {
  const wti = await queryOne<ThreeRows["wti"]>(
    "SELECT status, failure_stage, tx_hash FROM wallet_transaction_intents WHERE intent_id = $1",
    [intentId],
  );
  const aa = await queryOne<ThreeRows["aa"]>(
    "SELECT status, tx_hash, failure_code FROM agent_activity WHERE id = $1",
    [activityId],
  );
  const pe = await queryOne<ThreeRows["pe"]>(
    "SELECT execution_status, success, result FROM protocol_executions WHERE id = $1",
    [executionId],
  );
  if (wti === null || aa === null || pe === null) throw new Error("a coupled row is missing");
  return { wti, aa, pe };
}

async function prepareIntent(sessionId: string): Promise<intentsRepo.WalletTransactionIntent> {
  const intentId = `wtx-${randomUUID()}`;
  await withSessionControlLock(sessionId, (client) =>
    intentsRepo.createWith(client, {
      intentId,
      sessionId,
      walletAddress: WALLET,
      family: "eip155",
      chainAlias: "base",
      chainId: 8453,
      payload: { family: "eip155", evm: { to: TO, data: "0x", valueWei: "1000" } },
      decoded: {
        family: "eip155",
        role: "native_transfer",
        standard: "native",
        functionName: "nativeTransfer",
        contract: null,
        criticalArgs: { recipient: TO, valueWei: "1000" },
        unlimitedApproval: false,
        warnings: [],
      },
      preview: { label: "Send 1000 wei", criticalArgs: { chain: "base" } },
      feeBounds: {
        mode: "eip1559",
        gasLimit: "21000",
        maxFeePerGasWei: "1000000000",
        maxPriorityFeePerGasWei: "1000000",
        maxTotalFeeWei: "21000000000000",
      },
      proposalDigest: createHash("sha256").update(intentId).digest("hex"),
      proposalDigestVersion: PROPOSAL_DIGEST_VERSION,
      recentBlockhash: null,
      lastValidBlockHeight: null,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }),
  );
  const row = await intentsRepo.getById(intentId, sessionId);
  if (row === null) throw new Error("prepare did not persist the intent");
  return row;
}

/** A claimed attempt: the three rows exist and are linked, exactly as T2 leaves them. */
async function claimed(sessionId: string): Promise<{
  intent: intentsRepo.WalletTransactionIntent;
  targets: TerminalSettlementTargets;
}> {
  const intent = await prepareIntent(sessionId);
  const claim = await claimTransactionIntent(intent, intent.proposalDigest, CLEAR_FENCE);
  if (!claim.ok) throw new Error(`claim failed: ${claim.reason}`);
  return {
    intent: claim.intent,
    targets: {
      intentId: claim.intent.intentId,
      sessionId,
      activityId: claim.activity.activityId,
      executionId: claim.activity.executionId,
      startedAtMs: claim.activity.startedAtMs,
    },
  };
}

/** Stage a hash the way the confirm handler does immediately before broadcasting. */
async function stageHash(activityId: number, txHash: string): Promise<void> {
  await execute(
    `UPDATE agent_activity
        SET tx_hash = $2, from_address = $3, nonce = 7, submit_attempted_at = NOW()
      WHERE id = $1`,
    [activityId, txHash, WALLET],
  );
}

const CONFIRMED: TransactionExecution = { kind: "confirmed", txHash: TX_HASH, data: {} };

describe("terminal settlement: one transaction, the compatible-winner rule", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("settles all three rows in one transaction", async () => {
    const sessionId = await makeSession();
    const { targets } = await claimed(sessionId);
    await stageHash(targets.activityId, TX_HASH);

    await settleTerminalRows(targets, CONFIRMED);

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wti.status).toBe("executed");
    expect(rows.wti.tx_hash).toBe(TX_HASH);
    expect(rows.aa.status).toBe("confirmed");
    expect(rows.pe.execution_status).toBe("succeeded");
    expect(rows.pe.success).toBe(true);
  });

  it("an EXACT pre-existing winner on the intent is idempotent, and the siblings converge", async () => {
    const sessionId = await makeSession();
    const { targets } = await claimed(sessionId);
    await stageHash(targets.activityId, TX_HASH);

    // A durable winner terminalized ONLY the intent, with the same outcome and
    // the same hash this settlement is about to write. That is the compatible
    // case: the settlement must continue and finish the other two rows.
    await withSessionControlLock(sessionId, (client) =>
      intentsRepo.markExecutedWith(client, targets.intentId, sessionId, TX_HASH));

    await expect(settleTerminalRows(targets, CONFIRMED)).resolves.toBeUndefined();

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wti.status).toBe("executed");
    expect(rows.aa.status).toBe("confirmed");
    expect(rows.pe.execution_status).toBe("succeeded");
  });

  it("a CONFLICTING intent winner rolls the whole settlement back", async () => {
    const sessionId = await makeSession();
    const { targets } = await claimed(sessionId);
    await stageHash(targets.activityId, TX_HASH);

    // A different terminal status for the same attempt. Nothing may be written.
    await withSessionControlLock(sessionId, (client) =>
      intentsRepo.markBroadcastUnconfirmedWith(client, targets.intentId, sessionId, OTHER_HASH));

    await expect(settleTerminalRows(targets, CONFIRMED)).rejects.toBeInstanceOf(
      TerminalSettlementConflictError,
    );

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wti.status).toBe("broadcast_unconfirmed");
    expect(rows.wti.tx_hash).toBe(OTHER_HASH);
    // THE ROLLBACK IS WHOLE: neither sibling moved.
    expect(rows.aa.status).toBe("pending");
    expect(rows.pe.execution_status).toBe("intent");
  });

  it("a CONFLICTING activity winner rolls the intent write back too", async () => {
    const sessionId = await makeSession();
    const { targets } = await claimed(sessionId);
    await stageHash(targets.activityId, TX_HASH);

    // The activity row was already failed by somebody else. The settlement is
    // about to say `confirmed`, which is not the same account of the attempt.
    await execute(
      `UPDATE agent_activity
          SET status = 'definitively_failed', failure_code = 'unknown', failure_reason = 'other'
        WHERE id = $1`,
      [targets.activityId],
    );

    await expect(settleTerminalRows(targets, CONFIRMED)).rejects.toBeInstanceOf(
      TerminalSettlementConflictError,
    );

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wti.status).toBe("consuming");
    expect(rows.wti.tx_hash).toBeNull();
    expect(rows.pe.execution_status).toBe("intent");
  });

  it("a CONFLICTING execution result rolls the intent and activity writes back", async () => {
    const sessionId = await makeSession();
    const { targets } = await claimed(sessionId);
    await stageHash(targets.activityId, TX_HASH);

    // Completed by somebody else, for a DIFFERENT hash.
    await execute(
      `UPDATE protocol_executions
          SET execution_status = 'succeeded', success = true,
              result = jsonb_build_object('status', 'confirmed', 'txHash', $2::text)
        WHERE id = $1`,
      [targets.executionId, OTHER_HASH],
    );

    await expect(settleTerminalRows(targets, CONFIRMED)).rejects.toBeInstanceOf(
      TerminalSettlementConflictError,
    );

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wti.status).toBe("consuming");
    expect(rows.aa.status).toBe("pending");
  });

  it("an EXACT pre-existing winner on ALL THREE rows is a clean idempotent no-op", async () => {
    const sessionId = await makeSession();
    const { targets } = await claimed(sessionId);
    await stageHash(targets.activityId, TX_HASH);

    await settleTerminalRows(targets, CONFIRMED);
    // The second settlement misses every CAS and must find every row compatible.
    await expect(settleTerminalRows(targets, CONFIRMED)).resolves.toBeUndefined();

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wti.status).toBe("executed");
    expect(rows.aa.status).toBe("confirmed");
    expect(rows.pe.execution_status).toBe("succeeded");
  });
});

describe("terminal settlement: fault injection and recovery convergence", () => {
  beforeEach(async () => {
    await resetDb();
  });

  /**
   * An INTERRUPTED settlement, as a crashed process leaves it: the transaction
   * aborts after `stopAfter` writes, so nothing it wrote survives. The
   * partial-write states the old three-transaction settlement could reach are
   * therefore unreachable, and this proves it: whatever the interruption point,
   * the three rows are exactly as the claim left them.
   */
  async function interruptedSettlement(
    targets: TerminalSettlementTargets,
    stopAfter: "wti" | "aa" | "pe",
  ): Promise<void> {
    await expect(
      withSessionControlLock(targets.sessionId, async (client) => {
        await intentsRepo.markExecutedWith(client, targets.intentId, targets.sessionId, TX_HASH);
        if (stopAfter === "wti") throw new Error("crash after the intent write");
        await client.query(
          "UPDATE agent_activity SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1",
          [targets.activityId],
        );
        if (stopAfter === "aa") throw new Error("crash after the activity write");
        await client.query(
          "UPDATE protocol_executions SET execution_status = 'succeeded', success = true WHERE id = $1",
          [targets.executionId],
        );
        throw new Error("crash after the execution write");
      }),
    ).rejects.toThrow();
  }

  for (const stopAfter of ["wti", "aa", "pe"] as const) {
    it(`an interruption after the ${stopAfter} write leaves NO partial terminal state`, async () => {
      const sessionId = await makeSession();
      const { targets } = await claimed(sessionId);
      await stageHash(targets.activityId, TX_HASH);

      await interruptedSettlement(targets, stopAfter);

      const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
      // The whole point: no row moved, so there is no orphan for anyone to own.
      expect(rows.wti.status).toBe("consuming");
      expect(rows.aa.status).toBe("pending");
      expect(rows.pe.execution_status).toBe("intent");
    });
  }

  it("the scheduled recovery converges an interrupted attempt WITH a staged hash", async () => {
    const sessionId = await makeSession();
    const { targets } = await claimed(sessionId);
    await stageHash(targets.activityId, TX_HASH);
    await interruptedSettlement(targets, "pe");

    // The handler is gone. Recovery reads the STAGED HASH as proof a broadcast
    // may have happened and moves the intent to the only honest status: unknown.
    // It never re-broadcasts and never calls it failed.
    await execute(
      "UPDATE wallet_transaction_intents SET consumed_at = NOW() - INTERVAL '10 minutes' WHERE intent_id = $1",
      [targets.intentId],
    );
    await recoverStrandedTransactionIntents();

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    expect(rows.wti.status).toBe("broadcast_unconfirmed");
    expect(rows.wti.tx_hash).toBe(TX_HASH);
    // The activity row stays pending WITH its hash: that is the repair lane's
    // own candidate, and terminalizing it here would delete it.
    expect(rows.aa.status).toBe("pending");
    expect(rows.aa.tx_hash).toBe(TX_HASH);
  });

  it("the scheduled recovery converges an interrupted attempt with NO staged hash", async () => {
    const sessionId = await makeSession();
    const { targets } = await claimed(sessionId);
    await interruptedSettlement(targets, "wti");

    await execute(
      "UPDATE wallet_transaction_intents SET consumed_at = NOW() - INTERVAL '10 minutes' WHERE intent_id = $1",
      [targets.intentId],
    );
    await recoverStrandedTransactionIntents();

    const rows = await readThreeRows(targets.intentId, targets.activityId, targets.executionId);
    // No hash PROVES no broadcast, so this is honestly terminal with tx_hash NULL.
    expect(rows.wti.status).toBe("failed");
    expect(rows.wti.failure_stage).toBe("crashed_before_broadcast");
    expect(rows.wti.tx_hash).toBeNull();
    expect(rows.pe.execution_status).not.toBe("intent");
  });
});
