/**
 * Durable Hyperliquid session-risk proposals.
 *
 * Rows preserve the proposal the user saw. Activation only changes lifecycle
 * state in one transaction; policy_json is never updated in place.
 */

import type { PoolClient } from "pg";

import {
  HYPERLIQUID_POLICY_VERSION,
  hyperliquidPolicySchema,
  type HyperliquidPolicy,
} from "../../../lib/hyperliquid-policy.js";
import { execute, executeWith, query, queryOne, queryOneWith, withTransaction } from "../client.js";
import { jsonb } from "../params.js";

export type HyperliquidPolicyProposedBy = "agent" | "user";
export type HyperliquidSessionPolicyStatus = "proposed" | "active" | "expired" | "revoked";

interface HyperliquidSessionPolicyRow {
  readonly id: string;
  readonly session_id: string;
  readonly wallet_address: string;
  readonly coin: string;
  readonly proposal_id: string;
  readonly policy_json: unknown;
  readonly policy_version: number;
  readonly proposed_by: string;
  readonly status: string;
  readonly confirmed_at: string | Date | null;
  readonly expires_at: string | Date | null;
  readonly created_at: string | Date;
}

export interface HyperliquidSessionPolicyProposal {
  readonly id: string;
  readonly sessionId: string;
  readonly walletAddress: string;
  readonly coin: string;
  readonly proposalId: string;
  readonly policy: HyperliquidPolicy;
  readonly policyVersion: number;
  readonly proposedBy: HyperliquidPolicyProposedBy;
  readonly status: HyperliquidSessionPolicyStatus;
  readonly confirmedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface CreateHyperliquidSessionPolicyInput {
  readonly sessionId: string;
  readonly walletAddress: string;
  readonly coin: string;
  readonly policy: HyperliquidPolicy;
  readonly proposedBy: HyperliquidPolicyProposedBy;
  readonly expiresAt?: string | null;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function status(value: string): HyperliquidSessionPolicyStatus {
  if (value === "proposed" || value === "active" || value === "expired" || value === "revoked") {
    return value;
  }
  throw new Error(`Invalid Hyperliquid session policy status: ${value}`);
}

function proposedBy(value: string): HyperliquidPolicyProposedBy {
  if (value === "agent" || value === "user") return value;
  throw new Error(`Invalid Hyperliquid session policy proposer: ${value}`);
}

function mapRow(row: HyperliquidSessionPolicyRow): HyperliquidSessionPolicyProposal {
  return {
    id: row.id,
    sessionId: row.session_id,
    walletAddress: row.wallet_address,
    coin: row.coin,
    proposalId: row.proposal_id,
    policy: hyperliquidPolicySchema.parse(row.policy_json),
    policyVersion: row.policy_version,
    proposedBy: proposedBy(row.proposed_by),
    status: status(row.status),
    confirmedAt: row.confirmed_at === null ? null : iso(row.confirmed_at),
    expiresAt: row.expires_at === null ? null : iso(row.expires_at),
    createdAt: iso(row.created_at),
  };
}

/** Create a new immutable proposal; callers activate it separately. */
export async function createHyperliquidSessionPolicyProposal(
  input: CreateHyperliquidSessionPolicyInput,
  client?: PoolClient,
): Promise<HyperliquidSessionPolicyProposal> {
  const policy = hyperliquidPolicySchema.parse(input.policy);
  const sql = `INSERT INTO hyperliquid_session_policies
      (session_id, wallet_address, coin, policy_json, policy_version, proposed_by, status, expires_at)
    VALUES ($1, $2, $3, $4::jsonb, 1, $5, 'proposed', $6)
    RETURNING *`;
  const params = [
    input.sessionId,
    input.walletAddress,
    input.coin,
    jsonb(policy),
    input.proposedBy,
    input.expiresAt ?? null,
  ];
  const row = client
    ? await queryOneWith<HyperliquidSessionPolicyRow>(client, sql, params)
    : await queryOne<HyperliquidSessionPolicyRow>(sql, params);
  if (row === null) throw new Error("Could not create Hyperliquid policy proposal.");
  return mapRow(row);
}

/** Read the only active overlay for one trusted session/wallet pair. */
export async function getActiveHyperliquidSessionPolicy(
  sessionId: string,
  walletAddress: string,
  client?: PoolClient,
): Promise<HyperliquidSessionPolicyProposal | null> {
  const sql = `SELECT * FROM hyperliquid_session_policies
    WHERE session_id = $1
      AND wallet_address = $2
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY confirmed_at DESC NULLS LAST, created_at DESC
    LIMIT 1`;
  const row = client
    ? await queryOneWith<HyperliquidSessionPolicyRow>(client, sql, [sessionId, walletAddress])
    : await queryOne<HyperliquidSessionPolicyRow>(sql, [sessionId, walletAddress]);
  return row === null ? null : mapRow(row);
}

/** Main uses this at boot to hydrate its synchronous, fail-closed resolver cache. */
export async function listActiveHyperliquidSessionPolicies(): Promise<readonly HyperliquidSessionPolicyProposal[]> {
  const rows = await query<HyperliquidSessionPolicyRow>(
    `SELECT * FROM hyperliquid_session_policies
     WHERE status = 'active' AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY session_id ASC, wallet_address ASC, confirmed_at DESC NULLS LAST, created_at DESC`,
  );
  return rows.map(mapRow);
}

/** Bounded renderer DTO reads use this to show a pending/active proposal card. */
export async function listHyperliquidSessionPolicyProposals(
  sessionId: string,
  walletAddress: string,
): Promise<readonly HyperliquidSessionPolicyProposal[]> {
  const rows = await query<HyperliquidSessionPolicyRow>(
    `SELECT * FROM hyperliquid_session_policies
     WHERE session_id = $1 AND wallet_address = $2
     ORDER BY created_at DESC
     LIMIT 20`,
    [sessionId, walletAddress],
  );
  return rows.map(mapRow);
}

/**
 * Atomically replace the active policy for this session/wallet with a reviewed
 * proposal. The proposal payload itself remains untouched.
 */
export async function activateHyperliquidSessionPolicyProposal(
  proposalId: string,
  sessionId: string,
  walletAddress: string,
): Promise<HyperliquidSessionPolicyProposal | null> {
  return withTransaction(async (client) => {
    await executeWith(
      client,
      `UPDATE hyperliquid_session_policies
       SET status = 'revoked'
       WHERE session_id = $1 AND wallet_address = $2 AND status = 'active'`,
      [sessionId, walletAddress],
    );
    const row = await queryOneWith<HyperliquidSessionPolicyRow>(
      client,
      `UPDATE hyperliquid_session_policies
       SET status = 'active', confirmed_at = NOW()
       WHERE proposal_id = $1
         AND session_id = $2
         AND wallet_address = $3
         AND status = 'proposed'
         AND (expires_at IS NULL OR expires_at > NOW())
       RETURNING *`,
      [proposalId, sessionId, walletAddress],
    );
    return row === null ? null : mapRow(row);
  });
}

/** Explicit lifecycle operation for expiry/revocation paths added later. */
export async function revokeHyperliquidSessionPolicyProposal(
  proposalId: string,
  sessionId: string,
  walletAddress: string,
): Promise<boolean> {
  const changed = await execute(
    `UPDATE hyperliquid_session_policies
     SET status = 'revoked'
     WHERE proposal_id = $1 AND session_id = $2 AND wallet_address = $3
       AND status IN ('proposed', 'active')`,
    [proposalId, sessionId, walletAddress],
  );
  return changed > 0;
}

export const HYPERLIQUID_SESSION_POLICY_VERSION = HYPERLIQUID_POLICY_VERSION;
