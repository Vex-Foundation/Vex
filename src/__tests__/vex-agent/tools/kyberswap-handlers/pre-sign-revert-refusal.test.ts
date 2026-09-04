/**
 * `kyberswap.swap.execute` — a PRE-SIGN gas-estimate revert must reach the
 * agent as a refusal, not as an ambiguous internal interruption.
 *
 * WHY THIS FILE EXISTS — live 2026-07-25, Base, native ETH → USDC, 2 hops
 * (`curve-stable-ng`, `pancake-infinity-cl`), default 50 bps. The pre-sign
 * `eth_estimateGas` reverted with `Return amount is not enough` because the
 * pool moved past the calldata's embedded `minReturnAmount` between build and
 * estimate. NOTHING was signed. The activity row was honest
 * (`definitively_failed`, `not attempted: …`), but the message handed to the
 * agent said the swap had been "interrupted after it was already recorded"
 * and to "check the record before taking any further action" — so an
 * autonomous agent, correctly following its own do-not-retry doctrine for an
 * ambiguous record, stopped permanently on a routine and fully recoverable
 * condition. The identical swap at 300 bps landed immediately afterwards
 * (`0x2475561bda43bc24cc1d9d8051265c73d71daf661ad7ee2446cd18c81fd6b8e6`,
 * 0.008 ETH → 14.95045 USDC).
 *
 * The pre-existing `DependentLegGasEstimateError` branch already said the
 * right thing, but it fires ONLY when a PRIOR leg of the same plan confirmed.
 * With no allowance leg in front (native input, or an allowance already
 * sufficient) `priorLeg` is `undefined` and `estimateGasForPlanLeg` rethrows
 * the raw node error, which fell into the generic catch. The distinction that
 * matters is whether WE BROADCAST, never whether an allowance leg existed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionRevertedError } from "viem";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");

const SESSION_EVM = {
  family: "eip155" as const,
  address: "0x1234567890AbcdEF1234567890aBcdef12345678" as `0x${string}`,
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
const mockFailActivityEvent = vi.fn().mockResolvedValue({ applied: true, row: {} });

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => mockCreateAgentActivityPreBroadcastFailure(...args),
  markActivityBroadcast: (...args: unknown[]) => mockMarkActivityBroadcast(...args),
  markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  confirmActivityEvent: (...args: unknown[]) => mockConfirmActivityEvent(...args),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
  abortPlannedEvents: (...args: unknown[]) => mockAbortPlannedEvents(...args),
}));

vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: vi.fn().mockResolvedValue({ inserted: true }),
}));

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
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import {
  approvedClaim,
  legsForAllowancePlan,
} from "../../../kyberswap/fixtures/route-build/approved-quote.js";

/**
 * The transaction set the claimed quote bound, kept in step with whatever this
 * suite's allowance mock answers: since WP2-B an execute whose leg set is not
 * the approved one is refused, so `planAllowance` moves both together (a real
 * change of allowance would have come with a fresh quote).
 */
let approvedLegs = legsForAllowancePlan({ needsReset: false, needsApprove: false });
function planAllowance(plan: { needsReset: boolean; needsApprove: boolean }): void {
  mockPlanKyberAllowance.mockResolvedValue(plan);
  approvedLegs = legsForAllowancePlan(plan);
}
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import { KYBERSWAP_HANDLERS } from "../../../../vex-agent/tools/protocols/kyberswap/handlers.js";
import { DependentLegGasEstimateError } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { compliantSwapCalldata, compliantRoutePaths } from "../../../kyberswap/fixtures/route-build/compliant-swap-build.js";

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

const TOKEN_A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOKEN_B = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const COMPLIANT_CALLDATA = compliantSwapCalldata({
  srcToken: TOKEN_A, dstToken: TOKEN_B, dstReceiver: SESSION_EVM.address,
  amountIn: 10n ** 18n, quotedNetOutRaw: "999000", slippageBps: 50,
});

/** The EXACT reason the KyberSwap MetaAggregationRouterV2 returned on Base, 2026-07-25. */
const KYBER_SLIPPAGE_REVERT = "Return amount is not enough";

