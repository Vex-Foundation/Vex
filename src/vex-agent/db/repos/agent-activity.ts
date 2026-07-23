/**
 * Agent Scan activity repo — `agent_activity` (plan §4.1 + §11.1, migration
 * `044_agent_activity.sql`; FIX-SPINE round 1 hardened the CAS/conditional-
 * state contract per Codex findings 3/5/6/7/9; FIX2-SPINE round 2 added
 * `abortPlannedEvents` per Codex final-review finding 3/C17).
 *
 * One row per swap TRANSACTION EVENT (an allowance reset, an allowance grant,
 * or the swap itself), grouped by `protocol_execution_id` + uniquely keyed by
 * `(protocol_execution_id, event_index)`. Append-mostly / current-state: a row
 * is created `pending`, then finalized EXACTLY once via a compare-and-set
 * UPDATE (`WHERE status = 'pending'`) to a terminal state
 * (`confirmed` | `definitively_failed`). Terminal rows are immutable — every
 * finalizing function here is a CAS write, never an unconditional one, and
 * every one returns `{applied, row}` so a caller can tell "I finalized this"
 * from "this was already finalized" (finding 6/C7).
 *
 * Write protocol callers (the Kyber/Uniswap execute handlers) MUST follow,
 * verbatim from plan §11.1 (amended by FIX-SPINE C6):
 *   1. `createAgentActivityIntent` — BEFORE any allowance/swap broadcast.
 *      Atomically creates the `protocol_executions` intent row AND every
 *      initial `agent_activity` event row (one-or-more — an allowance reset,
 *      an allowance grant, and the swap itself can each need their own row).
 *   2. `markActivityBroadcast` — persist the SIGNED tx hash + from/nonce +
 *      `submit_attempted_at` BEFORE the RPC submit call. CAS `WHERE
 *      status='pending' AND tx_hash IS NULL` — a repair sweep or a duplicate
 *      caller can NEVER overwrite an already-staged hash.
 *   3. `markBroadcastAccepted` — once the RPC has actually accepted the
 *      submission. CAS `WHERE tx_hash IS NOT NULL AND broadcast_at IS NULL` —
 *      cannot run before step 2 persisted a hash, cannot run twice.
 *      (best-effort; an ambiguous/timeout submit result must NOT call this
 *      and must NOT call `failActivityEvent` either — the row stays
 *      `pending` for the repair sweep).
 *   4. `confirmActivityEvent` / `failActivityEvent` — CAS finalize from a
 *      DEFINITIVE receipt only. A receipt-wait THROW (confirmation could not
 *      be determined — see `src/tools/evm-chains/receipt-guard.ts:29-37`) is
 *      NOT a call to `failActivityEvent`; the row stays `pending` for the
 *      repair sweep (`src/vex-agent/sync/agent-activity-repair.ts`) forever
 *      — ambiguity never terminalizes (plan §11.1 / FIX-SPINE C1).
 *
 * On an EARLY plan abort (an upstream leg reverts or ends ambiguously) or in
 * the handler's outer catch, the venue calls `abortPlannedEvents` to
 * finalize every remaining never-signed row of the SAME execution — see its
 * own doc comment (FIX2-SPINE C17). This is a "not attempted" outcome, not an
 * ambiguous one, so it does not conflict with step 4's ambiguity rule.
 *
 * A pre-broadcast failure (e.g. a route-not-found quote) calls
 * `createAgentActivityPreBroadcastFailure` directly — a hashless
 * `definitively_failed` row is created in one step (there was never anything
 * to broadcast).
 *
 * Sanitization at the repo boundary (finding 9/C5): `failure_reason` passes
 * `redact()` + a hard 500-char cap here, ALWAYS — callers cannot bypass it by
 * pre-sanitizing. `intentParams` sanitization (secret-shape scrub + 8KiB cap)
 * lives in `executions.ts`'s `createExecutionIntent` (the actual
 * `protocol_executions.params` boundary, shared with Hyperliquid).
 *
 * `record_version` is fixed at 1 for every row this phase; reserved for a
 * future non-backward-compatible reshape without needing a new table.
 */

import type { PoolClient } from "pg";

import logger from "@utils/logger.js";

import { execute, queryOne, queryOneWith, query, withTransaction } from "../client.js";
import { nullableJsonb } from "../params.js";
import { createExecutionIntent } from "./executions.js";
import { redact } from "../../../lib/diagnostics/text-redaction.js";

// ── Types ─────────────────────────────────────────────────────────

/** Swap rows (Phase 1) or bridge rows (Phase 2, migration 045). */
export type AgentActivityKind = "swap" | "bridge";

/**
 * Event roles. Phase-1 swap roles PLUS the Phase-2 bridge roles (migration
 * 045). `bridge_fill_expected` is the LOGICAL-row marker (B2) — exactly one per
 * execution, carrying the route endpoints + amounts + `provider_order_id` that
 * every feed/dedup/in-flight-guard keys on. `bridge_deposit` is the Vex-signed
 * origin leg; `bridge_fill_observed`/`bridge_refund` are externally-observed
 * (solver-signed) evidence rows.
 */
export type AgentActivityEventRole =
  | "allowance_reset"
  | "allowance"
  | "swap"
  | "bridge_deposit"
  | "bridge_fill_expected"
  | "bridge_fill_observed"
  | "bridge_refund";

/** Chain family discriminator (045) — drives the nonce matrix + explorer-link resolution. */
export type BridgeChainFamily = "eip155" | "solana";

export type AgentActivityStatus = "pending" | "confirmed" | "definitively_failed";

/**
 * Closed enum — plan §4.1, grown to 11 members by FIX-SPINE round 1 (finding
 * 7/C1): `mined_revert` is the repair sweep's ONE definitive-failure path (a
 * receipt lookup that came back reverted). `confirmation_timeout` stays in
 * the enum but is RESERVED — nothing in this repo or the repair sweep ever
 * sets it; ambiguity (missing receipt, RPC error, receipt-wait throw) leaves
 * the row `pending` forever instead.
 */
export type AgentActivityFailureCode =
  | "route_not_found"
  | "slippage"
  | "deadline_expired"
  | "insufficient_liquidity"
  | "allowance_or_balance"
  | "chain_unsupported"
  | "simulation_reverted"
  | "mined_revert"
  | "broadcast_error"
  | "confirmation_timeout"
  | "unknown"
  // Bridge terminal codes (045): `bridge_refunded` = the bridge failed but funds
  // were returned to `refundTo` (money back != success); `bridge_failed` = a
  // provider-terminal failure / rejected step set.
  | "bridge_failed"
  | "bridge_refunded";

