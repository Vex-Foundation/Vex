/**
 * THE WRAP LANE'S DURABLE RECOVERY, on real PostgreSQL.
 *
 * The sibling suite `wallet-wrap-terminal-settlement.int.test.ts` proves what
 * the confirm handler writes when it RETURNS. This one proves what happens when
 * it does not - the half that had no production consumer at all before fix
 * round C, and whose absence meant:
 *
 *  - a crash after the claim left the intent `consuming` FOREVER, and a
 *    `consuming` row blocks the compaction money-state gate on a session where
 *    nothing is executing;
 *  - a repair lane could confirm the wrap ACTIVITY row from a receipt while the
 *    wrap INTENT stayed `broadcast_unconfirmed`, for the same permanent block.
 *
 * Three properties, one per way the lifecycle can be left incomplete:
 *
 *  1. CRASH AFTER CLAIM, NO STAGED HASH -> the sweep terminalizes intent and
 *     activity TOGETHER. Staging strictly precedes broadcast, so no hash is
 *     POSITIVE evidence that nothing was sent.
 *  2. BROADCAST_UNCONFIRMED + A CHAIN-CONFIRMED RECEIPT -> the repair lane's own
 *     confirm call settles the ACTIVITY and the INTENT in ONE transaction.
 *  3. UNKNOWN OUTCOME STAYS PENDING. A staged hash with no chain verdict moves
 *     the intent to `broadcast_unconfirmed` and leaves the activity row PENDING,
 *     because that row is the candidate the chain-observing lane selects. A
 *     sweep must never invent a verdict it does not hold.
 *
 * The recovery is driven through the PRODUCTION entry point
 * (`recoverStrandedWrapIntents`), not through the repo primitives it composes:
 * the defect being fixed was precisely that nothing in production called them.
 */

