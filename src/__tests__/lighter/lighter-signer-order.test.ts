import { describe, expect, it } from "vitest";

import {
  buildLighterUnsignedCreateOrderRequest,
  deriveVexAssignedClientOrderIndex,
} from "@tools/lighter/signer-order.js";
import type { LighterOrderReadyForSignerPlan } from "@vex-agent/tools/protocols/lighter/execution-plan.js";

function plan(overrides: Partial<LighterOrderReadyForSignerPlan> = {}): LighterOrderReadyForSignerPlan {
  return {
    intentId: "lighter-exec-1",
    sessionId: "session-1",
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
    // Immediate-or-cancel orders must carry Lighter's nil expiry (0), even though
    // the plan/preview kept a positive timestamp. A positive expiry here fails the
    // official signer with ErrOrderExpiryInvalid.
    expect(request.orderExpiryMs).toBe(0);
  });

  it("maps all supported plain-limit time-in-force values and expiry semantics", () => {
    const iocLimit = buildLighterUnsignedCreateOrderRequest(plan({
      orderType: "limit",
      timeInForce: "immediate-or-cancel",
      orderExpiryMs: 1893456000000,
    }));
    expect(iocLimit.timeInForceCode).toBe(0);
    expect(iocLimit.orderExpiryMs).toBe(0);

    const gttLimit = buildLighterUnsignedCreateOrderRequest(plan({
      orderType: "limit",
      timeInForce: "good-till-time",
      orderExpiryMs: 1893456000000,
    }));
    expect(gttLimit.timeInForceCode).toBe(1);
    expect(gttLimit.orderExpiryMs).toBe(1893456000000);

    const postOnlyLimit = buildLighterUnsignedCreateOrderRequest(plan({
      orderType: "limit",
      timeInForce: "post-only",
      orderExpiryMs: 1893456000000,
    }));
    expect(postOnlyLimit.timeInForceCode).toBe(2);
    expect(postOnlyLimit.orderExpiryMs).toBe(1893456000000);
  });

  it("maps an approved protective order with a non-nil trigger expiry", () => {
    const request = buildLighterUnsignedCreateOrderRequest(plan({
      side: "sell",
      orderType: "stop-loss",
      timeInForce: "immediate-or-cancel",
      reduceOnly: true,
      triggerPriceInteger: "290000",
      orderExpiryMs: 1893456000000,
    }));

    expect(request.orderTypeCode).toBe(2);
    expect(request.triggerPriceInteger).toBe("290000");
    expect(request.orderExpiryMs).toBe(1893456000000);

    const takeProfit = buildLighterUnsignedCreateOrderRequest(plan({
      side: "sell",
      orderType: "take-profit",
      timeInForce: "immediate-or-cancel",
      reduceOnly: true,
      triggerPriceInteger: "320000",
      orderExpiryMs: 1893456000000,
    }));
    expect(takeProfit.orderTypeCode).toBe(4);
    expect(takeProfit.triggerPriceInteger).toBe("320000");
  });

  it.each([
    ["stop-loss-limit", "immediate-or-cancel", 3, "290000", 0],
    ["stop-loss-limit", "good-till-time", 3, "290000", 1],
    ["stop-loss-limit", "post-only", 3, "290000", 2],
    ["take-profit-limit", "immediate-or-cancel", 5, "320000", 0],
    ["take-profit-limit", "good-till-time", 5, "320000", 1],
    ["take-profit-limit", "post-only", 5, "320000", 2],
  ] as const)("maps an approved %s %s to its official signer enum", (
    orderType,
    timeInForce,
    orderTypeCode,
    triggerPriceInteger,
    timeInForceCode,
  ) => {
    const request = buildLighterUnsignedCreateOrderRequest(plan({
      side: "sell",
      orderType,
      timeInForce,
      reduceOnly: true,
      triggerPriceInteger,
    }));

    expect(request.orderTypeCode).toBe(orderTypeCode);
    expect(request.timeInForceCode).toBe(timeInForceCode);
    expect(request.triggerPriceInteger).toBe(triggerPriceInteger);
    expect(request.orderExpiryMs).toBe(1893456000000);
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

  it("refuses unsupported tuples before producing signer input", () => {
    expect(() => buildLighterUnsignedCreateOrderRequest(plan({
      orderType: "stop-loss",
      timeInForce: "post-only",
      reduceOnly: true,
      triggerPriceInteger: "290000",
    }))).toThrow("Unsupported Lighter order type and time-in-force combination");
  });
});