const CLOSED_FAILURE_CODES: ReadonlySet<string> = new Set<AgentActivityFailureCode>([
  "route_not_found",
  "slippage",
  "deadline_expired",
  "insufficient_liquidity",
  "allowance_or_balance",
  "chain_unsupported",
  "simulation_reverted",
  "mined_revert",
  "broadcast_error",
  "confirmation_timeout",
  "unknown",
  "bridge_failed",
  "bridge_refunded",
]);

/** Fail-closed runtime guard for the closed `failure_code` enum (never reaches SQL on a miss). */
function assertFailureCode(code: string): asserts code is AgentActivityFailureCode {
  if (!CLOSED_FAILURE_CODES.has(code)) {
    throw new Error(`agent_activity: "${code}" is not a recognized failure_code`);
  }
}

/**
 * Repo-boundary sanitization for `failure_reason` (finding 9/C5) — applied
 * UNCONDITIONALLY inside every function that writes this column, so a
 * caller cannot bypass it by skipping its own redaction. Two-tier `redact()`
 * (hard-redacts secret shapes, masks addresses/hashes) then a hard 500-char
 * cap — raw provider/RPC text NEVER reaches this column.
 */
const MAX_FAILURE_REASON_CHARS = 500;
function sanitizeFailureReason(reason: string): string {
  const redacted = redact(reason).text;
  return redacted.length > MAX_FAILURE_REASON_CHARS
    ? `${redacted.slice(0, MAX_FAILURE_REASON_CHARS)}…[truncated]`
    : redacted;
}

export interface AgentActivityLegInput {
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  amountHuman?: string;
  amountRaw?: string;
}

export interface CreatePendingActivityEventInput {
  protocolExecutionId: number;
  eventIndex: number;
  eventRole: AgentActivityEventRole;
  kind: "swap";
  protocol: string;
  chainId: number;
  chainSlug?: string;
  walletAddress: string;
  sessionId: string;
  tokenIn?: AgentActivityLegInput;
  tokenOut?: AgentActivityLegInput;
  usdInEst?: string;
  usdOutEst?: string;
  usdFeeEst?: string;
  usdSource?: string;
  routeProvenance?: Record<string, unknown>;
}

export interface MarkActivityBroadcastInput {
  txHash: string;
  fromAddress: string;
  nonce: number;
}

export interface ConfirmActivityEventInput {
  executedAmountInHuman?: string;
  executedAmountInRaw?: string;
  executedAmountOutHuman?: string;
  executedAmountOutRaw?: string;
}

export interface FailActivityEventInput {
  failureCode: AgentActivityFailureCode;
  failureReason: string;
}

export interface RecordPreBroadcastFailureInput {
  protocolExecutionId: number;
  eventIndex: number;
  eventRole: AgentActivityEventRole;
  kind: "swap";
  protocol: string;
  chainId: number;
  chainSlug?: string;
  walletAddress: string;
  sessionId: string;
  tokenIn?: AgentActivityLegInput;
  tokenOut?: AgentActivityLegInput;
  failureCode: AgentActivityFailureCode;
  failureReason: string;
}

