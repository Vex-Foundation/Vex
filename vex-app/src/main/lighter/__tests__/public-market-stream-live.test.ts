import { requireValue } from "../../../../../src/__tests__/helpers/require-value.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  lighterTradingPublicBookEventSchema,
  lighterTradingPublicMarketStatusEventSchema,
  lighterTradingPublicStatsEventSchema,
  lighterTradingPublicTradesEventSchema,
  type LighterTradingEnvironment,
  type LighterTradingMarketType,
  type LighterTradingPublicBookEvent,
  type LighterTradingPublicMarketStatusEvent,
  type LighterTradingPublicStatsEvent,
  type LighterTradingPublicTradesEvent,
} from "@shared/schemas/lighter-trading.js";
import {
  defaultLighterPublicMarketSupervisorDeps,
  LighterPublicMarketSupervisor,
} from "../public-market-stream.js";
import { readLighterTradingMarketList } from "../trading-panel-service.js";

const describeLive = process.env["VEX_LIGHTER_PANEL_LIVE"] === "1"
  ? describe
  : describe.skip;

describeLive("Light it up live public market stream", () => {
  for (const environment of ["core", "rhc"] as const) {
    it(`streams real ${environment} perp and spot data`, { timeout: 60_000 }, async () => {
      const list = await readLighterTradingMarketList(environment);
      const active = list.markets.filter((market) => market.status === "active");
      const perp = active.find((market) => (
        market.marketType === "perp" && market.symbol.toUpperCase() === "BTC"
      )) ?? active.find((market) => market.marketType === "perp");
      const spot = active.find((market) => market.marketType === "spot");
      expect(perp).toBeDefined();
      expect(spot).toBeDefined();

      const proofs = await Promise.all([
        readLiveProof(environment, requireValue(perp).marketId, "perp", true),
        readLiveProof(environment, requireValue(spot).marketId, "spot", false),
      ]);
      for (const proof of proofs) {
        expect(lighterTradingPublicBookEventSchema.safeParse(proof.book).success).toBe(true);
        expect(lighterTradingPublicStatsEventSchema.safeParse(proof.stats).success).toBe(true);
        expect(lighterTradingPublicMarketStatusEventSchema.safeParse(proof.status).success).toBe(true);
        expect(proof.status.status).toBe("live");
        expect(proof.book.nonce).toMatch(/^\d+$/);
        if (proof.marketType === "perp") {
          expect(proof.trades).not.toBeNull();
          expect(lighterTradingPublicTradesEventSchema.safeParse(proof.trades).success).toBe(true);
          expect(proof.stats.stats.openInterestQuote).not.toBeNull();
        } else {
          expect(proof.stats.stats.openInterestQuote).toBeNull();
          expect(proof.stats.stats.markPrice).toBeNull();
        }
        process.stdout.write(`${JSON.stringify({
          event: "lighter.panel.live_public_market",
          environment,
          marketId: proof.marketId,
          marketType: proof.marketType,
          asks: proof.book.book.asks.length,
          bids: proof.book.book.bids.length,
          tradeRows: proof.trades?.trades.length ?? 0,
          readyLatencyMs: proof.readyLatencyMs,
          bookTransportLagMs: proof.book.receivedAt - proof.book.providerTimestamp,
          statsTransportLagMs: proof.stats.receivedAt - proof.stats.providerTimestamp,
        })}\n`);
      }
    });
  }
});

async function readLiveProof(
  environment: LighterTradingEnvironment,
  marketId: number,
  marketType: LighterTradingMarketType,
  requireTrade: boolean,
): Promise<{
  readonly marketId: number;
  readonly marketType: LighterTradingMarketType;
  readonly book: LighterTradingPublicBookEvent;
  readonly stats: LighterTradingPublicStatsEvent;
  readonly trades: LighterTradingPublicTradesEvent | null;
  readonly status: LighterTradingPublicMarketStatusEvent;
  readonly readyLatencyMs: number;
}> {
  const supervisor = new LighterPublicMarketSupervisor(
    defaultLighterPublicMarketSupervisorDeps(),
  );
  const subscriptionId = randomUUID();
  const startedAt = Date.now();
  try {
    return await new Promise((resolve, reject) => {
      let book: LighterTradingPublicBookEvent | null = null;
      let stats: LighterTradingPublicStatsEvent | null = null;
      let trades: LighterTradingPublicTradesEvent | null = null;
      let status: LighterTradingPublicMarketStatusEvent | null = null;
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for the Lighter public market stream.")),
        30_000,
      );
      const finish = (): void => {
        if (
          book === null
          || stats === null
          || status?.status !== "live"
          || (requireTrade && trades === null)
        ) return;
        clearTimeout(timeout);
        resolve({
          marketId,
          marketType,
          book,
          stats,
          trades,
          status,
          readyLatencyMs: Date.now() - startedAt,
        });
      };
      supervisor.subscribe(
        `live-public:${environment}:${marketType}`,
        { subscriptionId, environment, marketId, marketType },
        (event) => {
          const { kind, ...payload } = event;
          if (kind === "book") {
            const parsed = lighterTradingPublicBookEventSchema.safeParse(payload);
            if (parsed.success) book = parsed.data;
          } else if (kind === "stats") {
            const parsed = lighterTradingPublicStatsEventSchema.safeParse(payload);
            if (parsed.success) stats = parsed.data;
          } else if (kind === "trades") {
            const parsed = lighterTradingPublicTradesEventSchema.safeParse(payload);
            if (parsed.success) trades = parsed.data;
          } else {
            const parsed = lighterTradingPublicMarketStatusEventSchema.safeParse(payload);
            if (parsed.success) status = parsed.data;
          }
          finish();
        },
      );
    });
  } finally {
    supervisor.stop();
  }
}
