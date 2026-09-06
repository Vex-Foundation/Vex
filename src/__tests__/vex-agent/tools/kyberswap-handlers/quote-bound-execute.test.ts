/**
 * `kyberswap.swap.execute` is bound to the quote the agent was shown.
 *
 * ## The incident this file reproduces
 *
 * 2026-08-27: a quote showed 313,879.7 CCF at 500 bps; the CONFIRMED fill was
 * 1,190.145 CCF - 263x worse - and nothing reverted. The cause was not a bad
 * guard: the guard passed. The execute RE-QUOTED at broadcast time and derived
 * the price floor from the FRESH route (`execute-plan.ts:133` at the time), so
 * the floor moved with the market instead of bounding it. A build honestly
 * reflecting a 263x-worse route carried a floor 263x lower, satisfied the
 * comparison, and signed.
 *
 * The reproducer below is written so it FAILS on that old logic: `oldFloor`
 * (the floor a fresh-route rederivation produces) is asserted to ACCEPT the
 * very calldata the new approved-quote floor REFUSES. If the handler ever goes
 * back to deriving from a fresh route, the refusal assertion breaks.
 *
 * ## What must keep working
 *
 * Owner constraint (2026-08-28): "safe, and it has to keep working". There is
 * no zero-tolerance comparison here - a market that moved WITHIN the approved
 * slippage still signs, which is the second test - and every refusal is typed
 * and recoverable by requesting a fresh quote.
 *
 * The calldata guard and the floor arithmetic are REAL throughout; only the
 * provider, the wallet, the DB and the signer are mocked. "Refused" therefore
 * means the actual decoder rejected actual encoded bytes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, type Hex } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { FinalSignedRequest } from "@tools/evm-chains/staged-broadcast.js";

import capture from "../../../kyberswap/fixtures/route-build/base-usdc-to-native-50bps.json" with { type: "json" };
import { compliantRoutePaths } from "../../../kyberswap/fixtures/route-build/compliant-swap-build.js";
import { fixtureVexFeeBlock } from "../../../kyberswap/fixtures/route-build/approved-quote.js";

const SESSION_EVM = {
  family: "eip155" as const,
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

const mockSignStageBroadcast = vi.fn();

vi.mock("@tools/kyberswap/evm-utils.js", async () => ({
  ...(await import("./evm-client.test-fixtures.js")).kyberEvmClientMocks(),
  readErc20Metadata: vi.fn(async (_slug: string, address: string) => ({
    address, symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false as const,
  })),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: vi.fn().mockResolvedValue({ needsReset: false, needsApprove: false }),
  buildApproveCalldata: vi.fn(() => "0xapprove"),
  signStageBroadcast: (...args: unknown[]) => mockSignStageBroadcast(...args),
  decodeKyberSwapSettlement: vi.fn(() => ({ amountInRaw: "10000000", amountOutRaw: capture.build.amountOut })),
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
const mockCreateAgentActivityPreBroadcastFailure = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => mockCreateAgentActivityPreBroadcastFailure(...args),
  markActivityBroadcast: vi.fn().mockResolvedValue({ applied: true, row: { id: 100 } }),
  markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  confirmActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  failActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  abortPlannedEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: vi.fn().mockResolvedValue({ inserted: true }),
}));

// The CLAIM is the seam: its DB half is exercised against real Postgres in
// `integration/repos/swap-prequotes-claim.int.test.ts`. Here it stands in for
// "the store handed the execute this approved quote", so the tests can drive
// the floor and the refusal wording through the real handler.
const mockClaim = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  commitPrequoteClaim: vi.fn(async () => ({ ok: true })),
  readSwapExecutionSnapshot: (...args: unknown[]) => mockClaim(...args),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { KYBERSWAP_HANDLERS } from "@vex-agent/tools/protocols/kyberswap/handlers.js";
import { META_AGGREGATION_ROUTER_V2_SWAP_ABI } from "@tools/kyberswap/evm/swap-calldata-guard.js";
import {
  computeApprovedMinOut,
  KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW,
} from "@tools/kyberswap/swap-price-floor.js";
import { snapshotRefusal } from "@vex-agent/tools/protocols/quote-authority/restore.js";
import {
  ROUTE_SNAPSHOT_VERSION,
  encodeRouteSnapshotRaw,
  sealRouteSnapshot,
} from "@vex-agent/tools/protocols/quote-authority/snapshot.js";
import { buildBoundDebitPlan } from "@vex-agent/tools/protocols/quote-authority/debit-plan.js";

/**
 * The transaction set this suite's quote bound, matching the allowance plan its
 * own mocks produce - the execute refuses a set that is not the approved one
 * (WP2-B). The ceiling is high enough that no prepared request here is above it;
 * the ceiling itself is the subject of its own suite.
 */
