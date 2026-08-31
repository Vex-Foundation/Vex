import assert from "node:assert/strict";

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EvmWallet } from "@tools/wallet/multi-auth.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");
import { ErrorCodes, VexError } from "../../../../errors.js";

// ── Per-session wallet resolution mock (5D-protocols p1) ──────────
// Handlers now resolve the session wallet via resolve.js (NOT the zero-arg
// requireEvmWallet primary). Spy on the resolvers to assert the session wallet
// is used.

const SESSION_EVM: EvmWallet = {
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

vi.mock("@tools/kyberswap/evm-utils.js", async () => ({
  ...(await import("./evm-client.test-fixtures.js")).kyberEvmClientMocks(),
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

/** The first recorded activity-intent payload — absence is the test failure. */
function firstIntentCall(): unknown {
  const [call] = mockCreateAgentActivityIntent.mock.calls;
  assert.ok(call, "no activity intent was recorded");
  return call[0];
}
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

// The execute CLAIMS the approved quote instead of fetching a route (the
// 2026-08-27 quote-binding change). The claim's own behaviour is covered by
// `quote-bound-execute.test.ts` and the Postgres claim suite; here it hands
// back a real snapshot of this file's own route so the handler reaches the
// behaviour under test.
const mockClaim = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  claimSwapExecutionSnapshot: (...args: unknown[]) => mockClaim(...args),
}));

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
import { approvedClaim } from "../../../kyberswap/fixtures/route-build/approved-quote.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
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
    const routeResponse = {
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
    };
    mockGetRoute.mockResolvedValue(routeResponse);
    // This file has no global mock reset, so the claim spy is cleared here:
    // its CALL COUNT is an assertion below (the safety gate must abort before
    // a quote is consumed), and a cumulative count would make that vacuous.
    mockClaim.mockReset();
    mockClaim.mockImplementation(
      async (_toolId: unknown, _sessionId: unknown, params: Record<string, unknown>) =>
        approvedClaim(
          routeResponse.data.routeSummary,
          typeof params.slippageBps === "number" ? params.slippageBps : VEX_DEFAULT_SLIPPAGE_BPS,
        ),
    );
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
        // The provider's own gas figure for the swap leg. MEASURED live on Base
        // 2026-08-31: `/route/build` answered `gas: "287581"` for a real USDC route.
        gas: "287581",
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
    // Nothing claimed the approved quote either: a refusal here must not
    // consume the single-use quote the user would re-execute after fixing it.
    expect(mockClaim).not.toHaveBeenCalled();
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
    // Nothing claimed the approved quote either: a refusal here must not
    // consume the single-use quote the user would re-execute after fixing it.
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("FoT tax > 50 does NOT abort — proceeds past the gate to a real swap + warns", async () => {
    mockGetHoneypotFotInfo.mockImplementation(async (_chainId: number, address: string) => {
      if (address.toLowerCase() === TOKEN_A.toLowerCase()) return { isHoneypot: false, isFOT: true, tax: 60 };
      return { isHoneypot: false, isFOT: false, tax: 0 };
    });

    const result = await executeCall();
    // Claimed the approved quote and completed → the safety gate did NOT abort
    // on FoT. (The execute no longer fetches a route; the claim is the step
    // that follows the safety gate.)
    expect(result.success).toBe(true);
    expect(mockClaim).toHaveBeenCalledTimes(1);
    // A high-tax FoT still emits a (warn-only) structural log.
    const fotWarn = mockLoggerWarn.mock.calls.find((c) => c[0] === "kyberswap.swap.fot_warning");
    expect(fotWarn).toBeDefined();
    expect((fotWarn![1] as Record<string, unknown>).tax).toBe(60);
  });

  it("a THROWN safety check does NOT abort — and is DISCLOSED, never silent (W2b)", async () => {
    const RAW =
      "Honeypot check failed: 503 https://token-api.kyberswap.com/x?apiKey=sk_live_ABC <!DOCTYPE html><html>boom</html>";
    mockGetHoneypotFotInfo.mockImplementation(async (_chainId: number, address: string) => {
      if (address.toLowerCase() === TOKEN_A.toLowerCase()) throw new Error(RAW);
      return { isHoneypot: false, isFOT: false, tax: 0 };
    });

    const result = await executeCall();
    // A transient external-API failure must NOT abort a legit trade.
    expect(result.success).toBe(true);
    expect(mockClaim).toHaveBeenCalledTimes(1);

    // ONE bounded structural warn, now carrying the SANITIZED cause as well as
    // the reason class (owner decree 2026-08-02 — a generic label on a
    // diagnosable failure makes the agent retry blind). The scrubber's
    // guarantees are what is asserted: no URL, no credential, no raw markup.
    // A bounded status integer and the `(html)` placeholder are the sanitizer's
    // own OUTPUT and are deliberately allowed.
    const failWarn = mockLoggerWarn.mock.calls.find((c) => c[0] === "kyberswap.swap.safety_check_failed");
    expect(failWarn).toBeDefined();
    const payload = failWarn![1] as Record<string, unknown>;
    expect(["timeout", "rate_limited", "kyber_error", "unavailable"]).toContain(payload.reason);
    expect(typeof payload.cause).toBe("string");
    const serialized = JSON.stringify(payload).toLowerCase();
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("kyberswap.com");
    expect(serialized).not.toContain("<!doctype");
    expect(serialized).not.toContain("<html");
    expect(serialized).not.toContain("apikey=");
    expect(serialized).not.toContain("sk_live");

    // The AGENT is told, in the result output and in the machine field.
    expect(result.output).toMatch(/honeypot\/fee-on-transfer check could not run/i);
    expect(result.output).toMatch(/WITHOUT that protection/i);
    const data = result.data as { safetyCheckUnavailable?: ReadonlyArray<Record<string, unknown>> };
    const unavailable = data.safetyCheckUnavailable;
    assert.ok(unavailable);
    expect(unavailable).toHaveLength(1);
    const [firstUnavailable] = unavailable;
    assert.ok(firstUnavailable);
    expect(firstUnavailable.tokenAddress).toBe(TOKEN_A);
    expect(typeof firstUnavailable.cause).toBe("string");

    // …and the ACTIVITY ROW records it, so the persisted history says this swap
    // ran without honeypot protection.
    const intent = firstIntentCall() as { intentParams: Record<string, unknown> };
    expect(intent.intentParams._safetyCheckUnavailable).toHaveLength(1);
    // The model's own params are untouched beside it.
    expect(intent.intentParams.chain).toBe("ethereum");
  });

  it("records NOTHING extra when every safety check succeeded", async () => {
    const result = await executeCall();
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).safetyCheckUnavailable).toBeUndefined();
    const intent = firstIntentCall() as { intentParams: Record<string, unknown> };
    expect(intent.intentParams._safetyCheckUnavailable).toBeUndefined();
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
