/**
 * `uniswap.swap.execute` is bound to the TRANSACTIONS the approved quote said
 * it would send, not only to its price.
 *
 * ## The defect this file pins
 *
 * WP2-U's own report named it: the quote measured a leg plan, disclosed its
 * native debit on the approval card, and then the execute re-derived its own leg
 * set from a FRESH allowance read and priced it at a FRESH fee cap. A wallet
 * whose allowance moved between the quote and the click therefore signed extra
 * transactions the card never mentioned, and the execute proceeded because the
 * wallet happened to be solvent for them. Rule 90: approval binds to the exact
 * parameters, and the transaction set and the per-gas ceiling are parameters.
 *
 * ## How red is proved
 *
 * Every test drives the REAL handler over a scripted chain: the real leg
 * planner, the real fee resolution, the real snapshot codec and the real
 * pre-sign gate. The only doubles are the provider, the chain, the wallet, the
 * DB and the staged primitive - and the staged primitive is the CAPTURE point,
 * so what is asserted is what the handler actually decided to sign, and the
 * ceiling it decided to sign under.
 *
 * What must keep working is asserted too: a matching plan executes normally, and
 * gas UNITS are never bound (2.07x measured block-to-block drift would refuse
 * fundable swaps).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, parseUnits } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { LegFeeCap, NativeDebitLegRole } from "@tools/evm-chains/swap-native-debit.js";

import { uniswapSpendabilityFake } from "./_uniswap-spendability-fake.js";

const TOKEN_IN = getAddress("0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b");
const TOKEN_OUT = getAddress("0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31");
const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const ROUTER = getAddress("0x89e5db8b5aa49aa85ac63f691524311aeb649eba");
const CHAIN_ID = 4663;

const AMOUNT_IN = "1";
const AMOUNT_IN_RAW = parseUnits(AMOUNT_IN, 18);
const QUOTED_OUT = parseUnits("1000", 18);
const SLIPPAGE_BPS = 500;

/**
 * The ceiling the CHAIN would suggest right now. Deliberately different from
 * the one the fixture quotes bind, so a cap read fresh from the chain and a cap
 * restored from the snapshot are distinguishable in an assertion.
 */
const CHAIN_GAS_PRICE_WEI = 9_999n;

const quoteBestRoute = vi.fn();
const runStagedBroadcast = vi.fn();
const claimUniswapExecutionSnapshot = vi.fn();
const createAgentActivityIntent = vi.fn();
const createAgentActivityPreBroadcastFailure = vi.fn();
const readUniswapAllowance = vi.fn();

vi.mock("@vex-agent/db/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/db/client.js")>()),
  // The ONE durable question the spendability lane asks since 2026-09-01: does
  // this wallet have a broadcast of ours outstanding on a chain whose `pending`
  // tag subtracts nothing (chain 4663 is such an endpoint, measured). Only the
  // DATABASE is doubled - the capability table, the policy and the fail-closed
  // verdict are the production modules, and their own suites drive the other
  // answers. Without this the query reaches a pool that does not exist and
  // every read here refuses, correctly, for a reason no suite here is about.
  queryOne: vi.fn(async () => ({ in_flight: false })),
}));

