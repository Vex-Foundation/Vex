/**
 * The price alert poller (F01), with injected deps.
 *
 * Pins: an idle tick reads no price, a price-read failure ends the tick and
 * the loop survives, an alert at or past its level is claimed once and only a
 * claimed row is announced (after the claim), a lost claim announces nothing,
 * an unpriced token is skipped, and stop() aborts the in-flight tick before
 * draining it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseBoundedDecimal } from "@tools/dexscreener/token-watch-price/decimal.js";
import type { PriceAlertRow } from "@vex-agent/db/repos/price-alerts.js";
import {
  runPriceAlertTick,
  startPriceAlertExecutor,
  type PriceAlertExecutorDeps,
} from "@vex-agent/alerts/price-alert-executor.js";
import type { PriceTokensResult, TokenQuote } from "@vex-agent/alerts/price-source.js";
import { requireValue } from "../../helpers/require-value.js";

const WETH = "0x4200000000000000000000000000000000000006";
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
const NOW = new Date("2026-10-24T12:00:00.000Z");

function alert(over: Partial<PriceAlertRow> = {}): PriceAlertRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    chain: "base",
    address: WETH,
    assetKey: `base:${WETH}`,
    label: "WETH",
    condition: "above",
    value: "4000",
    referencePrice: "3900",
    triggerPrice: "4000",
    direction: "above",
    note: null,
    origin: "chat",
    sessionId: null,
    status: "active",
    triggeredAt: null,
    triggeredPrice: null,
    acknowledgedAt: null,
    createdAt: "2026-10-24T11:00:00.000Z",
    ...over,
  };
}

function quote(assetKey: string, priceUsd: string): TokenQuote {
  return {
    assetKey,
    priceUsd,
    price: requireValue(parseBoundedDecimal(priceUsd)),
    change24hPct: null,
    pairAddress: "0xpair",
    dexId: "aerodrome",
    symbol: "WETH",
  };
}

function prices(entries: readonly (readonly [string, string])[], failed: readonly string[] = []): PriceTokensResult {
  return { quotes: new Map(entries.map(([key, price]) => [key, quote(key, price)])), failed };
}

/** Deps recording the order of claims and announcements. */
function deps(over: Partial<PriceAlertExecutorDeps> = {}) {
  const order: string[] = [];
  const emit = vi.fn<PriceAlertExecutorDeps["emit"]>((event) => {
    order.push(`emit:${event.alertId}`);
  });
  const claimTriggered = vi.fn<PriceAlertExecutorDeps["claimTriggered"]>(async (id, price, at) => {
    order.push(`claim:${id}`);
    return alert({ id, status: "triggered", triggeredPrice: price, triggeredAt: at.toISOString() });
  });
  const built: PriceAlertExecutorDeps = {
    listActiveForPoll: vi.fn<PriceAlertExecutorDeps["listActiveForPoll"]>(async () => []),
    claimTriggered,
    priceTokens: vi.fn<PriceAlertExecutorDeps["priceTokens"]>(async () => prices([])),
    emit,
    now: () => NOW,
    ...over,
  };
  return { deps: built, order, emit, claimTriggered };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runPriceAlertTick", () => {
  it("reads no price when nothing is active", async () => {
    const { deps: d } = deps();
    const report = await runPriceAlertTick(d);
    expect(report).toEqual({ active: 0, priced: 0, failed: 0, fired: 0, lostClaims: 0 });
    expect(d.priceTokens).not.toHaveBeenCalled();
  });

  it("claims an alert whose level was reached, then announces it", async () => {
    const { deps: d, order, emit } = deps({
      listActiveForPoll: vi.fn(async () => [alert()]),
      priceTokens: vi.fn(async () => prices([[`base:${WETH}`, "4012.5"]])),
    });
    const report = await runPriceAlertTick(d);
    expect(report.fired).toBe(1);
    expect(order).toEqual(["claim:11111111-1111-4111-8111-111111111111", "emit:11111111-1111-4111-8111-111111111111"]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      alertId: "11111111-1111-4111-8111-111111111111",
      triggerPrice: "4000",
      triggeredPrice: "4012.5",
      triggeredAt: NOW.toISOString(),
    }));
  });

  it("counts touching the level as reaching it", async () => {
    const { deps: d } = deps({
      listActiveForPoll: vi.fn(async () => [alert({ direction: "below", condition: "below", triggerPrice: "3500" })]),
      priceTokens: vi.fn(async () => prices([[`base:${WETH}`, "3500"]])),
    });
    expect((await runPriceAlertTick(d)).fired).toBe(1);
  });

  it("leaves an alert short of its level active", async () => {
    const { deps: d, claimTriggered } = deps({
      listActiveForPoll: vi.fn(async () => [alert()]),
      priceTokens: vi.fn(async () => prices([[`base:${WETH}`, "3999.99"]])),
    });
    expect((await runPriceAlertTick(d)).fired).toBe(0);
    expect(claimTriggered).not.toHaveBeenCalled();
  });

  it("announces nothing for a lost claim", async () => {
    const { deps: d, emit } = deps({
      listActiveForPoll: vi.fn(async () => [alert()]),
      priceTokens: vi.fn(async () => prices([[`base:${WETH}`, "4100"]])),
      claimTriggered: vi.fn(async () => null),
    });
    const report = await runPriceAlertTick(d);
    expect(report).toMatchObject({ fired: 0, lostClaims: 1 });
    expect(emit).not.toHaveBeenCalled();
  });

  it("skips an unpriced token and still fires a priced one", async () => {
    const aero = alert({ id: "22222222-2222-4222-8222-222222222222", address: AERO, assetKey: `base:${AERO}`, triggerPrice: "1" });
    const { deps: d, emit } = deps({
      listActiveForPoll: vi.fn(async () => [alert(), aero]),
      priceTokens: vi.fn(async () => prices([[`base:${AERO}`, "1.2"]], [`base:${WETH}`])),
    });
    const report = await runPriceAlertTick(d);
    expect(report).toMatchObject({ active: 2, priced: 1, failed: 1, fired: 1 });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ alertId: "22222222-2222-4222-8222-222222222222" }));
  });

  it("prices each token once, however many alerts it has", async () => {
    const priceTokens = vi.fn<PriceAlertExecutorDeps["priceTokens"]>(async () => prices([]));
    const { deps: d } = deps({
      listActiveForPoll: vi.fn(async () => [alert(), alert({ id: "33333333-3333-4333-8333-333333333333", triggerPrice: "5000" })]),
      priceTokens,
    });
    await runPriceAlertTick(d);
    expect(priceTokens).toHaveBeenCalledTimes(1);
    const assets = requireValue(priceTokens.mock.calls[0])[0];
    expect(assets.map((a) => a.address)).toEqual([WETH, WETH]);
  });

  it("ends the tick when the price read throws, announcing nothing", async () => {
    const { deps: d, emit } = deps({
      listActiveForPoll: vi.fn(async () => [alert()]),
      priceTokens: vi.fn(async () => {
        throw new Error("provider down");
      }),
    });
    await expect(runPriceAlertTick(d)).rejects.toThrow("provider down");
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("startPriceAlertExecutor", () => {
  it("keeps polling after a failed tick", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const listActiveForPoll = vi.fn<PriceAlertExecutorDeps["listActiveForPoll"]>(async () => {
      calls += 1;
      if (calls === 1) throw new Error("db hiccup");
      return [];
    });
    const { deps: d } = deps({ listActiveForPoll });
    const handle = startPriceAlertExecutor({ intervalMs: 1_000, jitterMs: 0, deps: d });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listActiveForPoll).toHaveBeenCalledTimes(2);
    await handle.stop();
  });

  it("aborts the in-flight tick before draining on stop", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const { deps: d } = deps({
      listActiveForPoll: vi.fn(async () => [alert()]),
      priceTokens: vi.fn((_assets, options) => {
        seen = options?.signal;
        return new Promise<PriceTokensResult>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(prices([])));
        });
      }),
    });
    const handle = startPriceAlertExecutor({ intervalMs: 1_000, jitterMs: 0, deps: d });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen?.aborted).toBe(false);
    await handle.stop();
    expect(seen?.aborted).toBe(true);
  });

  it("schedules nothing after stop", async () => {
    vi.useFakeTimers();
    const { deps: d } = deps();
    const handle = startPriceAlertExecutor({ intervalMs: 1_000, jitterMs: 0, deps: d });
    await handle.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(d.listActiveForPoll).not.toHaveBeenCalled();
  });
});
