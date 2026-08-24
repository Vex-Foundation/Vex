import { describe, expect, it } from "vitest";

import { lighterTradingSnapshotSchema } from "@shared/schemas/lighter-trading.js";
import {
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
  }
});
