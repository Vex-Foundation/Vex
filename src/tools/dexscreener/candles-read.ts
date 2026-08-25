/**
 * Recent candles for ONE pool, for non-agent consumers.
 *
 * S11b. The sibling of the price-read seam and the same kind of owner: the
 * agent's own tool surface composes `pair-subject` and `bars` itself, with a
 * cursor, a page budget and a full walk report, because a model needs every one
 * of those facts. A widget or a hydration step does not: it needs the last N
 * completed buckets of one known pool, or a failure it can degrade around. This
 * module is that narrow contract, so the composition lives here once instead of
 * being re-derived by every non-agent caller.
 *
 * WHY THE SUBJECT IS RESOLVED RATHER THAN CONSTRUCTED. The chart route is keyed
 * by `ammId` and by the pool's OWN quote token, and it answers HTTP 200 with a
 * SILENTLY INVERTED series when the quote token is wrong, absent, or merely
 * lower-cased - measured at seventeen orders of magnitude, with no error and no
 * way to tell from the rows (see the invariant recorded on
 * `PairSubject.quoteTokenAddress`). Neither key may be hand-written or re-cased,
 * so both are read from the provider's own pair snapshot here and forwarded
 * verbatim. Callers pass a pool identity and never these keys.
 *
 * TRANSPORT. The chart route lives on a site host, so a caller with the
 * degraded default transport gets the transport's own typed refusal rather
 * than data. That is a named outcome, not an outage: `readRecentCandles` lets
 * it propagate so the caller can degrade (a sparkline is supplementary) instead
 * of a null being mistaken for "this pool has no history".
 */

import { walkBars, type BarResolution } from "./endpoints/bars.js";
import {
  resolvePairSubject,
  type PairSubject,
} from "./endpoints/pair-subject.js";
import { getDexScreenerTransport } from "./transport.js";

/** Deadline for ONE provider exchange, in milliseconds. */
const DEFAULT_EXCHANGE_TIMEOUT_MS = 8_000;

/**
 * Deadline for the whole read, in milliseconds.
 *
 * Two exchanges at most (resolve, then one page of bars), so this bounds the
 * pair rather than each half.
 */
const DEFAULT_DEADLINE_MS = 20_000;

/**
 * Buckets one page can carry.
 *
 * The provider serves up to 999 bars per call on both transports, so any
 * request the widget or a board hydration makes is satisfied by a single page.
 * A caller asking for more than this is asking for a walk, which is the agent
 * tool's job, not this seam's.
 */
export const RECENT_CANDLES_MAX = 999;

/** Which pool to read. Both fields are the provider's own spelling. */
export interface CandleSubject {
  readonly chainId: string;
  /**
   * The pool address, in the provider's CHECKSUM spelling on EVM chains and
   * verbatim on Solana. The lowercased form is answered with zero rows.
   */
  readonly pairAddress: string;
}

/**
 * One completed-or-forming bucket.
 *
 * Prices stay DECIMAL STRINGS exactly as the provider sent them. These are
 * token amounts on a money path and are never round-tripped through binary
 * floating point by this module; a consumer that needs a number parses one at
 * its own display boundary and owns that loss.
 */
export interface RecentCandle {
  readonly timestampMs: number;
  readonly openUsd: string | null;
  readonly highUsd: string | null;
  readonly lowUsd: string | null;
  readonly closeUsd: string | null;
}

export interface RecentCandles {
  /** Oldest first. At most `limit` buckets, the NEWEST ones. */
  readonly candles: readonly RecentCandle[];
  readonly resolution: BarResolution;
  /**
   * True when the newest bucket is still forming, so its close is not final.
   *
   * The provider always returns the forming bucket, and two reads seconds apart
   * were measured differing on it alone. A consumer that draws a line may keep
   * it; a consumer that quotes a close must know it is provisional.
   */
  readonly lastBarPartial: boolean;
  /** The pool the series is actually for, after resolution. */
  readonly subject: PairSubject;
  readonly fetchedAtMs: number;
}

export interface ReadRecentCandlesOptions {
  readonly subject: CandleSubject;
  readonly resolution: BarResolution;
  /** Newest buckets to return, 1..999. */
  readonly limit: number;
  /**
   * A subject already resolved by the caller, to skip the resolve exchange.
   *
   * `ammId` and `quoteTokenAddress` do not change for the life of a pool, so a
   * caller polling one pool resolves once and passes it back. It is accepted
   * ONLY as a whole `PairSubject` this module produced: accepting the two keys
   * separately would put the inverted-series footgun back in a caller's hands.
   */
  readonly resolvedSubject?: PairSubject;
  readonly timeoutMs?: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Read the newest `limit` buckets of one pool.
 *
 * Throws on a provider or transport failure, and on a refusal by the degraded
 * transport. An EMPTY series is returned as an empty list, not as an error:
 * the provider's empty page is measured ambiguous between "no history" and "no
 * such pool", so this module reports what it got rather than resolving that
 * ambiguity by assertion.
 */
export async function readRecentCandles(
  options: ReadRecentCandlesOptions,
): Promise<RecentCandles> {
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > RECENT_CANDLES_MAX
  ) {
    throw new RangeError(
      `candle limit must be a whole number of 1..${RECENT_CANDLES_MAX}, received ${String(options.limit)}`,
    );
  }

  const transport = getDexScreenerTransport();
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;

  const subject =
    options.resolvedSubject ??
    (await resolvePairSubject({
      transport,
      chainId: options.subject.chainId,
      pairAddress: options.subject.pairAddress,
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));

  const walk = await walkBars({
    transport,
    chainId: subject.chainId,
    pairAddress: subject.pairAddress,
    ammId: subject.ammId,
    // Verbatim from the resolved subject. Never re-cased, never caller-supplied.
    quoteTokenAddress: subject.quoteTokenAddress,
    resolution: options.resolution,
    series: "price",
    inverted: false,
    limit: options.limit,
    // One page holds up to 999 buckets, so a second page could only return
    // candles older than the caller asked for.
    maxPages: 1,
    deadlineMs,
    timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  // The newest `limit` buckets. Every bucket dropped here is older than the
  // caller's own window, which is a bound the caller set, not a hidden cut.
  const newest = walk.bars.slice(-options.limit);
  return {
    candles: newest.map((bar) => ({
      timestampMs: bar.timestampMs,
      openUsd: bar.openUsd,
      highUsd: bar.highUsd,
      lowUsd: bar.lowUsd,
      closeUsd: bar.closeUsd,
    })),
    resolution: options.resolution,
    // The provider always serves the forming bucket, so a non-empty answer's
    // newest row is partial by construction.
    lastBarPartial: newest.length > 0,
    subject,
    fetchedAtMs: walk.fetchedAtMs,
  };
}
