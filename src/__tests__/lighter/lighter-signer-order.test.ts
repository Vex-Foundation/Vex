import { describe, expect, it } from "vitest";

import {
  buildLighterUnsignedCreateOrderRequest,
  deriveVexAssignedClientOrderIndex,
} from "@tools/lighter/signer-order.js";
import type { LighterOrderReadyForSignerPlan } from "@vex-agent/tools/protocols/lighter/execution-plan.js";

function plan(overrides: Partial<LighterOrderReadyForSignerPlan> = {}): LighterOrderReadyForSignerPlan {
  return {
    intentId: "lighter-exec-1",
    previewId: "lighter-preview-1",
    matchHash: `${"a".repeat(12)}${"b".repeat(52)}`,
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    marketIndex: 0,
    side: "buy",
    baseAmountInteger: "10000",
    priceInteger: "300000",
    orderType: "limit",
    timeInForce: "good-till-time",
    reduceOnly: false,
    triggerPriceInteger: null,
    orderExpiryMs: 1893456000000,
    clientOrderIndexPolicy: "vex_assigned_uint48",
    providerVersion: "lighter-preview-v1",
    credentialReference: {
      kind: "encrypted_vault_reference",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/rhc/account-42/api-key-7",
    },
    nonceScope: {
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
    },
    ...overrides,
  };
}

describe("Lighter unsigned signer order request", () => {
  it("maps an approved plan into unsigned create-order fields without signing", () => {
    const request = buildLighterUnsignedCreateOrderRequest(plan());

    expect(request).toEqual({
      kind: "lighter_unsigned_create_order",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      clientOrderIndex: String(BigInt("0xaaaaaaaaaaaa")),
      baseAmountInteger: "10000",
      priceInteger: "300000",
      isAsk: false,
      orderTypeCode: 0,
      timeInForceCode: 1,
      reduceOnly: false,
      triggerPriceInteger: "0",
      orderExpiryMs: 1893456000000,
      matchHash: `${"a".repeat(12)}${"b".repeat(52)}`,
    });
  });

  it("maps sell market IOC orders to Lighter signer enum values", () => {
    const request = buildLighterUnsignedCreateOrderRequest(plan({
      side: "sell",
      orderType: "market",
      timeInForce: "immediate-or-cancel",
      reduceOnly: true,
    }));

    expect(request.isAsk).toBe(true);
    expect(request.orderTypeCode).toBe(1);
    expect(request.timeInForceCode).toBe(0);
    expect(request.reduceOnly).toBe(true);
  });

  it("derives a nonzero uint48 client order index from the match hash", () => {
    expect(deriveVexAssignedClientOrderIndex(`${"0".repeat(12)}${"1".repeat(52)}`)).toBe("1");
    expect(deriveVexAssignedClientOrderIndex(`${"f".repeat(12)}${"1".repeat(52)}`))
      .toBe(String((1n << 48n) - 1n));
    expect(() => deriveVexAssignedClientOrderIndex("not-a-hash")).toThrow("matchHash");
  });

  it("refuses unsupported trigger-price or client-order-index policies", () => {
    expect(() => buildLighterUnsignedCreateOrderRequest(plan({ triggerPriceInteger: "123" })))
      .toThrow("Trigger-price");
    expect(() => buildLighterUnsignedCreateOrderRequest(plan({ clientOrderIndexPolicy: "caller_supplied" })))
      .toThrow("Unsupported Lighter client-order-index policy");
  });
});
