/**
 * VEX market poller (T1).
 *
 * Three independent, self-scheduling polls compose one `VexMarketSnapshot`:
 *   - PRICE (DexScreener pair, 10s) - the authoritative price side; its
 *     freshness drives the snapshot's `stale` flag.
 *   - SPARKLINE (DexScreener hourly candles, 60s) - trailing hourly closes.
 *   - HOLDERS (Virtuals, 120s, best-effort) - a single integer; failure or a
 *     `null` result keeps last-good and never blocks the snapshot.
 *
 * S11b: both DexScreener reads now go through the shared seams
 * (`@tools/dexscreener/price-read.js`, `@tools/dexscreener/candles-read.js`)
 * and the transport the app registers at agent startup. GeckoTerminal, the
 * widget's former candle provider, is gone.
 *
 * Lifecycle mirrors `agent/sync-worker.ts`: an immediate first tick, a
 * non-reentrant single-in-flight guard per source, and an idempotent async
 * `stop()` that clears every timer and drains any in-flight tick (a probe that
 * resolves AFTER quit begins must not publish or reschedule). Self-scheduling
 * `setTimeout` (not a fixed `setInterval`) is used so a failed poll can back
 * off with jitter — the price loop retries at `base·2^failures` (capped) so a
 * DexScreener 429 does not hammer the endpoint.
 *
 * Every source keeps a last-good value; a transient failure re-broadcasts the
 * previous snapshot rather than blanking the widget. Deps are injectable for
 * tests (fetchers, publish sink, clock, cadences, backoff); production wires
 * the real clients + `publishSnapshot`.
 */

import { publishSnapshot as defaultPublish } from "./snapshot-cache.js";
import { fetchVexPair, type VexPairData } from "./dexscreener-pair.js";
import { fetchVexSparkline } from "./vex-candles.js";
import { fetchVexHolderCount } from "./virtuals-client.js";
import { log } from "../logger/index.js";
import type { VexMarketSnapshot } from "@shared/schemas/market.js";

/** Price data older than this (or a failed newest poll) marks the snapshot stale. */
const STALE_AFTER_MS = 60_000;

const DEFAULTS = {
  priceIntervalMs: 10_000,
  sparklineIntervalMs: 60_000,
  holderIntervalMs: 120_000,
  maxBackoffMs: 60_000,
} as const;

export interface VexMarketServiceDeps {
  readonly fetchPair: () => Promise<VexPairData>;
  readonly fetchSparkline: () => Promise<Array<[number, number]>>;
  readonly fetchHolderCount: () => Promise<number | null>;
  readonly publish: (snapshot: VexMarketSnapshot) => void;
  readonly now: () => number;
  readonly priceIntervalMs: number;
  readonly sparklineIntervalMs: number;
  readonly holderIntervalMs: number;
  readonly maxBackoffMs: number;
  /** Extra delay added to a backed-off retry; default is 0–1s of jitter. */
  readonly jitterMs: () => number;
}

