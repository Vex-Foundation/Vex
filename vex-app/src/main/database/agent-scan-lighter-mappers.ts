/**
 * `agent-scan-lighter-query.ts` row -> `AgentScanLighterFillEntry`.
 *
 * PURE, and deliberately so: every decision below is a table test away, and
 * nothing here logs a value. The one counted observation the reader wants (how
 * many stored positions could not be read) rides an optional stats accumulator
 * so `agent-scan-db.ts` can log the COUNT without this module ever holding a
 * logger or a position's figures.
 *
 * Four rules live here, each with the failure it exists to prevent.
 *
 * 1. FEE PROVENANCE SURVIVES (migration 152). `charged` is the provider's exact
 *    amount and is NULL when unproven - never zero, because a zero is itself a
 *    proven amount. The estimate is arithmetic on this fill's own basis and
 *    carries that basis and the tick it used. The two are separate DTO fields
 *    and are never added or coalesced: a renderer shows the exact figure when
 *    it exists and otherwise the estimate, marked as one.
 *
 * 2. THE FEE'S DENOMINATION IS THE VENUE'S RULE, not ours. The received BASE on
 *    a spot buy, the QUOTE asset otherwise. The ledger stores the integrator
 *    fee's own asset columns, so the integrator fee reads them; the exchange
 *    fee has no asset columns of its own and the rule is applied here. It is
 *    the same rule `src/vex-agent/sync/agentscan-report/lighter-fill-event.ts`
 *    applies at `feeDenominationAsset` (line 513), re-stated rather than
 *    imported because that helper and `LIGHTER_SPOT_MARKET_INDEX_FLOOR` beside
 *    it are both module-private there. The floor (2048) is the venue's own
 *    spot-market index boundary, pinned in this module's test beside its
 *    citation.
 *
 * 3. LEVERAGE IS DISPLAYED BY THE ONE OWNER OF THE UNIT.
 *    `initialMarginFractionToLeverageDisplay` (`@tools/lighter/margin-fraction.js`)
 *    is imported, never mirrored: it is the module that owns Lighter's
 *    10000-scale fraction and it truncates to two decimals (3334 -> "2.99")
 *    because rounding up would tell the user they hold leverage the exchange
 *    will not give them. It THROWS on a value outside 1..10000; a stored
 *    fraction outside that range is data this reader cannot interpret, so it
 *    degrades to `leverage: null` ("unknown") rather than taking a page down.
 *
 * 4. A MALFORMED FACT IS UNKNOWN, NEVER A GUESS, and it never takes its
 *    neighbours with it. The ledger's own columns are CHECK-constrained, so a
 *    malformed value there cannot occur and would fail the DTO parse loudly
 *    rather than ship a number nobody can read. The position JSONB has NO check
 *    behind it, so it is validated by shape here: a malformed optional fact (a
 *    PnL, a price, the leverage, the margin mode) becomes null while the
 *    readable facts beside it survive, and only a malformed `size` - the one
 *    fact that makes a position a position - collapses the whole position to
 *    "open, details unavailable".
 */

import { initialMarginFractionToLeverageDisplay } from "@tools/lighter/margin-fraction.js";
import { z } from "zod";
import {
  AGENT_SCAN_LIGHTER_TEXT_BOUNDS,
  lighterSignedDecimalSchema,
  lighterUnsignedDecimalSchema,
  type AgentScanLighterFillEntry,
  type AgentScanLighterPositionNow,
} from "@shared/schemas/agent-scan-lighter-entry.js";
import { TOKEN_SYMBOL_MAX_LENGTH } from "@shared/token-symbol-sanitizer.js";
import type { AgentScanLighterRow } from "./agent-scan-lighter-types.js";

/**
 * The venue's own spot-market index boundary: a market index at or above it is
 * a SPOT market, below it a perpetual. Measured and recorded by the engine's
 * wire mapper (`lighter-fill-event.ts:85` and
 * `tools/protocols/lighter/agentscan-activity.ts:95`), which keeps its own copy
 * private; this is the reader's.
 */
export const LIGHTER_SPOT_MARKET_INDEX_FLOOR = 2048;

