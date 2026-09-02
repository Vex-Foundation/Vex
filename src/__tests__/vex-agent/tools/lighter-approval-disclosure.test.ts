import { describe, expect, it } from "vitest";

import { ErrorCodes } from "../../../errors.js";
import { buildLighterOrderApprovalDisclosure } from "@vex-agent/tools/protocols/lighter/approval-disclosure.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";

const ORDER_EXPIRY_MS = Date.parse("2030-01-01T00:00:00.000Z");

function previewRow(overrides: Partial<LighterOrderPreviewRow> = {}): LighterOrderPreviewRow {
  return {
    previewId: "lighter-preview-1",
    sessionId: "session-1",
    matchHash: "a".repeat(64),
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    marketIndex: 0,
    side: "buy",
    baseAmountInteger: "12500",
    priceInteger: "299999",
    orderType: "limit",
    timeInForce: "good-till-time",
    reduceOnly: false,
    triggerPriceInteger: null,
    orderExpiryMs: ORDER_EXPIRY_MS,
    clientOrderIndexPolicy: "vex_assigned_uint48",
    providerVersion: "lighter-order-preview-v1",
    previewJson: {
      symbol: "ETH",
      marketType: "perp",
      baseAmount: { display: "1.25", integer: "12500", decimals: 4 },
      price: { display: "2999.99", integer: "299999", decimals: 2 },
      quoteNotional: { display: "3749.9875", integer: "3749987500", decimals: 6 },
    },
    liveSourceJson: { source: "live_lighter_public_api" },
    createdAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  } as LighterOrderPreviewRow;
}

function intentRow(
  overrides: Partial<LighterOrderExecutionIntentRow> = {},
): LighterOrderExecutionIntentRow {
  return {
    intentId: "lighter-exec-00000000-0000-4000-8000-000000000001",
    sessionId: "session-1",
    previewId: "lighter-preview-1",
    matchHash: "a".repeat(64),
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    marketIndex: 0,
    side: "buy",
    baseAmountInteger: "12500",
    priceInteger: "299999",
    orderType: "limit",
    timeInForce: "good-till-time",
    reduceOnly: false,
    triggerPriceInteger: null,
    orderExpiryMs: ORDER_EXPIRY_MS,
    clientOrderIndexPolicy: "vex_assigned_uint48",
    providerVersion: "lighter-order-preview-v1",
    ...overrides,
  } as LighterOrderExecutionIntentRow;
}

