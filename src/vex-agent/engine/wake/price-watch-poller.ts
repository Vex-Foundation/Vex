/**
 * Price watch poller - the PULL half of `LoopDefer`'s `token_price` watch.
 *
 * ## Why a poller and not a subscription
 *
 * The bridge watch has a PUSH source: the sync fast lane already detects
 * terminalization and publishes it, so `watch-promoter.ts` only has to listen. A
 * price has no such source in this process. Something has to ask, so this module
 * asks - on its own tick, for exactly the tokens some session is actually
 * sleeping on, and for nothing else.
 *
 * ## Cost is bounded three times over
 *
 *   1. Nothing pending, no request. The pending read is TYPE-FILTERED in
 *      Postgres, so an idle process pays one cheap query and stops.
 *   2. One request per distinct (chain, token), not per session. Ten sessions
 *      watching the same token cost one call.
 *   3. At most {@link PRICE_WATCH_MAX_PAIRS_PER_TICK} distinct pairs per tick,
 *      in a deterministic order, whatever admission let through. The evaluator's
 *      budget check is best-effort (count-then-enqueue is not atomic); THIS is
 *      the bound that actually holds.
 *
 * On top of that the provider's own 30 s edge cache absorbs the 3 s cadence, so
 * the real HTTP rate is roughly 2 requests per minute per watched token.
 *
 * ## Failure loses the EARLY wake, never the wake
 *
 * Any provider error - a 429 parking the rate class, a timeout, a shape the
 * validator refuses - skips the whole tick with ONE warn line. The deferred wake
 * still fires at its `due_at`, because this module can only ever move a deadline
 * earlier. That asymmetry is the entire safety argument for the feature, and it
 * is why nothing here retries.
 *
 * ## Lifetime
 *
 * Started and stopped by `startWakeExecutor`, exactly like the watch promoter: a
 * poller advancing deadlines in a process with no executor to claim them would
 * be pure cost. `stop()` ABANDONS the in-flight wait immediately rather than
 * sitting out a provider deadline, and the tick then promotes NOTHING: the
 * executor that would claim a promoted wake is going away, so a price read a
 * moment earlier is not evidence worth changing a deadline on the way out. The
 * shared provider request itself is left running for whichever other caller
 * wants it - see `DexScreenerRequestOptions`.
 */

import logger from "@utils/logger.js";
import { describeFailureForLog } from "@utils/error-summary.js";

import type { LoopWakeRequest, WakeTriggeredBy } from "../../db/repos/loop-wake.js";
import * as loopWakeRepo from "../../db/repos/loop-wake.js";
import type { DexPair } from "@tools/dexscreener/types.js";
import { selectTokenWatchPrice } from "@tools/dexscreener/token-watch-price.js";
import { isWakeWatchTriggered, type WakeWatchSignal } from "./watch-registry.js";
import {
  TOKEN_PRICE_WATCH_TYPE,
  readTokenPriceConditions,
  type ArmedTokenPriceCondition,
} from "./watch/token-price.js";
import { familyForSlug } from "./watch/token-price/chain-domain.js";
import { registerBuiltInWakeWatchEvaluators } from "./watch/index.js";

/** Poll cadence. The provider's ~30 s edge cache is the real freshness floor. */
export const PRICE_WATCH_POLL_INTERVAL_MS = 3_000;

/** Spread across restarts so parallel installs do not align on the provider. */
export const PRICE_WATCH_POLL_JITTER_MS = 500;

/** Hard per-tick provider cost bound. Matches the evaluator's admission budget. */
export const PRICE_WATCH_MAX_PAIRS_PER_TICK = 12;

/**
 * Per-request deadline. Longer than one tick interval, which is safe because
 * scheduling is single-in-flight (a slow request delays the next tick, it
 * never stacks one on top), and far below the shared 30 s HTTP default so a
 * stalled provider cannot hold a tick hostage for half a minute.
 */
export const PRICE_WATCH_REQUEST_TIMEOUT_MS = 5_000;

export interface PriceWatchPollerDeps {
  readonly getPendingPriceWatches: () => Promise<LoopWakeRequest[]>;
  readonly promotePendingWake: (
    input: loopWakeRepo.PromotePendingWakeInput,
  ) => Promise<boolean>;
  readonly getTokenPairs: (
    chainSlug: string,
    tokenAddress: string,
    options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  ) => Promise<DexPair[]>;
  readonly now: () => Date;
}

