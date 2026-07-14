import { z } from "zod";

import {
  HYPERLIQUID_CANDLE_WINDOWS_MS,
  hyperliquidCandleIntervalSchema,
  parseHyperliquidCandle,
  type HyperliquidCandle,
} from "@tools/hyperliquid/candles.js";
import { HyperliquidInfoClient } from "@tools/hyperliquid/info.js";
import { resolveHyperliquidNetwork } from "@tools/hyperliquid/constants.js";
import * as candleRepo from "@vex-agent/db/repos/hyperliquid-candles.js";
import type { ProtocolHandler } from "../types.js";
import { evaluateCandleScan, parseCandleScanFilters, type StoredHyperliquidCandle } from "./market-analysis.js";

export const MAX_HYPERLIQUID_CANDLE_WATCHES = 8;

const watchInput = z.object({
  coin: z.string().trim().min(1).max(64),
  interval: hyperliquidCandleIntervalSchema,
  enabled: z.boolean(),
}).strict();
const readInput = z.object({
  coin: z.string().trim().min(1).max(64),
  interval: hyperliquidCandleIntervalSchema,
  limit: z.number().int().min(1).max(500),
}).strict();
const scanInput = z.object({
  coin: z.string().trim().min(1).max(64),
  interval: hyperliquidCandleIntervalSchema,
  filters: z.record(z.string(), z.unknown()),
}).strict();

type CandleRepo = Pick<typeof candleRepo,
  "setHyperliquidCandleWatch" | "getHyperliquidCandleWatch" | "countEnabledHyperliquidCandleWatches"
  | "upsertHyperliquidCandles" | "readHyperliquidCandles">;

export interface HyperliquidMarketAnalysisDeps {
  readonly createInfoClient: () => Pick<HyperliquidInfoClient, "candleSnapshot">;
  readonly repo: CandleRepo;
  readonly now: () => number;
}

function productionDeps(): HyperliquidMarketAnalysisDeps {
  return {
    createInfoClient: () => new HyperliquidInfoClient({ network: resolveHyperliquidNetwork() }),
    repo: candleRepo,
    now: () => Date.now(),
  };
}

/** Separate sibling handler bundle; the legacy Hyperliquid handler stays focused on custody. */
export function createHyperliquidMarketAnalysisHandlers(
  deps: HyperliquidMarketAnalysisDeps = productionDeps(),
): Readonly<Record<string, ProtocolHandler>> {
  const load = async (coin: string, interval: HyperliquidCandle["interval"], limit: number) => {
    const watch = await deps.repo.getHyperliquidCandleWatch(coin, interval);
    if (watch?.enabled) {
      const rows = await deps.repo.readHyperliquidCandles(coin, interval, limit);
      return { source: "store" as const, rows, live: true };
    }
    const rows = await snapshot(deps, coin, interval);
    const newestFirst = [...rows].sort((left, right) => right.openTimeMs - left.openTimeMs);
    return { source: "snapshot" as const, rows: newestFirst.slice(0, limit), live: false };
  };

  return {
    "hyperliquid.market.watchCandles": async (params) => {
      const input = watchInput.parse(params);
      const coin = input.coin.toUpperCase();
      if (!input.enabled) {
        const watch = await deps.repo.setHyperliquidCandleWatch({ coin, interval: input.interval, enabled: false });
        return ok({ coin, interval: input.interval, enabled: watch.enabled, source: "store", writing: false });
      }
      const existing = await deps.repo.getHyperliquidCandleWatch(coin, input.interval);
      if (!existing?.enabled && await deps.repo.countEnabledHyperliquidCandleWatches() >= MAX_HYPERLIQUID_CANDLE_WATCHES) {
        return fail(`Candle watch limit reached (${MAX_HYPERLIQUID_CANDLE_WATCHES}). Disable an existing watch first.`);
      }
      const rows = await snapshot(deps, coin, input.interval);
      await deps.repo.upsertHyperliquidCandles(rows);
      const watch = await deps.repo.setHyperliquidCandleWatch({ coin, interval: input.interval, enabled: true });
      return ok({ coin, interval: input.interval, enabled: watch.enabled, source: "snapshot", backfilled: rows.length, writing: true });
    },
    "hyperliquid.market.candles": async (params) => {
      const input = readInput.parse(params);
      const coin = input.coin.toUpperCase();
      const loaded = await load(coin, input.interval, input.limit);
      return ok({
        source: loaded.source,
        candles: loaded.rows,
        coverage: coverage(loaded.rows, loaded.live),
      });
    },
    "hyperliquid.market.scan": async (params) => {
      const input = scanInput.parse(params);
      const coin = input.coin.toUpperCase();
      const loaded = await load(coin, input.interval, candleRepo.HYPERLIQUID_CANDLE_RING_SIZE);
      const result = evaluateCandleScan(loaded.rows as readonly StoredHyperliquidCandle[], parseCandleScanFilters(input.filters));
      return ok({ source: loaded.source, coverage: coverage(loaded.rows, loaded.live), ...result });
    },
  };
}

export const HYPERLIQUID_MARKET_ANALYSIS_HANDLERS = createHyperliquidMarketAnalysisHandlers();

async function snapshot(
  deps: HyperliquidMarketAnalysisDeps,
  coin: string,
  interval: HyperliquidCandle["interval"],
): Promise<readonly HyperliquidCandle[]> {
  const now = deps.now();
  const raw = await deps.createInfoClient().candleSnapshot({
    coin,
    interval,
    startTime: now - HYPERLIQUID_CANDLE_WINDOWS_MS[interval],
    endTime: now,
  });
  if (!Array.isArray(raw) || raw.length > 10_000) throw new Error("Hyperliquid returned an invalid candle snapshot.");
  return raw.map((row) => {
    // Per-row guard (instead of a separate .every) so TS narrows the spread.
    if (!isRecord(row)) throw new Error("Hyperliquid returned an invalid candle snapshot.");
    return parseHyperliquidCandle({ ...row, s: coin, i: interval });
  });
}

function coverage(rows: readonly { readonly openTimeMs: number }[], live: boolean): Record<string, unknown> {
  const timestamps = rows.map((row) => row.openTimeMs).filter(Number.isSafeInteger);
  return { from: timestamps.length === 0 ? null : Math.min(...timestamps), to: timestamps.length === 0 ? null : Math.max(...timestamps), live };
}

function ok(data: Record<string, unknown>) { return { success: true, output: JSON.stringify(data), data }; }
function fail(output: string) { return { success: false, output }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
