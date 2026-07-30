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
 * W5 (design `w5-design.md` §3, migration 049): this generic write path is
 * now also the entry point for `kind: 'lend'`/`'prediction'` rows (K5/K6
 * handlers), not just `'swap'` — `kind` widened from a literal `"swap"` to
 * `AgentActivityGenericKind` (`Exclude<AgentActivityKind, "bridge">`; bridge
 * keeps its own dedicated `./bridge-intent.js` API). `chainFamily` was added
 * for the same reason: this table's `chain_family` column defaults to
 * `'eip155'`, so a caller that never set it (every EVM swap caller, unchanged)
 * keeps getting that default, but a Solana `lend`/`prediction` row MUST pass
 * `chainFamily: 'solana'` explicitly — the 049 `agent_activity_kind_family_
 * binding` CHECK rejects `kind IN ('lend','prediction')` with any other family.
 *
 * Sanitization at the repo boundary (finding 9/C5): `failure_reason` passes
 * `redact()` + a hard 500-char cap here, ALWAYS — callers cannot bypass it by
 * pre-sanitizing. `intentParams` sanitization (secret-shape scrub + 8KiB cap)
 * lives in `executions.ts`'s `createExecutionIntent` (the actual
 * `protocol_executions.params` boundary, shared with Hyperliquid).
 *
 * `record_version` is fixed at 1 for every row this phase; reserved for a
 * future non-backward-compatible reshape without needing a new table.
 *
 * Steps 2-4 of this write protocol (staged broadcast, CAS finalize, repair-
 * sweep reads) live in the sibling `./swap-lifecycle.js` — split out of this
 * file for size (W0-A, move-only). This file owns step 1: pre-broadcast
 * intent creation, plus the pre-broadcast-failure shortcut.
 */

import type { PoolClient } from "pg";

import { queryOne, queryOneWith, withTransaction } from "../../client.js";
import { nullableJsonb } from "../../params.js";
import { createExecutionIntent } from "../executions.js";
import { acquireSessionControlLock } from "../../../engine/runtime/lease-and-status/session-control-lock.js";

import { assertFailureCode, sanitizeFailureReason } from "./validation.js";
import { mapRow } from "./mappers.js";
import type {
  AgentActivityEvent,
  AgentActivityEventRole,
  AgentActivityGenericKind,
  AgentActivityLegInput,
  AgentActivityFailureCode,
  AgentActivityVexFeeCharge,
  BridgeChainFamily,
} from "./types.js";

// ── Types (swap-only inputs) ─────────────────────────────────────────

export interface CreatePendingActivityEventInput {
  protocolExecutionId: number;
  eventIndex: number;
  eventRole: AgentActivityEventRole;
  kind: AgentActivityGenericKind;
  protocol: string;
  chainId: number;
  chainSlug?: string;
  /**
   * Chain-family discriminator (045). Omitted → `'eip155'` (every existing
   * EVM swap caller is unaffected). W5 (design REVISION 1 R1, migration 049):
   * `kind IN ('lend','prediction')` rows MUST pass `'solana'` explicitly — the
   * `agent_activity_kind_family_binding` CHECK rejects the default otherwise.
   */
  chainFamily?: BridgeChainFamily;
  walletAddress: string;
  sessionId: string;
  tokenIn?: AgentActivityLegInput;
  tokenOut?: AgentActivityLegInput;
  /**
   * Option-C SECOND legs (migration 053). Valid ONLY on `eventRole`
   * `'yield_py'`/`'yield_lp'` — `agent_activity_second_leg_roles_only` rejects
   * them anywhere else, and `agent_activity_yield_py_has_one_second_leg`
   * requires a `yield_py` row to populate EXACTLY one side (mint splits 1→PT+YT
   * so it carries `tokenOut2`; a pre-expiry redeem burns PT+YT→1 so it carries
   * `tokenIn2`). Populating both sides, or neither, is a shape no Pendle action
   * produces and the DB refuses it.
   */
  tokenIn2?: AgentActivityLegInput;
  tokenOut2?: AgentActivityLegInput;
  usdInEst?: string;
  /**
   * DEPRECATED (migration 050) — the mixed-meaning column. Keep dual-writing it
   * with the SAME value the writer used before 050 so old readers are
   * unaffected; put the honest figure in the four fields below. A later
   * contract migration drops it.
   */
  usdFeeEst?: string;
  /** Network gas only (USD) — not part of `tx.value`. Include the L1 data fee where the chain has one. */
  usdNetworkGasEst?: string;
  /** The VENUE's own protocol fee (USD). Never gas, never the Vex fee. */
  usdVenueFeeEst?: string;
  /** Destination-chain execution prepay (USD). */
  usdDestinationPrepayEst?: string;
  /** Vex's OWN integrator fee (USD) — set only on the row whose on-chain outcome decides whether it was collected. Omit rather than guess. */
  usdVexFeeEst?: string;
  /**
   * Vex's OWN integrator fee in TOKEN units — the exact amount taken (migration
   * 050 Part 2). Set it on EVERY row of an in-transaction venue that charges
   * one, whether or not `usdVexFeeEst` could be derived: that is what makes a
   * null USD mean "price unknown" instead of "no fee". Omitting it on a row
   * that did charge a fee reintroduces exactly the ambiguity it exists to end.
   */
  vexFee?: AgentActivityVexFeeCharge;
  usdOutEst?: string;
  usdSource?: string;
  routeProvenance?: Record<string, unknown>;
}