/** Lighter's 10000-scale initial margin fraction: 1 = 10000x, 10000 = 1x. */
const MIN_INITIAL_MARGIN_FRACTION = 1;
const MAX_INITIAL_MARGIN_FRACTION = 10_000;

/**
 * Counted observations a reader may log. Values NEVER travel on it - a position
 * figure is the user's money, and the whole point of the count is that the log
 * can say "one market's stored position could not be read" without saying what
 * it held.
 */
export interface AgentScanLighterMappingStats {
  /** Markets observed OPEN whose stored position JSON could not be read. */
  unreadablePositions: number;
}

// ── Scalar coercion ───────────────────────────────────────────────────────

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** An `INTEGER` column as a number, or null when it is not readable as one. */
function toInteger(value: number | string | null): number | null {
  if (value === null) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

/**
 * Non-negative decimals for a venue asset. Out of range is data this reader
 * cannot interpret; the DTO refuses a negative, so 0 is the honest floor.
 */
function toDecimals(value: number | string | null): number {
  const numeric = toInteger(value);
  return numeric !== null && numeric >= 0 ? numeric : 0;
}

/**
 * A tolerant display string, already SQL-clamped to the same bound. This is a
 * guard against drift, not a routine truncation: it keeps an over-long value
 * from failing output validation and blanking the whole page.
 */
function boundedText(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** The same, for a column the DTO requires. */
function requiredText(value: string | null, max: number, fallback: string): string {
  return boundedText(value, max) ?? fallback;
}

/**
 * A leverage reading from a 10000-scale fraction, or null when there is none to
 * read. Null and out-of-range are the SAME answer here - "unknown" - because a
 * fraction the unit owner refuses is not a leverage this feed may state.
 */
function toLeverage(
  fraction: number | string | null,
): AgentScanLighterFillEntry["leverage"] {
  const imf = toInteger(fraction);
  if (imf === null) return null;
  if (imf < MIN_INITIAL_MARGIN_FRACTION || imf > MAX_INITIAL_MARGIN_FRACTION) return null;
  return { initialMarginFraction: imf, display: initialMarginFractionToLeverageDisplay(imf) };
}

// ── The stored position JSONB ─────────────────────────────────────────────

/**
 * The stored shape of one open position
 * (`src/vex-agent/sync/lighter-position-snapshot.ts`'s
 * `LighterObservedPosition`), validated at THIS boundary rather than left for
 * the DTO parse to meet first.
 *
 * `size` is the only required fact: it is what makes the row a position at all,
 * and a position without a readable size is not a position with one unknown
 * field. Every other fact `.catch(null)`s independently, which is also what
 * makes an observation stored BEFORE leverage and margin mode were projected
 * read correctly: the keys are simply absent and become null.
 *
 * `marketIndex` and `marketSymbol` are stored on the row too and are
 * deliberately NOT read: the fill already names its own market, and a second
 * copy of that name on the same line could only ever disagree with it.
 */
const storedPositionSchema = z.object({
  size: lighterSignedDecimalSchema,
  entryPrice: lighterUnsignedDecimalSchema.nullable().catch(null),
  unrealizedPnl: lighterSignedDecimalSchema.nullable().catch(null),
  realizedPnl: lighterSignedDecimalSchema.nullable().catch(null),
  liquidationPrice: lighterUnsignedDecimalSchema.nullable().catch(null),
  /** 10000-scale integer, projected from the account endpoint's percent string. */
  initialMarginFraction: z
    .number()
    .int()
    .min(MIN_INITIAL_MARGIN_FRACTION)
    .max(MAX_INITIAL_MARGIN_FRACTION)
    .nullable()
    .catch(null),
  marginMode: z
    .string()
    .max(AGENT_SCAN_LIGHTER_TEXT_BOUNDS.marginMode)
    .nullable()
    .catch(null),
});

/**
 * The market's newest observed state, as CONTEXT beside a historical fill.
 *
 * FOUR outcomes, and each is a different sentence the renderer owes the user:
 *
 *   no row at all      -> `null`: Vex has never observed this market.
 *   `open = false`     -> observed CLOSED (migration 152 stores `position` NULL
 *                         with it), and the observation time still travels.
 *   `open = true`, read -> the position as last observed.
 *   `open = true`, unread -> "open, details unavailable": the observation is a
 *                         fact even when the details behind it are not, and
 *                         hiding it would understate what Vex knows.
 *
 * `observedAt` is VEX'S OWN observation time, assigned by the position sweep
 * (`src/vex-agent/sync/lighter-position-snapshot.ts:528`), not a venue
 * timestamp and not the fill's. It is on every one of these states because
 * these are facts about THEN, beside a fill that happened earlier.
 */
function toPositionNow(
  row: AgentScanLighterRow,
  stats: AgentScanLighterMappingStats | undefined,
): AgentScanLighterPositionNow | null {
  if (row.position_observed_at === null || row.position_open === null) return null;
  const observedAt = toIso(row.position_observed_at);
  if (!row.position_open) return { observedAt, open: false, position: null };

  const parsed = storedPositionSchema.safeParse(row.position_now);
  if (!parsed.success) {
    if (stats !== undefined) stats.unreadablePositions += 1;
    return { observedAt, open: true, position: null };
  }
  const stored = parsed.data;
  return {
    observedAt,
    open: true,
    position: {
      size: stored.size,
      entryPrice: stored.entryPrice,
      unrealizedPnl: stored.unrealizedPnl,
      realizedPnl: stored.realizedPnl,
      liquidationPrice: stored.liquidationPrice,
      leverage: toLeverage(stored.initialMarginFraction),
      marginMode: boundedText(stored.marginMode, AGENT_SCAN_LIGHTER_TEXT_BOUNDS.marginMode),
    },
  };
}

// ── Fees ──────────────────────────────────────────────────────────────────

interface VenueAsset {
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * The asset this fill's fees are denominated in: the received BASE on a spot
 * buy, the QUOTE asset otherwise. The venue's own behaviour, established by
 * `order-evidence.ts` and applied identically by the AgentScan wire mapper
 * (`lighter-fill-event.ts:513`).
 */
function feeDenominationAsset(
  side: string,
  spot: boolean,
  baseAsset: VenueAsset,
  quoteAsset: VenueAsset,
): VenueAsset {
  return spot && side === "buy" ? baseAsset : quoteAsset;
}

function mapIntegratorFee(
  row: AgentScanLighterRow,
): AgentScanLighterFillEntry["integratorFee"] {
  // The ledger's own asset columns: any integrator fee figure is refused by
  // migration 152's CHECK unless all three are present beside it.
  const symbol = boundedText(row.integrator_fee_asset_symbol, TOKEN_SYMBOL_MAX_LENGTH);
  const decimals = toDecimals(row.integrator_fee_asset_decimals);
  const asset = symbol === null ? null : { symbol, decimals };

  // NULL means UNPROVEN and stays null. Substituting "0" here would report a
  // charge of zero that nobody measured.
  const charged = row.integrator_fee_charged_raw !== null && asset !== null
    ? { raw: row.integrator_fee_charged_raw, symbol: asset.symbol, decimals: asset.decimals }
    : null;

  const estimate = row.integrator_fee_estimated_raw !== null
    && row.integrator_fee_estimate_basis !== null
    && row.integrator_fee_estimate_tick_source !== null
    && asset !== null
    ? {
        raw: row.integrator_fee_estimated_raw,
        symbol: asset.symbol,
        decimals: asset.decimals,
        basis: requiredText(
          row.integrator_fee_estimate_basis,
          AGENT_SCAN_LIGHTER_TEXT_BOUNDS.feeBasis,
          "unknown",
        ),
        tickSource: requiredText(
          row.integrator_fee_estimate_tick_source,
          AGENT_SCAN_LIGHTER_TEXT_BOUNDS.feeTickSource,
          "unknown",
        ),
        // NULL for the integrator fee on a spot BUY, which is charged in the
        // received base and keeps that denomination (migration 152).
        usd: row.integrator_fee_estimated_usd,
      }
    : null;

  return {
    charged,
    estimate,
    tickObserved: toInteger(row.integrator_fee_tick_observed),
    tickAuthorized: toInteger(row.integrator_fee_tick_authorized),
  };
}

function mapExchangeFee(
  row: AgentScanLighterRow,
  asset: VenueAsset,
): AgentScanLighterFillEntry["exchangeFee"] {
  return {
    // Signed: the exchange reports a rebate as a negative charged amount, and
    // the DTO admits the sign rather than presenting a rebate as a charge.
    charged: row.exchange_fee_charged_raw === null
      ? null
      : { raw: row.exchange_fee_charged_raw, symbol: asset.symbol, decimals: asset.decimals },
    estimatedUsd: row.exchange_fee_estimated_usd,
    tickObserved: toInteger(row.exchange_fee_tick_observed),
  };
}

// ── The row ───────────────────────────────────────────────────────────────

/**
 * One `lighter_fills` row plus its market's newest observation -> one feed
 * entry.
 *
 * @param stats optional counter the caller may log; values never travel on it.
 */
export function mapAgentScanLighterRow(
  row: AgentScanLighterRow,
  stats?: AgentScanLighterMappingStats,
): AgentScanLighterFillEntry {
  const marketIndex = toInteger(row.market_index) ?? 0;
  const spot = marketIndex >= LIGHTER_SPOT_MARKET_INDEX_FLOOR;
  const side = requiredText(row.side, AGENT_SCAN_LIGHTER_TEXT_BOUNDS.side, "unknown");

  const baseAsset: VenueAsset = {
    symbol: requiredText(row.base_asset_symbol, TOKEN_SYMBOL_MAX_LENGTH, "unknown"),
    decimals: toDecimals(row.base_asset_decimals),
  };
  const quoteAsset: VenueAsset = {
    symbol: requiredText(row.quote_asset_symbol, TOKEN_SYMBOL_MAX_LENGTH, "unknown"),
    decimals: toDecimals(row.quote_asset_decimals),
  };

  return {
    source: "lighter_fill",
    id: row.source_id,
    // `traded_at` is the VENUE's match time and the feed time of this row;
    // `observed_at` is when Vex saw it, and the two are different facts.
    createdAt: toIso(row.traded_at),
    observedAt: toIso(row.observed_at),
    environment: requiredText(
      row.environment,
      AGENT_SCAN_LIGHTER_TEXT_BOUNDS.environment,
      "unknown",
    ),
    marketIndex,
    marketSymbol: requiredText(
      row.market_symbol,
      AGENT_SCAN_LIGHTER_TEXT_BOUNDS.marketSymbol,
      String(marketIndex),
    ),
    spot,
    side,
    tradeType: requiredText(
      row.trade_type,
      AGENT_SCAN_LIGHTER_TEXT_BOUNDS.tradeType,
      "unknown",
    ),
    // NULL is a real state: the account's own half was never supplied, and the
    // renderer says "position facts unknown" rather than inventing an effect.
    positionEffect: boundedText(
      row.position_effect,
      AGENT_SCAN_LIGHTER_TEXT_BOUNDS.positionEffect,
    ),
    baseSize: row.base_size,
    price: row.price,
    quoteNotional: row.quote_notional,
    usdAmount: row.usd_amount,
    blockHeight: row.block_height,
    baseAsset,
    quoteAsset,
    positionSizeBefore: row.position_size_before,
    entryQuoteBefore: row.entry_quote_before,
    accountPnl: row.account_pnl,
    leverage: toLeverage(row.initial_margin_fraction_before),
    feeSide: requiredText(row.fee_side, AGENT_SCAN_LIGHTER_TEXT_BOUNDS.feeSide, "unknown"),
    integratorFee: mapIntegratorFee(row),
    exchangeFee: mapExchangeFee(
      row,
      feeDenominationAsset(side, spot, baseAsset, quoteAsset),
    ),
    providerTradeId: row.provider_trade_id,
    providerOrderId: row.provider_order_id,
    intentId: row.execution_intent_id,
    positionNow: toPositionNow(row, stats),
  };
}
