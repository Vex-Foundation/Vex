import { describe, expect, it, vi } from "vitest";

import {
  assertUnsignedCreateOrderFitsOfficialSigner,
  buildLighterAccountAuthSigningInput,
  buildLighterCreateOrderSigningInput,
  createLighterAccountAuthWithAdapter,
  signLighterCreateOrderWithAdapter,
  type LighterSignerAdapter,
} from "@tools/lighter/signer-adapter.js";
import { buildLighterUnsignedCreateOrderRequest } from "@tools/lighter/signer-order.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";
import type { LighterOrderReadyForSignerPlan } from "@vex-agent/tools/protocols/lighter/execution-plan.js";

const PRIVATE_KEY = `0x${"1".repeat(80)}`;

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

function signingInput(overrides: Partial<LighterOrderReadyForSignerPlan> = {}) {
  return buildLighterCreateOrderSigningInput({
    order: buildLighterUnsignedCreateOrderRequest(plan(overrides)),
    secret: materialFromSecret(PRIVATE_KEY),
    nonce: "123",
  });
}

describe("Lighter official signer adapter boundary", () => {
  it("enforces the immediate-or-cancel nil-expiry invariant before signing", () => {
    const iocOrder = buildLighterUnsignedCreateOrderRequest(plan({
      orderType: "market",
      timeInForce: "immediate-or-cancel",
    }));
    expect(iocOrder.orderExpiryMs).toBe(0);
    expect(() => assertUnsignedCreateOrderFitsOfficialSigner(iocOrder)).not.toThrow();

    const gttOrder = buildLighterUnsignedCreateOrderRequest(plan());
    expect(() => assertUnsignedCreateOrderFitsOfficialSigner(gttOrder)).not.toThrow();

    // IOC must not carry a positive expiry...
    expect(() => assertUnsignedCreateOrderFitsOfficialSigner({
      ...iocOrder,
      orderExpiryMs: 1893456000000,
    })).toThrow("zero (nil) order expiry");
    // ...and good-till-time must not carry a zero expiry.
    expect(() => assertUnsignedCreateOrderFitsOfficialSigner({
      ...gttOrder,
      orderExpiryMs: 0,
    })).toThrow("positive order expiry");

    const protectiveOrder = buildLighterUnsignedCreateOrderRequest(plan({
      side: "sell",
      orderType: "stop-loss",
      timeInForce: "immediate-or-cancel",
      reduceOnly: true,
      triggerPriceInteger: "290000",
    }));
    expect(protectiveOrder.orderExpiryMs).toBe(1893456000000);
    expect(() => assertUnsignedCreateOrderFitsOfficialSigner(protectiveOrder)).not.toThrow();
    expect(() => assertUnsignedCreateOrderFitsOfficialSigner({
      ...protectiveOrder,
      triggerPriceInteger: "0",
    })).toThrow("positive trigger price");
  });

  it("creates bounded canonical account auth for the exact credential scope", async () => {
    const order = buildLighterUnsignedCreateOrderRequest(plan());
    const input = buildLighterAccountAuthSigningInput({
      order,
      secret: materialFromSecret(PRIVATE_KEY),
      deadlineUnixSeconds: 1_893_456_600,
    });
    const adapter: LighterSignerAdapter = {
      source: "official_lighter_signer",
      createAccountAuth: vi.fn<LighterSignerAdapter["createAccountAuth"]>(async () => ({
        kind: "lighter_account_auth_signer_result",
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        deadlineUnixSeconds: 1_893_456_600,
        authToken: `1893456600:42:7:${"a".repeat(128)}`,
        publicKey: "b".repeat(80),
      })),
      signCreateOrder: vi.fn(async () => { throw new Error("not used"); }),
    };

    await expect(createLighterAccountAuthWithAdapter(input, adapter)).resolves.toMatchObject({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      publicKey: "b".repeat(80),
    });
  });

  it("rejects canonical auth returned for another credential scope", async () => {
    const input = buildLighterAccountAuthSigningInput({
      order: buildLighterUnsignedCreateOrderRequest(plan()),
      secret: materialFromSecret(PRIVATE_KEY),
      deadlineUnixSeconds: 1_893_456_600,
    });
    const adapter: LighterSignerAdapter = {
      source: "official_lighter_signer",
      createAccountAuth: vi.fn<LighterSignerAdapter["createAccountAuth"]>(async () => ({
        kind: "lighter_account_auth_signer_result",
        environment: "rhc",
        accountIndex: 43,
        apiKeyIndex: 7,
        deadlineUnixSeconds: 1_893_456_600,
        authToken: `1893456600:43:7:${"a".repeat(128)}`,
        publicKey: "b".repeat(80),
      })),
      signCreateOrder: vi.fn(async () => { throw new Error("not used"); }),
    };

    await expect(createLighterAccountAuthWithAdapter(input, adapter))
      .rejects.toThrow("does not match");
  });

  it("builds an official signer input with chain id, base URL, nonce, and unsigned order", () => {
    const input = signingInput();

    expect(input).toMatchObject({
      kind: "lighter_create_order_signing_input",
      environment: "rhc",
      restBaseUrl: "https://api.rh.lighter.xyz",
      chainId: 466324,
      accountIndex: 42,
      apiKeyIndex: 7,
      nonce: "123",
      order: {
        kind: "lighter_unsigned_create_order",
        clientOrderIndex: String(BigInt("0xaaaaaaaaaaaa")),
      },
      secret: {
        kind: "lighter_api_private_key_secret",
      },
    });
  });

  it("uses the Core chain id when the prepared order targets Core", () => {
    const input = signingInput({ environment: "core" });

    expect(input.restBaseUrl).toBe("https://mainnet.zklighter.elliot.ai");
    expect(input.chainId).toBe(304);
  });

  it("refuses signer values outside the official create-order ranges", () => {
    expect(() => buildLighterCreateOrderSigningInput({
      order: buildLighterUnsignedCreateOrderRequest(plan()),
      secret: materialFromSecret(PRIVATE_KEY),
      nonce: "0",
    })).not.toThrow();
    expect(() => buildLighterCreateOrderSigningInput({
      order: buildLighterUnsignedCreateOrderRequest(plan()),
      secret: materialFromSecret(PRIVATE_KEY),
      nonce: String(2n ** 48n),
    })).toThrow("nonce");

    expect(() => signingInput({ priceInteger: String(2n ** 32n) }))
      .toThrow("priceInteger");
    expect(() => signingInput({ baseAmountInteger: String(2n ** 48n) }))
      .toThrow("baseAmountInteger");
    expect(() => signingInput({
      matchHash: `${"f".repeat(12)}${"b".repeat(52)}`,
    })).not.toThrow();
  });

  it("returns only a signer result that still matches the prepared order identity", async () => {
    const input = signingInput();
    const adapter: LighterSignerAdapter = {
      source: "official_lighter_signer",
      createAccountAuth: vi.fn(async () => { throw new Error("not used"); }),
      signCreateOrder: vi.fn<LighterSignerAdapter["signCreateOrder"]>(async () => ({
        kind: "lighter_create_order_signer_result",
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        nonce: "123",
        clientOrderIndex: input.order.clientOrderIndex,
        matchHash: input.order.matchHash,
        txType: 14,
        txInfo: "{\"opaque\":\"provider body\"}",
        txHash: "0xabc123",
      })),
    };

    await expect(signLighterCreateOrderWithAdapter(input, adapter))
      .resolves.toMatchObject({
        kind: "lighter_create_order_signer_result",
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        nonce: "123",
        clientOrderIndex: input.order.clientOrderIndex,
        txType: 14,
      });
    expect(adapter.signCreateOrder).toHaveBeenCalledWith(input);
  });

  it("rejects signer results that do not match the prepared order", async () => {
    const input = signingInput();
    const adapter: LighterSignerAdapter = {
      source: "official_lighter_signer",
      createAccountAuth: vi.fn(async () => { throw new Error("not used"); }),
      signCreateOrder: async () => ({
        kind: "lighter_create_order_signer_result",
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        nonce: "124",
        clientOrderIndex: input.order.clientOrderIndex,
        matchHash: input.order.matchHash,
        txType: 14,
        txInfo: "{\"opaque\":\"provider body\"}",
        txHash: "0xabc123",
      }),
    };

    await expect(signLighterCreateOrderWithAdapter(input, adapter))
      .rejects.toThrow("does not match");
  });
});
