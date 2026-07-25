/**
 * `moves-db.ts` connection + SQL-half builders — split out (Card C5,
 * move-only) once the parent file crossed the repo's 500-line cap. See
 * `moves-db.ts`'s own module doc for the full source/dedupe/security contract
 * these builders implement; every SQL string here is byte-identical to the
 * original single-file version.
 */

import { Client, type ClientConfig } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { MOVE_TOKEN_SYMBOL_MAX } from "@shared/schemas/portfolio-moves.js";
import { getSessionWalletScope } from "./sessions-db.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

// `correlationId` intentionally omitted; `registerHandler` stamps
// `ctx.requestId` downstream. Domain is `portfolio` (MOVES reuses the
// portfolio VexDomain — no separate `moves` domain). Mirrors `portfolio-db.ts`.
export function dbUnavailable(): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "portfolio",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
  });
}

export function dbError(reason: string, cause?: unknown): Result<never, VexError> {
  log.warn(`[moves-db] ${reason}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "portfolio",
    message: "Unable to load moves.",
    retryable: true,
    userActionable: false,
    redacted: true,
  });
}

export async function withClient<T>(
  fn: (client: Client) => Promise<Result<T, VexError>>,
): Promise<Result<T, VexError>> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[moves-db] buildPoolConfig threw", cause);
    return dbUnavailable();
  }
  if (cfg === null) return dbUnavailable();

  const clientConfig: ClientConfig = {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  };
  const client = new Client(clientConfig);
  try {
    await client.connect();
  } catch (cause) {
    log.warn("[moves-db] client.connect failed", cause);
    return dbUnavailable();
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn("[moves-db] client.end failed (non-fatal)", cause);
    }
  }
}

/**
 * Resolve the session's wallet address allow-list (raw strings, NO lowercasing
 * so the `proj_activity.wallet_address` filter matches the engine's stored
 * form). A failed scope read propagates as an error (fail closed); an empty
 * scope resolves to `[]` (→ empty DTO before SQL).
 */
export async function resolveSessionAddresses(
  sessionId: string,
): Promise<Result<readonly string[], VexError>> {
  const scope = await getSessionWalletScope(sessionId);
  if (!scope.ok) return scope;
  const addrs = [scope.data.evm?.address, scope.data.solana?.address].filter(
    (a): a is string => typeof a === "string",
  );
  return ok([...new Set(addrs)]);
}

// STRICT PER-SESSION attribution. INNER JOIN protocol_executions on
// execution_id and filter session_id = $2:
//  - the INNER JOIN drops rows with a NULL execution_id (never a session);
//  - session_id = $2 drops rows whose execution belongs to another
//    session OR carries a NULL session_id (both comparisons evaluate to
//    UNKNOWN → excluded). Fail-closed: externally-detected / historical
//    activity without a matching session execution never leaks in.
// The wallet_address filter is KEPT as defense-in-depth (never omitted).
// Columns are qualified with the `a` alias because proj_activity and
// protocol_executions share `id`, `created_at`, and `external_refs`.
// The LEFT JOIN to protocol_capture_items resolves the EXACT capture
// item for this activity row (batch captures produce N items per
// execution) — both `capture_item_id` AND `execution_id` must match,
// so a row can never pick up a sibling execution's capture item. The
// symbol CASE expressions extract ONLY string-typed, length-bounded
// scalars from `trade_capture`; the raw JSONB itself never leaves SQL.
// The two `input_token_local_symbol`/`output_token_local_symbol` scalar
// AGGREGATE subqueries resolve a FALLBACK display symbol from THIS
// WALLET's own `proj_balances` (used when the capture item recorded no
// symbol — legacy raw-address rows). Each is a single bounded value per
// row (no JOIN fan-out) AND deterministic: `MIN(...)` guarded by
// `HAVING COUNT(DISTINCT token_symbol) = 1` declines when the same
// address carries different symbols across chains — see the docblock.
// NOT EXISTS (agent_activity …) is the defensive dedupe guard described
// in the module header — a no-op today (capture:"none" means the two
// sources never share an execution id) but mirrors the engine feed's
// own belt-and-suspenders posture.
export function buildLegacyMovesHalf(): string {
  return `
        SELECT a.id,
               a.trade_side,
               a.product_type,
               a.namespace AS venue,
               a.input_token,
               CASE
                 WHEN jsonb_typeof(ci.trade_capture->'inputToken') = 'string'
                  AND char_length(ci.trade_capture->>'inputToken')
                      BETWEEN 1 AND ${MOVE_TOKEN_SYMBOL_MAX}
                 THEN LEFT(ci.trade_capture->>'inputToken', ${MOVE_TOKEN_SYMBOL_MAX})
                 ELSE NULL
               END AS input_token_symbol,
               (SELECT LEFT(MIN(b.token_symbol), ${MOVE_TOKEN_SYMBOL_MAX})
                  FROM proj_balances b
                 WHERE b.wallet_address = a.wallet_address
                   AND b.token_address = a.input_token
                   AND b.token_symbol IS NOT NULL
                HAVING COUNT(DISTINCT b.token_symbol) = 1)
                 AS input_token_local_symbol,
               a.input_amount,
               a.output_token,
               CASE
                 WHEN jsonb_typeof(ci.trade_capture->'outputToken') = 'string'
                  AND char_length(ci.trade_capture->>'outputToken')
                      BETWEEN 1 AND ${MOVE_TOKEN_SYMBOL_MAX}
                 THEN LEFT(ci.trade_capture->>'outputToken', ${MOVE_TOKEN_SYMBOL_MAX})
                 ELSE NULL
               END AS output_token_symbol,
               (SELECT LEFT(MIN(b.token_symbol), ${MOVE_TOKEN_SYMBOL_MAX})
                  FROM proj_balances b
                 WHERE b.wallet_address = a.wallet_address
                   AND b.token_address = a.output_token
                   AND b.token_symbol IS NOT NULL
                HAVING COUNT(DISTINCT b.token_symbol) = 1)
                 AS output_token_local_symbol,
               a.output_amount,
               a.value_usd,
               a.capture_status,
               a.instrument_key,
               a.chain,
               COALESCE(a.external_refs->>'txHash', a.external_refs->>'signature')
                 AS tx_ref,
               a.wallet_address,
               a.created_at,
               'success'::text AS source,
               NULL::text AS status,
               NULL::text AS failure_code,
               NULL::text AS executed_amount_in_raw,
               NULL::text AS executed_amount_out_raw,
               NULL::smallint AS token_in_decimals,
               NULL::smallint AS token_out_decimals,
               NULL::text AS from_chain,
               NULL::text AS to_chain,
               NULL::text AS provider_order_id,
               NULL::jsonb AS legs,
               NULL::timestamptz AS last_checked_at
          FROM proj_activity a
          JOIN protocol_executions e ON e.id = a.execution_id
          LEFT JOIN protocol_capture_items ci
            ON ci.id = a.capture_item_id
           AND ci.execution_id = a.execution_id
         WHERE a.wallet_address = ANY($1::text[])
           AND e.session_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM agent_activity aa
              WHERE aa.protocol_execution_id = e.id
           )`;
}

// agent_activity half: the swap row (`event_role = 'swap'`) OR a bridge's
// LOGICAL row (`event_role = 'bridge_fill_expected'`, migration 045) OR
// any `lend`/`prediction` row (migration 049, W5 — every event_role
// under those kinds is its own standalone move: unlike EVM swaps,
// Solana has no allowance legs, so there is no sub-event to exclude) —
// allowance_reset/allowance/deposit/observed-fill/refund rows (kind=
// 'swap' or 'bridge' only) are execution detail, surfaced only inside
// `legs` (below), never as their own ledger row. `product_type` derives
// from `kind` ('bridge' → the BRIDGE chip; 'lend'/'prediction' → their
// own chips; else 'spot'). For a bridge logical row `chain` is the
// leg's OWN execution chain (the DESTINATION, where the fill hash lives,
// so `explorerTxUrl(chain, tx_ref)` resolves), while `from_chain`/
// `to_chain` carry the route endpoints for from→to display.
// `input_amount`/`output_amount` here are ONLY the quote-time REQUESTED
// echo — the JS mapper decides per-row whether to show that or the
// raw-computed EXECUTED amount (never COALESCE'd in SQL):
// `resolveAgentActivityAmount` for plain swaps (C20, blank when
// unproven), `resolveAmountWithEstimateBasis` for bridges (Q2) AND
// lend/prediction (W5 design R3/R5 — a confirmed row lacking
// decoder-proven executed data falls back to the quote, labelled
// `amountBasis: "estimated"`, rather than going blank). `status`
// collapses the 3-value DB enum to `pending | confirmed | failed` here
// so the JS mapper stays a plain pass-through. `legs` aggregates EVERY
// sibling leg of a bridge execution (deposit/allowances/the canonical
// expected fill/extra fills/refunds) — NEVER truncated (OWNER RULE):
// jsonb_agg has no LIMIT. `lend`/`prediction` rows have no analogous
// multi-leg shape (one role per on-chain tx — design §1), so `legs`
// stays `[]` for them, same as a plain swap.
export function buildAgentActivityMovesHalf(): string {
  return `
        SELECT aa.id,
               NULL::text AS trade_side,
               CASE aa.kind
                 WHEN 'bridge' THEN 'bridge'
                 WHEN 'lend' THEN 'lend'
                 WHEN 'prediction' THEN 'prediction'
                 ELSE 'spot'
               END AS product_type,
               aa.protocol AS venue,
               aa.token_in_address AS input_token,
               aa.token_in_symbol AS input_token_symbol,
               NULL::text AS input_token_local_symbol,
               aa.amount_in_human AS input_amount,
               aa.token_out_address AS output_token,
               aa.token_out_symbol AS output_token_symbol,
               NULL::text AS output_token_local_symbol,
               aa.amount_out_human AS output_amount,
               COALESCE(aa.usd_out_est, aa.usd_in_est) AS value_usd,
               NULL::text AS capture_status,
               NULL::text AS instrument_key,
               COALESCE(aa.chain_slug, aa.chain_id::text) AS chain,
               aa.tx_hash AS tx_ref,
               aa.wallet_address,
               aa.created_at,
               'agent_activity'::text AS source,
               CASE aa.status
                 WHEN 'definitively_failed' THEN 'failed'
                 ELSE aa.status
               END AS status,
               aa.failure_code,
               aa.executed_amount_in_raw,
               aa.executed_amount_out_raw,
               aa.token_in_decimals,
               aa.token_out_decimals,
               CASE WHEN aa.kind = 'bridge'
                 THEN COALESCE(aa.from_chain_slug, aa.from_chain_id::text) END AS from_chain,
               CASE WHEN aa.kind = 'bridge'
                 THEN COALESCE(aa.to_chain_slug, aa.to_chain_id::text) END AS to_chain,
               aa.provider_order_id,
               CASE WHEN aa.kind = 'bridge' THEN (
                 SELECT jsonb_agg(jsonb_build_object(
                   'role', leg.event_role,
                   'chainId', leg.chain_id,
                   'chainFamily', leg.chain_family,
                   'txHash', leg.tx_hash,
                   'status', CASE leg.status WHEN 'definitively_failed' THEN 'failed' ELSE leg.status END,
                   'failureCode', leg.failure_code
                 ) ORDER BY leg.event_index)
                 FROM agent_activity leg
                 WHERE leg.protocol_execution_id = aa.protocol_execution_id
               ) END AS legs,
               -- R12: last SUCCESSFUL sweep check of a pending bridge's order
               -- status (surfaced for bridge logical rows only in the mapper).
               aa.last_checked_at
          FROM agent_activity aa
         WHERE aa.wallet_address = ANY($1::text[])
           AND aa.session_id = $2
           AND (
             aa.event_role = 'swap'
             OR aa.event_role = 'bridge_fill_expected'
             OR aa.kind IN ('lend', 'prediction')
           )`;
}
