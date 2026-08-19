import { describe, expect, it } from "vitest";

import {
  createLighterOrderLifecycleSignerBinary,
  type LighterSignerBinaryRunRequest,
} from "@tools/lighter/signer-binary-adapter.js";
import {
  buildLighterCancelAllOrdersSigningInput,
  buildLighterCancelOrderSigningInput,
  buildLighterModifyOrderSigningInput,
} from "@tools/lighter/signer-order-lifecycle.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";

const secret = materialFromSecret(`0x${"1".repeat(80)}`);
const scope = {
  environment: "rhc" as const,
  accountIndex: 42,
  apiKeyIndex: 7,
  nonce: "9",
  expiredAt: "1893456000000",
  secret,
};

describe("Lighter order lifecycle signer", () => {
  it("keeps exact provider order identity as decimal text in cancel and modify payloads", async () => {
    const calls: LighterSignerBinaryRunRequest[] = [];
    const signer = createLighterOrderLifecycleSignerBinary({
      binaryPath: "/tmp/vex-lighter-signer-test",
      runner: async (request) => {
        calls.push(request);
        const txType = request.payload.operation === "signCancelOrder" ? 15 : 17;
        return { ok: true, txType, txInfo: "{}", txHash: `hash-${txType}` };
      },
    });
    const providerOrderId = "1152921504606846975";

    await signer.signCancelOrder(buildLighterCancelOrderSigningInput({
      ...scope,
      marketIndex: 0,
      providerOrderId,
    }));
    await signer.signModifyOrder(buildLighterModifyOrderSigningInput({
      ...scope,
      marketIndex: 2048,
      providerOrderId,
      baseAmountInteger: "125000",
      priceInteger: "300000",
    }));

    expect(calls[0]?.payload).toMatchObject({
      operation: "signCancelOrder",
      chainId: 466324,
      accountIndex: "42",
      nonce: "9",
      expiredAt: "1893456000000",
      cancelOrder: { marketIndex: 0, orderIndex: providerOrderId },
    });
    expect(calls[1]?.payload).toMatchObject({
      operation: "signModifyOrder",
      modifyOrder: {
        marketIndex: 2048,
        orderIndex: providerOrderId,
        baseAmount: "125000",
        price: "300000",
        triggerPrice: "0",
      },
    });
    expect(JSON.stringify(await signer.signCancelOrder(buildLighterCancelOrderSigningInput({
      ...scope,
      marketIndex: 0,
      providerOrderId: "1",
    })))).not.toContain(secret.privateKey);
  });

  it("pins cancel-all to immediate account-wide semantics", async () => {
    const calls: LighterSignerBinaryRunRequest[] = [];
    const signer = createLighterOrderLifecycleSignerBinary({
      runner: async (request) => {
        calls.push(request);
        return { ok: true, txType: 16, txInfo: "{}", txHash: "hash-16" };
      },
    });

    await expect(signer.signCancelAllOrders(buildLighterCancelAllOrdersSigningInput(scope)))
      .resolves.toMatchObject({ operation: "cancel_all_orders", txType: 16 });
    expect(calls[0]?.payload).toMatchObject({
      operation: "signCancelAllOrders",
      cancelAllOrders: { timeInForce: 0, time: "0" },
    });
  });

  it("rejects non-canonical, zero, and out-of-range provider identities before signing", () => {
    const base = { ...scope, marketIndex: 0 };
    expect(() => buildLighterCancelOrderSigningInput({
      ...base,
      providerOrderId: "01",
    })).toThrow("canonical decimal text");
    expect(() => buildLighterCancelOrderSigningInput({
      ...base,
      providerOrderId: "0",
    })).toThrow("outside the official signer range");
    expect(() => buildLighterCancelOrderSigningInput({
      ...base,
      providerOrderId: "1152921504606846976",
    })).toThrow("outside the official signer range");
  });

  it("rejects a helper response with the wrong lifecycle transaction type", async () => {
    const signer = createLighterOrderLifecycleSignerBinary({
      runner: async () => ({ ok: true, txType: 14, txInfo: "{}", txHash: "wrong" }),
    });
    await expect(signer.signCancelOrder(buildLighterCancelOrderSigningInput({
      ...scope,
      marketIndex: 0,
      providerOrderId: "123",
    }))).rejects.toThrow("Lighter signer helper failed");
  });
});
