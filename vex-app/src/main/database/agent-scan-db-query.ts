/**
 * `agent-scan-db.ts` connection helpers, filter compilation and the page SQL
 * builder. See `agent-scan-db.ts`'s module doc for the source / scope /
 * pagination contract these builders implement.
 *
 * The connection helpers mirror `token-history-db-query.ts` rather than being
 * shared with it — the established per-feed pattern in this directory, so each
 * feed owns its own log prefix and its own user-facing failure message. (A
 * third copy lived in the MOVES feed until that pipeline was retired; two
 * near-identical copies remain a real extraction candidate, deliberately NOT
 * done here because touching the live feed's connection path is not this
 * change's job.)
 *
 * FILTERS COMPILE TO BOUND PARAMETERS ONLY. Not one filter value is ever
 * interpolated into SQL text: each is pushed onto the parameter array and
 * referenced positionally. The filter schema caps array lengths and string
 * sizes, so the compiled predicate list is finite by construction.
 *
 * THE STATUS FILTER IS TRANSLATED, NOT PASSED THROUGH. The renderer speaks
 * `pending | confirmed | failed`; the table stores `pending | confirmed |
 * definitively_failed`. The SELECT collapses one way and this filter expands
 * the other. Forgetting either direction is silent: a `failed` filter would
 * match zero rows forever, and the page would look empty rather than broken.
 */

import { Client, type ClientConfig } from "pg";
import { err, type Result, type VexError } from "@shared/ipc/result.js";
import {
  AGENT_SCAN_PAGE_SIZE,
  AGENT_SCAN_TEXT_BOUNDS,
  type AgentScanCursor,
  type AgentScanFilters,
  type AgentScanStatusFilter,
} from "@shared/schemas/agent-scan-feed.js";
import {
  ACTIVITY_KIND_MAX_LENGTH,
  DB_DEFINITIVELY_FAILED_STATUS,
  EVENT_ROLE_MAX_LENGTH,
} from "@shared/agent-activity-vocabulary.js";
import { TOKEN_SYMBOL_MAX_LENGTH } from "@shared/token-symbol-sanitizer.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
/** Outer session-level safety net; the per-transaction `SET LOCAL` is the real bound. */
const SESSION_STATEMENT_TIMEOUT_MS = 5_000;
export const STATEMENT_TIMEOUT_SQL = "2s";
const STATEMENT_TIMEOUT_SQLSTATE = "57014";

// ── Result helpers ────────────────────────────────────────────────────────
//
// `correlationId` is threaded in from the handler's `ctx.requestId` rather than
// omitted. The sibling feeds omit it and rely on `registerHandler` to stamp one
// downstream, which works at runtime but leaves their error literals failing the
// `VexError` contract (they are recorded in `type-baseline.json` for exactly
// that). Passing the real request id costs one parameter, keeps this module off
// the baseline, and means the redacted `log.warn` below and the error the
// renderer receives carry the SAME id — which is the entire point of the field.

export function dbUnavailable(correlationId: string): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "portfolio",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

