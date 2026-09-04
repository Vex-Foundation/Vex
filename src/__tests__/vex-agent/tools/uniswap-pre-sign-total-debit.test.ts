/**
 * `uniswap.swap.execute` - the AUTHORITATIVE debit read lives in the pre-sign
 * window, and it covers the leg being signed plus every leg still authorized
 * after it.
 *
 * ## The defect this file pins
 *
 * A quote-time observation is minutes old by the time a human approves it, and
 * before WP2-U nothing re-read the wallet at all: the execute's only balance
 * check was an ERC-20 preflight at `latest` that ignored native gas entirely. A
 * wallet could therefore fund leg one, watch it confirm, and discover at leg
 * three that it could not pay - with the allowance already granted and the
 * position half-entered (contract C2.5/C2.6).
 *
 * ## What is asserted here
 *
 *   - the gate runs on the request that is about to be serialized, at the
 *     PENDING tag, and its total includes the legs that have not been sent yet
 *     and the measured follow-up reserve;
 *   - a refusal signs nothing and broadcasts nothing;
 *   - the Vex fee leg is checked AGAIN in its own window, after the swap
 *     confirmed;
 *   - and a fee-leg refusal can NEVER rewrite a confirmed swap as failed, which
 *     is the invariant `fee/run.ts` exists to hold.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, parseUnits, type Hex } from "viem";

import { makeProtocolContext } from "./_test-context.js";
import {
  uniswapSpendabilityFake,
  type UniswapSpendabilityFakeOptions,
} from "./_uniswap-spendability-fake.js";
import { claimStandingInForTheParams } from "./_uniswap-approved-snapshot.js";

const TOKEN_IN = getAddress("0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b");
const TOKEN_OUT = getAddress("0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31");
const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const ROUTER = getAddress("0x89e5db8b5aa49aa85ac63f691524311aeb649eba");
const CHAIN_ID = 4663;

const AMOUNT_IN = "1";
const QUOTED_OUT = parseUnits("1000", 18);
/** The gas the prepared swap request carries, and the price the chain reports. */
const SWAP_GAS = 300_000n;
const GAS_PRICE = 1_000n;
/** What the fake answers for every other leg's estimate. */
const LEG_GAS = 21_000n;

const signUniswapTransaction = vi.fn();
const broadcastUniswapTransaction = vi.fn();
const signStageBroadcast = vi.fn();
const createAgentActivityIntent = vi.fn();
const markActivityBroadcast = vi.fn();
const markBroadcastAccepted = vi.fn();
const confirmActivityEvent = vi.fn();
const failActivityEvent = vi.fn();
const abortPlannedEvents = vi.fn();
const createAgentActivityPreBroadcastFailure = vi.fn();
const waitForSuccessfulReceipt = vi.fn();
const claimUniswapExecutionSnapshot = vi.fn();
const quoteBestRoute = vi.fn();

/** Every block tag the execution's balance reads asked for, in order. */
const observedTags: string[] = [];
/**
 * How many of them had been taken when the first transaction was staged - i.e.
 * the reads that DECIDED whether to sign. Reads after that point (the post-buy
 * delivery verification) are a different question at a different block and are
 * deliberately not part of this assertion.
 */
let tagsBeforeFirstBroadcast = 0;
let clientOptions: UniswapSpendabilityFakeOptions = {};
/** The fee fields the swap leg's prepared request carries. */
let swapRequestPrices: Record<string, bigint> = { gasPrice: GAS_PRICE };
/** The fee fields the FEE leg's prepared request carries. */
let feeRequestPrices: Record<string, bigint> = { gasPrice: GAS_PRICE };

