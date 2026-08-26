/**
 * Migration 093 and the transfer failed-with-hash repair owner, against real
 * PostgreSQL. The only chain seams are the existing observers' read-only ports.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../constants/solana-chain.js";
import { execute, queryOne } from "@vex-agent/db/client.js";
import {
  abortPlannedEvents,
  confirmActivityEventStatusOnlyWith,
  recoverStaleHashlessIntents,
} from "@vex-agent/db/repos/agent-activity.js";
import {
  settleLinkedActivityRows,
  type LinkedSettlementWritePoint,
} from "@vex-agent/db/repos/agent-activity/linked-transaction-settlement.js";
import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";
import { createExecutionIntent } from "@vex-agent/db/repos/executions.js";
import * as walletIntentsRepo from "@vex-agent/db/repos/wallet-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { repairPendingActivity } from "@vex-agent/sync/agent-activity-repair.js";
import { repairPendingSolanaActivity } from "@vex-agent/sync/solana-activity-repair.js";
import {
  openWalletTransferActivity,
  type WalletTransferPlan,
} from "@vex-agent/tools/internal/wallet/send/activity-writer.js";

import { makeSession, resetDb } from "../setup/fixtures.js";

const EVM_WALLET = "0xabcdef1234567890abcdef1234567890abcdef12";
const EVM_TO = "0xfedcba0987654321fedcba0987654321fedcba09";
const SOL_WALLET = "7YttLkHDoNj9wyDur5U5jZrH3kCXpLKGBMQvSF5B6K7D";
const SOL_TO = "9xQeWvG816bUx9EPfEZrM9VHN8YcZcVn3KDBbT4G3aLq";
const SOL_MINT = "So11111111111111111111111111111111111111112";

const MIGRATION_093 = fileURLToPath(
  new URL("../../../vex-agent/db/migrations/093_wallet_transfer_unconfirmed_repair.sql", import.meta.url),
);

beforeEach(async () => {
  await resetDb();
});

async function createClaimedIntent(
  sessionId: string,
  network: walletIntentsRepo.WalletIntentNetwork,
): Promise<walletIntentsRepo.WalletIntent> {
  const intentId = `send-${randomUUID()}`;
  const walletAddress = network === "eip155" ? EVM_WALLET : SOL_WALLET;
  await withSessionControlLock(sessionId, (client) =>
    walletIntentsRepo.createWith(client, {
      intentId,
      sessionId,
      walletAddress,
      network,
      chainAlias: network === "eip155" ? "base" : null,
      toAddress: network === "eip155" ? EVM_TO : SOL_TO,
      amount: "1",
      token: null,
      previewJson: { label: "transfer fixture", criticalArgs: {} },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      idempotencyKey: intentId,
    }),
  );
  const claimed = await withSessionControlLock(sessionId, (client) =>
    walletIntentsRepo.consumeIfPendingWith(client, intentId, sessionId),
  );
  if (claimed === null) throw new Error("transfer fixture claim failed");
  return claimed;
}

function planFor(network: walletIntentsRepo.WalletIntentNetwork): WalletTransferPlan {
  if (network === "eip155") {
    return {
      chainId: 8453,
      chainSlug: "base",
      chainFamily: "eip155",
      tokenAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      tokenSymbol: "ETH",
      tokenDecimals: 18,
      amountRaw: 1_000_000_000_000_000_000n,
      amountHuman: "1",
    };
  }
  return {
    chainId: SOLANA_SYNTHETIC_CHAIN_ID,
    chainSlug: "solana",
    chainFamily: "solana",
    tokenAddress: SOL_MINT,
    tokenSymbol: "SOL",
    tokenDecimals: 9,
    amountRaw: 1_000_000_000n,
    amountHuman: "1",
  };
}

async function stageUnconfirmed(
  network: walletIntentsRepo.WalletIntentNetwork,
): Promise<{ intent: walletIntentsRepo.WalletIntent; activityId: number; txHash: string }> {
  const sessionId = await makeSession();
  const intent = await createClaimedIntent(sessionId, network);
  const activity = await openWalletTransferActivity(intent, planFor(network));
  const txHash = network === "eip155" ? `0x${"ab".repeat(32)}` : "5".repeat(88);
  if (network === "eip155") {
    const nonce = await activity.reserveEvmNonce({
      fromAddress: EVM_WALLET,
      chainId: 8453,
      nodePendingNonce: 7,
    });
    await activity.stageEvm({ txHash, fromAddress: EVM_WALLET, nonce });
  } else {
    await activity.stageSolana({
      signature: txHash,
      fromAddress: SOL_WALLET,
      recentBlockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 999_999,
    });
  }
  await activity.completeExecution({ kind: "confirmation_unknown", txHash });
  const unconfirmed = await withSessionControlLock(sessionId, (client) =>
    walletIntentsRepo.markBroadcastUnconfirmedWith(
      client,
      intent.intentId,
      sessionId,
      txHash,
      "ConfirmationUnknown:fixture",
    ),
  );
  if (unconfirmed === null) throw new Error("transfer fixture did not become unconfirmed");
  await execute(
    "UPDATE agent_activity SET submit_attempted_at = NOW() - INTERVAL '10 minutes' WHERE id = $1",
    [activity.rowId],
  );
  return { intent: unconfirmed, activityId: activity.rowId, txHash };
}

interface DurableTransferState {
  intent_status: string;
  intent_hash: string | null;
  activity_status: string;
  failure_code: string | null;
}

async function readDurableState(intentId: string): Promise<DurableTransferState> {
  const row = await queryOne<DurableTransferState>(
    `SELECT w.status AS intent_status, w.tx_hash AS intent_hash,
            a.status AS activity_status, a.failure_code
       FROM wallet_intents w
       JOIN agent_activity a ON a.id = w.activity_id
      WHERE w.intent_id = $1`,
    [intentId],
  );
  if (row === null) throw new Error("durable transfer state missing");
  return row;
}

function readMoneyState(sessionId: string) {
  return withSessionControlLock(sessionId, (client) =>
    getUnresolvedMoneyStateForSession(client, sessionId),
  );
}

interface HashlessTransferState {
  readonly intent_status: string;
  readonly intent_hash: string | null;
  readonly activity_status: string;
  readonly failure_code: string | null;
  readonly execution_status: string;
}

async function readHashlessTransferState(intentId: string): Promise<HashlessTransferState> {
  const row = await queryOne<HashlessTransferState>(
    `SELECT w.status AS intent_status, w.tx_hash AS intent_hash,
            a.status AS activity_status, a.failure_code, e.execution_status
       FROM wallet_intents w
       JOIN agent_activity a ON a.id = w.activity_id
       JOIN protocol_executions e ON e.id = a.protocol_execution_id
      WHERE w.intent_id = $1`,
    [intentId],
  );
  if (row === null) throw new Error("hashless transfer fixture is missing");
  return row;
}

describe("linked transfer hashless terminalization", () => {
  it("the stale reaper converges WI, AA, and PE after a crash between open and stage", async () => {
    const sessionId = await makeSession();
    const intent = await createClaimedIntent(sessionId, "eip155");
    const activity = await openWalletTransferActivity(intent, planFor("eip155"));
    await execute(
      "UPDATE agent_activity SET created_at = NOW() - INTERVAL '20 minutes' WHERE id = $1",
      [activity.rowId],
    );

    await expect(readMoneyState(sessionId)).resolves.toMatchObject({ clear: false });
    const recovered = await recoverStaleHashlessIntents(15 * 60 * 1000, 25);
    expect(recovered.map((row) => row.id)).toContain(activity.rowId);

    await expect(readHashlessTransferState(intent.intentId)).resolves.toEqual({
      intent_status: "failed",
      intent_hash: null,
      activity_status: "definitively_failed",
      failure_code: "unknown",
      execution_status: "failed",
    });
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
  });

  it("plan abort commits a linked transfer's WI, AA, and PE terminal states together", async () => {
    const sessionId = await makeSession();
    const intent = await createClaimedIntent(sessionId, "eip155");
    const activity = await openWalletTransferActivity(intent, planFor("eip155"));

    const aborted = await abortPlannedEvents(activity.executionId, 0, "transfer refused before signing");
    expect(aborted.map((row) => row.id)).toContain(activity.rowId);
    await expect(readHashlessTransferState(intent.intentId)).resolves.toEqual({
      intent_status: "failed",
      intent_hash: null,
      activity_status: "definitively_failed",
      failure_code: "unknown",
      execution_status: "failed",
    });
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
  });
});

describe("linked transfer signed-not-submitted terminalization", () => {
  it("keeps the staged signature on AA but exposes no network hash on WI or PE", async () => {
    const sessionId = await makeSession();
    const intent = await createClaimedIntent(sessionId, "solana");
    const activity = await openWalletTransferActivity(intent, planFor("solana"));
    const signature = "6".repeat(88);
    await activity.stageSolana({
      signature,
      fromAddress: SOL_WALLET,
      recentBlockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 999_999,
    });

    await activity.completeExecution({ kind: "failed_before_broadcast" });
    await activity.failSignedNotSubmitted({
      failureReason: "SubmitRejected:SendTransactionError:fixture",
    });

    const state = await queryOne<{
      intent_status: string;
      intent_hash: string | null;
      intent_reason: string | null;
      activity_status: string;
      activity_hash: string | null;
      failure_code: string | null;
      execution_status: string;
      execution_result_status: string | null;
      execution_refs: Record<string, unknown>;
    }>(
      `SELECT w.status AS intent_status, w.tx_hash AS intent_hash,
              w.failure_reason AS intent_reason,
              a.status AS activity_status, a.tx_hash AS activity_hash,
              a.failure_code, e.execution_status,
              e.result ->> 'status' AS execution_result_status,
              e.external_refs AS execution_refs
         FROM wallet_intents w
         JOIN agent_activity a ON a.id = w.activity_id
         JOIN protocol_executions e ON e.id = a.protocol_execution_id
        WHERE w.intent_id = $1`,
      [intent.intentId],
    );
    expect(state).toEqual({
      intent_status: "failed",
      intent_hash: null,
      intent_reason: "PreBroadcast:signed_not_submitted",
      activity_status: "definitively_failed",
      activity_hash: signature,
      failure_code: "broadcast_error",
      execution_status: "failed",
      execution_result_status: "failed_before_broadcast",
      execution_refs: {},
    });
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
  });
});

describe("linked transfer observers", () => {
  it("EVM observer atomically settles broadcast_unconfirmed and restart is idempotent", async () => {
    const staged = await stageUnconfirmed("eip155");
    const observeTransaction = vi.fn(async () => ({
      kind: "mined" as const,
      status: "success" as const,
      blockTimeIso: null,
    }));
    expect((await readMoneyState(staged.intent.sessionId)).clear).toBe(false);

    const first = await repairPendingActivity({ observeTransaction });
    expect(first).toMatchObject({ checked: 1, confirmed: 1, failed: 0 });
    expect(await readDurableState(staged.intent.intentId)).toMatchObject({
      intent_status: "executed",
      intent_hash: staged.txHash,
      activity_status: "confirmed",
    });
    await expect(readMoneyState(staged.intent.sessionId)).resolves.toEqual({ clear: true });

    const second = await repairPendingActivity({ observeTransaction });
    expect(second.checked).toBe(0);
    expect(observeTransaction).toHaveBeenCalledTimes(1);
  });

  it("Solana observer settles a mined revert without a rebroadcast capability", async () => {
    const staged = await stageUnconfirmed("solana");
    const getSignatureStatuses = vi.fn(async () => ({
      outcome: "found" as const,
      value: [{ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }],
    }));
    const getFinalizedTransaction = vi.fn(async () => ({ outcome: "not_found" as const }));
    const getCurrentBlockHeight = vi.fn(async () => ({ outcome: "unavailable" as const }));

    const first = await repairPendingSolanaActivity({
      getSignatureStatuses,
      getFinalizedTransaction,
      getCurrentBlockHeight,
    });
    expect(first).toMatchObject({ checked: 1, confirmed: 0, failed: 1 });
    expect(await readDurableState(staged.intent.intentId)).toMatchObject({
      intent_status: "failed",
      intent_hash: staged.txHash,
      activity_status: "definitively_failed",
      failure_code: "mined_revert",
    });
    expect(getSignatureStatuses).toHaveBeenCalledTimes(1);
    expect(getFinalizedTransaction).not.toHaveBeenCalled();
  });
});

describe("linked transfer atomicity", () => {
  for (const point of [
    "activity_terminal",
    "intent_terminal",
    "execution_terminal",
  ] as const satisfies readonly LinkedSettlementWritePoint[]) {
    it(`rolls back AA, wallet intent and PE when interrupted after ${point}`, async () => {
      const sessionId = await makeSession();
      const intent = await createClaimedIntent(sessionId, "eip155");
      const activity = await openWalletTransferActivity(intent, planFor("eip155"));
      const txHash = `0x${"cd".repeat(32)}`;
      const nonce = await activity.reserveEvmNonce({
        fromAddress: EVM_WALLET,
        chainId: 8453,
        nodePendingNonce: 9,
      });
      await activity.stageEvm({ txHash, fromAddress: EVM_WALLET, nonce });

      await expect(
        settleLinkedActivityRows(
          {
            activityId: activity.rowId,
            sessionId,
            intentOutcome: "confirmed",
            activityTarget: { status: "confirmed" },
            activityWrite: (client) => confirmActivityEventStatusOnlyWith(
              client,
              activity.rowId,
              "receipt_status_only_evm",
            ),
          },
          {
            afterWrite(writePoint): void {
              if (writePoint === point) throw new Error(`interrupt after ${point}`);
            },
          },
        ),
      ).rejects.toThrow(`interrupt after ${point}`);

      const row = await queryOne<{
        intent_status: string;
        activity_status: string;
        execution_status: string;
      }>(
        `SELECT w.status AS intent_status, a.status AS activity_status,
                e.execution_status
           FROM wallet_intents w
           JOIN agent_activity a ON a.id = w.activity_id
           JOIN protocol_executions e ON e.id = a.protocol_execution_id
          WHERE w.intent_id = $1`,
        [intent.intentId],
      );
      expect(row).toEqual({
        intent_status: "consuming",
        activity_status: "pending",
        execution_status: "intent",
      });
    });
  }
});

async function insertLegacyWalletIntent(
  sessionId: string,
  network: walletIntentsRepo.WalletIntentNetwork,
  txHash: string,
  status: "failed" | "review_required" = "failed",
): Promise<string> {
  const intentId = `legacy-${randomUUID()}`;
  await execute(
    `INSERT INTO wallet_intents
       (intent_id, session_id, wallet_address, network, chain_alias, to_address,
        amount, token, preview_json, status, expires_at, consumed_at, tx_hash,
        failure_reason, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, '1', NULL, '{}'::jsonb, $8,
             NOW() + INTERVAL '10 minutes', NOW(), $7, 'ConfirmationUnknown:legacy', $1)`,
    [
      intentId,
      sessionId,
      network === "eip155" ? EVM_WALLET : SOL_WALLET,
      network,
      network === "eip155" ? "base" : null,
      network === "eip155" ? EVM_TO : SOL_TO,
      txHash,
      status,
    ],
  );
  return intentId;
}

async function insertLegacyLinkedActivity(
  sessionId: string,
  intentId: string,
  txHash: string,
  terminal: "pending" | "confirmed" | "reverted" | "superseded",
): Promise<number> {
  const executionId = await createExecutionIntent(
    "wallet_send_confirm",
    "wallet",
    sessionId,
    { intentId },
  );
  const row = await queryOne<{ id: number }>(
    `INSERT INTO agent_activity
       (protocol_execution_id, event_index, event_role, kind, protocol, chain_id,
        chain_slug, chain_family, wallet_address, session_id, status, tx_hash,
        from_address, nonce, submit_attempted_at)
     VALUES ($1, 0, 'wallet_transfer', 'transfer', 'wallet', 8453,
             'base', 'eip155', $2, $3, 'pending', $4, $2, 7, NOW())
     RETURNING id`,
    [executionId, EVM_WALLET, sessionId, txHash],
  );
  if (row === null) throw new Error("legacy activity insert failed");
  if (terminal === "confirmed") {
    await execute(
      "UPDATE agent_activity SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1",
      [row.id],
    );
  } else if (terminal === "reverted") {
    await execute(
      `UPDATE agent_activity
          SET status = 'definitively_failed', failure_code = 'mined_revert',
              failure_reason = 'legacy fixture revert'
        WHERE id = $1`,
      [row.id],
    );
  } else if (terminal === "superseded") {
    await execute(
      "UPDATE agent_activity SET status = 'superseded_unproven' WHERE id = $1",
      [row.id],
    );
  }
  return row.id;
}

async function rerunMigration093(): Promise<void> {
  await execute(await readFile(MIGRATION_093, "utf8"));
}

describe("migration 093 forward backfill", () => {
  it("preserves every recognized activity verdict and names the unlinked legacy queue", async () => {
    const sessionId = await makeSession();
    // Construct the pre-093 shape inside the fully migrated integration schema.
    // The migration rerun below restores this constraint after classifying rows.
    await execute(
      "ALTER TABLE wallet_intents DROP CONSTRAINT wallet_intents_failed_hash_evidence",
    );
    const expected = [
      ["pending", "broadcast_unconfirmed"],
      ["confirmed", "executed"],
      ["reverted", "failed"],
      ["superseded", "superseded_unproven"],
    ] as const;
    const linked: Array<{ intentId: string; activityId: number; expectedStatus: string }> = [];
    for (const [activityStatus, expectedStatus] of expected) {
      const txHash = `0x${activityStatus.padEnd(64, "0")}`;
      const intentId = await insertLegacyWalletIntent(sessionId, "eip155", txHash);
      const activityId = await insertLegacyLinkedActivity(
        sessionId,
        intentId,
        txHash,
        activityStatus,
      );
      linked.push({ intentId, activityId, expectedStatus });
    }
    const unlinkedId = await insertLegacyWalletIntent(
      sessionId,
      "eip155",
      `0x${"ff".repeat(32)}`,
    );

    await rerunMigration093();

    for (const fixture of linked) {
      const row = await queryOne<{ status: string; activity_id: string | null }>(
        "SELECT status, activity_id::text FROM wallet_intents WHERE intent_id = $1",
        [fixture.intentId],
      );
      expect(row).toEqual({
        status: fixture.expectedStatus,
        activity_id: String(fixture.activityId),
      });
    }
    const unlinked = await queryOne<{ status: string; activity_id: string | null }>(
      "SELECT status, activity_id::text FROM wallet_intents WHERE intent_id = $1",
      [unlinkedId],
    );
    expect(unlinked).toEqual({ status: "review_required", activity_id: null });
  });
});

describe("pre-084 review queue", () => {
  it("EVM review rows converge from a mined revert and release the money gate", async () => {
    const sessionId = await makeSession();
    const intentId = await insertLegacyWalletIntent(
      sessionId,
      "eip155",
      `0x${"12".repeat(32)}`,
      "review_required",
    );
    await rerunMigration093();
    expect((await readMoneyState(sessionId)).clear).toBe(false);
    const observeTransaction = vi.fn(async () => ({
      kind: "mined" as const,
      status: "reverted" as const,
      blockTimeIso: null,
    }));

    const first = await repairPendingActivity(
      { observeTransaction },
      { includeAuxiliaryState: true },
    );
    expect(first).toMatchObject({ checked: 1, failed: 1 });
    expect((await walletIntentsRepo.getById(intentId, sessionId))?.status).toBe("failed");
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });

    const second = await repairPendingActivity(
      { observeTransaction },
      { includeAuxiliaryState: true },
    );
    expect(second.checked).toBe(0);
    expect(observeTransaction).toHaveBeenCalledTimes(1);
    await rerunMigration093();
    expect((await walletIntentsRepo.getById(intentId, sessionId))?.status).toBe("failed");
  });

  it("Solana review rows converge only from an explicit landed status", async () => {
    const sessionId = await makeSession();
    const signature = "4".repeat(88);
    const intentId = await insertLegacyWalletIntent(
      sessionId,
      "solana",
      signature,
      "review_required",
    );
    await rerunMigration093();
    const getSignatureStatuses = vi.fn(async () => ({
      outcome: "found" as const,
      value: [{ confirmationStatus: "finalized", err: null }],
    }));

    const result = await repairPendingSolanaActivity({
      includeLegacyTransferReview: true,
      getSignatureStatuses,
      getFinalizedTransaction: async () => ({ outcome: "not_found" }),
      getCurrentBlockHeight: async () => ({ outcome: "unavailable" }),
    });
    expect(result).toMatchObject({ checked: 1, confirmed: 1, failed: 0 });
    expect((await walletIntentsRepo.getById(intentId, sessionId))?.status).toBe("executed");
    expect(getSignatureStatuses).toHaveBeenCalledWith([signature]);
  });
});
