import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");
import { ErrorCodes, VexError } from "../../../../errors.js";

// ── Per-session wallet resolution mock (5D-protocols p1) ──────────
// Handlers now resolve the session wallet via resolve.js (NOT the zero-arg
// requireEvmWallet primary). Spy on the resolvers to assert the session wallet
// is used.

const SESSION_EVM = {
  family: "eip155" as const,
  address: "0x1234567890abcdef1234567890abcdef12345678",
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};
const mockResolveSigningWallet = vi.fn<WalletResolveModule["resolveSigningWallet"]>(() => SESSION_EVM);
const mockResolveSelectedAddress = vi.fn<WalletResolveModule["resolveSelectedAddress"]>(() => SESSION_EVM.address);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet: (...args: Parameters<WalletResolveModule["resolveSigningWallet"]>) => mockResolveSigningWallet(...args),
  resolveSelectedAddress: (...args: Parameters<WalletResolveModule["resolveSelectedAddress"]>) => mockResolveSelectedAddress(...args),
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

const mockPlanKyberAllowance = vi.fn();
const mockEnsureErc20Balance = vi.fn();
const mockSignStageBroadcast = vi.fn();
const mockDecodeKyberSwapSettlement = vi.fn();

// readErc20Metadata is used by resolveTokenMetadataStrict for address inputs.
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
  planKyberAllowance: (...args: unknown[]) => mockPlanKyberAllowance(...args),
  buildApproveCalldata: vi.fn(() => "0xapprove"),
  signStageBroadcast: (...args: unknown[]) => mockSignStageBroadcast(...args),
  decodeKyberSwapSettlement: (...args: unknown[]) => mockDecodeKyberSwapSettlement(...args),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
}));

vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: (...args: unknown[]) => mockEnsureErc20Balance(...args),
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
const mockBuildRoute = vi.fn();

vi.mock("@tools/kyberswap/aggregator/client.js", () => ({
  getKyberAggregatorClient: () => ({
    getRoute: (...args: unknown[]) => mockGetRoute(...args),
    buildRoute: (...args: unknown[]) => mockBuildRoute(...args),
  }),
}));

const mockCreateAgentActivityIntent = vi.fn();
const mockCreateAgentActivityPreBroadcastFailure = vi.fn().mockResolvedValue({ executionId: 1, event: { id: 1 } });

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => mockCreateAgentActivityPreBroadcastFailure(...args),
  markActivityBroadcast: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  confirmActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  failActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
}));

vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: vi.fn().mockResolvedValue({ inserted: true }),
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

import { compliantSwapCalldata, compliantRoutePaths } from "../../../kyberswap/fixtures/route-build/compliant-swap-build.js";
import { KYBERSWAP_HANDLERS } from "../../../../vex-agent/tools/protocols/kyberswap/handlers.js";

