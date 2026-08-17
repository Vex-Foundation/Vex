/**
 * Repository for `lighter_onboarding_intents` — the durable state of each
 * fund-moving onboarding leg (Phase 7). It records addresses, amounts, tx
 * hashes, and lifecycle only; never keys, signatures, or signed payloads.
 * Marks persist tx hashes BEFORE broadcast (staged-broadcast doctrine) and
 * advance execution state through explicit CAS transitions.
 */

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { query, queryOne } from "../client.js";
import type { LighterEnvironment } from "@tools/lighter/types.js";
import {
  transitionLighterOnboardingWorkflowWith,
  type LighterOnboardingWorkflowState,
} from "./lighter-onboarding-workflows.js";

export type LighterOnboardingCapability = "deposit" | "key_registration" | "swap" | "withdrawal";

export type LighterOnboardingApprovalStatus =
  | "approval_pending"
  | "approved"
  | "rejected"
  | "expired";

export type LighterOnboardingExecutionState =
  | "prepared"
  | "approval_pending"
  | "approved"
  | "allowance_verified"
  | "approve_submitted"
  | "approve_confirmed"
  | "deposit_submitted"
  | "deposit_confirmed"
  | "credited"
  | "ambiguous"
  | "failed";

export interface LighterOnboardingIntentRow {
  readonly intentId: string;
  readonly sessionId: string;
  readonly protocolExecutionId: number | null;
  readonly approvalId: string | null;
  readonly environment: LighterEnvironment;
  readonly capability: LighterOnboardingCapability;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly depositContract: string | null;
  readonly depositTo: string | null;
  readonly assetIndex: number | null;
  readonly routeType: number | null;
  readonly amountUnits: string | null;
  readonly approvalStatus: LighterOnboardingApprovalStatus;
  readonly executionState: LighterOnboardingExecutionState;
  readonly approveTxHash: string | null;
  readonly depositTxHash: string | null;
  readonly resolvedAccountIndex: number | null;
  readonly decisionReason: string | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
}

export interface CreateDepositIntentInput {
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly depositContract: string;
  readonly depositTo: string;
  readonly assetIndex: number;
  readonly routeType: number;
  readonly amountUnits: string;
  readonly expiresAt: Date;
}

export type CreateDepositIntentOutcome =
  | { readonly outcome: "created"; readonly intent: LighterOnboardingIntentRow }
  | { readonly outcome: "live_conflict"; readonly intent: LighterOnboardingIntentRow | null };

export function generateOnboardingIntentId(): string {
  return `lighter-onboard-${randomUUID()}`;
}

const RETURNING = `
  intent_id, session_id, protocol_execution_id, approval_id, environment, capability,
  wallet_address, chain_id, deposit_contract, deposit_to, asset_index, route_type, amount_units,
  approval_status, execution_state, approve_tx_hash, deposit_tx_hash, resolved_account_index,
  decision_reason, failure_reason, created_at, updated_at, expires_at
`;

const INSERT_DEPOSIT_SQL = `
  INSERT INTO lighter_onboarding_intents (
    intent_id, session_id, environment, capability, wallet_address, chain_id,
    deposit_contract, deposit_to, asset_index, route_type, amount_units,
    approval_status, execution_state, expires_at
  ) VALUES (
    $1, $2, $3, 'deposit', $4, $5, $6, $7, $8, $9, $10, 'approval_pending', 'approval_pending', $11
  )
  ON CONFLICT DO NOTHING
  RETURNING ${RETURNING}
`;

/**
 * Create the row under the caller's session-control-locked transaction.
 * `ON CONFLICT DO NOTHING` converts the partial unique-index race into a
 * deterministic result; a second statement returns the authoritative live row.
 */
