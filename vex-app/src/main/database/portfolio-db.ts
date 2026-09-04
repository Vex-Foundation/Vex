/**
 * Portfolio DB helper — read-only dual-scope POSITION portfolio (stage 3).
 *
 * Mirrors `usage-db.ts` / `sessions-db.ts` decoupling: own `pg.Client` per
 * call, no `@vex-agent/db/repos/*` import. Reads the same local `vex`
 * Postgres the engine writes to, against:
 *
 *   proj_balances(wallet_address TEXT, chain_id BIGINT, token_symbol TEXT,
 *                 token_name TEXT, balance_raw TEXT, decimals INTEGER,
 *                 balance_usd NUMERIC)
 *   proj_portfolio_snapshots(wallet_family eip155|solana, wallet_address TEXT,
 *                 snapshot_group_id UUID, total_usd NUMERIC,
 *                 pnl_vs_prev NUMERIC, created_at)
 *
 * SECURITY (non-negotiable):
 *  - GLOBAL is an EXPLICIT address allow-list. EVERY SELECT carries
 *    `WHERE wallet_address = ANY($1::text[])` with a bound, finite array.
 *    The filter is never omitted.
 *  - addresses.length === 0 → return the EMPTY DTO BEFORE issuing any SQL
 *    (no wallets configured, or empty session scope). Fail closed.
 *  - addresses are resolved SERVER-SIDE (config inventory / session scope).
 *    A renderer-supplied address is NEVER trusted as-is: the ONLY place one
 *    can enter is the optional `walletAddress` on a `global` request
 *    (WP-L2, the welcome-screen per-wallet switcher), and it is matched
 *    against the SAME configured inventory before use — an address outside
 *    the inventory fails closed with `wallets.invalid_selection` (no SQL
 *    issued), it never widens or redirects the read.
 *  - join key between inventory and balances is the raw ADDRESS string —
 *    DO NOT lowercase (the engine stores raw checksum/base58 addresses).
 *  - logging records sessionId (if any) + wallet COUNT + token COUNT only;
 *    NEVER raw addresses, balances, or USD figures.
 *  - token aggregation groups by `(chain_id, NORMALIZED token_address)` —
 *    never by symbol in any form. A spoof token that self-declares a
 *    legitimate token's symbol has a DIFFERENT `token_address`, so it can
 *    never coalesce into that token's line before the renderer's trust gate
 *    (address-verified brand icon) can act on it.
 *  - native SOL uses its database-only System Program key while wSOL uses its
 *    mint. SQL groups on those distinct persisted keys first. Only after that
 *    grouping does the DTO map native SOL back to Jupiter's route mint, so the
 *    two balances remain separate rows while every renderer action receives a
 *    route-compatible address.
 *  - `token_name` (like `token_symbol`) is attacker-influenceable display
 *    metadata; it is sanitized through `sanitizeTokenName` HERE, before the
 *    DTO is built, because the output schema's `safeTokenNameSchema` is a
 *    validation gate, not a sanitizer — an unsanitized name would fail that
 *    gate and hard-fail the whole response instead of degrading to `null`.
 *    Both the symbol and name aggregates share ONE `ORDER BY` fragment
 *    (`LATEST_ROW_ORDER_SQL`) so an exact `synced_at` tie can never pair a
 *    name from one source row with a symbol from a different one.
 */

import { Client, type ClientConfig } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import type {
  PortfolioDto,
  PortfolioReadInput,
  PositionChainDto,
  PositionTokenDto,
} from "@shared/schemas/portfolio.js";
import { familyForChainId } from "@shared/chains/display.js";
import { sanitizeTokenName } from "@shared/token-name-sanitizer.js";
import { solanaRouteMintFromPersistedAddress } from "@tools/solana-ecosystem/shared/solana-asset-identity.js";
import { listInventoryWalletEntries } from "./inventory-wallets.js";
import { getSessionWalletScope } from "./sessions-db.js";
import { readProjectPortfolioScope } from "./projects/portfolio-scope.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

