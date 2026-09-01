/**
 * `kyberswap.swap.execute` - the AUTHORITATIVE debit read, in the pre-sign
 * window.
 *
 * WHAT THIS FILE IS ABOUT. Contract C2.6 says the quote-time observation is for
 * the agent's reasoning and the authoritative read belongs immediately before
 * the signature. Until WP2 the KyberSwap pre-sign hook re-asserted the calldata
 * and the price floor and asked nothing at all about money: a wallet drained
 * between the quote and the click signed an approval and then discovered it
 * could not pay for the swap - allowance granted, position not entered, gas
 * spent.
 *
 * THE SHAPE OF THE CHECK. At leg N it covers leg N as the prepared request
 * actually prices it, PLUS every leg still authorized after it, PLUS a measured
 * reserve for one more transaction. Legs already broadcast are excluded, because
 * their money is already gone and charging for them twice would refuse a swap
 * that can in fact be paid for.
 *
 * WHAT WP2-B ADDED HERE. The same window also holds the execute to the
 * TRANSACTION SET and the per-gas CEILING the approved quote bound: a leg set
 * that is not the approved one refuses before the intent exists, and a prepared
 * request priced above the approved ceiling refuses before the signature. Gas
 * UNITS stay unbound - they drift 2.07x block to block inside the quote window.
 *
 * The debit arithmetic, the L1 data fee and the evaluator are the production
 * modules throughout; only the provider, the wallet, the DB and the signer are
 * doubles. A refusal here is the handler's own decision over the fake chain's
 * answers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAddress, type Hex } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { FinalSignedRequest } from "@tools/evm-chains/staged-broadcast.js";

import capture from "../../../kyberswap/fixtures/route-build/base-usdc-to-native-50bps.json" with { type: "json" };
import { compliantRoutePaths } from "../../../kyberswap/fixtures/route-build/compliant-swap-build.js";

const SESSION_EVM = {
  family: "eip155" as const,
  address: "0x1234567890AbcdEF1234567890aBcdef12345678",
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => SESSION_EVM.address,
  resolveSelectedAddressForRead: () => SESSION_EVM.address,
  resolveSigningWallet: () => SESSION_EVM,
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

const mockSignStageBroadcast = vi.fn();
const mockPlanKyberAllowance = vi.fn();

vi.mock("@tools/kyberswap/evm-utils.js", async () => ({
  ...(await import("./evm-client.test-fixtures.js")).kyberEvmClientMocks(),
  readErc20Metadata: vi.fn(async (_slug: string, address: string) => ({
    address, symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false as const,
  })),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: (...args: unknown[]) => mockPlanKyberAllowance(...args),
  // REAL hex: the allowance leg's bytes are serialized to price the L1 data fee
  // an OP-stack chain charges for them.
  buildApproveCalldata: vi.fn(() => `0x095ea7b3${"0".repeat(128)}`),
  signStageBroadcast: (...args: unknown[]) => mockSignStageBroadcast(...args),
  decodeKyberSwapSettlement: vi.fn(() => ({
    amountInRaw: capture.build.amountIn,
    amountOutRaw: capture.build.amountOut,
  })),
}));

// The early ERC-20 preflight is GATE ONE of two and has its own suite; here it
// is stubbed so a test about the pre-sign gate cannot be satisfied by it.
vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    searchTokens: vi.fn().mockResolvedValue([]),
    getHoneypotFotInfo: vi.fn().mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 }),
  }),
}));

const mockBuildRoute = vi.fn();
vi.mock("@tools/kyberswap/aggregator/client.js", () => ({
  getKyberAggregatorClient: () => ({
    getRoute: vi.fn(),
    buildRoute: (...args: unknown[]) => mockBuildRoute(...args),
  }),
}));

const mockCreateAgentActivityIntent = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: vi.fn().mockResolvedValue({ executionId: 9 }),
  markActivityBroadcast: vi.fn().mockResolvedValue({ applied: true, row: { id: 100 } }),
  markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  confirmActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  failActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  abortPlannedEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: vi.fn().mockResolvedValue({ inserted: true }),
}));

const mockClaim = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  claimSwapExecutionSnapshot: (...args: unknown[]) => mockClaim(...args),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { KYBERSWAP_HANDLERS } from "@vex-agent/tools/protocols/kyberswap/handlers.js";
import { computeApprovedMinOut } from "@tools/kyberswap/swap-price-floor.js";
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
  legs: [{ role: "allowance" as const, pricing: "measured" as const }, { role: "swap" as const, pricing: "measured" as const }],
  feeCap: { mode: "eip1559", maxFeePerGasWei: 10n ** 15n, maxPriorityFeePerGasWei: 10n ** 15n },
});
import { resetEvmFake, setEvmFake } from "./evm-client.test-fixtures.js";

const TOKEN_IN = getAddress(capture.request.tokenIn);
const TOKEN_OUT = capture.request.tokenOut;
const QUOTED_OUT = capture.routeSummary.amountOut;
const AMOUNT_IN_HUMAN = "10";
const SLIPPAGE_BPS = 50;

const ROUTE_PATHS = compliantRoutePaths({
  srcToken: TOKEN_IN, dstToken: TOKEN_OUT,
  amountIn: BigInt(capture.routeSummary.amountIn), quotedNetOutRaw: QUOTED_OUT,
});

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`test expected ${what} to be present`);
  return value;
}

function claimedSnapshot(plan: ReturnType<typeof buildBoundDebitPlan> = APPROVED_PLAN) {
  const summary = {
    amountIn: capture.routeSummary.amountIn,
    amountOut: QUOTED_OUT,
    amountInUsd: "10", amountOutUsd: "9.99",
    gasUsd: "0.01", l1FeeUsd: "0.0000019", routeID: "r1", checksum: "c1",
    route: ROUTE_PATHS,
  };
  const encoded = encodeRouteSnapshotRaw(summary);
  if (!encoded.ok) throw new Error("fixture route must encode");
  return {
    ok: true as const,
    prequoteId: "prequote-presign",
    routeSummary: summary,
    snapshot: sealRouteSnapshot({
      v: ROUTE_SNAPSHOT_VERSION,
      provider: "kyberswap" as const,
      raw: encoded.raw,
      approvedAmountOutRaw: QUOTED_OUT,
      approvedMinOutRaw: computeApprovedMinOut(QUOTED_OUT, SLIPPAGE_BPS).toString(),
      approvedAmountOutHuman: "0.005376",
      approvedMinOutHuman: "0.005349",
      tokenOutSymbol: "NATIVE (ETH)",
      effectiveSlippageBps: SLIPPAGE_BPS,
      expiresAt: "2026-08-28T10:00:00.000Z",
      eligibility: { kind: "executable" as const, priceImpactFraction: 0.001, adverse: false },
      debitPlan: plan,
    }),
  };
}

const BUILD_RESPONSE = {
  data: {
    routerAddress: capture.routerAddress,
    data: capture.build.data as Hex,
    // MEASURED live on Base 2026-08-31: `/route/build` answered `gas: "287581"`.
    gas: "287581",
    transactionValue: capture.build.transactionValue,
    amountIn: capture.build.amountIn,
    amountOut: capture.build.amountOut,
    amountInUsd: "10", amountOutUsd: "10", gasUsd: "0.01",
  },
};

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full", approved: true,
    walletResolution: { source: "default" }, walletPolicy: { kind: "none" },
    sessionId: "session-1",
  };
}

const EXECUTE_HANDLER = KYBERSWAP_HANDLERS["kyberswap.swap.execute"];
if (EXECUTE_HANDLER === undefined) throw new Error("kyberswap.swap.execute is not registered");

function execute() {
  return EXECUTE_HANDLER(
    {
      chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT,
      amountIn: AMOUNT_IN_HUMAN, slippageBps: SLIPPAGE_BPS,
    },
    ctx(),
  );
}

/**
 * The signer and hooks the handler installed for the leg at `index`, read off
 * the recorded call rather than reimported - so what is exercised is what the
 * handler actually passed to the staged primitive.
 */