describe("Lighter order approval disclosure", () => {
  it("derives human-readable fields from the exact signed integers and market decimals", () => {
    const disclosure = buildLighterOrderApprovalDisclosure(intentRow(), previewRow());

    expect(disclosure).toEqual({
      marketSymbol: "ETH",
      marketType: "perp",
      baseAmountDisplay: "1.25",
      priceDisplay: "2999.99",
      triggerPriceDisplay: null,
      notionalDisplay: "3749.9875",
      orderExpiryIso: "2030-01-01T00:00:00.000Z",
      orderSummary: expect.stringContaining("Buy 1.25 ETH at limit price 2999.99"),
    });
    expect(disclosure.orderSummary).toContain("est. notional 3749.9875");
    expect(disclosure.orderSummary).toContain("Robinhood Chain Lighter (rhc)");
    expect(disclosure.orderSummary).toContain("perpetual market");
    expect(disclosure.orderSummary).toContain("Keep open");
    expect(disclosure.orderSummary).toContain("API acceptance is not final execution.");
    expect(disclosure.orderSummary).not.toContain("reduce-only");
  });

  it("discloses the trigger separately from the hard execution bound", () => {
    const disclosure = buildLighterOrderApprovalDisclosure(
      intentRow({
        side: "sell",
        orderType: "stop-loss",
        timeInForce: "immediate-or-cancel",
        reduceOnly: true,
        triggerPriceInteger: "290000",
      }),
      previewRow({
        side: "sell",
        orderType: "stop-loss",
        timeInForce: "immediate-or-cancel",
        reduceOnly: true,
        triggerPriceInteger: "290000",
      }),
    );

    expect(disclosure.triggerPriceDisplay).toBe("2900");
    expect(disclosure.orderSummary).toContain("hard execution bound 2999.99");
    expect(disclosure.orderSummary).toContain("stop-loss trigger 2900");
    expect(disclosure.orderSummary).toContain("reduce-only");
    expect(disclosure.orderSummary).toContain("signed trigger-order expiry 2030-01-01T00:00:00.000Z");
  });

  it("labels a trigger-limit price and warns that the post-trigger order may not fill", () => {
    const disclosure = buildLighterOrderApprovalDisclosure(
      intentRow({
        side: "sell",
        orderType: "stop-loss-limit",
        timeInForce: "good-till-time",
        reduceOnly: true,
        triggerPriceInteger: "290000",
      }),
      previewRow({
        side: "sell",
        orderType: "stop-loss-limit",
        timeInForce: "good-till-time",
        reduceOnly: true,
        triggerPriceInteger: "290000",
      }),
    );

    expect(disclosure.orderSummary).toContain("limit price 2999.99");
    expect(disclosure.orderSummary).toContain("stop-loss-limit trigger 2900");
    expect(disclosure.orderSummary).toContain("may remain open until filled or expired and may never fill");
  });

  it("makes the user-selected resting behavior explicit", () => {
    expect(buildLighterOrderApprovalDisclosure(intentRow(), previewRow()).orderSummary)
      .toContain("Any unfilled amount may remain open until filled or expired.");
    expect(buildLighterOrderApprovalDisclosure(intentRow(), previewRow()).orderSummary)
      .toContain("signed order expiry 2030-01-01T00:00:00.000Z");
    expect(buildLighterOrderApprovalDisclosure(
      intentRow({ timeInForce: "post-only" }),
      previewRow({ timeInForce: "post-only" }),
    ).orderSummary).toContain("maker-only order is not allowed to take liquidity");
  });

  it("names Core explicitly and labels a market order's worst acceptable price", () => {
    const disclosure = buildLighterOrderApprovalDisclosure(
      intentRow({
        environment: "core",
        side: "sell",
        orderType: "market",
        timeInForce: "immediate-or-cancel",
        reduceOnly: true,
      }),
      previewRow({
        environment: "core",
        side: "sell",
        orderType: "market",
        timeInForce: "immediate-or-cancel",
        reduceOnly: true,
      }),
    );

    expect(disclosure.orderSummary).toContain("Sell 1.25 ETH at worst acceptable price 2999.99");
    expect(disclosure.orderSummary).toContain("Lighter Core (core)");
    expect(disclosure.orderSummary).toContain("Immediate only");
    expect(disclosure.orderSummary).toContain("reduce-only");
    expect(disclosure.orderSummary).toContain("Any unfilled remainder is canceled immediately.");
    expect(disclosure.orderSummary).toContain("stored, unsent expiry reference 2030-01-01T00:00:00.000Z");
    expect(disclosure.orderSummary).toContain("this timestamp is not the approval deadline");
    expect(disclosure.orderSummary).toContain("is not signed as an order expiry");
    expect(disclosure.orderSummary).toContain("nil (0) OrderExpiry");
    expect(disclosure.orderSummary).toContain("immediate-only order");
    expect(disclosure.orderSummary).not.toContain("signed order expiry");
  });

  it("uses nil-expiry wording for an ordinary limit IOC", () => {
    const disclosure = buildLighterOrderApprovalDisclosure(
      intentRow({ timeInForce: "immediate-or-cancel" }),
      previewRow({ timeInForce: "immediate-or-cancel" }),
    );

    expect(disclosure.orderSummary).toContain("this timestamp is not the approval deadline");
    expect(disclosure.orderSummary).toContain("is not signed as an order expiry");
    expect(disclosure.orderSummary).toContain("nil (0) OrderExpiry");
  });

  it("names the spot product explicitly", () => {
    const disclosure = buildLighterOrderApprovalDisclosure(
      intentRow({ environment: "core", marketIndex: 2_048, orderType: "market", timeInForce: "immediate-or-cancel" }),
      previewRow({
        environment: "core",
        marketIndex: 2_048,
        orderType: "market",
        timeInForce: "immediate-or-cancel",
        previewJson: {
          ...previewRow().previewJson,
          marketType: "spot",
          symbol: "ETH/USDC",
        },
      }),
    );

    expect(disclosure.marketType).toBe("spot");
    expect(disclosure.orderSummary).toContain("spot market on Lighter Core");
  });

  it("refuses when the persisted preview no longer matches the prepared intent", () => {
    expect(() =>
      buildLighterOrderApprovalDisclosure(
        intentRow({ priceInteger: "300001" }),
        previewRow(),
      )).toThrowError(expect.objectContaining({
        code: ErrorCodes.LIGHTER_INVALID_REQUEST,
        message: expect.stringContaining("no order was signed or submitted"),
      }));
  });

  it("refuses semantic drift between the persisted preview and intent", () => {
    expect(() => buildLighterOrderApprovalDisclosure(
      intentRow({ timeInForce: "post-only" }),
      previewRow({ timeInForce: "good-till-time" }),
    )).toThrowError(expect.objectContaining({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
      message: expect.stringContaining("no longer matches"),
    }));
  });

  it("refuses when the persisted preview lacks symbol or decimal precision", () => {
    for (const previewJson of [
      { marketType: "perp", baseAmount: { decimals: 4 }, price: { decimals: 2 }, quoteNotional: { decimals: 6 } },
      { marketType: "perp", symbol: "ETH", price: { decimals: 2 }, quoteNotional: { decimals: 6 } },
      {
        marketType: "perp",
        symbol: "ETH",
        baseAmount: { decimals: 4 },
        price: { decimals: 2 },
        quoteNotional: { decimals: 99 },
      },
    ]) {
      expect(() =>
        buildLighterOrderApprovalDisclosure(
          intentRow(),
          previewRow({ previewJson }),
        )).toThrowError(expect.objectContaining({
          code: ErrorCodes.LIGHTER_INVALID_REQUEST,
        }));
    }
  });
});