export function dbError(
  correlationId: string,
  reason: string,
  cause?: unknown,
): Result<never, VexError> {
  log.warn(`[agent-scan-db] ${reason} correlationId=${correlationId}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "portfolio",
    message: "Unable to load agent activity.",
    retryable: true,
    userActionable: false,
    redacted: true,
    correlationId,
  });
}

export function isStatementTimeout(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === STATEMENT_TIMEOUT_SQLSTATE
  );
}

// ── Connection ────────────────────────────────────────────────────────────

export async function withClient<T>(
  correlationId: string,
  fn: (client: Client) => Promise<Result<T, VexError>>,
): Promise<Result<T, VexError>> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[agent-scan-db] buildPoolConfig threw", cause);
    return dbUnavailable(correlationId);
  }
  if (cfg === null) return dbUnavailable(correlationId);

  const clientConfig: ClientConfig = {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: SESSION_STATEMENT_TIMEOUT_MS,
  };
  const client = new Client(clientConfig);
  try {
    await client.connect();
  } catch (cause) {
    log.warn("[agent-scan-db] client.connect failed", cause);
    return dbUnavailable(correlationId);
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn("[agent-scan-db] client.end failed (non-fatal)", cause);
    }
  }
}

export async function rollbackQuietly(client: Client): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (cause) {
    log.warn("[agent-scan-db] ROLLBACK failed (non-fatal)", cause);
  }
}

// ── Status vocabulary translation ─────────────────────────────────────────

/**
 * Renderer vocabulary → STORED vocabulary. Exhaustive switch (no fallback) so
 * adding a member to the filter enum without deciding its stored counterpart
 * is a compile error, not a silently-empty page.
 */
function toStoredStatus(status: AgentScanStatusFilter): string {
  switch (status) {
    case "pending":
      return "pending";
    case "confirmed":
      return "confirmed";
    case "failed":
      return DB_DEFINITIVELY_FAILED_STATUS;
    // Stored under its own name and NOT collapsed — the SELECT's `ELSE
    // aa.status` carries it through unchanged, so the two directions agree.
    case "superseded_unproven":
      return "superseded_unproven";
  }
}

export function toStoredStatuses(
  statuses: readonly AgentScanStatusFilter[],
): readonly string[] {
  return statuses.map(toStoredStatus);
}

// ── Page query ────────────────────────────────────────────────────────────