export async function createOrFindLiveDepositApprovalPendingWith(
  client: PoolClient,
  input: CreateDepositIntentInput,
): Promise<CreateDepositIntentOutcome> {
  const inserted = await client.query<Record<string, unknown>>(INSERT_DEPOSIT_SQL, [
    generateOnboardingIntentId(),
    input.sessionId,
    input.environment,
    input.walletAddress,
    input.chainId,
    input.depositContract,
    input.depositTo,
    input.assetIndex,
    input.routeType,
    input.amountUnits,
    input.expiresAt,
  ]);
  const created = inserted.rows[0];
  if (created !== undefined) {
    const intent = mapRow(created);
    await requireDepositWorkflowTransition(client, intent, {
      expectedStates: [
        "integration_enabled",
        "account_resolved",
        "ready_to_trade",
        "failed",
      ],
      nextState: "deposit_approval_pending",
    });
    return { outcome: "created", intent };
  }

  const existing = await client.query<Record<string, unknown>>(
    `SELECT ${RETURNING}
       FROM lighter_onboarding_intents
      WHERE environment = $1
        AND LOWER(wallet_address) = LOWER($2)
        AND capability = 'deposit'
        AND approval_status IN ('approval_pending', 'approved')
        AND execution_state NOT IN ('credited', 'failed')
      ORDER BY created_at ASC
      LIMIT 1`,
    [input.environment, input.walletAddress],
  );
  const conflict = existing.rows[0];
  return {
    outcome: "live_conflict",
    intent: conflict === undefined ? null : mapRow(conflict),
  };
}

export async function markApprovalDecisionWith(
  client: PoolClient,
  input: {
    readonly intentId: string;
    readonly decision: "approved" | "rejected" | "expired";
    readonly approvalId?: string | null;
    readonly protocolExecutionId?: number | null;
    readonly reason?: string | null;
  },
): Promise<LighterOnboardingIntentRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
       SET approval_status = $2,
           execution_state = CASE WHEN $2 = 'approved' THEN 'approved' ELSE execution_state END,
           approval_id = COALESCE($3, approval_id),
           protocol_execution_id = COALESCE($4, protocol_execution_id),
           decision_reason = $5,
           decided_at = NOW(),
           updated_at = NOW()
     WHERE intent_id = $1 AND approval_status = 'approval_pending'
     RETURNING ${RETURNING}`,
    [input.intentId, input.decision, input.approvalId ?? null, input.protocolExecutionId ?? null, input.reason ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  if (input.decision !== "approved") {
    await requireDepositWorkflowTransition(client, intent, {
      expectedStates: ["deposit_approval_pending", "deposit_preflight_validated"],
      nextState: "failed",
      failureCode: input.decision === "rejected"
        ? "deposit_approval_rejected"
        : "deposit_approval_expired",
    });
  }
  return intent;
}

/** Persist an approve tx hash before broadcast; only from the approved state. */
export async function markApproveSubmittedWith(
  client: PoolClient,
  intentId: string,
  approveTxHash: string,
): Promise<LighterOnboardingIntentRow | null> {
  return advanceDepositWith(client, intentId, "approve_submitted", ["approved"], {
    approve_tx_hash: approveTxHash,
  }, {
    expectedStates: ["deposit_approval_pending", "deposit_preflight_validated"],
    nextState: "approve_staged",
  });
}

export async function markApproveConfirmedWith(
  client: PoolClient,
  intentId: string,
): Promise<LighterOnboardingIntentRow | null> {
  return advanceDepositWith(
    client,
    intentId,
    "approve_confirmed",
    ["approve_submitted"],
    {},
    { expectedStates: ["approve_staged", "ambiguous"], nextState: "approve_confirmed" },
  );
}

/** Record that the live on-chain allowance already covered this exact amount. */
export async function markAllowanceVerifiedWith(
  client: PoolClient,
  intentId: string,
): Promise<LighterOnboardingIntentRow | null> {
  return advanceDepositWith(
    client,
    intentId,
    "allowance_verified",
    ["approved"],
    {},
    {
      expectedStates: ["deposit_approval_pending", "deposit_preflight_validated"],
      nextState: "allowance_verified",
    },
  );
}

/** Persist a deposit tx hash before broadcast; only after allowance is proven. */
export async function markDepositSubmittedWith(
  client: PoolClient,
  intentId: string,
  depositTxHash: string,
): Promise<LighterOnboardingIntentRow | null> {
  return advanceDepositWith(
    client,
    intentId,
    "deposit_submitted",
    ["approve_confirmed", "allowance_verified"],
    { deposit_tx_hash: depositTxHash },
    {
      expectedStates: ["approve_confirmed", "allowance_verified"],
      nextState: "deposit_staged",
    },
  );
}

export async function markDepositConfirmedWith(
  client: PoolClient,
  intentId: string,
): Promise<LighterOnboardingIntentRow | null> {
  return advanceDepositWith(
    client,
    intentId,
    "deposit_confirmed",
    ["deposit_submitted"],
    {},
    {
      expectedStates: ["deposit_staged", "ambiguous"],
      nextState: "deposit_l2_pending",
    },
  );
}

export async function markAmbiguousWith(
  client: PoolClient,
  intentId: string,
  reason: string,
): Promise<LighterOnboardingIntentRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
       SET execution_state = 'ambiguous', failure_reason = $2, updated_at = NOW()
     WHERE intent_id = $1 AND execution_state NOT IN ('credited','failed')
     RETURNING ${RETURNING}`,
    [intentId, reason],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  await requireDepositWorkflowTransition(client, intent, {
    expectedStates: [
      "deposit_approval_pending",
      "deposit_preflight_validated",
      "allowance_verified",
      "approve_staged",
      "approve_confirmed",
      "deposit_staged",
      "deposit_l1_confirmed",
      "deposit_l2_pending",
    ],
    nextState: "ambiguous",
    failureCode: "deposit_outcome_ambiguous",
  });
  return intent;
}

