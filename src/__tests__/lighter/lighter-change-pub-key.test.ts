import { describe, expect, it } from "vitest";

import {
  buildLighterChangePubKeySignatureBody,
  buildLighterChangePubKeySigningInput,
  signLighterChangePubKeyWithAdapter,
} from "@tools/lighter/change-pub-key.js";
import {
  createLighterChangePubKeySignerBinary,
  type LighterSignerBinaryRunRequest,
} from "@tools/lighter/signer-binary-adapter.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";

const PRIVATE_KEY = `0x${"1".repeat(80)}`;
const PUBLIC_KEY = "ab".repeat(40);
const L1_SIGNATURE = `0x${"11".repeat(64)}1b`;
const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";

function signingInput(environment: "core" | "rhc" = "core") {
  return buildLighterChangePubKeySigningInput({
    environment,
    accountIndex: 42,
    apiKeyIndex: 7,
    nonce: "0",
    expiredAt: "1893456000000",
    publicKey: PUBLIC_KEY,
    expectedL1Address: WALLET_ADDRESS,
    l1Signature: L1_SIGNATURE,
    secret: materialFromSecret(PRIVATE_KEY),
  });
}

function helperOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const input = signingInput();
  return {
    ok: true,
    txType: 8,
    txInfo: JSON.stringify({
      AccountIndex: input.accountIndex,
      ApiKeyIndex: input.apiKeyIndex,
      PubKey: Buffer.from(input.publicKey, "hex").toString("base64"),
      L1Sig: input.l1Signature,
      ExpiredAt: Number(input.expiredAt),
      Nonce: Number(input.nonce),
      Sig: Buffer.alloc(80, 1).toString("base64"),
      L2TxAttributes: null,
    }),
    txHash: "cd".repeat(40),
    messageToSign: input.messageToSign,
    ...overrides,
  };
}

describe("Lighter L2ChangePubKey signer boundary", () => {
  it("builds the exact official EIP-191 body with fixed-width lowercase uint64 fields", () => {
    expect(buildLighterChangePubKeySignatureBody({
      publicKey: `0x${PUBLIC_KEY.toUpperCase()}`,
      nonce: "0",
      accountIndex: 42,
      apiKeyIndex: 7,
    })).toBe(
      `Register Lighter Account\n\npubkey: 0x${PUBLIC_KEY}\n`
      + "nonce: 0x0000000000000000\n"
      + "account index: 0x000000000000002a\n"
      + "api key index: 0x0000000000000007\n"
      + "Only sign this message for a trusted client!",
    );
  });

  it("sends secrets only in helper stdin and accepts an exact TxType 8 result", async () => {
    const calls: LighterSignerBinaryRunRequest[] = [];
    const input = signingInput();
    const signer = createLighterChangePubKeySignerBinary({
      binaryPath: "/tmp/vex-lighter-signer-test",
      runner: async (request) => {
        calls.push(request);
        return helperOutput();
      },
    });

    const result = await signLighterChangePubKeyWithAdapter(input, signer);
    expect(result).toMatchObject({
      kind: "lighter_change_pub_key_signer_result",
      environment: "core",
      txType: 8,
      txHash: "cd".repeat(40),
      messageToSign: input.messageToSign,
    });
    expect(result.txInfo).toContain("L1Sig");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toEqual({
      operation: "signChangePubKey",
      privateKey: PRIVATE_KEY,
      chainId: 304,
      accountIndex: "42",
      apiKeyIndex: 7,
      nonce: "0",
      expiredAt: "1893456000000",
      publicKey: PUBLIC_KEY,
      l1Signature: L1_SIGNATURE,
      expectedL1Address: WALLET_ADDRESS,
    });
    expect(JSON.stringify(input)).not.toContain(L1_SIGNATURE);
    expect(JSON.stringify(result)).not.toContain("L1Sig");
  });

  it("uses the RHC signer domain while preserving the exact TxType 8 boundary", async () => {
    const calls: LighterSignerBinaryRunRequest[] = [];
    const input = signingInput("rhc");
    const signer = createLighterChangePubKeySignerBinary({
      runner: async (request) => {
        calls.push(request);
        return helperOutput({ messageToSign: input.messageToSign });
      },
    });

    const result = await signLighterChangePubKeyWithAdapter(input, signer);
    expect(result).toMatchObject({ environment: "rhc", txType: 8 });
    expect(calls[0]?.payload).toMatchObject({ chainId: 466324 });
    expect(calls[0]?.payload).not.toMatchObject({ chainId: 4663 });
  });

  it("rejects helper drift in the message, transaction fields, type, or hash", async () => {
    const input = signingInput();
    const run = async (overrides: Record<string, unknown>) => {
      const signer = createLighterChangePubKeySignerBinary({
        runner: async () => helperOutput(overrides),
      });
      return signLighterChangePubKeyWithAdapter(input, signer);
    };

    await expect(run({ messageToSign: `${input.messageToSign} altered` }))
      .rejects.toThrow("does not match the approved scope");
    await expect(run({ txType: 14 })).rejects.toThrow("signer helper failed");
    await expect(run({ txHash: "0xabc" })).rejects.toThrow("invalid transaction hash");
    await expect(run({
      txInfo: JSON.stringify({
        AccountIndex: 42,
        ApiKeyIndex: 8,
        PubKey: Buffer.from(PUBLIC_KEY, "hex").toString("base64"),
        L1Sig: L1_SIGNATURE,
        ExpiredAt: 1_893_456_000_000,
        Nonce: 0,
        Sig: Buffer.alloc(80, 1).toString("base64"),
        L2TxAttributes: null,
      }),
    })).rejects.toThrow("transaction info does not match");
  });

  it("rejects reserved slots, noncanonical nonces, and unsupported signature recovery", () => {
    const base = {
      accountIndex: 42,
      apiKeyIndex: 7,
      nonce: "0",
      expiredAt: "1893456000000",
      publicKey: PUBLIC_KEY,
      expectedL1Address: WALLET_ADDRESS,
      l1Signature: L1_SIGNATURE,
      secret: materialFromSecret(PRIVATE_KEY),
    };
    expect(() => buildLighterChangePubKeySigningInput({ ...base, apiKeyIndex: 3 }))
      .toThrow("4 through 254");
    expect(() => buildLighterChangePubKeySigningInput({ ...base, nonce: "00" }))
      .toThrow("canonical decimal");
    expect(() => buildLighterChangePubKeySigningInput({
      ...base,
      l1Signature: `0x${"11".repeat(64)}02`,
    })).toThrow("recovery value");
  });
});
