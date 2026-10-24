/**
 * Integration: the price alert poller's tick against real Postgres (F01).
 *
 * With an injected price, the tick claims an alert whose level was reached,
 * records the fire price and time on the row, and announces it once; a second
 * tick finds nothing active and announces nothing; a cancelled alert is never
 * announced.
 *
 * LIVE (opt-in, `VEX_PRICE_ALERT_LIVE=1`): the same tick with the production
 * price source against DexScreener's public API. An above-alert on WETH on
 * base is written with its level just under the live price, so the first
 * tick must claim and announce it with the price it read.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closePool, execute } from "@vex-agent/db/client.js";
import * as repo from "@vex-agent/db/repos/price-alerts.js";
import { parseBoundedDecimal } from "@tools/dexscreener/token-watch-price/decimal.js";
import {
  buildProductionPriceAlertDeps,
  runPriceAlertTick,
  type PriceAlertExecutorDeps,
} from "@vex-agent/alerts/price-alert-executor.js";
import { priceTokens, type PriceTokensResult } from "@vex-agent/alerts/price-source.js";
import { requireValue } from "../../helpers/require-value.js";

const WETH = "0x4200000000000000000000000000000000000006";
const ASSET_KEY = `base:${WETH}`;
const RUN_LIVE = process.env.VEX_PRICE_ALERT_LIVE === "1";

function alertInput(over: Partial<repo.NewPriceAlert> = {}): repo.NewPriceAlert {
  return {
    chain: "base",
    address: WETH,
    assetKey: ASSET_KEY,
    label: "WETH",
    condition: "above",
    value: "4000",
    referencePrice: "3500",
    triggerPrice: "4000",
    direction: "above",
    note: "sell some",
    origin: "chat",
    sessionId: null,
    ...over,
  };
}

async function created(over: Partial<repo.NewPriceAlert> = {}): Promise<repo.PriceAlertRow> {
  const result = await repo.createAlert(alertInput(over), 20);
  if (!result.ok) throw new Error(`createAlert refused: ${result.reason}`);
  return result.alert;
}

function priced(priceUsd: string): PriceTokensResult {
  return {
    quotes: new Map([[ASSET_KEY, {
      assetKey: ASSET_KEY,
      priceUsd,
      price: requireValue(parseBoundedDecimal(priceUsd)),
      change24hPct: null,
      pairAddress: "0xpair",
      dexId: "aerodrome",
      symbol: "WETH",
    }]]),
    failed: [],
  };
}

function deps(priceUsd: string) {
  const emit = vi.fn<PriceAlertExecutorDeps["emit"]>();
  const built: PriceAlertExecutorDeps = {
    ...buildProductionPriceAlertDeps(),
    priceTokens: async () => priced(priceUsd),
    emit,
  };
  return { deps: built, emit };
}

beforeEach(async () => {
  await execute("DELETE FROM price_alerts");
});

afterAll(async () => {
  await execute("DELETE FROM price_alerts");
  await closePool();
});

describe("price alert tick on real Postgres", () => {
  it("claims a reached alert once, records the fire, and announces it once", async () => {
    const alert = await created();
    const { deps: d, emit } = deps("4010.25");

    const first = await runPriceAlertTick(d);
    expect(first).toMatchObject({ active: 1, fired: 1, lostClaims: 0 });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      alertId: alert.id,
      triggeredPrice: "4010.25",
      note: "sell some",
    }));

    const row = requireValue(await repo.getAlert(alert.id));
    expect(row.status).toBe("triggered");
    expect(row.triggeredPrice).toBe("4010.25");
    expect(row.triggeredAt).not.toBeNull();

    const second = await runPriceAlertTick(d);
    expect(second).toMatchObject({ active: 0, fired: 0 });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("leaves an alert short of its level active", async () => {
    const alert = await created();
    const { deps: d, emit } = deps("3999.99");
    expect((await runPriceAlertTick(d)).fired).toBe(0);
    expect(emit).not.toHaveBeenCalled();
    expect(requireValue(await repo.getAlert(alert.id)).status).toBe("active");
  });

  it("never announces a cancelled alert", async () => {
    const alert = await created();
    await repo.cancelAlert(alert.id);
    const { deps: d, emit } = deps("5000");
    expect((await runPriceAlertTick(d)).active).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe.skipIf(!RUN_LIVE)("LIVE: price alert tick against DexScreener", () => {
  it("fires an above-alert on WETH on base whose level is just under the live price", async () => {
    const live = await priceTokens([{ chain: "base", address: WETH }]);
    const quote = requireValue(live.quotes.get(ASSET_KEY));
    const level = (Number(quote.priceUsd) * 0.99).toFixed(2);
    const alert = await created({ value: level, triggerPrice: level, referencePrice: level });

    const emit = vi.fn<PriceAlertExecutorDeps["emit"]>();
    const report = await runPriceAlertTick({ ...buildProductionPriceAlertDeps(), emit });

    expect(report).toMatchObject({ active: 1, priced: 1, failed: 0, fired: 1 });
    expect(emit).toHaveBeenCalledTimes(1);
    const event = requireValue(emit.mock.calls[0])[0];
    expect(event.alertId).toBe(alert.id);
    expect(Number(event.triggeredPrice)).toBeGreaterThanOrEqual(Number(level));
    const row = requireValue(await repo.getAlert(alert.id));
    expect(row.status).toBe("triggered");
    console.log(`[live] WETH on base read ${quote.priceUsd} USD via ${quote.dexId}; level ${level}; fired at ${event.triggeredPrice} (${event.triggeredAt})`);
  });
});
