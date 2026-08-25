/**
 * THE REPAIR OWNER FOR AN INTENT STILL `consuming` UNDER A TERMINAL ACTIVITY
 * ROW, on real PostgreSQL, through the REAL Solana repair entrypoint.
 *
 * ## The stranding this file is the regression guard for
 *
 * The confirm handler claims the intent (`consuming`), stages its signed hash on
 * the activity row, and then the process dies. Two orderings follow, and both
 * used to end with an intent nobody owned:
 *
 *   LANE FIRST - the Solana lane observes the hash and terminalizes the ACTIVITY
 *     row while the intent is still `consuming`. The linked settlement only
 *     moved `broadcast_unconfirmed` rows, so it skipped this one. The stranded
 *     scan later flipped it to `broadcast_unconfirmed` - and by then the
 *     activity row was terminal, so no lane would ever select it again. The
 *     intent blocked the money-state gate forever.
 *
 *   SCAN FIRST - the same end state reached the other way round: the scan finds
 *     a `consuming` intent whose activity row is ALREADY terminal, and parks it
 *     at `broadcast_unconfirmed` under a row nothing will look at again.
 *
 * Both are fixed by spending evidence that already exists rather than by adding
 * a second chain observer: the lane converges the intent in the SAME repair
 * action, from the verdict it just established; the scan converges it from the
 * verdict already written on the terminal row in front of it.
 *
 * ## What is real
 *
 * The intent row, the claim transaction, the activity row, the execution row,
 * the settlement CAS chain and `repairPendingSolanaActivity` itself. Only the
 * Solana RPC is a seam - it is the sweep's own injected port, and what an
 * observation MEANS is production code either way.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedMessage,
} from "@solana/web3.js";

import { execute, queryOne } from "@vex-agent/db/client.js";
import * as intentsRepo from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import { claimTransactionIntent } from "@vex-agent/tools/internal/wallet/transaction/activity-writer.js";
import { canonicalTransactionPreview } from "@vex-agent/tools/internal/wallet/transaction/preview.js";
import { decodeSolanaTransaction } from "@vex-agent/tools/internal/wallet/transaction/decode-solana.js";
import { digestOfIntent } from "@vex-agent/tools/internal/wallet/transaction/revalidate.js";
import { repairPendingSolanaActivity } from "@vex-agent/sync/solana-activity-repair.js";
import type { SolanaActivitySweepDeps } from "@vex-agent/sync/solana-activity-repair/sweep-port.js";
import { recoverStrandedTransactionIntents } from "@vex-agent/sync/wallet-transaction-intent-settlement.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";

import { makeSession, resetDb } from "../setup/fixtures.js";

const SOL_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(7));
const SOL_WALLET = SOL_KEYPAIR.publicKey.toBase58();
const SOL_OTHER = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
const BLOCKHASH = PublicKey.default.toBase58();
/** A signature-shaped string. The lane treats it as an opaque key, never parses it. */
const SIGNATURE = "5".repeat(64);

const SOL_MESSAGE_BASE64 = Buffer.from(
  new TransactionMessage({
    payerKey: SOL_KEYPAIR.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: SOL_KEYPAIR.publicKey,
        toPubkey: new PublicKey(SOL_OTHER),
        lamports: 1000,
      }),
    ],
  })
    .compileToV0Message()
    .serialize(),
).toString("base64");

/** The REAL decoder's output for the message above - never a hand-written copy. */
const SOL_DECODED = await (async () => {
  const decoded = await decodeSolanaTransaction(
    VersionedMessage.deserialize(new Uint8Array(Buffer.from(SOL_MESSAGE_BASE64, "base64"))),
    { getLookupTableAddresses: async () => null },
  );
  if (!decoded.ok) throw new Error(`the fixture message does not decode: ${decoded.refusal.code}`);
  return decoded.value;
})();

const FEE_BOUNDS = {
  mode: "solana" as const,
  computeUnitLimit: "200000",
  computeUnitPriceMicroLamports: "1000",
  baseFeeLamports: "5000",
  maxPriorityFeeLamports: "200",
  maxTotalFeeLamports: "10000",
};

