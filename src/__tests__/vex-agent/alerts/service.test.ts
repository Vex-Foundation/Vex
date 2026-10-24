import { describe, expect, it } from "vitest";

import type { PriceAlertRow, WatchlistItemRow } from "@vex-agent/db/repos/price-alerts.js";
import type { PriceTokensResult, TokenQuote } from "@vex-agent/alerts/price-source.js";
import {
  ACTIVE_ALERT_LIMIT,
  WATCHLIST_LIMIT,
  acknowledgeFired,
  addToWatchlist,
  cancelPriceAlert,
  readWatchlist,
  removeFromWatchlist,
  setPriceAlert,
  type AlertServiceDeps,
  type SetPriceAlertInput,
} from "@vex-agent/alerts/service.js";
import { parseBoundedDecimal, type BoundedDecimal } from "../../../tools/dexscreener/token-watch-price/decimal.js";

const WETH = "0x4200000000000000000000000000000000000006";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const NOW = new Date("2026-10-24T12:00:00.000Z");

function dec(raw: string): BoundedDecimal {
  const parsed = parseBoundedDecimal(raw);
  if (parsed === null) throw new Error(`not a decimal: ${raw}`);
  return parsed;
}

function quote(assetKey: string, priceUsd: string, symbol: string | null = "WETH"): TokenQuote {
  return { assetKey, priceUsd, price: dec(priceUsd), change24hPct: 1.5, pairAddress: "0xpool", dexId: "uniswap", symbol };
}

interface Fake {
  readonly deps: AlertServiceDeps;
  readonly watchlist: WatchlistItemRow[];
  readonly alerts: PriceAlertRow[];
  readonly acknowledgedIds: string[][];
}

function fake(prices: { quotes?: TokenQuote[]; failed?: string[] } = {}): Fake {
  const watchlist: WatchlistItemRow[] = [];
  const alerts: PriceAlertRow[] = [];
  const acknowledgedIds: string[][] = [];
  let seq = 0;
  const priceResult = (): PriceTokensResult => ({
    quotes: new Map((prices.quotes ?? []).map((q) => [q.assetKey, q])),
    failed: prices.failed ?? [],
  });
  const deps: AlertServiceDeps = {
    now: () => NOW,
    priceTokens: async () => priceResult(),
    repo: {
      listWatchlist: async () => [...watchlist],
      addWatchlistItem: async (input, limit) => {
        const found = watchlist.find((w) => w.assetKey === input.assetKey);
        if (found !== undefined) return { ok: true, item: found, created: false };
        if (watchlist.length >= limit) return { ok: false, reason: "watchlist_full" };
        const item = { id: `w${++seq}`, createdAt: NOW.toISOString(), ...input };
        watchlist.push(item);
        return { ok: true, item, created: true };
      },
      removeWatchlistItem: async (assetKey) => {
        const index = watchlist.findIndex((w) => w.assetKey === assetKey);
        if (index < 0) return false;
        watchlist.splice(index, 1);
        return true;
      },
      listAlerts: async ({ status }) => alerts.filter((a) => a.status === status),
      createAlert: async (input, limit) => {
        const found = alerts.find(
          (a) => a.status === "active" && a.assetKey === input.assetKey && a.condition === input.condition && a.value === input.value,
        );
        if (found !== undefined) return { ok: true, alert: found, created: false };
        if (alerts.filter((a) => a.status === "active").length >= limit) return { ok: false, reason: "too_many_alerts" };
        const alert: PriceAlertRow = {
          ...input,
          id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
          status: "active",
          triggeredAt: null,
          triggeredPrice: null,
          acknowledgedAt: null,
          createdAt: NOW.toISOString(),
        };
        alerts.push(alert);
        return { ok: true, alert, created: true };
      },
      cancelAlert: async (id) => {
        const index = alerts.findIndex((a) => a.id === id && a.status === "active");
        const found = alerts[index];
        if (found === undefined) return null;
        const cancelled: PriceAlertRow = { ...found, status: "cancelled" };
        alerts[index] = cancelled;
        return cancelled;
      },
      acknowledgeFired: async (ids) => {
        acknowledgedIds.push([...ids]);
        return ids.length;
      },
      clearFired: async (ids) => ids.length,
    },
  };
  return { deps, watchlist, alerts, acknowledgedIds };
}

