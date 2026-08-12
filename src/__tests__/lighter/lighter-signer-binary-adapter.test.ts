import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createLighterSignerBinaryAdapter,
  resolveDefaultLighterSignerBinaryPath,
  type LighterSignerBinaryRunRequest,
} from "@tools/lighter/signer-binary-adapter.js";
import {
  buildLighterCreateOrderSigningInput,
  signLighterCreateOrderWithAdapter,
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
    side: "sell",
    baseAmountInteger: "281474976710655",
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

function signingInput() {
  return buildLighterCreateOrderSigningInput({
    order: buildLighterUnsignedCreateOrderRequest(plan()),
    secret: materialFromSecret(PRIVATE_KEY),
    nonce: "1784732515923",
  });
}

describe("Lighter signer binary adapter", () => {
  it("maps signer input into the helper stdin payload with exact decimal strings", async () => {
    const calls: LighterSignerBinaryRunRequest[] = [];
    const input = signingInput();
    const adapter = createLighterSignerBinaryAdapter({
      binaryPath: "/tmp/vex-lighter-signer-test",
      runner: async (request) => {
        calls.push(request);
        return {
          ok: true,
          txType: 14,
          txInfo: "{\"Tx\":\"signed\"}",
          txHash: "0xabc123",
        };
      },
    });

    const result = await signLighterCreateOrderWithAdapter(input, adapter);

    expect(result).toMatchObject({
      txType: 14,
      txInfo: "{\"Tx\":\"signed\"}",
      txHash: "0xabc123",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.binaryPath).toBe("/tmp/vex-lighter-signer-test");
    expect(calls[0]?.payload).toMatchObject({
      operation: "signCreateOrder",
      privateKey: PRIVATE_KEY,
      chainId: 466324,
      accountIndex: "42",
      apiKeyIndex: 7,
      nonce: "1784732515923",
      order: {
        marketIndex: 0,
        clientOrderIndex: input.order.clientOrderIndex,
        baseAmount: "281474976710655",
        price: "300000",
        isAsk: 1,
        orderType: 0,
        timeInForce: 1,
        reduceOnly: 0,
        triggerPrice: "0",
        orderExpiry: "1893456000000",
      },
    });
  });

  it("returns structural helper failures without echoing helper error text", async () => {
    const adapter = createLighterSignerBinaryAdapter({
      binaryPath: "/tmp/vex-lighter-signer-test",
      runner: async () => ({
        ok: false,
        errorCode: "signing_failed",
        error: `bad private key ${"1".repeat(80)} tx_info Sig`,
      }),
    });

    await expect(signLighterCreateOrderWithAdapter(signingInput(), adapter))
      .rejects.toMatchObject({
        message: "Lighter signer helper failed (signing_failed).",
      });
  });

  it("resolves packaged and local signer helper paths", () => {
    expect(resolveDefaultLighterSignerBinaryPath({
      resourcesPath: "/Applications/Vex.app/Contents/Resources",
      platform: "darwin",
      arch: "arm64",
    })).toBe("/Applications/Vex.app/Contents/Resources/lighter-signer/vex-lighter-signer-darwin-arm64");

    expect(resolveDefaultLighterSignerBinaryPath({
      cwd: "/repo",
      platform: "win32",
      arch: "x64",
    })).toBe(join("/repo", "vex-app", "resources", "lighter-signer", "vex-lighter-signer-win32-x64.exe"));
  });

  it("keeps the helper process argument list empty so secrets travel only over stdin", () => {
    const source = readFileSync(
      join(process.cwd(), "src/tools/lighter/signer-binary-adapter.ts"),
      "utf-8",
    );
    expect(source).toContain("spawn(request.binaryPath, []");
  });
});
