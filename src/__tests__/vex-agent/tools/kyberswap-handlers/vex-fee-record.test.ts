/**
 * `kyberswap.swap.execute` — what the durable row records about VEX'S OWN FEE
 * (migration 050 Part 2).
 *
 * The fee Vex charges is taken inside the swap transaction, so it has no row of
 * its own the way a bridge fee does. Before these columns existed the only
 * trace was `usd_vex_fee_est`, an ESTIMATE that is NULL whenever no USD price
 * is available — indistinguishable, to the agent reading the row back, from
 * "Vex charged nothing".
 *
 * These tests pin the fix as behaviour, against the REAL captured
 * `/route/build` bytes (the calldata guard is not mocked, so the handler only
 * reaches the intent write if the actual decoder accepted actual provider
 * bytes):
 *
 *   - the swap leg records the exact amount, its token, and its decimals;
 *   - it records them even when the USD estimate is unavailable — the whole
 *     point of the column;
 *   - a leg that charges NO Vex fee (an allowance approve) leaves every fee
 *     column unset, so "all null" is a positive statement of "no fee".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAddress, formatUnits, type Hex } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import capture from "../../../kyberswap/fixtures/route-build/base-usdc-to-native-50bps.json" with { type: "json" };
import { compliantRoutePaths } from "../../../kyberswap/fixtures/route-build/compliant-swap-build.js";

const SESSION_EVM = {
  family: "eip155" as const,
  // Must equal the fixture's `recipient` — the guard asserts the build sends
  // the output to the wallet Vex approved.
  address: "0x1234567890AbcdEF1234567890aBcdef12345678",
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};

const mockResolveSelectedAddress = vi.fn((..._args: unknown[]) => SESSION_EVM.address);
const mockResolveSigningWallet = vi.fn((..._args: unknown[]) => SESSION_EVM);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (...args: unknown[]) => mockResolveSelectedAddress(...args),
  resolveSigningWallet: (...args: unknown[]) => mockResolveSigningWallet(...args),
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

const mockReadErc20Metadata = vi.fn(async (_slug: string, address: string) => ({
  address, symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false as const,
}));
const mockPlanKyberAllowance = vi.fn();
const mockSignStageBroadcast = vi.fn();
const mockDecodeKyberSwapSettlement = vi.fn(() => null as { amountInRaw: string; amountOutRaw: string } | null);

// Only the evm-utils BARREL is mocked; `evm/swap-calldata-guard.js` stays REAL,
// so the fee line in the captured calldata is genuinely verified before the
// handler records anything.
vi.mock("@tools/kyberswap/evm-utils.js", async () => ({
  ...(await import("./evm-client.test-fixtures.js")).kyberEvmClientMocks(),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: (...args: unknown[]) => mockPlanKyberAllowance(...args),
  buildApproveCalldata: vi.fn(() => "0xapprove"),
  signStageBroadcast: (...args: unknown[]) => mockSignStageBroadcast(...args),
  decodeKyberSwapSettlement: (...args: unknown[]) => mockDecodeKyberSwapSettlement(...(args as [])),
}));

vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    searchTokens: vi.fn().mockResolvedValue([]),
    getHoneypotFotInfo: vi.fn().mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 }),
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

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: vi.fn().mockResolvedValue({ executionId: 1, event: { id: 1 } }),
  markActivityBroadcast: vi.fn().mockResolvedValue({ applied: true, row: { id: 100 } }),
  markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  confirmActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  failActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  abortPlannedEvents: vi.fn().mockResolvedValue(undefined),
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
const mockCommitPrequoteClaim = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  commitPrequoteClaim: (...args: unknown[]) => mockCommitPrequoteClaim(...args),
  readSwapExecutionSnapshot: (...args: unknown[]) => mockClaim(...args),
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
import { KYBERSWAP_HANDLERS } from "@vex-agent/tools/protocols/kyberswap/handlers.js";
import { KYBERSWAP_FEE_BPS } from "@tools/kyberswap/constants.js";

const TOKEN_IN = getAddress(capture.request.tokenIn);
const TOKEN_OUT = capture.request.tokenOut;
const ROUTE_OUT = capture.routeSummary.amountOut;
/**
 * The captured `routeSummary` was trimmed to the two fields the harness needed
 * in 2026-07-25, so its paths are reconstructed here. A real summary always
 * carries them, and the pre-sign guard reads them to decide which pools the
 * build may fund.
 */