interface Loop {
  readonly cancel: () => void;
  readonly drain: () => Promise<void>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Start the VEX market poller. Returns an idempotent async `stop` for the app
 * quit cleanup. Broadcast-only (no DB), so it is safe to start before windows
 * exist — early broadcasts no-op and the cache is served on the first
 * `market.getVexSnapshot`.
 */
export function setupVexMarketService(
  deps: Partial<VexMarketServiceDeps> = {},
): () => Promise<void> {
  const fetchPair = deps.fetchPair ?? fetchVexPair;
  const fetchSparkline = deps.fetchSparkline ?? fetchVexSparkline;
  const fetchHolderCount = deps.fetchHolderCount ?? fetchVexHolderCount;
  const publish = deps.publish ?? defaultPublish;
  const now = deps.now ?? Date.now;
  const priceIntervalMs = deps.priceIntervalMs ?? DEFAULTS.priceIntervalMs;
  const sparklineIntervalMs =
    deps.sparklineIntervalMs ?? DEFAULTS.sparklineIntervalMs;
  const holderIntervalMs = deps.holderIntervalMs ?? DEFAULTS.holderIntervalMs;
  const maxBackoffMs = deps.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
  const jitterMs = deps.jitterMs ?? (() => Math.round(Math.random() * 1_000));

  let stopped = false;

  // ── Last-good source state ───────────────────────────────────────────────
  let lastPair: VexPairData | null = null;
  let lastPairAt: number | null = null;
  let pricePollFailing = false;
  let lastSparkline: Array<[number, number]> = [];
  let lastHolderCount: number | null = null;

  /** Compose the current snapshot; `null` until the first price arrives. */
  function compose(): VexMarketSnapshot | null {
    if (lastPair === null) return null;
    const nowMs = now();
    const stale =
      pricePollFailing ||
      lastPairAt === null ||
      nowMs - lastPairAt > STALE_AFTER_MS;
    return {
      priceUsd: lastPair.priceUsd,
      priceChange: { h1: lastPair.priceChange.h1, h24: lastPair.priceChange.h24 },
      marketCap: lastPair.marketCap,
      fdv: lastPair.fdv,
      liquidityUsd: lastPair.liquidityUsd,
      volumeH24: lastPair.volumeH24,
      txnsH24: lastPair.txnsH24 === null ? null : { ...lastPair.txnsH24 },
      holderCount: lastHolderCount,
      sparkline: lastSparkline.map((point) => [point[0], point[1]] as [number, number]),
      updatedAt: nowMs,
      stale,
    };
  }

  function publishFromCompose(): void {
    const snapshot = compose();
    if (snapshot !== null) publish(snapshot);
  }

  // ── Per-source ticks (throw on failure so the loop can back off) ─────────
  async function priceRun(): Promise<void> {
    const pair = await fetchPair();
    if (stopped) return;
    lastPair = pair;
    lastPairAt = now();
    pricePollFailing = false;
    publishFromCompose();
  }
  function onPriceFailure(err: unknown): void {
    if (stopped) return;
    pricePollFailing = true;
    log.warn(`[market] VEX price poll failed: ${errMessage(err)}`);
    // Re-broadcast last-good data marked stale (never blank the widget).
    publishFromCompose();
  }

  async function sparklineRun(): Promise<void> {
    const points = await fetchSparkline();
    if (stopped) return;
    lastSparkline = points;
    publishFromCompose();
  }
  function onSparklineFailure(err: unknown): void {
    if (stopped) return;
    // Sparkline is supplementary; keep last-good and do NOT mark stale
    // (staleness tracks price freshness only).
    log.debug(`[market] VEX sparkline poll failed: ${errMessage(err)}`);
  }

  async function holderRun(): Promise<void> {
    const count = await fetchHolderCount();
    if (stopped || count === null) return;
    lastHolderCount = count;
    publishFromCompose();
  }
  function onHolderFailure(err: unknown): void {
    if (stopped) return;
    log.debug(`[market] VEX holder poll failed: ${errMessage(err)}`);
  }

  // ── Generic self-scheduling loop with jittered backoff ───────────────────
  function makeLoop(opts: {
    readonly run: () => Promise<void>;
    readonly onFailure: (err: unknown) => void;
    readonly baseMs: number;
  }): Loop {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let failures = 0;

    const schedule = (delayMs: number): void => {
      if (stopped) return;
      timer = setTimeout(fire, delayMs);
    };

    const fire = (): void => {
      timer = null;
      if (stopped || inFlight !== null) return;
      inFlight = opts
        .run()
        .then(() => {
          failures = 0;
        })
        .catch((err: unknown) => {
          failures += 1;
          opts.onFailure(err);
        })
        .finally(() => {
          inFlight = null;
          if (stopped) return;
          const delayMs =
            failures > 0
              ? Math.min(
                  opts.baseMs * 2 ** Math.min(failures, 6),
                  maxBackoffMs,
                ) + jitterMs()
              : opts.baseMs;
          schedule(delayMs);
        });
    };

    schedule(0); // immediate first tick
    return {
      cancel: () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      },
      drain: async () => {
        if (inFlight !== null) {
          try {
            await inFlight;
          } catch {
            // failures are already handled in `catch` above
          }
        }
      },
    };
  }

  const loops: Loop[] = [
    makeLoop({ run: priceRun, onFailure: onPriceFailure, baseMs: priceIntervalMs }),
    makeLoop({
      run: sparklineRun,
      onFailure: onSparklineFailure,
      baseMs: sparklineIntervalMs,
    }),
    makeLoop({
      run: holderRun,
      onFailure: onHolderFailure,
      baseMs: holderIntervalMs,
    }),
  ];

  return async function stop(): Promise<void> {
    stopped = true;
    for (const loop of loops) loop.cancel();
    await Promise.all(loops.map((loop) => loop.drain()));
  };
}