function revertedWith(reason: string): ExecutionRevertedError {
  return new ExecutionRevertedError({ message: `execution reverted: ${reason}` });
}

function execute(params: Record<string, unknown> = {}) {
  return KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
    { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1", ...params },
    ctx(),
  );
}

describe("kyberswap.swap.execute — pre-sign estimate revert (no prior leg)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
    mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
    }));
    mockGetHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
    // No allowance leg — the live shape. `priorLeg` is therefore `undefined`
    // and `estimateGasForPlanLeg` rethrows the node's raw revert.
    planAllowance({ needsReset: false, needsApprove: false });
    const routeResponse = {
      data: {
        routeSummary: {
          amountIn: "1000000", amountOut: "999000", gasUsd: "0.5", routeID: "r1", checksum: "c1",
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
        { legs: approvedLegs },
        ),
    );
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
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 214, events: [{ id: 100 }] });
    mockSignStageBroadcast.mockReset();
    mockMarkActivityBroadcast.mockReset();
    mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 100 } });
    mockDecodeKyberSwapSettlement.mockReset();
    mockDecodeKyberSwapSettlement.mockReturnValue(null);
    mockConfirmActivityEvent.mockReset();
    mockConfirmActivityEvent.mockResolvedValue({ applied: true, row: {} });
    mockFailActivityEvent.mockReset();
    mockFailActivityEvent.mockResolvedValue({ applied: true, row: {} });
  });

  it("reports not_attempted + retryable — never an interruption 'after it was already recorded'", async () => {
    mockSignStageBroadcast.mockRejectedValueOnce(revertedWith(KYBER_SLIPPAGE_REVERT));

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.data?.status).toBe("not_attempted");
    expect(result.data?.retryable).toBe(true);
    expect(result.data?._executionId).toBe(214);
    // The two phrases that stranded the live agent. Neither may ever return.
    expect(result.output).not.toMatch(/already recorded/i);
    expect(result.output).not.toMatch(/before taking any further action/i);
    expect(result.output).not.toMatch(/internal error/i);
  });

  it("states plainly that nothing was signed, so re-running cannot duplicate it", async () => {
    mockSignStageBroadcast.mockRejectedValueOnce(revertedWith(KYBER_SLIPPAGE_REVERT));

    const result = await execute();

    expect(result.output).toMatch(/nothing was signed/i);
    expect(result.output).toMatch(/cannot duplicate/i);
  });

  it("names the remedy BY PARAMETER NAME and quotes the tolerance actually applied", async () => {
    mockSignStageBroadcast.mockRejectedValueOnce(revertedWith(KYBER_SLIPPAGE_REVERT));

    const result = await execute({ slippageBps: 50 });

    expect(result.output).toContain("slippageBps");
    // Target quality is the messages already in the tree that quote numbers:
    // the tolerance this attempt used and the ceiling a retry may not exceed.
    expect(result.output).toContain("50");
    expect(result.output).toContain("1000");
    // The revert reason itself is evidence the agent needs, not noise.
    expect(result.output).toContain(KYBER_SLIPPAGE_REVERT);
  });

  it("records the refused leg as `slippage`, never the generic `unknown` bucket", async () => {
    mockSignStageBroadcast.mockRejectedValueOnce(revertedWith(KYBER_SLIPPAGE_REVERT));

    await execute();

    expect(mockFailActivityEvent).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ failureCode: "slippage" }),
    );
  });

  it("still finalizes every never-signed planned row (no row left permanently pending)", async () => {
    mockSignStageBroadcast.mockRejectedValueOnce(revertedWith(KYBER_SLIPPAGE_REVERT));

    await execute();

    expect(mockAbortPlannedEvents).toHaveBeenCalledWith(214, 0, expect.any(String));
    // C36: `abortPlannedEvents` owns the "not attempted:" prefix exclusively.
    expect(mockAbortPlannedEvents.mock.calls[0]![2]).not.toMatch(/^not attempted:/i);
    // C18: never a second execution.
    expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
  });

  it("a decoded revert with NO known remedy is still a pre-sign refusal, but invents no advice", async () => {
    mockSignStageBroadcast.mockRejectedValueOnce(revertedWith("SomeRouter: WEIRD_STATE"));

    const result = await execute();

    expect(result.data?.status).toBe("not_attempted");
    expect(result.data?.retryable).toBe(true);
    expect(result.output).toMatch(/nothing was signed/i);
    expect(result.output).toContain("SomeRouter: WEIRD_STATE");
    // No remedy is known for this string — it must not claim one.
    expect(result.output).not.toContain("slippageBps");
    expect(mockFailActivityEvent).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ failureCode: "simulation_reverted" }),
    );
  });

  it("an error carrying NO decoded revert reason keeps the generic branch (no false 'nothing was signed' claim)", async () => {
    // A DB/CAS/internal throw is genuinely not a chain refusal — the handler
    // must not start asserting pre-sign safety for errors it cannot place.
    mockSignStageBroadcast.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.data?.status).not.toBe("not_attempted");
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
  });
});