export interface AgentScanQueryPlan {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface AgentScanQueryArgs {
  /** Server-resolved inventory allow-list. NEVER caller-supplied, never omitted. */
  readonly wallets: readonly string[];
  readonly filters: AgentScanFilters;
  readonly cursor: AgentScanCursor | null;
}

/** DB-side microsecond-precision UTC render — the keyset cursor's `createdAt`. */
const CURSOR_TS_EXPR = `to_char(aa.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Which rows are their execution's LOGICAL row (owner decision): the swap row,
 * a bridge's `bridge_fill_expected` marker, and every row of the kinds that
 * have no sub-events at all. `wrap` is included FROM DAY ONE — migration
 * 051:129-135 warns that all three pre-existing surfaces map it through
 * `ELSE 'spot'` or omit it, so a wrap is written correctly and is then either
 * invisible or displayed as a spot trade. This feed does neither.
 *
 * `launch` (migration 062) joins FROM DAY ONE for the same reason. A Trench
 * token creation is one transaction with one `token_launch` row, so it is its
 * own logical row; its prebuy is a LEG of that row, deliberately not a second
 * `swap` row for the same tx hash. Omitting `launch` here would make the whole
 * launch capability invisible in Agent Scan — the one surface the owner asked
 * every action to appear on.
 *
 * `yield` (migration 053) joins for the third time on the same evidence: every
 * Pendle mutation writes a receipt-truth `kind = 'yield'` row and every one of
 * them was invisible here. Each yield role is one on-chain tx, so each is its
 * own logical row — spelled as the kind MINUS the two approval roles rather
 * than as a role list, so a seventh yield role added by a later migration is
 * visible on the day it is written.
 *
 * Excluded: `allowance` / `allowance_reset` (approval plumbing) and a bridge's
 * deposit/fee/observed-fill/refund legs — all of which ride the logical row's
 * `legs` array instead of appearing as their own ledger entries.
 *
 * Also excluded, on EVERY kind: the three Vex-fee leg roles (OWNER REVISION
 * 2026-08-05, supersedes the earlier "the fee leg renders as its own row
 * everywhere except the agent view"). A `trench_fee` on a launch execution is
 * stored with `kind = 'launch'`, so the kind arm above used to admit it and the
 * feed rendered a bare "LAUNCH-FEE 0.0000031675 ETH → —" entry above the launch
 * it belonged to. The charge is not a separate user action; it surfaces on its
 * parent's row through the `vexFee*` fields projected by VEX_FEE_LATERALS below.
 * `event_role` is NOT NULL (migration 044:59), so the leading NOT IN can never
 * make the whole predicate NULL and swallow a row.
 */
const LOGICAL_ROW_PREDICATE = `(
          aa.event_role NOT IN ('bridge_fee', 'swap_fee', 'trench_fee')
          AND (
            aa.event_role = 'swap'
            OR aa.event_role = 'bridge_fill_expected'
            OR aa.kind IN ('lend', 'prediction', 'wrap', 'launch', 'claim')
            OR (aa.kind = 'yield' AND aa.event_role NOT IN ('allowance', 'allowance_reset'))
          )
        )`;

/**
 * THE VEX FEE FROM ITS SEPARATE LEG, projected onto the logical row (R1 Step 2b)
 * — a READ projection that writes nothing, so the documented
 * `SUM(usd_vex_fee_est) WHERE status='confirmed'` revenue invariant is
 * byte-unaffected.
 *
 * Since the OWNER REVISION of 2026-08-05 no fee leg is its own ledger entry here
 * (see `LOGICAL_ROW_PREDICATE`), so this is the ONLY place the charge is visible on
 * this surface and it projects unconditionally. The former "and only if that leg
 * is not already its own row" guard was the exact predicate that is now false for
 * every fee role, and is deleted rather than kept as a tautology.
 *
 * A9 — a confirmed fee whose PARENT FAILED stays visible: the sibling arm gates
 * on `fee.status = 'confirmed'` only, never on `aa.status`, so the failed launch
 * row still reports the fee that was really charged. Only the OWN-ROW arm is
 * gated on `aa.status = 'confirmed'`, because those columns are written at intent
 * time and the row's own status is what says whether that fee was collected.
 *
 * ONE SOURCE WINS WHOLE, and the anomalies FAIL CLOSED — two confirmed fee legs
 * on one execution, or an own-row fee beside a confirmed sibling, report NO
 * exact fee at all. Reporting one exact-looking fee while knowingly omitting
 * another is a money field stating less than the truth.
 */
const VEX_FEE_LATERALS = `
      LEFT JOIN LATERAL (
        SELECT fee.token_in_symbol                                        AS vex_fee_token_symbol,
               COALESCE(fee.executed_amount_in_human, fee.amount_in_human) AS vex_fee_amount_human,
               COALESCE(fee.executed_amount_in_raw,   fee.amount_in_raw)   AS vex_fee_amount_raw,
               fee.usd_vex_fee_est                                        AS usd_vex_fee_est,
               count(*) OVER ()                                           AS fee_leg_count
          FROM agent_activity fee
         WHERE fee.protocol_execution_id = aa.protocol_execution_id
           AND fee.id        <> aa.id
           AND fee.event_role IN ('bridge_fee','swap_fee','trench_fee')
           AND fee.status     = 'confirmed'
         ORDER BY fee.event_index ASC
         LIMIT 1
      ) fee_leg ON TRUE
      LEFT JOIN LATERAL (
        SELECT (aa.vex_fee_amount_raw IS NOT NULL AND aa.status = 'confirmed')  AS own_ok,
               (fee_leg.vex_fee_amount_raw IS NOT NULL
                AND fee_leg.fee_leg_count = 1)                                  AS sibling_ok
      ) fee_flags ON TRUE
      LEFT JOIN LATERAL (
        SELECT CASE
                 WHEN fee_flags.own_ok AND fee_flags.sibling_ok THEN NULL
                 WHEN fee_flags.own_ok THEN 'in_transaction'
                 WHEN fee_flags.sibling_ok THEN 'separate_leg'
               END::text AS vex_fee_source
      ) fee_pick ON TRUE`;

/**
 * Every sibling leg of a BRIDGE execution, ordered by `event_index`. No LIMIT
 * (OWNER RULE: feed output is never truncated). Non-bridge kinds have no
 * multi-leg shape — one role per on-chain tx — so `legs` stays null for them,
 * exactly as `token-history-db-query.ts` does.
 */
const LEGS_EXPR = `CASE WHEN aa.kind = 'bridge' THEN (
          SELECT jsonb_agg(jsonb_build_object(
            'role', leg.event_role,
            'chainId', leg.chain_id,
            'chainFamily', leg.chain_family,
            'chainSlug', leg.chain_slug,
            'txHash', leg.tx_hash,
            'status', CASE leg.status WHEN 'definitively_failed' THEN 'failed' ELSE leg.status END,
            'failureCode', leg.failure_code
          ) ORDER BY leg.event_index)
          FROM agent_activity leg
          WHERE leg.protocol_execution_id = aa.protocol_execution_id
        ) END`;

export function buildAgentScanPageQuery(args: AgentScanQueryArgs): AgentScanQueryPlan {
  const { wallets, filters, cursor } = args;
  const params: unknown[] = [];
  const push = (value: unknown): number => {
    params.push(value);
    return params.length;
  };

  // $1 is the wallet allow-list, always, before any optional predicate.
  const walletsParam = push([...wallets]);

  const predicates: string[] = [];

  if (filters.kinds !== undefined && filters.kinds.length > 0) {
    predicates.push(`AND aa.kind = ANY($${push([...filters.kinds])}::text[])`);
  }
  if (filters.statuses !== undefined && filters.statuses.length > 0) {
    const stored = toStoredStatuses(filters.statuses);
    predicates.push(`AND aa.status = ANY($${push([...stored])}::text[])`);
  }
  if (filters.protocols !== undefined && filters.protocols.length > 0) {
    predicates.push(`AND aa.protocol = ANY($${push([...filters.protocols])}::text[])`);
  }
  if (filters.chainFamily !== undefined) {
    predicates.push(`AND aa.chain_family = $${push(filters.chainFamily)}`);
  }
  // NARROWS the read. The wallet allow-list above is unconditional, so this can
  // only ever remove rows from an already-scoped set — never add any.
  if (filters.sessionId !== undefined) {
    predicates.push(`AND aa.session_id = $${push(filters.sessionId)}`);
  }

  if (cursor !== null) {
    const tsParam = push(cursor.createdAt);
    // Compared as a BIGINT, not text: `id` is a BIGSERIAL, and a lexicographic
    // compare would order "9" after "10" and drop rows from the next page.
    const idParam = push(cursor.sourceId);
    predicates.push(
      `AND (aa.created_at < $${tsParam}::timestamptz` +
        ` OR (aa.created_at = $${tsParam}::timestamptz AND aa.id < $${idParam}::bigint))`,
    );
  }

  const limitParam = push(AGENT_SCAN_PAGE_SIZE + 1);

  const sql = `
      SELECT
        aa.id::text AS source_id,
        aa.created_at,
        ${CURSOR_TS_EXPR} AS cursor_ts,
        LEFT(aa.kind, ${ACTIVITY_KIND_MAX_LENGTH}) AS activity_kind,
        LEFT(aa.event_role, ${EVENT_ROLE_MAX_LENGTH}) AS event_role,
        CASE aa.status WHEN 'definitively_failed' THEN 'failed' ELSE aa.status END AS status,
        LEFT(aa.protocol, ${AGENT_SCAN_TEXT_BOUNDS.protocol}) AS protocol,
        aa.chain_id,
        LEFT(aa.chain_family, ${AGENT_SCAN_TEXT_BOUNDS.chainFamily}) AS chain_family,
        LEFT(aa.chain_slug, ${AGENT_SCAN_TEXT_BOUNDS.chainSlug}) AS chain_slug,
        aa.from_chain_id,
        LEFT(aa.from_chain_slug, ${AGENT_SCAN_TEXT_BOUNDS.chainSlug}) AS from_chain_slug,
        aa.to_chain_id,
        LEFT(aa.to_chain_slug, ${AGENT_SCAN_TEXT_BOUNDS.chainSlug}) AS to_chain_slug,
        LEFT(aa.token_in_address, ${AGENT_SCAN_TEXT_BOUNDS.tokenAddress}) AS token_in_address,
        LEFT(aa.token_in_symbol, ${TOKEN_SYMBOL_MAX_LENGTH}) AS token_in_symbol,
        aa.token_in_decimals,
        aa.amount_in_human,
        aa.amount_in_raw,
        aa.executed_amount_in_human,
        aa.executed_amount_in_raw,
        aa.usd_in_est,
        LEFT(aa.token_out_address, ${AGENT_SCAN_TEXT_BOUNDS.tokenAddress}) AS token_out_address,
        LEFT(aa.token_out_symbol, ${TOKEN_SYMBOL_MAX_LENGTH}) AS token_out_symbol,
        aa.token_out_decimals,
        aa.amount_out_human,
        aa.amount_out_raw,
        aa.executed_amount_out_human,
        aa.executed_amount_out_raw,
        aa.usd_out_est,
        aa.usd_fee_est,
        -- O-7: the renderer prints this beside the "Vex fee" label, but
        -- aa.usd_fee_est is migration 050's DEPRECATED mixed-meaning column
        -- (network gas on a Kyber row, the VENUE's fee on a Jupiter one). The
        -- label may only be fed from vex_fee provenance, so it now reads the
        -- projected Vex-fee USD and nothing else.
        CASE fee_pick.vex_fee_source
          WHEN 'in_transaction' THEN aa.usd_vex_fee_est
          WHEN 'separate_leg' THEN fee_leg.usd_vex_fee_est
        END AS vex_fee_usd_est,
        -- All fee fields switch on the SAME discriminator: one source wins
        -- whole, so a mixed tuple is unrepresentable.
        CASE fee_pick.vex_fee_source
          WHEN 'in_transaction' THEN LEFT(aa.vex_fee_token_symbol, ${TOKEN_SYMBOL_MAX_LENGTH})
          WHEN 'separate_leg' THEN LEFT(fee_leg.vex_fee_token_symbol, ${TOKEN_SYMBOL_MAX_LENGTH})
        END AS vex_fee_token_symbol,
        CASE fee_pick.vex_fee_source
          WHEN 'in_transaction' THEN aa.vex_fee_amount_human
          WHEN 'separate_leg' THEN fee_leg.vex_fee_amount_human
        END AS vex_fee_amount_human,
        fee_pick.vex_fee_source,
        LEFT(aa.failure_code, ${AGENT_SCAN_TEXT_BOUNDS.failureCode}) AS failure_code,
        LEFT(aa.failure_reason, ${AGENT_SCAN_TEXT_BOUNDS.failureReason}) AS failure_reason,
        LEFT(aa.tx_hash, ${AGENT_SCAN_TEXT_BOUNDS.txRef}) AS tx_hash,
        LEFT(aa.provider_order_id, ${AGENT_SCAN_TEXT_BOUNDS.providerOrderId}) AS provider_order_id,
        aa.last_checked_at,
        aa.verification_attempts,
        LEFT(aa.last_verification_reason, ${AGENT_SCAN_TEXT_BOUNDS.failureReason}) AS last_verification_reason,
        LEFT(aa.pending_reason, ${AGENT_SCAN_TEXT_BOUNDS.failureReason}) AS pending_reason,
        ${LEGS_EXPR} AS legs
      FROM agent_activity aa
      ${VEX_FEE_LATERALS}
      WHERE aa.wallet_address = ANY($${walletsParam}::text[])
        AND ${LOGICAL_ROW_PREDICATE}
        ${predicates.join("\n        ")}
      ORDER BY aa.created_at DESC, aa.id DESC
      LIMIT $${limitParam}`;

  return { sql, params };
}
