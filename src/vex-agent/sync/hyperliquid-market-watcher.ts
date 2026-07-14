/**
 * Hyperliquid mark watcher.
 *
 * Owns the first generic loop-watch evaluator. It reads public market data,
 * promotes an existing wake at most once, and never signs or creates exposure.
 */

import { Decimal } from "decimal.js";
import { z } from "zod";

import { HyperliquidInfoClient } from "@tools/hyperliquid/info.js";
import { HyperliquidCandleSubscriptions, HyperliquidSubscriptions } from "@tools/hyperliquid/subscriptions.js";
import { resolveHyperliquidNetwork } from "@tools/hyperliquid/constants.js";
import { assertPositiveDecimal, normalizeProviderDecimal, parseDecimalString } from "@tools/hyperliquid/validation.js";
import { getActiveHyperliquidPerpWallets } from "@vex-agent/db/repos/activity.js";
import { getOpen } from "@vex-agent/db/repos/open-positions.js";
import * as loopWakeRepo from "@vex-agent/db/repos/loop-wake.js";
import * as syncRepo from "@vex-agent/db/repos/sync.js";
import * as candleRepo from "@vex-agent/db/repos/hyperliquid-candles.js";
import {
  isWakeWatchTriggered,
  registerWakeWatchEvaluator,
  type WakeWatchCondition,
  type WakeWatchEvaluator,
} from "@vex-agent/engine/wake/watch-registry.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";

const HL_MARK_PRICE_TYPE = "hl_mark_price";
const DEFAULT_INTERVAL_MS = 2_000;
const MAX_MARK_DEVIATION_PCT = new Decimal(50);

const hlMarkPriceSchema = z.object({
  type: z.literal(HL_MARK_PRICE_TYPE),
  coin: z.string().trim().min(1).max(64),
  direction: z.enum(["above", "below"]),
  price: z.string(),
}).strict();

export interface HlMarkPriceWatchCondition extends WakeWatchCondition {
  readonly type: typeof HL_MARK_PRICE_TYPE;
  readonly coin: string;
  readonly direction: "above" | "below";
  readonly price: string;
}

export interface HyperliquidMarketWatcherDeps {
  readonly createInfoClient: () => Pick<HyperliquidInfoClient, "allMids" | "frontendOpenOrders">;
  readonly getOpenPositions: typeof getOpen;
  readonly getPendingWithWatch: typeof loopWakeRepo.getPendingWithWatch;
  readonly promotePendingWake: typeof loopWakeRepo.promotePendingWake;
  readonly getTrackedWallets?: () => Promise<readonly string[]>;
  readonly createSubscriptions?: (walletAddress: `0x${string}`) => HyperliquidSubscriptions;
  readonly listEnabledCandleWatches?: typeof candleRepo.listEnabledHyperliquidCandleWatches;
  readonly createCandleSubscriptions?: (watch: Pick<candleRepo.HyperliquidCandleWatch, "coin" | "interval">) => HyperliquidCandleSubscriptions;
}

export interface HyperliquidMarketWatcherHandle {
  stop(): Promise<void>;
}

function productionDeps(): HyperliquidMarketWatcherDeps {
  return {
    createInfoClient: () => new HyperliquidInfoClient({ network: resolveHyperliquidNetwork() }),
    getOpenPositions: getOpen,
    getPendingWithWatch: loopWakeRepo.getPendingWithWatch,
    promotePendingWake: loopWakeRepo.promotePendingWake,
    getTrackedWallets: async () => {
      const [positions, orderWallets] = await Promise.all([
        getOpen(undefined, "hyperliquid"),
        getActiveHyperliquidPerpWallets(),
      ]);
      return [...new Set([...positions.map((position) => position.walletAddress), ...orderWallets])];
    },
    createSubscriptions: (walletAddress) => new HyperliquidSubscriptions({
      network: resolveHyperliquidNetwork(),
      user: walletAddress,
      callbacks: {
        onUserEvents: (event) => {
          void import("./hyperliquid-reconciler.js")
            .then(({ recordHyperliquidUserEvent }) => recordHyperliquidUserEvent(walletAddress, event))
            .catch((error: unknown) => logger.warn("hyperliquid.market_watcher.event_record_failed", { error: message(error) }));
          void enqueueHyperliquidReconcile().catch((error: unknown) => logger.warn("hyperliquid.market_watcher.enqueue_failed", { error: message(error) }));
        },
        onError: (error) => logger.warn("hyperliquid.market_watcher.subscription_error", { error: message(error) }),
      },
    }),
    listEnabledCandleWatches: candleRepo.listEnabledHyperliquidCandleWatches,
    createCandleSubscriptions: (watch) => new HyperliquidCandleSubscriptions({
      network: resolveHyperliquidNetwork(),
      coin: watch.coin,
      interval: watch.interval,
      onCandle: async (candle) => { await candleRepo.upsertHyperliquidCandles([candle]); },
      onError: (error) => logger.warn("hyperliquid.market_watcher.candle_event_dropped", { coin: watch.coin, interval: watch.interval, error: message(error) }),
    }),
  };
}