export async function markFailedWith(
  client: PoolClient,
  intentId: string,
  reason: string,
): Promise<LighterOnboardingIntentRow | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
       SET execution_state = 'failed', failure_reason = $2, updated_at = NOW()
     WHERE intent_id = $1 AND execution_state NOT IN ('credited')
     RETURNING ${RETURNING}`,
    [intentId, reason],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  await requireDepositWorkflowTransition(client, intent, {
    expectedStates: [
      "deposit_approval_pending",
      "deposit_preflight_validated",
      "allowance_verified",
      "approve_staged",
      "approve_confirmed",
      "deposit_staged",
      "deposit_l1_confirmed",
      "deposit_l2_pending",
      "ambiguous",
    ],
    nextState: "failed",
    failureCode: "deposit_failed",
  });
  return intent;
}

export async function findByIntentId(intentId: string): Promise<LighterOnboardingIntentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${RETURNING} FROM lighter_onboarding_intents WHERE intent_id = $1`,
    [intentId],
  );
  return row ? mapRow(row) : null;
}

export async function listUnresolved(
  environment: LighterEnvironment,
): Promise<LighterOnboardingIntentRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${RETURNING} FROM lighter_onboarding_intents
      WHERE environment = $1
        AND execution_state NOT IN ('credited','failed')
        AND approval_status <> 'rejected'
      ORDER BY updated_at DESC`,
    [environment],
  );
  return rows.map(mapRow);
}

export async function listUnresolvedDepositsForWallet(
  environment: LighterEnvironment,
  walletAddress: string,
): Promise<LighterOnboardingIntentRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${RETURNING} FROM lighter_onboarding_intents
      WHERE environment = $1
        AND capability = 'deposit'
        AND LOWER(wallet_address) = LOWER($2)
        AND execution_state NOT IN ('credited','failed')
        AND approval_status <> 'rejected'
      ORDER BY updated_at DESC`,
    [environment, walletAddress],
  );
  return rows.map(mapRow);
}

export async function reconcileApproveReceiptWith(
  client: PoolClient,
  input: {
    readonly intentId: string;
    readonly txHash: string;
    readonly outcome: "confirmed" | "reverted";
  },
): Promise<LighterOnboardingIntentRow | null> {
  const next = input.outcome === "confirmed" ? "approve_confirmed" : "failed";
  const reason = input.outcome === "reverted"
    ? "Ethereum receipt proves the Lighter USDC approval transaction reverted."
    : null;
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = $3,
            failure_reason = $4,
            updated_at = NOW()
      WHERE intent_id = $1
        AND LOWER(approve_tx_hash) = LOWER($2)
        AND deposit_tx_hash IS NULL
        AND execution_state IN ('approve_submitted', 'ambiguous')
      RETURNING ${RETURNING}`,
    [input.intentId, input.txHash, next, reason],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  await requireDepositWorkflowTransition(client, intent, input.outcome === "confirmed"
    ? {
        expectedStates: ["approve_staged", "ambiguous"],
        nextState: "approve_confirmed",
      }
    : {
        expectedStates: ["approve_staged", "ambiguous"],
        nextState: "failed",
        failureCode: "approve_transaction_reverted",
      });
  return intent;
}

export async function reconcileDepositReceiptWith(
  client: PoolClient,
  input: {
    readonly intentId: string;
    readonly txHash: string;
    readonly outcome: "confirmed" | "reverted";
  },
): Promise<LighterOnboardingIntentRow | null> {
  const next = input.outcome === "confirmed" ? "deposit_confirmed" : "failed";
  const reason = input.outcome === "reverted"
    ? "Ethereum receipt proves the Lighter deposit transaction reverted."
    : null;
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
        SET execution_state = $3,
            failure_reason = $4,
            updated_at = NOW()
      WHERE intent_id = $1
        AND LOWER(deposit_tx_hash) = LOWER($2)
        AND execution_state IN ('deposit_submitted', 'ambiguous')
      RETURNING ${RETURNING}`,
    [input.intentId, input.txHash, next, reason],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  await requireDepositWorkflowTransition(client, intent, input.outcome === "confirmed"
    ? {
        expectedStates: ["deposit_staged", "ambiguous"],
        nextState: "deposit_l2_pending",
      }
    : {
        expectedStates: ["deposit_staged", "ambiguous"],
        nextState: "failed",
        failureCode: "deposit_transaction_reverted",
      });
  return intent;
}