const APPROVED_PLAN = buildBoundDebitPlan({
  legs: [{ role: "swap" as const, pricing: "measured" as const }],
  feeCap: { mode: "eip1559", maxFeePerGasWei: 10n ** 15n, maxPriorityFeePerGasWei: 10n ** 15n },
});

const TOKEN_IN = getAddress(capture.request.tokenIn);
const TOKEN_OUT = capture.request.tokenOut;
/** The output the AGENT WAS SHOWN. Everything in this file is bound to it. */
const QUOTED_OUT = capture.routeSummary.amountOut;
const ROUTE_PATHS = compliantRoutePaths({
  srcToken: TOKEN_IN, dstToken: TOKEN_OUT,
  amountIn: BigInt(capture.routeSummary.amountIn), quotedNetOutRaw: QUOTED_OUT,
});
const AMOUNT_IN_HUMAN = "10";
const SLIPPAGE_BPS = 50;

function approvedRouteSummary(amountOut: string = QUOTED_OUT) {
  return {
    amountIn: capture.routeSummary.amountIn,
    amountOut,
    amountInUsd: "10", amountOutUsd: "9.99",
    // Present as the provider sends it: a raw summary carries `l1FeeUsd` as a
    // string on the L2s that charge one and omits it elsewhere. It is never
    // null on the wire, and the snapshot stores the provider's own bytes.
    gasUsd: "0.01", l1FeeUsd: "0.0000019", routeID: "r1", checksum: "c1",
    route: ROUTE_PATHS,
  };
}

/** The claim result the store would hand back for a quote of `amountOut`. */
function claimedSnapshot(amountOut: string = QUOTED_OUT, slippageBps = SLIPPAGE_BPS) {
  const summary = approvedRouteSummary(amountOut);
  const encoded = encodeRouteSnapshotRaw(summary);
  if (!encoded.ok) throw new Error("fixture route must encode");

  return {
    ok: true as const,
    prequoteId: "prequote-incident",
    // The Vex fee statement the row carries. The execute re-derives its own and
    // refuses before signing if the two disagree, so a claim without one is a
    // claim no fee-bearing execute may run on.
    vexFee: fixtureVexFeeBlock(BigInt(capture.routeSummary.amountIn)),
    routeSummary: summary,
    snapshot: sealRouteSnapshot({
      v: ROUTE_SNAPSHOT_VERSION,
      provider: "kyberswap" as const,
      raw: encoded.raw,
      approvedAmountOutRaw: amountOut,
      approvedMinOutRaw: computeApprovedMinOut(amountOut, slippageBps).toString(),
      approvedAmountOutHuman: "0.005376",
      approvedMinOutHuman: "0.005349",
      tokenOutSymbol: "NATIVE (ETH)",
      effectiveSlippageBps: slippageBps,
      expiresAt: "2026-08-28T10:00:00.000Z",
      eligibility: { kind: "executable" as const, priceImpactFraction: 0.001, adverse: false },
      debitPlan: APPROVED_PLAN,
    }),
  };
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

/**
 * Resolved once, with a real check: an absent handler is a registry bug, and a
 * non-null assertion here would report it as an unrelated call-of-undefined
 * inside whichever test ran first.
 */
const EXECUTE_HANDLER = KYBERSWAP_HANDLERS["kyberswap.swap.execute"];
if (EXECUTE_HANDLER === undefined) throw new Error("kyberswap.swap.execute is not registered");

function execute(params: Record<string, unknown> = {}) {
  return EXECUTE_HANDLER(
    { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT_IN_HUMAN, slippageBps: SLIPPAGE_BPS, ...params },
    ctx(),
  );
}

type SwapExecution = ReturnType<typeof decodeSwapCapture>;
type SwapDescription = SwapExecution["desc"];

/** Decode the captured build through the REAL router ABI, fully typed. */
function decodeSwapCapture() {
  const decoded = decodeFunctionData({
    abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI,
    data: capture.build.data as Hex,
  });
  if (decoded.functionName !== "swap") {
    throw new Error(`capture is not a swap call: ${decoded.functionName}`);
  }
  return decoded.args[0];
}

/**
 * Re-encode the captured build with one patched `SwapDescriptionV2` field.
 *
 * Typed against the ABI rather than cast through `unknown`, so a patch naming a
 * field the struct does not have is a compile error instead of calldata that
 * silently drops it.
 */
function patchedCalldata(patch: Partial<SwapDescription>): Hex {
  const execution = decodeSwapCapture();
  return encodeFunctionData({
    abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI,
    functionName: "swap",
    args: [{ ...execution, desc: { ...execution.desc, ...patch } }],
  });
}

/** Narrow an optional to a value, failing the test with a named reason instead of assuming. */
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`test expected ${what} to be present`);
  return value;
}

