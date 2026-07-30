/**
 * Agent Scan activity repo — Bridge API, post-submit lifecycle (migration
 * 045, Phase 2). Sibling of `./bridge-intent.js`, which owns route
 * normalization + intent/pre-broadcast-failure creation and whose module doc
 * has the full Bridge overview (R1-R15/B1-B4/C1-C4 references used below).
 * This file owns everything that happens to a logical `bridge_fill_expected`
 * row AFTER it was created: provider-order-id attachment, fill/refund
 * evidence, and the in-flight pre-check.
 */

import logger from "@utils/logger.js";

import { queryOne, queryOneWith, withTransaction } from "../../client.js";
import {
  resolveActivitySessionByExecutionId,
  withActivitySessionLock,
} from "./session-lock.js";

import { insertBridgeRow, findPendingLogicalRow, buildNormalizedBridgeRoute } from "./bridge-intent.js";
import type { BridgeRouteEndpoints } from "./bridge-intent.js";
import { mapRow } from "./mappers.js";
import type { AgentActivityEvent, AgentActivityLegInput, BridgeChainFamily, CasResult } from "./types.js";

/** Outcome of an attach-order-id attempt (B2/C4). */
export type AttachProviderOrderIdOutcome =
  | "attached"
  | "already_attached_same"
  | "conflict_different_id"
  | "not_pending";

export interface AttachProviderOrderIdResult {
  readonly outcome: AttachProviderOrderIdOutcome;
  /** The logical row's CURRENT state (null only if no logical row exists for the execution). */
  readonly row: AgentActivityEvent | null;
}

/**
 * Attach the provider order id (Khalani orderId / Relay requestId) to the
 * logical row AFTER submit (R5), CAS-guarded `WHERE <logical> AND
 * status='pending' AND provider_order_id IS NULL` (C4):
 *   - fresh attach on a pending logical row → `attached`;
 *   - the SAME id already present → `already_attached_same` (idempotent no-op);
 *   - a DIFFERENT id already present → `conflict_different_id` — NO write, a
 *     structured anomaly is logged (B2);
 *   - the logical row is terminal or missing → `not_pending`.
 * Terminal rows and non-logical siblings are immutable (the CAS never matches
 * them).
 */
