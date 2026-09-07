import { describe, expect, it } from "vitest";

import type { LighterOcoExecutionIntentRow } from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
import {
  buildLighterOcoApprovalDisclosure,
  lighterOcoCriticalArgs,
} from "@vex-agent/tools/protocols/lighter/oco-approval.js";

const EXPIRY = Date.parse("2030-01-01T00:00:00.000Z");
const intent = {
  intentId: "lighter-oco-1", sessionId: "session-1", matchHash: "a".repeat(64),
  environment: "rhc", accountIndex: 42, apiKeyIndex: 7, marketIndex: 0, side: "sell",
  baseAmountInteger: "10000", stopLossPreviewId: "sl", stopLossMatchHash: "b".repeat(64),
  stopLossPriceInteger: "285000", stopLossTriggerPriceInteger: "290000",
  takeProfitPreviewId: "tp", takeProfitMatchHash: "c".repeat(64),
  takeProfitPriceInteger: "325000", takeProfitTriggerPriceInteger: "330000",
  orderExpiryMs: EXPIRY,
} as LighterOcoExecutionIntentRow;

function leg(kind: "stop-loss" | "take-profit"): LighterOrderPreviewRow {
  const stop = kind === "stop-loss";
  return {
    previewId: stop ? "sl" : "tp", sessionId: "session-1",
    matchHash: stop ? "b".repeat(64) : "c".repeat(64), environment: "rhc",
    accountIndex: 42, apiKeyIndex: 7, marketIndex: 0, side: "sell",
    baseAmountInteger: "10000", priceInteger: stop ? "285000" : "325000",
    orderType: kind, timeInForce: "immediate-or-cancel", reduceOnly: true,
    triggerPriceInteger: stop ? "290000" : "330000", orderExpiryMs: EXPIRY,
    clientOrderIndexPolicy: "vex_assigned_uint48", providerVersion: "lighter-order-preview-v1",
    previewJson: {
      symbol: "ETH", marketType: "perp",
      baseAmount: { display: "1", integer: "10000", decimals: 4 },
      price: { display: stop ? "2850" : "3250", integer: stop ? "285000" : "325000", decimals: 2 },
    },
    liveSourceJson: {}, createdAt: "2029-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z",
  };
}

describe("Lighter OCO approval binding material", () => {
  it("discloses both exact triggers and hard execution bounds in one approval", () => {
    const disclosure = buildLighterOcoApprovalDisclosure(intent, leg("stop-loss"), leg("take-profit"));
    expect(disclosure).toMatchObject({
      marketSymbol: "ETH", baseAmountDisplay: "1", stopLossTriggerDisplay: "2900",
      stopLossBoundDisplay: "2850", takeProfitTriggerDisplay: "3300", takeProfitBoundDisplay: "3250",
    });
    const critical = lighterOcoCriticalArgs(intent, disclosure);
    expect(critical).toMatchObject({ groupingType: "one-cancels-the-other", reduceOnly: true });
  });

  it("refuses a child preview whose bound no longer matches the durable group", () => {
    expect(() => buildLighterOcoApprovalDisclosure(
      intent,
      { ...leg("stop-loss"), priceInteger: "284999" },
      leg("take-profit"),
    )).toThrow(/stop-loss preview no longer matches/);
  });
});
