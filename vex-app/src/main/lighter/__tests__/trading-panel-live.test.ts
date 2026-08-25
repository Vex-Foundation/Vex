import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  lighterTradingCandleSnapshotEventSchema,
  lighterTradingCandleUpdateEventSchema,
  lighterTradingSnapshotSchema,
  type LighterTradingCandleSnapshotEvent,
  type LighterTradingCandleUpdateEvent,
  type LighterTradingEnvironment,
} from "@shared/schemas/lighter-trading.js";
import {
  defaultLighterCandleStreamSupervisorDeps,
  LighterCandleStreamSupervisor,
} from "../candle-stream.js";
import {
  readLighterTradingCandleHistory,
  readLighterTradingMarketList,
  readLighterTradingSnapshot,
} from "../trading-panel-service.js";

const describeLive = process.env["VEX_LIGHTER_PANEL_LIVE"] === "1"
  ? describe
  : describe.skip;
const ENVIRONMENTS = ["core", "rhc"] as const;
const PREFERRED_SYMBOLS = ["BTC", "BTC-USD", "ETH", "ETH-USD"];

describeLive("Light it up live read-only market surface", () => {
  for (const environment of ENVIRONMENTS) {
    it(`reads a real ${environment} chart snapshot`, { timeout: 60_000 }, async () => {
      const list = await readLighterTradingMarketList(environment);
      const active = list.markets.filter((market) => market.status === "active");
      expect(active.length).toBeGreaterThan(0);
      const preferred = active.filter((market) =>
        PREFERRED_SYMBOLS.includes(market.symbol.toUpperCase()),
      );
      const candidates = [...preferred, ...active].slice(0, 8);

      let snapshot: Awaited<ReturnType<typeof readLighterTradingSnapshot>> | null = null;
      for (const market of candidates) {
        try {
          const candidate = await readLighterTradingSnapshot({
            environment,
            marketId: market.marketId,
            resolution: "1h",
          });
          if (candidate.candles.length === 0) continue;
          snapshot = candidate;
          break;
        } catch {
          // A single inactive/stale book must not prevent proving another live
          // active market in this read-only environment can hydrate the panel.
        }
      }

      expect(snapshot).not.toBeNull();
      expect(lighterTradingSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(snapshot?.candles.length).toBeGreaterThan(0);
      process.stdout.write(
        `${JSON.stringify({
          event: "lighter.panel.live_read",
          environment,
          marketId: snapshot?.market.marketId,
          symbol: snapshot?.market.symbol,
          candles: snapshot?.candles.length,
          asks: snapshot?.book.asks.length,
          bids: snapshot?.book.bids.length,
          trades: snapshot?.trades.length,
        })}\n`,
      );
    });

    it(`streams and reconciles real ${environment} candles`, { timeout: 60_000 }, async () => {
      const list = await readLighterTradingMarketList(environment);
      const active = list.markets.filter((market) => market.status === "active");
      const preferred = active.filter((market) =>
        PREFERRED_SYMBOLS.includes(market.symbol.toUpperCase()),
      );
      const candidates = [...preferred, ...active].slice(0, 8);

      let proof: Awaited<ReturnType<typeof readStreamParityProof>> | null = null;
      for (const market of candidates) {
        try {
          proof = await readStreamParityProof(environment, market.marketId);
          if (proof.commonClosedCandles > 0) break;
        } catch {
          proof = null;
        }
      }

      expect(proof).not.toBeNull();
      expect(proof?.commonClosedCandles).toBeGreaterThan(0);
      expect(proof?.mismatches).toEqual([]);
      process.stdout.write(
        `${JSON.stringify({
          event: "lighter.panel.live_candle_parity",
          environment,
          marketId: proof?.event.marketId,
          resolution: proof?.event.resolution,
          streamCandles: proof?.event.candles.length,
          commonClosedCandles: proof?.commonClosedCandles,
          liveUpdateCandles: proof?.liveUpdate.candles.length,
        })}\n`,
      );
    });
  }
});

async function readStreamParityProof(
  environment: LighterTradingEnvironment,
  marketId: number,
): Promise<{
  readonly event: LighterTradingCandleSnapshotEvent;
  readonly liveUpdate: LighterTradingCandleUpdateEvent;
  readonly commonClosedCandles: number;
  readonly mismatches: string[];
}> {
  const supervisor = new LighterCandleStreamSupervisor(
    defaultLighterCandleStreamSupervisorDeps(),
  );
  const subscriptionId = randomUUID();
  try {
    const { event, liveUpdate } = await new Promise<{
      readonly event: LighterTradingCandleSnapshotEvent;
      readonly liveUpdate: LighterTradingCandleUpdateEvent;
    }>((resolve, reject) => {
      let snapshot: LighterTradingCandleSnapshotEvent | null = null;
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for Lighter candle stream update.")),
        30_000,
      );
      supervisor.subscribe(
        `live-canary:${environment}`,
        { subscriptionId, environment, marketId, resolution: "1m" },
        (candidate) => {
          const { kind, ...payload } = candidate;
          if (kind === "snapshot") {
            const parsed = lighterTradingCandleSnapshotEventSchema.safeParse(payload);
            if (parsed.success) snapshot = parsed.data;
            return;
          }
          if (kind !== "update" || snapshot === null) return;
          const parsed = lighterTradingCandleUpdateEventSchema.safeParse(payload);
          if (
            !parsed.success
            || !parsed.data.candles.some((candle) => candle.source === "websocket_update")
          ) return;
          clearTimeout(timeout);
          resolve({ event: snapshot, liveUpdate: parsed.data });
        },
      );
    });
    const rest = await readLighterTradingCandleHistory({
      environment,
      marketId,
      resolution: "1m",
      count: 10,
    });
    const restByTime = new Map(rest.map((candle) => [candle.timestamp, candle]));
    const common = event.candles
      .slice(0, -1)
      .filter((candle) => restByTime.has(candle.timestamp));
    const mismatches: string[] = [];
    for (const candle of common) {
      const reference = restByTime.get(candle.timestamp)!;
      if (
        candle.open !== reference.open
        || candle.high !== reference.high
        || candle.low !== reference.low
        || candle.close !== reference.close
        || candle.volumeBase !== reference.volumeBase
        || candle.volumeQuote !== reference.volumeQuote
        || candle.lastTradeId !== reference.lastTradeId
      ) {
        mismatches.push(`${candle.timestamp}`);
      }
    }
    return { event, liveUpdate, commonClosedCandles: common.length, mismatches };
  } finally {
    supervisor.stop();
  }
}