function buildResponse(calldata: Hex = capture.build.data as Hex, amountOut = capture.build.amountOut) {
  return {
    data: {
      routerAddress: capture.routerAddress,
      data: calldata,
      // The provider's own gas figure for the swap leg. MEASURED live on Base
      // 2026-08-31: `/route/build` answered `gas: "287581"` for a real USDC route.
      gas: "287581",
      transactionValue: capture.build.transactionValue,
      amountIn: capture.build.amountIn,
      amountOut,
      amountInUsd: "10", amountOutUsd: "10", gasUsd: "0.01",
    },
  };
}

/**
 * The swap leg's pre-sign gate, as the staged broadcast would call it.
 *
 * Reached through the recorded `signStageBroadcast` call rather than reimported,
 * so what is exercised is the hook the handler actually installed. Every leg now
 * carries one - the spendability half runs on all of them - and the calldata
 * assertion inside it applies only to the swap; the claims in this file are
 * about the swap leg, which is the only one these fixtures plan.
 */
function swapPreSignGate(): (request: FinalSignedRequest) => Promise<void> {
  const hooks = required(mockSignStageBroadcast.mock.calls[0], "a staged broadcast")[3] as {
    onBeforeSign?: (request: FinalSignedRequest) => Promise<void>;
  };
  return required(hooks.onBeforeSign, "an onBeforeSign pre-sign gate on the swap leg");
}

/**
 * The request `prepareTransactionRequest` would return for the captured build,
 * with any field a test wants to alter.
 *
 * The gate's whole subject is this object: the caller asks for one transaction
 * and signs whatever preparation returns, so a test that alters a field here is
 * simulating exactly the substitution the gate exists to catch.
 */
function finalRequest(patch: Partial<FinalSignedRequest> = {}): FinalSignedRequest {
  return {
    to: getAddress(capture.routerAddress),
    data: capture.build.data as Hex,
    value: BigInt(capture.build.transactionValue),
    gas: 300_000n,
    nonce: 3,
    // The prices the request REALLY carries - the pre-sign spendability gate
    // computes the debit from these and refuses a request that names none, so a
    // fixture without them would be a transaction no node ever produces.
    // MEASURED on Base 2026-08-31: base fee 5,000,000 wei, priority 1,210,000.
    gasPrice: undefined,
    maxFeePerGas: 11_210_000n,
    maxPriorityFeePerGas: 1_210_000n,
    ...patch,
  };
}