/**
 * Live session on Robinhood Chain (4663), 2026-07-30: `SwapExecute` failed
 * TWICE at the pre-sign gas estimate with the router revert `"Call failed"`.
 * Nothing was broadcast, the refusal itself told the agent to "try another
 * pair or venue" — and the agent was never pointed at the other venue, because
 * fired for a MINED revert (gas burned) but not for the strictly safer
 * pre-sign refusal of the same calldata.
 */
describe("kyberswap.swap.execute — a pre-sign refusal of the SWAP leg unlocks the fallback venue", () => {
  const FALLBACK_SENTENCE = "Uniswap is an alternative venue for this trade: quote it with SwapQuoteUniswap, then execute with SwapExecuteUniswap.";

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
    mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
    }));
    mockGetHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
    planAllowance({ needsReset: false, needsApprove: false });
    const routeResponse = {
      data: {
        routeSummary: {
          amountIn: "1000000", amountOut: "999000", gasUsd: "0.5", routeID: "r1", checksum: "c1",
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
        { legs: approvedLegs },
        ),
    );
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
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 216, events: [{ id: 100 }] });
    mockSignStageBroadcast.mockReset();
    mockMarkActivityBroadcast.mockReset();
    mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 100 } });
    mockFailActivityEvent.mockReset();
    mockFailActivityEvent.mockResolvedValue({ applied: true, row: {} });
  });

  it("the EXACT live shape — `Call failed`, nothing broadcast — names Uniswap and says so", async () => {
    mockSignStageBroadcast.mockRejectedValueOnce(revertedWith("Call failed"));

    const result = await execute();

    expect(result.output).toContain(FALLBACK_SENTENCE);
    // The refusal itself is unchanged — the sentence is appended, never a
    // replacement for the evidence and remedy the agent already relied on.
    expect(result.data?.status).toBe("not_attempted");
    expect(result.data?.retryable).toBe(true);
    expect(result.data?.failureCode).toBe("simulation_reverted");
    expect(result.output).toMatch(/nothing was signed or broadcast/i);
    expect(result.output).toContain("Call failed");
  });

  it("a PRICE-guard refusal does NOT name a second venue — a fresh quote at a higher tolerance can clear it", async () => {
    mockSignStageBroadcast.mockRejectedValueOnce(revertedWith(KYBER_SLIPPAGE_REVERT));

    const result = await execute({ slippageBps: 50 });

    expect(result.output).not.toContain(FALLBACK_SENTENCE);
    // ...and the price remedy it does give is untouched.
    expect(result.output).toContain("slippageBps");
  });

  it("an ALLOWANCE-leg refusal does NOT name a second venue — an approve failing is not venue evidence", async () => {
    planAllowance({ needsReset: false, needsApprove: true });
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 217, events: [{ id: 10 }, { id: 11 }] });
    // The FIRST leg (the approve) is the one the chain refuses.
    mockSignStageBroadcast.mockRejectedValueOnce(revertedWith("Call failed"));

    const result = await execute();

    expect(result.output).not.toContain(FALLBACK_SENTENCE);
    expect(result.output).toMatch(/the allowance step was refused before signing/i);
  });

  it("a leg whose hash was already STAGED never names a second venue — that is not a pre-sign refusal", async () => {
    mockSignStageBroadcast.mockImplementationOnce(async (_pub, _wallet, _params, hooks) => {
      await hooks.onHashStaged({ txHash: "0xswap", fromAddress: SESSION_EVM.address, nonce: 0 });
      throw revertedWith("Call failed");
    });

    const result = await execute();

    expect(result.output).not.toContain(FALLBACK_SENTENCE);
  });

  it("an error with no decoded revert reason never names a second venue — an unplaceable failure is not evidence", async () => {
    mockSignStageBroadcast.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const result = await execute();

    expect(result.output).not.toContain(FALLBACK_SENTENCE);
  });
});