import { createHash, randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { queryOne, query } from "@vex-agent/db/client.js";
import * as wrapIntentsRepo from "@vex-agent/db/repos/wallet-wrap-intents.js";
import { confirmActivityEventStatusOnly } from "@vex-agent/db/repos/agent-activity.js";
import { WRAP_PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-wrap-intent.js";
import {
  claimWrapIntent,
  type WrapActivity,
} from "@vex-agent/tools/internal/wallet/wrap/activity-writer.js";
import { recoverStrandedWrapIntents } from "@vex-agent/sync/wallet-wrap-intent-settlement.js";
import { REPAIR_CANDIDATE_AGE_MS } from "@vex-agent/sync/handler-window.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";

import { makeSession, resetDb } from "../setup/fixtures.js";

const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const WETH = "0x4200000000000000000000000000000000000006";
const CHAIN_ID = 8453;
const CHAIN_ALIAS = "base";

const TX_HASH = "0xaaaa000000000000000000000000000000000000000000000000000000000001";

const AMOUNT_RAW = "2500000000000000000";
const AMOUNT_HUMAN = "2.5";

const DEPOSIT_SELECTOR = "0xd0e30db0";

const CLEAR_FENCE = async (): Promise<{ ok: true; value: undefined }> => ({
  ok: true,
  value: undefined,
});

const NATIVE = { symbol: "ETH", decimals: 18 } as const;

interface ThreeRows {
  readonly wwi: {
    status: string;
    failure_stage: string | null;
    tx_hash: string | null;
    failure_reason: string | null;
  };
  readonly aa: { status: string; tx_hash: string | null; failure_code: string | null };
  readonly pe: { execution_status: string; success: boolean };
}

async function readThreeRows(
  intentId: string,
  activityId: number,
  executionId: number,
): Promise<ThreeRows> {
  const wwi = await queryOne<ThreeRows["wwi"]>(
    `SELECT status, failure_stage, tx_hash, failure_reason
       FROM wallet_wrap_intents WHERE intent_id = $1`,
    [intentId],
  );
  const aa = await queryOne<ThreeRows["aa"]>(
    "SELECT status, tx_hash, failure_code FROM agent_activity WHERE id = $1",
    [activityId],
  );
  const pe = await queryOne<ThreeRows["pe"]>(
    "SELECT execution_status, success FROM protocol_executions WHERE id = $1",
    [executionId],
  );
  if (wwi === null || aa === null || pe === null) throw new Error("a coupled row is missing");
  return { wwi, aa, pe };
}

async function prepareIntent(sessionId: string): Promise<wrapIntentsRepo.WalletWrapIntent> {
  const intentId = `wrp-${randomUUID()}`;
  await withSessionControlLock(sessionId, (client) =>
    wrapIntentsRepo.createWith(client, {
      intentId,
      sessionId,
      walletAddress: WALLET,
      chainAlias: CHAIN_ALIAS,
      chainId: CHAIN_ID,
      direction: "wrap",
      contract: { address: WETH, symbol: "WETH", decimals: 18 },
      amountRaw: AMOUNT_RAW,
      payload: { to: WETH, data: DEPOSIT_SELECTOR, valueWei: AMOUNT_RAW },
      preview: {
        label: "Wrap 2.5 ETH",
        criticalArgs: { chain: CHAIN_ALIAS, amount: AMOUNT_HUMAN },
      },
      feeBounds: {
        mode: "eip1559",
        gasLimit: "60000",
        maxFeePerGasWei: "2000000000",
        maxPriorityFeePerGasWei: "1000000000",
        maxTotalFeeWei: "120000000000000",
      },
      proposalDigest: createHash("sha256").update(intentId).digest("hex"),
      proposalDigestVersion: WRAP_PROPOSAL_DIGEST_VERSION,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }),
  );
  const row = await wrapIntentsRepo.getById(intentId, sessionId);
  if (row === null) throw new Error("prepare did not persist the wrap intent");
  return row;
}

interface Claimed {
  readonly intentId: string;
  readonly activityId: number;
  readonly executionId: number;
  readonly activity: WrapActivity;
}

async function claimed(sessionId: string): Promise<Claimed> {
  const intent = await prepareIntent(sessionId);
  const claim = await claimWrapIntent(
    intent,
    intent.proposalDigest,
    NATIVE,
    AMOUNT_HUMAN,
    CLEAR_FENCE,
  );
  if (!claim.ok) throw new Error(`claim failed: ${claim.reason}`);
  return {
    intentId: claim.intent.intentId,
    activityId: claim.activity.activityId,
    executionId: claim.activity.executionId,
    activity: claim.activity,
  };
}

/**
 * Age the claim past the handler window. The sweep's `consumed_at` gate is what
 * separates recovery from interference - a LIVE handler's row is legitimately
 * `consuming` - so the age has to be real, not stubbed.
 */
async function ageTheClaim(intentId: string): Promise<void> {
  await query(
    `UPDATE wallet_wrap_intents
        SET consumed_at = NOW() - ($2::bigint * INTERVAL '1 millisecond')
      WHERE intent_id = $1`,
    [intentId, String(REPAIR_CANDIDATE_AGE_MS + 60_000)],
  );
}

describe("a wrap intent stranded `consuming` by a dead handler", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("with NO staged hash, the sweep terminalizes the intent AND its activity", async () => {
    const sessionId = await makeSession();
    const { intentId, activityId, executionId } = await claimed(sessionId);
    await ageTheClaim(intentId);

    const result = await recoverStrandedWrapIntents();

    expect(result.examined).toBe(1);
    expect(result.crashedBeforeBroadcast).toBe(1);

    const rows = await readThreeRows(intentId, activityId, executionId);
    // No hash PROVES no broadcast, so this is an honest terminal and the row is
    // one from which preparing again is safe.
    expect(rows.wwi.status).toBe("failed");
    expect(rows.wwi.failure_stage).toBe("crashed_before_broadcast");
    expect(rows.wwi.tx_hash).toBeNull();
    expect(rows.aa.status).toBe("definitively_failed");
    expect(rows.aa.failure_code).toBe("broadcast_error");
    expect(rows.aa.tx_hash).toBeNull();
    // An execution row left at `intent` blocks the money-state gate on its own.
    expect(rows.pe.execution_status).not.toBe("intent");
  });

  it("a claim INSIDE the handler window is not touched at all", async () => {
    const sessionId = await makeSession();
    const { intentId, activityId, executionId } = await claimed(sessionId);
    // Deliberately NOT aged: a live confirm handler owns this row right now,
    // and terminalizing it would race a signing path.
    const result = await recoverStrandedWrapIntents();

    expect(result.examined).toBe(0);
    const rows = await readThreeRows(intentId, activityId, executionId);
    expect(rows.wwi.status).toBe("consuming");
    expect(rows.aa.status).toBe("pending");
    expect(rows.pe.execution_status).toBe("intent");
  });

  it("with a staged hash and NO chain verdict, the outcome stays UNKNOWN", async () => {
    const sessionId = await makeSession();
    const { intentId, activityId, executionId, activity } = await claimed(sessionId);
    await activity.stageEvm({ txHash: TX_HASH, fromAddress: WALLET, nonce: 12 });
    await ageTheClaim(intentId);

    const result = await recoverStrandedWrapIntents();

    expect(result.examined).toBe(1);
    expect(result.recoveredUnconfirmed).toBe(1);
    expect(result.crashedBeforeBroadcast).toBe(0);

    const rows = await readThreeRows(intentId, activityId, executionId);
    // Bytes may be on the network. This is never `failed`-with-a-hash: that
    // shape cannot be told apart from a revert and a reader of "failed" retries.
    expect(rows.wwi.status).toBe("broadcast_unconfirmed");
    expect(rows.wwi.tx_hash).toBe(TX_HASH);
    expect(rows.wwi.failure_stage).toBeNull();

    // THE POINT: the ACTIVITY row is left PENDING. It is the candidate the
    // chain-observing lane selects, and terminalizing it here would both invent
    // a verdict nobody holds and delete that candidate.
    expect(rows.aa.status).toBe("pending");
    expect(rows.aa.failure_code).toBeNull();
    expect(rows.aa.tx_hash).toBe(TX_HASH);

    // A SECOND pass changes nothing: the row is no longer `consuming`, so it is
    // not a stranded candidate, and no terminal was guessed in the meantime.
    const second = await recoverStrandedWrapIntents();
    expect(second.examined).toBe(0);
    const after = await readThreeRows(intentId, activityId, executionId);
    expect(after.wwi.status).toBe("broadcast_unconfirmed");
    expect(after.aa.status).toBe("pending");
  });
});

describe("a broadcast_unconfirmed wrap intent settled by a chain verdict", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("a confirmed receipt settles the ACTIVITY and the INTENT together", async () => {
    const sessionId = await makeSession();
    const { intentId, activityId, executionId, activity } = await claimed(sessionId);
    await activity.stageEvm({ txHash: TX_HASH, fromAddress: WALLET, nonce: 12 });
    await withSessionControlLock(sessionId, (client) =>
      wrapIntentsRepo.markBroadcastUnconfirmedWith(client, intentId, sessionId, TX_HASH));

    // The repair lane's OWN call: it read a receipt whose status is success and
    // has no decoded legs to publish. Before this fix it moved the activity row
    // and left the wrap intent behind.
    const settled = await confirmActivityEventStatusOnly(activityId, "receipt_status_only_evm");
    expect(settled.applied).toBe(true);

    const rows = await readThreeRows(intentId, activityId, executionId);
    expect(rows.aa.status).toBe("confirmed");
    expect(rows.wwi.status).toBe("executed");
    expect(rows.wwi.tx_hash).toBe(TX_HASH);
    expect(rows.pe.execution_status).toBe("succeeded");
    expect(rows.pe.success).toBe(true);
  });

  it("the intent settlement is part of the SAME transaction as the activity write", async () => {
    const sessionId = await makeSession();
    const { intentId, activityId, executionId, activity } = await claimed(sessionId);
    await activity.stageEvm({ txHash: TX_HASH, fromAddress: WALLET, nonce: 12 });
    // A durable winner already terminalized the INTENT with an incompatible
    // account of the same transaction. The coordinator must refuse and roll the
    // activity write back with it - a confirmed activity row over a
    // chain-reverted intent is two accounts of one transaction.
    await withSessionControlLock(sessionId, (client) =>
      wrapIntentsRepo.markChainFailedWith(
        client,
        intentId,
        sessionId,
        TX_HASH,
        "Revert:ab12cd34",
      ));

    await expect(
      confirmActivityEventStatusOnly(activityId, "receipt_status_only_evm"),
    ).rejects.toThrow(/wwi/);

    const rows = await readThreeRows(intentId, activityId, executionId);
    expect(rows.wwi.status).toBe("failed");
    expect(rows.aa.status).toBe("pending");
    expect(rows.pe.execution_status).toBe("intent");
  });
});