const ROUTE_PATHS = compliantRoutePaths({
  srcToken: TOKEN_IN, dstToken: TOKEN_OUT, amountIn: BigInt(capture.routeSummary.amountIn), quotedNetOutRaw: ROUTE_OUT,
});
/** 10 USDC at 6 decimals — matches the capture's `amountIn` of 10000000. */
const AMOUNT_IN_HUMAN = "10";
const AMOUNT_IN_RAW = BigInt(capture.routeSummary.amountIn);
/** 25 bps of 10 USDC = 0.025 USDC = 25000 atomic units at 6 decimals. */
const EXPECTED_FEE_RAW = (AMOUNT_IN_RAW * BigInt(KYBERSWAP_FEE_BPS)) / 10_000n;

interface RecordedVexFee {
  tokenAddress: string;
  tokenSymbol?: string;
  tokenDecimals: number;
  amountRaw: string;
  amountHuman: string;
}

interface RecordedEvent {
  eventRole: string;
  vexFee?: RecordedVexFee;
  usdVexFeeEst?: string;
}

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
  };
}

function execute(params: Record<string, unknown> = {}) {
  return KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
    { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT_IN_HUMAN, ...params },
    ctx(),
  );
}

function buildResponse(over: Record<string, unknown> = {}) {
  return {
    data: {
      routerAddress: capture.routerAddress,
      data: capture.build.data as Hex,
      // The provider's own gas figure for the swap leg. MEASURED live on Base
      // 2026-08-31: `/route/build` answered `gas: "287581"` for a real USDC route.
      gas: "287581",
      transactionValue: capture.build.transactionValue,
      amountIn: capture.build.amountIn,
      amountOut: capture.build.amountOut,
      amountInUsd: "10", amountOutUsd: "10", gasUsd: "0.01",
      ...over,
    },
  };
}

/** The event rows the handler asked the repo to create, in plan order. */
function recordedEvents(): RecordedEvent[] {
  expect(mockCreateAgentActivityIntent).toHaveBeenCalledTimes(1);
  const call = mockCreateAgentActivityIntent.mock.calls[0]![0] as { events: RecordedEvent[] };
  return call.events;
}

function swapLeg(): RecordedEvent {
  const leg = recordedEvents().find((e) => e.eventRole === "swap");
  expect(leg).toBeDefined();
  return leg!;
}

describe("kyberswap.swap.execute — the Vex fee recorded as a token amount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
    mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false as const,
    }));
    planAllowance({ needsReset: false, needsApprove: false });
    const routeResponse = {
      data: {
        routeSummary: {
          amountIn: capture.routeSummary.amountIn,
          amountOut: ROUTE_OUT,
          gasUsd: "0.01", routeID: "r1", checksum: "c1",
          route: ROUTE_PATHS,
        },
        routerAddress: capture.routerAddress,
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
    mockBuildRoute.mockResolvedValue(buildResponse());
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 100 }, { id: 101 }] });
    mockSignStageBroadcast.mockResolvedValue({ kind: "confirmed", txHash: "0xswap", receipt: { logs: [] } });
    mockDecodeKyberSwapSettlement.mockReturnValue({
      amountInRaw: capture.routeSummary.amountIn,
      amountOutRaw: capture.build.amountOut,
    });
    mockCommitPrequoteClaim.mockResolvedValue({ ok: true });
  });

  it("records the exact fee the router keeps, with its token and decimals", async () => {
    const result = await execute();
    expect(result.success).toBe(true);

    const { vexFee } = swapLeg();
    expect(vexFee).toEqual({
      tokenAddress: TOKEN_IN,
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      amountRaw: EXPECTED_FEE_RAW.toString(),
      amountHuman: formatUnits(EXPECTED_FEE_RAW, 6),
    });
    // Stated absolutely, not just relative to the constant: 25 bps of 10 USDC.
    expect(vexFee!.amountRaw).toBe("25000");
    expect(vexFee!.amountHuman).toBe("0.025");
  });

  it("the recorded fee is a COMPONENT of the input amount, never an extra debit", async () => {
    await execute();

    const leg = swapLeg() as RecordedEvent & { tokenIn: { amountRaw: string } };
    // The user is debited `amountIn`; the router keeps the fee out of it and
    // swaps the rest. Adding the two would double-count the fee.
    expect(BigInt(leg.vexFee!.amountRaw)).toBeLessThan(BigInt(leg.tokenIn.amountRaw));
    expect(leg.tokenIn.amountRaw).toBe(AMOUNT_IN_RAW.toString());
  });

  it("records the fee amount even when NO USD estimate can be derived", async () => {
    // The provider returned an unusable input-side USD figure, so the USD
    // estimate is impossible. The fee itself is still a known fact.
    mockBuildRoute.mockResolvedValue(buildResponse({ amountInUsd: "" }));

    const result = await execute();
    expect(result.success).toBe(true);

    const leg = swapLeg();
    expect(leg.usdVexFeeEst).toBeUndefined();
    expect(leg.vexFee?.amountRaw).toBe("25000");
    expect(leg.vexFee?.tokenDecimals).toBe(6);
  });

  it("leaves every fee field unset on an allowance leg, which charges no Vex fee", async () => {
    planAllowance({ needsReset: true, needsApprove: true });

    await execute();

    const events = recordedEvents();
    const allowanceLegs = events.filter((e) => e.eventRole.startsWith("allowance"));
    expect(allowanceLegs).toHaveLength(2);
    for (const leg of allowanceLegs) {
      expect(leg.vexFee).toBeUndefined();
      expect(leg.usdVexFeeEst).toBeUndefined();
    }
    // ...while the swap leg in the SAME execution still carries the fee, so the
    // difference is a real signal and not a blanket omission.
    expect(swapLeg().vexFee?.amountRaw).toBe("25000");
  });
});

