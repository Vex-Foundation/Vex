/**
 * Input contract for the six PER-MARKET / PER-ASSET Pendle READ tools:
 * `pendle.market.get`, `.history`, `.candles`, `pendle.orderbook`,
 * `pendle.rewards.merkle` and `pendle.prices.assets`.
 *
 * SEPARATE from `read-params.ts`, which owns the two PORTFOLIO-shaped read tools
 * (`pendle.yields`, `pendle.position.value`). The two files change for different
 * reasons — that one moves when the screening and portfolio vocabularies move,
 * this one moves when Pendle's per-market query surface moves — and they share
 * only the rejection TYPE, so both lanes speak one failure vocabulary. The
 * primitive readers live in `read-param-readers.ts`.
 *
 * REJECT BY NAME, NEVER SILENTLY DROP. The protocol runtime already refuses an
 * undeclared key and a wrong-typed value. What it cannot see is a well-typed
 * value outside the domain — `timeFrame: "minute"`, `precision: 7`, a 400-day
 * hourly window, an id belonging to another chain. Each of those is refused here
 * with the offending PARAM NAME and the accepted set, because a model that
 * believes it read minute candles carries that mistake into every later step.
 */

import {
  PENDLE_READ_ASSET_PRICE_TYPES,
  PENDLE_READ_HISTORY_FIELDS,
  type PendleReadAssetPriceType,
  type PendleReadHistoryField,
  type PendleReadTimeFrame,
} from "@tools/pendle/read/types.js";
import { PENDLE_READ_MAX_ORDERBOOK_PRECISION } from "@tools/pendle/read/request.js";
import type { PendleReadParams } from "./read-params.js";
import {
  checkSeriesWindow,
  isAddress,
  readOptionalInstantMs,
  readOptionalInteger,
  readOptionalString,
  readTimeFrame,
  reject,
  requireAddressParam,
  requireChain,
} from "./read-param-readers.js";

// ── Bounds (every one of them declared, echoed and refused by name) ─

/**
 * Hard ceiling on points a single series request may cover. Matches the read
 * shelf's candle row cap so history and candles bound identically: 1,440 is 60
 * days of hourly or ~4 years of daily. A window past it is REFUSED with the
 * computed count rather than served as a silent prefix (owner no-truncation
 * rule).
 */
export const PENDLE_READ_MAX_SERIES_POINTS = 1440;

/** Provider-side cap we impose on one price lookup, so the payload stays bounded. */
export const PENDLE_PRICES_MAX_IDS = 50;

/** Default page size when `pendle.prices.assets` is called without ids. */
export const PENDLE_PRICES_DEFAULT_LIMIT = 50;

/** Provider page ceiling for `/v1/prices/assets`. */
export const PENDLE_PRICES_MAX_LIMIT = 100;

/** Default depth levels per side on `pendle.orderbook`. */
export const PENDLE_ORDERBOOK_DEFAULT_LEVELS = 10;

/**
 * Hard ceiling on depth levels returned PER SIDE.
 *
 * This parser is the only bound the order-book read has: unlike the candle
 * decoder, `read/validation/orderbook.ts` caps no rows — it normalizes every
 * entry the provider sent — so an unbounded `limit` would let a book decide how
 * much of the agent's context it occupies. The live books measured on 2026-07-27
 * carried at most ten levels a side (five without AMM depth merged), so fifty is
 * far above anything observed while still being a number. `levelCounts` always
 * reports what actually exists, so raising the ceiling can never be needed to
 * learn the true depth.
 */
export const PENDLE_ORDERBOOK_MAX_LEVELS = 50;

/** Provider-required rounding of the order book's implied-APY axis. */
export const PENDLE_ORDERBOOK_DEFAULT_PRECISION = 2;

/**
 * Default series fields: the three a fixed-yield decision actually turns on —
 * the rate being locked, the rate it is being locked against, and whether the
 * market is deep enough to exit. Naming fields also keeps the CU cost at the
 * narrow-window price instead of the provider's default set.
 */
export const PENDLE_HISTORY_DEFAULT_FIELDS: readonly PendleReadHistoryField[] = ["impliedApy", "underlyingApy", "tvl"];