function expectNothingSigned() {
  expect(mockSignStageBroadcast).not.toHaveBeenCalled();
  expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
  mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
  mockClaim.mockResolvedValue(claimedSnapshot());
  mockBuildRoute.mockResolvedValue(buildResponse());
  mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 100 }] });
  mockCreateAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 7, event: { id: 7 } });
  mockSignStageBroadcast.mockResolvedValue({ kind: "confirmed", txHash: "0xswap", receipt: { logs: [] } });
});

describe("the 2026-08-27 incident cannot happen again", () => {
  it("REPRODUCER: quoted X, market at X/263 - refused, and the OLD fresh-route floor would have signed it", async () => {
    // The market has collapsed by the incident's own factor since the quote.
    // The build is HONEST about it: KyberSwap derives the calldata floor from
    // whatever route it is handed (measured), so a 263x-worse route yields a
    // 263x-lower floor, and the whole point is that this is not a tampered
    // build - it is a truthful build of a route nobody approved.
    const movedOut = (BigInt(QUOTED_OUT) / 263n).toString();
    const movedFloor = computeApprovedMinOut(movedOut, SLIPPAGE_BPS);
    mockBuildRoute.mockResolvedValue(
      buildResponse(patchedCalldata({ minReturnAmount: movedFloor }), movedOut),
    );

    // THE CHARACTERIZATION, asserted rather than asserted-about: under the
    // deleted logic the floor came from the FRESH route, which is exactly
    // `movedOut`, so the comparison the guard performs would have PASSED.
    const oldFreshRouteFloor = computeApprovedMinOut(movedOut, SLIPPAGE_BPS);
    expect(movedFloor + KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW).toBeGreaterThanOrEqual(oldFreshRouteFloor);

    // And under the approved-quote floor it fails, by a factor of 263.
    const approvedFloor = computeApprovedMinOut(QUOTED_OUT, SLIPPAGE_BPS);
    expect(movedFloor + KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW).toBeLessThan(approvedFloor);

    const result = await execute();

    expect(result.success).toBe(false);
    expectNothingSigned();
    expect(result.output).toContain("Refused before signing");
    const failure = required(
      mockCreateAgentActivityPreBroadcastFailure.mock.calls[0],
      "a recorded pre-broadcast failure",
    )[0] as { event: { failureCode: string } };
    expect(failure.event.failureCode).toBe("slippage");
  });

  it("the execute NEVER re-quotes - no route fetch happens at all", async () => {
    await execute();
    expect(mockGetRoute).not.toHaveBeenCalled();
  });

  it("builds from the APPROVED route summary and the APPROVED tolerance, never an omitted one", async () => {
    await execute();
    const body = required(mockBuildRoute.mock.calls[0], "a build request")[1] as {
      routeSummary: { amountOut: string };
      slippageTolerance: number;
    };
    expect(body.routeSummary.amountOut).toBe(QUOTED_OUT);
    // MEASURED: an omitted slippageTolerance defaults to 0 at KyberSwap, which
    // builds calldata that reverts on any movement at all.
    expect(body.slippageTolerance).toBe(SLIPPAGE_BPS);
  });

  it("a market that moved WITHIN the approved slippage still signs - refusals are not a dead end", async () => {
    // 20 bps against the user, inside the 50 bps the human authorized.
    const movedOut = ((BigInt(QUOTED_OUT) * 9980n) / 10000n).toString();
    mockBuildRoute.mockResolvedValue(
      buildResponse(patchedCalldata({ minReturnAmount: computeApprovedMinOut(QUOTED_OUT, SLIPPAGE_BPS) }), movedOut),
    );

    const result = await execute();

    expect(result.success).toBe(true);
    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(1);
  });

  it("re-asserts the floor immediately before the SWAP signature, not only at plan time", async () => {
    await execute();
    // The pure re-run must accept the transaction the plan already accepted.
    await expect(swapPreSignGate()(finalRequest())).resolves.toBeUndefined();
  });

  it("records the approved floor on the activity row's route provenance, without touching an attested field", async () => {
    await execute();
    const created = required(mockCreateAgentActivityIntent.mock.calls[0], "a created intent")[0] as {
      events: readonly { eventRole: string; routeProvenance?: Record<string, unknown>; tokenOut?: { amountRaw: string } }[];
    };
    const swapEvent = required(created.events.find((e) => e.eventRole === "swap"), "a swap event");
    expect(swapEvent.routeProvenance?.approvedMinOutRaw).toBe(
      computeApprovedMinOut(QUOTED_OUT, SLIPPAGE_BPS).toString(),
    );
    // The attested output keeps its wire meaning: the BUILD response amountOut.
    expect(swapEvent.tokenOut?.amountRaw).toBe(capture.build.amountOut);
  });
});