async function prepareSolanaIntent(
  sessionId: string,
): Promise<intentsRepo.WalletTransactionIntent> {
  const intentId = `wtx-${randomUUID()}`;
  await withSessionControlLock(sessionId, (client) =>
    intentsRepo.createWith(client, {
      intentId,
      sessionId,
      walletAddress: SOL_WALLET,
      family: "solana",
      chainAlias: null,
      chainId: null,
      payload: {
        family: "solana",
        solana: { messageBase64: SOL_MESSAGE_BASE64, feePayer: SOL_WALLET },
      },
      decoded: SOL_DECODED,
      preview: canonicalTransactionPreview({
        family: "solana",
        chainAlias: null,
        decoded: SOL_DECODED,
        feeBounds: FEE_BOUNDS,
        // Solana charges no Vex fee on this lane (migration 088).
        evmValueWei: null,
      }),
      feeBounds: FEE_BOUNDS,
      proposalDigest: "0".repeat(64),
      proposalDigestVersion: PROPOSAL_DIGEST_VERSION,
      recentBlockhash: BLOCKHASH,
      lastValidBlockHeight: 1000,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }),
  );
  const draft = await intentsRepo.getById(intentId, sessionId);
  if (draft === null) throw new Error("intent did not persist");
  await execute("UPDATE wallet_transaction_intents SET proposal_digest = $2 WHERE intent_id = $1", [
    intentId,
    digestOfIntent(draft),
  ]);
  const row = await intentsRepo.getById(intentId, sessionId);
  if (row === null) throw new Error("intent did not persist");
  return row;
}

const CLEAR_FENCE = async (): Promise<{ ok: true; value: undefined }> => ({
  ok: true,
  value: undefined,
});

/**
 * Claim, stage the signed hash, and (unless told otherwise) move the claim back
 * past the handler window - the exact durable shape a confirm handler leaves
 * behind when the process dies between the broadcast and the settlement.
 */
async function claimAndStage(
  intent: intentsRepo.WalletTransactionIntent,
  options: { backdate?: boolean } = {},
) {
  const claimed = await claimTransactionIntent(intent, intent.proposalDigest, CLEAR_FENCE);
  if (!claimed.ok) throw new Error(`claim failed: ${claimed.reason}`);
  // The blockhash evidence rides with the hash because the schema requires it
  // of a locally staged Solana row (`agent_activity_solana_staged_has_evidence`)
  // - the same pair the handler persists when it stages.
  await execute(
    `UPDATE agent_activity
        SET tx_hash = $2, submit_attempted_at = NOW(),
            recent_blockhash = $3, last_valid_block_height = 1000
      WHERE id = $1`,
    [claimed.activity.activityId, SIGNATURE, BLOCKHASH],
  );
  if (options.backdate !== false) {
    await execute(
      "UPDATE wallet_transaction_intents SET consumed_at = NOW() - INTERVAL '10 minutes' WHERE intent_id = $1",
      [intent.intentId],
    );
  }
  return claimed;
}

/** The sweep's own port, answering "landed, and it reverted on chain". */
function minedRevertDeps(): SolanaActivitySweepDeps {
  return {
    getSignatureStatuses: async () => ({
      outcome: "found",
      value: [{ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }],
    }),
    getFinalizedTransaction: async () => ({ outcome: "unavailable" }),
    getCurrentBlockHeight: async () => ({ outcome: "unavailable" }),
  } as unknown as SolanaActivitySweepDeps;
}

interface ThreeRows {
  wti: { status: string; failure_stage: string | null; tx_hash: string | null };
  aa: { status: string; failure_code: string | null } | null;
  pe: { execution_status: string; success: boolean } | null;
}

async function readThreeRows(intentId: string, activityId: number): Promise<ThreeRows> {
  const wti = await queryOne<ThreeRows["wti"]>(
    "SELECT status, failure_stage, tx_hash FROM wallet_transaction_intents WHERE intent_id = $1",
    [intentId],
  );
  if (wti === null) throw new Error(`no intent row for ${intentId}`);
  const aa = await queryOne<ThreeRows["aa"] & { protocol_execution_id: number }>(
    "SELECT status, failure_code, protocol_execution_id FROM agent_activity WHERE id = $1",
    [activityId],
  );
  const pe = aa === null
    ? null
    : await queryOne<{ execution_status: string; success: boolean }>(
        "SELECT execution_status, success FROM protocol_executions WHERE id = $1",
        [(aa as unknown as { protocol_execution_id: number }).protocol_execution_id],
      );
  return { wti, aa, pe };
}