describe("kyberswap.swap.execute inline safety gate (FIX 1, broadcast path)", () => {
  const TOKEN_A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC-like
  const TOKEN_B = "0xdAC17F958D2ee523a2206206994597C13D831ec7"; // USDT-like
  const EXEC_CTX = ctx({ sessionPermission: "full", approved: true });

  /** A real execute call that, once past the safety gate, completes cleanly. */
  function executeCall() {
    return KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      EXEC_CTX,
    );
  }

  beforeEach(() => {
    // Quoted 999000 out at the venue-default 50 bps — identical to the route
    // mock below, so the re-read floor is consistent with the route.
    mockGetHoneypotFotInfo.mockReset();
    mockGetHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
    mockGetRoute.mockReset();
    mockGetRoute.mockResolvedValue({
      data: {
        routeSummary: {
          amountIn: "1000000", amountOut: "999000", gasUsd: "0.5", routeID: "r1", checksum: "c1",
          // A route summary ALWAYS carries its paths, and the pre-sign guard
          // reads them to decide which pools the build may fund.
          route: compliantRoutePaths({
            srcToken: TOKEN_A, dstToken: TOKEN_B, amountIn: 10n ** 18n, quotedNetOutRaw: "999000",
          }),
        },
        routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
      },
    });
    mockBuildRoute.mockReset();
    mockBuildRoute.mockResolvedValue({
      data: {
        routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        // Real router calldata from a captured build. The execute DECODES this
        // before signing (`swap-calldata-guard.ts`: fee receiver/amount, bps +
        // source flags, no partial fill, and both price floors), so a
        // `"0xcalldata"` placeholder is refused as "could not decode it as a
        // router swap" before the safety-gate outcomes asserted here. Identity
        // fields mirror the handler call: TOKEN_A→TOKEN_B, 18-decimal
        // `amountIn: "1"`, output to the session wallet.
        data: compliantSwapCalldata({
          srcToken: TOKEN_A, dstToken: TOKEN_B, dstReceiver: SESSION_EVM.address,
          amountIn: 10n ** 18n, quotedNetOutRaw: "999000", slippageBps: 50,
        }),
        transactionValue: "0",
        amountIn: "1000000", amountOut: "999000",
        amountInUsd: "1", amountOutUsd: "1", gasUsd: "0.1",
      },
    });
    mockReadErc20Metadata.mockReset();
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
    }));
    mockLoggerWarn.mockClear();
    mockPlanKyberAllowance.mockReset();
    mockPlanKyberAllowance.mockResolvedValue({ needsReset: false, needsApprove: false });
    mockEnsureErc20Balance.mockReset();
    mockEnsureErc20Balance.mockResolvedValue(undefined);
    mockCreateAgentActivityIntent.mockReset();
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 1, events: [{ id: 1 }] });
    mockCreateAgentActivityPreBroadcastFailure.mockClear();
    mockSignStageBroadcast.mockReset();
    mockSignStageBroadcast.mockResolvedValue({ kind: "confirmed", txHash: "0xswaphash", receipt: { logs: [] } });
    mockDecodeKyberSwapSettlement.mockReset();
    mockDecodeKyberSwapSettlement.mockReturnValue(null);
  });

  it("an insufficient input balance aborts before the swap is planned or broadcast", async () => {
    mockEnsureErc20Balance.mockRejectedValue(new VexError(ErrorCodes.INSUFFICIENT_BALANCE, "short balance"));

    const result = await executeCall();

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/short balance/i);
    expect(mockSignStageBroadcast).not.toHaveBeenCalled();
  });

  it("a CONFIRMED honeypot tokenIn STILL aborts — never reaches the route step", async () => {
    mockGetHoneypotFotInfo.mockImplementation(async (_chainId: number, address: string) => {
      if (address.toLowerCase() === TOKEN_A.toLowerCase()) return { isHoneypot: true, isFOT: false, tax: 0 };
      return { isHoneypot: false, isFOT: false, tax: 0 };
    });

    const result = await executeCall();
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/honeypot/i);
    expect(result.output).toMatch(/aborting/i);
    // Aborted before the route fetch.
    expect(mockGetRoute).not.toHaveBeenCalled();
  });

  it("a CONFIRMED honeypot tokenOut STILL aborts", async () => {
    mockGetHoneypotFotInfo.mockImplementation(async (_chainId: number, address: string) => {
      if (address.toLowerCase() === TOKEN_B.toLowerCase()) return { isHoneypot: true, isFOT: false, tax: 0 };
      return { isHoneypot: false, isFOT: false, tax: 0 };
    });

    const result = await executeCall();
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/honeypot/i);
    expect(mockGetRoute).not.toHaveBeenCalled();
  });

  it("FoT tax > 50 does NOT abort — proceeds past the gate to a real swap + warns", async () => {
    mockGetHoneypotFotInfo.mockImplementation(async (_chainId: number, address: string) => {
      if (address.toLowerCase() === TOKEN_A.toLowerCase()) return { isHoneypot: false, isFOT: true, tax: 60 };
      return { isHoneypot: false, isFOT: false, tax: 0 };
    });

    const result = await executeCall();
    // Reached the route step and completed → the safety gate did NOT abort on FoT.
    expect(result.success).toBe(true);
    expect(mockGetRoute).toHaveBeenCalledTimes(1);
    // A high-tax FoT still emits a (warn-only) structural log.
    const fotWarn = mockLoggerWarn.mock.calls.find((c) => c[0] === "kyberswap.swap.fot_warning");
    expect(fotWarn).toBeDefined();
    expect((fotWarn![1] as Record<string, unknown>).tax).toBe(60);
  });

  it("a THROWN safety check does NOT abort — proceeds + logs ONE bounded reason class (no raw text)", async () => {
    const RAW =
      "Honeypot check failed: 503 https://token-api.kyberswap.com/x?apiKey=sk_live_ABC <!DOCTYPE html><html>boom</html>";
    mockGetHoneypotFotInfo.mockImplementation(async (_chainId: number, address: string) => {
      if (address.toLowerCase() === TOKEN_A.toLowerCase()) throw new Error(RAW);
      return { isHoneypot: false, isFOT: false, tax: 0 };
    });

    const result = await executeCall();
    // A transient external-API failure must NOT abort a legit trade.
    expect(result.success).toBe(true);
    expect(mockGetRoute).toHaveBeenCalledTimes(1);

    // ONE bounded structural warn — reason class only, never raw provider/HTTP text.
    const failWarn = mockLoggerWarn.mock.calls.find((c) => c[0] === "kyberswap.swap.safety_check_failed");
    expect(failWarn).toBeDefined();
    const payload = failWarn![1] as Record<string, unknown>;
    expect(["timeout", "rate_limited", "kyber_error", "unavailable"]).toContain(payload.reason);
    const serialized = JSON.stringify(payload).toLowerCase();
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("kyberswap.com");
    expect(serialized).not.toContain("<!doctype");
    expect(serialized).not.toContain("html");
    expect(serialized).not.toContain("apikey=");
    expect(serialized).not.toContain("sk_live");
    expect(serialized).not.toContain("503");
  });

  it("a confirmed honeypot caught at execute STILL aborts even when the OTHER leg's check threw", async () => {
    // Owner residual-risk note: the execute-time honeypot gate is the hard block
    // whenever the check SUCCEEDS and returns honeypot — independent of a
    // transient failure on the other leg.
    mockGetHoneypotFotInfo.mockImplementation(async (_chainId: number, address: string) => {
      if (address.toLowerCase() === TOKEN_A.toLowerCase()) throw new Error("transient 429");
      if (address.toLowerCase() === TOKEN_B.toLowerCase()) return { isHoneypot: true, isFOT: false, tax: 0 };
      return { isHoneypot: false, isFOT: false, tax: 0 };
    });

    const result = await executeCall();
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/honeypot/i);
  });
});