// ── pendle.market.get ───────────────────────────────────────────────

/** Which param carried the address — echoed so the answer names what was asked. */
export type PendleMarketIdentifier = "market" | "pt" | "yt";

export interface PendleMarketGetQuery {
  chainId: number;
  /** Bare lowercase 0x — the market, PT or YT address. */
  address: string;
  addressParam: PendleMarketIdentifier;
}

const MARKET_IDENTIFIERS: readonly PendleMarketIdentifier[] = ["market", "pt", "yt"];

/**
 * `chain` plus EXACTLY ONE of `market` / `pt` / `yt`.
 *
 * Two identifiers are refused rather than resolved by precedence: a model that
 * passes a PT and a market that do not belong together is confused about its own
 * position, and answering for one of them hides that.
 */
export function parsePendleMarketGetParams(p: Record<string, unknown>): PendleReadParams<PendleMarketGetQuery> {
  const chain = requireChain(p.chain);
  if (!chain.ok) return chain;

  const supplied = MARKET_IDENTIFIERS.filter((key) => readOptionalString(p[key]) !== undefined);
  const first = supplied[0];
  if (first === undefined) {
    return reject(
      "market",
      "name exactly one of `market`, `pt` or `yt` — the market (LP) address, the principal-token address, or the yield-token address.",
    );
  }
  if (supplied.length > 1) {
    return reject(
      first,
      `name exactly ONE of \`market\`, \`pt\` or \`yt\`; received ${supplied.map((k) => `\`${k}\``).join(" and ")}. ` +
        "Passing two is refused rather than resolved, because they may not describe the same market.",
    );
  }

  const address = requireAddressParam(p[first], first);
  if (!address.ok) return address;
  return { ok: true, value: { chainId: chain.value, address: address.value, addressParam: first } };
}

// ── pendle.market.history ───────────────────────────────────────────

export interface PendleMarketHistoryQuery {
  chainId: number;
  market: string;
  timeFrame: PendleReadTimeFrame;
  fields: PendleReadHistoryField[];
  /** ISO bounds, echoed verbatim into the provider's `timestamp_start`/`_end`. */
  fromIso: string | undefined;
  toIso: string | undefined;
}

export function parsePendleMarketHistoryParams(
  p: Record<string, unknown>,
  nowMs: number,
): PendleReadParams<PendleMarketHistoryQuery> {
  const chain = requireChain(p.chain);
  if (!chain.ok) return chain;
  const market = requireAddressParam(p.market, "market");
  if (!market.ok) return market;
  const timeFrame = readTimeFrame(p.timeFrame);
  if (!timeFrame.ok) return timeFrame;

  const fields = parseHistoryFields(p.fields);
  if (!fields.ok) return fields;

  const from = readOptionalInstantMs(p.from, "from");
  if (!from.ok) return from;
  const to = readOptionalInstantMs(p.to, "to");
  if (!to.ok) return to;
  const window = checkSeriesWindow(from.value, to.value, timeFrame.value, nowMs, PENDLE_READ_MAX_SERIES_POINTS);
  if (!window.ok) return window;

  return {
    ok: true,
    value: {
      chainId: chain.value,
      market: market.value,
      timeFrame: timeFrame.value,
      fields: fields.value,
      fromIso: from.value === undefined ? undefined : new Date(from.value).toISOString(),
      toIso: to.value === undefined ? undefined : new Date(to.value).toISOString(),
    },
  };
}

/**
 * The selectable field list is a CLOSED allowlist because the provider is not
 * uniformly strict: it answers HTTP 400 for `feeRate` and `liquidity`, so an
 * unchecked field would turn a whole read into a transport error the agent
 * cannot act on. Refusing here names the offender and the accepted set.
 */
function parseHistoryFields(raw: unknown): PendleReadParams<PendleReadHistoryField[]> {
  const value = readOptionalString(raw);
  if (value === undefined) return { ok: true, value: [...PENDLE_HISTORY_DEFAULT_FIELDS] };

  const out: PendleReadHistoryField[] = [];
  for (const token of value.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
    const match = PENDLE_READ_HISTORY_FIELDS.find((f) => f.toLowerCase() === token.toLowerCase());
    if (match === undefined) {
      return reject(
        "fields",
        `\`fields\` contains "${token}", which this endpoint does not serve. Selectable: ${PENDLE_READ_HISTORY_FIELDS.join(", ")}.`,
      );
    }
    if (!out.includes(match)) out.push(match);
  }
  if (out.length === 0) return { ok: true, value: [...PENDLE_HISTORY_DEFAULT_FIELDS] };
  return { ok: true, value: out };
}