function alertInput(over: Partial<SetPriceAlertInput> = {}): SetPriceAlertInput {
  return { chain: "base", tokenAddress: WETH, condition: "above", value: "4000", origin: "chat", sessionId: "s1", ...over };
}

const WETH_KEY = `base:${WETH}`;

describe("setPriceAlert", () => {
  it("stores a level alert with the read price as its reference", async () => {
    const f = fake({ quotes: [quote(WETH_KEY, "3500")] });
    const result = await setPriceAlert(alertInput({ value: "4000.00", note: " take profit " }), f.deps);
    expect(result).toMatchObject({ ok: true, status: "created", priceUsd: "3500" });
    expect(f.alerts[0]).toMatchObject({
      assetKey: WETH_KEY,
      value: "4000",
      referencePrice: "3500",
      triggerPrice: "4000",
      direction: "above",
      note: "take profit",
      label: "WETH",
      origin: "chat",
      sessionId: "s1",
    });
  });

  it("turns a percentage into its absolute level", async () => {
    const f = fake({ quotes: [quote(WETH_KEY, "2000")] });
    await setPriceAlert(alertInput({ condition: "falls_pct", value: "12.5" }), f.deps);
    expect(f.alerts[0]).toMatchObject({ triggerPrice: "1750", direction: "below", value: "12.5" });
  });

  it("returns the waiting alert as already_set on a replay", async () => {
    const f = fake({ quotes: [quote(WETH_KEY, "3500")] });
    const first = await setPriceAlert(alertInput(), f.deps);
    const again = await setPriceAlert(alertInput(), f.deps);
    if (!first.ok || !again.ok) throw new Error("expected alerts");
    expect(again.status).toBe("already_set");
    expect(again.alert.id).toBe(first.alert.id);
  });

  it("normalises an EVM address and accepts chain aliases", async () => {
    const f = fake({ quotes: [quote(WETH_KEY, "3500")] });
    const result = await setPriceAlert(alertInput({ tokenAddress: WETH.toUpperCase().replace("0X", "0x") }), f.deps);
    expect(result).toMatchObject({ ok: true });
    expect(f.alerts[0]?.address).toBe(WETH);
  });

  it("refuses by name", async () => {
    const priced = fake({ quotes: [quote(WETH_KEY, "3500")] });
    const cases: Array<[Partial<SetPriceAlertInput>, string]> = [
      [{ chain: "notachain" }, "unsupported_chain"],
      [{ chain: "solana", tokenAddress: WETH }, "invalid_address"],
      [{ tokenAddress: SOL_MINT }, "invalid_address"],
      [{ value: "0" }, "invalid_value"],
      [{ value: "1e3" }, "invalid_value"],
      [{ condition: "rises_pct", value: "1000.5" }, "invalid_value"],
      [{ condition: "falls_pct", value: "100" }, "invalid_value"],
      [{ note: "x".repeat(141) }, "invalid_note"],
      [{ label: "x".repeat(81) }, "invalid_label"],
      [{ value: "3500" }, "already_past"],
      [{ condition: "below", value: "3600" }, "already_past"],
    ];
    for (const [over, reason] of cases) {
      expect(await setPriceAlert(alertInput(over), priced.deps)).toMatchObject({ ok: false, reason });
    }
    expect(priced.alerts).toHaveLength(0);
  });

  it("says no_price, and words a failed read differently from an unpriced token", async () => {
    const unpriced = await setPriceAlert(alertInput(), fake().deps);
    const failed = await setPriceAlert(alertInput(), fake({ failed: [WETH_KEY] }).deps);
    expect(unpriced).toMatchObject({ ok: false, reason: "no_price" });
    expect(failed).toMatchObject({ ok: false, reason: "no_price" });
    if (unpriced.ok || failed.ok) throw new Error("expected refusals");
    expect(unpriced.message).not.toBe(failed.message);
  });

  it("refuses the 21st waiting alert", async () => {
    const f = fake({ quotes: [quote(WETH_KEY, "3500")] });
    for (let n = 0; n < ACTIVE_ALERT_LIMIT; n++) {
      expect(await setPriceAlert(alertInput({ value: String(4000 + n) }), f.deps)).toMatchObject({ ok: true });
    }
    expect(await setPriceAlert(alertInput({ value: "9999" }), f.deps)).toMatchObject({ ok: false, reason: "too_many_alerts" });
  });

  it("labels with the user's words, else the pool symbol, else a short address", async () => {
    const own = fake({ quotes: [quote(WETH_KEY, "3500")] });
    await setPriceAlert(alertInput({ label: "My ETH" }), own.deps);
    expect(own.alerts[0]?.label).toBe("My ETH");
    const bare = fake({ quotes: [quote(WETH_KEY, "3500", null)] });
    await setPriceAlert(alertInput(), bare.deps);
    expect(bare.alerts[0]?.label).toBe("0x4200...0006");
  });
});

