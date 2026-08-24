/**
 * THE T1-T8 LIFECYCLE MATRIX, on real PostgreSQL.
 *
 * Stage A4b's transition table couples THREE rows - the
 * `wallet_transaction_intents` row (WTI), its `agent_activity` row (AA) and the
 * `protocol_executions` row (PE) - and every interesting failure of this arc is
 * a failure of the COUPLING, not of any one write. A mocked client cannot prove
 * a transaction boundary, cannot enforce a CHECK, and cannot tell you that a
 * hash landed on a row the schema forbids it on. So each transition below runs
 * the REAL function and then asserts ALL THREE ROWS.
 *
 * The transitions that get their own case are exactly the ones the reviewer
 * named: the ambiguous NORMAL return (T3d), crash recovery on both sides of the
 * staged-hash split (T4a, T4b), repair to confirmed and to reverted (T5), and
 * repair to `superseded_unproven` (T6). T1, T2, T7 and T8 are here too, because
 * a matrix with holes in it is a matrix nobody can read as a whole.
 */

import { createHash, randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, getPool, queryOne } from "@vex-agent/db/client.js";
import * as intentsRepo from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import { claimTransactionIntent } from "@vex-agent/tools/internal/wallet/transaction/activity-writer.js";
import { settleExecution } from "@vex-agent/tools/internal/wallet/transaction/confirm-shared.js";
import {
  recoverStrandedTransactionIntents,
  settleLinkedTransactionIntent,
} from "@vex-agent/sync/wallet-transaction-intent-settlement.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";

import { makeSession, resetDb } from "../setup/fixtures.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";

interface ThreeRows {
  readonly wti: {
    status: string;
    failure_stage: string | null;
    tx_hash: string | null;
    activity_id: string | null;
  };
  readonly aa: { id: number; status: string; kind: string; event_role: string; tx_hash: string | null } | null;
  readonly pe: { execution_status: string; success: boolean } | null;
}

async function readThreeRows(intentId: string): Promise<ThreeRows> {
  const wti = await queryOne<ThreeRows["wti"]>(
    `SELECT status, failure_stage, tx_hash, activity_id::text AS activity_id
       FROM wallet_transaction_intents WHERE intent_id = $1`,
    [intentId],
  );
  if (wti === null) throw new Error(`no intent row for ${intentId}`);
  const aa = wti.activity_id === null
    ? null
    : await queryOne<ThreeRows["aa"] & { protocol_execution_id: number }>(
        `SELECT id, status, kind, event_role, tx_hash, protocol_execution_id
           FROM agent_activity WHERE id = $1`,
        [wti.activity_id],
      );
  const pe = aa === null
    ? null
    : await queryOne<{ execution_status: string; success: boolean }>(
        "SELECT execution_status, success FROM protocol_executions WHERE id = $1",
        [(aa as unknown as { protocol_execution_id: number }).protocol_execution_id],
      );
  return { wti, aa, pe };
}