function recordingClient(): ReturnType<typeof uniswapSpendabilityFake> {
  const fake = uniswapSpendabilityFake(clientOptions);
  return {
    ...fake,
    getBalance: async (parameters) => {
      observedTags.push(parameters.blockTag ?? "default");
      return await fake.getBalance(parameters);
    },
    readContract: async (parameters) => {
      if (parameters.functionName === "balanceOf") observedTags.push(parameters.blockTag ?? "default");
      return await fake.readContract(parameters);
    },
  };
}

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
}));
vi.mock("@tools/uniswap/evm-client.js", () => ({
  getUniswapPublicClient: vi.fn(() => recordingClient()),
  // The wallet client carries an ACCOUNT and a CHAIN because production's type
  // guarantees both, and the fee leg now reads them to build its deferred
  // signer (`fee/run.ts`): a bare `{}` would make that leg fail as
  // `not_attempted` for a reason no production client can have.
  getUniswapEvmClients: vi.fn(() => ({
    publicClient: recordingClient(),
    walletClient: { account: { address: WALLET, type: "local" }, chain: { id: CHAIN_ID } },
  })),
}));
vi.mock("@tools/uniswap/erc20.js", () => ({
  readUniswapErc20Metadata: vi.fn(async (_client: unknown, address: string) => ({
    address, symbol: "TKN", decimals: 18, isNative: false,
  })),
  validateUniswapSpender: vi.fn(),
  readUniswapAllowance: vi.fn(async () => 10n ** 40n),
}));
vi.mock("@tools/uniswap/quote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/uniswap/quote.js")>()),
  quoteBestRoute: (...args: unknown[]) => quoteBestRoute(...args),
}));
// The calldata builders and the refusal classes stay REAL: the gate refuses the
// real request shape, and the loop tells the refusals apart by identity.
vi.mock("@tools/uniswap/execute.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/uniswap/execute.js")>()),
  signUniswapTransaction: (...args: unknown[]) => signUniswapTransaction(...args),
  broadcastUniswapTransaction: (...args: unknown[]) => broadcastUniswapTransaction(...args),
}));
vi.mock("@tools/uniswap/safety.js", () => ({
  checkRouteFactories: vi.fn(async () => ({ checked: true, allowlisted: true })),
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
vi.mock("@tools/evm-chains/receipt-guard.js", () => ({
  waitForSuccessfulReceipt: (...args: unknown[]) => waitForSuccessfulReceipt(...args),
}));
// The FEE leg rides the shared staged broadcaster. Stubbed so this suite can
// hand its pre-sign hook the request the fee leg would have serialized.
vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: (...args: unknown[]) => signStageBroadcast(...args),
}));
vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    getHoneypotFotInfo: async () => ({ isHoneypot: false, isFOT: false, tax: 0 }),
  }),
}));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => createAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => createAgentActivityPreBroadcastFailure(...args),
  markActivityBroadcast: (...args: unknown[]) => markActivityBroadcast(...args),
  reserveActivityEvmNonce: vi.fn(async () => 7),
  markBroadcastAccepted: (...args: unknown[]) => markBroadcastAccepted(...args),
  confirmActivityEvent: (...args: unknown[]) => confirmActivityEvent(...args),
  failActivityEvent: (...args: unknown[]) => failActivityEvent(...args),
  abortPlannedEvents: (...args: unknown[]) => abortPlannedEvents(...args),
}));
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: vi.fn() }));
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  claimSwapExecutionSnapshot: vi.fn(),
  claimUniswapExecutionSnapshot: (...args: unknown[]) => claimUniswapExecutionSnapshot(...args),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => WALLET),
  resolveSigningWallet: vi.fn(() => ({ family: "eip155", address: WALLET, privateKey: `0x${"ab".repeat(32)}` })),
  walletScopeErrorToResult: vi.fn((err: unknown) => ({ success: false, output: String(err) })),
}));
vi.mock("@vex-agent/tools/protocols/runtime/pending-provenance.js", () => ({
  noteHandlerPendingReason: vi.fn(),
}));
vi.mock("@utils/logger.js", () => {
  const stub = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { UNISWAP_SWAP_HANDLERS } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap.js");
const execute = UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"];
if (execute === undefined) throw new Error("uniswap.swap.execute is not registered");

const context = makeProtocolContext({
  sessionPermission: "full",
  approved: true,
  sessionId: "session-1",
});

const PARAMS = { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT_IN };

async function run(): Promise<{ success: boolean; output: string; data?: unknown }> {
  const result = await execute(PARAMS, context);
  return { success: result.success, output: String(result.output), data: result.data };
}

beforeEach(() => {
  vi.clearAllMocks();
  observedTags.length = 0;
  tagsBeforeFirstBroadcast = 0;
  swapRequestPrices = { gasPrice: GAS_PRICE };
  feeRequestPrices = { gasPrice: GAS_PRICE };
  clientOptions = {
    tokenBalanceRaw: 10n ** 30n,
    nativeBalanceWei: 10n ** 18n,
    gasEstimate: LEG_GAS,
    gasPriceWei: GAS_PRICE,
  };
  quoteBestRoute.mockResolvedValue({
    route: { version: "v2", path: [TOKEN_IN, TOKEN_OUT], amountOut: QUOTED_OUT },
    priceImpact: 0.001,
  });
  claimUniswapExecutionSnapshot.mockImplementation(
    claimStandingInForTheParams({ chainId: CHAIN_ID, weth: WETH }),
  );
  createAgentActivityIntent.mockResolvedValue({
    executionId: 1,
    events: [
      { id: 100, eventIndex: 0, eventRole: "swap" },
      { id: 101, eventIndex: 1, eventRole: "swap_fee" },
    ],
  });
  createAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 999, event: {} });
  markActivityBroadcast.mockImplementation(async () => {
    if (tagsBeforeFirstBroadcast === 0) tagsBeforeFirstBroadcast = observedTags.length;
    return { applied: true };
  });
  markBroadcastAccepted.mockResolvedValue({ applied: true });
  confirmActivityEvent.mockResolvedValue({ applied: true, row: { status: "confirmed" } });
  abortPlannedEvents.mockResolvedValue({ applied: true, count: 1 });
  waitForSuccessfulReceipt.mockResolvedValue({ status: "success", blockNumber: 5n, logs: [] });
  broadcastUniswapTransaction.mockResolvedValue("0xswap");

  // The venue signer, reduced to its fence: it hands the caller's gate the
  // request that WOULD be serialized, then reports a signature.
  signUniswapTransaction.mockImplementation(async (
    _public: unknown, _wallet: unknown,
    tx: { to: Hex; data: Hex; value: bigint },
    _priorLeg: unknown, _reserveNonce: unknown,
    onBeforeSign?: (request: Record<string, unknown>) => Promise<void>,
  ) => {
    if (onBeforeSign) {
      await onBeforeSign({
        to: tx.to, data: tx.data, value: tx.value, gas: SWAP_GAS, nonce: 7, ...swapRequestPrices,
      });
    }
    return { serializedTransaction: "0xsigned" as Hex, txHash: "0xswap" as Hex, fromAddress: WALLET, nonce: 7 };
  });

  // The shared broadcaster, reduced to the same fence for the fee leg.
  signStageBroadcast.mockImplementation(async (
    _public: unknown, _wallet: unknown,
    txParams: { to: Hex; data: Hex; value: bigint },
    hooks: {
      onBeforeSign?: (request: Record<string, unknown>) => Promise<void>;
      onHashStaged: (handles: unknown) => Promise<void>;
      onAccepted: () => Promise<void>;
    },
  ) => {
    if (hooks.onBeforeSign) {
      await hooks.onBeforeSign({
        to: txParams.to, data: txParams.data, value: txParams.value, gas: LEG_GAS, nonce: 8, ...feeRequestPrices,
      });
    }
    await hooks.onHashStaged({ txHash: "0xfee", fromAddress: WALLET, nonce: 8 });
    await hooks.onAccepted();
    return { kind: "confirmed", txHash: "0xfee", receipt: { blockNumber: 6n } };
  });
});