const evaluator: WakeWatchEvaluator = {
  type: HL_MARK_PRICE_TYPE,
  async validate(condition, context): Promise<WakeWatchCondition> {
    const parsed = parseHlMarkPriceWatchCondition(condition);
    const walletAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
    const info = new HyperliquidInfoClient({ network: resolveHyperliquidNetwork() });
    const [positions, orders, mids] = await Promise.all([
      getOpen([walletAddress], "hyperliquid"),
      info.frontendOpenOrders(walletAddress),
      info.allMids(),
    ]);
    const hasExposure = positions.some((position) => position.instrumentKey === `hyperliquid:perp:${parsed.coin}`);
    const hasRestingOrder = array(orders).some((order) => record(order)?.coin === parsed.coin);
    if (!hasExposure && !hasRestingOrder) {
      throw new Error(`Watch coin "${parsed.coin}" requires an open Hyperliquid position or resting order.`);
    }
    const mark = markForCoin(mids, parsed.coin);
    if (mark === null) throw new Error(`No live Hyperliquid mark is available for "${parsed.coin}".`);
    const deviation = new Decimal(parsed.price).minus(mark).abs().div(mark).mul(100);
    if (deviation.gt(MAX_MARK_DEVIATION_PCT)) {
      throw new Error(`Watch price must be within ${MAX_MARK_DEVIATION_PCT.toFixed()}% of the current mark.`);
    }
    return parsed;
  },
  isTriggered(condition, signal): boolean {
    if (signal.type !== "mark_price") return false;
    const parsed = hlMarkPriceSchema.safeParse(condition);
    if (!parsed.success || signal.values.coin !== parsed.data.coin) return false;
    const providerPrice = signal.values.price;
    if (providerPrice === undefined) return false;
    const mark = parseDecimalString(providerPrice);
    const target = parseDecimalString(parsed.data.price);
    return parsed.data.direction === "above"
      ? new Decimal(mark).gte(target)
      : new Decimal(mark).lte(target);
  },
};

let evaluatorRegistered = false;

/** Sync boot calls this before the watcher accepts `hl_mark_price` conditions. */
export function registerHyperliquidMarkPriceWatchEvaluator(): void {
  if (evaluatorRegistered) return;
  registerWakeWatchEvaluator(evaluator);
  evaluatorRegistered = true;
}

/** Pure Zod/decimal boundary; live ownership checks happen in the evaluator. */
export function parseHlMarkPriceWatchCondition(value: unknown): HlMarkPriceWatchCondition {
  const parsed = hlMarkPriceSchema.parse(value);
  const price = parseDecimalString(parsed.price);
  assertPositiveDecimal(price, "Watch price");
  return { type: HL_MARK_PRICE_TYPE, coin: parsed.coin, direction: parsed.direction, price };
}

/** Evaluate every persisted HL condition once against one public mids response. */
export async function tickHyperliquidMarketWatcher(
  deps: HyperliquidMarketWatcherDeps = productionDeps(),
): Promise<{ readonly checked: number; readonly promoted: number }> {
  const wakes = await deps.getPendingWithWatch();
  if (wakes.length === 0) return { checked: 0, promoted: 0 };
  const mids = await deps.createInfoClient().allMids();
  let checked = 0;
  let promoted = 0;
  for (const wake of wakes) {
    const watchId = typeof wake.payload?.watchId === "string" ? wake.payload.watchId : null;
    const conditions = Array.isArray(wake.payload?.conditions) ? wake.payload.conditions : [];
    if (watchId === null) continue;
    for (const condition of conditions) {
      const conditionRecord = record(condition);
      if (conditionRecord?.type !== HL_MARK_PRICE_TYPE || typeof conditionRecord.coin !== "string") continue;
      const mark = markForCoin(mids, conditionRecord.coin);
      if (mark === null) continue;
      checked += 1;
      if (!isWakeWatchTriggered(conditionRecord, { type: "mark_price", values: { coin: conditionRecord.coin, price: mark } })) continue;
      if (await deps.promotePendingWake(wake.sessionId, wake.missionRunId, watchId)) promoted += 1;
      break;
    }
  }
  return { checked, promoted };
}