function stagedCall(index: number): {
  signer: { kind?: string; address?: string; onBeforeSign?: unknown; createSigner?: unknown };
  txParams: { to: string; data: Hex; value?: bigint };
  hooks: { onBeforeSign?: (request: FinalSignedRequest) => Promise<void> };
} {
  const call = required(mockSignStageBroadcast.mock.calls[index], `a staged broadcast for leg ${index}`);
  return {
    signer: call[1] as { kind?: string },
    txParams: call[2] as { to: string; data: Hex; value?: bigint },
    hooks: call[3] as { onBeforeSign?: (request: FinalSignedRequest) => Promise<void> },
  };
}

function preSignGate(index: number): (request: FinalSignedRequest) => Promise<void> {
  return required(stagedCall(index).hooks.onBeforeSign, `an onBeforeSign gate on leg ${index}`);
}

/**
 * A prepared request for one planned leg, as `prepareTransactionRequest` would
 * return it - the caller's own target, calldata and value, plus the fields only
 * preparation knows: the gas limit, the nonce and the PRICES.
 *
 * MEASURED on Base 2026-08-31: base fee 5,000,000 wei, priority 1,210,000 wei.
 */
function preparedRequest(
  index: number,
  patch: Partial<FinalSignedRequest> = {},
): FinalSignedRequest {
  const { txParams } = stagedCall(index);
  return {
    to: getAddress(txParams.to),
    data: txParams.data,
    value: txParams.value ?? 0n,
    gas: 300_000n,
    nonce: 3 + index,
    gasPrice: undefined,
    maxFeePerGas: 11_210_000n,
    maxPriorityFeePerGas: 1_210_000n,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEvmFake();
  mockClaim.mockResolvedValue(claimedSnapshot());
  mockBuildRoute.mockResolvedValue(BUILD_RESPONSE);
  // An approval is needed, so the plan has TWO legs and the "leg N covers what
  // is still to come" property has something to be about.
  mockPlanKyberAllowance.mockResolvedValue({ needsReset: false, needsApprove: true });
  mockCreateAgentActivityIntent.mockResolvedValue({
    executionId: 42,
    events: [{ id: 100 }, { id: 101 }],
  });
  mockSignStageBroadcast.mockReset();
  // The staged primitive as its contract describes it: the pre-sign gate runs,
  // and a throw from it means nothing was signed and nothing was sent.
  mockSignStageBroadcast.mockImplementation(async (_pub, _signer, _params, hooks) => {
    await hooks.onBeforeSign?.(preparedRequest(mockSignStageBroadcast.mock.calls.length - 1));
    await hooks.onHashStaged({ txHash: "0xfeed", fromAddress: SESSION_EVM.address, nonce: 3 });
    return { kind: "confirmed", txHash: "0xfeed", receipt: { blockNumber: 1n, logs: [] } };
  });
});