export type PriceWatchTickResult =
  /** Nothing is watching a price right now; no provider call was made. */
  | { readonly kind: "idle" }
  /** The provider failed; the tick did nothing and the timers are untouched. */
  | { readonly kind: "skipped_provider_error"; readonly error: string }
  /** The caller cancelled mid-tick; nothing was promoted. */
  | { readonly kind: "aborted" }
  | {
    readonly kind: "polled";
    readonly pairsPolled: number;
    readonly pairsUnpriced: number;
    readonly pairsSkippedOverBudget: number;
    readonly promoted: number;
  };

export interface PriceWatchPollerHandle {
  /** Abort anything in flight and stop scheduling. Resolves once drained. */
  stop(): Promise<void>;
}

export interface PriceWatchPollerOptions {
  intervalMs?: number;
  jitterMs?: number;
  deps?: PriceWatchPollerDeps;
}

export function buildProductionPriceWatchDeps(): PriceWatchPollerDeps {
  return {
    getPendingPriceWatches: () => loopWakeRepo.getPendingWithWatchType(TOKEN_PRICE_WATCH_TYPE),
    promotePendingWake: (input) => loopWakeRepo.promotePendingWake(input),
    getTokenPairs: async (chainSlug, tokenAddress, options) => {
      const { getDexScreenerClient } = await import("@tools/dexscreener/client.js");
      return getDexScreenerClient().getTokenPairs(chainSlug, tokenAddress, options);
    },
    now: () => new Date(),
  };
}

// ── Tick ───────────────────────────────────────────────────────────

interface WatchedPair {
  readonly key: string;
  readonly chain: string;
  readonly tokenAddress: string;
}

interface ParsedWatch {
  readonly wake: LoopWakeRequest;
  readonly watchId: string;
  readonly conditions: readonly ArmedTokenPriceCondition[];
}

function parsePendingWatches(rows: readonly LoopWakeRequest[]): ParsedWatch[] {
  const parsed: ParsedWatch[] = [];
  for (const wake of rows) {
    const watchId = wake.payload?.watchId;
    if (typeof watchId !== "string" || watchId.length === 0) continue;
    const conditions = readTokenPriceConditions(wake.payload);
    if (conditions.length === 0) continue;
    parsed.push({ wake, watchId, conditions });
  }
  return parsed;
}

/**
 * The dedup key for one watched (chain, token).
 *
 * Case-folded for EVM, preserved for base58: folding a Solana mint would let
 * two DIFFERENT mints collide into one key, and only one of them would be
 * polled while the other's watch waited on a price never fetched for it.
 */
function pairKey(chain: string, tokenAddress: string): string {
  const address = familyForSlug(chain) === "solana"
    ? tokenAddress
    : tokenAddress.toLowerCase();
  return `${chain.toLowerCase()}:${address}`;
}