export async function attachProviderOrderId(input: {
  readonly executionId: number;
  readonly providerOrderId: string;
}): Promise<AttachProviderOrderIdResult> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET provider_order_id = $2, updated_at = NOW()
      WHERE protocol_execution_id = $1
        AND event_role = 'bridge_fill_expected'
        AND status = 'pending'
        AND provider_order_id IS NULL
      RETURNING *`,
    [input.executionId, input.providerOrderId],
  );
  if (row) return { outcome: "attached", row: mapRow(row) };

  const current = await findLogicalRowByExecution(input.executionId);
  if (!current) return { outcome: "not_pending", row: null };
  if (current.providerOrderId === input.providerOrderId) {
    return { outcome: "already_attached_same", row: current };
  }
  if (current.status !== "pending") {
    // Terminality wins over the different-id anomaly (C4): terminal rows are
    // immutable, and `conflict_different_id` is reserved for a PENDING row
    // already carrying another order id.
    return { outcome: "not_pending", row: current };
  }
  if (current.providerOrderId !== null) {
    // Anomaly (B2): the logical row already carries a DIFFERENT order id. No
    // provider free-text here (ids only) → no scrubber needed.
    logger.warn("agent_activity.bridge.order_id_conflict", {
      protocolExecutionId: input.executionId,
    });
    return { outcome: "conflict_different_id", row: current };
  }
  // Pending-with-null-id CAS miss is impossible (the UPDATE would have matched);
  // reaching here means the row went terminal between the UPDATE and the read.
  return { outcome: "not_pending", row: current };
}

/**
 * Provider-observed evidence for the logical expected-fill row (R2). On a
 * successful provider fill, CAS the logical row `pending -> confirmed`, stamping
 * the destination fill `tx_hash`, `evidence_source`, `observed_at`,
 * `provider_status`, and — ONLY when the caller has independently decoded them
 * against the stored token/recipient (B4/Q2) — the executed amounts. The caller
 * (W4 sweep / W3a in-turn poll) MUST have completed the B4 verification checklist
 * BEFORE calling this; the repo enforces the structural invariants (a confirmed
 * bridge leg needs a tx_hash; an observed row carries no local broadcast fields).
 */
export async function confirmBridgeExpectedFill(input: {
  readonly executionId: number;
  readonly txHash: string;
  readonly evidenceSource: string;
  readonly observedAt?: string;
  readonly providerStatus?: string;
  readonly executedAmountInHuman?: string;
  readonly executedAmountInRaw?: string;
  readonly executedAmountOutHuman?: string;
  readonly executedAmountOutRaw?: string;
}): Promise<CasResult> {
  // Under the session control lock — `pending` is money state the compaction
  // safe-moment gate reads (see `./session-lock.ts`). DB-only: the provider
  // status lookup that produced this evidence has already returned.
  const sessionId = await resolveActivitySessionByExecutionId(input.executionId);
  const row = await withActivitySessionLock(sessionId, (client) =>
    queryOneWith<Record<string, unknown>>(
    client,
    `UPDATE agent_activity
        SET status = 'confirmed', confirmed_at = NOW(),
            tx_hash = $2, evidence_source = $3,
            observed_at = COALESCE($4::timestamptz, NOW()),
            provider_status = $5,
            executed_amount_in_human = $6, executed_amount_in_raw = $7,
            executed_amount_out_human = $8, executed_amount_out_raw = $9,
            updated_at = NOW()
      WHERE protocol_execution_id = $1
        AND event_role = 'bridge_fill_expected'
        AND status = 'pending'
      RETURNING *`,
    [
      input.executionId,
      input.txHash,
      input.evidenceSource,
      input.observedAt ?? null,
      input.providerStatus ?? null,
      input.executedAmountInHuman ?? null,
      input.executedAmountInRaw ?? null,
      input.executedAmountOutHuman ?? null,
      input.executedAmountOutRaw ?? null,
    ],
  ));
  if (row) return { applied: true, row: mapRow(row) };
  const current = await findLogicalRowByExecution(input.executionId);
  if (!current) {
    throw new Error(
      `agent_activity: confirmBridgeExpectedFill — no logical row for execution ${input.executionId}`,
    );
  }
  return { applied: false, row: current };
}

export interface MarkBridgeLegObservedInput {
  readonly executionId: number;
  readonly eventRole: "bridge_fill_observed" | "bridge_refund";
  readonly protocol: string;
  /** The observed leg's execution chain (destination for extra fills, origin for refunds). */
  readonly chainId: number;
  readonly chainSlug?: string;
  readonly chainFamily: BridgeChainFamily;
  readonly txHash: string;
  readonly evidenceSource: string;
  readonly observedAt?: string;
  readonly providerStatus?: string;
  readonly tokenIn?: AgentActivityLegInput;
  readonly tokenOut?: AgentActivityLegInput;
  readonly executedAmountInHuman?: string;
  readonly executedAmountInRaw?: string;
  readonly executedAmountOutHuman?: string;
  readonly executedAmountOutRaw?: string;
}

export interface MarkBridgeLegObservedResult {
  /** false when the tx_hash was already recorded (dedup — returns the existing row). */
  readonly inserted: boolean;
  readonly row: AgentActivityEvent;
}

/**
 * Append an EXTRA externally-observed evidence row (B2): a `bridge_fill_observed`
 * row for an additional provider fill (multi-fill orders), or a `bridge_refund`
 * row for origin-side refund evidence. Inserted `confirmed` (a real, verified
 * on-chain event) with the provider `tx_hash` + `evidence_source` + `observed_at`;
 * it carries NO local submit/broadcast fields (the input has no way to set them —
 * the 045 observed-no-local-fields CHECK is the backstop).
 *
 * Concurrency (B2): a row lock (`SELECT ... FOR UPDATE`) is taken on the logical
 * row so a handler in-turn poll and the W4 sweep cannot both insert the same
 * evidence — under the lock the tx_hash is de-duplicated and the `event_index`
 * is allocated deterministically (`MAX(event_index)+1`). The 044 global tx_hash
 * UNIQUE index is the final backstop. A duplicate tx_hash returns the EXISTING
 * row with `inserted:false` — never a fabricated second confirmation.
 *
 * This never touches the logical row's OWN status — a successful fill confirms it
 * via `confirmBridgeExpectedFill`; a refund fails it via `failActivityEvent`
 * (`failure_code='bridge_refunded'`).
 */
export async function markBridgeLegObserved(
  input: MarkBridgeLegObservedInput,
): Promise<MarkBridgeLegObservedResult> {
  return withTransaction(async (client) => {
    const logicalRaw = await queryOneWith<Record<string, unknown>>(
      client,
      `SELECT * FROM agent_activity
        WHERE protocol_execution_id = $1 AND event_role = 'bridge_fill_expected'
        FOR UPDATE`,
      [input.executionId],
    );
    if (!logicalRaw) {
      throw new Error(
        `agent_activity: markBridgeLegObserved — no logical row for execution ${input.executionId}`,
      );
    }
    const logical = mapRow(logicalRaw);
    // Extract into locals BEFORE the awaits below — TS resets property-access
    // narrowing across `await`, so the null-guard must land on stable consts.
    const { fromChainId, toChainId, fromChainSlug, toChainSlug, walletAddress } = logical;
    const logicalSession = logical.sessionId;
    if (fromChainId === null || toChainId === null || logicalSession === null) {
      throw new Error(
        `agent_activity: markBridgeLegObserved — logical row ${logical.id} missing route/session`,
      );
    }

    // tx_hash dedup under the lock (idempotent handler/sweep re-observation).
    const existing = await queryOneWith<Record<string, unknown>>(
      client,
      `SELECT * FROM agent_activity WHERE protocol_execution_id = $1 AND tx_hash = $2`,
      [input.executionId, input.txHash],
    );
    if (existing) return { inserted: false, row: mapRow(existing) };

    const next = await queryOneWith<{ next_index: number }>(
      client,
      `SELECT COALESCE(MAX(event_index), 0) + 1 AS next_index
         FROM agent_activity WHERE protocol_execution_id = $1`,
      [input.executionId],
    );
    const eventIndex = next?.next_index ?? 1;

    const row = await insertBridgeRow({
      client,
      protocolExecutionId: input.executionId,
      eventIndex,
      eventRole: input.eventRole,
      protocol: input.protocol,
      chainId: input.chainId,
      chainSlug: input.chainSlug,
      chainFamily: input.chainFamily,
      // Route endpoints echoed from the logical row (every bridge row needs them,
      // R1). Tokens are unused for observed rows (no normalized_route computed).
      route: {
        fromChainId,
        fromChainSlug: fromChainSlug ?? undefined,
        fromChainFamily: input.chainFamily,
        fromToken: "",
        toChainId,
        toChainSlug: toChainSlug ?? undefined,
        toChainFamily: input.chainFamily,
        toToken: "",
      },
      walletAddress,
      sessionId: logicalSession,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      txHash: input.txHash,
      evidenceSource: input.evidenceSource,
      observedAt: input.observedAt,
      providerStatus: input.providerStatus,
      status: "confirmed",
      confirmed: true,
      executedAmountInHuman: input.executedAmountInHuman,
      executedAmountInRaw: input.executedAmountInRaw,
      executedAmountOutHuman: input.executedAmountOutHuman,
      executedAmountOutRaw: input.executedAmountOutRaw,
    });
    return { inserted: true, row };
  });
}

export interface BridgeInFlightResult {
  readonly inFlight: boolean;
  /** The pending logical row already occupying this route slot, if any. */
  readonly existing: AgentActivityEvent | null;
}

/**
 * Friendly pre-check for the in-flight guard (C2): is there already a pending
 * logical row for this wallet+session+route? The authoritative gate is the DB
 * UNIQUE index (enforced inside `createBridgeActivityIntent`); this read lets a
 * handler surface "a bridge is already in flight for this route" without racing
 * a 23505. `prequote match alone is NOT consumption` — only a live pending
 * logical row counts.
 */
export async function checkBridgeInFlight(input: {
  readonly walletAddress: string;
  readonly sessionId: string;
  readonly route: BridgeRouteEndpoints;
}): Promise<BridgeInFlightResult> {
  const normalizedRoute = buildNormalizedBridgeRoute(input.route);
  const existing = await findPendingLogicalRow(
    input.walletAddress, input.sessionId, normalizedRoute,
  );
  return { inFlight: existing !== null, existing };
}

// ── Internal helpers ─────────────────────────────────────────────────

/** The logical `bridge_fill_expected` row for an execution (any status), or null. */
async function findLogicalRowByExecution(executionId: number): Promise<AgentActivityEvent | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM agent_activity
      WHERE protocol_execution_id = $1 AND event_role = 'bridge_fill_expected'`,
    [executionId],
  );
  return row ? mapRow(row) : null;
}
