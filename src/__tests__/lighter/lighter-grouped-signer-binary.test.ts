import { describe, expect, it } from "vitest";

import { buildLighterUnsignedOcoRequest } from "@tools/lighter/oco-order.js";
import {
  createLighterGroupedOrderSignerBinaryAdapter,
  type LighterSignerBinaryRunRequest,
} from "@tools/lighter/signer-binary-adapter.js";
import {
  buildLighterCreateGroupedOrdersSigningInput,
  signLighterCreateGroupedOrdersWithAdapter,
} from "@tools/lighter/signer-grouped-orders.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";

describe("Lighter grouped signer binary adapter", () => {
  it("sends one native grouping type 2 request without process arguments", async () => {
    const calls: LighterSignerBinaryRunRequest[] = [];
    const group = buildLighterUnsignedOcoRequest({
      matchHash: "a".repeat(64), environment: "core", accountIndex: 42, apiKeyIndex: 7,
      marketIndex: 0, side: "sell", baseAmountInteger: "10000", orderExpiryMs: 1_893_456_000_000,
      stopLoss: { matchHash: "b".repeat(64), priceInteger: "280000", triggerPriceInteger: "285000" },
      takeProfit: { matchHash: "c".repeat(64), priceInteger: "325000", triggerPriceInteger: "330000" },
    });
    const input = buildLighterCreateGroupedOrdersSigningInput({
      group, secret: materialFromSecret(`0x${"1".repeat(80)}`), nonce: "11",
      restBaseUrl: "https://mainnet.zklighter.elliot.ai",
    });
    const adapter = createLighterGroupedOrderSignerBinaryAdapter({
      binaryPath: "/tmp/vex-lighter-signer-test",
      runner: async (request) => {
        calls.push(request);
        return { ok: true, txType: 28, txInfo: "{\"GroupingType\":2}", txHash: "0xabc" };
      },
    });
    await signLighterCreateGroupedOrdersWithAdapter(input, adapter);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({
      operation: "signCreateGroupedOrders",
      nonce: "11",
      groupedOrders: { groupingType: 2 },
    });
    expect(JSON.stringify(calls[0]?.payload)).toContain(`0x${"1".repeat(80)}`);
    expect(calls[0]?.binaryPath).toBe("/tmp/vex-lighter-signer-test");
  });
});