// ── pendle.market.candles ───────────────────────────────────────────

export interface PendleMarketCandlesQuery {
  chainId: number;
  /** PT / YT / LP contract, bare lowercase 0x. */
  asset: string;
  timeFrame: PendleReadTimeFrame;
  /**
   * ISO bounds, exactly as `pendle.market.history` takes them.
   *
   * The endpoint is asymmetric and it has caught us once already: its RESPONSE
   * rows carry unix-second timestamps, but a unix-seconds REQUEST bound is a
   * 400 ("timestamp_start must be a Date instance"). Live-verified 2026-07-27.
   */
  fromIso: string | undefined;
  toIso: string | undefined;
}

export function parsePendleMarketCandlesParams(
  p: Record<string, unknown>,
  nowMs: number,
): PendleReadParams<PendleMarketCandlesQuery> {
  const chain = requireChain(p.chain);
  if (!chain.ok) return chain;
  const asset = requireAddressParam(p.asset, "asset");
  if (!asset.ok) return asset;
  const timeFrame = readTimeFrame(p.timeFrame);
  if (!timeFrame.ok) return timeFrame;

  const from = readOptionalInstantMs(p.from, "from");
  if (!from.ok) return from;
  const to = readOptionalInstantMs(p.to, "to");
  if (!to.ok) return to;
  const window = checkSeriesWindow(from.value, to.value, timeFrame.value, nowMs, PENDLE_READ_MAX_SERIES_POINTS);
  if (!window.ok) return window;

  return {
    ok: true,
    value: {
      chainId: chain.value,
      asset: asset.value,
      timeFrame: timeFrame.value,
      fromIso: from.value === undefined ? undefined : new Date(from.value).toISOString(),
      toIso: to.value === undefined ? undefined : new Date(to.value).toISOString(),
    },
  };
}

// ── pendle.orderbook ────────────────────────────────────────────────

export interface PendleOrderbookQuery {
  chainId: number;
  market: string;
  /** Provider-required rounding of the implied-APY axis, 0-3. */
  precision: number;
  /** Levels per side to return. */
  limit: number;
}

export function parsePendleOrderbookParams(p: Record<string, unknown>): PendleReadParams<PendleOrderbookQuery> {
  const chain = requireChain(p.chain);
  if (!chain.ok) return chain;
  const market = requireAddressParam(p.market, "market");
  if (!market.ok) return market;

  const precision = readOptionalInteger(p.precision, "precision", { min: 0, max: PENDLE_READ_MAX_ORDERBOOK_PRECISION });
  if (!precision.ok) return precision;
  const limit = readOptionalInteger(p.limit, "limit", { min: 1, max: PENDLE_ORDERBOOK_MAX_LEVELS });
  if (!limit.ok) return limit;

  return {
    ok: true,
    value: {
      chainId: chain.value,
      market: market.value,
      precision: precision.value ?? PENDLE_ORDERBOOK_DEFAULT_PRECISION,
      limit: limit.value ?? PENDLE_ORDERBOOK_DEFAULT_LEVELS,
    },
  };
}

// ── pendle.rewards.merkle ───────────────────────────────────────────

/**
 * The ONLY input is an optional chain filter.
 *
 * There is deliberately no wallet param: the wallet is the session's selected
 * one, resolved in the handler through the same path `pendle.position.value`
 * uses. Accepting an address from model output would make the tool a
 * third-party balance probe (rules/06 — data minimisation).
 */
export interface PendleMerkleRewardsQuery {
  chainId: number | undefined;
}