describe("cancelPriceAlert", () => {
  it("cancels a waiting alert once, and calls anything else not_found", async () => {
    const f = fake({ quotes: [quote(WETH_KEY, "3500")] });
    const created = await setPriceAlert(alertInput(), f.deps);
    if (!created.ok) throw new Error("expected an alert");
    expect(await cancelPriceAlert({ alertId: created.alert.id }, f.deps)).toMatchObject({ ok: true });
    expect(await cancelPriceAlert({ alertId: created.alert.id }, f.deps)).toMatchObject({ ok: false, reason: "not_found" });
    expect(await cancelPriceAlert({ alertId: "not-a-uuid" }, f.deps)).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("watchlist", () => {
  it("follows a token with the pool symbol and returns it again on a replay", async () => {
    const f = fake({ quotes: [quote(WETH_KEY, "3500")] });
    expect(await addToWatchlist({ chain: "base", tokenAddress: WETH }, f.deps)).toMatchObject({
      ok: true,
      created: true,
      item: { label: "WETH", priceStatus: "priced", quote: { priceUsd: "3500" } },
    });
    expect(await addToWatchlist({ chain: "base", tokenAddress: WETH }, f.deps)).toMatchObject({ ok: true, created: false });
  });

  it("follows a token with no price yet, labelled by its address", async () => {
    const f = fake();
    expect(await addToWatchlist({ chain: "solana", tokenAddress: SOL_MINT }, f.deps)).toMatchObject({
      ok: true,
      item: { label: "So1111...1112", priceStatus: "no_price", quote: null },
    });
  });

  it("refuses the 31st token and an address that does not fit the chain", async () => {
    const f = fake();
    for (let n = 0; n < WATCHLIST_LIMIT; n++) {
      await addToWatchlist({ chain: "base", tokenAddress: `0x${n.toString(16).padStart(40, "0")}` }, f.deps);
    }
    expect(await addToWatchlist({ chain: "base", tokenAddress: WETH }, f.deps)).toMatchObject({ ok: false, reason: "watchlist_full" });
    expect(await addToWatchlist({ chain: "base", tokenAddress: "nope" }, f.deps)).toMatchObject({ ok: false, reason: "invalid_address" });
  });

  it("removes a followed token, and says not_found when there is none", async () => {
    const f = fake();
    await addToWatchlist({ chain: "base", tokenAddress: WETH }, f.deps);
    expect(await removeFromWatchlist({ assetKey: WETH_KEY }, f.deps)).toMatchObject({ ok: true });
    expect(await removeFromWatchlist({ assetKey: WETH_KEY }, f.deps)).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("readWatchlist", () => {
  it("prices every followed token and marks unpriced and failed rows apart", async () => {
    const SOL_KEY = `solana:${SOL_MINT}`;
    const other = `0x${"1".repeat(40)}`;
    const f = fake({ quotes: [quote(WETH_KEY, "3500")], failed: [SOL_KEY] });
    await addToWatchlist({ chain: "base", tokenAddress: WETH }, f.deps);
    await addToWatchlist({ chain: "solana", tokenAddress: SOL_MINT }, f.deps);
    await addToWatchlist({ chain: "base", tokenAddress: other }, f.deps);
    const snapshot = await readWatchlist({}, f.deps);
    expect(snapshot.items.map((i) => i.priceStatus)).toEqual(["priced", "unavailable", "no_price"]);
    expect(snapshot.limits).toEqual({ watchlist: 30, activeAlerts: 20 });
    expect(snapshot.pricedAt).toBe(NOW.toISOString());
  });
});

describe("acknowledgeFired", () => {
  it("passes only well-formed ids, and clears when asked", async () => {
    const f = fake();
    const id = "00000000-0000-4000-8000-000000000001";
    expect(await acknowledgeFired({ alertIds: [id, "bad"], clear: true }, f.deps)).toEqual({ ok: true, acknowledged: 1, cleared: 1 });
    expect(f.acknowledgedIds).toEqual([[id]]);
  });
});