/** T1. One prepared intent, exactly as the prepare handler writes it. */
async function prepareIntent(
  sessionId: string,
  overrides: { expiresInMs?: number } = {},
): Promise<intentsRepo.WalletTransactionIntent> {
  const intentId = `wtx-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + (overrides.expiresInMs ?? 600_000)).toISOString();
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
      // A real 64-char hex sha256, the shape the durable-row parser now enforces.
      proposalDigest: createHash("sha256").update(intentId).digest("hex"),
      proposalDigestVersion: PROPOSAL_DIGEST_VERSION,
      recentBlockhash: null,
      lastValidBlockHeight: null,
      expiresAt,
    }),
  );
  const row = await intentsRepo.getById(intentId, sessionId);
  if (row === null) throw new Error("prepare did not persist the intent");
  return row;
}

/** T2, through the real claim transaction. */
async function claim(intent: intentsRepo.WalletTransactionIntent) {
  const claimed = await claimTransactionIntent(intent, intent.proposalDigest);
  if (!claimed.ok) throw new Error(`claim failed: ${claimed.reason} ${claimed.detail}`);
  return claimed;
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

/** Move a claim back in time so the crash-recovery age gate admits it. */
async function backdateClaim(intentId: string): Promise<void> {
  await execute(
    "UPDATE wallet_transaction_intents SET consumed_at = NOW() - INTERVAL '10 minutes' WHERE intent_id = $1",
    [intentId],
  );
}

describe("wallet_transaction_intents lifecycle T1-T8, three coupled rows", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("T1: prepare inserts a pending intent with no hash and no activity row", async () => {
    const sessionId = await makeSession();
    const intent = await prepareIntent(sessionId);
    const rows = await readThreeRows(intent.intentId);
    expect(rows.wti.status).toBe("pending");
    expect(rows.wti.tx_hash).toBeNull();
    expect(rows.wti.activity_id).toBeNull();
    expect(rows.aa).toBeNull();
  });

  it("T2: the claim transaction moves the intent, creates BOTH rows, and links them", async () => {
    const sessionId = await makeSession();
    const intent = await prepareIntent(sessionId);
    const claimed = await claim(intent);

    const rows = await readThreeRows(intent.intentId);
    expect(rows.wti.status).toBe("consuming");
    expect(rows.wti.tx_hash).toBeNull();
    expect(rows.wti.activity_id).toBe(String(claimed.activity.activityId));
    expect(rows.aa?.status).toBe("pending");
    // The TRUTHFUL vocabulary: a generic signed transaction is never `spot`,
    // and never the transfer shape either.
    expect(rows.aa?.kind).toBe("transaction");
    expect(rows.aa?.event_role).toBe("tx_native_transfer");
    expect(rows.aa?.tx_hash).toBeNull();
    expect(rows.pe?.execution_status).toBe("intent");
  });

  it("T2: a second claim of the same intent loses the race and writes nothing", async () => {
    const sessionId = await makeSession();
    const intent = await prepareIntent(sessionId);
    await claim(intent);

    const second = await claimTransactionIntent(intent, intent.proposalDigest);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("race_lost");

    const count = await queryOne<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM agent_activity WHERE session_id = $1",
      [sessionId],
    );
    expect(count?.c).toBe("1");
  });

  it("T2: a DRIFTED proposal digest cannot claim, and the intent stays pending", async () => {
    const sessionId = await makeSession();
    const intent = await prepareIntent(sessionId);

    const claimed = await claimTransactionIntent(intent, "digest-that-was-never-approved");
    expect(claimed.ok).toBe(false);

    const rows = await readThreeRows(intent.intentId);
    expect(rows.wti.status).toBe("pending");
    expect(rows.aa).toBeNull();
  });

  it("T3a: a confirmed return settles all three rows", async () => {
    const sessionId = await makeSession();
    const claimed = await claim(await prepareIntent(sessionId));
    await stageHash(claimed.activity.activityId, "0xhash-confirmed");

    await settleExecution(
      claimed.intent,
      claimed.activity,
      { kind: "confirmed", txHash: "0xhash-confirmed", data: {} },
      {},
    );

    const rows = await readThreeRows(claimed.intent.intentId);
    expect(rows.wti.status).toBe("executed");
    expect(rows.wti.tx_hash).toBe("0xhash-confirmed");
    expect(rows.aa?.status).toBe("confirmed");
    expect(rows.pe?.execution_status).toBe("succeeded");
  });

  it("T3c: a pre-broadcast failure is terminal with NO hash anywhere", async () => {
    const sessionId = await makeSession();
    const claimed = await claim(await prepareIntent(sessionId));

    await settleExecution(
      claimed.intent,
      claimed.activity,
      { kind: "pre_broadcast_failed", errorKind: "Error", errorHash: "abcd", message: "nope" },
      {},
    );

    const rows = await readThreeRows(claimed.intent.intentId);
    expect(rows.wti.status).toBe("failed");
    expect(rows.wti.failure_stage).toBe("pre_broadcast");
    expect(rows.wti.tx_hash).toBeNull();
    expect(rows.aa?.status).toBe("definitively_failed");
    expect(rows.pe?.execution_status).toBe("failed");
  });

  it("T3d: an AMBIGUOUS normal return keeps the activity row pending and completes the execution", async () => {
    const sessionId = await makeSession();
    const claimed = await claim(await prepareIntent(sessionId));
    await stageHash(claimed.activity.activityId, "0xhash-unknown");

    await settleExecution(
      claimed.intent,
      claimed.activity,
      {
        kind: "confirmation_unknown",
        txHash: "0xhash-unknown",
        chain: "base",
        errorKind: "ConfirmationUnknown",
        errorHash: "0123456789abcdef",
      },
      {},
    );

    const rows = await readThreeRows(claimed.intent.intentId);
    // NEVER `failed`-with-a-hash: that shape cannot be told apart from a revert.
    expect(rows.wti.status).toBe("broadcast_unconfirmed");
    expect(rows.wti.failure_stage).toBeNull();
    expect(rows.wti.tx_hash).toBe("0xhash-unknown");
    // The activity row stays staged-with-hash for the lane that owns chain
    // observation - it is the only row allowed to say the outcome is unknown.
    expect(rows.aa?.status).toBe("pending");
    expect(rows.aa?.tx_hash).toBe("0xhash-unknown");
    // The ATTEMPT is over even though the chain state is not, so the execution
    // row must not block the compaction gate forever.
    expect(rows.pe?.execution_status).toBe("failed");
  });

  it("T4a: crash recovery with NO staged hash proves no broadcast happened", async () => {
    const sessionId = await makeSession();
    const claimed = await claim(await prepareIntent(sessionId));
    await backdateClaim(claimed.intent.intentId);

    const recovered = await recoverStrandedTransactionIntents();
    expect(recovered.crashedBeforeBroadcast).toBe(1);

    const rows = await readThreeRows(claimed.intent.intentId);
    expect(rows.wti.status).toBe("failed");
    expect(rows.wti.failure_stage).toBe("crashed_before_broadcast");
    expect(rows.wti.tx_hash).toBeNull();
    expect(rows.aa?.status).toBe("definitively_failed");
    expect(rows.pe?.execution_status).toBe("failed");
  });

  it("T4b: crash recovery WITH a staged hash keeps the outcome unknown and never fails it", async () => {
    const sessionId = await makeSession();
    const claimed = await claim(await prepareIntent(sessionId));
    await stageHash(claimed.activity.activityId, "0xhash-crashed");
    await backdateClaim(claimed.intent.intentId);

    const recovered = await recoverStrandedTransactionIntents();
    expect(recovered.recoveredUnconfirmed).toBe(1);

    const rows = await readThreeRows(claimed.intent.intentId);
    expect(rows.wti.status).toBe("broadcast_unconfirmed");
    expect(rows.wti.tx_hash).toBe("0xhash-crashed");
    // UNCHANGED: it is staged-with-hash, which is exactly what makes it a
    // candidate for the repair lane that owns chain observation.
    expect(rows.aa?.status).toBe("pending");
    expect(rows.pe?.execution_status).toBe("failed");
  });

  it("T4: a FRESH claim is left alone - recovery is not interference with a live handler", async () => {
    const sessionId = await makeSession();
    const claimed = await claim(await prepareIntent(sessionId));

    const recovered = await recoverStrandedTransactionIntents();
    expect(recovered.examined).toBe(0);

    const rows = await readThreeRows(claimed.intent.intentId);
    expect(rows.wti.status).toBe("consuming");
  });

  it("T5: the repair lane settles an unconfirmed intent to executed", async () => {
    const sessionId = await makeSession();
    const claimed = await claim(await prepareIntent(sessionId));
    await stageHash(claimed.activity.activityId, "0xhash-t5");
    await settleExecution(
      claimed.intent,
      claimed.activity,
      { kind: "confirmation_unknown", txHash: "0xhash-t5", chain: "base", errorKind: "K", errorHash: "h" },
      {},
    );
    // The lane terminalizes its own row first; this is the settlement it then
    // performs for the intent hanging off it.
    await execute("UPDATE agent_activity SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1", [
      claimed.activity.activityId,
    ]);

    await settleLinkedTransactionIntent(
      claimed.activity.activityId,
      "confirmed",
      claimed.activity.executionId,
    );

    const rows = await readThreeRows(claimed.intent.intentId);
    expect(rows.wti.status).toBe("executed");
    expect(rows.wti.tx_hash).toBe("0xhash-t5");
    expect(rows.aa?.status).toBe("confirmed");
    expect(rows.pe?.execution_status).toBe("failed");
  });

  it("T5: the repair lane settles an unconfirmed intent to a chain revert", async () => {
    const sessionId = await makeSession();
    const claimed = await claim(await prepareIntent(sessionId));
    await stageHash(claimed.activity.activityId, "0xhash-t5b");
    await settleExecution(
      claimed.intent,
      claimed.activity,
      { kind: "confirmation_unknown", txHash: "0xhash-t5b", chain: "base", errorKind: "K", errorHash: "h" },
      {},
    );
    await execute(
      "UPDATE agent_activity SET status = 'definitively_failed', failure_code = 'mined_revert' WHERE id = $1",
      [claimed.activity.activityId],
    );

    await settleLinkedTransactionIntent(
      claimed.activity.activityId,
      "reverted",
      claimed.activity.executionId,
    );

    const rows = await readThreeRows(claimed.intent.intentId);
    expect(rows.wti.status).toBe("failed");
    expect(rows.wti.failure_stage).toBe("chain_reverted");
    // A revert is a REAL transaction: the hash the operator reads the receipt
    // from is required, not optional.
    expect(rows.wti.tx_hash).toBe("0xhash-t5b");
  });

  it("T6: `superseded_unproven` is carried through as itself and never as a failure", async () => {
    const sessionId = await makeSession();
    const claimed = await claim(await prepareIntent(sessionId));
    await stageHash(claimed.activity.activityId, "0xhash-t6");
    await settleExecution(
      claimed.intent,
      claimed.activity,
      { kind: "confirmation_unknown", txHash: "0xhash-t6", chain: "base", errorKind: "K", errorHash: "h" },
      {},
    );
    await execute("UPDATE agent_activity SET status = 'superseded_unproven' WHERE id = $1", [
      claimed.activity.activityId,
    ]);

    await settleLinkedTransactionIntent(
      claimed.activity.activityId,
      "superseded_unproven",
      claimed.activity.executionId,
    );

    const rows = await readThreeRows(claimed.intent.intentId);
    expect(rows.wti.status).toBe("superseded_unproven");
    expect(rows.wti.failure_stage).toBeNull();
    expect(rows.wti.tx_hash).toBe("0xhash-t6");
  });

  it("T5/T6: settling is IDEMPOTENT - a second verdict cannot rewrite a terminal intent", async () => {
    const sessionId = await makeSession();
    const claimed = await claim(await prepareIntent(sessionId));
    await stageHash(claimed.activity.activityId, "0xhash-twice");
    await settleExecution(
      claimed.intent,
      claimed.activity,
      { kind: "confirmation_unknown", txHash: "0xhash-twice", chain: "base", errorKind: "K", errorHash: "h" },
      {},
    );
    await settleLinkedTransactionIntent(claimed.activity.activityId, "confirmed", claimed.activity.executionId);
    await settleLinkedTransactionIntent(claimed.activity.activityId, "reverted", claimed.activity.executionId);

    const rows = await readThreeRows(claimed.intent.intentId);
    expect(rows.wti.status).toBe("executed");
    expect(rows.wti.failure_stage).toBeNull();
  });

  it("T7: the TTL sweep expires a stale pending intent and creates no rows", async () => {
    const sessionId = await makeSession();
    const intent = await prepareIntent(sessionId, { expiresInMs: -1000 });

    const expired = await withSessionControlLock(sessionId, (client) =>
      intentsRepo.expireStalePendingWith(client, sessionId),
    );
    expect(expired.map((row) => row.intentId)).toContain(intent.intentId);

    const rows = await readThreeRows(intent.intentId);
    expect(rows.wti.status).toBe("expired");
    expect(rows.wti.activity_id).toBeNull();
    expect(rows.aa).toBeNull();
  });

  it("T8: cancelling a pending intent is terminal, and a claim afterwards misses", async () => {
    const sessionId = await makeSession();
    const intent = await prepareIntent(sessionId);

    const cancelled = await withSessionControlLock(sessionId, (client) =>
      intentsRepo.cancelIfPendingWith(client, intent.intentId, sessionId),
    );
    expect(cancelled?.status).toBe("cancelled");

    const claimed = await claimTransactionIntent(intent, intent.proposalDigest);
    expect(claimed.ok).toBe(false);

    const rows = await readThreeRows(intent.intentId);
    expect(rows.wti.status).toBe("cancelled");
    expect(rows.aa).toBeNull();
  });

  it("cross-session: an intent id is not a capability", async () => {
    const owner = await makeSession();
    const stranger = await makeSession();
    const intent = await prepareIntent(owner);

    expect(await intentsRepo.getById(intent.intentId, stranger)).toBeNull();
    const claimed = await claimTransactionIntent(
      { ...intent, sessionId: stranger },
      intent.proposalDigest,
    );
    expect(claimed.ok).toBe(false);

    const rows = await readThreeRows(intent.intentId);
    expect(rows.wti.status).toBe("pending");
  });

  it("the schema REFUSES a hash on a status that means nothing was broadcast", async () => {
    const sessionId = await makeSession();
    const intent = await prepareIntent(sessionId);
    const client = await getPool().connect();
    try {
      await expect(
        client.query(
          "UPDATE wallet_transaction_intents SET tx_hash = '0xnope' WHERE intent_id = $1",
          [intent.intentId],
        ),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });
});
