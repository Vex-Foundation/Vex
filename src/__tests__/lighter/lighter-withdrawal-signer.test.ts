import { describe, expect, it, vi } from "vitest";

import { createLighterCoreWithdrawalSignerBinary } from "@tools/lighter/signer-binary-adapter.js";
import {
  buildLighterCoreWithdrawalSigningInput,
  signLighterCoreWithdrawalWithAdapter,
  type LighterCoreWithdrawalSignerAdapter,
} from "@tools/lighter/signer-withdrawal.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";

const NOW = 1_893_456_000_000;
const PRIVATE_KEY = `0x${"1".repeat(80)}`;

function input() {
  return buildLighterCoreWithdrawalSigningInput({
    accountIndex: 737_810,
    apiKeyIndex: 4,
    nonce: "9",
    expiredAt: String(NOW + 120_000),
    amountUnits: "2000000",
    matchHash: "a".repeat(64),
    secret: materialFromSecret(PRIVATE_KEY),
    nowMs: NOW,
  });
}

describe("Lighter Core withdrawal signer boundary", () => {
  it("builds only the reviewed Core USDC secure withdrawal identity", () => {
    expect(input()).toMatchObject({
      kind: "lighter_core_withdrawal_signing_input",
      environment: "core",
      restBaseUrl: "https://mainnet.zklighter.elliot.ai",
      chainId: 304,
      accountIndex: 737_810,
      apiKeyIndex: 4,
      nonce: "9",
      expiredAt: String(NOW + 120_000),
      assetIndex: 3,
      routeType: 0,
      amountUnits: "2000000",
      matchHash: "a".repeat(64),
    });
  });

  it("maps the secret to helper stdin and keeps signed txInfo non-enumerable", async () => {
    const calls: unknown[] = [];
    const signingInput = input();
    const adapter = createLighterCoreWithdrawalSignerBinary({
      binaryPath: "/tmp/vex-lighter-signer-test",
      runner: async (request) => {
        calls.push(request);
        return {
          ok: true,
          txType: 13,
          txInfo: "{\"Sig\":\"opaque\"}",
          txHash: "lighter-hash-13",
        };
      },
    });

    const result = await signLighterCoreWithdrawalWithAdapter(signingInput, adapter);
    expect(calls).toEqual([{
      binaryPath: "/tmp/vex-lighter-signer-test",
      timeoutMs: 10_000,
      payload: {
        operation: "signWithdraw",
        privateKey: PRIVATE_KEY,
        chainId: 304,
        accountIndex: "737810",
        apiKeyIndex: 4,
        nonce: "9",
        expiredAt: String(NOW + 120_000),
        withdrawal: { assetIndex: 3, routeType: 0, amount: "2000000" },
      },
    }]);
    expect(result.txInfo).toBe("{\"Sig\":\"opaque\"}");
    expect(Object.keys(result)).not.toContain("txInfo");
    expect(JSON.stringify(result)).not.toContain("Sig");
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
  });

  it("rejects mismatched or enumerable signed results", async () => {
    const signingInput = input();
    const mismatched: LighterCoreWithdrawalSignerAdapter = {
      source: "official_lighter_signer",
      signWithdraw: vi.fn(async () => ({
        kind: "lighter_core_withdrawal_signer_result",
        environment: "core",
        accountIndex: signingInput.accountIndex,
        apiKeyIndex: signingInput.apiKeyIndex,
        nonce: "10",
        expiredAt: signingInput.expiredAt,
        assetIndex: 3,
        routeType: 0,
        amountUnits: signingInput.amountUnits,
        matchHash: signingInput.matchHash,
        txType: 13,
        txInfo: "opaque",
        txHash: "hash",
      })),
    };
    await expect(signLighterCoreWithdrawalWithAdapter(signingInput, mismatched))
      .rejects.toThrow("does not match");

    const enumerable: LighterCoreWithdrawalSignerAdapter = {
      source: "official_lighter_signer",
      signWithdraw: vi.fn(async () => ({
        kind: "lighter_core_withdrawal_signer_result",
        environment: "core",
        accountIndex: signingInput.accountIndex,
        apiKeyIndex: signingInput.apiKeyIndex,
        nonce: signingInput.nonce,
        expiredAt: signingInput.expiredAt,
        assetIndex: 3,
        routeType: 0,
        amountUnits: signingInput.amountUnits,
        matchHash: signingInput.matchHash,
        txType: 13,
        txInfo: "opaque",
        txHash: "hash",
      })),
    };
    await expect(signLighterCoreWithdrawalWithAdapter(signingInput, enumerable))
      .rejects.toThrow("enumerable");
  });

  it("rejects unsafe nonce, amount, hash, key slot, and expiry inputs", () => {
    const base = {
      accountIndex: 737_810,
      apiKeyIndex: 4,
      nonce: "9",
      expiredAt: String(NOW + 120_000),
      amountUnits: "2000000",
      matchHash: "a".repeat(64),
      secret: materialFromSecret(PRIVATE_KEY),
      nowMs: NOW,
    };
    expect(() => buildLighterCoreWithdrawalSigningInput({ ...base, apiKeyIndex: 3 })).toThrow("apiKeyIndex");
    expect(() => buildLighterCoreWithdrawalSigningInput({ ...base, nonce: String(2n ** 48n) })).toThrow("nonce");
    expect(() => buildLighterCoreWithdrawalSigningInput({ ...base, amountUnits: "0" })).toThrow("amountUnits");
    expect(() => buildLighterCoreWithdrawalSigningInput({ ...base, matchHash: "A".repeat(64) })).toThrow("matchHash");
    expect(() => buildLighterCoreWithdrawalSigningInput({ ...base, expiredAt: String(NOW + 10_000) })).toThrow("expiry");
    expect(() => buildLighterCoreWithdrawalSigningInput({ ...base, expiredAt: String(NOW + 600_000) })).toThrow("expiry");
  });
});