vi.mock("@tools/uniswap/chains.js", () => ({
  resolveUniswapDeployment: vi.fn(() => ({
    key: "robinhood", name: "Robinhood Chain", chainId: CHAIN_ID, weth: WETH,
    v2: { router02: ROUTER, factory: "0x2222222222222222222222222222222222222222" },
  })),
  resolveUniswapChainId: vi.fn(() => CHAIN_ID),
}));
vi.mock("@tools/uniswap/evm-client.js", () => ({
  getUniswapPublicClient: vi.fn(() => uniswapSpendabilityFake({ gasPriceWei: CHAIN_GAS_PRICE_WEI })),
  getUniswapEvmClients: vi.fn(() => ({
    publicClient: uniswapSpendabilityFake({ gasPriceWei: CHAIN_GAS_PRICE_WEI }),
    walletClient: {},
  })),
}));
vi.mock("@tools/uniswap/erc20.js", () => ({
  readUniswapErc20Metadata: vi.fn(async (_client: unknown, address: string) => ({
    address, symbol: "TKN", decimals: 18, isNative: false,
  })),
  validateUniswapSpender: vi.fn(),
  readUniswapAllowance: (...args: unknown[]) => readUniswapAllowance(...args),
}));
vi.mock("@tools/uniswap/quote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/uniswap/quote.js")>()),
  quoteBestRoute: (...args: unknown[]) => quoteBestRoute(...args),
}));
vi.mock("@tools/uniswap/safety.js", () => ({
  checkRouteFactories: vi.fn(async () => ({ ok: true })),
  probeFotSignal: vi.fn(async () => false),
  UNISWAP_MIN_LIQUIDITY_USD: 5000,
}));
vi.mock("@tools/uniswap/receipt-decoder.js", () => ({
  decodeUniswapExecutedLegs: vi.fn(() => ({ executedAmountInRaw: 1n, executedAmountOutRaw: 1n })),
}));
vi.mock("@tools/uniswap/revert-mapping.js", () => ({
  classifyUniswapRevertError: vi.fn(() => ({ failureCode: "unknown", failureReason: "unused" })),
  classifyPreBroadcastFailure: vi.fn(() => ({ failureCode: "unknown", failureReason: "unused" })),
}));
vi.mock("@tools/dexscreener/price-read.js", () => ({ readTokensPairs: vi.fn(async () => []) }));
vi.mock("@tools/evm-chains/registry.js", () => ({ getLocalChain: vi.fn(() => ({ chainId: CHAIN_ID })) }));
vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({ ensureErc20Balance: vi.fn() }));
vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({ getHoneypotFotInfo: async () => ({ isHoneypot: false, isFOT: false, tax: 0 }) }),
}));
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: vi.fn(async () => ({ inserted: true })) }));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => createAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => createAgentActivityPreBroadcastFailure(...args),
  markActivityBroadcast: vi.fn(async () => ({ applied: true, row: {} })),
  markBroadcastAccepted: vi.fn(async () => ({ applied: true, row: {} })),
  confirmActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
  failActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
  abortPlannedEvents: vi.fn(async () => undefined),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => WALLET),
  resolveSigningWallet: vi.fn(() => ({ family: "eip155", address: WALLET, privateKey: `0x${"ab".repeat(32)}` })),
  walletScopeErrorToResult: vi.fn((err: unknown) => ({ success: false, output: String(err) })),
}));
// The CAPTURE point: what the handler decided to sign, the gate it installed in
// front of that signature, and the ceiling it forced into preparation.
vi.mock("@vex-agent/tools/protocols/uniswap/handlers/swap/execute-broadcast.js", () => ({
  runStagedBroadcast: (...args: unknown[]) => runStagedBroadcast(...args),
}));
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  claimSwapExecutionSnapshot: vi.fn(),
  claimUniswapExecutionSnapshot: (...args: unknown[]) => claimUniswapExecutionSnapshot(...args),
}));
vi.mock("@utils/logger.js", () => {
  const stub = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { UNISWAP_SWAP_HANDLERS } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap.js");
const { applySlippage } = await import("@tools/uniswap/quote.js");
const { approvedUniswapSnapshot, approvedUniswapVexFee } = await import("./_uniswap-approved-snapshot.js");

const execute = UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"];
if (execute === undefined) throw new Error("uniswap.swap.execute is not registered");

const context: ProtocolExecutionContext = {
  sessionPermission: "full", approved: true, sessionId: "session-1",
  walletResolution: { source: "default" }, walletPolicy: { kind: "none" },
};

const TOKEN_IN_LEG = { address: TOKEN_IN, symbol: "TKN", decimals: 18, isNative: false } as const;
const TOKEN_OUT_LEG = { address: TOKEN_OUT, symbol: "TKN", decimals: 18, isNative: false } as const;

/** The ceiling the fixture quotes bind. Not the chain's, so the two are telling apart. */
const APPROVED_CAP: LegFeeCap = { mode: "legacy", gasPriceWei: 4_242n };

/** The row's Vex fee statement for this trade, re-checked before signing. */
function approvedVexFee() {
  return approvedUniswapVexFee({
    chainId: CHAIN_ID,
    tokenIn: TOKEN_IN_LEG,
    tokenOut: TOKEN_OUT_LEG,
    amountInRaw: AMOUNT_IN_RAW,
    approvedAmountOutRaw: QUOTED_OUT,
    approvedMinOutRaw: QUOTED_OUT,
  });
}

async function snapshotBoundTo(
  legs: readonly NativeDebitLegRole[],
  feeCap: LegFeeCap = APPROVED_CAP,
) {
  return await approvedUniswapSnapshot({
    chainId: CHAIN_ID,
    tokenIn: TOKEN_IN_LEG,
    tokenOut: TOKEN_OUT_LEG,
    amountInRaw: AMOUNT_IN_RAW,
    approvedAmountOutRaw: QUOTED_OUT,
    approvedMinOutRaw: applySlippage(QUOTED_OUT, SLIPPAGE_BPS),
    slippageBps: SLIPPAGE_BPS,
    legs,
    feeCap,
  });
}

function run() {
  return execute(
    {
      chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT,
      amountIn: AMOUNT_IN, slippageBps: SLIPPAGE_BPS,
    },
    context,
  );
}

/** The staged call for one leg, as the handler actually made it. */
function stagedCall(index: number): {
  readonly gate: (request: Record<string, unknown>) => Promise<void>;
  readonly bounds: { readonly cap: LegFeeCap };
} {
  const call = runStagedBroadcast.mock.calls[index];
  if (!call) throw new Error(`test expected a staged broadcast for leg ${index}`);
  return {
    gate: call[6] as (request: Record<string, unknown>) => Promise<void>,
    bounds: call[7] as { readonly cap: LegFeeCap },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  // An allowance already in place: the execute plans the swap and the fee leg.
  readUniswapAllowance.mockResolvedValue(10n ** 40n);
  createAgentActivityIntent.mockResolvedValue({
    executionId: 1,
    events: [
      { id: 100, eventIndex: 0, eventRole: "swap" },
      { id: 101, eventIndex: 1, eventRole: "swap_fee" },
    ],
  });
  createAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 999, event: {} });
  runStagedBroadcast.mockResolvedValue({
    kind: "confirmed", txHash: "0xswap", receipt: { logs: [] }, settledAtBlock: 1n,
  });
  claimUniswapExecutionSnapshot.mockResolvedValue({
    ok: true, prequoteId: "prequote-plan", snapshot: await snapshotBoundTo(["swap", "swap_fee"]),
    vexFee: await approvedVexFee(),
  });
  quoteBestRoute.mockResolvedValue({
    route: { version: "v2" as const, path: [TOKEN_IN, TOKEN_OUT], amountOut: QUOTED_OUT },
    priceImpact: 0.001,
  });
});

