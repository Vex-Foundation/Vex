/** Public, wallet-level Lighter onboarding state. No credential bytes live here. */

import type { PoolClient } from "pg";

import { queryOne } from "../client.js";
import type { LighterEnvironment } from "@tools/lighter/types.js";

export const LIGHTER_ONBOARDING_WORKFLOW_STATES = [
  "integration_enabled",
  "deposit_approval_pending",
  "deposit_preflight_validated",
  "allowance_verified",
  "approve_staged",
  "approve_confirmed",
  "deposit_staged",
  "deposit_l1_confirmed",
  "deposit_l2_pending",
  "account_resolved",
  "key_generated_encrypted",
  "key_registration_approval_pending",
  "change_pub_key_submitted",
  "key_verified",
  "nonce_synchronized",
  "ready_to_trade",
  "ambiguous",
  "failed",
] as const;

export type LighterOnboardingWorkflowState =
  (typeof LIGHTER_ONBOARDING_WORKFLOW_STATES)[number];

/** Narrow transaction surface used by onboarding repositories and unit fakes. */
export type LighterOnboardingQueryClient = Pick<PoolClient, "query">;

export interface LighterOnboardingWorkflowRow {
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly workflowState: LighterOnboardingWorkflowState;
  readonly lastStableState: LighterOnboardingWorkflowState | null;
  readonly activeDepositIntentId: string | null;
  readonly resolvedAccountIndex: number | null;
  readonly apiKeyIndex: number | null;
  readonly publicKeyFingerprint: string | null;
  readonly failureCode: string | null;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface WorkflowRow {
  readonly environment: LighterEnvironment;
  readonly wallet_address: string;
  readonly workflow_state: LighterOnboardingWorkflowState;
  readonly last_stable_state: LighterOnboardingWorkflowState | null;
  readonly active_deposit_intent_id: string | null;
  readonly resolved_account_index: number | null;
  readonly api_key_index: number | null;
  readonly public_key_fingerprint: string | null;
  readonly failure_code: string | null;
  readonly revision: string | number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const RETURNING = `
  environment, wallet_address, workflow_state, last_stable_state,
  active_deposit_intent_id, resolved_account_index, api_key_index,
  public_key_fingerprint, failure_code, revision, created_at, updated_at
`;

const ALLOWED_NEXT: Readonly<Record<LighterOnboardingWorkflowState, readonly LighterOnboardingWorkflowState[]>> = {
  integration_enabled: ["deposit_approval_pending", "account_resolved", "failed"],
  deposit_approval_pending: ["deposit_preflight_validated", "allowance_verified", "approve_staged", "ambiguous", "failed"],
  deposit_preflight_validated: ["allowance_verified", "approve_staged", "ambiguous", "failed"],
  allowance_verified: ["deposit_staged", "ambiguous", "failed"],
  approve_staged: ["approve_confirmed", "ambiguous", "failed"],
  approve_confirmed: ["deposit_staged", "ambiguous", "failed"],
  deposit_staged: ["deposit_l1_confirmed", "deposit_l2_pending", "ambiguous", "failed"],
  deposit_l1_confirmed: ["deposit_l2_pending", "ambiguous", "failed"],
  deposit_l2_pending: ["account_resolved", "ambiguous", "failed"],
  account_resolved: ["deposit_approval_pending", "key_generated_encrypted", "failed"],
  key_generated_encrypted: ["key_registration_approval_pending", "failed"],
  key_registration_approval_pending: ["change_pub_key_submitted", "ambiguous", "failed"],
  change_pub_key_submitted: ["key_verified", "ambiguous", "failed"],
  key_verified: ["nonce_synchronized", "failed"],
  nonce_synchronized: ["ready_to_trade", "failed"],
  ready_to_trade: ["deposit_approval_pending", "failed"],
  ambiguous: ["approve_confirmed", "deposit_l1_confirmed", "deposit_l2_pending", "account_resolved", "key_verified", "failed"],
  failed: ["deposit_approval_pending", "key_generated_encrypted"],
};

export async function getLighterOnboardingWorkflow(
  environment: LighterEnvironment,
  walletAddress: string,
): Promise<LighterOnboardingWorkflowRow | null> {
  assertWalletAddress(walletAddress);
  const row = await queryOne<WorkflowRow>(
    `SELECT ${RETURNING}
       FROM lighter_onboarding_workflows
      WHERE environment = $1 AND wallet_address = LOWER($2)`,
    [environment, walletAddress],
  );
  return row === null ? null : mapRow(row);
}

export async function ensureLighterOnboardingWorkflowEnabledWith(
  client: LighterOnboardingQueryClient,
  environment: LighterEnvironment,
  walletAddress: string,
): Promise<LighterOnboardingWorkflowRow> {
  assertWalletAddress(walletAddress);
  const result = await client.query<WorkflowRow>(
    `INSERT INTO lighter_onboarding_workflows (
       environment, wallet_address, workflow_state
     ) VALUES ($1, LOWER($2), 'integration_enabled')
     ON CONFLICT (environment, wallet_address) DO UPDATE
       SET updated_at = lighter_onboarding_workflows.updated_at
     RETURNING ${RETURNING}`,
    [environment, walletAddress],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Lighter onboarding workflow upsert returned no row.");
  return mapRow(row);
}

export async function transitionLighterOnboardingWorkflowWith(
  client: LighterOnboardingQueryClient,
  input: {
    readonly environment: LighterEnvironment;
    readonly walletAddress: string;
    readonly expectedStates: readonly LighterOnboardingWorkflowState[];
    readonly nextState: LighterOnboardingWorkflowState;
    readonly activeDepositIntentId?: string | null;
    readonly resolvedAccountIndex?: number | null;
    readonly apiKeyIndex?: number | null;
    readonly publicKeyFingerprint?: string | null;
    readonly failureCode?: string | null;
  },
): Promise<LighterOnboardingWorkflowRow | null> {
  assertWalletAddress(input.walletAddress);
  if (input.expectedStates.length === 0) {
    throw new Error("Lighter onboarding workflow transition requires an expected state.");
  }
  for (const current of input.expectedStates) {
    if (!ALLOWED_NEXT[current].includes(input.nextState)) {
      throw new Error(`Invalid Lighter onboarding workflow transition: ${current} -> ${input.nextState}.`);
    }
  }
  const result = await client.query<WorkflowRow>(
    `UPDATE lighter_onboarding_workflows
        SET workflow_state = $4,
            last_stable_state = CASE WHEN $4 = 'ambiguous' THEN workflow_state ELSE $4 END,
            active_deposit_intent_id = COALESCE($5, active_deposit_intent_id),
            resolved_account_index = COALESCE($6, resolved_account_index),
            api_key_index = COALESCE($7, api_key_index),
            public_key_fingerprint = COALESCE($8, public_key_fingerprint),
            failure_code = $9,
            revision = revision + 1,
            updated_at = NOW()
      WHERE environment = $1
        AND wallet_address = LOWER($2)
        AND workflow_state = ANY($3)
      RETURNING ${RETURNING}`,
    [
      input.environment,
      input.walletAddress,
      input.expectedStates,
      input.nextState,
      input.activeDepositIntentId ?? null,
      input.resolvedAccountIndex ?? null,
      input.apiKeyIndex ?? null,
      input.publicKeyFingerprint ?? null,
      input.failureCode ?? null,
    ],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

function assertWalletAddress(walletAddress: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    throw new Error("Lighter onboarding workflow requires a valid EVM wallet address.");
  }
}

function mapRow(row: WorkflowRow): LighterOnboardingWorkflowRow {
  return {
    environment: row.environment,
    walletAddress: row.wallet_address,
    workflowState: row.workflow_state,
    lastStableState: row.last_stable_state,
    activeDepositIntentId: row.active_deposit_intent_id,
    resolvedAccountIndex: row.resolved_account_index,
    apiKeyIndex: row.api_key_index,
    publicKeyFingerprint: row.public_key_fingerprint,
    failureCode: row.failure_code,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