export interface AgentActivityEvent {
  id: number;
  protocolExecutionId: number;
  eventIndex: number;
  eventRole: AgentActivityEventRole;
  recordVersion: number;
  kind: AgentActivityKind;
  protocol: string;
  chainId: number;
  chainSlug: string | null;
  status: AgentActivityStatus;
  failureCode: AgentActivityFailureCode | null;
  failureReason: string | null;
  tokenInAddress: string | null;
  tokenInSymbol: string | null;
  tokenInDecimals: number | null;
  amountInHuman: string | null;
  amountInRaw: string | null;
  tokenOutAddress: string | null;
  tokenOutSymbol: string | null;
  tokenOutDecimals: number | null;
  amountOutHuman: string | null;
  amountOutRaw: string | null;
  executedAmountInHuman: string | null;
  executedAmountInRaw: string | null;
  executedAmountOutHuman: string | null;
  executedAmountOutRaw: string | null;
  usdInEst: string | null;
  usdOutEst: string | null;
  usdFeeEst: string | null;
  usdSource: string | null;
  txHash: string | null;
  fromAddress: string | null;
  nonce: number | null;
  walletAddress: string;
  sessionId: string | null;
  routeProvenance: Record<string, unknown> | null;
  // ── Bridge columns (045) — NULL on swap rows ──
  fromChainId: number | null;
  fromChainSlug: string | null;
  toChainId: number | null;
  toChainSlug: string | null;
  chainFamily: BridgeChainFamily;
  providerOrderId: string | null;
  /** Only present on the logical `bridge_fill_expected` row (family-safe, provider-excluded route key). */
  normalizedRoute: string | null;
  /** Last provider-native status (e.g. Khalani "filled"/"refund_pending", Relay "success"). */
  providerStatus: string | null;
  /** Externally-observed provenance marker (e.g. "khalani_order_status"); NULL on Vex-signed rows. */
  evidenceSource: string | null;
  observedAt: string | null;
  lastAttemptedAt: string | null;
  submitAttemptedAt: string | null;
  broadcastAt: string | null;
  confirmedAt: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Result of a CAS write — `applied:false` means the row was already terminal (or missing); `row` is always the CURRENT state either way. */
export interface CasResult {
  applied: boolean;
  row: AgentActivityEvent;
}

// ── Create ────────────────────────────────────────────────────────

/**
 * Accepts an optional shared `client` so a caller can persist this row in the
 * SAME transaction as the `protocol_executions` intent row it belongs to
 * (plan §11.1 step 1). Prefer `createAgentActivityIntent` below when you are
 * creating the event row(s) for a brand-new execution — it owns that
 * transaction and creates the intent row too.
 */
export async function createPendingActivityEvent(
  input: CreatePendingActivityEventInput,
  client?: PoolClient,
): Promise<AgentActivityEvent> {
  const sql = `INSERT INTO agent_activity (
       protocol_execution_id, event_index, event_role, kind, protocol,
       chain_id, chain_slug, wallet_address, session_id,
       token_in_address, token_in_symbol, token_in_decimals, amount_in_human, amount_in_raw,
       token_out_address, token_out_symbol, token_out_decimals, amount_out_human, amount_out_raw,
       usd_in_est, usd_out_est, usd_fee_est, usd_source, route_provenance
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19,
       $20::numeric, $21::numeric, $22::numeric, $23, $24::jsonb
     ) RETURNING *`;
  const bindParams = [
    input.protocolExecutionId,
    input.eventIndex,
    input.eventRole,
    input.kind,
    input.protocol,
    input.chainId,
    input.chainSlug ?? null,
    input.walletAddress,
    input.sessionId,
    input.tokenIn?.tokenAddress ?? null,
    input.tokenIn?.tokenSymbol ?? null,
    input.tokenIn?.tokenDecimals ?? null,
    input.tokenIn?.amountHuman ?? null,
    input.tokenIn?.amountRaw ?? null,
    input.tokenOut?.tokenAddress ?? null,
    input.tokenOut?.tokenSymbol ?? null,
    input.tokenOut?.tokenDecimals ?? null,
    input.tokenOut?.amountHuman ?? null,
    input.tokenOut?.amountRaw ?? null,
    input.usdInEst ?? null,
    input.usdOutEst ?? null,
    input.usdFeeEst ?? null,
    input.usdSource ?? null,
    nullableJsonb(input.routeProvenance ?? null),
  ];
  const row = client
    ? await queryOneWith<Record<string, unknown>>(client, sql, bindParams)
    : await queryOne<Record<string, unknown>>(sql, bindParams);
  if (!row) {
    throw new Error("agent_activity: insert returned no row");
  }
  return mapRow(row);
}

export interface CreateAgentActivityIntentInput {
  toolId: string;
  namespace: string;
  /** Raw params echo persisted on the protocol_executions intent row — sanitized INSIDE createExecutionIntent, not by the caller. */
  intentParams: Record<string, unknown>;
  /**
   * One-or-more initial event rows (FIX-SPINE C6 — §11.1 always allowed
   * multiple events per execution; round-1 wrongly modeled only one). All
   * events share the SAME `protocolExecutionId` (filled in for you) and
   * MUST use distinct `eventIndex` values (allowance_reset=0, allowance=1,
   * swap=2, or whatever subset applies).
   */
  events: ReadonlyArray<Omit<CreatePendingActivityEventInput, "protocolExecutionId">>;
}

/**
 * Atomically create the `protocol_executions` intent row AND every initial
 * `agent_activity` event row for a brand-new swap execute (plan §11.1 step 1
 * — "atomically create protocol_executions intent row + initial agent_activity
 * event row(s) BEFORE any allowance or swap broadcast"). The execute handler
 * calls this ONCE, before signing anything, then threads the returned
 * `executionId` through its `ToolResult.data._executionId` (see
 * `tools/protocols/runtime/capture.ts`) so post-handler capture reuses the
 * SAME `protocol_executions` row instead of creating a second one.
 */
export async function createAgentActivityIntent(
  input: CreateAgentActivityIntentInput,
): Promise<{ executionId: number; events: AgentActivityEvent[] }> {
  if (input.events.length === 0) {
    throw new Error("agent_activity: createAgentActivityIntent requires at least one event");
  }
  const sessionId = input.events[0]!.sessionId;
  return withTransaction(async (client) => {
    const executionId = await createExecutionIntent(
      input.toolId, input.namespace, sessionId, input.intentParams, client,
    );
    if (executionId <= 0) {
      throw new Error("agent_activity: durable intent insert returned no execution id");
    }
    const events: AgentActivityEvent[] = [];
    for (const eventInput of input.events) {
      const event = await createPendingActivityEvent(
        { ...eventInput, protocolExecutionId: executionId },
        client,
      );
      events.push(event);
    }
    return { executionId, events };
  });
}

/**
 * A pre-broadcast route/validation failure: create AND finalize a hashless
 * `definitively_failed` `swap` event in one step — there was never a signed
 * payload to broadcast, so no CAS staging is needed. `failureReason` is
 * sanitized here (redact + 500-char cap) regardless of what the caller
 * passed. Accepts an optional shared `client` — see
 * `createAgentActivityPreBroadcastFailure` below for the atomic-with-intent-
 * creation entry point most callers want.
 */
export async function recordPreBroadcastFailure(
  input: RecordPreBroadcastFailureInput,
  client?: PoolClient,
): Promise<AgentActivityEvent> {
  assertFailureCode(input.failureCode);
  const sql = `INSERT INTO agent_activity (
       protocol_execution_id, event_index, event_role, kind, protocol,
       chain_id, chain_slug, wallet_address, session_id,
       token_in_address, token_in_symbol, token_in_decimals, amount_in_human, amount_in_raw,
       token_out_address, token_out_symbol, token_out_decimals, amount_out_human, amount_out_raw,
       status, failure_code, failure_reason
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19,
       'definitively_failed', $20, $21
     ) RETURNING *`;
  const bindParams = [
    input.protocolExecutionId,
    input.eventIndex,
    input.eventRole,
    input.kind,
    input.protocol,
    input.chainId,
    input.chainSlug ?? null,
    input.walletAddress,
    input.sessionId,
    input.tokenIn?.tokenAddress ?? null,
    input.tokenIn?.tokenSymbol ?? null,
    input.tokenIn?.tokenDecimals ?? null,
    input.tokenIn?.amountHuman ?? null,
    input.tokenIn?.amountRaw ?? null,
    input.tokenOut?.tokenAddress ?? null,
    input.tokenOut?.tokenSymbol ?? null,
    input.tokenOut?.tokenDecimals ?? null,
    input.tokenOut?.amountHuman ?? null,
    input.tokenOut?.amountRaw ?? null,
    input.failureCode,
    sanitizeFailureReason(input.failureReason),
  ];
  const row = client
    ? await queryOneWith<Record<string, unknown>>(client, sql, bindParams)
    : await queryOne<Record<string, unknown>>(sql, bindParams);
  if (!row) {
    throw new Error("agent_activity: pre-broadcast failure insert returned no row");
  }
  return mapRow(row);
}

export interface CreateAgentActivityPreBroadcastFailureInput {
  toolId: string;
  namespace: string;
  intentParams: Record<string, unknown>;
  event: Omit<RecordPreBroadcastFailureInput, "protocolExecutionId">;
}

/**
 * Atomically create the `protocol_executions` intent row AND a hashless,
 * already-`definitively_failed` `agent_activity` event for a route/validation
 * failure that happened before anything could be signed or broadcast (e.g. a
 * KyberSwap route-not-found quote). Returns `executionId` for the SAME
 * `_executionId` capture-threading contract as `createAgentActivityIntent`.
 */
export async function createAgentActivityPreBroadcastFailure(
  input: CreateAgentActivityPreBroadcastFailureInput,
): Promise<{ executionId: number; event: AgentActivityEvent }> {
  return withTransaction(async (client) => {
    const executionId = await createExecutionIntent(
      input.toolId, input.namespace, input.event.sessionId, input.intentParams, client,
    );
    if (executionId <= 0) {
      throw new Error("agent_activity: durable intent insert returned no execution id");
    }
    const event = await recordPreBroadcastFailure(
      { ...input.event, protocolExecutionId: executionId },
      client,
    );
    return { executionId, event };
  });
}

// ── Staged broadcast persistence ────────────────────────────────────

/**
 * Persist the SIGNED tx hash + from/nonce BEFORE the RPC submit call
 * (§11.1 step 2). CAS-guarded `WHERE status='pending' AND tx_hash IS NULL`
 * (FIX-SPINE C6 — finding 5) — a repair-sweep, a retry, or a duplicate call
 * can NEVER overwrite an already-staged hash; `applied:false` signals the
 * miss instead.
 */
export async function markActivityBroadcast(
  id: number,
  input: MarkActivityBroadcastInput,
): Promise<CasResult> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET tx_hash = $2, from_address = $3, nonce = $4,
            submit_attempted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'pending' AND tx_hash IS NULL
      RETURNING *`,
    [id, input.txHash, input.fromAddress, input.nonce],
  );
  if (row) return { applied: true, row: mapRow(row) };
  return { applied: false, row: await getCurrentRowOrThrow(id, "markActivityBroadcast") };
}

/**
 * Solana staging variant of `markActivityBroadcast` (B1 nonce matrix): a
 * Vex-signed Solana leg stages its base58 SIGNATURE in `tx_hash` (the Khalani
 * API contract carries signatures in the hash field) with `nonce` left NULL —
 * the 045 `agent_activity_solana_no_nonce` CHECK forbids a Solana nonce. The
 * `chain_family='solana'` predicate makes misuse on an EVM row a CAS miss
 * (`applied:false`), never a wrongly-shaped stage.
 */
export async function markActivitySolanaBroadcast(
  id: number,
  input: { readonly txHash: string; readonly fromAddress: string },
): Promise<CasResult> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET tx_hash = $2, from_address = $3,
            submit_attempted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'pending' AND tx_hash IS NULL
        AND chain_family = 'solana'
      RETURNING *`,
    [id, input.txHash, input.fromAddress],
  );
  if (row) return { applied: true, row: mapRow(row) };
  return { applied: false, row: await getCurrentRowOrThrow(id, "markActivitySolanaBroadcast") };
}

