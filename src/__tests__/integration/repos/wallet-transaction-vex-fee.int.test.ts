/**
 * THE VEX FEE ROW ON REAL POSTGRESQL (migration 088).
 *
 * Three things only a real database can answer, and each of them is a rule the
 * code above it is allowed to assume:
 *
 *   1. `tx_vex_fee` is EVM-ONLY. The Solana half of the generic signing lane
 *      charges nothing, and that gap is enforced by
 *      `agent_activity_tx_vex_fee_eip155` rather than by a comment. A mocked
 *      client cannot enforce a CHECK, so a fixture-only test proves nothing
 *      about this at all.
 *   2. The CLAIM IS ATOMIC. The fee row is created as `event_index` 1 inside the
 *      same transaction that moves the intent to `consuming`; if anything in
 *      that transaction fails, there is no fee row AND no claimed intent.
 *   3. A HASHLESS FEE ROW IS REAPABLE. `tx_vex_fee` joins
 *      `LOCALLY_SIGNABLE_ACTIVITY_ROLES`, so a leg planned and never signed is
 *      recovered rather than left pending forever - and a STAGED one is not
 *      touched, because a hash means bytes that may be in flight.
 */

import { createHash, randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, query, queryOne } from "@vex-agent/db/client.js";
import * as intentsRepo from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import { claimTransactionIntent } from "@vex-agent/tools/internal/wallet/transaction/activity-writer.js";
import { prepareWalletTransactionVexFeePlan } from "@vex-agent/tools/internal/wallet/transaction/vex-fee.js";
import { abortPlannedEvents } from "@vex-agent/db/repos/agent-activity.js";
import {
  recoverStaleHashlessIntents,
  HASHLESS_INTENT_RECOVERY_LEASE_MS,
} from "@vex-agent/db/repos/agent-activity/hashless-recovery.js";
import { createExecutionIntent } from "@vex-agent/db/repos/executions.js";
import { createPendingActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";

import { makeSession, resetDb } from "../setup/fixtures.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";
/** One ETH: 25 bps clears the collection cost comfortably. */
const CHARGED_VALUE = "1000000000000000000";

const CHAIN_FACTS = { chainSlug: "base", nativeSymbol: "ETH", nativeDecimals: 18 } as const;
const CLEAR_FENCE = async (): Promise<{ ok: true; value: undefined }> => ({ ok: true, value: undefined });

let sessionId: string;

beforeEach(async () => {
  await resetDb();
  sessionId = await makeSession();
});

async function prepareIntent(valueWei: string): Promise<intentsRepo.WalletTransactionIntent> {
  const intentId = `wtx-${randomUUID()}`;
  await withSessionControlLock(sessionId, (client) =>
    intentsRepo.createWith(client, {
      intentId,
      sessionId,
      walletAddress: WALLET,
      family: "eip155",
      chainAlias: "base",
      chainId: 8453,
      payload: { family: "eip155", evm: { to: TO, data: "0x", valueWei } },
      decoded: {
        family: "eip155",
        role: "native_transfer",
        standard: "native",
        functionName: "nativeTransfer",
        contract: null,
        criticalArgs: { recipient: TO, valueWei },
        unlimitedApproval: false,
        warnings: [],
      },
      preview: { label: `Send ${valueWei} wei`, criticalArgs: { chain: "base" } },
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

interface FeeRow {
  id: number;
  event_index: number;
  event_role: string;
  kind: string;
  chain_family: string;
  status: string;
  tx_hash: string | null;
  amount_in_raw: string | null;
  amount_in_human: string | null;
  failure_reason: string | null;
}

async function feeRowOf(executionId: number): Promise<FeeRow | null> {
  return queryOne<FeeRow>(
    `SELECT id, event_index, event_role, kind, chain_family, status, tx_hash,
            amount_in_raw, amount_in_human, failure_reason
       FROM agent_activity
      WHERE protocol_execution_id = $1 AND event_role = 'tx_vex_fee'`,
    [executionId],
  );
}

describe("T-FEE 15: the database owns the EVM-only binding", () => {
  it("ACCEPTS a tx_vex_fee row on an eip155 transaction", async () => {
    const executionId = await createExecutionIntent("t", "wallet", sessionId, {});
    const row = await createPendingActivityEvent({
      protocolExecutionId: executionId,
      eventIndex: 1,
      eventRole: "tx_vex_fee",
      kind: "transaction",
      protocol: "wallet",
      chainId: 8453,
      chainSlug: "base",
      chainFamily: "eip155",
      walletAddress: WALLET,
      sessionId,
    });
    expect(row.id).toBeGreaterThan(0);
  });

  it("REJECTS a tx_vex_fee row on solana - the named gap, enforced", async () => {
    const executionId = await createExecutionIntent("t", "wallet", sessionId, {});
    await expect(
      createPendingActivityEvent({
        protocolExecutionId: executionId,
        eventIndex: 1,
        eventRole: "tx_vex_fee",
        kind: "transaction",
        protocol: "wallet",
        chainId: 20011000000,
        chainSlug: "solana",
        chainFamily: "solana",
        walletAddress: "So11111111111111111111111111111111111111112",
        sessionId,
      }),
    ).rejects.toThrow(/agent_activity_tx_vex_fee_eip155/);
  });

  it("REJECTS tx_vex_fee on any kind other than `transaction`", async () => {
    const executionId = await createExecutionIntent("t", "wallet", sessionId, {});
    await expect(
      createPendingActivityEvent({
        protocolExecutionId: executionId,
        eventIndex: 1,
        eventRole: "tx_vex_fee",
        kind: "swap",
        protocol: "wallet",
        chainId: 8453,
        chainSlug: "base",
        chainFamily: "eip155",
        walletAddress: WALLET,
        sessionId,
      }),
    ).rejects.toThrow(/agent_activity_kind_role_binding/);
  });

  it("leaves every pre-088 role/kind pairing writable", async () => {
    const executionId = await createExecutionIntent("t", "trench", sessionId, {});
    const row = await createPendingActivityEvent({
      protocolExecutionId: executionId,
      eventIndex: 1,
      eventRole: "trench_fee",
      kind: "launch",
      protocol: "trench",
      chainId: 4663,
      chainSlug: "robinhood",
      chainFamily: "eip155",
      walletAddress: WALLET,
      sessionId,
    });
    expect(row.id).toBeGreaterThan(0);
  });
});

describe("the fee row is created inside the claim, atomically", () => {
  it("creates it as event 1 beside the transaction's own row at event 0", async () => {
    const intent = await prepareIntent(CHARGED_VALUE);
    const plan = prepareWalletTransactionVexFeePlan(intent, CHAIN_FACTS);
    expect(plan?.charged).toBe(true);
    if (plan === null || !plan.charged) throw new Error("expected a charged plan");

    const claimed = await claimTransactionIntent(
      intent,
      intent.proposalDigest,
      CLEAR_FENCE,
      plan.leg.event,
    );
    if (!claimed.ok) throw new Error(`claim failed: ${claimed.reason}`);

    const fee = await feeRowOf(claimed.activity.executionId);
    expect(fee).not.toBeNull();
    expect(claimed.activity.feeRowId).toBe(Number(fee?.id));
    expect(fee?.event_index).toBe(1);
    expect(fee?.kind).toBe("transaction");
    expect(fee?.chain_family).toBe("eip155");
    expect(fee?.status).toBe("pending");
    // Hashless: nothing has been signed. The staging CAS requires exactly this.
    expect(fee?.tx_hash).toBeNull();
    // The fee IS this row, carried in the input leg, exactly as a bridge_fee is.
    expect(fee?.amount_in_raw).toBe("2500000000000000");
    expect(fee?.amount_in_human).toBe("0.0025");

    // The intent is linked to event 0, not to the fee.
    const wti = await queryOne<{ status: string; activity_id: string }>(
      "SELECT status, activity_id::text AS activity_id FROM wallet_transaction_intents WHERE intent_id = $1",
      [intent.intentId],
    );
    expect(wti?.status).toBe("consuming");
    expect(Number(wti?.activity_id)).toBe(claimed.activity.activityId);
    expect(Number(wti?.activity_id)).not.toBe(Number(fee?.id));
  });

  it("creates NO fee row when the fee is not charged, and the claim still succeeds", async () => {
    // Dust: 25 bps does not clear its own collection cost.
    const intent = await prepareIntent("1000000000000");
    const plan = prepareWalletTransactionVexFeePlan(intent, CHAIN_FACTS);
    expect(plan?.charged).toBe(false);

    const claimed = await claimTransactionIntent(intent, intent.proposalDigest, CLEAR_FENCE, null);
    if (!claimed.ok) throw new Error("claim failed");
    expect(claimed.activity.feeRowId).toBeNull();
    expect(await feeRowOf(claimed.activity.executionId)).toBeNull();
  });

  it("ROLLS BACK THE WHOLE CLAIM when the fee row cannot be written - nothing is signed", async () => {
    const intent = await prepareIntent(CHARGED_VALUE);
    const plan = prepareWalletTransactionVexFeePlan(intent, CHAIN_FACTS);
    if (plan === null || !plan.charged) throw new Error("expected a charged plan");

    // A fee event the CHECK forbids: the same role on the wrong family. The
    // insert raises, and the intent must be left `pending` with no rows.
    const poisoned = { ...plan.leg.event, chainFamily: "solana" as const };
    const claimed = await claimTransactionIntent(
      intent,
      intent.proposalDigest,
      CLEAR_FENCE,
      poisoned,
    );
    expect(claimed.ok).toBe(false);
    if (!claimed.ok) expect(claimed.reason).toBe("write_failed");

    const wti = await queryOne<{ status: string; activity_id: string | null }>(
      "SELECT status, activity_id::text AS activity_id FROM wallet_transaction_intents WHERE intent_id = $1",
      [intent.intentId],
    );
    expect(wti?.status).toBe("pending");
    expect(wti?.activity_id).toBeNull();
    const anyRow = await queryOne<{ n: string }>(
      "SELECT count(*)::text AS n FROM agent_activity WHERE session_id = $1",
      [sessionId],
    );
    expect(anyRow?.n).toBe("0");
  });
});

describe("a fee leg that is never signed converges", () => {
  it("finalizes never-attempted through abortPlannedEvents, keeping the parent row pending", async () => {
    const intent = await prepareIntent(CHARGED_VALUE);
    const plan = prepareWalletTransactionVexFeePlan(intent, CHAIN_FACTS);
    if (plan === null || !plan.charged) throw new Error("expected a charged plan");
    const claimed = await claimTransactionIntent(intent, intent.proposalDigest, CLEAR_FENCE, plan.leg.event);
    if (!claimed.ok) throw new Error("claim failed");

    await abortPlannedEvents(claimed.activity.executionId, 1, "the transaction reverted");

    const fee = await feeRowOf(claimed.activity.executionId);
    expect(fee?.status).toBe("definitively_failed");
    expect(fee?.failure_reason).toContain("not attempted:");
    // The transaction's OWN row is at index 0 and is untouched by the abort.
    const parent = await queryOne<{ status: string }>(
      "SELECT status FROM agent_activity WHERE id = $1",
      [claimed.activity.activityId],
    );
    expect(parent?.status).toBe("pending");
  });

  it("CANNOT terminalize a STAGED fee row - a hash means bytes that may be in flight", async () => {
    const intent = await prepareIntent(CHARGED_VALUE);
    const plan = prepareWalletTransactionVexFeePlan(intent, CHAIN_FACTS);
    if (plan === null || !plan.charged) throw new Error("expected a charged plan");
    const claimed = await claimTransactionIntent(intent, intent.proposalDigest, CLEAR_FENCE, plan.leg.event);
    if (!claimed.ok || claimed.activity.feeRowId === null) throw new Error("claim failed");

    await execute(
      "UPDATE agent_activity SET tx_hash = $2, from_address = $3, nonce = 4, submit_attempted_at = NOW() WHERE id = $1",
      [claimed.activity.feeRowId, `0x${"fe".repeat(32)}`, WALLET],
    );

    await abortPlannedEvents(claimed.activity.executionId, 1, "the transaction reverted");

    const fee = await feeRowOf(claimed.activity.executionId);
    expect(fee?.status).toBe("pending");
    expect(fee?.tx_hash).not.toBeNull();
  });

  it("is REAPED by hashless recovery when even the best-effort finalization never landed", async () => {
    const intent = await prepareIntent(CHARGED_VALUE);
    const plan = prepareWalletTransactionVexFeePlan(intent, CHAIN_FACTS);
    if (plan === null || !plan.charged) throw new Error("expected a charged plan");
    const claimed = await claimTransactionIntent(intent, intent.proposalDigest, CLEAR_FENCE, plan.leg.event);
    if (!claimed.ok || claimed.activity.feeRowId === null) throw new Error("claim failed");

    // Age the row past the recovery lease, as a crashed process would leave it.
    await execute(
      `UPDATE agent_activity
          SET created_at = NOW() - INTERVAL '1 millisecond' * $2
        WHERE id = $1`,
      [claimed.activity.feeRowId, HASHLESS_INTENT_RECOVERY_LEASE_MS + 60_000],
    );

    const reaped = await recoverStaleHashlessIntents(HASHLESS_INTENT_RECOVERY_LEASE_MS, 25);
    expect(reaped.map((row) => row.id)).toContain(claimed.activity.feeRowId);

    const fee = await feeRowOf(claimed.activity.executionId);
    expect(fee?.status).toBe("definitively_failed");
  });

  it("does not reap a STAGED fee row - the same CAS the staging write needs", async () => {
    const intent = await prepareIntent(CHARGED_VALUE);
    const plan = prepareWalletTransactionVexFeePlan(intent, CHAIN_FACTS);
    if (plan === null || !plan.charged) throw new Error("expected a charged plan");
    const claimed = await claimTransactionIntent(intent, intent.proposalDigest, CLEAR_FENCE, plan.leg.event);
    if (!claimed.ok || claimed.activity.feeRowId === null) throw new Error("claim failed");

    await execute(
      `UPDATE agent_activity
          SET tx_hash = $2, from_address = $3, nonce = 4, submit_attempted_at = NOW(),
              created_at = NOW() - INTERVAL '1 millisecond' * $4
        WHERE id = $1`,
      [claimed.activity.feeRowId, `0x${"fe".repeat(32)}`, WALLET, HASHLESS_INTENT_RECOVERY_LEASE_MS + 60_000],
    );

    const reaped = await recoverStaleHashlessIntents(HASHLESS_INTENT_RECOVERY_LEASE_MS, 25);
    expect(reaped.map((row) => row.id)).not.toContain(claimed.activity.feeRowId);
  });
});

describe("T-FEE 14: the fee leg is a child leg, and the parent reports the charge", () => {
  it("is excluded from the agent feed while its confirmed amount projects onto the parent", async () => {
    const intent = await prepareIntent(CHARGED_VALUE);
    const plan = prepareWalletTransactionVexFeePlan(intent, CHAIN_FACTS);
    if (plan === null || !plan.charged) throw new Error("expected a charged plan");
    const claimed = await claimTransactionIntent(intent, intent.proposalDigest, CLEAR_FENCE, plan.leg.event);
    if (!claimed.ok || claimed.activity.feeRowId === null) throw new Error("claim failed");

    // Both legs confirmed, as a fully collected fee leaves them.
    await execute(
      `UPDATE agent_activity
          SET status = 'confirmed', tx_hash = $2, confirmed_at = NOW(),
              from_address = $3, nonce = 1, submit_attempted_at = NOW()
        WHERE id = $1`,
      [claimed.activity.activityId, `0x${"ac".repeat(32)}`, WALLET],
    );
    await execute(
      `UPDATE agent_activity
          SET status = 'confirmed', tx_hash = $2, confirmed_at = NOW(),
              from_address = $3, nonce = 2, submit_attempted_at = NOW(),
              executed_amount_in_raw = amount_in_raw, executed_amount_in_human = amount_in_human
        WHERE id = $1`,
      [claimed.activity.feeRowId, `0x${"fe".repeat(32)}`, WALLET],
    );

    const rows = await query<{ id: number; vex_fee_amount_raw: string | null; vex_fee_source: string | null }>(
      `SELECT agent_activity.id,
              fee_pick.vex_fee_source,
              fee_leg.vex_fee_amount_raw
         FROM agent_activity
         LEFT JOIN LATERAL (
           SELECT COALESCE(fee.executed_amount_in_raw, fee.amount_in_raw) AS vex_fee_amount_raw,
                  count(*) OVER () AS fee_leg_count
             FROM agent_activity fee
            WHERE fee.protocol_execution_id = agent_activity.protocol_execution_id
              AND fee.id <> agent_activity.id
              AND fee.event_role IN ('bridge_fee','swap_fee','trench_fee','pools_fee','tx_vex_fee')
              AND fee.status = 'confirmed'
            ORDER BY fee.event_index ASC
            LIMIT 1
         ) fee_leg ON TRUE
         LEFT JOIN LATERAL (
           SELECT CASE WHEN fee_leg.vex_fee_amount_raw IS NOT NULL AND fee_leg.fee_leg_count = 1
                       THEN 'separate_leg' END::text AS vex_fee_source
         ) fee_pick ON TRUE
        WHERE agent_activity.protocol_execution_id = $1
          AND agent_activity.event_role NOT IN
              ('allowance', 'allowance_reset', 'trench_fee', 'swap_fee', 'pools_fee', 'tx_vex_fee')`,
      [claimed.activity.executionId],
    );

    // ONE feed row - the transaction - and it carries the fee.
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.id)).toBe(claimed.activity.activityId);
    expect(rows[0]?.vex_fee_amount_raw).toBe("2500000000000000");
    expect(rows[0]?.vex_fee_source).toBe("separate_leg");
  });
});