describe("kyberswap.swap.execute — the genuinely-ambiguous paths are NOT collapsed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
    mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
    }));
    mockGetHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
    planAllowance({ needsReset: false, needsApprove: false });
    const routeResponse = {
      data: {
        routeSummary: {
          amountIn: "1000000", amountOut: "999000", gasUsd: "0.5", routeID: "r1", checksum: "c1",
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
        { legs: approvedLegs },
        ),
    );
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
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 214, events: [{ id: 100 }] });
    mockSignStageBroadcast.mockReset();
    mockMarkActivityBroadcast.mockReset();
    mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 100 } });
    mockDecodeKyberSwapSettlement.mockReset();
    mockDecodeKyberSwapSettlement.mockReturnValue(null);
    mockFailActivityEvent.mockReset();
    mockFailActivityEvent.mockResolvedValue({ applied: true, row: {} });
  });

  it("a BROADCAST whose outcome is unknown still tells the agent NOT to retry — pending, never not_attempted", async () => {
    // The expensively-won distinction: we sent bytes to the network and cannot
    // prove what happened to them. This must never inherit the new
    // "safe to re-run" framing.
    mockSignStageBroadcast.mockResolvedValueOnce({ kind: "ambiguous", txHash: "0xswap", stage: "send" });

    const result = await execute();

    expect(result.data?.status).toBe("pending");
    expect(result.data?.retryable).toBeUndefined();
    expect(result.output).toMatch(/do not retry/i);
    expect(result.output).not.toMatch(/nothing was signed/i);
  });

  it("a revert AFTER the hash was staged is never reported as 'nothing was signed'", async () => {
    // Signing already happened and `onHashStaged` ran, so this leg can no
    // longer claim pre-sign safety even though the thrown error carries a
    // decodable revert reason.
    mockSignStageBroadcast.mockImplementationOnce(async (_pub, _wallet, _params, hooks) => {
      await hooks.onHashStaged({ txHash: "0xswap", fromAddress: SESSION_EVM.address, nonce: 0 });
      throw revertedWith(KYBER_SLIPPAGE_REVERT);
    });

    const result = await execute();

    expect(result.data?.status).not.toBe("not_attempted");
    expect(result.output).not.toMatch(/nothing was signed/i);
  });
});