/**
 * Stamp `broadcast_at` once the RPC has actually accepted the submission.
 * CAS-guarded `WHERE status='pending' AND tx_hash IS NOT NULL AND
 * broadcast_at IS NULL` (FIX-SPINE C6 — finding 5): cannot run before a hash
 * was staged, cannot run twice.
 */
export async function markBroadcastAccepted(id: number): Promise<CasResult> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET broadcast_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'pending' AND tx_hash IS NOT NULL AND broadcast_at IS NULL
      RETURNING *`,
    [id],
  );
  if (row) return { applied: true, row: mapRow(row) };
  return { applied: false, row: await getCurrentRowOrThrow(id, "markBroadcastAccepted") };
}

// ── CAS finalize ─────────────────────────────────────────────────────

/**
 * `pending -> confirmed`. CAS-guarded; returns `{applied, row}` (FIX-SPINE
 * C7 — finding 6) so a caller (notably the repair sweep, which can race a
 * concurrent finalize) can tell "I just confirmed this" from "this was
 * already confirmed" instead of treating both identically.
 *
 * `event_role='swap'` REQUIRES both executed amounts (FIX-SPINE C8 — finding
 * 3): the row's OWN `event_role` is read first (never trusted from the
 * caller) and validated before the UPDATE is attempted — the DB's
 * `agent_activity_confirmed_swap_has_executed_legs` CHECK is the
 * belt-and-suspenders backstop if this repo function is ever bypassed.
 */
export async function confirmActivityEvent(
  id: number,
  input: ConfirmActivityEventInput,
): Promise<CasResult> {
  const current = await getActivityEventById(id);
  if (!current) {
    throw new Error(`agent_activity: confirmActivityEvent — row ${id} does not exist`);
  }
  if (current.eventRole === "swap"
    && (!input.executedAmountInRaw || !input.executedAmountOutRaw)) {
    throw new Error(
      "agent_activity: confirmActivityEvent — event_role 'swap' requires "
        + "executedAmountInRaw + executedAmountOutRaw",
    );
  }
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW(),
            executed_amount_in_human = $2, executed_amount_in_raw = $3,
            executed_amount_out_human = $4, executed_amount_out_raw = $5
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [
      id,
      input.executedAmountInHuman ?? null,
      input.executedAmountInRaw ?? null,
      input.executedAmountOutHuman ?? null,
      input.executedAmountOutRaw ?? null,
    ],
  );
  if (row) return { applied: true, row: mapRow(row) };
  return { applied: false, row: await getCurrentRowOrThrow(id, "confirmActivityEvent") };
}

/**
 * `pending -> definitively_failed`. CAS-guarded; returns `{applied, row}`
 * (FIX-SPINE C7). `failureReason` is sanitized here (redact + 500-char cap)
 * regardless of what the caller passed (finding 9/C5).
 */
export async function failActivityEvent(
  id: number,
  input: FailActivityEventInput,
): Promise<CasResult> {
  assertFailureCode(input.failureCode);
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET status = 'definitively_failed', failure_code = $2, failure_reason = $3,
            updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id, input.failureCode, sanitizeFailureReason(input.failureReason)],
  );
  if (row) return { applied: true, row: mapRow(row) };
  return { applied: false, row: await getCurrentRowOrThrow(id, "failActivityEvent") };
}

/**
 * Early-plan-abort finalize (FIX2-SPINE C17 — Codex final-review finding
 * 3): when an upstream leg of a multi-event execution reverts or ends
 * ambiguously, every DOWNSTREAM row that is still `pending` AND was NEVER
 * signed (`tx_hash IS NULL`) is CAS-finalized to `definitively_failed` in one
 * sweep. "Not attempted" is itself a definitive outcome — nothing was ever
 * broadcast for these rows — so this does NOT reopen "ambiguity never
 * terminalizes" (C1): that rule protects a row whose OWN signed submission
 * has an uncertain outcome, never a row that was never signed to begin with.
 * A row that already has a `tx_hash` staged is left untouched — its own
 * repair-sweep path (C1/`agent-activity-repair.ts`) owns finalizing it, since
 * ITS submission may still be in flight or mined.
 *
 * Venue handlers call this on EVERY early return (upstream revert/ambiguity)
 * and in the outer catch (§11.1/C18 — the outer catch must finalize existing
 * rows, never create a second execution). `fromIndex` is the first
 * not-yet-attempted `event_index` in the plan; every row at or after it is a
 * candidate. Never throws for "nothing qualified" — returns `[]`.
 *
 * `listPendingOlderThan` can never pick up a row this function is meant to
 * catch in the interim: that sweep query requires `submit_attempted_at IS NOT
 * NULL`, and `submit_attempted_at` is set ONLY by `markActivityBroadcast`
 * (step 2) — a never-signed row has no `submit_attempted_at`, so it is not a
 * repair-sweep candidate regardless of how long it sits `pending` before this
 * function (or a crash) finalizes or abandons it.
 *
 * `toIndexExclusive` (FIX-ROUND-1 blocker 1, granted minimal widening) bounds the
 * abort to `event_index < toIndexExclusive` so a caller can abort never-signed
 * sibling legs WITHOUT terminalizing a higher-indexed row it must leave pending —
 * specifically the logical `bridge_fill_expected` row after an AMBIGUOUS deposit,
 * whose in-flight guard + W4 null-order-id recovery require it to stay `pending`
 * (aborting it would release the guard while the deposit may have landed, enabling
 * a duplicate bridge). Omitted → the bound is a no-op and the range is `>=
 * fromIndex` exactly as before (every existing caller is byte-unaffected). The
 * bound cannot express what the existing `fromIndex`-only range could, and does
 * not touch any CHECK.
 *
 * INT-TEST NOTE (FIX-A → coordinator/W-SPINE): the CAS suite for the bridge repo
 * (`integration/agent-scan/bridge-cas.int.test.ts`) should gain a case proving
 * `abortPlannedEvents(exec, depositIndex+1, reason, expectedFillIndex)` finalizes
 * the never-signed sibling legs while leaving the `bridge_fill_expected` row
 * `pending` (its `event_index === toIndexExclusive` is excluded).
 */
export async function abortPlannedEvents(
  executionId: number,
  fromIndex: number,
  reason: string,
  toIndexExclusive?: number,
): Promise<AgentActivityEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `UPDATE agent_activity
        SET status = 'definitively_failed', failure_code = 'unknown',
            failure_reason = $3, updated_at = NOW()
      WHERE protocol_execution_id = $1 AND event_index >= $2
        AND ($4::int IS NULL OR event_index < $4::int)
        AND status = 'pending' AND tx_hash IS NULL
      RETURNING *`,
    // C17: the stored reason is ALWAYS prefixed "not attempted:" — a single
    // enforcement point, whatever wording the venue caller passed in.
    [executionId, fromIndex, sanitizeFailureReason(`not attempted: ${reason}`), toIndexExclusive ?? null],
  );
  return rows.map(mapRow);
}

/** Repair-sweep bookkeeping — a receipt lookup found nothing new to report yet. */
export async function touchLastChecked(id: number): Promise<void> {
  await execute(
    `UPDATE agent_activity SET last_checked_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
    [id],
  );
}