// `correlationId` intentionally omitted; `registerHandler` stamps
// `ctx.requestId` downstream. Mirrors `usage-db.ts`.
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
  log.warn(`[portfolio-db] ${reason}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "portfolio",
    message: "Unable to load portfolio.",
    retryable: true,
    userActionable: false,
    redacted: true,
  });
}

async function withClient<T>(
  fn: (client: Client) => Promise<Result<T, VexError>>,
): Promise<Result<T, VexError>> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[portfolio-db] buildPoolConfig threw", cause);
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
    log.warn("[portfolio-db] client.connect failed", cause);
    return dbUnavailable();
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn("[portfolio-db] client.end failed (non-fatal)", cause);
    }
  }
}

interface LiveTotalRow {
  readonly live: number | string | null;
}

interface TokenRow {
  readonly chain_id: number | string | null;
  readonly token_address: string;
  readonly token_symbol: string | null;
  readonly token_name: string | null;
  readonly usd: number | string | null;
  readonly amount: number | string | null;
}

interface SnapshotRow {
  readonly total: number | string | null;
  readonly at: string | Date | null;
}

interface ChainBreakdownRow {
  readonly chain_id: number | string;
  readonly chain_total: number | string;
  readonly token_address: string | null;
  readonly token_symbol: string | null;
  readonly token_name: string | null;
  readonly token_usd: number | string | null;
  readonly token_amount: number | string | null;
}

/**
 * Human token QUANTITY for one balance row: `balance_raw / 10^decimals`,
 * computed PER ROW inside the aggregate (mixed-decimals buckets must divide
 * before summing). The CASE guard keeps a NULL-decimals or malformed
 * `balance_raw` row as a NULL contribution (SUM skips it) instead of failing
 * the whole query on a bad cast — SUM over only-NULL rows yields NULL, which
 * the DTO carries as `amount: null` (nothing fabricated).
 */
const AMOUNT_SUM_SQL = `SUM(
              CASE WHEN decimals IS NOT NULL AND balance_raw ~ '^[0-9]+$'
                   THEN balance_raw::numeric / power(10::numeric, decimals)
              END
            )::float8`;

/**
 * Cap on per-(chain, token) holding lines. Matches the `portfolioDtoSchema`
 * `tokens` `.max(500)` so the response can never overflow the output-schema
 * bound (a >cap wallet set would otherwise 500-error the whole panel via the
 * handler's output validation). Enforced in BOTH the SQL LIMIT and a TS slice.
 */
const MAX_TOKEN_LINES = 500;

// Semantic token identity for aggregation: one contract must aggregate into
// ONE line even when different wallets' rows carry different address casing
// (EVM addresses are case-insensitive hex; checksum/casing variants are the
// same contract) or stale symbols from earlier syncs. EVM (0x…) addresses
// normalize to lowercase; Solana mints are case-SENSITIVE base58 and must be
// preserved verbatim. The displayed symbol is the deterministic latest one
// (freshest `synced_at` wins; symbol text breaks exact ties) — never one
// arbitrary row's stale label.
const NORMALIZED_TOKEN_ADDRESS_SQL = `CASE WHEN token_address ~* '^0x' THEN lower(token_address) ELSE token_address END`;

// ONE shared ORDER BY fragment for BOTH the symbol and name "latest row"
// aggregates below. This is deliberate, not incidental: `array_agg(...)[1]`
// picks the first row of ITS OWN sort order, so if the name aggregate used a
// different tie-breaker (e.g. `token_name ASC`) an exact `synced_at` tie
// could pick symbol from one source row and name from a DIFFERENT row —
// pairing a legitimate symbol with an unrelated name (or vice versa). Reusing
// the identical fragment (tie-broken on `token_symbol`, not `token_name`)
// guarantees both aggregates resolve to the SAME winning row.
const LATEST_ROW_ORDER_SQL = `ORDER BY synced_at DESC NULLS LAST, token_symbol ASC NULLS LAST`;
const LATEST_TOKEN_SYMBOL_SQL = `(array_agg(token_symbol ${LATEST_ROW_ORDER_SQL}))[1]`;
const LATEST_TOKEN_NAME_SQL = `(array_agg(token_name ${LATEST_ROW_ORDER_SQL}))[1]`;

/**
 * Caps for the per-chain breakdown — mirror `portfolioDtoSchema.chains`
 * (`.max(64)` chains, `.max(3)` tokens each). The SQL emits at most
 * 64 chains × ≤3 token rows; TS slices defensively to the same bounds.
 */
const MAX_BREAKDOWN_CHAINS = 64;
const MAX_CHAIN_TOKENS = 3;

/**
 * Assemble `PositionChainDto[]` from the breakdown query's flat rows
 * (one row per surviving (chain, top-token) pair, chain totals repeated,
 * ordered chain-total DESC then chain id ASC then token rank ASC — the
 * chain-id tie-breaker keeps equal-total chains CONTIGUOUS, which this
 * single-pass grouper depends on; codex final review). Rows arrive
 * pre-filtered: non-negative chain totals (0 = a chain holding ONLY unpriced
 * tokens — owner decision: still shown), token lines either positive-USD or
 * UNPRICED (NULL usd, amount carried when computable), NULL chain_id
 * excluded.
 */
function buildChainBreakdown(
  rows: readonly ChainBreakdownRow[],
): PositionChainDto[] {
  const chains: PositionChainDto[] = [];
  let current: {
    chainId: number;
    totalUsd: number;
    tokens: {
      symbol: string | null;
      tokenAddress: string | null;
      tokenName: string | null;
      balanceUsd: number | null;
      amount: number | null;
    }[];
  } | null = null;
  for (const row of rows) {
    const chainId = toChainId(row.chain_id);
    const totalUsd = toNumber(row.chain_total);
    // Defensive: the SQL already excludes NULL chain ids and cannot emit a
    // negative total; a row that still fails coercion is dropped, not
    // fabricated. Zero totals are KEPT (unpriced-only chain).
    if (chainId === null || totalUsd < 0) continue;
    if (current === null || current.chainId !== chainId) {
      if (current !== null) {
        chains.push({
          chainId: current.chainId,
          family: familyForChainId(current.chainId),
          totalUsd: current.totalUsd,
          tokens: current.tokens,
        });
        if (chains.length >= MAX_BREAKDOWN_CHAINS) return chains;
      }
      current = { chainId, totalUsd, tokens: [] };
    }
    const tokenUsd = toNumberOrNull(row.token_usd);
    const tokenAmount = toNumberOrNull(row.token_amount);
    // A LEFT-JOIN miss (chain with no rankable lines) emits all-NULL token
    // columns — skip it. Real lines are either priced (> $0 by the ranked
    // filter; defensively re-checked) or UNPRICED (NULL usd) and kept so
    // held funds stay visible without a valuation.
    const hasTokenRow =
      row.token_symbol !== null || tokenUsd !== null || tokenAmount !== null;
    if (
      hasTokenRow &&
      (tokenUsd === null || tokenUsd > 0) &&
      current.tokens.length < MAX_CHAIN_TOKENS
    ) {
      current.tokens.push({
        symbol: row.token_symbol,
        tokenAddress: routeCompatibleTokenAddress(chainId, row.token_address),
        tokenName: sanitizeTokenName(row.token_name),
        balanceUsd: tokenUsd,
        amount: tokenAmount,
      });
    }
  }
  if (current !== null && chains.length < MAX_BREAKDOWN_CHAINS) {
    chains.push({
      chainId: current.chainId,
      family: familyForChainId(current.chainId),
      totalUsd: current.totalUsd,
      tokens: current.tokens,
    });
  }
  return chains;
}

/**
 * `NUMERIC`/`float8` columns come back from `pg` as strings or numbers. We
 * coerce to a finite JS number, falling back to `0` for the never-null
 * SUM totals (the SQL `COALESCE(...,0)::float8` already guarantees a value).
 */
function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Like `toNumber` but preserves the "absent" distinction as `null`. */
function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Convert the native SOL database-only storage key back to Jupiter's route
 * mint after SQL has grouped native SOL and wSOL under their distinct keys.
 * Every non-Solana address and every SPL mint passes through unchanged.
 */
function routeCompatibleTokenAddress(
  chainId: number | null,
  persistedAddress: string | null,
): string | null {
  if (chainId === null || persistedAddress === null) return persistedAddress;
  return familyForChainId(chainId) === "solana"
    ? solanaRouteMintFromPersistedAddress(persistedAddress)
    : persistedAddress;
}

/**
 * `chain_id` is a `BIGINT` that may exceed the JS safe-integer range; `pg`
 * returns it as a string. We coerce via `Number()` and tolerate loss of
 * precision (the renderer uses it as an opaque grouping key, not for
 * arithmetic). `null` when absent or unparseable — no fabricated 0.
 */
function toChainId(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function emptyPortfolio(scope: PortfolioReadInput["scope"]): PortfolioDto {
  return {
    scope,
    walletCount: 0,
    liveTotalUsd: 0,
    snapshotTotalUsd: null,
    pnlVsPrev: null,
    snapshotAt: null,
    tokens: [],
    chains: [],
  };
}

/**
 * Selected wallet is not in the configured inventory (WP-L2). Mirrors
 * `invalidWalletSelectionError` in `_wallet-refs.ts` (same code/semantics)
 * but domain `portfolio` — this file's own error constructors intentionally
 * omit `correlationId` too (`registerHandler` stamps it downstream).
 */
function invalidWalletSelection(): Result<never, VexError> {
  return err({
    code: "wallets.invalid_selection",
    domain: "portfolio",
    message: "Selected wallet is not in the configured inventory.",
    retryable: false,
    userActionable: true,
    redacted: true,
  });
}

/**
 * Resolve the server-side wallet address allow-list for the requested scope.
 *
 *  - `global`  — the configured EVM + Solana inventory (≤6 addresses); a
 *    `walletAddress` on the request (WP-L2) narrows this to that ONE
 *    address, but ONLY after matching it against the SAME inventory — an
 *    address that is not a configured wallet fails closed with
 *    `wallets.invalid_selection` (no SQL issued), never a silent aggregate.
 *  - `session` — the session's selected EVM/Solana wallets (≤2 addresses).
 *    A failed scope read propagates as an error (fail closed); an empty
 *    scope resolves to `[]` (→ empty DTO before SQL).
 *
 * Addresses are returned as raw strings (NO lowercasing) so the
 * `proj_balances.wallet_address` join matches the engine's stored form.
 */
async function resolveAddresses(
  input: PortfolioReadInput,
  correlationId: string,
): Promise<Result<readonly string[], VexError>> {
  if (input.scope === "global") {
    const entries = listInventoryWalletEntries();
    if (input.walletAddress !== undefined) {
      const match = entries.find((e) => e.address === input.walletAddress);
      if (match === undefined) return invalidWalletSelection();
      return ok([match.address]);
    }
    // Dedupe: the snapshot-completeness guard compares COUNT(DISTINCT
    // wallet_address) against addresses.length, so a repeated address in the
    // configured inventory would otherwise spuriously drop the snapshot total.
    return ok([...new Set(entries.map((e) => e.address))]);
  }
  if (input.scope === "session") {
    const scope = await getSessionWalletScope(input.sessionId);
    if (!scope.ok) return scope;
    const addrs = [scope.data.evm?.address, scope.data.solana?.address].filter(
      (a): a is string => typeof a === "string",
    );
    return ok([...new Set(addrs)]);
  }
  return resolveProjectAddresses(input, correlationId);
}

/**
 * The PROJECT arm (B0).
 *
 * `project_wallets` is the authority, read through the projects repository so
 * the inventory-drift policy has one owner. Every failure is named:
 *
 *   - unknown or TOMBSTONED project  -> `projects.not_found`
 *   - a selection the inventory no longer backs -> `projects.wallet_drift`
 *   - a `walletId` that is not one of THIS project's selections
 *                                    -> `wallets.invalid_selection`
 *
 * The `walletId` check is the security-relevant one. It narrows WITHIN the
 * project's own two selections, exactly as `walletAddress` narrows within the
 * configured inventory on the global arm. Accepting any id that merely exists
 * in the global inventory would turn this arm into a way to read any wallet's
 * balances by quoting a project id, which is precisely the widening the
 * server-side allow-list exists to prevent.
 *
 * A project with nothing selected resolves to `[]`, which the caller renders as
 * an empty portfolio without issuing SQL. That is a real state, not a failure.
 */
async function resolveProjectAddresses(
  input: Extract<PortfolioReadInput, { scope: "project" }>,
  correlationId: string,
): Promise<Result<readonly string[], VexError>> {
  const scope = await readProjectPortfolioScope(input.projectId);
  if (scope.kind === "not_found") return projectNotFound(correlationId);
  if (scope.kind === "drift") return projectWalletDrift(scope.family, correlationId);
  if (scope.kind === "missing_family" || scope.kind === "unavailable") {
    // Both are infrastructure, not user-actionable: a project whose wallet rows
    // are incomplete was written around, and an unreadable one is a database
    // problem. Neither is an empty portfolio.
    return dbError("the project's wallet selection could not be read");
  }

  const selected = [scope.wallets.evm, scope.wallets.solana].filter(
    (ref): ref is { id: string; address: string } => ref !== null,
  );

  if (input.walletId !== undefined) {
    const match = selected.find((ref) => ref.id === input.walletId);
    if (match === undefined) return invalidWalletSelection();
    return ok([match.address]);
  }
  return ok([...new Set(selected.map((ref) => ref.address))]);
}

/**
 * `projects.not_found` in the PORTFOLIO domain. Mirrors
 * `studio/project-errors.ts`'s sentence; the domain differs because this is a
 * portfolio read failing, and the correlationId is omitted for the reason
 * documented on `invalidWalletSelection` above.
 */
function projectNotFound(correlationId: string): Result<never, VexError> {
  return err({
    code: "projects.not_found",
    domain: "portfolio",
    correlationId,
    message: "That project no longer exists. Refresh your project list.",
    retryable: false,
    userActionable: true,
    redacted: true,
  });
}

/** `projects.wallet_drift` in the portfolio domain. Never an empty portfolio. */
function projectWalletDrift(
  family: "evm" | "solana",
  correlationId: string,
): Result<never, VexError> {
  const label = family === "evm" ? "EVM" : "Solana";
  return err({
    code: "projects.wallet_drift",
    domain: "portfolio",
    correlationId,
    message:
      `The ${label} wallet saved for this project no longer matches the wallet in `
      + "your inventory: it was removed, or re-imported over a different key. "
      + "No balances were read. Select the wallet again in project settings to "
      + "confirm which key it should use.",
    retryable: false,
    userActionable: true,
    redacted: true,
  });
}

/**
 * Read the dual-scope POSITION portfolio for the requested scope.
 *
 * Returns the EMPTY DTO (no SQL issued) when the resolved allow-list is
 * empty. Otherwise aggregates `proj_balances` (live total + per-token lines)
 * and the most recent COMPLETE `proj_portfolio_snapshots` group covering
 * exactly the resolved address set.
 */
export async function getPortfolio(
  input: PortfolioReadInput,
  /**
   * The request's correlation id, threaded through so the `projects.*` errors
   * the project arm reports carry the SAME id `registerHandler` will stamp -
   * it warns when a handler attaches a different one. Defaults to empty for
   * the direct callers (tests) that never cross that boundary.
   */
  correlationId = "",
): Promise<Result<PortfolioDto, VexError>> {
  const resolved = await resolveAddresses(input, correlationId);
  if (!resolved.ok) return resolved;
  const addresses = resolved.data;

  // Fail closed: no wallets → empty portfolio BEFORE any SQL.
  if (addresses.length === 0) {
    return ok(emptyPortfolio(input.scope));
  }

  const addrParam = [...addresses];

  return withClient(async (client) => {
    try {
      // (a) Live total USD across all resolved addresses.
      const liveResult = await client.query<LiveTotalRow>(
        `SELECT COALESCE(SUM(balance_usd), 0)::float8 AS live
           FROM proj_balances
          WHERE wallet_address = ANY($1::text[])`,
        [addrParam],
      );
      const liveTotalUsd = toNumber(liveResult.rows[0]?.live);

      // (b) Per-(chain, token) live lines, biggest USD first, capped at
      // MAX_TOKEN_LINES so the response stays inside the output-schema bound.
      // `usd` stays NULL for an UNPRICED holding (no COALESCE — the renderer
      // shows the amount with an em dash instead of a fabricated $0.00);
      // `amount` is the human token quantity (see AMOUNT_SUM_SQL).
      const tokensResult = await client.query<TokenRow>(
        `SELECT chain_id,
                ${NORMALIZED_TOKEN_ADDRESS_SQL} AS token_address,
                ${LATEST_TOKEN_SYMBOL_SQL} AS token_symbol,
                ${LATEST_TOKEN_NAME_SQL} AS token_name,
                SUM(balance_usd)::float8 AS usd,
                ${AMOUNT_SUM_SQL} AS amount
           FROM proj_balances
          WHERE wallet_address = ANY($1::text[])
          GROUP BY chain_id, ${NORMALIZED_TOKEN_ADDRESS_SQL}
          ORDER BY usd DESC NULLS LAST
          LIMIT ${MAX_TOKEN_LINES}`,
        [addrParam],
      );
      const tokens: PositionTokenDto[] = tokensResult.rows
        .slice(0, MAX_TOKEN_LINES)
        .map((row) => {
          const chainId = toChainId(row.chain_id);
          return {
            chainId,
            symbol: row.token_symbol,
            tokenAddress: routeCompatibleTokenAddress(chainId, row.token_address),
            tokenName: sanitizeTokenName(row.token_name),
            balanceUsd: toNumberOrNull(row.usd),
            amount: toNumberOrNull(row.amount),
          };
        });

      // (b2) Per-chain breakdown for the POSITION chain switcher — a
      // PURPOSE-BUILT window query over the FULL balance set (Codex plan
      // review: post-processing the capped flat query above would silently
      // drop chains once the 500-row bound bites). Invariants pushed into
      // SQL: NULL chain ids excluded (legacy `tokens` still carries them),
      // EVERY funded chain survives — a chain holding only UNPRICED tokens
      // totals 0 instead of disappearing (owner decision: show funds without
      // a valuation) — and each chain contributes its top-${MAX_CHAIN_TOKENS}
      // lines ranked usd DESC NULLS LAST (positive-USD first, then unpriced;
      // priced-at-zero lines are dropped).
      const breakdownResult = await client.query<ChainBreakdownRow>(
        `WITH lines AS (
           SELECT chain_id,
                  ${NORMALIZED_TOKEN_ADDRESS_SQL} AS token_address,
                  ${LATEST_TOKEN_SYMBOL_SQL} AS token_symbol,
                  ${LATEST_TOKEN_NAME_SQL} AS token_name,
                  SUM(balance_usd)::float8 AS usd,
                  ${AMOUNT_SUM_SQL} AS amount
             FROM proj_balances
            WHERE wallet_address = ANY($1::text[])
              AND chain_id IS NOT NULL
            GROUP BY chain_id, ${NORMALIZED_TOKEN_ADDRESS_SQL}
         ),
         ranked AS (
           SELECT chain_id, token_address, token_symbol, token_name, usd, amount,
                  ROW_NUMBER() OVER (
                    PARTITION BY chain_id ORDER BY usd DESC NULLS LAST
                  ) AS rn
             FROM lines
            WHERE usd > 0 OR usd IS NULL
         ),
         totals AS (
           SELECT chain_id, COALESCE(SUM(usd), 0)::float8 AS chain_total
             FROM lines
            GROUP BY chain_id
            ORDER BY chain_total DESC
            LIMIT ${MAX_BREAKDOWN_CHAINS}
         )
         SELECT t.chain_id,
                t.chain_total,
                r.token_address,
                r.token_symbol,
                r.token_name,
                r.usd AS token_usd,
                r.amount AS token_amount
           FROM totals t
           LEFT JOIN ranked r
             ON r.chain_id = t.chain_id AND r.rn <= ${MAX_CHAIN_TOKENS}
          ORDER BY t.chain_total DESC, t.chain_id ASC, r.rn ASC NULLS LAST`,
        [addrParam],
      );
      const chains = buildChainBreakdown(breakdownResult.rows);

      // (c) PnL across COMPLETE snapshot cycles: the latest TWO groups that
      // cover EXACTLY the resolved address set (HAVING COUNT(DISTINCT)=N — a
      // partial group for a subset of the wallets is ignored). Aggregate PnL is
      // `latest.total − previous.total`, NOT SUM(pnl_vs_prev): per-wallet PnL
      // baselines don't compose into a correct set total (and miss wallets with
      // no prior row). snapshot/PnL are null when the cycle(s) are absent.
      const snapshotResult = await client.query<SnapshotRow>(
        `SELECT snapshot_group_id,
                SUM(total_usd)::float8 AS total,
                MAX(created_at)        AS at
           FROM proj_portfolio_snapshots
          WHERE wallet_address = ANY($1::text[])
          GROUP BY snapshot_group_id
         HAVING COUNT(DISTINCT wallet_address) = $2
          ORDER BY at DESC
          LIMIT 2`,
        [addrParam, addresses.length],
      );
      const latest = snapshotResult.rows[0];
      const previous = snapshotResult.rows[1];
      const snapshotTotalUsd = latest ? toNumberOrNull(latest.total) : null;
      const previousTotalUsd = previous ? toNumberOrNull(previous.total) : null;
      const pnlVsPrev =
        snapshotTotalUsd !== null && previousTotalUsd !== null
          ? snapshotTotalUsd - previousTotalUsd
          : null;
      const snapshotAt = latest && latest.at !== null ? toIso(latest.at) : null;

      log.info(
        `[portfolio-db] getPortfolio ok scope=${input.scope} ` +
          `wallets=${addresses.length} tokens=${tokens.length} ` +
          `chains=${chains.length} snapshot=${latest !== undefined}`,
      );

      return ok({
        scope: input.scope,
        walletCount: addresses.length,
        liveTotalUsd,
        snapshotTotalUsd,
        pnlVsPrev,
        snapshotAt,
        tokens,
        chains,
      });
    } catch (cause) {
      return dbError("getPortfolio query failed", cause);
    }
  });
}
