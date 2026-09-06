/**
 * `token-history-db.ts` connection helpers, chain-identity resolution, and
 * SQL-half builders — split out (Card C5, move-only) once the parent file
 * crossed the repo's 500-line cap. See `token-history-db.ts`'s own module
 * doc for the full source/dedupe/security contract these builders implement.
 * SQL-shape changes stay with this owner and its focused database tests.
 */

import { Client, type ClientConfig } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { SOLANA_CHAIN_ID } from "@shared/chains/display.js";
import { SOLANA_NATIVE_ASSET_IDENTITY } from "@tools/solana-ecosystem/shared/solana-asset-identity.js";
import {
  JUPITER_FEE_SWAP_SETTLEMENT_KIND,
  SOLANA_SETTLEMENT_PROFILE_VERSION,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/settlement-profile.js";
import {
  ACTIVITY_KIND_MAX_LENGTH,
  EVENT_ROLE_MAX_LENGTH,
} from "@shared/agent-activity-vocabulary.js";
import { AGENT_ACTIVITY_LOGICAL_ROW_PREDICATE } from "./agent-activity-logical-row.js";
import { legacyActivityKindSql } from "./legacy-activity-kind.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
/** Outer session-level safety net; the per-transaction `SET LOCAL` below is the real bound. */
const SESSION_STATEMENT_TIMEOUT_MS = 5_000;
export const STATEMENT_TIMEOUT_SQL = "2s";
const STATEMENT_TIMEOUT_SQLSTATE = "57014";

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
  log.warn(`[token-history-db] ${reason}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "portfolio",
    message: "Unable to load token history.",
    retryable: true,
    userActionable: false,
    redacted: true,
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

export async function withClient<T>(
  fn: (client: Client) => Promise<Result<T, VexError>>,
): Promise<Result<T, VexError>> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[token-history-db] buildPoolConfig threw", cause);
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
    statement_timeout: SESSION_STATEMENT_TIMEOUT_MS,
  };
  const client = new Client(clientConfig);
  try {
    await client.connect();
  } catch (cause) {
    log.warn("[token-history-db] client.connect failed", cause);
    return dbUnavailable();
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn("[token-history-db] client.end failed (non-fatal)", cause);
    }
  }
}

export async function rollbackQuietly(client: Client): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (cause) {
    log.warn("[token-history-db] ROLLBACK failed (non-fatal)", cause);
  }
}

// ── Chain identity ──────────────────────────────────────────────────────

/**
 * Free-text `proj_activity.chain` / `wallet_intents.chain_alias` candidates
 * for a numeric chainId (the `agent_activity` arm below needs none of this —
 * it has a real `chain_id` BIGINT column). These columns are NOT FKs to any
 * chain-id table (`activity-populator.ts` writes `_tradeCapture.chain`
 * verbatim). Real emitters use two shapes for the same chain — a curated
 * slug (transcribed from `shared/explorer-links.ts`'s documented alias
 * vocabulary, the repo's existing single source of truth for these exact
 * strings) and the BARE decimal chain id (`relay.bridge`/`khalani.bridge`
 * always emit `chain: String(chainId)`) — so every candidate list carries
 * both. Scoped to the finite chainId set `shared/chains/display.ts` curates
 * (the only ids a click-origin identity can carry); an uncurated chainId
 * still gets the bare-decimal fallback.
 */
const CURATED_CHAIN_ALIASES: ReadonlyMap<number, readonly string[]> = new Map([
  [1, ["ethereum", "mainnet"]],
  [8453, ["base"]],
  [42161, ["arbitrum"]],
  [137, ["polygon"]],
  [10, ["optimism"]],
  [56, ["bsc", "bnb"]],
  [4663, ["robinhood", "robinhood chain", "robinhoodchain", "rhc"]],
]);

export function chainMatchCandidates(chainId: number): readonly string[] {
  if (chainId === SOLANA_CHAIN_ID) return ["solana"];
  const curated = CURATED_CHAIN_ALIASES.get(chainId) ?? [];
  return [...curated, String(chainId)];
}

/**
 * Reverse of `CURATED_CHAIN_ALIASES` (alias → chainId), built once. Used to
 * resolve a STORED display-chain string (`a.chain` / `wi.chain_alias`) back
 * to its numeric chainId for `txRefs[].chainId` — this is NOT always the
 * chainId the read was scoped to: a bridge row can match via its
 * DESTINATION leg while its tx hash lives on the ORIGIN chain (`a.chain`),
 * so the ref's chain must be resolved from the row's own stored chain
 * string, never assumed from the query input.
 */
const CHAIN_ALIAS_TO_ID: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (const [id, aliases] of CURATED_CHAIN_ALIASES) {
    for (const alias of aliases) map.set(alias, id);
  }
  return map;
})();

/**
 * Resolve a stored display-chain string to a numeric chainId for `txRefs`.
 * `0` means "could not resolve" (no real EVM chain uses id 0) — the renderer
 * must treat that as "no link", never guess one.
 */
export function resolveChainIdFromDisplayChain(chain: string): number {
  const normalized = chain.trim().toLowerCase();
  if (normalized === "solana") return SOLANA_CHAIN_ID;
  const curated = CHAIN_ALIAS_TO_ID.get(normalized);
  if (curated !== undefined) return curated;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && Number.isInteger(numeric) ? numeric : 0;
}

// ── Cursor helpers ──────────────────────────────────────────────────────

/** DB-side microsecond-precision UTC render, reused for BOTH arms' `cursor_ts`. */
function cursorTsExpr(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * Per-arm keyset boundary predicate on `(created_at, sourceRank, sourceId)`
 * DESC. `sourceRank` is a literal constant per arm (specialised, not a
 * row-value compare) — mirrors `transactions.ts`'s `keysetPredicate`.
 * Returns "" when there is no cursor (first page).
 */
export function keysetPredicate(
  createdAtColumn: string,
  sourceIdExpr: string,
  sourceRankLiteral: 0 | 1 | 2,
  hasCursor: boolean,
  tsParam: number,
  rankParam: number,
  idParam: number,
): string {
  if (!hasCursor) return "";
  return (
    `AND (${createdAtColumn} < $${tsParam}::timestamptz` +
    ` OR (${createdAtColumn} = $${tsParam}::timestamptz AND ${sourceRankLiteral} < $${rankParam}::int)` +
    ` OR (${createdAtColumn} = $${tsParam}::timestamptz AND ${sourceRankLiteral} = $${rankParam}::int AND ${sourceIdExpr} < $${idParam}::text))`
  );
}

// ── SQL-half builders ────────────────────────────────────────────────────

/** Shared per-half param-index/keyset bundle (mirrors `transactions-query-builder.ts`'s `HalfKeysetParams`). */
export interface ActivityHalfParams {
  readonly walletsParam: number;
  readonly chainAliasesParam: number;
  readonly addressParam: number;
  readonly addr: (column: string) => string;
  readonly activityKeyset: string;
}

/**
 * A legacy row carries no pinned native-versus-wrapped provenance. A SOL_MINT
 * leg therefore gets no local-symbol enrichment rather than guessing either
 * the native or wSOL balance row. Every unambiguous token passes through.
 */
function legacyProjectedBalanceAddressSql(tokenExpression: string): string {
  return `CASE WHEN ${tokenExpression} = '${SOLANA_NATIVE_ASSET_IDENTITY.routeMint}'`
    + " THEN NULL"
    + ` ELSE ${tokenExpression} END`;
}

const JUPITER_SETTLEMENT_SQL = "aa.route_provenance->'settlement'";

/**
 * SQL predicate for the versioned fields that decide one Jupiter leg's
 * native-versus-wrapped identity. Every value used by the CASE is type-checked
 * before comparison. Unrelated profile fields do not affect this decision.
 */
function validatedJupiterLegProfileSql(
  tokenExpression: string,
  mintField: "inputMint" | "outputMint",
): string {
  return [
    `jsonb_typeof(${JUPITER_SETTLEMENT_SQL}) = 'object'`,
    `jsonb_typeof(${JUPITER_SETTLEMENT_SQL}->'v') = 'number'`,
    `${JUPITER_SETTLEMENT_SQL}->'v' = '${SOLANA_SETTLEMENT_PROFILE_VERSION}'::jsonb`,
    `jsonb_typeof(${JUPITER_SETTLEMENT_SQL}->'kind') = 'string'`,
    `${JUPITER_SETTLEMENT_SQL}->>'kind' = '${JUPITER_FEE_SWAP_SETTLEMENT_KIND}'`,
    `jsonb_typeof(${JUPITER_SETTLEMENT_SQL}->'${mintField}') = 'string'`,
    `${JUPITER_SETTLEMENT_SQL}->>'${mintField}' = ${tokenExpression}`,
    `jsonb_typeof(${JUPITER_SETTLEMENT_SQL}->'wrapAndUnwrapSol') = 'boolean'`,
  ].join(" AND ");
}

/**
 * Map a SOL_MINT leg only when its own validated settlement profile identifies
 * the spendability domain. `true` means transient native SOL and selects the
 * database-only native key. `false` means durable wSOL and keeps the mint.
 * Missing, malformed or mismatched provenance yields no local enrichment.
 */
function agentProjectedBalanceAddressSql(
  tokenExpression: string,
  mintField: "inputMint" | "outputMint",
): string {
  const profileIsValid = validatedJupiterLegProfileSql(tokenExpression, mintField);
  return `CASE WHEN ${tokenExpression} <> '${SOLANA_NATIVE_ASSET_IDENTITY.routeMint}'`
    + ` THEN ${tokenExpression}`
    + ` WHEN (${profileIsValid}) THEN CASE`
    + ` WHEN ${JUPITER_SETTLEMENT_SQL}->'wrapAndUnwrapSol' = 'true'::jsonb`
    + ` THEN '${SOLANA_NATIVE_ASSET_IDENTITY.persistedAddress}'`
    + ` ELSE '${SOLANA_NATIVE_ASSET_IDENTITY.routeMint}' END`
    + " ELSE NULL END";
}

export function buildActivityHalf(p: ActivityHalfParams): string {
  const { walletsParam, chainAliasesParam, addressParam, addr, activityKeyset } = p;
  return `
      SELECT
        'activity'::text AS source_kind,
        1 AS source_rank,
        lpad(a.id::text, 20, '0') AS source_id,
        a.created_at,
        ${cursorTsExpr("a.created_at")} AS cursor_ts,
        a.namespace,
        a.product_type,
        a.trade_side,
        a.chain,
        CASE WHEN a.product_type = 'bridge' THEN a.meta->>'destChain' ELSE NULL END AS dest_chain,
        COALESCE(NULLIF(ci.trade_capture->>'inputTokenAddress', ''), a.input_token) AS input_token_address,
        a.input_amount,
        COALESCE(NULLIF(ci.trade_capture->>'outputTokenAddress', ''), a.output_token) AS output_token_address,
        a.output_amount,
        a.input_value_usd,
        a.output_value_usd,
        a.unit_price_usd,
        a.capture_status,
        COALESCE(a.external_refs->>'txHash', a.external_refs->>'signature') AS tx_ref,
        CASE
          WHEN jsonb_typeof(ci.trade_capture->'inputToken') = 'string'
           AND char_length(ci.trade_capture->>'inputToken') BETWEEN 1 AND 64
          THEN LEFT(ci.trade_capture->>'inputToken', 64)
          ELSE NULL
        END AS input_token_symbol,
        (SELECT LEFT(MIN(b.token_symbol), 64)
           FROM proj_balances b
          WHERE b.wallet_address = a.wallet_address
            AND b.token_address = ${legacyProjectedBalanceAddressSql("a.input_token")}
            AND b.token_symbol IS NOT NULL
         HAVING COUNT(DISTINCT b.token_symbol) = 1) AS input_token_local_symbol,
        CASE
          WHEN jsonb_typeof(ci.trade_capture->'outputToken') = 'string'
           AND char_length(ci.trade_capture->>'outputToken') BETWEEN 1 AND 64
          THEN LEFT(ci.trade_capture->>'outputToken', 64)
          ELSE NULL
        END AS output_token_symbol,
        (SELECT LEFT(MIN(b.token_symbol), 64)
           FROM proj_balances b
          WHERE b.wallet_address = a.wallet_address
            AND b.token_address = ${legacyProjectedBalanceAddressSql("a.output_token")}
            AND b.token_symbol IS NOT NULL
         HAVING COUNT(DISTINCT b.token_symbol) = 1) AS output_token_local_symbol,
        NULL::text AS to_address,
        NULL::text AS status,
        NULL::text AS failure_code,
        NULL::text AS executed_amount_in_raw,
        NULL::text AS executed_amount_out_raw,
        NULL::smallint AS token_in_decimals,
        NULL::smallint AS token_out_decimals,
        NULL::text AS provider_order_id,
        NULL::jsonb AS legs,
        NULL::timestamptz AS last_checked_at,
        -- Canonical vocabulary DERIVED from the legacy product type, so a
        -- historical bridge keeps its meaning once the UI stops reading
        -- product_type. event_role has no legacy counterpart: NULL, never
        -- invented.
        ${legacyActivityKindSql("a.product_type")} AS activity_kind,
        NULL::text AS event_role
      FROM proj_activity a
      LEFT JOIN protocol_capture_items ci
        ON ci.id = a.capture_item_id AND ci.execution_id = a.execution_id
      WHERE a.wallet_address = ANY($${walletsParam}::text[])
        AND (
          (
            lower(trim(a.chain)) = ANY($${chainAliasesParam}::text[])
            AND ${addr("COALESCE(NULLIF(ci.trade_capture->>'inputTokenAddress', ''), a.input_token)")} = $${addressParam}
          )
          OR
          (
            lower(trim(CASE WHEN a.product_type = 'bridge' THEN COALESCE(a.meta->>'destChain', a.chain) ELSE a.chain END)) = ANY($${chainAliasesParam}::text[])
            AND ${addr("COALESCE(NULLIF(ci.trade_capture->>'outputTokenAddress', ''), a.output_token)")} = $${addressParam}
          )
        )
        -- Defensive dedupe (mirrors the engine feed's own belt-and-suspenders
        -- posture, module header): a no-op today — capture:"none" on the
        -- unified swap.execute handlers means this execution id can never
        -- also have an agent_activity row — but guards against a future
        -- capture-matrix change silently double-surfacing one execution.
        AND NOT EXISTS (
          SELECT 1 FROM agent_activity aa2
           WHERE aa2.protocol_execution_id = a.execution_id
        )
        ${activityKeyset}`;
}

export interface IntentHalfParams {
  readonly walletsParam: number;
  readonly networkParam: number;
  readonly chainAliasesParam: number;
  readonly addressParam: number;
  readonly addr: (column: string) => string;
  readonly intentKeyset: string;
}

export function buildIntentHalf(p: IntentHalfParams): string {
  const { walletsParam, networkParam, chainAliasesParam, addressParam, addr, intentKeyset } = p;
  return `
      SELECT
        'intent'::text AS source_kind,
        0 AS source_rank,
        wi.intent_id AS source_id,
        wi.created_at,
        ${cursorTsExpr("wi.created_at")} AS cursor_ts,
        NULL::text AS namespace,
        NULL::text AS product_type,
        NULL::text AS trade_side,
        wi.chain_alias AS chain,
        NULL::text AS dest_chain,
        NULL::text AS input_token_address,
        NULL::text AS input_amount,
        wi.token AS output_token_address,
        wi.amount AS output_amount,
        NULL::numeric AS input_value_usd,
        NULL::numeric AS output_value_usd,
        NULL::numeric AS unit_price_usd,
        wi.status AS capture_status,
        wi.tx_hash AS tx_ref,
        NULL::text AS input_token_symbol,
        NULL::text AS input_token_local_symbol,
        NULL::text AS output_token_symbol,
        NULL::text AS output_token_local_symbol,
        wi.to_address,
        NULL::text AS status,
        NULL::text AS failure_code,
        NULL::text AS executed_amount_in_raw,
        NULL::text AS executed_amount_out_raw,
        NULL::smallint AS token_in_decimals,
        NULL::smallint AS token_out_decimals,
        NULL::text AS provider_order_id,
        NULL::jsonb AS legs,
        NULL::timestamptz AS last_checked_at,
        -- This arm produces a transfer ENTRY, which carries no vocabulary
        -- field today; the columns exist only so the UNION arms line up.
        NULL::text AS activity_kind,
        NULL::text AS event_role
      FROM wallet_intents wi
      WHERE wi.wallet_address = ANY($${walletsParam}::text[])
        AND wi.status = 'executed'
        AND wi.tx_hash IS NOT NULL
        AND wi.network = $${networkParam}
        AND lower(trim(wi.chain_alias)) = ANY($${chainAliasesParam}::text[])
        AND ${addr("wi.token")} = $${addressParam}
        ${intentKeyset}`;
}

export interface AgentActivityHalfParams {
  readonly walletsParam: number;
  readonly chainIdParam: number;
  readonly addressParam: number;
  readonly addr: (column: string) => string;
  readonly agentActivityKeyset: string;
}

// agent_activity half (Agent Scan plan §4.1/§4.7 + Phase 2 bridges + W5
// migration 049 lend/prediction): surfaces a SWAP row (`event_role =
// 'swap'`) OR a bridge's LOGICAL row (`event_role = 'bridge_fill_expected'`,
// migration 045) OR any `kind IN ('lend','prediction')` row — allowance/
// deposit/observed-fill/refund rows (kind='swap'/'bridge' only) are
// execution detail carried only inside `legs`. `product_type` derives
// from `kind`. Match is EXACT (real BIGINT `chain_id` + real token
// address columns, no free-text dance):
//  - a SWAP or a lend/prediction row matches its single `chain_id` (W5
//    design R5: token_in/out_address must be a REAL token mint — the
//    deposit/withdraw mint or the prediction settlement mint — NEVER a
//    position/market pubkey; that contract is the write side's, K5/K6);
//  - a BRIDGE matches LEG-AWARE — the origin leg (`from_chain_id` +
//    `token_in_address`) OR the destination leg (`to_chain_id` +
//    `token_out_address`) — because a bridge's two legs live on DIFFERENT
//    chains (mirrors the leg-aware match on the legacy `proj_activity`
//    half). For a bridge, `chain` is the ORIGIN and `dest_chain` the
//    destination (route endpoints), while the per-leg hashes ride `legs`.
// `status` collapses the DB's 3-value enum here; `input_amount`/
// `output_amount` are the quote-time REQUESTED echo — the JS mapper
// (`agentActivityAmountField` C20 for swap/lend/prediction /
// `resolveAmountWithEstimateBasis` Q2/R5 for bridges) decides what to
// show. `legs` (jsonb_agg, NO LIMIT — OWNER RULE) aggregates every
// sibling leg of a bridge execution; lend/prediction rows have no such
// multi-leg shape (one role per on-chain tx), so `legs` stays absent/`[]`
// for them, same as a plain swap.
export function buildAgentActivityHalf(p: AgentActivityHalfParams): string {
  const { walletsParam, chainIdParam, addressParam, addr, agentActivityKeyset } = p;
  return `
      SELECT
        'agent_activity'::text AS source_kind,
        2 AS source_rank,
        lpad(aa.id::text, 20, '0') AS source_id,
        aa.created_at,
        ${cursorTsExpr("aa.created_at")} AS cursor_ts,
        aa.protocol AS namespace,
        CASE aa.kind
          WHEN 'bridge' THEN 'bridge'
          WHEN 'lend' THEN 'lend'
          WHEN 'prediction' THEN 'prediction'
          WHEN 'yield' THEN 'yield'
          -- A launch is NOT a spot trade (migration 062). Folding it into the
          -- ELSE would assert a route, a price and a counterparty a token
          -- creation never had — 051's documented mistake, for wrap.
          WHEN 'launch' THEN 'launch'
          ELSE 'spot'
        END AS product_type,
        NULL::text AS trade_side,
        CASE WHEN aa.kind = 'bridge'
          THEN COALESCE(aa.from_chain_slug, aa.from_chain_id::text)
          ELSE COALESCE(aa.chain_slug, aa.chain_id::text) END AS chain,
        CASE WHEN aa.kind = 'bridge'
          THEN COALESCE(aa.to_chain_slug, aa.to_chain_id::text)
          ELSE NULL END AS dest_chain,
        aa.token_in_address AS input_token_address,
        aa.amount_in_human AS input_amount,
        aa.token_out_address AS output_token_address,
        aa.amount_out_human AS output_amount,
        aa.usd_in_est AS input_value_usd,
        aa.usd_out_est AS output_value_usd,
        NULL::numeric AS unit_price_usd,
        NULL::text AS capture_status,
        aa.tx_hash AS tx_ref,
        aa.token_in_symbol AS input_token_symbol,
        (SELECT LEFT(MIN(b.token_symbol), 64)
           FROM proj_balances b
          WHERE b.wallet_address = aa.wallet_address
            AND b.token_address = ${agentProjectedBalanceAddressSql("aa.token_in_address", "inputMint")}
            AND b.token_symbol IS NOT NULL
         HAVING COUNT(DISTINCT b.token_symbol) = 1) AS input_token_local_symbol,
        aa.token_out_symbol AS output_token_symbol,
        (SELECT LEFT(MIN(b.token_symbol), 64)
           FROM proj_balances b
          WHERE b.wallet_address = aa.wallet_address
            AND b.token_address = ${agentProjectedBalanceAddressSql("aa.token_out_address", "outputMint")}
            AND b.token_symbol IS NOT NULL
         HAVING COUNT(DISTINCT b.token_symbol) = 1) AS output_token_local_symbol,
        NULL::text AS to_address,
        CASE aa.status
          WHEN 'definitively_failed' THEN 'failed'
          ELSE aa.status
        END AS status,
        aa.failure_code,
        aa.executed_amount_in_raw,
        aa.executed_amount_out_raw,
        aa.token_in_decimals,
        aa.token_out_decimals,
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
        -- R12: last SUCCESSFUL sweep check of a pending bridge's order status
        -- (surfaced on the DTO for bridge logical rows only in the mapper).
        aa.last_checked_at,
        -- The REAL canonical vocabulary — unlike product_type above, which
        -- folds swap/wrap into 'spot'. Clamped to the DTO bounds so a
        -- future vocabulary value can never fail output validation and blank
        -- the screen.
        LEFT(aa.kind, ${ACTIVITY_KIND_MAX_LENGTH}) AS activity_kind,
        LEFT(aa.event_role, ${EVENT_ROLE_MAX_LENGTH}) AS event_role
      FROM agent_activity aa
      WHERE aa.wallet_address = ANY($${walletsParam}::text[])
        -- Shared positive allow-list: approvals, fees and future technical
        -- roles stay execution detail instead of becoming history entries.
        AND ${AGENT_ACTIVITY_LOGICAL_ROW_PREDICATE}
        AND (
          (
            -- A launch matches the ordinary single-chain, first-leg shape: the
            -- native msg.value in, the newly created token out. No second-leg
            -- arm is needed — migration 053's constraint 5 bars token_launch
            -- from the Option-C columns, so they are always NULL here.
            (aa.event_role = 'swap' OR aa.kind IN ('lend', 'prediction', 'launch'))
            AND aa.chain_id = $${chainIdParam}::bigint
            AND (
              ${addr("aa.token_in_address")} = $${addressParam}
              OR ${addr("aa.token_out_address")} = $${addressParam}
            )
          )
          OR
          (
            -- YIELD (migration 053). Single-chain like a swap, but the
            -- Option-C second-leg columns are part of the row's IDENTITY:
            -- a py.mint is 1 -> 2 (PT AND YT out) and a pre-expiry
            -- py.redeem is 2 -> 1. Matching only the first leg would hide
            -- the mint from the SECOND output token's own history — the
            -- instrument the user is most likely looking at. The *2
            -- columns are constrained to yield_py/yield_lp (migration
            -- 053 constraint 5), so they are NULL — and this arm is a
            -- no-op — for every other role.
            aa.event_role IN (
              'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_claim'
            )
            AND aa.chain_id = $${chainIdParam}::bigint
            AND (
              ${addr("aa.token_in_address")} = $${addressParam}
              OR ${addr("aa.token_out_address")} = $${addressParam}
              OR ${addr("aa.token_in2_address")} = $${addressParam}
              OR ${addr("aa.token_out2_address")} = $${addressParam}
            )
          )
          OR
          (
            aa.event_role = 'bridge_fill_expected'
            AND (
              (aa.from_chain_id = $${chainIdParam}::bigint AND ${addr("aa.token_in_address")} = $${addressParam})
              OR (aa.to_chain_id = $${chainIdParam}::bigint AND ${addr("aa.token_out_address")} = $${addressParam})
            )
          )
        )
        ${agentActivityKeyset}`;
}