/**
 * The same fee, checked against the statement the human approved, before the
 * intent row exists and long before Phase B signs anything.
 *
 * On this venue equality holds BY CONSTRUCTION: the calldata guard (REAL in
 * this suite) has already refused to continue unless the decoded description
 * carries `desc.amount == amountIn` and `feeAmounts == [KYBERSWAP_FEE_BPS]` with
 * the pinned receiver, and the row's block was stated at quote time from the
 * same arithmetic over the same amount. So the assertion below can only fail
 * when the row and the guard disagree, which is a Vex defect - and the refusal
 * says exactly that, rather than blaming the market.
 *
 * "Before signing" is proved by `mockCreateAgentActivityIntent`: Phase A creates
 * the intent as its LAST statement and every signature in Phase B is recorded
 * against it, so a refusal that never reached the intent write never reached a
 * key either.
 */
describe("kyberswap.swap.execute - the approved Vex fee statement is re-checked before signing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
    mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false as const,
    }));
    planAllowance({ needsReset: false, needsApprove: false });
    mockGetRoute.mockResolvedValue({
      data: {
        routeSummary: {
          amountIn: capture.routeSummary.amountIn,
          amountOut: ROUTE_OUT,
          gasUsd: "0.01", routeID: "r1", checksum: "c1",
          route: ROUTE_PATHS,
        },
        routerAddress: capture.routerAddress,
      },
    });
    mockBuildRoute.mockResolvedValue(buildResponse());
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 100 }, { id: 101 }] });
    mockSignStageBroadcast.mockResolvedValue({ kind: "confirmed", txHash: "0xswap", receipt: { logs: [] } });
    mockDecodeKyberSwapSettlement.mockReturnValue({
      amountInRaw: capture.routeSummary.amountIn,
      amountOutRaw: capture.build.amountOut,
    });
    mockCommitPrequoteClaim.mockResolvedValue({ ok: true });
  });

  /** The claim the store hands back, carrying `vexFee` for `amountInRaw`. */
  function claimStating(amountInRaw: bigint): void {
    mockClaim.mockImplementation(
      async (_toolId: unknown, _sessionId: unknown, params: Record<string, unknown>) =>
        approvedClaim(
          {
            amountIn: capture.routeSummary.amountIn,
            amountOut: ROUTE_OUT,
            gasUsd: "0.01", routeID: "r1", checksum: "c1",
            route: ROUTE_PATHS,
          },
          typeof params.slippageBps === "number" ? params.slippageBps : VEX_DEFAULT_SLIPPAGE_BPS,
          { legs: approvedLegs, amountInRaw },
        ),
    );
  }

  it("executes when the row's statement is the fee this build will take", async () => {
    claimStating(AMOUNT_IN_RAW);

    const result = await execute();

    expect(result.success, `handler output: ${result.output}`).toBe(true);
    expect(swapLeg().vexFee?.amountRaw).toBe(EXPECTED_FEE_RAW.toString());
  });

  it("refuses before signing when the row states a different fee amount", async () => {
    // A row stating the fee for TWICE this trade's input: the amount the router
    // will actually keep is half what the card said. Nothing about the market
    // can produce this, which is what the refusal tells the agent.
    claimStating(AMOUNT_IN_RAW * 2n);

    const result = await execute();

    expect(result.success).toBe(false);
    // Phase A never reached its last statement, so no execution was opened and
    // Phase B never ran.
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockSignStageBroadcast).not.toHaveBeenCalled();
    expect(result.output).toContain("Refused before signing");
    expect(result.output).toContain("the Vex fee amount");
    expect(result.output).toContain("cannot happen on this venue");
  });

  it("fails closed when the claimed row carries no fee statement at all", async () => {
    mockClaim.mockImplementation(
      async (_toolId: unknown, _sessionId: unknown, params: Record<string, unknown>) => {
        const claim = approvedClaim(
          {
            amountIn: capture.routeSummary.amountIn,
            amountOut: ROUTE_OUT,
            gasUsd: "0.01", routeID: "r1", checksum: "c1",
            route: ROUTE_PATHS,
          },
          typeof params.slippageBps === "number" ? params.slippageBps : VEX_DEFAULT_SLIPPAGE_BPS,
          { legs: approvedLegs, amountInRaw: AMOUNT_IN_RAW },
        );
        // The gate refuses a fee-bearing execute on a row in this state, so
        // reaching the executor means it was bypassed. It signs nothing anyway.
        return { ...claim, vexFee: undefined };
      },
    );

    const result = await execute();

    expect(result.success).toBe(false);
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockSignStageBroadcast).not.toHaveBeenCalled();
    expect(result.output).toContain("the approved quote states no Vex fee at all");
  });
});

