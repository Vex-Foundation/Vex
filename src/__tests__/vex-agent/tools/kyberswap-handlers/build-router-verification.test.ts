/**
 * FIX 1 — the BUILD-response router address must be verified before broadcast.
 *
 * `verifyRouterAddress` was only applied to the GET/route response's
 * routerAddress, which guards the approval step. But the transaction actually
 * broadcast uses the POST/build response's routerAddress, which was never
 * verified — an attacker-controlled build routerAddress is a direct theft
 * vector (approvals + the tx target both flow to that address).
 *
 * These tests pin the fail-closed contract: when the build response's
 * routerAddress differs from the allowlisted constant, the handler MUST refuse
 * BEFORE any send, even though the route response's routerAddress matched.
 *
 * `verifyRouterAddress` is mocked with a behaviour-equivalent lowercase compare
 * (the real function's checksum semantics are covered by
 * `kyberswap-evm-utils.test.ts`); here we assert the WIRING — that each handler
 * calls it with the BUILD router + the correct allowlisted constant, before the
 * send spy.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import {
  META_AGGREGATION_ROUTER_V2,
  KS_ZAP_ROUTER_POSITION,
} from "@tools/kyberswap/constants.js";
import type { ZapDexEntry } from "@tools/kyberswap/zaas/zap-dexes/types.js";

const ATTACKER_ROUTER = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

// ── Hoisted spies (available inside vi.mock factories) ────────────────
const h = vi.hoisted(() => ({
  verifyRouterAddress: vi.fn((actual: string, expected: string) => {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Router address mismatch: ${actual} != ${expected}`);
    }
  }),
  sendKyberTransaction: vi.fn().mockResolvedValue("0xswaphash"),
  sendKyberTransactionWithReceipt: vi.fn().mockResolvedValue({
    hash: "0xzaphash",
    receipt: { logs: [] },
  }),
  ensureKyberAllowance: vi.fn().mockResolvedValue(undefined),
  ensureErc20Balance: vi.fn().mockResolvedValue(undefined),
  getRoute: vi.fn(),
  buildRoute: vi.fn(),
  getZapInRoute: vi.fn(),
  buildZapIn: vi.fn(),
  getHoneypotFotInfo: vi.fn().mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 }),
  resolveChainBenchmark: vi.fn(() => null),
}));

const SESSION_EVM = {
  family: "eip155" as const,
  address: "0x1234567890abcdef1234567890abcdef12345678",
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

vi.mock("@tools/kyberswap/evm-utils.js", () => ({
  getKyberEvmClients: () => ({ publicClient: {}, walletClient: {} }),
  ensureKyberAllowance: (...a: unknown[]) => h.ensureKyberAllowance(...a),
  ensureErc721Approval: vi.fn().mockResolvedValue(null),
  ensureErc1155ApprovalForAll: vi.fn().mockResolvedValue(null),
  sendKyberTransaction: (...a: unknown[]) => h.sendKyberTransaction(...a),
  sendKyberTransactionWithReceipt: (...a: unknown[]) => h.sendKyberTransactionWithReceipt(...a),
  extractMintedNftId: vi.fn(() => undefined),
  extractErc1155Position: vi.fn(() => undefined),
  readErc20Metadata: vi.fn(async (_slug: string, address: string) => ({
    address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
  })),
  verifyRouterAddress: (...a: [string, string]) => h.verifyRouterAddress(...a),
}));

vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: (...a: unknown[]) => h.ensureErc20Balance(...a),
}));

vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    searchTokens: vi.fn().mockResolvedValue([]),
    getHoneypotFotInfo: (...a: [number, string]) => h.getHoneypotFotInfo(...a),
  }),
}));

vi.mock("@tools/kyberswap/aggregator/client.js", () => ({
  getKyberAggregatorClient: () => ({
    getRoute: (...a: unknown[]) => h.getRoute(...a),
    buildRoute: (...a: unknown[]) => h.buildRoute(...a),
  }),
}));

vi.mock("@tools/kyberswap/zaas/client.js", () => ({
  getKyberZaasClient: () => ({
    getZapInRoute: (...a: unknown[]) => h.getZapInRoute(...a),
    buildZapIn: (...a: unknown[]) => h.buildZapIn(...a),
  }),
}));

// Controlled DEX catalog so zap.in reaches the build+send path hermetically.
const NATIVE_ZAP_DEX: ZapDexEntry = {
  id: "DEX_UNISWAPV3",
  name: "Uniswap V3",
  supports: ["zap-in"],
  verification: "verified",
  positionRefKind: "tokenId",
  approvalStandard: "erc20",
  approvalTargetKind: "poolAddress",
  captureKind: "none",
  positionKeyStrategy: "none",
};

vi.mock("@tools/kyberswap/zaas/zap-dexes/index.js", () => ({
  getZapDexConfig: () => ({
    chain: "ethereum",
    lastVerified: "2026-01-01",
    source: "test",
    dexes: [NATIVE_ZAP_DEX],
  }),
}));

vi.mock("@vex-agent/sync/benchmark.js", () => ({
  resolveChainBenchmark: (...a: [string]) => h.resolveChainBenchmark(...a),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { KYBERSWAP_HANDLERS } from "../../../../vex-agent/tools/protocols/kyberswap/handlers.js";

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
  };
}

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

describe("FIX 1 — swap build-response router verification", () => {
  const TOKEN_A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const TOKEN_B = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

  beforeEach(() => {
    vi.clearAllMocks();
    h.verifyRouterAddress.mockImplementation((actual: string, expected: string) => {
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`Router address mismatch: ${actual} != ${expected}`);
      }
    });
    h.getHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
    // Route response's router matches — guards approval — but the build
    // response's router is attacker-controlled.
    h.getRoute.mockResolvedValue({
      data: {
        routeSummary: { amountIn: "1000000", amountOut: "999000", gasUsd: "0.5" },
        routerAddress: META_AGGREGATION_ROUTER_V2,
      },
    });
  });

  it("fails closed BEFORE send when the build router differs from the allowlist", async () => {
    h.buildRoute.mockResolvedValue({
      data: {
        routerAddress: ATTACKER_ROUTER,
        data: "0xcalldata",
        transactionValue: "0",
        amountIn: "1000000", amountOut: "999000",
        amountInUsd: "1", amountOutUsd: "1", gasUsd: "0.1",
      },
    });

    await expect(
      KYBERSWAP_HANDLERS["kyberswap.swap.sell"]!(
        { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
        ctx(),
      ),
    ).rejects.toThrow(/mismatch/i);

    expect(h.verifyRouterAddress).toHaveBeenCalledWith(ATTACKER_ROUTER, META_AGGREGATION_ROUTER_V2);
    expect(h.sendKyberTransaction).not.toHaveBeenCalled();
  });

  it("broadcasts when the build router matches the allowlist (positive control)", async () => {
    h.buildRoute.mockResolvedValue({
      data: {
        routerAddress: META_AGGREGATION_ROUTER_V2,
        data: "0xcalldata",
        transactionValue: "0",
        amountIn: "1000000", amountOut: "999000",
        amountInUsd: "1", amountOutUsd: "1", gasUsd: "0.1",
      },
    });

    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.sell"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(h.verifyRouterAddress).toHaveBeenCalledWith(META_AGGREGATION_ROUTER_V2, META_AGGREGATION_ROUTER_V2);
    expect(h.sendKyberTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("FIX 1 — zap.in build-response router verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.verifyRouterAddress.mockImplementation((actual: string, expected: string) => {
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`Router address mismatch: ${actual} != ${expected}`);
      }
    });
    // Route response's router matches the allowlist.
    h.getZapInRoute.mockResolvedValue({
      data: {
        route: "0xroute",
        routerAddress: KS_ZAP_ROUTER_POSITION,
        zapDetails: undefined,
        poolDetails: undefined,
      },
    });
  });

  it("fails closed BEFORE send when the build router differs from the allowlist", async () => {
    h.buildZapIn.mockResolvedValue({
      data: { routerAddress: ATTACKER_ROUTER, callData: "0xcalldata", value: "0" },
    });

    await expect(
      KYBERSWAP_HANDLERS["kyberswap.zap.in"]!(
        { chain: "ethereum", dex: "DEX_UNISWAPV3", pool: "0x1111111111111111111111111111111111111111", tokenIn: NATIVE, amountIn: "1000000000000000000" },
        ctx(),
      ),
    ).rejects.toThrow(/mismatch/i);

    expect(h.verifyRouterAddress).toHaveBeenCalledWith(ATTACKER_ROUTER, KS_ZAP_ROUTER_POSITION);
    expect(h.sendKyberTransactionWithReceipt).not.toHaveBeenCalled();
  });

  it("broadcasts when the build router matches the allowlist (positive control)", async () => {
    h.buildZapIn.mockResolvedValue({
      data: { routerAddress: KS_ZAP_ROUTER_POSITION, callData: "0xcalldata", value: "0" },
    });

    const result = await KYBERSWAP_HANDLERS["kyberswap.zap.in"]!(
      { chain: "ethereum", dex: "DEX_UNISWAPV3", pool: "0x1111111111111111111111111111111111111111", tokenIn: NATIVE, amountIn: "1000000000000000000" },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(h.verifyRouterAddress).toHaveBeenCalledWith(KS_ZAP_ROUTER_POSITION, KS_ZAP_ROUTER_POSITION);
    expect(h.sendKyberTransactionWithReceipt).toHaveBeenCalledTimes(1);
  });
});
