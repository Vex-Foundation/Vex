import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

// ── Per-session wallet resolution mock (5D-protocols p1) ──────────
// Handlers now resolve the session wallet via resolve.js (NOT the zero-arg
// requireEvmWallet primary). Spy on the resolvers to assert the session wallet
// is used and that preview/dryRun never decrypts a signing key.

const SESSION_EVM = {
  family: "eip155" as const,
  address: "0x1234567890abcdef1234567890abcdef12345678",
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};
const mockResolveSigningWallet = vi.fn(() => SESSION_EVM);
const mockResolveSelectedAddress = vi.fn(() => SESSION_EVM.address);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet: (...args: unknown[]) => mockResolveSigningWallet(...args),
  resolveSelectedAddress: (...args: unknown[]) => mockResolveSelectedAddress(...args),
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

/** Type-complete ProtocolExecutionContext for handler tests. */
function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...over,
  };
}

const mockGetZapInRoute = vi.fn();
const mockBuildZapIn = vi.fn();
const mockGetZapOutRoute = vi.fn();
const mockBuildZapOut = vi.fn();
const mockGetZapMigrateRoute = vi.fn();
const mockBuildZapMigrate = vi.fn();

vi.mock("@tools/kyberswap/zaas/client.js", () => ({
  getKyberZaasClient: () => ({
    getZapInRoute: (...args: unknown[]) => mockGetZapInRoute(...args),
    buildZapIn: (...args: unknown[]) => mockBuildZapIn(...args),
    getZapOutRoute: (...args: unknown[]) => mockGetZapOutRoute(...args),
    buildZapOut: (...args: unknown[]) => mockBuildZapOut(...args),
    getZapMigrateRoute: (...args: unknown[]) => mockGetZapMigrateRoute(...args),
    buildZapMigrate: (...args: unknown[]) => mockBuildZapMigrate(...args),
  }),
}));

const mockExtractMintedNftId = vi.fn();
const mockExtractErc1155Position = vi.fn();

// readErc20Metadata is used by resolveTokenMetadataStrict for address inputs
// (the quote path is now strict/address-only, matching execute).
// Default: return plain ERC-20 metadata so non-native token addresses resolve
// without an on-chain read. Tests override per-case where needed.
const mockReadErc20Metadata = vi.fn(async (_slug: string, address: string) => ({
  address,
  symbol: "TKN",
  name: "Token",
  decimals: 18,
  isNative: false as const,
}));

vi.mock("@tools/kyberswap/evm-utils.js", () => ({
  getKyberEvmClients: () => ({
    publicClient: {},
    walletClient: {},
  }),
  ensureKyberAllowance: vi.fn().mockResolvedValue(undefined),
  ensureErc721Approval: vi.fn().mockResolvedValue(null),
  ensureErc1155ApprovalForAll: vi.fn().mockResolvedValue(null),
  sendKyberTransaction: vi.fn().mockResolvedValue("0xmockhash"),
  sendKyberTransactionWithReceipt: vi.fn().mockResolvedValue({
    hash: "0xzaphash",
    receipt: { logs: [{ topics: ["0xddf252ad"], data: "0x" }] },
  }),
  extractMintedNftId: (...args: unknown[]) => mockExtractMintedNftId(...args),
  extractErc1155Position: (...args: unknown[]) => mockExtractErc1155Position(...args),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
}));

// Mock token API for safety gate + quote-time safety surfacing (Stage 6b).
// Shared spy so individual tests can drive honeypot/FoT/check-failed scenarios.
const mockGetHoneypotFotInfo = vi.fn().mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });

vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    searchTokens: vi.fn().mockResolvedValue([]),
    getHoneypotFotInfo: (...args: [number, string]) => mockGetHoneypotFotInfo(...args),
  }),
}));

// Mock aggregator client so the read-only quote can fetch a route hermetically.
const mockGetRoute = vi.fn();

vi.mock("@tools/kyberswap/aggregator/client.js", () => ({
  getKyberAggregatorClient: () => ({
    getRoute: (...args: unknown[]) => mockGetRoute(...args),
  }),
}));

// Spy on logger.warn so the fail-soft safety leg's log payload can be asserted
// to contain NO raw provider/HTTP text (Stage 6b fix 1). Other methods are
// no-ops to keep tests hermetic and quiet.
const mockLoggerWarn = vi.fn();

