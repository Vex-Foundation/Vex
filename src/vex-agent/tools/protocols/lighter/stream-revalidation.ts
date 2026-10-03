import type { LighterEnvironment } from "@tools/lighter/constants.js";
import type { LighterMarketType, LighterOrderBookOrdersResponse } from "@tools/lighter/types.js";

/**
 * SWITCH `LIGHTER_STREAM_REVALIDATION` (default OFF).
 *
 * ON lets post-approval revalidation take the order book's best ask and best
 * bid from the main-process public WebSocket book for that market, instead of
 * a REST `/orderBookOrders` read, when that book is live and its last applied
 * frame arrived at most {@link LIGHTER_STREAM_REVALIDATION_MAX_AGE_MS} ago.
 * Anything less (no live watcher, a stale or future frame, a one-sided or
 * crossed book, a market type that differs from the REST market detail) reads
 * REST exactly as today. Market details, the account, fees, the API key and
 * the nonce always stay REST. OFF never consults the stream.
 *
 * ON for the owner's live canary; `false` is the rollback. The risk: a stream
 * book can lag the provider by up to the max age plus transit, and only a live
 * canary can show that is immaterial next to the REST read it replaces.
 */
export const LIGHTER_STREAM_REVALIDATION = true;

/** A stream book older than this is never used for revalidation. */
export const LIGHTER_STREAM_REVALIDATION_MAX_AGE_MS = 1_500;

/** The live book's top of book, as the main-process public stream holds it. */
export interface LighterStreamOrderBookSnapshot {
  readonly environment: LighterEnvironment;
  readonly marketId: number;
  readonly marketType: LighterMarketType;
  /** Local wall clock (ms) at which the last applied book frame arrived. */
  readonly receivedAtMs: number;
  /** Lowest ask price with a non-zero size, as the provider wrote it. */
  readonly bestAsk: string | null;
  /** Highest bid price with a non-zero size, as the provider wrote it. */
  readonly bestBid: string | null;
}

/**
 * Installed by the main process. Returns the single live book for that market
 * or null; it never opens a subscription or waits.
 */
export type LighterStreamOrderBookReader = (
  environment: LighterEnvironment,
  marketId: number,
) => LighterStreamOrderBookSnapshot | null;

export interface FreshLighterStreamOrderBook {
  readonly snapshot: LighterStreamOrderBookSnapshot;
  readonly ageMs: number;
}

const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/**
 * The stream book when it may stand in for REST, else null. A reader that
 * throws is treated as no book: the stream can only ever speed an order up,
 * never refuse one.
 */
export function takeFreshLighterStreamOrderBook(input: {
  readonly enabled: boolean;
  readonly reader: LighterStreamOrderBookReader | null | undefined;
  readonly environment: LighterEnvironment;
  readonly marketId: number;
  readonly nowMs: number;
}): FreshLighterStreamOrderBook | null {
  if (!input.enabled || input.reader === null || input.reader === undefined) return null;
  let snapshot: LighterStreamOrderBookSnapshot | null;
  try {
    snapshot = input.reader(input.environment, input.marketId);
  } catch {
    return null;
  }
  if (snapshot === null) return null;
  if (snapshot.environment !== input.environment || snapshot.marketId !== input.marketId) return null;
  const ageMs = input.nowMs - snapshot.receivedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > LIGHTER_STREAM_REVALIDATION_MAX_AGE_MS) return null;
  const { bestAsk, bestBid } = snapshot;
  if (bestAsk === null || bestBid === null) return null;
  if (!DECIMAL.test(bestAsk) || !DECIMAL.test(bestBid)) return null;
  if (compareDecimals(bestBid, bestAsk) >= 0) return null;
  return { snapshot, ageMs };
}

/**
 * The REST response shape revalidation reads, carrying only the stream's best
 * level on each side: the order preview reads nothing from the book but the
 * best ask and best bid prices.
 */
export function lighterOrderBookFromStream(
  snapshot: LighterStreamOrderBookSnapshot,
): LighterOrderBookOrdersResponse {
  const level = (price: string) => ({
    order_index: 0,
    order_id: "",
    owner_account_index: 0,
    initial_base_amount: "0",
    remaining_base_amount: "0",
    price,
    order_expiry: 0,
    transaction_time: 0,
  });
  return {
    code: 200,
    total_asks: snapshot.bestAsk === null ? 0 : 1,
    asks: snapshot.bestAsk === null ? [] : [level(snapshot.bestAsk)],
    total_bids: snapshot.bestBid === null ? 0 : 1,
    bids: snapshot.bestBid === null ? [] : [level(snapshot.bestBid)],
  };
}

function compareDecimals(left: string, right: string): number {
  const [leftWhole = "0", leftFraction = ""] = left.split(".");
  const [rightWhole = "0", rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const a = BigInt(`${leftWhole}${leftFraction.padEnd(scale, "0")}`);
  const b = BigInt(`${rightWhole}${rightFraction.padEnd(scale, "0")}`);
  return a === b ? 0 : a < b ? -1 : 1;
}