async function advanceDepositWith(
  client: PoolClient,
  intentId: string,
  next: LighterOnboardingExecutionState,
  from: LighterOnboardingExecutionState[],
  set: Record<string, unknown> = {},
  workflow: {
    readonly expectedStates: readonly LighterOnboardingWorkflowState[];
    readonly nextState: LighterOnboardingWorkflowState;
    readonly resolvedAccountIndex?: number | null;
  },
): Promise<LighterOnboardingIntentRow | null> {
  const columns = Object.keys(set);
  const setClauses = columns.map((col, i) => `${col} = $${i + 3}`);
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_onboarding_intents
       SET execution_state = $2${setClauses.length ? ", " + setClauses.join(", ") : ""}, updated_at = NOW()
     WHERE intent_id = $1 AND execution_state = ANY($${columns.length + 3})
     RETURNING ${RETURNING}`,
    [intentId, next, ...columns.map((c) => set[c]), from],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const intent = mapRow(row);
  await requireDepositWorkflowTransition(client, intent, workflow);
  return intent;
}

async function requireDepositWorkflowTransition(
  client: PoolClient,
  intent: LighterOnboardingIntentRow,
  input: {
    readonly expectedStates: readonly LighterOnboardingWorkflowState[];
    readonly nextState: LighterOnboardingWorkflowState;
    readonly resolvedAccountIndex?: number | null;
    readonly failureCode?: string | null;
  },
): Promise<void> {
  const workflow = await transitionLighterOnboardingWorkflowWith(client, {
    environment: intent.environment,
    walletAddress: intent.walletAddress,
    expectedStates: input.expectedStates,
    nextState: input.nextState,
    activeDepositIntentId: intent.intentId,
    resolvedAccountIndex: input.resolvedAccountIndex,
    failureCode: input.failureCode,
  });
  if (workflow === null) {
    throw new Error(
      `Lighter onboarding workflow rejected ${input.nextState} for intent ${intent.intentId}.`,
    );
  }
}

function mapRow(row: Record<string, unknown>): LighterOnboardingIntentRow {
  return {
    intentId: String(row.intent_id),
    sessionId: String(row.session_id),
    protocolExecutionId: row.protocol_execution_id === null ? null : Number(row.protocol_execution_id),
    approvalId: row.approval_id === null ? null : String(row.approval_id),
    environment: row.environment as LighterEnvironment,
    capability: row.capability as LighterOnboardingCapability,
    walletAddress: String(row.wallet_address),
    chainId: Number(row.chain_id),
    depositContract: row.deposit_contract === null ? null : String(row.deposit_contract),
    depositTo: row.deposit_to === null ? null : String(row.deposit_to),
    assetIndex: row.asset_index === null ? null : Number(row.asset_index),
    routeType: row.route_type === null ? null : Number(row.route_type),
    amountUnits: row.amount_units === null ? null : String(row.amount_units),
    approvalStatus: row.approval_status as LighterOnboardingApprovalStatus,
    executionState: row.execution_state as LighterOnboardingExecutionState,
    approveTxHash: row.approve_tx_hash === null ? null : String(row.approve_tx_hash),
    depositTxHash: row.deposit_tx_hash === null ? null : String(row.deposit_tx_hash),
    resolvedAccountIndex: row.resolved_account_index === null ? null : Number(row.resolved_account_index),
    decisionReason: row.decision_reason === null ? null : String(row.decision_reason),
    failureReason: row.failure_reason === null ? null : String(row.failure_reason),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    expiresAt: row.expires_at as Date,
  };
}
