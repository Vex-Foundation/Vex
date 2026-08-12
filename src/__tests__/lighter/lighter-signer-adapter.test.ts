import { describe, expect, it, vi } from "vitest";

import {
  buildLighterCreateOrderSigningInput,
  signLighterCreateOrderWithAdapter,
  type LighterSignerAdapter,
} from "@tools/lighter/signer-adapter.js";
import { buildLighterUnsignedCreateOrderRequest } from "@tools/lighter/signer-order.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";
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

function signingInput(overrides: Partial<LighterOrderReadyForSignerPlan> = {}) {
  return buildLighterCreateOrderSigningInput({
    order: buildLighterUnsignedCreateOrderRequest(plan(overrides)),
    secret: materialFromSecret("lighter-private-key-material-1234567890"),
    nonce: "123",
  });
}

describe("Lighter official signer adapter boundary", () => {
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
      secret: materialFromSecret("lighter-private-key-material-1234567890"),
      nonce: "0",
    })).toThrow("nonce");

    expect(() => signingInput({ priceInteger: String(2n ** 32n) }))
      .toThrow("priceInteger");
    expect(() => signingInput({ baseAmountInteger: String(2n ** 63n) }))
      .toThrow("baseAmountInteger");
    expect(() => signingInput({
      matchHash: `${"f".repeat(12)}${"b".repeat(52)}`,
    })).not.toThrow();
  });

  it("returns only a signer result that still matches the prepared order identity", async () => {
    const input = signingInput();
    const adapter: LighterSignerAdapter = {
      source: "official_lighter_signer",
      signCreateOrder: vi.fn(async () => ({
        kind: "lighter_create_order_signer_result",
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        nonce: "123",
        clientOrderIndex: input.order.clientOrderIndex,
        matchHash: input.order.matchHash,
        txType: 14,
        txInfo: "{\"opaque\":\"provider body\"}",
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
      }),
    };

    await expect(signLighterCreateOrderWithAdapter(input, adapter))
      .rejects.toThrow("does not match");
  });
});