describe("the gate stands in front of every signature, not only the swap", () => {
  it("installs a pre-sign gate on the allowance leg as well as the swap leg", async () => {
    await execute();

    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(2);
    expect(stagedCall(0).hooks.onBeforeSign).toBeTypeOf("function");
    expect(stagedCall(1).hooks.onBeforeSign).toBeTypeOf("function");
  });

  it("signs OFFLINE: the signer handed to the primitive is the deferred arm", async () => {
    await execute();

    // The deferred arm exists so that NO provider call sits between the gate and
    // the signature. On the eager arm viem's wallet action awaits one
    // `eth_chainId` of its own after the gate (measured in viem 2.54.3), which
    // would put a network round trip after a check about what the wallet holds.
    const { signer } = stagedCall(1);
    expect(signer.kind).toBe("deferred");
    expect(signer.address).toBe(getAddress(SESSION_EVM.address));
    expect(signer.createSigner).toBeTypeOf("function");
  });
});

describe("at leg N the check covers every leg still to come", () => {
  it("refuses the ALLOWANCE signature when the wallet cannot pay for the swap that follows", async () => {
    // Enough native for the approval alone, nowhere near enough for the approval
    // plus the swap plus the reserve. A per-leg check would sign this approval.
    const approvalOnly = 300_000n * 11_210_000n + 12_771_545_556n;
    setEvmFake({ nativeBalanceRaw: approvalOnly });

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.output).toContain("cannot cover this swap's remaining transactions and a reserve");
    // NOTHING was signed: the throw came from the first leg's gate, so the
    // primitive never reached its second call.
    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(1);
  });

  it("charges the swap leg less than the allowance leg, because a broadcast leg's money is already gone", async () => {
    await execute();

    const atAllowance = await refusalAmount(0);
    const atSwap = await refusalAmount(1);

    // Both figures come from a wallet holding one wei, so each states the FULL
    // remaining debit at that point. The swap leg's is smaller by exactly the
    // allowance leg it no longer has to pay for.
    expect(atSwap).toBeLessThan(atAllowance);
  });
});