/** Deterministic order, so the same 12 pairs win the budget on every tick. */
function collectWatchedPairs(watches: readonly ParsedWatch[]): WatchedPair[] {
  const byKey = new Map<string, WatchedPair>();
  for (const watch of watches) {
    for (const condition of watch.conditions) {
      const key = pairKey(condition.chain, condition.tokenAddress);
      if (!byKey.has(key)) {
        byKey.set(key, { key, chain: condition.chain, tokenAddress: condition.tokenAddress });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function toSignal(chain: string, tokenAddress: string, priceUsd: string): WakeWatchSignal {
  return {
    type: TOKEN_PRICE_WATCH_TYPE,
    values: { chain, tokenAddress, priceUsd },
  };
}

function triggeredBy(
  condition: ArmedTokenPriceCondition,
  priceUsd: string,
  observedAt: Date,
): WakeTriggeredBy {
  return {
    type: TOKEN_PRICE_WATCH_TYPE,
    chain: condition.chain,
    tokenAddress: condition.tokenAddress,
    direction: condition.direction,
    thresholdUsd: condition.priceUsd,
    observedPriceUsd: priceUsd,
    observedAt: observedAt.toISOString(),
  };
}

/**
 * One pass. Exported so the behavior can be tested without a timer: everything
 * that decides whether a session wakes lives here, and the scheduler below is
 * only cadence.
 */
export async function runPriceWatchTick(
  deps: PriceWatchPollerDeps,
  signal?: AbortSignal,
): Promise<PriceWatchTickResult> {
  registerBuiltInWakeWatchEvaluators();

  const watches = parsePendingWatches(await deps.getPendingPriceWatches());
  if (watches.length === 0) return { kind: "idle" };

  const allPairs = collectWatchedPairs(watches);
  if (allPairs.length === 0) return { kind: "idle" };

  const pairs = allPairs.slice(0, PRICE_WATCH_MAX_PAIRS_PER_TICK);
  const pairsSkippedOverBudget = allPairs.length - pairs.length;
  if (pairsSkippedOverBudget > 0) {
    logger.warn("wake.price_watch.pairs_over_budget", {
      watched: allPairs.length,
      polled: pairs.length,
      skipped: pairsSkippedOverBudget,
    });
  }

  const priceByPair = new Map<string, string>();
  let pairsUnpriced = 0;
  for (const pair of pairs) {
    if (signal?.aborted === true) return { kind: "aborted" };
    let pools: DexPair[];
    try {
      pools = await deps.getTokenPairs(pair.chain, pair.tokenAddress, {
        timeoutMs: PRICE_WATCH_REQUEST_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (err) {
      const error = describeFailureForLog(err);
      // ONE line, and the tick is over. The deferred wakes still fire on time.
      logger.warn("wake.price_watch.provider_unavailable", {
        chain: pair.chain,
        error,
      });
      return { kind: "skipped_provider_error", error };
    }
    const selected = selectTokenWatchPrice(pools, {
      chainSlug: pair.chain,
      tokenAddress: pair.tokenAddress,
      // Base58 identity is case-sensitive; EVM identity is not.
      caseSensitiveAddress: familyForSlug(pair.chain) === "solana",
    });
    if (selected === null) {
      pairsUnpriced += 1;
      continue;
    }
    priceByPair.set(pair.key, selected.priceUsd);
  }

  // An abort means the executor that would claim a promoted wake is going away,
  // so the tick ends here instead of promoting on the way out. Every affected
  // wake still fires on its own timer, as always.
  if (signal?.aborted === true) return { kind: "aborted" };

  const observedAt = deps.now();
  let promoted = 0;
  for (const watch of watches) {
    const matched = findTriggeredCondition(watch, priceByPair);
    if (matched === null) continue;
    const advanced = await deps.promotePendingWake({
      sessionId: watch.wake.sessionId,
      missionRunId: watch.wake.missionRunId,
      watchId: watch.watchId,
      triggeredBy: triggeredBy(matched.condition, matched.priceUsd, observedAt),
    });
    if (!advanced) continue;
    promoted += 1;
    logger.info("wake.price_watch.promoted", {
      wakeId: watch.wake.id,
      sessionId: watch.wake.sessionId,
      chain: matched.condition.chain,
      direction: matched.condition.direction,
      thresholdUsd: matched.condition.priceUsd,
      observedPriceUsd: matched.priceUsd,
    });
  }

  return {
    kind: "polled",
    pairsPolled: priceByPair.size,
    pairsUnpriced,
    pairsSkippedOverBudget,
    promoted,
  };
}

/**
 * The FIRST condition of this wake whose threshold the observed price crossed.
 *
 * The predicate itself comes from the registry, not from this module: the
 * evaluator that armed the condition owns what "crossed" means, and a poller
 * with its own copy of the comparison is how the two would drift.
 */
function findTriggeredCondition(
  watch: ParsedWatch,
  priceByPair: ReadonlyMap<string, string>,
): { readonly condition: ArmedTokenPriceCondition; readonly priceUsd: string } | null {
  for (const condition of watch.conditions) {
    const priceUsd = priceByPair.get(pairKey(condition.chain, condition.tokenAddress));
    if (priceUsd === undefined) continue;
    const signal = toSignal(condition.chain, condition.tokenAddress, priceUsd);
    if (isWakeWatchTriggered(condition, signal)) {
      return { condition, priceUsd };
    }
  }
  return null;
}

// ── Scheduler ──────────────────────────────────────────────────────

export function startPriceWatchPoller(
  options: PriceWatchPollerOptions = {},
): PriceWatchPollerHandle {
  const intervalMs = options.intervalMs ?? PRICE_WATCH_POLL_INTERVAL_MS;
  const jitterMs = options.jitterMs ?? PRICE_WATCH_POLL_JITTER_MS;
  const deps = options.deps ?? buildProductionPriceWatchDeps();
  const aborter = new AbortController();

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const runOne = async (): Promise<void> => {
    try {
      await runPriceWatchTick(deps, aborter.signal);
    } catch (err) {
      // Never let a tick failure kill the loop; the next tick is 3 s away.
      logger.warn("wake.price_watch.tick_failed", { error: describeFailureForLog(err) });
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    inFlight = runOne().finally(() => {
      inFlight = null;
      if (!stopped) {
        timer = setTimeout(schedule, intervalMs + Math.floor(Math.random() * (jitterMs + 1)));
      }
    });
  };

  timer = setTimeout(schedule, intervalMs);
  logger.info("wake.price_watch.poller_started", { intervalMs });

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Abort BEFORE draining: the in-flight tick abandons its wait at once
      // instead of sitting out a 5 s provider deadline, and promotes nothing.
      aborter.abort();
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // Already logged inside runOne.
        }
      }
      logger.info("wake.price_watch.poller_stopped");
    },
  };
}
