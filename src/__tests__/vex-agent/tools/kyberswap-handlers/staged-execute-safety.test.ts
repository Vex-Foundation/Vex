/**
 * FIX2-W2a / FIX3-W2a / FIX4-W2a — Codex final-review round 1
 * (`codex-review-final-round1.md`, findings 1/3/7/11, contracts
 * C14/C17/C18/C22/C25), round 2 (`codex-review-final-round2.md`, findings
 * 3-6/9, contracts C31-C34/C36), and round 3
 * (`codex-review-final-round3.md`, findings 1/5/6, contracts C37/C40/C41).
 * Pins the staged-execute safety properties that a full-mock happy-path test
 * can't distinguish:
 *
 *   - C14: a `markActivityBroadcast` CAS miss must abort BEFORE any broadcast
 *     is attempted — never a silently-untracked transaction.
 *   - C17/C18: once `createAgentActivityIntent` has run, a later failure must
 *     NEVER create a second execution via `createAgentActivityPreBroadcastFailure`;
 *     it aborts the remaining never-signed planned rows and returns the SAME
 *     `_executionId`.
 *   - C22: a token-resolution failure records the REAL wallet_address
 *     (resolved address-only, before token resolution), never an empty string.
 *   - C32: a settlement-decode throw after confirmation never loses the tx hash.
 *   - C33/C41: a `confirmActivityEvent` write failure OR a CAS miss whose
 *     current row does not already match reports `confirmed_unrecorded`,
 *     never `confirmed`; a CAS miss whose current row already matches is a
 *     benign race and still reports `confirmed`.
 *   - C34: the success message's input amount is the DECODED amount, never
 *     the request echo.
 *   - C36: `abortRemainingPlans` never supplies its own "not attempted:" prefix.
 *   - C37 (supersedes C31's venue-local `preScrub`/HTML/Bearer supplements,
 *     now DELETED): `kyberFailureMessage` is a THIN
 *     `summarizeProtocolError(err).message` delegate — no local
 *     transformation — and every raw-log site routes through it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EvmWallet } from "@tools/wallet/multi-auth.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");

const SESSION_EVM: EvmWallet = {
  family: "eip155" as const,
  // Correct EIP-55 checksum for 0x1234567890abcdef1234567890abcdef12345678 —
  // `getAddress()` re-derives this from the mocked address-only resolver, so
  // this literal must ALREADY be in that exact checksummed form for the
  // wallet_address assertions below to compare equal.
  address: "0x1234567890AbcdEF1234567890aBcdef12345678",
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};

const mockResolveSelectedAddress = vi.fn<WalletResolveModule["resolveSelectedAddress"]>(() => SESSION_EVM.address);
const mockResolveSigningWallet = vi.fn<WalletResolveModule["resolveSigningWallet"]>(() => SESSION_EVM);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (...args: Parameters<WalletResolveModule["resolveSelectedAddress"]>) => mockResolveSelectedAddress(...args),
  resolveSigningWallet: (...args: Parameters<WalletResolveModule["resolveSigningWallet"]>) => mockResolveSigningWallet(...args),
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

const mockReadErc20Metadata = vi.fn(async (_slug: string, address: string) => ({
  address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
}));
const mockPlanKyberAllowance = vi.fn().mockResolvedValue({ needsReset: false, needsApprove: false });
const mockSignStageBroadcast = vi.fn();
const mockDecodeKyberSwapSettlement = vi.fn<(...args: unknown[]) => { amountInRaw: string; amountOutRaw: string } | null>(() => null);

vi.mock("@tools/kyberswap/evm-utils.js", async () => ({
  ...(await import("./evm-client.test-fixtures.js")).kyberEvmClientMocks(),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: (...args: unknown[]) => mockPlanKyberAllowance(...args),
  buildApproveCalldata: vi.fn(() => "0xapprove"),
  signStageBroadcast: (...args: unknown[]) => mockSignStageBroadcast(...args),
  decodeKyberSwapSettlement: (...args: unknown[]) => mockDecodeKyberSwapSettlement(...args),
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

const mockCreateAgentActivityIntent = vi.fn();
const mockCreateAgentActivityPreBroadcastFailure = vi.fn().mockResolvedValue({ executionId: 1, event: { id: 1 } });
const mockMarkActivityBroadcast = vi.fn();
const mockAbortPlannedEvents = vi.fn().mockResolvedValue(undefined);
const mockConfirmActivityEvent = vi.fn().mockResolvedValue({ applied: true, row: {} });

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => mockCreateAgentActivityPreBroadcastFailure(...args),
  markActivityBroadcast: (...args: unknown[]) => mockMarkActivityBroadcast(...args),
  markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  confirmActivityEvent: (...args: unknown[]) => mockConfirmActivityEvent(...args),
  failActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  abortPlannedEvents: (...args: unknown[]) => mockAbortPlannedEvents(...args),
}));

vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: vi.fn().mockResolvedValue({ inserted: true }),
}));

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
  const stub = { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { approvedClaim } from "../../../kyberswap/fixtures/route-build/approved-quote.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import { KYBERSWAP_HANDLERS } from "../../../../vex-agent/tools/protocols/kyberswap/handlers.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { compliantRoutePaths } from "../../../kyberswap/fixtures/route-build/compliant-swap-build.js";
import { compliantCalldataFor, ctx, ROUTER, TOKEN_A, TOKEN_B } from "./staged-execute-safety.test-fixtures.js";

const COMPLIANT_CALLDATA = compliantCalldataFor(SESSION_EVM.address);

function execute(params: Record<string, unknown>) {
  return KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(params, ctx());
}

describe("kyberswap.swap.execute — staged safety (FIX2-W2a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
    mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
    }));
    mockGetHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
    mockPlanKyberAllowance.mockResolvedValue({ needsReset: false, needsApprove: false });
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
        routerAddress: ROUTER,
      },
    };
    mockGetRoute.mockResolvedValue(routeResponse);
    mockClaim.mockImplementation(
      async (_toolId: unknown, _sessionId: unknown, params: Record<string, unknown>) =>
        approvedClaim(
          routeResponse.data.routeSummary,
          typeof params.slippageBps === "number" ? params.slippageBps : VEX_DEFAULT_SLIPPAGE_BPS,
        ),
    );
    // REAL router calldata (re-encoded from a captured build): the handler
    // decodes and asserts it before signing, so a placeholder string would be
    // refused at the pre-sign gate and never reach the staged loop.
    mockBuildRoute.mockResolvedValue({
      data: {
        routerAddress: ROUTER,
        data: COMPLIANT_CALLDATA,
        // The provider's own gas figure for the swap leg. MEASURED live on Base
        // 2026-08-31: `/route/build` answered `gas: "287581"` for a real USDC route.
        gas: "287581",
        transactionValue: "0",
        amountIn: "1000000", amountOut: "999000",
        amountInUsd: "1", amountOutUsd: "1", gasUsd: "0.1",
      },
    });
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 100 }] });
    // `vi.clearAllMocks()` clears call history but NOT a configured
    // implementation/once-queue — reset the mocks whose EXACT per-test
    // sequencing matters so no test can inherit a stale
    // `mockResolvedValueOnce`/`mockImplementation` from the previous one.
    mockSignStageBroadcast.mockReset();
    mockMarkActivityBroadcast.mockReset();
    mockDecodeKyberSwapSettlement.mockReset();
    mockDecodeKyberSwapSettlement.mockReturnValue(null);
    mockConfirmActivityEvent.mockReset();
    mockConfirmActivityEvent.mockResolvedValue({ applied: true, row: {} });
  });

  it("C14: a markActivityBroadcast CAS miss aborts BEFORE any broadcast is attempted", async () => {
    // Mirrors the REAL signStageBroadcast contract: signing happens, the
    // onHashStaged hook runs, and a throw from it propagates OUT of
    // signStageBroadcast before any send is attempted.
    mockMarkActivityBroadcast.mockResolvedValue({ applied: false, row: { id: 100 } });
    mockSignStageBroadcast.mockImplementation(async (_pub, _wallet, _params, hooks) => {
      await hooks.onHashStaged({ txHash: "0xdeadbeef", fromAddress: SESSION_EVM.address, nonce: 0 });
      // Unreachable if onHashStaged throws (matches the real primitive).
      return { kind: "confirmed", txHash: "0xdeadbeef", receipt: { logs: [] } };
    });

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(false);
    expect(mockMarkActivityBroadcast).toHaveBeenCalledTimes(1);
    // The CAS-miss row's own hook threw — no second broadcast/hook attempt.
    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(1);
  });

  it("C18: a post-intent failure NEVER creates a second execution — same _executionId, no pre-broadcast-failure row", async () => {
    mockMarkActivityBroadcast.mockResolvedValue({ applied: false, row: { id: 100 } });
    mockSignStageBroadcast.mockImplementation(async (_pub, _wallet, _params, hooks) => {
      await hooks.onHashStaged({ txHash: "0xdeadbeef", fromAddress: SESSION_EVM.address, nonce: 0 });
      return { kind: "confirmed", txHash: "0xdeadbeef", receipt: { logs: [] } };
    });

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(false);
    expect(result.data?._executionId).toBe(42);
    // failPreBroadcast (createAgentActivityPreBroadcastFailure) must NEVER be
    // called once the intent already exists — that would be a SECOND execution.
    expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
    // The remaining (in this case, the only) never-signed row is aborted.
    expect(mockAbortPlannedEvents).toHaveBeenCalledWith(42, 0, expect.any(String));
    // C36 (Codex final-review round 2, finding 9): `abortPlannedEvents` owns
    // the mandatory "not attempted:" prefix exactly once — the venue caller
    // must NOT supply its own copy (that would double it up).
    expect(mockAbortPlannedEvents.mock.calls[0]![2]).not.toMatch(/^not attempted:/i);
  });

  it("C17: an ambiguous broadcast aborts the DOWNSTREAM never-signed rows, not the ambiguous one itself", async () => {
    mockPlanKyberAllowance.mockResolvedValue({ needsReset: false, needsApprove: true });
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 7, events: [{ id: 10 }, { id: 11 }] });
    mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 10 } });
    mockSignStageBroadcast.mockResolvedValueOnce({ kind: "ambiguous", txHash: "0xallow", stage: "confirm" });

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(false);
    expect(result.data?._executionId).toBe(7);
    // Only ONE broadcast was attempted (the allowance event) — the swap event
    // (index 1) was never signed and must be aborted, NOT the ambiguous row
    // itself (fromIndex = 1, not 0).
    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(1);
    expect(mockAbortPlannedEvents).toHaveBeenCalledWith(7, 1, expect.stringContaining("ambiguous"));
    // C36: no doubled-up "not attempted:" prefix from the venue caller.
    expect(mockAbortPlannedEvents.mock.calls[0]![2]).not.toMatch(/^not attempted:/i);
  });

  it("C22: a token-resolution failure records the REAL wallet_address, never an empty string", async () => {
    mockReadErc20Metadata.mockRejectedValueOnce(new Error("not a valid ERC-20 contract"));

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(false);
    expect(mockCreateAgentActivityPreBroadcastFailure).toHaveBeenCalledTimes(1);
    const call = mockCreateAgentActivityPreBroadcastFailure.mock.calls[0]![0] as { event: { walletAddress: string } };
    expect(call.event.walletAddress).toBe(SESSION_EVM.address);
    expect(call.event.walletAddress).not.toBe("");
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockSignStageBroadcast).not.toHaveBeenCalled();
  });

  it("C32: a settlement-decode throw AFTER on-chain confirmation never loses the tx hash — falls through to confirmed_pending_amounts, not the generic hashless post-intent failure", async () => {
    // The receipt is ALREADY confirmed on-chain at this point (funds moved).
    // A decoder throw here (e.g. a malicious token's malformed log — guarded
    // in `swap-settlement.ts` itself, but this pins the handler's OWN
    // defense-in-depth bounded catch too) must never escape to the outer
    // post-intent catch, which returns a result WITHOUT a tx hash.
    const RAW = "malformed log data: Authorization: Bearer decode-throw-canary";
    mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 100 } });
    mockSignStageBroadcast.mockResolvedValueOnce({ kind: "confirmed", txHash: "0xswaphash", receipt: { logs: [] } });
    mockDecodeKyberSwapSettlement.mockImplementationOnce(() => {
      throw new Error(RAW);
    });

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(true);
    expect(result.data?.txHash).toBe("0xswaphash");
    expect(result.data?.status).toBe("confirmed_pending_amounts");
    // C37: the LOG payload for this raw-log site must carry the scrubbed
    // message (the single entry point), never the raw caught error.
    const call = mockLoggerWarn.mock.calls.find((c) => c[0] === "kyberswap.swap.execute.settlement_decode_threw");
    expect(call).toBeDefined();
    expect((call![1] as { error: string }).error).toBe(summarizeProtocolError(new Error(RAW)).message);
  });

  // 2026-07-25 restoration: the build response's own cost disclosure was
  // validated (`aggregator/validation.ts`) and then referenced nowhere, so a
  // real extra charge on the settlement never reached the agent.
  it("surfaces the build response's additionalCostUsd + provider message on the confirmed result", async () => {
    mockBuildRoute.mockResolvedValue({
      data: {
        routerAddress: ROUTER,
        data: COMPLIANT_CALLDATA,
        // The provider's own gas figure for the swap leg. MEASURED live on Base
        // 2026-08-31: `/route/build` answered `gas: "287581"` for a real USDC route.
        gas: "287581",
        transactionValue: "0",
        amountIn: "1000000", amountOut: "999000",
        amountInUsd: "1", amountOutUsd: "1", gasUsd: "0.1",
        additionalCostUsd: "0.42",
        // Provider-authored prose with an embedded newline — content is kept
        // verbatim (never truncated), control chars collapse to spaces.
        additionalCostMessage: "Positive slippage\nrecouped by the router.",
      },
    });
    mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 100 } });
    mockSignStageBroadcast.mockResolvedValueOnce({ kind: "confirmed", txHash: "0xswaphash", receipt: { logs: [] } });
    mockDecodeKyberSwapSettlement.mockReturnValueOnce({ amountInRaw: "1000000000000000000", amountOutRaw: "999000000000000000" });

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("confirmed");
    expect(result.data?.additionalCostUsd).toBe("0.42");
    expect(result.data?.additionalCostMessage).toBe("Positive slippage recouped by the router.");
  });

  it("omits the additional-cost keys entirely when the build response carries none", async () => {
    mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 100 } });
    mockSignStageBroadcast.mockResolvedValueOnce({ kind: "confirmed", txHash: "0xswaphash", receipt: { logs: [] } });
    mockDecodeKyberSwapSettlement.mockReturnValueOnce({ amountInRaw: "1000000000000000000", amountOutRaw: "999000000000000000" });

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.data).not.toHaveProperty("additionalCostUsd");
    expect(result.data).not.toHaveProperty("additionalCostMessage");
  });

  it("C33: a confirmActivityEvent write failure after a successful decode reports confirmed_unrecorded, never confirmed", async () => {
    const RAW = "db write failed: Authorization: Bearer confirm-failed-canary";
    mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 100 } });
    mockSignStageBroadcast.mockResolvedValueOnce({ kind: "confirmed", txHash: "0xswaphash", receipt: { logs: [] } });
    mockDecodeKyberSwapSettlement.mockReturnValueOnce({ amountInRaw: "1000000000000000000", amountOutRaw: "999000000000000000" });
    mockConfirmActivityEvent.mockRejectedValueOnce(new Error(RAW));

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("confirmed_unrecorded");
    expect(result.data?.txHash).toBe("0xswaphash");
    // C37: same boundary for this site.
    const call = mockLoggerWarn.mock.calls.find((c) => c[0] === "kyberswap.swap.execute.confirm_failed" && !("role" in (c[1] as object)));
    expect(call).toBeDefined();
    expect((call![1] as { error: string }).error).toBe(summarizeProtocolError(new Error(RAW)).message);
  });

  it("C41: a confirmActivityEvent CAS miss with a MISMATCHED already-confirmed row reports confirmed_unrecorded, never confirmed", async () => {
    // The row is no longer `pending` when the UPDATE runs (some OTHER
    // process already terminalized it) — `.applied` is false, and the
    // CURRENT row's executed amounts do NOT match what this call tried to
    // write. This must never be reported as an ordinary recorded confirm.
    mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 100 } });
    mockSignStageBroadcast.mockResolvedValueOnce({ kind: "confirmed", txHash: "0xswaphash", receipt: { logs: [] } });
    mockDecodeKyberSwapSettlement.mockReturnValueOnce({ amountInRaw: "1000000000000000000", amountOutRaw: "999000000000000000" });
    mockConfirmActivityEvent.mockResolvedValueOnce({
      applied: false,
      row: { status: "definitively_failed", executedAmountInRaw: null, executedAmountOutRaw: null },
    });

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("confirmed_unrecorded");
    expect(result.data?.txHash).toBe("0xswaphash");
  });

  it("C41: a confirmActivityEvent CAS miss with an already-confirmed row carrying MATCHING executed amounts still reports confirmed (benign race, not a failure)", async () => {
    mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 100 } });
    mockSignStageBroadcast.mockResolvedValueOnce({ kind: "confirmed", txHash: "0xswaphash", receipt: { logs: [] } });
    mockDecodeKyberSwapSettlement.mockReturnValueOnce({ amountInRaw: "1000000000000000000", amountOutRaw: "999000000000000000" });
    mockConfirmActivityEvent.mockResolvedValueOnce({
      applied: false,
      row: { status: "confirmed", executedAmountInRaw: "1000000000000000000", executedAmountOutRaw: "999000000000000000" },
    });

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("confirmed");
    expect(result.data?.txHash).toBe("0xswaphash");
  });

  it("C34: the confirmed success message's input amount is the DECODED executed amount, never the requested-amount echo", async () => {
    mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 100 } });
    mockSignStageBroadcast.mockResolvedValueOnce({ kind: "confirmed", txHash: "0xswaphash", receipt: { logs: [] } });
    // Requested amountIn is "1" (1e18 wei at 18 decimals) but the DECODED net
    // settlement is a materially different amount — proves the success
    // message reports the persisted truth, not the request echo.
    mockDecodeKyberSwapSettlement.mockReturnValueOnce({ amountInRaw: "500000000000000000", amountOutRaw: "999000000000000000" });

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(true);
    expect(result.data?.amountIn).toBe("0.5");
    expect(result.data?.status).toBe("confirmed");
  });

  // C37 (Codex final-review round 3, finding 1): the scrub CORE (HTML
  // removal, balanced/nested body removal, Bearer-before-header ordering)
  // now lives ENTIRELY in the shared `runtime/errors.ts` — this venue no
  // longer forks a local copy of that behavior (FIX3-W2a's `preScrub`/
  // `stripBearerTokens`/`stripHtmlDocuments` are DELETED). Re-targeted from
  // per-shape adversarial assertions (that duplicated the shared core's own
  // test responsibility) to the property this venue actually owns: every
  // caught error that reaches `ToolResult.output` is the UNMODIFIED
  // `summarizeProtocolError(err).message` — a thin delegate, never a fork.
  it("C37: kyberFailureMessage is a thin summarizeProtocolError(err).message delegate — no local transformation", async () => {
    const RAW = "Request failed: Authorization: Bearer delegate-identity-canary Cookie: session=xyz789secret";
    // The provider call on the EXECUTE path is `/route/build`: the execute no
    // longer fetches a route, it builds from the quote it claimed. The
    // redaction contract under test is the same one, at the call that still
    // reaches a provider.
    mockBuildRoute.mockRejectedValueOnce(new Error(RAW));

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(false);
    // Whatever the shared scrub core currently produces for this EXACT
    // error, the handler's output must carry that value VERBATIM — proves
    // there is no second, venue-local transformation layered on top.
    expect(result.output).toContain(summarizeProtocolError(new Error(RAW)).message);
  });

  it("C31/C37: a provider error's embedded API key is redacted before reaching ToolResult.output (shared core, unchanged shape)", async () => {
    // Short fake canary (matches sibling quote-safety/execute-safety-gate
    // convention) — the assignment-pattern scrub consumes ANY `apiKey=` value,
    // and a realistic-length key here would trip GitHub push protection.
    const RAW = "Route fetch failed: 503 apiKey=sk_live_ABC";
    // The provider call on the EXECUTE path is `/route/build`: the execute no
    // longer fetches a route, it builds from the quote it claimed. The
    // redaction contract under test is the same one, at the call that still
    // reaches a provider.
    mockBuildRoute.mockRejectedValueOnce(new Error(RAW));

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(false);
    expect(result.output).not.toContain("sk_live_ABC");
    expect(result.output).toContain(summarizeProtocolError(new Error(RAW)).message);
  });

  it("C31/C37: a JSON response body (with a nested secret field) never reaches ToolResult.output (shared core, unchanged shape)", async () => {
    const RAW = 'Bad request: {"chainId":1,"secret":"nested-leak-value","amount":"1000"}';
    // The provider call on the EXECUTE path is `/route/build`: the execute no
    // longer fetches a route, it builds from the quote it claimed. The
    // redaction contract under test is the same one, at the call that still
    // reaches a provider.
    mockBuildRoute.mockRejectedValueOnce(new Error(RAW));

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(false);
    expect(result.output).not.toContain("nested-leak-value");
    expect(result.output).not.toContain("chainId");
    expect(result.output).toContain(summarizeProtocolError(new Error(RAW)).message);
  });

  it("C37: abort_planned_events_failed logs the scrubbed message, never the raw error (raw-log site 1/4)", async () => {
    const RAW = "Abort DB failure: Authorization: Bearer abort-log-canary";
    mockMarkActivityBroadcast.mockResolvedValue({ applied: false, row: { id: 100 } });
    mockSignStageBroadcast.mockImplementation(async (_pub, _wallet, _params, hooks) => {
      await hooks.onHashStaged({ txHash: "0xdeadbeef", fromAddress: SESSION_EVM.address, nonce: 0 });
      return { kind: "confirmed", txHash: "0xdeadbeef", receipt: { logs: [] } };
    });
    mockAbortPlannedEvents.mockRejectedValueOnce(new Error(RAW));

    await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    const call = mockLoggerWarn.mock.calls.find((c) => c[0] === "kyberswap.swap.execute.abort_planned_events_failed");
    expect(call).toBeDefined();
    expect((call![1] as { error: string }).error).toBe(summarizeProtocolError(new Error(RAW)).message);
  });

  it("C37: allowance-event confirm_failed logs the scrubbed message, never the raw error (raw-log site 2/4)", async () => {
    const RAW = "DB failure: Authorization: Bearer allowance-confirm-log-canary";
    mockPlanKyberAllowance.mockResolvedValue({ needsReset: false, needsApprove: true });
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 7, events: [{ id: 10 }, { id: 11 }] });
    mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 10 } });
    mockSignStageBroadcast
      .mockResolvedValueOnce({ kind: "confirmed", txHash: "0xallow", receipt: { logs: [] } })
      .mockResolvedValueOnce({ kind: "confirmed", txHash: "0xswap", receipt: { logs: [] } });
    // First confirmActivityEvent call is the allowance event's — the second
    // (swap event's) falls back to beforeEach's default resolved value.
    mockConfirmActivityEvent.mockRejectedValueOnce(new Error(RAW));
    mockDecodeKyberSwapSettlement.mockReturnValueOnce({ amountInRaw: "1000000000000000000", amountOutRaw: "999000000000000000" });

    await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    const call = mockLoggerWarn.mock.calls.find(
      (c) => c[0] === "kyberswap.swap.execute.confirm_failed" && (c[1] as { role?: string }).role === "allowance",
    );
    expect(call).toBeDefined();
    expect((call![1] as { error: string }).error).toBe(summarizeProtocolError(new Error(RAW)).message);
  });

  it("C31/C37: a token=<value> assignment never reaches ToolResult.output (shared core, unchanged shape)", async () => {
    // Short fake canary — see the apiKey= test above for why not full-length.
    const RAW = "Config error: token=sk_live_ABC";
    // The provider call on the EXECUTE path is `/route/build`: the execute no
    // longer fetches a route, it builds from the quote it claimed. The
    // redaction contract under test is the same one, at the call that still
    // reaches a provider.
    mockBuildRoute.mockRejectedValueOnce(new Error(RAW));

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(false);
    expect(result.output).not.toContain("sk_live_ABC");
    expect(result.output).toContain(summarizeProtocolError(new Error(RAW)).message);
  });

  it("C31/C37: a provider error message longer than the shared cap is truncated in ToolResult.output", async () => {
    const RAW = `Route fetch failed: ${"x".repeat(400)}`;
    // The provider call on the EXECUTE path is `/route/build`: the execute no
    // longer fetches a route, it builds from the quote it claimed. The
    // redaction contract under test is the same one, at the call that still
    // reaches a provider.
    mockBuildRoute.mockRejectedValueOnce(new Error(RAW));

    const result = await execute({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" });

    expect(result.success).toBe(false);
    expect(result.output).toContain("…");
    expect(result.output.length).toBeLessThan(RAW.length);
  });
});