describe("the pre-sign window is the authority, not the quote", () => {
  it("reads both balances at the PENDING tag before the swap is signed", async () => {
    const result = await run();

    expect(result.success).toBe(true);
    // Every balance this execution read - the ERC-20 preflight and both legs of
    // every pre-sign gate - was taken at the only tag a spend may be authorized
    // from. `latest` does not subtract the wallet's own in-flight spending.
    expect(tagsBeforeFirstBroadcast).toBeGreaterThan(0);
    expect(new Set(observedTags.slice(0, tagsBeforeFirstBroadcast))).toEqual(new Set(["pending"]));
  });

  it("refuses at the swap leg when the wallet covers the swap but not the fee leg and the reserve", async () => {
    // Enough for the swap's own gas and a little more - and less than the swap
    // plus the fee transfer plus the measured follow-up reserve.
    clientOptions = {
      ...clientOptions,
      nativeBalanceWei: SWAP_GAS * GAS_PRICE + LEG_GAS * GAS_PRICE,
    };

    const result = await run();

    expect(result.success).toBe(false);
    expect(result.output).toContain("refused before signing");
    expect(result.output).toContain("remaining native cost");
    // NOTHING reached the network.
    expect(broadcastUniswapTransaction).not.toHaveBeenCalled();
    expect(markActivityBroadcast).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ status: "not_attempted" });
  });

  it("refuses when the source balance no longer covers the FULL requested amount", async () => {
    clientOptions = { ...clientOptions, tokenBalanceRaw: parseUnits(AMOUNT_IN, 18) - 1n };

    const result = await run();

    expect(result.success).toBe(false);
    expect(broadcastUniswapTransaction).not.toHaveBeenCalled();
  });

  it("fails closed when a balance cannot be read in the pre-sign window", async () => {
    // The ERC-20 preflight is what fails first here, and it fails CLOSED with a
    // read error rather than a shortfall - the two must never be one message.
    clientOptions = { ...clientOptions, nativeReadFails: true };

    const result = await run();

    expect(result.success).toBe(false);
    expect(broadcastUniswapTransaction).not.toHaveBeenCalled();
  });

  it("refuses a leg whose price left the ceiling the debit total was computed under", async () => {
    // The chain reports a legacy price; this request arrives priced as EIP-1559.
    // A cap approved as one mode says nothing about the other.
    swapRequestPrices = { maxFeePerGas: GAS_PRICE * 100n, maxPriorityFeePerGas: 1n };

    const result = await run();

    expect(result.success).toBe(false);
    expect(result.output).toContain("refused before signing");
    expect(broadcastUniswapTransaction).not.toHaveBeenCalled();
  });
});

