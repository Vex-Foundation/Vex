/**
 * `wallet_transaction_intents.activity_id` UNIQUENESS (audit finding F,
 * migration 090), on real PostgreSQL.
 *
 * 087 created `idx_wallet_transaction_intents_activity` as a plain partial
 * index over `activity_id` - it speeds up the repair lanes' traversal but
 * enforces nothing. `stampActivityWith`'s own CAS predicate
 * (`status = 'consuming' AND activity_id IS NULL`) already makes a SINGLE
 * intent idempotent-by-refusal against a second stamp, but nothing in the
 * schema stopped a future writer from linking a SECOND, DIFFERENT intent to
 * the SAME `agent_activity` row. 090 adds a partial UNIQUE index
 * (`idx_wallet_transaction_intents_activity_unique`) so that can never
 * happen, proven here against the real constraint rather than the
 * application-level CAS.
 */

import { createHash, randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, queryOne } from "@vex-agent/db/client.js";
import * as intentsRepo from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import { claimTransactionIntent } from "@vex-agent/tools/internal/wallet/transaction/activity-writer.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";

import { makeSession, resetDb } from "../setup/fixtures.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";

const CLEAR_FENCE = async (): Promise<{ ok: true; value: undefined }> => ({
  ok: true,
  value: undefined,
});

/** T1, exactly as the prepare handler writes it. */
async function prepareIntent(sessionId: string): Promise<intentsRepo.WalletTransactionIntent> {
  const intentId = `wtx-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
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
      expiresAt,
    }),
  );
  const row = await intentsRepo.getById(intentId, sessionId);
  if (row === null) throw new Error("prepare did not persist the intent");
  return row;
}

/** T2, through the real claim transaction: stamps a FRESH `activity_id`. */
async function claim(intent: intentsRepo.WalletTransactionIntent): Promise<string> {
  const claimed = await claimTransactionIntent(intent, intent.proposalDigest, CLEAR_FENCE);
  if (!claimed.ok) throw new Error(`claim failed: ${claimed.reason}`);
  const row = await queryOne<{ activity_id: string }>(
    "SELECT activity_id::text AS activity_id FROM wallet_transaction_intents WHERE intent_id = $1",
    [intent.intentId],
  );
  if (row === null || row.activity_id === null) {
    throw new Error("claim did not stamp an activity_id");
  }
  return row.activity_id;
}

describe("wallet_transaction_intents.activity_id stays unique (090)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("lets two independent intents each keep their own activity_id", async () => {
    const sessionId = await makeSession();
    const first = await claim(await prepareIntent(sessionId));
    const second = await claim(await prepareIntent(sessionId));
    expect(first).not.toBe(second);
  });

  it("refuses a raw stamp that would link a SECOND intent to an ALREADY-CLAIMED activity_id", async () => {
    const sessionId = await makeSession();
    const owner = await claim(await prepareIntent(sessionId));
    const other = await prepareIntent(sessionId);

    // Bypass the repo's own `activity_id IS NULL` CAS on purpose: this proves
    // the DATABASE refuses the duplicate, not merely that the application-level
    // guard happens to run first.
    await expect(
      execute(
        `UPDATE wallet_transaction_intents SET activity_id = $2 WHERE intent_id = $1`,
        [other.intentId, owner],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    const row = await queryOne<{ activity_id: string | null }>(
      "SELECT activity_id::text AS activity_id FROM wallet_transaction_intents WHERE intent_id = $1",
      [other.intentId],
    );
    expect(row?.activity_id ?? null).toBeNull();
  });
});