describe("the transaction set is bound quote-to-execute", () => {
  it("refuses when the wallet now needs an allowance leg the approved quote never disclosed", async () => {
    // The allowance was spent between the quote and the click, so this execute
    // would send THREE transactions where the card named two.
    readUniswapAllowance.mockResolvedValue(0n);

    const result = await run();

    expect(result.success).toBe(false);
    expect(runStagedBroadcast).not.toHaveBeenCalled();
    expect(createAgentActivityIntent).not.toHaveBeenCalled();
    expect(result.output).toContain("allowance, swap, swap_fee");
    expect(result.output).toContain("swap, swap_fee");
    expect(result.output).toContain("was not widened");
    expect(result.output).toContain("uniswap__swap_quote");
  });

  it("refuses when a leg the approved quote disclosed has VANISHED", async () => {
    // The mirror case: the quote was answered when an approve was needed, and
    // by execute time the allowance is in place. Fewer transactions is still a
    // different plan, and the card's disclosed debit no longer describes it.
    claimUniswapExecutionSnapshot.mockResolvedValue({
      ok: true,
      prequoteId: "prequote-plan",
      snapshot: await snapshotBoundTo(["allowance", "swap", "swap_fee"]),
      vexFee: await approvedVexFee(),
    });

    const result = await run();

    expect(result.success).toBe(false);
    expect(runStagedBroadcast).not.toHaveBeenCalled();
    expect(result.output).toContain("was not widened");
  });

  it("executes normally when the plan is the one that was approved", async () => {
    const result = await run();

    expect(result.success).toBe(true);
    expect(runStagedBroadcast).toHaveBeenCalled();
  });
});

describe("the per-gas ceiling comes from the snapshot, not from a fresh read", () => {
  it("forces the APPROVED ceiling into preparation even when the chain now suggests another", async () => {
    await run();

    expect(stagedCall(0).bounds.cap).toEqual(APPROVED_CAP);
    // Proof the value is the snapshot's and not the fake chain's own suggestion.
    expect(stagedCall(0).bounds.cap).not.toEqual({ mode: "legacy", gasPriceWei: CHAIN_GAS_PRICE_WEI });
  });

  it("refuses a prepared request priced above the approved ceiling, before signing", async () => {
    await run();
    const { gate } = stagedCall(0);

    // The bytes the signer is about to commit to, priced above what the human
    // approved. Nothing about the wallet is wrong - it is the PRICE that is not
    // the one that was agreed.
    const refusal = await gate({
      gas: 300_000n,
      nonce: 3,
      gasPrice: APPROVED_CAP.mode === "legacy" ? APPROVED_CAP.gasPriceWei + 1n : 1n,
    }).then(() => null, (err: unknown) => err as { message: string; hint?: string; retryable?: boolean });

    expect(refusal).not.toBeNull();
    expect(refusal?.message).toContain("above the 4242");
    expect(refusal?.hint).toContain("Nothing was signed");
    expect(refusal?.retryable).toBe(false);
  });

  it("admits a request at or below the approved ceiling - the ceiling is not a blanket refusal", async () => {
    await run();
    const { gate } = stagedCall(0);

    await expect(gate({ gas: 300_000n, nonce: 3, gasPrice: 4_242n })).resolves.toBeUndefined();
    await expect(gate({ gas: 300_000n, nonce: 3, gasPrice: 1n })).resolves.toBeUndefined();
  });

  it("does NOT bind gas UNITS: a leg that needs far more gas than the quote priced still signs", async () => {
    await run();
    const { gate } = stagedCall(0);

    // 2.07x block-to-block drift in a router's own estimate was MEASURED on
    // Base inside the 15-minute quote window (WP2-K), so a units ceiling would
    // refuse swaps the wallet can pay for. Only the price is bound.
    await expect(gate({ gas: 30_000_000n, nonce: 3, gasPrice: 4_242n })).resolves.toBeUndefined();
  });
});
