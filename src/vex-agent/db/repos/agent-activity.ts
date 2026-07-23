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

import { execute, queryOne, queryOneWith, query, withTransaction } from "../client.js";
import { nullableJsonb } from "../params.js";
import { createExecutionIntent } from "./executions.js";
import { redact } from "../../../lib/diagnostics/text-redaction.js";

// ── Types ─────────────────────────────────────────────────────────

export type AgentActivityEventRole = "allowance_reset" | "allowance" | "swap";
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
  | "unknown";

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
  kind: "swap";
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
 */
export async function abortPlannedEvents(
  executionId: number,
  fromIndex: number,
  reason: string,
): Promise<AgentActivityEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `UPDATE agent_activity
        SET status = 'definitively_failed', failure_code = 'unknown',
            failure_reason = $3, updated_at = NOW()
      WHERE protocol_execution_id = $1 AND event_index >= $2
        AND status = 'pending' AND tx_hash IS NULL
      RETURNING *`,
    // C17: the stored reason is ALWAYS prefixed "not attempted:" — a single
    // enforcement point, whatever wording the venue caller passed in.
    [executionId, fromIndex, sanitizeFailureReason(`not attempted: ${reason}`)],
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

// ── Internal helpers ─────────────────────────────────────────────────

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
    kind: r.kind as "swap",
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