describe("the read is fresh, and the quote-time preview is not the authority", () => {
  it("refuses at signing when the source token was drained after the early guard passed", async () => {
    // `ensureErc20Balance` is stubbed as passing - gate one saw a funded wallet.
    // The chain now says otherwise, and the signature is what must not happen.
    setEvmFake({ erc20BalanceRaw: 1n });

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.output).toContain("no longer holds enough of the input token");
    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a balance it could not READ from a wallet that is short", async () => {
    setEvmFake({ balanceReadFailure: new Error("rpc down") });

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.output).toContain("could not be read");
    expect(result.output).not.toContain("no longer holds enough");
  });

  it("refuses a prepared request that names no fee price rather than pricing gas as free", async () => {
    await execute();

    const gate = preSignGate(1);
    await expect(
      gate(preparedRequest(1, {
        gasPrice: undefined,
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
      })),
    ).rejects.toThrow(/could not be read/);
  });

  it("computes the debit from maxFeePerGas ALONE, never maxFee plus priority", async () => {
    await execute();

    // A wallet funded for exactly the ceiling-priced debit must pass. If the two
    // 1559 fields were summed, the same wallet would be refused - which is the
    // double count `swap-native-debit.ts` exists to prevent.
    setEvmFake({ nativeBalanceRaw: 10n ** 24n });
    await expect(preSignGate(1)(preparedRequest(1))).resolves.toBeUndefined();

    setEvmFake({ nativeBalanceRaw: 1n });
    await expect(preSignGate(1)(preparedRequest(1))).rejects.toThrow(/reserve/);
  });
});

describe("the approved TRANSACTION SET and its ceiling are bound quote-to-execute", () => {
  it("refuses when this execute would broadcast a leg the approved quote never disclosed", async () => {
    // A USDT-style reset appears between the quote and the click: three
    // transactions where the card named two. A wallet that happens to be
    // solvent for the wider set is not a wallet that authorized it.
    mockPlanKyberAllowance.mockResolvedValue({ needsReset: true, needsApprove: true });

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.output).toContain("allowance_reset, allowance, swap");
    expect(result.output).toContain("was not widened");
    // Nothing was signed AND no intent row was opened: the refusal is
    // pre-intent, where a clean pre-broadcast failure is the correct record.
    expect(mockSignStageBroadcast).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
  });

  it("refuses when a disclosed leg has VANISHED, which is also a different plan", async () => {
    mockPlanKyberAllowance.mockResolvedValue({ needsReset: false, needsApprove: false });

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.output).toContain("was not widened");
    expect(mockSignStageBroadcast).not.toHaveBeenCalled();
  });

  it("refuses a prepared request priced ABOVE the ceiling the quote was priced at", async () => {
    // The quote was answered at a ceiling one wei below what this request
    // carries. The wallet is rich; what is wrong is the PRICE, and a solvency
    // check alone cannot see that.
    mockClaim.mockResolvedValue(claimedSnapshot(buildBoundDebitPlan({
      legs: [
        { role: "allowance" as const, pricing: "measured" as const },
        { role: "swap" as const, pricing: "measured" as const },
      ],
      feeCap: {
        mode: "eip1559",
        maxFeePerGasWei: 11_210_000n - 1n,
        maxPriorityFeePerGasWei: 1_210_000n,
      },
    })));

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.output).toContain("above the 11209999");
    expect(result.output).toContain("kyberswap__swap_quote");
  });

  it("does NOT bind gas UNITS - a leg that needs far more gas than the quote priced still signs", async () => {
    // 2.07x block-to-block drift in the router's own estimate was MEASURED on
    // Base inside the 15-minute quote window, so a units ceiling would refuse
    // swaps the wallet can pay for. Only the per-gas PRICE is bound.
    setEvmFake({ nativeBalanceRaw: 10n ** 24n });
    await execute();

    await expect(preSignGate(1)(preparedRequest(1, { gas: 3_000_000n }))).resolves.toBeUndefined();
  });
});

/**
 * The native figure the gate at `index` says is required, in wei.
 *
 * Driven with a one-wei wallet so the refusal always fires and always states the
 * full remaining debit at that leg.
 */
async function refusalAmount(index: number): Promise<bigint> {
  setEvmFake({ nativeBalanceRaw: 1n });
  try {
    await preSignGate(index)(preparedRequest(index));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const match = /required ([0-9.]+) ETH/.exec(message);
    if (match === null) throw new Error(`no required figure in refusal: ${message}`);
    const figure = match[1];
  if (figure === undefined) throw new Error(`no captured figure in: ${match[0]}`);
  const [whole, fraction = ""] = figure.split(".");
    return BigInt(`${whole}${fraction.padEnd(18, "0")}`);
  }
  throw new Error(`the gate on leg ${index} did not refuse a one-wei wallet`);
}

