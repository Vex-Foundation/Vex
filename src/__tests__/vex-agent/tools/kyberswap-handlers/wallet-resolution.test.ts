import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

// ── Per-session wallet resolution mock (5D-protocols p1) ──────────
// Handlers now resolve the session wallet via resolve.js (NOT the zero-arg
// requireEvmWallet primary). Spy on the resolvers to assert the session wallet
// is used and that a rejected dryRun never decrypts a signing key.

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
    sessionId: "session-1",
    ...over,
  };
}

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
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: vi.fn().mockResolvedValue({ needsReset: false, needsApprove: false }),
  buildApproveCalldata: vi.fn(() => "0xapprove"),
  signStageBroadcast: vi.fn().mockResolvedValue({ kind: "confirmed", txHash: "0xswaphash", receipt: { logs: [] } }),
  decodeKyberSwapSettlement: vi.fn(() => null),
}));

vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: vi.fn().mockResolvedValue(undefined),
}));

const mockGetHoneypotFotInfo = vi.fn().mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });

vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    searchTokens: vi.fn().mockResolvedValue([]),
    getHoneypotFotInfo: (...args: [number, string]) => mockGetHoneypotFotInfo(...args),
  }),
}));

const mockGetRoute = vi.fn();
const mockBuildRoute = vi.fn();

vi.mock("@tools/kyberswap/aggregator/client.js", () => ({
  getKyberAggregatorClient: () => ({
    getRoute: (...args: unknown[]) => mockGetRoute(...args),
    buildRoute: (...args: unknown[]) => mockBuildRoute(...args),
  }),
}));

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: vi.fn().mockResolvedValue({ executionId: 1, events: [{ id: 1 }] }),
  createAgentActivityPreBroadcastFailure: vi.fn().mockResolvedValue({ executionId: 1, event: { id: 1 } }),
  markActivityBroadcast: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  confirmActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  failActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
}));

vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: vi.fn().mockResolvedValue({ inserted: true }),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { compliantSwapCalldata } from "../../../kyberswap/fixtures/route-build/compliant-swap-build.js";
import { KYBERSWAP_HANDLERS } from "../../../../vex-agent/tools/protocols/kyberswap/handlers.js";

const TOKEN_A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOKEN_B = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

describe("kyberswap session wallet resolution", () => {
  const SESSION_CTX = ctx({
    walletResolution: { source: "session", evm: { id: "w-evm-1", address: SESSION_EVM.address }, solana: null },
    walletPolicy: { kind: "none" },
  });

  beforeEach(() => {
    mockResolveSigningWallet.mockClear();
    mockResolveSelectedAddress.mockClear();
    mockGetHoneypotFotInfo.mockClear();
    mockGetHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
    mockGetRoute.mockReset();
    mockGetRoute.mockResolvedValue({
      data: {
        routeSummary: { amountIn: "1000000", amountOut: "999000", gasUsd: "0.5", routeID: "r1", checksum: "c1" },
        routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
      },
    });
    mockBuildRoute.mockReset();
    mockBuildRoute.mockResolvedValue({
      data: {
        routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        // Real router calldata from a captured build. The execute now DECODES
        // this before signing (fee receivers/amounts, bps + source flags, no
        // partial fill, and both price floors), so a `"0xcalldata"` placeholder
        // is refused as "could not decode it as a router swap" long before the
        // wallet resolution these tests assert.
        data: compliantSwapCalldata({
          srcToken: TOKEN_A, dstToken: TOKEN_B, dstReceiver: SESSION_EVM.address,
          amountIn: 10n ** 18n, quotedNetOutRaw: "999000", slippageBps: 50,
        }),
        transactionValue: "0",
        amountIn: "1000000", amountOut: "999000",
        amountInUsd: "1", amountOutUsd: "1", gasUsd: "0.1",
      },
    });
  });

  it("kyberswap.swap.execute resolves the SESSION signing wallet (not the zero-arg primary)", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      SESSION_CTX,
    );

    expect(result.success, `handler output: ${result.output}`).toBe(true);
    // Signer resolved from the SESSION resolution + policy, family eip155.
    expect(mockResolveSigningWallet).toHaveBeenCalledWith(
      SESSION_CTX.walletResolution, SESSION_CTX.walletPolicy, "eip155",
    );
  });

  it("kyberswap.swap.execute rejects dryRun WITHOUT ever resolving a signing wallet", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1", dryRun: true },
      SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/dryRun/i);
    expect(mockResolveSigningWallet).not.toHaveBeenCalled();
    expect(mockGetRoute).not.toHaveBeenCalled();
  });
});
