/**
 * Token history DB helper — read-only, global-scope per-token TX history
 * (chronos-shell). Mirrors `portfolio-db.ts` / `moves-db.ts`: own `pg.Client`
 * per call, no `@vex-agent/db/repos/*` import. Reads the same local `vex`
 * Postgres the engine writes to.
 *
 * SOURCES (UNIONed, keyset-paginated):
 *  (a) `proj_activity` — the wallet's success-only activity feed. A row
 *      matches when EITHER leg's token+chain identity equals the requested
 *      `(chainId, tokenAddress)`. Matching is LEG-AWARE because a bridge
 *      row's two legs can be on DIFFERENT chains: the INPUT leg is always on
 *      `proj_activity.chain` (the origin — both `relay.bridge` and
 *      `khalani.bridge` write `chain: String(originChainId)`, read-only
 *      reference: `tools/protocols/relay/handlers/bridge.ts`,
 *      `tools/protocols/khalani/handlers/bridge.ts`, root `src/`, NOT
 *      imported — the trust boundary forbids it), while the OUTPUT leg for a
 *      `product_type = 'bridge'` row is on `meta->>'destChain'` (both bridge
 *      handlers copy `{ sourceChain, destChain }` into `_tradeCapture.meta`,
 *      which `activity-populator.ts`'s `captureMeta` copies verbatim onto
 *      `proj_activity.meta`) — for every other product type the output leg
 *      shares the row's own `chain`. Bridge legs are recorded SYMBOL-first
 *      (`activity-populator.ts`'s `preferSymbolLegs`), so the AUTHORITATIVE
 *      address for matching/display is resolved via a `protocol_capture_items
 *      .trade_capture->>'{input,output}TokenAddress'` join (the same join key
 *      `moves-db.ts` already uses), falling back to the projected column when
 *      the JSONB field is absent.
 *  (b) `wallet_intents` — EXECUTED (`status='executed' AND tx_hash IS NOT
 *      NULL`) outbound sends, matched by ADDRESS ONLY: `token` is free-text,
 *      model-supplied (never validated at write time — see
 *      `tools/internal/wallet/send/validation.ts`, root `src/`, read-only
 *      reference), so a row whose `token` does not equal the requested
 *      address after normalization is EXCLUDED — never a symbol guess.
 *  (c) `agent_activity` (Agent Scan plan §4.1/§4.7) — one row per EVM swap
 *      ATTEMPT (`event_role = 'swap'` only; allowance rows are approval
 *      plumbing, excluded). Matching is DIRECT and exact — `chain_id` is a
 *      real BIGINT column (no free-text alias dance) and
 *      `token_in_address`/`token_out_address` are real columns (no JSONB
 *      resolution needed): a row matches when `chain_id = $chainId` AND
 *      (input OR output token address = the requested address). Surfaces
 *      `status`/`failureCode` so a pending or failed attempt is visible too,
 *      not just confirmed fills — mirrors `db/repos/transactions.ts`'s
 *      compatibility feed (root `src/`, read-only reference — NOT imported).
 *      Dedupe (mirrors that same feed's semantics): the unified
 *      `kyberswap.swap.execute`/`uniswap.swap.execute` handlers have
 *      `capture: "none"`, so an execution is written to EXACTLY ONE of
 *      `proj_activity`/`agent_activity`, never both — no runtime overlap to
 *      guard against structurally, unlike the root feed's failure half.
 *
 * Total order: `created_at DESC, source_rank DESC, source_id DESC`
 * (source_rank: agent_activity=2, activity=1, intent=0 — fixed). `source_id`
 * is TEXT in every arm (the two BIGSERIAL/SERIAL arms zero-pad so
 * lexicographic order matches numeric order; intent ids are already opaque
 * text) so one UNION column type works for all three. Keyset `limit+1` →
 * `nextCursor`/`hasMore`, mirroring `src/vex-agent/db/repos/transactions.ts`
 * (read-only reference).
 *
 * BOUNDED READ WITHOUT A MIGRATION (round-2 negotiated): the read runs inside
 * `BEGIN READ ONLY; SET LOCAL statement_timeout = '2s'` … guaranteed
 * COMMIT/ROLLBACK. A SQLSTATE 57014 fails the WHOLE read closed
 * (`{status:"unavailable", reason:"query_timeout"}`). The IPC handler (not
 * this module) is responsible for checking `ctx.signal.aborted` before
 * trusting an `"unavailable"` result as a genuine timeout rather than a user
 * cancel (register-handler discipline — this module has no `ctx`).
 *
 * COST BASIS — RETIRED (Agent Scan plan §4.7): the former cost-basis phase
 * read `proj_pnl_lots`, which the PnL/lot-projection teardown deletes (the
 * unified Kyber/Uniswap handlers never populate a lot ledger). No
 * replacement; the page's `entries` are the whole result now.
 *
 * AMOUNT HONESTY (Codex final-review round 1 finding 5 / contract C20): a
 * `confirmed` agent_activity swap entry NEVER displays the quote-time
 * REQUESTED amount as if it were settlement. `resolveAgentActivityAmount`
 * (`./agent-activity-amount.js`, shared with `moves-db.ts`) picks the one
 * honest value per status: `confirmed` → computed from
 * `executed_amount_*_raw` + `token_*_decimals` (BigInt-safe, via `viem`'s
 * `formatUnits` — never `Number` on a wei-scale string, and never the
 * repair-sweep decoders' human column, which they intentionally leave
 * unpopulated); `pending` → the requested echo; anything else (`failed`) →
 * none.
 *
 * USD HONESTY (Codex final-review round 2 finding 7 / contract C35): unlike
 * the amount above, an `agent_activity` leg's `valueUsd` is ALWAYS a
 * quote-time estimate (`aa.usd_in/out_est`) — there is no settlement-time USD
 * repricing anywhere in this feed, so the tag does NOT vary with `status` the
 * way `resolveAgentActivityAmount` does. Every leg's `valueUsd` carries a
 * `usdProvenance` tag (`usdField()` below): `"estimated"` for the
 * `agent_activity` arm, `"recorded"` for the legacy `proj_activity` arm (its
 * own captured USD column). The renderer must show an `"estimated"` figure
 * with an explicit `~ … est.` marker — never bare "USD at execution".
 *
 * SECURITY: wallet allow-list is the GLOBAL configured inventory only
 * (`inventory-wallets.ts` — the same resolution `portfolio-db.ts` uses for
 * `scope: "global"`); the renderer never supplies an address. Logging records
 * ONLY counts + correlationId-free structural context — a cancellation logs
 * exactly one redacted event (`portfolio.token_history_query_canceled`),
 * never addresses/amounts.
 */