export interface RecordPreBroadcastFailureInput {
  protocolExecutionId: number;
  eventIndex: number;
  eventRole: AgentActivityEventRole;
  kind: AgentActivityGenericKind;
  protocol: string;
  chainId: number;
  chainSlug?: string;
  /** See `CreatePendingActivityEventInput.chainFamily` — same default, same W5 requirement. */
  chainFamily?: BridgeChainFamily;
  walletAddress: string;
  sessionId: string;
  tokenIn?: AgentActivityLegInput;
  tokenOut?: AgentActivityLegInput;
  /**
   * Option-C SECOND legs (migration 053) — same role binding as
   * `CreatePendingActivityEventInput.tokenIn2`/`tokenOut2`. A refusal states
   * them WHENEVER it knows them: a `py.mint` refused on a price floor knows
   * both minted instruments from the quote, and dropping the YT would make the
   * failed row narrower than the succeeded one for no reason.
   *
   * They stay optional because a PY refusal often fires BEFORE the second
   * instrument is resolvable (an unresolved market is the commonest refusal,
   * and the YT address is exactly what that resolution failed to produce) —
   * `agent_activity_yield_py_has_one_second_leg` exempts precisely this
   * hashless `definitively_failed` shape.
   */
  tokenIn2?: AgentActivityLegInput;
  tokenOut2?: AgentActivityLegInput;
  failureCode: AgentActivityFailureCode;
  failureReason: string;
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
       chain_id, chain_slug, chain_family, wallet_address, session_id,
       token_in_address, token_in_symbol, token_in_decimals, amount_in_human, amount_in_raw,
       token_out_address, token_out_symbol, token_out_decimals, amount_out_human, amount_out_raw,
       usd_in_est, usd_out_est, usd_fee_est,
       usd_network_gas_est, usd_venue_fee_est, usd_destination_prepay_est, usd_vex_fee_est,
       vex_fee_token_address, vex_fee_token_symbol, vex_fee_token_decimals,
       vex_fee_amount_raw, vex_fee_amount_human,
       usd_source, route_provenance,
       token_in2_address, token_in2_symbol, token_in2_decimals, amount_in2_human, amount_in2_raw,
       token_out2_address, token_out2_symbol, token_out2_decimals, amount_out2_human, amount_out2_raw
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15,
       $16, $17, $18, $19, $20,
       $21::numeric, $22::numeric, $23::numeric,
       $24::numeric, $25::numeric, $26::numeric, $27::numeric,
       $28, $29, $30,
       $31, $32,
       $33, $34::jsonb,
       $35, $36, $37, $38, $39,
       $40, $41, $42, $43, $44
     ) RETURNING *`;
  const bindParams = [
    input.protocolExecutionId,
    input.eventIndex,
    input.eventRole,
    input.kind,
    input.protocol,
    input.chainId,
    input.chainSlug ?? null,
    input.chainFamily ?? "eip155",
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
    input.usdNetworkGasEst ?? null,
    input.usdVenueFeeEst ?? null,
    input.usdDestinationPrepayEst ?? null,
    input.usdVexFeeEst ?? null,
    // All five move together: a fee amount without its decimals is unreadable,
    // so the row records the whole charge or none of it.
    input.vexFee?.tokenAddress ?? null,
    input.vexFee?.tokenSymbol ?? null,
    input.vexFee?.tokenDecimals ?? null,
    input.vexFee?.amountRaw ?? null,
    input.vexFee?.amountHuman ?? null,
    input.usdSource ?? null,
    nullableJsonb(input.routeProvenance ?? null),
    input.tokenIn2?.tokenAddress ?? null,
    input.tokenIn2?.tokenSymbol ?? null,
    input.tokenIn2?.tokenDecimals ?? null,
    input.tokenIn2?.amountHuman ?? null,
    input.tokenIn2?.amountRaw ?? null,
    input.tokenOut2?.tokenAddress ?? null,
    input.tokenOut2?.tokenSymbol ?? null,
    input.tokenOut2?.tokenDecimals ?? null,
    input.tokenOut2?.amountHuman ?? null,
    input.tokenOut2?.amountRaw ?? null,
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
    // Session control lock FIRST — this transaction ADDS rows to the set the
    // compaction safe-moment gate reads (`protocol_executions` at `intent`,
    // `agent_activity` at `pending`). That is the direction that matters most:
    // without the lock the gate could read `clear` a microsecond before this
    // money state came into existence, and authorise a transcript rewrite over
    // a broadcast about to happen. DB-only and short — every signing and
    // broadcast call happens AFTER this transaction commits.
    await acquireSessionControlLock(client, sessionId);

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
       chain_id, chain_slug, chain_family, wallet_address, session_id,
       token_in_address, token_in_symbol, token_in_decimals, amount_in_human, amount_in_raw,
       token_out_address, token_out_symbol, token_out_decimals, amount_out_human, amount_out_raw,
       token_in2_address, token_in2_symbol, token_in2_decimals, amount_in2_human, amount_in2_raw,
       token_out2_address, token_out2_symbol, token_out2_decimals, amount_out2_human, amount_out2_raw,
       status, failure_code, failure_reason
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15,
       $16, $17, $18, $19, $20,
       $21, $22, $23, $24, $25,
       $26, $27, $28, $29, $30,
       'definitively_failed', $31, $32
     ) RETURNING *`;
  const bindParams = [
    input.protocolExecutionId,
    input.eventIndex,
    input.eventRole,
    input.kind,
    input.protocol,
    input.chainId,
    input.chainSlug ?? null,
    input.chainFamily ?? "eip155",
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
    input.tokenIn2?.tokenAddress ?? null,
    input.tokenIn2?.tokenSymbol ?? null,
    input.tokenIn2?.tokenDecimals ?? null,
    input.tokenIn2?.amountHuman ?? null,
    input.tokenIn2?.amountRaw ?? null,
    input.tokenOut2?.tokenAddress ?? null,
    input.tokenOut2?.tokenSymbol ?? null,
    input.tokenOut2?.tokenDecimals ?? null,
    input.tokenOut2?.amountHuman ?? null,
    input.tokenOut2?.amountRaw ?? null,
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
    // Session control lock FIRST — this transaction ADDS rows to the set the
    // compaction safe-moment gate reads (`protocol_executions` at `intent`,
    // `agent_activity` at `pending`). That is the direction that matters most:
    // without the lock the gate could read `clear` a microsecond before this
    // money state came into existence, and authorise a transcript rewrite over
    // a broadcast about to happen. DB-only and short — every signing and
    // broadcast call happens AFTER this transaction commits.
    await acquireSessionControlLock(client, input.event.sessionId);

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