// ── Reads ─────────────────────────────────────────────────────────

export async function getActivityEventById(id: number): Promise<AgentActivityEvent | null> {
  const row = await queryOne<Record<string, unknown>>(
    "SELECT * FROM agent_activity WHERE id = $1",
    [id],
  );
  return row ? mapRow(row) : null;
}

/**
 * Repair-sweep candidate set: `pending` rows whose signed submit was
 * attempted more than `olderThanMs` ago, oldest first, capped at `limit`
 * rows (FIX-SPINE C11 — finding 12: the repair sweep must never starve
 * balance/Jupiter/Hyperliquid sync by loading an unbounded backlog). A row
 * with no `submit_attempted_at` yet (crash before step 2) is not a
 * candidate — there is no hash to check.
 */
export async function listPendingOlderThan(
  olderThanMs: number,
  limit: number,
): Promise<AgentActivityEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM agent_activity
      WHERE status = 'pending'
        AND submit_attempted_at IS NOT NULL
        AND submit_attempted_at < NOW() - make_interval(secs => $1::float8)
      ORDER BY submit_attempted_at ASC
      LIMIT $2`,
    [olderThanMs / 1000, limit],
  );
  return rows.map(mapRow);
}

export interface ListActivityFeedOptions {
  walletAddresses: string[];
  before?: { createdAt: string; id: number };
  limit: number;
}

/** Keyset-paginated (created_at DESC, id DESC) feed for a wallet set — the Agent Scan read surface. */
export async function listActivityFeed(
  options: ListActivityFeedOptions,
): Promise<AgentActivityEvent[]> {
  if (options.walletAddresses.length === 0) return [];
  const params: unknown[] = [options.walletAddresses, options.limit];
  let cursorClause = "";
  if (options.before) {
    params.push(options.before.createdAt, options.before.id);
    cursorClause = `AND (created_at < $3::timestamptz OR (created_at = $3::timestamptz AND id < $4::bigint))`;
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM agent_activity
      WHERE wallet_address = ANY($1::text[]) ${cursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    params,
  );
  return rows.map(mapRow);
}

/**
 * True iff at least one `agent_activity` row exists for this
 * `protocol_execution_id` — used by the compatibility feed (transactions.ts)
 * to exclude a legacy-failure-half row already represented here (FIX-SPINE
 * C9 — findings 1/2).
 */
export async function existsForExecutionId(protocolExecutionId: number): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM agent_activity WHERE protocol_execution_id = $1) AS exists",
    [protocolExecutionId],
  );
  return row?.exists === true;
}

// ══ Bridge (migration 045) ═══════════════════════════════════════════
//
// Bridges record into the SAME table as swaps (plan §2). The Vex-signed legs
// (allowances + `bridge_deposit`) reuse the swap staging primitives above
// (`markActivityBroadcast` / `markBroadcastAccepted` / `confirmActivityEvent` /
// `failActivityEvent` / `abortPlannedEvents`) verbatim (R4) — the functions
// below add only what a bridge needs that a swap does not: route-scoped intent
// creation with a logical expected-fill row (R2/R5), an in-flight DB guard (C2),
// provider-order-id attachment (B2/C4), externally-observed fill/refund evidence
// (B2/B4), and the R15/C1 pre-broadcast failure shape.
//
// The LOGICAL row is the `bridge_fill_expected` row (marker decision, migration
// 045 header + pinned in bridge int tests). Every feed/dedup/guard keys on it.

/** Route endpoints — feeds the from/to columns AND the family-safe normalized route key. */
export interface BridgeRouteEndpoints {
  readonly fromChainId: number;
  readonly fromChainSlug?: string;
  readonly fromChainFamily: BridgeChainFamily;
  /** Source token — provider-native address/mint (canonicalized into the route key). */
  readonly fromToken: string;
  readonly toChainId: number;
  readonly toChainSlug?: string;
  readonly toChainFamily: BridgeChainFamily;
  /** Destination token — provider-native address/mint. */
  readonly toToken: string;
}

function canonRouteChain(family: BridgeChainFamily, chainId: number): string {
  // Solana's provider-native ids DIVERGE (Khalani 20011000000 vs Relay
  // 792703809) but denote the same chain — collapse to one canonical token so
  // Khalani and Relay collide on the same Solana route (Codex pin). EVM ids are
  // already provider-agnostic.
  return family === "solana" ? "solana" : `eip155:${chainId}`;
}

function canonRouteToken(family: BridgeChainFamily, token: string): string {
  const trimmed = token.trim();
  // EVM addresses are case-insensitive → lowercase; Solana mints are
  // case-SENSITIVE base58 → preserved (same mint across providers).
  return family === "eip155" ? trimmed.toLowerCase() : trimmed;
}

/**
 * The in-flight guard key (C2 + Codex GREEN-LIGHT pin): family-safe, NOT NULL on
 * logical rows, and EXCLUDING provider/protocol so Khalani and Relay cannot race
 * one route into two in-flight bridges. Exported + unit-pinned so the shape is
 * discoverable and cannot drift. Format:
 *   `<fromChainKey>:<fromToken>-><toChainKey>:<toToken>`
 */
export function buildNormalizedBridgeRoute(route: BridgeRouteEndpoints): string {
  return (
    `${canonRouteChain(route.fromChainFamily, route.fromChainId)}`
    + `:${canonRouteToken(route.fromChainFamily, route.fromToken)}`
    + `->${canonRouteChain(route.toChainFamily, route.toChainId)}`
    + `:${canonRouteToken(route.toChainFamily, route.toToken)}`
  );
}

/** A Vex-signed bridge leg (approvals + the origin deposit). Staged/broadcast via the swap CAS primitives (R4). */
export interface BridgeActivityLeg {
  readonly eventIndex: number;
  readonly eventRole: "allowance_reset" | "allowance" | "bridge_deposit";
  /** The leg's OWN execution chain (origin for these Vex-signed legs). */
  readonly chainId: number;
  readonly chainSlug?: string;
  readonly chainFamily: BridgeChainFamily;
  readonly tokenIn?: AgentActivityLegInput;
  readonly tokenOut?: AgentActivityLegInput;
}

/** The single planned logical row (R2). Carries the route amounts + USD estimates. */
export interface BridgeExpectedFill {
  readonly eventIndex: number;
  /** The fill executes on the DESTINATION chain. */
  readonly chainId: number;
  readonly chainSlug?: string;
  readonly chainFamily: BridgeChainFamily;
  /** Requested source leg (what leaves the origin) — quote echo, never a settlement claim. */
  readonly tokenIn?: AgentActivityLegInput;
  /** Requested destination leg (what should arrive) — quote echo. */
  readonly tokenOut?: AgentActivityLegInput;
  readonly usdInEst?: string;
  readonly usdOutEst?: string;
  readonly usdFeeEst?: string;
  readonly usdSource?: string;
}

export interface CreateBridgeActivityIntentInput {
  readonly toolId: string;
  readonly namespace: string;
  /** Provider column value — "khalani" | "relay". */
  readonly protocol: string;
  readonly intentParams: Record<string, unknown>;
  readonly walletAddress: string;
  readonly sessionId: string;
  readonly route: BridgeRouteEndpoints;
  /** Pre-sign correlation persisted on the logical row BEFORE any signing (R5) — quoteId/routeId/requestId. */
  readonly quoteRef?: Record<string, unknown>;
  /** Vex-signed legs (approvals + deposit). May be empty (native deposit, no approval). */
  readonly legs: ReadonlyArray<BridgeActivityLeg>;
  /** Exactly one planned logical row (R2). */
  readonly expectedFill: BridgeExpectedFill;
}

export type CreateBridgeActivityIntentResult =
  | {
      readonly outcome: "created";
      readonly executionId: number;
      readonly legs: AgentActivityEvent[];
      readonly expectedFill: AgentActivityEvent;
    }
  // The DB in-flight guard (C2) rejected a second concurrent execute for the
  // same wallet+session+route — NOTHING was persisted for this attempt. The
  // handler surfaces "a bridge is already in flight for this route".
  | {
      readonly outcome: "in_flight_conflict";
      readonly existing: AgentActivityEvent | null;
    };

const BRIDGE_INFLIGHT_INDEX = "idx_agent_activity_bridge_inflight";

function isUniqueViolation(err: unknown, indexName: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as Record<string, unknown>;
  return record.code === "23505" && record.constraint === indexName;
}

/** Full-column bridge INSERT payload — one private entry point for every bridge row shape. */
interface BridgeRowInsert {
  client: PoolClient;
  protocolExecutionId: number;
  eventIndex: number;
  eventRole: AgentActivityEventRole;
  protocol: string;
  chainId: number;
  chainSlug?: string;
  chainFamily: BridgeChainFamily;
  route: BridgeRouteEndpoints;
  walletAddress: string;
  sessionId: string;
  tokenIn?: AgentActivityLegInput;
  tokenOut?: AgentActivityLegInput;
  usdInEst?: string;
  usdOutEst?: string;
  usdFeeEst?: string;
  usdSource?: string;
  providerOrderId?: string;
  /** Set ONLY on the logical row — the biconditional CHECK enforces this. */
  normalizedRoute?: string;
  providerStatus?: string;
  evidenceSource?: string;
  observedAt?: string;
  status: AgentActivityStatus;
  failureCode?: AgentActivityFailureCode;
  failureReason?: string;
  txHash?: string;
  executedAmountInHuman?: string;
  executedAmountInRaw?: string;
  executedAmountOutHuman?: string;
  executedAmountOutRaw?: string;
  /** Set together with a confirmed status. */
  confirmed?: boolean;
  routeProvenance?: Record<string, unknown>;
}

/**
 * The ONE place a bridge row is inserted. `kind` is always `'bridge'`; the
 * route endpoints are stamped on EVERY row (R1); local submit/broadcast fields
 * are NEVER written here (Vex-signed legs stage those later via
 * `markActivityBroadcast`, provider-observed rows must not have them at all —
 * the 045 observed-no-local-fields CHECK). `failure_reason` is sanitized
 * unconditionally (redact + cap), same repo-boundary contract as the swap path.
 */
async function insertBridgeRow(input: BridgeRowInsert): Promise<AgentActivityEvent> {
  if (input.failureCode) assertFailureCode(input.failureCode);
  const confirmedAtExpr = input.confirmed ? "NOW()" : "NULL";
  const sql = `INSERT INTO agent_activity (
       protocol_execution_id, event_index, event_role, kind, protocol,
       chain_id, chain_slug, chain_family,
       from_chain_id, from_chain_slug, to_chain_id, to_chain_slug,
       wallet_address, session_id,
       token_in_address, token_in_symbol, token_in_decimals, amount_in_human, amount_in_raw,
       token_out_address, token_out_symbol, token_out_decimals, amount_out_human, amount_out_raw,
       usd_in_est, usd_out_est, usd_fee_est, usd_source,
       provider_order_id, normalized_route, provider_status, evidence_source, observed_at,
       status, failure_code, failure_reason,
       tx_hash,
       executed_amount_in_human, executed_amount_in_raw,
       executed_amount_out_human, executed_amount_out_raw,
       confirmed_at, route_provenance
     ) VALUES (
       $1, $2, $3, 'bridge', $4,
       $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13,
       $14, $15, $16, $17, $18,
       $19, $20, $21, $22, $23,
       $24::numeric, $25::numeric, $26::numeric, $27,
       $28, $29, $30, $31, $32::timestamptz,
       $33, $34, $35,
       $36,
       $37, $38,
       $39, $40,
       ${confirmedAtExpr}, $41::jsonb
     ) RETURNING *`;
  const bindParams = [
    input.protocolExecutionId,
    input.eventIndex,
    input.eventRole,
    input.protocol,
    input.chainId,
    input.chainSlug ?? null,
    input.chainFamily,
    input.route.fromChainId,
    input.route.fromChainSlug ?? null,
    input.route.toChainId,
    input.route.toChainSlug ?? null,
    input.walletAddress,
    input.sessionId,
    input.tokenIn?.tokenAddress ?? null,
    input.tokenIn?.tokenSymbol ?? null,
    input.tokenIn?.tokenDecimals ?? null,
    input.tokenIn?.amountHuman ?? null,
    input.tokenIn?.amountRaw ?? null,
    input.tokenOut?.tokenAddress ?? null,
    input.tokenOut?.tokenSymbol ?? null,
    input.tokenOut?.tokenDecimals ?? null,
    input.tokenOut?.amountHuman ?? null,
    input.tokenOut?.amountRaw ?? null,
    input.usdInEst ?? null,
    input.usdOutEst ?? null,
    input.usdFeeEst ?? null,
    input.usdSource ?? null,
    input.providerOrderId ?? null,
    input.normalizedRoute ?? null,
    input.providerStatus ?? null,
    input.evidenceSource ?? null,
    input.observedAt ?? null,
    input.status,
    input.failureCode ?? null,
    input.failureReason === undefined ? null : sanitizeFailureReason(input.failureReason),
    input.txHash ?? null,
    input.executedAmountInHuman ?? null,
    input.executedAmountInRaw ?? null,
    input.executedAmountOutHuman ?? null,
    input.executedAmountOutRaw ?? null,
    nullableJsonb(input.routeProvenance ?? null),
  ];
  const row = await queryOneWith<Record<string, unknown>>(input.client, sql, bindParams);
  if (!row) throw new Error("agent_activity: bridge insert returned no row");
  return mapRow(row);
}

/**
 * Atomically create the `protocol_executions` intent + every Vex-signed leg
 * (pending, hashless — staged later) + EXACTLY ONE planned `bridge_fill_expected`
 * logical row (R2/R5), all BEFORE any signing. The logical row carries the route
 * endpoints, requested amounts, USD estimates, the `normalized_route` in-flight
 * key, and `quoteRef` (quoteId/routeId/requestId) as `route_provenance`.
 *
 * The DB in-flight guard (C2) makes a second concurrent execute for the same
 * wallet+session+route fail-closed: exactly one caller gets `outcome:"created"`,
 * the other gets `outcome:"in_flight_conflict"` with NOTHING persisted (the
 * transaction rolled back) — no duplicate broadcast is possible. Callers SHOULD
 * still call `checkBridgeInFlight` first for a friendly pre-check, but this is
 * the authoritative gate.
 */
export async function createBridgeActivityIntent(
  input: CreateBridgeActivityIntentInput,
): Promise<CreateBridgeActivityIntentResult> {
  const normalizedRoute = buildNormalizedBridgeRoute(input.route);
  try {
    return await withTransaction(async (client) => {
      const executionId = await createExecutionIntent(
        input.toolId, input.namespace, input.sessionId, input.intentParams, client,
      );
      if (executionId <= 0) {
        throw new Error("agent_activity: bridge intent insert returned no execution id");
      }
      const legs: AgentActivityEvent[] = [];
      for (const leg of input.legs) {
        legs.push(await insertBridgeRow({
          client,
          protocolExecutionId: executionId,
          eventIndex: leg.eventIndex,
          eventRole: leg.eventRole,
          protocol: input.protocol,
          chainId: leg.chainId,
          chainSlug: leg.chainSlug,
          chainFamily: leg.chainFamily,
          route: input.route,
          walletAddress: input.walletAddress,
          sessionId: input.sessionId,
          tokenIn: leg.tokenIn,
          tokenOut: leg.tokenOut,
          status: "pending",
        }));
      }
      const expectedFill = await insertBridgeRow({
        client,
        protocolExecutionId: executionId,
        eventIndex: input.expectedFill.eventIndex,
        eventRole: "bridge_fill_expected",
        protocol: input.protocol,
        chainId: input.expectedFill.chainId,
        chainSlug: input.expectedFill.chainSlug,
        chainFamily: input.expectedFill.chainFamily,
        route: input.route,
        walletAddress: input.walletAddress,
        sessionId: input.sessionId,
        tokenIn: input.expectedFill.tokenIn,
        tokenOut: input.expectedFill.tokenOut,
        usdInEst: input.expectedFill.usdInEst,
        usdOutEst: input.expectedFill.usdOutEst,
        usdFeeEst: input.expectedFill.usdFeeEst,
        usdSource: input.expectedFill.usdSource,
        normalizedRoute,
        status: "pending",
        routeProvenance: input.quoteRef,
      });
      return { outcome: "created" as const, executionId, legs, expectedFill };
    });
  } catch (err) {
    if (isUniqueViolation(err, BRIDGE_INFLIGHT_INDEX)) {
      const existing = await findPendingLogicalRow(
        input.walletAddress, input.sessionId, normalizedRoute,
      );
      return { outcome: "in_flight_conflict" as const, existing };
    }
    throw err;
  }
}

/**
 * R15/C1 — a bridge attempt that fails BEFORE anything could be signed (empty
 * routes, an unsupported/rejected Relay step set, a pre-sign validation error):
 * atomically create the intent + a SINGLE hashless, already-`definitively_failed`
 * logical row (no pending legs — no pending artifacts from a rejected plan). A
 * read-only quote miss creates NO row (the handler simply does not call this).
 */
export async function createBridgePreBroadcastFailure(input: {
  readonly toolId: string;
  readonly namespace: string;
  readonly protocol: string;
  readonly intentParams: Record<string, unknown>;
  readonly walletAddress: string;
  readonly sessionId: string;
  readonly route: BridgeRouteEndpoints;
  readonly eventIndex?: number;
  readonly tokenIn?: AgentActivityLegInput;
  readonly tokenOut?: AgentActivityLegInput;
  readonly failureCode: AgentActivityFailureCode;
  readonly failureReason: string;
}): Promise<{ executionId: number; expectedFill: AgentActivityEvent }> {
  assertFailureCode(input.failureCode);
  const normalizedRoute = buildNormalizedBridgeRoute(input.route);
  return withTransaction(async (client) => {
    const executionId = await createExecutionIntent(
      input.toolId, input.namespace, input.sessionId, input.intentParams, client,
    );
    if (executionId <= 0) {
      throw new Error("agent_activity: bridge pre-broadcast intent returned no execution id");
    }
    const expectedFill = await insertBridgeRow({
      client,
      protocolExecutionId: executionId,
      eventIndex: input.eventIndex ?? 0,
      eventRole: "bridge_fill_expected",
      protocol: input.protocol,
      chainId: input.route.toChainId,
      chainSlug: input.route.toChainSlug,
      chainFamily: input.route.toChainFamily,
      route: input.route,
      walletAddress: input.walletAddress,
      sessionId: input.sessionId,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      normalizedRoute,
      status: "definitively_failed",
      failureCode: input.failureCode,
      failureReason: input.failureReason,
    });
    return { executionId, expectedFill };
  });
}

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
  const row = await queryOne<Record<string, unknown>>(
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
  );
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

/** The pending logical row occupying a wallet+session+route in-flight slot, or null. */
async function findPendingLogicalRow(
  walletAddress: string,
  sessionId: string,
  normalizedRoute: string,
): Promise<AgentActivityEvent | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM agent_activity
      WHERE event_role = 'bridge_fill_expected' AND status = 'pending'
        AND wallet_address = $1 AND session_id = $2 AND normalized_route = $3
      LIMIT 1`,
    [walletAddress, sessionId, normalizedRoute],
  );
  return row ? mapRow(row) : null;
}