/**
 * Read, compare, THEN claim.
 *
 * KyberSwap used to claim the approved row in the handler, before Phase A had
 * fetched the build, run the calldata guard or compared the fee statement. Every
 * refusal in this phase therefore spent the quote, and the retry those refusals
 * instruct the agent to make got `already_claimed`. The claim is now the last
 * thing Phase A does that writes anything - after the guard, the fee comparison
 * and the debit-plan comparison, immediately before the durable intent.
 */
describe("kyberswap.swap.execute - a refused execute leaves the approved quote unconsumed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
    mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false as const,
    }));
    planAllowance({ needsReset: false, needsApprove: false });
    mockGetRoute.mockResolvedValue({
      data: {
        routeSummary: {
          amountIn: capture.routeSummary.amountIn,
          amountOut: ROUTE_OUT,
          gasUsd: "0.01", routeID: "r1", checksum: "c1",
          route: ROUTE_PATHS,
        },
        routerAddress: capture.routerAddress,
      },
    });
    mockBuildRoute.mockResolvedValue(buildResponse());
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 100 }, { id: 101 }] });
    mockSignStageBroadcast.mockResolvedValue({ kind: "confirmed", txHash: "0xswap", receipt: { logs: [] } });
    mockDecodeKyberSwapSettlement.mockReturnValue({
      amountInRaw: capture.routeSummary.amountIn,
      amountOutRaw: capture.build.amountOut,
    });
    mockCommitPrequoteClaim.mockResolvedValue({ ok: true });
    claimFor(AMOUNT_IN_RAW);
  });

  /** The row the store hands back, stating the fee for `amountInRaw`. */
  function claimFor(amountInRaw: bigint): void {
    mockClaim.mockImplementation(
      async (_toolId: unknown, _sessionId: unknown, params: Record<string, unknown>) =>
        approvedClaim(
          {
            amountIn: capture.routeSummary.amountIn,
            amountOut: ROUTE_OUT,
            gasUsd: "0.01", routeID: "r1", checksum: "c1",
            route: ROUTE_PATHS,
          },
          typeof params.slippageBps === "number" ? params.slippageBps : VEX_DEFAULT_SLIPPAGE_BPS,
          { legs: approvedLegs, amountInRaw },
        ),
    );
  }

  it("does not claim the row when the fee statement disagrees with the build", async () => {
    claimFor(AMOUNT_IN_RAW * 2n);

    const result = await execute();

    expect(result.success).toBe(false);
    expect(mockCommitPrequoteClaim).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockSignStageBroadcast).not.toHaveBeenCalled();
  });

  it("does not claim the row when the build itself is refused", async () => {
    // A build whose router is not the one Vex verified: the calldata guard (real
    // in this suite) refuses it. The quote must survive that refusal too.
    mockBuildRoute.mockResolvedValue(buildResponse({ data: "0xdeadbeef" }));

    const result = await execute();

    expect(result.success).toBe(false);
    expect(mockCommitPrequoteClaim).not.toHaveBeenCalled();
  });

  it("claims the row that was read, once, immediately before the intent", async () => {
    const result = await execute();

    expect(result.success, `handler output: ${result.output}`).toBe(true);
    expect(mockCommitPrequoteClaim).toHaveBeenCalledTimes(1);
    const [ticket, claimedBy] = mockCommitPrequoteClaim.mock.calls[0] as [{ prequoteId: string }, string];
    expect(ticket.prequoteId).toBe("prequote-fixture");
    expect(claimedBy).toContain("kyberswap.swap.execute");
    // The order is the contract: the claim writes, then the intent.
    const [claimOrder] = mockCommitPrequoteClaim.mock.invocationCallOrder;
    const [intentOrder] = mockCreateAgentActivityIntent.mock.invocationCallOrder;
    if (claimOrder === undefined || intentOrder === undefined) {
      throw new Error("both the claim and the intent write must have been called");
    }
    expect(claimOrder).toBeLessThan(intentOrder);
  });

  it("refuses without signing when a concurrent execute won the same row", async () => {
    mockCommitPrequoteClaim.mockResolvedValue({
      ok: false,
      refusal: { kind: "already_claimed", message: "Refused before signing: this quote has already been claimed." },
    });

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.output).toContain("already been claimed");
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockSignStageBroadcast).not.toHaveBeenCalled();
  });

  /**
   * The typed reason must reach the RESULT, not only the log line. KyberSwap
   * throws its refusal out of Phase A, so the reason travels on the thrown
   * `VexFeeStatementRefusal` and is merged into the result's data by the
   * pre-broadcast recorder.
   */
  it("carries the typed fee reason on the tool result", async () => {
    claimFor(AMOUNT_IN_RAW * 2n);

    const result = await execute();

    const refusal = (result.data as Record<string, unknown>)._vexFeeRefusal as Record<string, unknown>;
    expect(refusal.reason).toBe("vex_fee_statement_changed");
    expect(refusal.movedFields).toContain("feeAmountRaw");
    expect(String(refusal.remediation)).toContain("kyberswap__swap_quote");
    expect(JSON.stringify(refusal)).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  /**
   * PIN, DO NOT RE-DERIVE (fixed decision 2026-09-04, recorded beside
   * `vexFeePreviewSchema`).
   *
   * KyberSwap has no separate fee leg at all: the fee is inside the router
   * calldata the pre-sign guard accepted, so the amount that is signed cannot
   * differ from the compared statement by construction, and nothing after the
   * comparison can raise it. What is signed is the build response's own bytes.
   */
  it("signs the build's bytes, with the fee inside them and nothing re-derived", async () => {
    const result = await execute();
    expect(result.success, `handler output: ${result.output}`).toBe(true);

    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(1);
    const signedCall = mockSignStageBroadcast.mock.calls[0];
    if (signedCall === undefined) throw new Error("the swap leg must have been signed");
    const request = signedCall[2] as { readonly to: string; readonly data: string };
    expect(request.data).toBe(capture.build.data);
    expect(request.to.toLowerCase()).toBe(getAddress(capture.routerAddress).toLowerCase());
    // The fee the row recorded is the router's own arithmetic over the amount
    // the guard pinned, and the disclosure says it is taken inside the route.
    expect(swapLeg().vexFee?.amountRaw).toBe(EXPECTED_FEE_RAW.toString());
  });
});