/**
 * The gate's subject is the FINAL PREPARED REQUEST.
 *
 * `prepareTransactionRequest` returns the object that is serialized, and it is
 * not required to be the object the caller passed in. A gate that re-ran the
 * guard over the captured build response proved only that a value in memory had
 * not changed - the bytes could still have been anything. Each case below alters
 * one field of the final request and asserts the gate refuses it; the control
 * case proves an honest request still signs, so this is a binding and not a
 * blanket refusal.
 */
describe("the pre-sign gate validates the transaction that will be signed", () => {
  it("refuses a target that is not the strict router", async () => {
    await execute();
    await expect(
      swapPreSignGate()(finalRequest({ to: "0x1111111111111111111111111111111111111111" })),
    ).rejects.toThrow("Refused at signing");
  });

  it("refuses calldata whose floor is below the approved floor", async () => {
    await execute();
    const approvedFloor = computeApprovedMinOut(QUOTED_OUT, SLIPPAGE_BPS);
    const lowered = patchedCalldata({
      minReturnAmount: approvedFloor - KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW - 1n,
    });

    await expect(
      swapPreSignGate()(finalRequest({ data: lowered })),
    ).rejects.toThrow("Refused at signing");
  });

  it("refuses native value the approved transaction does not attach", async () => {
    await execute();
    // The captured trade sells an ERC-20, so the approved value is zero and any
    // attached wei is native funds nobody agreed to spend.
    expect(BigInt(capture.build.transactionValue)).toBe(0n);

    await expect(
      swapPreSignGate()(finalRequest({ value: 1n })),
    ).rejects.toThrow("Refused at signing");
  });

  it("refuses a request carrying no calldata at all", async () => {
    await execute();
    await expect(
      swapPreSignGate()(finalRequest({ data: undefined })),
    ).rejects.toThrow("Refused at signing");
  });

  it("accepts the unaltered prepared request - the binding is not a blanket refusal", async () => {
    await execute();
    await expect(swapPreSignGate()(finalRequest())).resolves.toBeUndefined();
  });
});

describe("a quote authorizes exactly one execute", () => {
  const refusals = ["already_claimed", "superseded", "expired", "digest_mismatch", "not_executable", "missing_snapshot"] as const;

  for (const kind of refusals) {
    it(`refuses ${kind} by name, signs nothing, and says how to recover`, async () => {
      mockClaim.mockResolvedValue({ ok: false, refusal: snapshotRefusal(kind) });

      const result = await execute();

      expect(result.success).toBe(false);
      expectNothingSigned();
      expect(mockBuildRoute).not.toHaveBeenCalled();
      expect(result.output).toContain("Request a fresh kyberswap__swap_quote");
    });
  }

  it("refuses a tolerance that is not the one the quote was priced at", async () => {
    // The prequote identity already binds slippage, so this is the drift guard
    // between the two owners of the number rather than an expected path.
    mockClaim.mockResolvedValue(claimedSnapshot(QUOTED_OUT, 25));

    const result = await execute({ slippageBps: SLIPPAGE_BPS });

    expect(result.success).toBe(false);
    expectNothingSigned();
    expect(mockBuildRoute).not.toHaveBeenCalled();
  });
});
