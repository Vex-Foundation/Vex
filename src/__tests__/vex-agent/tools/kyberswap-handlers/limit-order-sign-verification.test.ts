/**
 * FIX 2 (wiring) — the create-order handler must cross-check the returned
 * EIP-712 sign-message against the requested order BEFORE signing. A tampered
 * verifyingContract (or any economic field) must fail closed with NO call to
 * signEip712Message.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { DSLO_PROTOCOL } from "@tools/kyberswap/constants.js";

const LEGACY_PROTOCOL = "0x227B0c196eA8db17A665EA6824D972A64202E936";

const h = vi.hoisted(() => ({
  getSignMessage: vi.fn(),
  createOrder: vi.fn().mockResolvedValue({ orderId: 7 }),
  signEip712Message: vi.fn().mockResolvedValue("0xsignature"),
  // DSLO_PROTOCOL literal — vi.hoisted runs before module imports resolve.
  verifyingContract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" as string,
}));

const SESSION_EVM = {
  family: "eip155" as const,
  address: "0x1111111111111111111111111111111111111111",
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet: () => SESSION_EVM,
  resolveSelectedAddress: () => SESSION_EVM.address,
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

vi.mock("@tools/kyberswap/helpers.js", () => ({
  requireFeature: vi.fn(),
  resolveChainWithId: () => ({ slug: "ethereum", chainId: 1 }),
  resolveTokenMetadataStrict: vi.fn(async (address: string) => ({
    address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
  })),
}));

vi.mock("@tools/kyberswap/limit-order/client.js", () => ({
  getKyberLimitOrderClient: () => ({
    getSignMessage: (...a: unknown[]) => h.getSignMessage(...a),
    createOrder: (...a: unknown[]) => h.createOrder(...a),
  }),
}));

vi.mock("@tools/kyberswap/limit-order/signing.js", () => ({
  signEip712Message: (...a: unknown[]) => h.signEip712Message(...a),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { limitOrderCreate } from "@vex-agent/tools/protocols/kyberswap/handlers/limit-order/create.js";

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
  };
}

const PARAMS = {
  chain: "ethereum",
  makerAsset: "0x2222222222222222222222222222222222222222",
  takerAsset: "0x3333333333333333333333333333333333333333",
  makingAmount: "1",
  takingAmount: "2000",
  expires: "1h",
};

describe("FIX 2 — limitOrder.create sign-message verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.signEip712Message.mockResolvedValue("0xsignature");
    h.createOrder.mockResolvedValue({ orderId: 7 });
    // The API echoes the requested order back into the message using the REAL
    // DSLO Order shape: receiver defaults to maker, and expiry is ABI-encoded
    // inside `predicate` (timestampBelow selector 0x63592c2b + 32-byte word),
    // NOT a top-level field. The domain's verifyingContract is per-test.
    h.getSignMessage.mockImplementation(async (body: Record<string, unknown>) => {
      const expiredAt = body.expiredAt as number;
      const expiryWord = expiredAt.toString(16).padStart(64, "0");
      const predicate = "0xda061db0" + "0".repeat(48) + "63592c2b" + expiryWord;
      return {
        domain: {
          name: "Kyber DSLO Protocol",
          version: "1",
          chainId: Number(body.chainId),
          verifyingContract: h.verifyingContract,
        },
        types: { Order: [{ name: "maker", type: "address" }] },
        primaryType: "Order",
        message: {
          salt: "12345",
          maker: body.maker,
          makerAsset: body.makerAsset,
          takerAsset: body.takerAsset,
          receiver: body.maker,
          makingAmount: body.makingAmount,
          takingAmount: body.takingAmount,
          predicate,
        },
      };
    });
  });

  it("signs and creates the order when the message matches (happy path)", async () => {
    h.verifyingContract = DSLO_PROTOCOL;

    const result = await limitOrderCreate(PARAMS, ctx());

    expect(result.success).toBe(true);
    expect(h.signEip712Message).toHaveBeenCalledTimes(1);
    expect(h.createOrder).toHaveBeenCalledTimes(1);
  });

  it("fails closed WITHOUT signing when verifyingContract is the legacy protocol", async () => {
    h.verifyingContract = LEGACY_PROTOCOL;

    await expect(limitOrderCreate(PARAMS, ctx())).rejects.toThrow(/verifyingContract/);

    expect(h.signEip712Message).not.toHaveBeenCalled();
    expect(h.createOrder).not.toHaveBeenCalled();
  });
});