/**
 * WHAT THE GATE MUST RESERVE FOR A LEG THAT IS NOT PREPARED YET.
 *
 * The defect (found in review, 2026-09-01): after checking the CURRENT request
 * against its approved ceiling, the gate priced every REMAINING leg and the
 * follow-up reserve at that current request's price. That is a price about
 * bytes that exist, applied to bytes that do not. Nothing stops the swap leg
 * from being prepared later at anything up to the ceiling its role was quoted
 * under - this same gate will accept it - so a wallet could fund the allowance
 * at a cheap moment, sign it, and then be short for a swap the gate itself was
 * about to authorize at a higher price. Allowance granted, position not
 * entered.
 *
 * The fix is one sentence: this leg at its real price, everything after it and
 * the reserve at the APPROVED ceiling.
 *
 * The experiment holds the prepared request identical and moves ONLY the
 * approved ceiling. Before the fix the two figures were equal by construction.
 */
describe("the remainder is reserved at the ceiling the quote approved, not at this leg's price", () => {
  const REQUEST_CAP = { maxFeePerGasWei: 11_210_000n, maxPriorityFeePerGasWei: 1_210_000n };

  function planAtCeiling(maxFeePerGasWei: bigint): ReturnType<typeof buildBoundDebitPlan> {
    return buildBoundDebitPlan({
      legs: [
        { role: "allowance" as const, pricing: "measured" as const },
        { role: "swap" as const, pricing: "measured" as const },
      ],
      feeCap: {
        mode: "eip1559",
        maxFeePerGasWei,
        maxPriorityFeePerGasWei: REQUEST_CAP.maxPriorityFeePerGasWei,
      },
    });
  }

  it("charges MORE at the allowance leg when the approved ceiling is above the current price", async () => {
    mockClaim.mockResolvedValue(claimedSnapshot(planAtCeiling(REQUEST_CAP.maxFeePerGasWei)));
    await execute();
    const atCurrentPrice = await refusalAmount(0);

    vi.clearAllMocks();
    resetEvmFake();
    mockClaim.mockResolvedValue(claimedSnapshot(planAtCeiling(REQUEST_CAP.maxFeePerGasWei * 4n)));
    mockBuildRoute.mockResolvedValue(BUILD_RESPONSE);
    mockPlanKyberAllowance.mockResolvedValue({ needsReset: false, needsApprove: true });
    mockCreateAgentActivityIntent.mockResolvedValue({
      executionId: 42,
      events: [{ id: 100 }, { id: 101 }],
    });
    await execute();
    const atApprovedCeiling = await refusalAmount(0);

    // The swap leg and the reserve may both legally cost four times as much as
    // this allowance does, and the wallet must be shown to cover that BEFORE
    // the allowance is signed.
    expect(atApprovedCeiling).toBeGreaterThan(atCurrentPrice);
  });

  it("prices the leg being signed at the request's OWN price, never at the ceiling", async () => {
    // The other half of the same rule. If the leg being signed were also
    // charged at the ceiling, the figure would rise with the ceiling even for a
    // single-leg remainder - which would refuse swaps the wallet can pay for,
    // for a price those bytes will never carry.
    mockClaim.mockResolvedValue(claimedSnapshot(planAtCeiling(REQUEST_CAP.maxFeePerGasWei)));
    await execute();
    const swapLegAtCurrentPrice = await refusalAmount(1);

    vi.clearAllMocks();
    resetEvmFake();
    mockClaim.mockResolvedValue(claimedSnapshot(planAtCeiling(REQUEST_CAP.maxFeePerGasWei * 4n)));
    mockBuildRoute.mockResolvedValue(BUILD_RESPONSE);
    mockPlanKyberAllowance.mockResolvedValue({ needsReset: false, needsApprove: true });
    mockCreateAgentActivityIntent.mockResolvedValue({
      executionId: 42,
      events: [{ id: 100 }, { id: 101 }],
    });
    await execute();
    const swapLegAtApprovedCeiling = await refusalAmount(1);

    // Only the RESERVE moves at the last leg, so the figure rises - but by far
    // less than the leg itself would have. The assertion that matters is that
    // the swap leg's own gas is not multiplied by the ceiling: at 4x, a
    // ceiling-priced last leg would have roughly quadrupled the whole figure.
    expect(swapLegAtApprovedCeiling).toBeLessThan(swapLegAtCurrentPrice * 4n);
  });
});