import { Client, type ClientConfig } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { SOLANA_CHAIN_ID, familyForChainId } from "@shared/chains/display.js";
import {
  TOKEN_HISTORY_PAGE_SIZE,
  type AmountField,
  type TokenHistoryCursor,
  type TokenHistoryDto,
  type TokenHistoryEntry,
  type TokenHistoryReadInput,
  type UsdField,
} from "@shared/schemas/token-history.js";
import { sanitizeTokenSymbol } from "@shared/token-symbol-sanitizer.js";
import { coerceBridgeLegs } from "@shared/schemas/bridge-legs.js";
import {
  resolveAgentActivityAmount,
  resolveBridgeActivityAmount,
} from "./agent-activity-amount.js";
import { resolveInventoryWalletAddresses } from "./inventory-wallets.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
/** Outer session-level safety net; the per-transaction `SET LOCAL` below is the real bound. */
const SESSION_STATEMENT_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_SQL = "2s";
const STATEMENT_TIMEOUT_SQLSTATE = "57014";

function dbUnavailable(): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "portfolio",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
  });
}

function dbError(reason: string, cause?: unknown): Result<never, VexError> {
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

function isStatementTimeout(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === STATEMENT_TIMEOUT_SQLSTATE
  );
}

async function withClient<T>(
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

async function rollbackQuietly(client: Client): Promise<void> {
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

function chainMatchCandidates(chainId: number): readonly string[] {
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
function resolveChainIdFromDisplayChain(chain: string): number {
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
function keysetPredicate(
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

// ── Row shape (wide UNION — NULL placeholders where an arm doesn't apply) ─

interface PageRow {
  readonly source_kind: "activity" | "intent" | "agent_activity";
  readonly source_rank: number;
  readonly source_id: string;
  readonly created_at: string | Date;
  readonly cursor_ts: string;
  readonly namespace: string | null;
  readonly product_type: string | null;
  readonly trade_side: string | null;
  readonly chain: string | null;
  readonly dest_chain: string | null;
  readonly input_token_address: string | null;
  readonly input_amount: string | null;
  readonly output_token_address: string | null;
  readonly output_amount: string | null;
  readonly input_value_usd: number | string | null;
  readonly output_value_usd: number | string | null;
  readonly unit_price_usd: number | string | null;
  readonly capture_status: string | null;
  readonly tx_ref: string | null;
  readonly input_token_symbol: string | null;
  readonly input_token_local_symbol: string | null;
  readonly output_token_symbol: string | null;
  readonly output_token_local_symbol: string | null;
  readonly to_address: string | null;
  /** `agent_activity` only — already collapsed to the DTO's 3-value vocabulary in SQL. */
  readonly status: string | null;
  /** `agent_activity` only — the closed failure_code enum. */
  readonly failure_code: string | null;
  /** `agent_activity` only — receipt-derived EXECUTED leg, raw base-unit integer text (C20). */
  readonly executed_amount_in_raw: string | null;
  readonly executed_amount_out_raw: string | null;
  /** `agent_activity` only — token decimals, needed to format the raw executed amount. */
  readonly token_in_decimals: number | null;
  readonly token_out_decimals: number | null;
  /** `agent_activity` BRIDGE logical row only — provider order id; `null` otherwise. */
  readonly provider_order_id: string | null;
  /**
   * `agent_activity` BRIDGE logical row only — `jsonb_agg(...)` of every
   * sibling leg (parsed to a JS array by node-postgres), or `null`. Coerced
   * via `coerceBridgeLegs`; carries the per-leg chain + hash the renderer turns
   * into explorer links (NEVER truncated — OWNER RULE).
   */
  readonly legs: unknown;
  /**
   * `agent_activity` only — last SUCCESSFUL sweep check (`last_checked_at`),
   * surfaced on the DTO for BRIDGE logical rows only (R12 tracking-delay);
   * `null`/absent on the legacy arms. `Date`/string per node-postgres.
   */
  readonly last_checked_at?: string | Date | null;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toUsdStringOrNull(value: number | string | null): string | null {
  if (value === null) return null;
  return String(value);
}

/**
 * Wrap a leg's USD column with its provenance tag (C35). `provenance` is a
 * caller-supplied constant per arm — NEVER derived from `status` (see the
 * module header's USD HONESTY note: unlike the executed amount, there is no
 * settlement-time repricing to switch to).
 */
function usdField(value: number | string | null, provenance: "recorded" | "estimated"): UsdField {
  return { value: toUsdStringOrNull(value), usdProvenance: provenance };
}

/**
 * Unit provenance for a LEGACY (`proj_activity`) amount column, mirroring
 * `MovesBlock.tsx`'s `amountDisplay` discipline exactly: the engine recorded
 * HUMAN-readable amounts only for some captures (a dotted decimal that
 * parses to a finite positive number); anything else — including a raw
 * base-unit integer with no dot — is honestly `"unknown"` rather than
 * asserted as a specific-but-unrenderable unit (there is nothing display-side
 * to gain from distinguishing "atomic" from "unknown": both render the em
 * dash). `agent_activity` rows never call this — see
 * `agentActivityAmountField` below.
 */
function amountField(value: string | null): AmountField {
  if (value === null) return { value: null, unitProvenance: "unknown" };
  if (value.includes(".")) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return { value, unitProvenance: "human" };
  }
  return { value, unitProvenance: "unknown" };
}

/**
 * `wallet_intents.amount` is ALWAYS a human decimal the tool validated as
 * `Number.isFinite(...) > 0` at prepare time (`send/validation.ts`) — never
 * a raw atomic integer — so whole-number strings ("5") are still "human"
 * here, unlike `amountField`'s dotted-decimal requirement for activity rows.
 */
function humanAmountField(value: string | null): AmountField {
  if (value === null) return { value: null, unitProvenance: "unknown" };
  const parsed = Number.parseFloat(value);
  if (Number.isFinite(parsed) && parsed > 0) return { value, unitProvenance: "human" };
  return { value, unitProvenance: "unknown" };
}

/**
 * `agent_activity` amounts are ALREADY human decimals BY CONTRACT (plan
 * §4.1) — no dot-detection heuristic needed, unlike the legacy `amountField`
 * above (Codex final review finding 10 / contract C27: a whole-number
 * human value like "50" is a VALID result, not a rejection). WHICH value is
 * honest to show depends on the row's status — delegated to
 * `resolveAgentActivityAmount` (`./agent-activity-amount.js`, shared with
 * `moves-db.ts` — contract C20): `confirmed` computes from the raw executed
 * leg + decimals; `pending` uses the requested echo; anything else is
 * `null`. Never a blind COALESCE of executed/requested in SQL.
 */
function agentActivityAmountField(
  status: TokenHistorySwapStatus | null,
  requestedHuman: string | null,
  executedRaw: string | null,
  decimals: number | null,
): AmountField {
  const value = resolveAgentActivityAmount(status, requestedHuman, executedRaw, decimals);
  return value === null
    ? { value: null, unitProvenance: "unknown" }
    : { value, unitProvenance: "human" };
}

/**
 * Wrap a BRIDGE amount value (already resolved via `resolveBridgeActivityAmount`
 * per BINDING Q2) as an `AmountField`. A resolved value is ALWAYS a human
 * decimal (executed truth or a labelled quote estimate); the `estimated` vs
 * `executed` distinction rides the entry-level `amountBasis`, not the unit
 * provenance (both are honest human units, unlike a raw wei string).
 */
function bridgeAmountField(value: string | null): AmountField {
  return value === null
    ? { value: null, unitProvenance: "unknown" }
    : { value, unitProvenance: "human" };
}

const TOKEN_HISTORY_SWAP_STATUSES = ["pending", "confirmed", "failed"] as const;
type TokenHistorySwapStatus = (typeof TOKEN_HISTORY_SWAP_STATUSES)[number];

/**
 * Narrow the SQL-collapsed `agent_activity` status string to the DTO's closed
 * vocabulary. An unrecognized value fails closed to `null` rather than
 * risking an output-schema parse failure on a future enum drift.
 */
function toTokenHistorySwapStatus(value: string | null): TokenHistorySwapStatus | null {
  // Tolerate the raw DB value too — the SQL CASE collapses
  // `definitively_failed` → `failed`, but the mapper must not depend on it.
  if (value === "definitively_failed") return "failed";
  return value !== null &&
    (TOKEN_HISTORY_SWAP_STATUSES as readonly string[]).includes(value)
    ? (value as TokenHistorySwapStatus)
    : null;
}

function mapEntry(row: PageRow): TokenHistoryEntry {
  // The tx hash always lives on the ORIGIN chain (`row.chain` — never
  // `dest_chain`), even for a row that matched via its destination leg —
  // resolve it from the row's OWN stored chain string, not the query's
  // input chainId, which can legitimately differ for a bridge.
  const txRefs = row.tx_ref !== null && row.chain !== null
    ? [{ chainId: resolveChainIdFromDisplayChain(row.chain), ref: row.tx_ref }]
    : [];

  if (row.source_kind === "intent") {
    return {
      kind: "transfer",
      id: row.source_id,
      createdAt: toIso(row.created_at),
      chain: row.chain,
      toAddress: row.to_address ?? "",
      amount: humanAmountField(row.output_amount),
      token: row.output_token_address,
      status: row.capture_status ?? "unknown",
      txRefs,
    };
  }

  if (row.source_kind === "agent_activity") {
    const status = toTokenHistorySwapStatus(row.status);

    // A bridge's LOGICAL row (`event_role = 'bridge_fill_expected'`, migration
    // 045) → a `kind: "bridge"` entry: from→to chains from the route endpoints
    // (`chain` = origin, `dest_chain` = destination — set in SQL), status
    // (`pending` = still settling, tracked; `bridge_refunded` distinguishes a
    // money-returned outcome), amounts per BINDING Q2, and `legs[]` carrying
    // every sibling leg's chain + hash (the renderer builds per-leg explorer
    // links from `legs`, NEVER truncated — OWNER RULE — so `txRefs` stays empty
    // for bridges; legacy `proj_activity` bridges keep using `txRefs`).
    if (row.product_type === "bridge") {
      const inRes = resolveBridgeActivityAmount(
        status,
        row.input_amount,
        row.executed_amount_in_raw,
        row.token_in_decimals,
      );
      const outRes = resolveBridgeActivityAmount(
        status,
        row.output_amount,
        row.executed_amount_out_raw,
        row.token_out_decimals,
      );
      return {
        kind: "bridge",
        id: row.source_id,
        createdAt: toIso(row.created_at),
        originChain: row.chain ?? "unknown",
        destinationChain: row.dest_chain,
        venue: row.namespace,
        input: {
          token: row.input_token_address,
          symbol: sanitizeTokenSymbol(row.input_token_symbol),
          localSymbol: null,
          amount: bridgeAmountField(inRes.value),
          valueUsd: usdField(row.input_value_usd, "estimated"),
        },
        output: {
          token: row.output_token_address,
          symbol: sanitizeTokenSymbol(row.output_token_symbol),
          localSymbol: null,
          amount: bridgeAmountField(outRes.value),
          valueUsd: usdField(row.output_value_usd, "estimated"),
        },
        captureStatus: null,
        txRefs: [],
        status,
        failureCode: row.failure_code,
        providerOrderId: row.provider_order_id ?? null,
        // executed_* are populated together (B4); prefer the output basis.
        amountBasis: outRes.basis ?? inRes.basis,
        legs: coerceBridgeLegs(row.legs),
        // R12: last successful sweep check — the renderer flags a stale pending
        // bridge "tracking delayed". `null` when never checked.
        lastCheckedAt: row.last_checked_at != null ? toIso(row.last_checked_at) : null,
      };
    }

    // event_role='swap' → a swap entry. Amount provenance is status-dependent
    // (C20 — see `agentActivityAmountField`); no dot-detection heuristic gates
    // a whole-number result (C27). USD provenance is NOT status-dependent (C35
    // — see the module header's USD HONESTY note): `usd_in/out_est` is always a
    // quote-time estimate, so both legs are tagged `"estimated"` regardless of
    // `status`. `localSymbol` fallback is unnecessary — `token_in/out_symbol`
    // are authoritative on-chain reads, not a legacy raw-address gap to fill.
    return {
      kind: "swap",
      id: row.source_id,
      createdAt: toIso(row.created_at),
      chain: row.chain ?? "unknown",
      venue: row.namespace,
      tradeSide: null,
      productType: row.product_type,
      input: {
        token: row.input_token_address,
        symbol: sanitizeTokenSymbol(row.input_token_symbol),
        localSymbol: null,
        amount: agentActivityAmountField(
          status,
          row.input_amount,
          row.executed_amount_in_raw,
          row.token_in_decimals,
        ),
        valueUsd: usdField(row.input_value_usd, "estimated"),
      },
      output: {
        token: row.output_token_address,
        symbol: sanitizeTokenSymbol(row.output_token_symbol),
        localSymbol: null,
        amount: agentActivityAmountField(
          status,
          row.output_amount,
          row.executed_amount_out_raw,
          row.token_out_decimals,
        ),
        valueUsd: usdField(row.output_value_usd, "estimated"),
      },
      unitPriceUsd: toUsdStringOrNull(row.unit_price_usd),
      captureStatus: null,
      status,
      failureCode: row.failure_code,
      txRefs,
    };
  }

  const input = {
    token: row.input_token_address,
    symbol: sanitizeTokenSymbol(row.input_token_symbol),
    localSymbol: sanitizeTokenSymbol(row.input_token_local_symbol),
    amount: amountField(row.input_amount),
    valueUsd: usdField(row.input_value_usd, "recorded"),
  };
  const output = {
    token: row.output_token_address,
    symbol: sanitizeTokenSymbol(row.output_token_symbol),
    localSymbol: sanitizeTokenSymbol(row.output_token_local_symbol),
    amount: amountField(row.output_amount),
    valueUsd: usdField(row.output_value_usd, "recorded"),
  };

  if (row.product_type === "bridge") {
    // Legacy `proj_activity` bridge (pre-migration-045, success-only): no
    // durable lifecycle, no provider order id, no per-leg breakdown — the new
    // agent_activity-only fields are null/empty here (the DTO defaults them so
    // pre-existing payloads still parse).
    return {
      kind: "bridge",
      id: row.source_id,
      createdAt: toIso(row.created_at),
      originChain: row.chain ?? "unknown",
      destinationChain: row.dest_chain,
      venue: row.namespace,
      input,
      output,
      captureStatus: row.capture_status,
      txRefs,
      status: null,
      failureCode: null,
      providerOrderId: null,
      amountBasis: null,
      legs: [],
    };
  }

  return {
    kind: "swap",
    id: row.source_id,
    createdAt: toIso(row.created_at),
    chain: row.chain ?? "unknown",
    venue: row.namespace,
    tradeSide: row.trade_side,
    productType: row.product_type,
    input,
    output,
    unitPriceUsd: toUsdStringOrNull(row.unit_price_usd),
    captureStatus: row.capture_status,
    status: null,
    failureCode: null,
    txRefs,
  };
}

// ── Main read ─────────────────────────────────────────────────────────────

export async function getTokenHistory(
  input: TokenHistoryReadInput,
): Promise<Result<TokenHistoryDto, VexError>> {
  const wallets = [...resolveInventoryWalletAddresses()];

  // Fail closed: no configured wallets → the empty available page, before any SQL.
  if (wallets.length === 0) {
    log.info("[token-history-db] getTokenHistory ok wallets=0 (empty inventory)");
    return ok({
      status: "available",
      entries: [],
      nextCursor: null,
      hasMore: false,
    });
  }

  const family = familyForChainId(input.chainId);
  const network = family === "solana" ? "solana" : "eip155";
  const chainAliases = [...chainMatchCandidates(input.chainId)];
  // Defense in depth: `tokenHistoryReadInputSchema` already lower-cases EVM
  // addresses at the IPC boundary, but `addr()` below only wraps the STORED
  // COLUMN in `lower(...)` — the bound parameter must independently carry
  // the same casing, or `lower(column) = $param` would silently match zero
  // rows for any caller that reaches this function without going through
  // that schema (e.g. a direct call). Idempotent when the schema already ran.
  const normalizedAddress =
    family === "evm" ? input.tokenAddress.toLowerCase() : input.tokenAddress;
  const addr = (column: string): string => (family === "evm" ? `lower(${column})` : column);

  const cursor: TokenHistoryCursor | null = input.cursor;

  return withClient<TokenHistoryDto>(async (client) => {
    try {
      await client.query("BEGIN READ ONLY");
    } catch (cause) {
      return dbError("BEGIN READ ONLY failed", cause);
    }

    try {
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_SQL}'`);
    } catch (cause) {
      await rollbackQuietly(client);
      return dbError("SET LOCAL statement_timeout failed", cause);
    }

    // ── Phase 1: the page ────────────────────────────────────────────────
    const params: unknown[] = [];
    const push = (value: unknown): number => {
      params.push(value);
      return params.length;
    };

    const walletsParam = push(wallets);
    const chainAliasesParam = push(chainAliases);
    const addressParam = push(normalizedAddress);
    const networkParam = push(network);
    const chainIdParam = push(input.chainId);

    const hasCursor = cursor !== null;
    const tsParam = cursor !== null ? push(cursor.createdAt) : 0;
    const rankParam = cursor !== null ? push(cursor.sourceRank) : 0;
    const idParam = cursor !== null ? push(cursor.sourceId) : 0;

    const limitParam = push(TOKEN_HISTORY_PAGE_SIZE + 1);

    const activityKeyset = keysetPredicate(
      "a.created_at",
      "lpad(a.id::text, 20, '0')",
      1,
      hasCursor,
      tsParam,
      rankParam,
      idParam,
    );
    const intentKeyset = keysetPredicate(
      "wi.created_at",
      "wi.intent_id",
      0,
      hasCursor,
      tsParam,
      rankParam,
      idParam,
    );
    const agentActivityKeyset = keysetPredicate(
      "aa.created_at",
      "lpad(aa.id::text, 20, '0')",
      2,
      hasCursor,
      tsParam,
      rankParam,
      idParam,
    );

    const activityHalf = `
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
            AND b.token_address = a.input_token
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
            AND b.token_address = a.output_token
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
        NULL::timestamptz AS last_checked_at
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

    const intentHalf = `
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
        NULL::timestamptz AS last_checked_at
      FROM wallet_intents wi
      WHERE wi.wallet_address = ANY($${walletsParam}::text[])
        AND wi.status = 'executed'
        AND wi.tx_hash IS NOT NULL
        AND wi.network = $${networkParam}
        AND lower(trim(wi.chain_alias)) = ANY($${chainAliasesParam}::text[])
        AND ${addr("wi.token")} = $${addressParam}
        ${intentKeyset}`;

    // agent_activity half (Agent Scan plan §4.1/§4.7 + Phase 2 bridges):
    // surfaces a SWAP row (`event_role = 'swap'`) OR a bridge's LOGICAL row
    // (`event_role = 'bridge_fill_expected'`, migration 045) — allowance/
    // deposit/observed-fill/refund rows are execution detail carried only
    // inside `legs`. `product_type` derives from `kind`. Match is EXACT (real
    // BIGINT `chain_id` + real token address columns, no free-text dance):
    //  - a SWAP matches its single `chain_id`;
    //  - a BRIDGE matches LEG-AWARE — the origin leg (`from_chain_id` +
    //    `token_in_address`) OR the destination leg (`to_chain_id` +
    //    `token_out_address`) — because a bridge's two legs live on DIFFERENT
    //    chains (mirrors the leg-aware match on the legacy `proj_activity`
    //    half). For a bridge, `chain` is the ORIGIN and `dest_chain` the
    //    destination (route endpoints), while the per-leg hashes ride `legs`.
    // `status` collapses the DB's 3-value enum here; `input_amount`/
    // `output_amount` are the quote-time REQUESTED echo — the JS mapper
    // (`agentActivityAmountField` C20 for swaps / `resolveBridgeActivityAmount`
    // Q2 for bridges) decides what to show. `legs` (jsonb_agg, NO LIMIT — OWNER
    // RULE) aggregates every sibling leg of a bridge execution.
    const agentActivityHalf = `
      SELECT
        'agent_activity'::text AS source_kind,
        2 AS source_rank,
        lpad(aa.id::text, 20, '0') AS source_id,
        aa.created_at,
        ${cursorTsExpr("aa.created_at")} AS cursor_ts,
        aa.protocol AS namespace,
        CASE aa.kind WHEN 'bridge' THEN 'bridge' ELSE 'spot' END AS product_type,
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
        NULL::text AS input_token_local_symbol,
        aa.token_out_symbol AS output_token_symbol,
        NULL::text AS output_token_local_symbol,
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
        aa.last_checked_at
      FROM agent_activity aa
      WHERE aa.wallet_address = ANY($${walletsParam}::text[])
        AND aa.event_role IN ('swap', 'bridge_fill_expected')
        AND (
          (
            aa.event_role = 'swap'
            AND aa.chain_id = $${chainIdParam}::bigint
            AND (
              ${addr("aa.token_in_address")} = $${addressParam}
              OR ${addr("aa.token_out_address")} = $${addressParam}
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

    const pageSql = `${activityHalf}
      UNION ALL
      ${intentHalf}
      UNION ALL
      ${agentActivityHalf}
      ORDER BY created_at DESC, source_rank DESC, source_id DESC
      LIMIT $${limitParam}`;

    let pageRows: PageRow[];
    try {
      const result = await client.query<PageRow>(pageSql, params);
      pageRows = result.rows;
    } catch (cause) {
      await rollbackQuietly(client);
      if (isStatementTimeout(cause)) {
        log.info("portfolio.token_history_query_canceled phase=page");
        return ok({ status: "unavailable", reason: "query_timeout" });
      }
      return dbError("page query failed", cause);
    }

    const hasMore = pageRows.length > TOKEN_HISTORY_PAGE_SIZE;
    const kept = hasMore ? pageRows.slice(0, TOKEN_HISTORY_PAGE_SIZE) : pageRows;
    const entries = kept.map(mapEntry);
    const lastKept = kept[kept.length - 1];
    const nextCursor: TokenHistoryCursor | null =
      hasMore && lastKept !== undefined
        ? {
            createdAt: lastKept.cursor_ts,
            sourceRank: normalizeSourceRank(lastKept.source_rank),
            sourceId: lastKept.source_id,
          }
        : null;

    try {
      await client.query("COMMIT");
    } catch (cause) {
      await rollbackQuietly(client);
      return dbError("COMMIT failed", cause);
    }

    log.info(
      `[token-history-db] getTokenHistory ok entries=${entries.length} hasMore=${hasMore}`,
    );
    return ok({ status: "available", entries, nextCursor, hasMore });
  });
}

function normalizeSourceRank(value: number): 0 | 1 | 2 {
  return value === 2 ? 2 : value === 1 ? 1 : 0;
}