/** A CAS write missed (row already terminal, or the id genuinely does not exist). */
async function getCurrentRowOrThrow(id: number, caller: string): Promise<AgentActivityEvent> {
  const current = await getActivityEventById(id);
  if (!current) {
    throw new Error(`agent_activity: ${caller} — row ${id} does not exist`);
  }
  return current;
}

function mapRow(r: Record<string, unknown>): AgentActivityEvent {
  return {
    id: Number(r.id),
    protocolExecutionId: Number(r.protocol_execution_id),
    eventIndex: Number(r.event_index),
    eventRole: r.event_role as AgentActivityEventRole,
    recordVersion: Number(r.record_version),
    kind: r.kind as AgentActivityKind,
    protocol: r.protocol as string,
    chainId: Number(r.chain_id),
    chainSlug: r.chain_slug as string | null,
    status: r.status as AgentActivityStatus,
    failureCode: r.failure_code as AgentActivityFailureCode | null,
    failureReason: r.failure_reason as string | null,
    tokenInAddress: r.token_in_address as string | null,
    tokenInSymbol: r.token_in_symbol as string | null,
    tokenInDecimals: r.token_in_decimals === null ? null : Number(r.token_in_decimals),
    amountInHuman: r.amount_in_human as string | null,
    amountInRaw: r.amount_in_raw as string | null,
    tokenOutAddress: r.token_out_address as string | null,
    tokenOutSymbol: r.token_out_symbol as string | null,
    tokenOutDecimals: r.token_out_decimals === null ? null : Number(r.token_out_decimals),
    amountOutHuman: r.amount_out_human as string | null,
    amountOutRaw: r.amount_out_raw as string | null,
    executedAmountInHuman: r.executed_amount_in_human as string | null,
    executedAmountInRaw: r.executed_amount_in_raw as string | null,
    executedAmountOutHuman: r.executed_amount_out_human as string | null,
    executedAmountOutRaw: r.executed_amount_out_raw as string | null,
    usdInEst: r.usd_in_est as string | null,
    usdOutEst: r.usd_out_est as string | null,
    usdFeeEst: r.usd_fee_est as string | null,
    usdSource: r.usd_source as string | null,
    txHash: r.tx_hash as string | null,
    fromAddress: r.from_address as string | null,
    nonce: r.nonce === null || r.nonce === undefined ? null : Number(r.nonce),
    walletAddress: r.wallet_address as string,
    sessionId: r.session_id as string | null,
    routeProvenance: r.route_provenance as Record<string, unknown> | null,
    fromChainId: r.from_chain_id === null || r.from_chain_id === undefined ? null : Number(r.from_chain_id),
    fromChainSlug: r.from_chain_slug as string | null,
    toChainId: r.to_chain_id === null || r.to_chain_id === undefined ? null : Number(r.to_chain_id),
    toChainSlug: r.to_chain_slug as string | null,
    chainFamily: r.chain_family as BridgeChainFamily,
    providerOrderId: r.provider_order_id as string | null,
    normalizedRoute: r.normalized_route as string | null,
    providerStatus: r.provider_status as string | null,
    evidenceSource: r.evidence_source as string | null,
    observedAt: toIsoOrNull(r.observed_at),
    lastAttemptedAt: toIsoOrNull(r.last_attempted_at),
    submitAttemptedAt: toIsoOrNull(r.submit_attempted_at),
    broadcastAt: toIsoOrNull(r.broadcast_at),
    confirmedAt: toIsoOrNull(r.confirmed_at),
    lastCheckedAt: toIsoOrNull(r.last_checked_at),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}
