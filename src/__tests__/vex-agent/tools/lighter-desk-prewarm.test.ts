/**
 * The desk pre-warm cache (`LIGHTER_DESK_PREWARM`): what it keeps, for how
 * long, and when a stream book may stand in for the margin-fit depth read.
 * The preview-level OFF==ON proof lives in
 * `lighter-preview-single-snapshot.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";

import type {
  LighterAccountLimitsResponse,
  LighterAccountResponse,
  LighterSystemConfigResponse,
} from "@tools/lighter/types.js";
import {
  clearLighterDeskPrewarm,
  configureLighterDeskPrewarmBookDepth,
  LIGHTER_DESK_PREWARM_ACCOUNT_LIMITS_MAX_AGE_MS,
  LIGHTER_DESK_PREWARM_BOOK_LEVELS,
  LIGHTER_DESK_PREWARM_BOOK_MAX_AGE_MS,
  LIGHTER_DESK_PREWARM_FEE_CONFIG_MAX_AGE_MS,
  recordLighterDeskPrewarmAccountLimits,
  recordLighterDeskPrewarmFeeConfig,
  takeLighterDeskPrewarmAccountLimits,
  takeLighterDeskPrewarmBookDepth,
  takeLighterDeskPrewarmFeeConfig,
  type LighterStreamBookDepth,
} from "@vex-agent/tools/protocols/lighter/desk-prewarm.js";
import { LIGHTER_ORDER_PREVIEW_FRESHNESS_MS } from "@tools/lighter/order-preview.js";
import { requireValue } from "../../helpers/require-value.js";

const NOW = 1_800_000_000_000;

const SYSTEM_CONFIG: LighterSystemConfigResponse = {
  code: 200,
  liquidity_pool_index: 1,
  staking_pool_index: 2,
  funding_fee_rebate_account_index: 3,
  market_maker_incentive_account_index: 4,
  liquidity_pool_cooldown_period: 0,
  staking_pool_lockup_period: 0,
  max_integrator_perps_maker_fee: 1_000_000,
  max_integrator_perps_taker_fee: 1_000_000,
  max_integrator_spot_maker_fee: 1_000_000,
  max_integrator_spot_taker_fee: 1_000_000,
};
const COLLECTOR: LighterAccountResponse = {
  code: 200,
  total: 1,
  accounts: [{ index: 99, status: 1, l1_address: `0x${"2".repeat(40)}` }],
};
const LIMITS: LighterAccountLimitsResponse = {
  code: 200,
  user_tier: "premium",
  user_tier_name: "Premium",
  current_maker_fee_tick: 120,
  current_taker_fee_tick: 350,
};

function depth(overrides: Partial<LighterStreamBookDepth> = {}): LighterStreamBookDepth {
  return {
    environment: "rhc",
    marketId: 0,
    marketType: "perp",
    receivedAtMs: NOW,
    asks: [{ price: "3500.50", size: "2" }, { price: "3505.00", size: "5" }],
    bids: [{ price: "3499.50", size: "2" }, { price: "3490", size: "1.5" }],
    ...overrides,
  };
}

function take(nowMs = NOW) {
  return takeLighterDeskPrewarmBookDepth({ environment: "rhc", marketId: 0, marketType: "perp", nowMs });
}

afterEach(() => {
  clearLighterDeskPrewarm();
  configureLighterDeskPrewarmBookDepth(null);
});

describe("desk pre-warm fee config", () => {
  it("lives no longer than an approval card may, and only for the collector it was read for", () => {
    expect(LIGHTER_DESK_PREWARM_FEE_CONFIG_MAX_AGE_MS).toBe(LIGHTER_ORDER_PREVIEW_FRESHNESS_MS);
    recordLighterDeskPrewarmFeeConfig({
      environment: "rhc",
      collectorAccountIndex: 99,
      systemConfig: SYSTEM_CONFIG,
      collectorAccount: COLLECTOR,
      atMs: NOW,
    });
    expect(takeLighterDeskPrewarmFeeConfig("rhc", 99, NOW + LIGHTER_DESK_PREWARM_FEE_CONFIG_MAX_AGE_MS)).toEqual({
      systemConfig: SYSTEM_CONFIG,
      collectorAccount: COLLECTOR,
    });
    expect(takeLighterDeskPrewarmFeeConfig("rhc", 99, NOW + LIGHTER_DESK_PREWARM_FEE_CONFIG_MAX_AGE_MS + 1)).toBeNull();
    expect(takeLighterDeskPrewarmFeeConfig("rhc", 99, NOW - 1)).toBeNull();
    expect(takeLighterDeskPrewarmFeeConfig("rhc", 100, NOW)).toBeNull();
    expect(takeLighterDeskPrewarmFeeConfig("core", 99, NOW)).toBeNull();
  });

  it("keeps no answer whose code is not 200", () => {
    recordLighterDeskPrewarmFeeConfig({
      environment: "rhc",
      collectorAccountIndex: 99,
      systemConfig: { ...SYSTEM_CONFIG, code: 500 },
      collectorAccount: COLLECTOR,
      atMs: NOW,
    });
    expect(takeLighterDeskPrewarmFeeConfig("rhc", 99, NOW)).toBeNull();
    recordLighterDeskPrewarmFeeConfig({
      environment: "rhc",
      collectorAccountIndex: 99,
      systemConfig: SYSTEM_CONFIG,
      collectorAccount: { ...COLLECTOR, code: 404 },
      atMs: NOW,
    });
    expect(takeLighterDeskPrewarmFeeConfig("rhc", 99, NOW)).toBeNull();
  });

  it("keeps a frozen private copy, so neither the recorder nor a reader can change it", () => {
    const systemConfig = { ...SYSTEM_CONFIG };
    recordLighterDeskPrewarmFeeConfig({
      environment: "rhc",
      collectorAccountIndex: 99,
      systemConfig,
      collectorAccount: COLLECTOR,
      atMs: NOW,
    });
    systemConfig.max_integrator_perps_taker_fee = 0;
    const kept = requireValue(takeLighterDeskPrewarmFeeConfig("rhc", 99, NOW));
    expect(kept.systemConfig.max_integrator_perps_taker_fee).toBe(1_000_000);
    expect(Object.isFrozen(kept.systemConfig)).toBe(true);
    expect(Object.isFrozen(kept.collectorAccount.accounts[0])).toBe(true);
  });
});

describe("desk pre-warm account limits", () => {
  it("lives briefly, per environment and account", () => {
    recordLighterDeskPrewarmAccountLimits({ environment: "rhc", accountIndex: 42, response: LIMITS, atMs: NOW });
    expect(takeLighterDeskPrewarmAccountLimits("rhc", 42, NOW + LIGHTER_DESK_PREWARM_ACCOUNT_LIMITS_MAX_AGE_MS)).toEqual(LIMITS);
    expect(takeLighterDeskPrewarmAccountLimits("rhc", 42, NOW + LIGHTER_DESK_PREWARM_ACCOUNT_LIMITS_MAX_AGE_MS + 1)).toBeNull();
    expect(takeLighterDeskPrewarmAccountLimits("rhc", 42, NOW - 1)).toBeNull();
    expect(takeLighterDeskPrewarmAccountLimits("rhc", 43, NOW)).toBeNull();
    expect(takeLighterDeskPrewarmAccountLimits("core", 42, NOW)).toBeNull();
  });

  it("keeps no answer whose code is not 200, and forgets everything when cleared", () => {
    recordLighterDeskPrewarmAccountLimits({ environment: "rhc", accountIndex: 42, response: { ...LIMITS, code: 401 }, atMs: NOW });
    expect(takeLighterDeskPrewarmAccountLimits("rhc", 42, NOW)).toBeNull();
    recordLighterDeskPrewarmAccountLimits({ environment: "rhc", accountIndex: 42, response: LIMITS, atMs: NOW });
    recordLighterDeskPrewarmFeeConfig({
      environment: "rhc",
      collectorAccountIndex: 99,
      systemConfig: SYSTEM_CONFIG,
      collectorAccount: COLLECTOR,
      atMs: NOW,
    });
    clearLighterDeskPrewarm();
    expect(takeLighterDeskPrewarmAccountLimits("rhc", 42, NOW)).toBeNull();
    expect(takeLighterDeskPrewarmFeeConfig("rhc", 99, NOW)).toBeNull();
  });
});

describe("desk pre-warm book depth", () => {
  it("hands the margin-fit check the live book as one entry per level, best first", () => {
    configureLighterDeskPrewarmBookDepth(() => depth());
    const book = requireValue(take(NOW + LIGHTER_DESK_PREWARM_BOOK_MAX_AGE_MS));
    expect(book.code).toBe(200);
    expect(book.asks.map((order) => [order.price, order.remaining_base_amount])).toEqual([["3500.50", "2"], ["3505.00", "5"]]);
    expect(book.bids.map((order) => [order.price, order.remaining_base_amount])).toEqual([["3499.50", "2"], ["3490", "1.5"]]);
    expect(book.total_asks).toBe(2);
  });

  it("asks the reader for, and keeps, at most the REST read's depth per side", () => {
    let asked = 0;
    const many = Array.from({ length: 80 }, (_unused, index) => ({ price: String(3500 + index), size: "1" }));
    configureLighterDeskPrewarmBookDepth((_environment, _marketId, maxLevels) => {
      asked = maxLevels;
      return depth({ asks: many });
    });
    const book = requireValue(take());
    expect(asked).toBe(LIGHTER_DESK_PREWARM_BOOK_LEVELS);
    expect(book.asks).toHaveLength(LIGHTER_DESK_PREWARM_BOOK_LEVELS);
  });

  it.each([
    { label: "no reader is installed", reader: null },
    { label: "the reader throws", reader: () => { throw new Error("socket closed"); } },
    { label: "there is no live book", reader: () => null },
    { label: "the book is for another environment", reader: () => depth({ environment: "core" }) },
    { label: "the book is for another market", reader: () => depth({ marketId: 1 }) },
    { label: "the book is for another market type", reader: () => depth({ marketType: "spot" }) },
    { label: "the last frame is too old", reader: () => depth({ receivedAtMs: NOW - LIGHTER_DESK_PREWARM_BOOK_MAX_AGE_MS - 1 }) },
    { label: "the last frame is in the future", reader: () => depth({ receivedAtMs: NOW + 1 }) },
    { label: "a side is empty", reader: () => depth({ bids: [] }) },
    { label: "a price is malformed", reader: () => depth({ asks: [{ price: "3,500", size: "1" }] }) },
    { label: "a size is zero", reader: () => depth({ asks: [{ price: "3500.50", size: "0.000" }] }) },
    { label: "a side is not sorted best first", reader: () => depth({ asks: [{ price: "3505", size: "1" }, { price: "3500", size: "1" }] }) },
    { label: "the book is crossed", reader: () => depth({ bids: [{ price: "3501", size: "1" }] }) },
  ])("reads Lighter instead when $label", ({ reader }) => {
    configureLighterDeskPrewarmBookDepth(reader);
    expect(take()).toBeNull();
  });

  it("uninstalls only the reader it installed", () => {
    const first = configureLighterDeskPrewarmBookDepth(() => depth());
    configureLighterDeskPrewarmBookDepth(() => depth({ marketId: 1 }));
    first();
    expect(take()).toBeNull();
  });
});