export function parsePendleMerkleRewardsParams(
  p: Record<string, unknown>,
): PendleReadParams<PendleMerkleRewardsQuery> {
  const raw = readOptionalString(p.chain);
  if (raw === undefined) return { ok: true, value: { chainId: undefined } };
  const chain = requireChain(raw);
  if (!chain.ok) return chain;
  return { ok: true, value: { chainId: chain.value } };
}

// ── pendle.prices.assets ────────────────────────────────────────────

export interface PendleAssetPricesQuery {
  chainId: number;
  /** `chainId-address` composites, already scoped to `chainId`. */
  ids: string[] | undefined;
  types: PendleReadAssetPriceType[] | undefined;
  limit: number;
  offset: number;
}

export function parsePendleAssetPricesParams(p: Record<string, unknown>): PendleReadParams<PendleAssetPricesQuery> {
  const chain = requireChain(p.chain);
  if (!chain.ok) return chain;

  const ids = parseAssetIds(p.ids, chain.value);
  if (!ids.ok) return ids;
  const types = parseAssetTypes(p.type);
  if (!types.ok) return types;

  const limit = readOptionalInteger(p.limit, "limit", { min: 1, max: PENDLE_PRICES_MAX_LIMIT });
  if (!limit.ok) return limit;
  const offset = readOptionalInteger(p.offset, "offset", { min: 0 });
  if (!offset.ok) return offset;

  return {
    ok: true,
    value: {
      chainId: chain.value,
      ids: ids.value,
      types: types.value,
      limit: limit.value ?? PENDLE_PRICES_DEFAULT_LIMIT,
      offset: offset.value ?? 0,
    },
  };
}

/**
 * Bare addresses and `chainId-address` composites both accepted; both leave as
 * composites scoped to the requested chain.
 *
 * A composite naming ANOTHER chain is refused by name. The endpoint would simply
 * return nothing for it, and "Pendle does not price this asset" and "you asked
 * the wrong chain" are different answers.
 */
function parseAssetIds(raw: unknown, chainId: number): PendleReadParams<string[] | undefined> {
  const value = readOptionalString(raw);
  if (value === undefined) return { ok: true, value: undefined };

  const tokens = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (tokens.length > PENDLE_PRICES_MAX_IDS) {
    return reject(
      "ids",
      `\`ids\` carried ${tokens.length} entries; the cap is ${PENDLE_PRICES_MAX_IDS} per call. Split the request.`,
    );
  }

  const out: string[] = [];
  for (const token of tokens) {
    const separator = token.indexOf("-");
    const address = separator >= 0 ? token.slice(separator + 1) : token;
    if (!isAddress(address)) {
      return reject("ids", `\`ids\` contains "${token}", which is not an address or a chainId-address id.`);
    }
    if (separator >= 0) {
      const idChain = Number(token.slice(0, separator));
      if (!Number.isInteger(idChain) || idChain !== chainId) {
        return reject(
          "ids",
          `\`ids\` contains "${token}", which belongs to chain ${token.slice(0, separator)} while \`chain\` resolved to ${chainId}. ` +
            "One call reads one chain.",
        );
      }
    }
    const composite = `${chainId}-${address.toLowerCase()}`;
    if (!out.includes(composite)) out.push(composite);
  }
  return { ok: true, value: out.length > 0 ? out : undefined };
}

function parseAssetTypes(raw: unknown): PendleReadParams<PendleReadAssetPriceType[] | undefined> {
  const value = readOptionalString(raw);
  if (value === undefined) return { ok: true, value: undefined };

  const out: PendleReadAssetPriceType[] = [];
  for (const token of value.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
    const match = PENDLE_READ_ASSET_PRICE_TYPES.find((t) => t.toLowerCase() === token.toLowerCase());
    if (match === undefined) {
      return reject(
        "type",
        `\`type\` must be one of: ${PENDLE_READ_ASSET_PRICE_TYPES.join(", ")}. Received "${token}".`,
      );
    }
    if (!out.includes(match)) out.push(match);
  }
  return { ok: true, value: out.length > 0 ? out : undefined };
}