describe("a `consuming` intent under a terminal activity row is converged, not stranded", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("LANE FIRST: the real Solana repair entrypoint settles a WTI still `consuming`", async () => {
    const sessionId = await makeSession();
    const claimed = await claimAndStage(await prepareSolanaIntent(sessionId));

    // The intent is exactly where the defect leaves it: claimed, hash staged,
    // handler gone.
    const before = await intentsRepo.getById(claimed.intent.intentId, sessionId);
    expect(before?.status).toBe("consuming");

    const result = await repairPendingSolanaActivity(minedRevertDeps());
    expect(result.failed).toBe(1);

    const rows = await readThreeRows(claimed.intent.intentId, claimed.activity.activityId);
    // The lane's own verdict, applied to the intent in the SAME repair action.
    expect(rows.aa?.status).toBe("definitively_failed");
    expect(rows.aa?.failure_code).toBe("mined_revert");
    expect(rows.wti.status).toBe("failed");
    expect(rows.wti.failure_stage).toBe("chain_reverted");
    // A revert is a REAL transaction: the hash the operator reads the receipt
    // from is required, not optional.
    expect(rows.wti.tx_hash).toBe(SIGNATURE);
    // And the execution row is released, so it cannot block the money-state gate.
    expect(rows.pe?.execution_status).toBe("failed");
  });

  it("LANE FIRST: a claim INSIDE the handler window is left alone - repair is not interference", async () => {
    const sessionId = await makeSession();
    const claimed = await claimAndStage(await prepareSolanaIntent(sessionId), { backdate: false });

    await repairPendingSolanaActivity(minedRevertDeps());

    const rows = await readThreeRows(claimed.intent.intentId, claimed.activity.activityId);
    // The activity row is the lane's to terminalize; the INTENT is not, while a
    // confirm handler may still be holding it.
    expect(rows.aa?.status).toBe("definitively_failed");
    expect(rows.wti.status).toBe("consuming");
  });

  it("SCAN FIRST: the stranded scan converges a `consuming` WTI from an ALREADY terminal row", async () => {
    const sessionId = await makeSession();
    const claimed = await claimAndStage(await prepareSolanaIntent(sessionId));
    // The inverse ordering: the lane got there first and the activity row is
    // already terminal, so no lane will ever select it again.
    await execute(
      "UPDATE agent_activity SET status = 'definitively_failed', failure_code = 'mined_revert' WHERE id = $1",
      [claimed.activity.activityId],
    );

    const recovered = await recoverStrandedTransactionIntents();
    expect(recovered.convergedFromTerminalActivity).toBe(1);
    // NOT counted as a plain `broadcast_unconfirmed` recovery: parking there is
    // exactly the outcome this converges past.
    expect(recovered.recoveredUnconfirmed).toBe(0);

    const rows = await readThreeRows(claimed.intent.intentId, claimed.activity.activityId);
    expect(rows.wti.status).toBe("failed");
    expect(rows.wti.failure_stage).toBe("chain_reverted");
    expect(rows.wti.tx_hash).toBe(SIGNATURE);
    expect(rows.pe?.execution_status).toBe("failed");
  });

  it("SCAN FIRST: an EXPIRY verdict converges as `superseded_unproven`, never as a revert", async () => {
    const sessionId = await makeSession();
    const claimed = await claimAndStage(await prepareSolanaIntent(sessionId));
    await execute(
      `UPDATE agent_activity
          SET status = 'definitively_failed', failure_code = 'solana_signature_expired'
        WHERE id = $1`,
      [claimed.activity.activityId],
    );

    await recoverStrandedTransactionIntents();

    const rows = await readThreeRows(claimed.intent.intentId, claimed.activity.activityId);
    // Nobody established that the transaction RAN, so `failed`/`chain_reverted`
    // would be a claim about evidence that does not exist.
    expect(rows.wti.status).toBe("superseded_unproven");
    expect(rows.wti.failure_stage).toBeNull();
    expect(rows.wti.tx_hash).toBe(SIGNATURE);
  });

  it("SCAN FIRST: a CONFIRMED terminal row converges the intent to executed", async () => {
    const sessionId = await makeSession();
    const claimed = await claimAndStage(await prepareSolanaIntent(sessionId));
    await execute(
      "UPDATE agent_activity SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1",
      [claimed.activity.activityId],
    );

    await recoverStrandedTransactionIntents();

    const rows = await readThreeRows(claimed.intent.intentId, claimed.activity.activityId);
    expect(rows.wti.status).toBe("executed");
    expect(rows.wti.tx_hash).toBe(SIGNATURE);
    expect(rows.pe?.execution_status).toBe("succeeded");
  });

  it("SCAN FIRST: an UNRECOGNIZED terminal reason is not read as a chain verdict", async () => {
    const sessionId = await makeSession();
    const claimed = await claimAndStage(await prepareSolanaIntent(sessionId));
    await execute(
      `UPDATE agent_activity
          SET status = 'definitively_failed', failure_code = 'broadcast_error'
        WHERE id = $1`,
      [claimed.activity.activityId],
    );

    const recovered = await recoverStrandedTransactionIntents();

    // No verdict this module may act on, so it keeps the honest unknown rather
    // than inventing one. T4b behaviour, unchanged.
    expect(recovered.convergedFromTerminalActivity).toBe(0);
    expect(recovered.recoveredUnconfirmed).toBe(1);
    const rows = await readThreeRows(claimed.intent.intentId, claimed.activity.activityId);
    expect(rows.wti.status).toBe("broadcast_unconfirmed");
    expect(rows.wti.tx_hash).toBe(SIGNATURE);
  });
});