describe("the Vex fee leg is counted first and checked again", () => {
  it("runs its own pre-sign gate only after the swap confirmed", async () => {
    const result = await run();

    expect(result.success).toBe(true);
    // The fee leg is signed through the shared broadcaster, and only after the
    // swap's own broadcast and receipt.
    expect(broadcastUniswapTransaction).toHaveBeenCalledBefore(signStageBroadcast);
    const hooks = signStageBroadcast.mock.calls[0]?.[3] as { onBeforeSign?: unknown };
    expect(hooks.onBeforeSign).toBeTypeOf("function");
  });

  it("signs the fee leg on the DEFERRED arm, so no provider call follows its debit gate", async () => {
    await run();
    // The eager arm signs through viem's wallet action, which awaits an
    // `eth_chainId` of its own AFTER the authoritative hook resolves (measured
    // in viem 2.54.3). The fee leg carries a money gate, so it is exactly the
    // leg that may not have a round trip in that window; the other Uniswap legs
    // already sign offline. This asserts the ARM, which is the only thing that
    // closes the window - a hook alone does not.
    const signer = signStageBroadcast.mock.calls[0]?.[1] as { kind?: unknown };
    expect(signer.kind).toBe("deferred");
  });

  it("leaves a CONFIRMED swap confirmed when the fee leg's own gate refuses", async () => {
    // The fee request arrives priced in a mode the ceiling was not approved in,
    // so the fee leg's gate refuses it. Nothing about the swap may change.
    feeRequestPrices = { maxFeePerGas: GAS_PRICE * 100n, maxPriorityFeePerGas: 1n };

    const result = await run();

    expect(result.success).toBe(true);
    const data = result.data as { vexFee?: { collection?: string; collectionNote?: string } };
    expect(data.vexFee?.collection).toBe("not_attempted");
    expect(String(data.vexFee?.collectionNote)).toContain("swap is unaffected");
    // The swap's own row was confirmed and never failed by the fee's refusal.
    expect(failActivityEvent).not.toHaveBeenCalled();
  });
});
