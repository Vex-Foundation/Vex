import { describe, expect, it } from "vitest";
import type { LighterTradingAccount, LighterTradingMarket } from "../../../../../shared/schemas/lighter-trading.js";
import {
  buildDeskContext,
  deskChartScopeKey,
  deskQuickPrompts,
  deskScopeLabel,
  deskScopeTag,
  describeChartNotes,
  withDeskScope,
  type DeskChartNotes,
  type DeskContextScope,
} from "../desk-context.js";
import { DEFAULT_CHART_PREFERENCES } from "../chart-preferences.js";

const MARKET: LighterTradingMarket = {
  marketId: 1,
  symbol: "BTC",
  marketType: "perp",
  status: "active",
  baseAssetId: 1,
  quoteAssetId: 3,
  minBaseAmount: "0.0001",
  minQuoteAmount: "10",
  orderQuoteLimit: "100000",
  decimals: { size: 5, price: 1, quote: 6 },
  fees: { maker: "0", taker: "0.0003", makerEnabled: false, takerEnabled: true },
  activity24h: { tradesCount: 120, quoteVolume: 1_600_000 },
  margin: { defaultInitialMarginFraction: 1_000, minInitialMarginFraction: 200, maintenanceMarginFraction: 400 },
};

const SCOPE: DeskContextScope = { environment: "core", market: MARKET, resolution: "15m" };

const POSITION: LighterTradingAccount["positions"][number] = {
  marketId: 1,
  symbol: "BTC",
  side: "short",
  size: "0.25",
  entryPrice: "64000",
  value: "16000",
  unrealizedPnl: "120",
  liquidationPrice: "70100",
  initialMarginFraction: 1_000,
  marginMode: "cross",
  allocatedMargin: "1600",
};

describe("desk scope", () => {
  it("tags a typed message with the exact scope and forbids inferring it from the symbol", () => {
    const tag = deskScopeTag(SCOPE);
    expect(tag).toBe(
      "Lighter desk scope: environment=core, marketId=1, marketType=perp, symbol=BTC, candleInterval=15m. Do not infer the environment or product from the symbol.",
    );
    expect(withDeskScope("should I trim?", tag)).toBe(`should I trim?\n\n${tag}`);
    expect(deskScopeLabel(SCOPE)).toBe("Core · BTC · 15m");
    expect(deskScopeLabel({ ...SCOPE, environment: "rhc" })).toBe("RHC · BTC · 15m");
  });
});

describe("chart notes", () => {
  // 2026-09-17 10:00 UTC and 12:00 UTC.
  const T1 = 1_789_639_200;
  const T2 = T1 + 7_200;
  const CHART: DeskChartNotes = {
    preferences: { ...DEFAULT_CHART_PREFERENCES, studies: ["rsi", "sma"], periods: { sma: 50, ema: 20, bb: 20, rsi: 14 } },
    drawings: [
      { id: "h", kind: "horizontal", a: { time: T1, price: 64000 }, b: { time: T1, price: 64000 } },
      { id: "t", kind: "trend", a: { time: T1, price: 63000.25 }, b: { time: T2, price: 65000 } },
      { id: "r", kind: "rectangle", a: { time: T2, price: 64500 }, b: { time: T1, price: 63500 } },
      { id: "f", kind: "fib", a: { time: T1, price: 62000 }, b: { time: T2, price: 66000 } },
      { id: "m", kind: "measure", a: { time: T1, price: 63000 }, b: { time: T2, price: 64000 } },
    ],
  };

  it("reads out indicators in toolbar order and every drawing at market precision", () => {
    expect(describeChartNotes(CHART, MARKET)).toBe(
      "Indicators on the trader's chart: SMA 50, RSI 14. "
      + "Drawings the trader placed on the chart: horizontal line at 64000.0; "
      + "trend line from 63000.3 (2026-09-17 10:00 UTC) to 65000.0 (2026-09-17 12:00 UTC); "
      + "rectangle 63500.0 to 64500.0 between 2026-09-17 10:00 UTC and 2026-09-17 12:00 UTC; "
      + "fib retracement from 62000.0 (2026-09-17 10:00 UTC) to 66000.0 (2026-09-17 12:00 UTC); "
      + "measured move from 63000.0 (2026-09-17 10:00 UTC) to 64000.0 (2026-09-17 12:00 UTC). "
      + "Refer to these levels by their prices.",
    );
  });

  it("says nothing for a bare chart and keeps the scope unchanged without notes", () => {
    expect(describeChartNotes(undefined, MARKET)).toBe("");
    expect(describeChartNotes({ preferences: DEFAULT_CHART_PREFERENCES, drawings: [] }, MARKET)).toBe("");
    const bare = buildDeskContext(SCOPE);
    expect(buildDeskContext({ ...SCOPE, chart: { preferences: DEFAULT_CHART_PREFERENCES, drawings: [] } })).toBe(bare);
    expect(bare.endsWith("do not infer the environment or product from the symbol.")).toBe(true);
  });

  it("carries the notes into the prompts and the typed-message tag", () => {
    const scope = { ...SCOPE, chart: CHART };
    const notes = describeChartNotes(CHART, MARKET);
    expect(buildDeskContext(scope).endsWith(` ${notes}`)).toBe(true);
    expect(deskScopeTag(scope).endsWith(` ${notes}`)).toBe(true);
    expect(deskScopeTag(SCOPE)).not.toContain("Drawings");
    for (const prompt of deskQuickPrompts(scope, null)) expect(prompt.message).toContain("horizontal line at 64000.0");
    expect(deskChartScopeKey("rhc", 7)).toBe("rhc:7");
  });
});

describe("deskQuickPrompts", () => {
  it("flat on the market: reads and 1% risk plans, every one scoped and non-executing", () => {
    const prompts = deskQuickPrompts(SCOPE, null);
    expect(prompts.map((p) => p.label)).toEqual([
      "Analyze chart",
      "Find liquidity",
      "Plan long · 1%",
      "Plan short · 1%",
    ]);
    for (const prompt of prompts) {
      expect(prompt.message.startsWith(buildDeskContext(SCOPE))).toBe(true);
      expect(prompt.message).toContain("Do not execute anything.");
    }
    expect(prompts[2]?.message).toContain("Plan a long risking 1%");
    expect(prompts[3]?.message).toContain("Plan a short risking 1%");
  });

  it("in a position: manages what is open and names the position", () => {
    const prompts = deskQuickPrompts(SCOPE, POSITION);
    expect(prompts.map((p) => p.label)).toEqual([
      "Should I trim?",
      "Set a protective stop",
      "What invalidates this?",
    ]);
    for (const prompt of prompts) {
      expect(prompt.message).toContain("I am short 0.25 BTC from 64000.");
      expect(prompt.message).toContain("Do not execute anything.");
    }
  });

  it("omits the entry when Lighter did not report one", () => {
    const [trim] = deskQuickPrompts(SCOPE, { ...POSITION, entryPrice: null });
    expect(trim?.message).toContain("I am short 0.25 BTC. Should I trim?");
  });
});