/** Start/stop-owned polling and websocket lifecycle. */
export function startHyperliquidMarketWatcher(
  deps: HyperliquidMarketWatcherDeps = productionDeps(),
  intervalMs = DEFAULT_INTERVAL_MS,
): HyperliquidMarketWatcherHandle {
  registerHyperliquidMarkPriceWatchEvaluator();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  const subscriptions = new Map<string, HyperliquidSubscriptions>();
  const candleSubscriptions = new Map<string, HyperliquidCandleSubscriptions>();

  const refreshSubscriptions = async (): Promise<void> => {
    const getTrackedWallets = deps.getTrackedWallets;
    const createSubscriptions = deps.createSubscriptions;
    if (getTrackedWallets !== undefined && createSubscriptions !== undefined) {
      const trackedWallets = new Set(await getTrackedWallets());
      await Promise.all([...subscriptions.entries()]
        .filter(([walletAddress]) => !trackedWallets.has(walletAddress))
        .map(async ([walletAddress, subscription]) => {
          subscriptions.delete(walletAddress);
          await subscription.stop();
        }));
      for (const walletAddress of trackedWallets) {
        if (subscriptions.has(walletAddress) || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) continue;
        const subscription = createSubscriptions(walletAddress as `0x${string}`);
        try {
          await subscription.start();
          subscriptions.set(walletAddress, subscription);
        } catch (error) {
          logger.warn("hyperliquid.market_watcher.subscription_start_failed", { error: message(error) });
          await subscription.stop();
        }
      }
    }
    await reconcileHyperliquidCandleSubscriptions(deps, candleSubscriptions);
  };

  const schedule = (delayMs = intervalMs): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = refreshSubscriptions()
        .then(async () => { await tickHyperliquidMarketWatcher(deps); })
        .catch((error: unknown) => { logger.warn("hyperliquid.market_watcher.tick_failed", { error: message(error) }); })
        .finally(() => { inFlight = null; schedule(); });
    }, delayMs);
  };
  // Restore persisted candle watches as soon as the long-lived runtime starts;
  // later reconciliation keeps enable/disable changes bounded by intervalMs.
  schedule(0);
  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      await inFlight;
      await Promise.allSettled([...subscriptions.values()].map((subscription) => subscription.stop()));
      subscriptions.clear();
      await Promise.allSettled([...candleSubscriptions.values()].map((subscription) => subscription.stop()));
      candleSubscriptions.clear();
    },
  };
}

/** Reconcile durable candle-watch rows with owned websocket subscriptions. */
export async function reconcileHyperliquidCandleSubscriptions(
  deps: Pick<HyperliquidMarketWatcherDeps, "listEnabledCandleWatches" | "createCandleSubscriptions">,
  subscriptions: Map<string, Pick<HyperliquidCandleSubscriptions, "start" | "stop">>,
): Promise<void> {
  if (deps.listEnabledCandleWatches === undefined || deps.createCandleSubscriptions === undefined) return;
  const watches = await deps.listEnabledCandleWatches();
  const active = new Map(watches.map((watch) => [candleWatchKey(watch), watch]));
  await Promise.all([...subscriptions.entries()]
    .filter(([key]) => !active.has(key))
    .map(async ([key, subscription]) => {
      subscriptions.delete(key);
      await subscription.stop();
    }));
  for (const [key, watch] of active) {
    if (subscriptions.has(key)) continue;
    const subscription = deps.createCandleSubscriptions(watch);
    try {
      await subscription.start();
      subscriptions.set(key, subscription);
    } catch (error) {
      logger.warn("hyperliquid.market_watcher.candle_subscription_start_failed", { coin: watch.coin, interval: watch.interval, error: message(error) });
      await subscription.stop();
    }
  }
}

function candleWatchKey(watch: Pick<candleRepo.HyperliquidCandleWatch, "coin" | "interval">): string {
  return `${watch.coin}\u0000${watch.interval}`;
}

async function enqueueHyperliquidReconcile(): Promise<void> {
  const job = (await syncRepo.getAllJobs()).find(
    (candidate) => candidate.namespace === "_global" && candidate.syncType === "hyperliquid_reconcile",
  );
  if (job !== undefined) await syncRepo.enqueueRun(job.id);
}

function markForCoin(mids: unknown, coin: string): string | null {
  try { return normalizeProviderDecimal(record(mids)?.[coin], `Mark price for ${coin}`); } catch { return null; }
}
function record(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