vi.mock("@utils/logger.js", () => {
  const stub = {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
  return { default: stub, logger: stub };
});

import { KYBERSWAP_HANDLERS } from "../../../../vex-agent/tools/protocols/kyberswap/handlers.js";
import { KYBERSWAP_TOOLS } from "../../../../vex-agent/tools/protocols/kyberswap/manifest.js";

describe("kyberswap handlers", () => {
  // ── Handler coverage ─────────────────────────────────────────────

  it("has a handler for every manifest toolId", () => {
    const handlerKeys = new Set(Object.keys(KYBERSWAP_HANDLERS));
    const manifestIds = KYBERSWAP_TOOLS.map(t => t.toolId);
    const missing = manifestIds.filter(id => !handlerKeys.has(id));
    expect(missing).toEqual([]);
  });

  it("has no extra handlers without manifests", () => {
    const manifestIds = new Set(KYBERSWAP_TOOLS.map(t => t.toolId));
    const handlerKeys = Object.keys(KYBERSWAP_HANDLERS);
    const extra = handlerKeys.filter(key => !manifestIds.has(key));
    expect(extra).toEqual([]);
  });

  it("handler count matches manifest count (20)", () => {
    expect(Object.keys(KYBERSWAP_HANDLERS)).toHaveLength(20);
  });

  it("every handler is a function", () => {
    for (const [, handler] of Object.entries(KYBERSWAP_HANDLERS)) {
      expect(typeof handler).toBe("function");
    }
  });

  // ── Required param validation ────────────────────────────────────

  it("kyberswap.tokens.check fails without chain and address", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.tokens.check"]!(
      {},
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chain");
  });

  it("kyberswap.swap.quote fails without required params", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
      { chain: "ethereum" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });

  it("kyberswap.swap.sell fails without required params", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.sell"]!(
      { chain: "ethereum", tokenIn: "ETH" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });

  it("kyberswap.swap.buy fails without required params", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.buy"]!(
      { chain: "ethereum", tokenIn: "USDC" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });

  it("kyberswap.limitOrder.list fails without chain", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.limitOrder.list"]!(
      {},
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chain");
  });

  it("kyberswap.limitOrder.activeMakingAmount fails without chain and makerAsset", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.limitOrder.activeMakingAmount"]!(
      { chain: "ethereum" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("makerAsset");
  });

  it("kyberswap.limitOrder.create fails without required params", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.limitOrder.create"]!(
      { chain: "ethereum", makerAsset: "USDC" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });

  it("kyberswap.limitOrder.cancel fails without chain and orderId", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.limitOrder.cancel"]!(
      { chain: "ethereum" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("orderId");
  });

  it("kyberswap.limitOrder.hardCancel fails without chain and orderId", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.limitOrder.hardCancel"]!(
      {},
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chain");
  });

  it("kyberswap.limitOrder.pairs fails without chain", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.limitOrder.pairs"]!(
      {},
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chain");
  });

  it("kyberswap.limitOrder.fill fails without required params", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.limitOrder.fill"]!(
      { chain: "ethereum", orderId: 123 },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });

  it("kyberswap.limitOrder.batchFill fails without required params", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.limitOrder.batchFill"]!(
      { chain: "ethereum" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });

  it("kyberswap.limitOrder.cancelAll fails without chain", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.limitOrder.cancelAll"]!(
      {},
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chain");
  });

  it("kyberswap.zap.in fails without required params", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.zap.in"]!(
      { chain: "ethereum", dex: "uniswapv3" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });

  it("kyberswap.zap.out fails without required params", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.zap.out"]!(
      { chain: "ethereum" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });

  it("kyberswap.zap.migrate fails without required params", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.zap.migrate"]!(
      { chain: "ethereum", dexFrom: "uniswapv3" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });

  // ── Read-only handlers return data (no wallet needed) ────────────

  it("kyberswap.chains returns chain list", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.chains"]!(
      {},
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(21);
    expect(data[0].slug).toBeDefined();
    expect(data[0].chainId).toBeDefined();
    expect(data[0].aggregator).toBeDefined();
  });

  // ── positionRef rename ──────────────────────────────────────────

  it("kyberswap.zap.out fails with old positionId param name", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.zap.out"]!(
      { chain: "polygon", dex: "DEX_UNISWAPV3", pool: "0xPool", positionId: "123", tokenOut: "0xToken" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });

  it("kyberswap.zap.migrate fails with old positionId param name", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.zap.migrate"]!(
      { chain: "polygon", dexFrom: "DEX_UNISWAPV3", dexTo: "DEX_UNISWAPV3", poolFrom: "0xA", poolTo: "0xB", positionId: "123" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required");
  });

  // ── source-only / TBD rejection ───────────────────────────────

  it("kyberswap.zap.in rejects unknown DEX", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.zap.in"]!(
      {
        chain: "polygon", dex: "DEX_NONEXISTENT", pool: "0xPool",
        tokenIn: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", amountIn: "100",
      },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown DEX");
  });

  // ── zap.in positionKey regression ───────────────────────────────

  it("kyberswap.zap.in captures positionKey from receipt NFT mint", async () => {
    mockGetZapInRoute.mockResolvedValueOnce({
      data: {
        route: { some: "route" },
        routerAddress: "0x2f1E23e0A5A56e7746E1Ae42d5c3112B2d0cf09B",
        zapDetails: { initialAmountUsd: "50.00", actions: [] },
      },
    });
    mockBuildZapIn.mockResolvedValueOnce({
      data: {
        routerAddress: "0x2f1E23e0A5A56e7746E1Ae42d5c3112B2d0cf09B",
        callData: "0xdeadbeef",
        value: "0",
      },
    });
    mockExtractMintedNftId.mockReturnValueOnce("12345");

    const result = await KYBERSWAP_HANDLERS["kyberswap.zap.in"]!(
      {
        chain: "polygon", dex: "DEX_UNISWAPV3", pool: "0xPoolAddress",
        tokenIn: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        amountIn: "1000000000000000000",
      },
      ctx({ sessionPermission: "full", approved: true }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const capture = result.data!._tradeCapture as Record<string, unknown>;
    expect(capture.type).toBe("lp");
    expect(capture.positionKey).toBe("12345");
    expect(capture.instrumentKey).toBe("polygon:lp:0xPoolAddress");
    expect(capture.valuationSource).toBe("zaas_estimate");
    expect(mockExtractMintedNftId).toHaveBeenCalledTimes(1);
  });

  // ── zap.migrate emits 2 capture items (R6) ────────────────────

  it("kyberswap.zap.migrate emits close + open capture items with different positionKeys", async () => {
    mockGetZapMigrateRoute.mockResolvedValueOnce({
      data: {
        route: "encoded-route",
        routerAddress: "0x0e97c887b61ccd952a53578b04763e7134429e05",
        zapDetails: { finalAmountUsd: "100.00", actions: [] },
      },
    });
    mockBuildZapMigrate.mockResolvedValueOnce({
      data: {
        routerAddress: "0x0e97c887b61ccd952a53578b04763e7134429e05",
        callData: "0xdeadbeef",
        value: "0",
      },
    });
    mockExtractMintedNftId.mockReturnValueOnce("99999");

    const result = await KYBERSWAP_HANDLERS["kyberswap.zap.migrate"]!(
      {
        chain: "polygon", dexFrom: "DEX_UNISWAPV3", dexTo: "DEX_UNISWAPV3",
        poolFrom: "0xB6e57ed85c4c9dbfEF2a68711e9d6f36c56e0FcB", poolTo: "0xA374094527e1673A86dE625aa7147BeE868d0D1a",
        sourcePositionRef: "12345",
      },
      ctx({ sessionPermission: "full", approved: true }),
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const items = data._tradeCaptureItems as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);

    // First item: close source
    expect((items[0].meta as Record<string, unknown>).action).toBe("zap-out");
    expect(items[0].positionKey).toBe("12345"); // sourcePositionKey = NFT tokenId

    // Second item: open destination
    expect((items[1].meta as Record<string, unknown>).action).toBe("zap-in");
    expect(items[1].positionKey).toBe("99999"); // newPositionKey from receipt
    expect(items[1].instrumentKey).toBe("polygon:lp:0xA374094527e1673A86dE625aa7147BeE868d0D1a");
  });

  // ── zap.out uses approval target from catalog (R1) ─────────────

  it("kyberswap.zap.out resolves approval target from DEX entry", async () => {
    mockGetZapOutRoute.mockResolvedValueOnce({
      data: {
        route: "encoded-route",
        routerAddress: "0x0e97c887b61ccd952a53578b04763e7134429e05",
        zapDetails: { finalAmountUsd: "50.00", actions: [] },
      },
    });
    mockBuildZapOut.mockResolvedValueOnce({
      data: {
        routerAddress: "0x0e97c887b61ccd952a53578b04763e7134429e05",
        callData: "0xdeadbeef",
        value: "0",
      },
    });

    const result = await KYBERSWAP_HANDLERS["kyberswap.zap.out"]!(
      {
        chain: "polygon", dex: "DEX_UNISWAPV3", pool: "0xB6e57ed85c4c9dbfEF2a68711e9d6f36c56e0FcB",
        positionRef: "12345",
        tokenOut: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      },
      ctx({ sessionPermission: "full", approved: true }),
    );

    expect(result.success).toBe(true);
    // ensureErc721Approval should have been called (ERC-721 DEX)
    const { ensureErc721Approval } = await import("@tools/kyberswap/evm-utils.js");
    expect(ensureErc721Approval).toHaveBeenCalled();
  });
});