describe("kyberswap.swap.execute — the prior-leg (DependentLegGasEstimateError) branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
    mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
    }));
    mockGetHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
    // Allowance leg in front — `priorLeg` is set, so a failing estimate is
    // retried and surfaces as `DependentLegGasEstimateError`.
    planAllowance({ needsReset: false, needsApprove: true });
    const routeResponse = {
      data: {
        routeSummary: {
          amountIn: "1000000", amountOut: "999000", gasUsd: "0.5", routeID: "r1", checksum: "c1",
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
        { legs: approvedLegs },
        ),
    );
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
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 215, events: [{ id: 10 }, { id: 11 }] });
    mockSignStageBroadcast.mockReset();
    mockMarkActivityBroadcast.mockReset();
    mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 10 } });
    mockDecodeKyberSwapSettlement.mockReset();
    mockDecodeKyberSwapSettlement.mockReturnValue(null);
    mockConfirmActivityEvent.mockReset();
    mockConfirmActivityEvent.mockResolvedValue({ applied: true, row: {} });
    mockFailActivityEvent.mockReset();
    mockFailActivityEvent.mockResolvedValue({ applied: true, row: {} });
  });

  /** The approval leg confirms, then the swap leg's estimate fails every retry. */
  function allowanceThenExhaustedEstimate(reason: string) {
    mockSignStageBroadcast
      .mockResolvedValueOnce({ kind: "confirmed", txHash: "0xallow", receipt: { logs: [], blockNumber: 900n } })
      .mockRejectedValueOnce(new DependentLegGasEstimateError({
        attempts: 3,
        priorLegBlockNumber: 900n,
        observedHeadBlock: 902n,
        cause: revertedWith(reason),
      }));
  }

  it("an ALLOWANCE-shaped reason keeps the read-after-write wording, unchanged", async () => {
    // Doctrine (`dependent-leg-gas-estimate.ts`, live 2026-07-24/25): the node
    // reported `ERC20: transfer amount exceeds allowance` for a transaction
    // that was in fact fine, and an unchanged retry succeeded. This is that
    // exact case and it must keep its retry-then-stop message.
    allowanceThenExhaustedEstimate("ERC20: transfer amount exceeds allowance");

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.data?.status).toBe("not_attempted");
    expect(result.data?.retryable).toBe(true);
    expect(result.output).toMatch(/nothing was signed or broadcast/i);
    expect(result.output).toContain("900");
    expect(result.output).toMatch(/once more is reasonable/i);
    expect(result.output).toMatch(/do not keep retrying/i);
    // No remedy is provable here, so none may be named.
    expect(result.output).not.toContain("slippageBps");
  });

  it("does NOT classify an allowance reason's revert string — a lagging node's reason is not evidence", async () => {
    allowanceThenExhaustedEstimate("ERC20: transfer amount exceeds allowance");

    await execute();

    expect(mockFailActivityEvent).not.toHaveBeenCalledWith(
      11,
      expect.objectContaining({ failureCode: "allowance_or_balance" }),
    );
  });

  it("a POOL-STATE reason that survived every retry names slippageBps — the ERC-20-input case", async () => {
    // The common USDC→X shape: an allowance leg exists, so a genuine price-guard
    // refusal reaches the agent through this branch. Lag cannot manufacture it
    // (our approval does not touch reserves, and a lagging node reads them at an
    // EARLIER block), so the agent gets the actionable remedy instead of the
    // RPC-lag wording it cannot act on.
    allowanceThenExhaustedEstimate(KYBER_SLIPPAGE_REVERT);

    const result = await execute({ slippageBps: 50 });

    expect(result.data?.status).toBe("not_attempted");
    expect(result.data?.retryable).toBe(true);
    expect(result.data?.failureCode).toBe("slippage");
    expect(result.output).toContain("slippageBps");
    expect(result.output).toContain("50");
    expect(result.output).toContain("1000");
    expect(result.output).toContain(KYBER_SLIPPAGE_REVERT);
    expect(result.output).toMatch(/priceImpact/i);
    expect(result.output).toMatch(/nothing was signed or broadcast/i);
    // The lag hypothesis was already tested and failed — do not tell the agent
    // to re-run the identical request and then stop.
    expect(result.output).not.toMatch(/once more is reasonable/i);
  });

  it("the pool-state message still shows the retries and the confirmed prior leg's block", async () => {
    allowanceThenExhaustedEstimate(KYBER_SLIPPAGE_REVERT);

    const result = await execute();

    expect(result.output).toContain("900");
    expect(result.output).toContain("3");
  });

  it("never claims the swap leg was submitted, and never opens a second execution", async () => {
    allowanceThenExhaustedEstimate(KYBER_SLIPPAGE_REVERT);

    const result = await execute();

    expect(result.output).not.toMatch(/already recorded/i);
    expect(result.output).not.toMatch(/before taking any further action/i);
    expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
    expect(mockAbortPlannedEvents).toHaveBeenCalled();
  });
});
