/**
 * `uniswap.swap.execute` WIRES the pre-sign fence, with the approved authority.
 *
 * The guard's own decisions are pinned over real encoder bytes in
 * `src/__tests__/tools/uniswap/final-request-gate.test.ts`. What is pinned HERE
 * is the wiring nobody else can prove: that the handler hands the fence the
 * CLAIMED snapshot's floor and native input plus this deployment's own router,
 * that the fence runs on the swap leg, and that its refusal reaches the agent as
 * a "nothing was signed" refusal rather than as an unexpected internal failure.
 *
 * The seam is the signer: `signUniswapTransaction` is stubbed to invoke the
 * handler's `onBeforeSign` with a request the test controls - which is exactly
 * what a preparation path that altered the request would do - and then to report
 * a signed transaction. Everything between the claim and the fence (the fee
 * resolution, the drift comparison, the calldata build, the guard itself) is
 * real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { uniswapSpendabilityFake } from "./_uniswap-spendability-fake.js";
import { getAddress, parseUnits, type Hex } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { FinalSignedRequest } from "@tools/evm-chains/staged-broadcast.js";

const TOKEN_IN = getAddress("0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b");
const TOKEN_OUT = getAddress("0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31");
const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const ROUTER = getAddress("0x89e5db8b5aa49aa85ac63f691524311aeb649eba");
const CHAIN_ID = 4663;

const quoteBestRoute = vi.fn();
const claimUniswapExecutionSnapshot = vi.fn();
const createAgentActivityIntent = vi.fn();
const createAgentActivityPreBroadcastFailure = vi.fn();
const signUniswapTransaction = vi.fn();

vi.mock("@vex-agent/db/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/db/client.js")>()),
  // Only the DATABASE is doubled. Since 2026-09-01 the spendability lane asks
  // one durable question - has this wallet a broadcast of ours outstanding on a
  // chain whose `pending` tag subtracts nothing - and this suite's chain is such
  // an endpoint (measured). The capability table, the policy and the fail-closed
  // verdict stay production code, driven by their own suites.
  queryOne: vi.fn(async () => ({ in_flight: false })),
}));

vi.mock("@tools/uniswap/chains.js", () => ({
  resolveUniswapDeployment: vi.fn(() => ({
    key: "robinhood", name: "Robinhood Chain", chainId: CHAIN_ID, weth: WETH,
    v2: { router02: ROUTER, factory: "0x2222222222222222222222222222222222222222" },
  })),
  resolveUniswapChainId: vi.fn(() => CHAIN_ID),
}));
// WP2-U: the quote and every leg's pre-sign gate read balances and price the
// leg plan through this client. A SOLVENT default keeps this suite's subject -
// the final-request fence - the thing that decides its outcome.
vi.mock("@tools/uniswap/evm-client.js", () => ({
  getUniswapPublicClient: vi.fn(() => uniswapSpendabilityFake()),
  getUniswapEvmClients: vi.fn(() => ({ publicClient: uniswapSpendabilityFake(), walletClient: {} })),
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
// The CALLDATA BUILDER stays real - the bytes the fence decodes must be the
// bytes this handler builds. Only the signer is a seam.
vi.mock("@tools/uniswap/execute.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/uniswap/execute.js")>()),
  signUniswapTransaction: (...args: unknown[]) => signUniswapTransaction(...args),
  broadcastUniswapTransaction: vi.fn(async () => "0xswap" as Hex),
}));
vi.mock("@tools/evm-chains/receipt-guard.js", () => ({
  waitForSuccessfulReceipt: vi.fn(async () => ({ status: "success", blockNumber: 1n, logs: [] })),
}));
vi.mock("@tools/uniswap/safety.js", () => ({
  checkRouteFactories: vi.fn(async () => ({ checked: true, allowlisted: true })),
  probeFotSignal: vi.fn(async () => false),
  UNISWAP_MIN_LIQUIDITY_USD: 5000,
}));
vi.mock("@tools/uniswap/receipt-decoder.js", () => ({
  decodeUniswapExecutedLegs: vi.fn(() => ({ executedAmountInRaw: 1n, executedAmountOutRaw: 1n })),
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
  reserveActivityEvmNonce: vi.fn(async () => 9),
  confirmActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
  failActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
  abortPlannedEvents: vi.fn(async () => undefined),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => WALLET),
  resolveSigningWallet: vi.fn(() => ({ family: "eip155", address: WALLET, privateKey: `0x${"ab".repeat(32)}` })),
  walletScopeErrorToResult: vi.fn((err: unknown) => ({ success: false, output: String(err) })),
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
const { buildSwapTx } = await import("@tools/uniswap/execute.js");
const { resolveUniswapDeployment } = await import("@tools/uniswap/chains.js");
const { approvedUniswapSnapshot } = await import("./_uniswap-approved-snapshot.js");

const execute = UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"];
if (execute === undefined) throw new Error("uniswap.swap.execute is not registered");

const ROBINHOOD_DEPLOYMENT = resolveUniswapDeployment("robinhood");
if (ROBINHOOD_DEPLOYMENT === undefined) {
  throw new Error("the mocked robinhood uniswap deployment must resolve for this suite");
}

const context: ProtocolExecutionContext = {
  sessionPermission: "full", approved: true, sessionId: "session-1",
  walletResolution: { source: "default" }, walletPolicy: { kind: "none" },
};

const SLIPPAGE_BPS = 500;
const AMOUNT_IN_HUMAN = "1";
const AMOUNT_IN_RAW = parseUnits(AMOUNT_IN_HUMAN, 18);
const QUOTED_OUT = parseUnits("313879.7", 18);

const TOKEN_IN_LEG = { address: TOKEN_IN, symbol: "TKN", decimals: 18, isNative: false } as const;
const TOKEN_OUT_LEG = { address: TOKEN_OUT, symbol: "TKN", decimals: 18, isNative: false } as const;

function freshRoute(amountOut: bigint) {
  return { route: { version: "v2" as const, path: [TOKEN_IN, TOKEN_OUT], amountOut }, priceImpact: 0.001 };
}

async function approved() {
  return approvedUniswapSnapshot({
    chainId: CHAIN_ID,
    tokenIn: TOKEN_IN_LEG,
    tokenOut: TOKEN_OUT_LEG,
    amountInRaw: AMOUNT_IN_RAW,
    approvedAmountOutRaw: QUOTED_OUT,
    approvedMinOutRaw: applySlippage(QUOTED_OUT, SLIPPAGE_BPS),
    slippageBps: SLIPPAGE_BPS,
  });
}

/**
 * The request the FENCE is shown. `undefined` means "whatever the handler built"
 * - the honest pass-through; anything else stands for a preparation path that
 * handed the signer a different transaction.
 */
let alteredRequest: ((built: { to: string; data: Hex; value: bigint }) => FinalSignedRequest) | undefined;

/** Every `onBeforeSign` the handler installed this run, in leg order. */
const fences: (((r: FinalSignedRequest) => Promise<void>) | undefined)[] = [];

function run() {
  return execute(
    { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT_IN_HUMAN, slippageBps: SLIPPAGE_BPS },
    context,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  fences.length = 0;
  alteredRequest = undefined;
  createAgentActivityIntent.mockResolvedValue({
    executionId: 1,
    events: [
      { id: 100, eventIndex: 0, eventRole: "swap" },
      { id: 101, eventIndex: 1, eventRole: "swap_fee" },
    ],
  });
  createAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 999, event: {} });
  claimUniswapExecutionSnapshot.mockResolvedValue({
    ok: true, prequoteId: "prequote-1", snapshot: await approved(),
  });
  quoteBestRoute.mockResolvedValue(freshRoute(QUOTED_OUT));

  signUniswapTransaction.mockImplementation(async (
    _public: unknown, _wallet: unknown,
    tx: { to: string; data: Hex; value: bigint },
    _priorLeg: unknown, _reserveNonce: unknown,
    onBeforeSign?: (r: FinalSignedRequest) => Promise<void>,
  ) => {
    fences.push(onBeforeSign);
    if (onBeforeSign) {
      const shown: FinalSignedRequest = alteredRequest
        ? alteredRequest(tx)
        : { to: tx.to as `0x${string}`, data: tx.data, value: tx.value, gas: 300_000n, nonce: 9 };
      // A real prepared request always carries a fee price - WP2-U's debit gate
      // refuses one that does not, because a cost nobody can state cannot be
      // checked against the ceiling the swap was totalled under. The stand-in
      // price matches this suite's fake chain (`uniswapSpendabilityFake`), so
      // the FENCE stays the only thing deciding these outcomes.
      await onBeforeSign({ gasPrice: 1_000n, ...shown });
    }
    return { serializedTransaction: "0xsigned" as Hex, txHash: "0xswap" as Hex, fromAddress: WALLET, nonce: 9 };
  });
});

describe("the swap leg is fenced with the CLAIMED authority", () => {
  it("passes the fence when the request is the trade that was approved", async () => {
    const result = await run();

    expect(fences.length).toBe(1);
    expect(fences[0]).toBeTypeOf("function");
    expect(result.success).toBe(true);
  });

  it("refuses a request whose calldata carries a floor the human never approved", async () => {
    const snapshot = await approved();
    // The REAL encoder, at the collapsed-route floor the old code would have
    // derived. Same router, same value - only the bytes differ.
    alteredRequest = (tx) => ({
      to: tx.to as `0x${string}`,
      data: buildSwapTx({
        // The SAME deployment the handler resolved, read back through the
        // module the handler itself reads - never a literal that could drift
        // from it.
        deployment: ROBINHOOD_DEPLOYMENT,
        route: { version: "v2", path: [TOKEN_IN, TOKEN_OUT], amountOut: QUOTED_OUT },
        amountIn: AMOUNT_IN_RAW,
        minAmountOut: BigInt(snapshot.approvedMinOutRaw) / 100n,
        recipient: WALLET,
        deadline: 1_900_000_000n,
        tokenInIsNative: false,
        tokenOutIsNative: false,
      }).data,
      value: tx.value,
      gas: 300_000n,
      nonce: 9,
    });

    const result = await run();

    expect(result.success).toBe(false);
    expect(result.output).toContain("refused before signing");
    expect(result.output).toContain("Nothing was signed");
    // Refused by the PROVENANCE layer: these bytes are not the ones this
    // execute built. The floor layer's own refusal is proven over the guard
    // directly (`tools/uniswap/final-request-gate.test.ts`), where the built
    // transaction can be made to BE the tampered one.
    expect(result.output).toContain("byte-for-byte");
    expect(result.data).toMatchObject({ status: "not_attempted", failureCode: "build_integrity" });
  });

  it("refuses a request whose calldata pays the output to someone else", async () => {
    const snapshot = await approved();
    alteredRequest = (tx) => ({
      to: tx.to as `0x${string}`,
      data: buildSwapTx({
        deployment: ROBINHOOD_DEPLOYMENT,
        route: { version: "v2", path: [TOKEN_IN, TOKEN_OUT], amountOut: QUOTED_OUT },
        amountIn: AMOUNT_IN_RAW,
        minAmountOut: BigInt(snapshot.approvedMinOutRaw),
        // The approved floor, the approved router, the approved path - and the
        // proceeds sent to an address the human never saw.
        recipient: getAddress("0x9999999999999999999999999999999999999999"),
        deadline: 1_900_000_000n,
        tokenInIsNative: false,
        tokenOutIsNative: false,
      }).data,
      value: tx.value,
      gas: 300_000n,
      nonce: 9,
    });

    const result = await run();

    expect(result.success).toBe(false);
    expect(result.output).toContain("byte-for-byte");
    expect(result.data).toMatchObject({ status: "not_attempted", failureCode: "build_integrity" });
  });

  it("refuses a request retargeted at another contract", async () => {
    alteredRequest = (tx) => ({
      to: "0x9999999999999999999999999999999999999999",
      data: tx.data, value: tx.value, gas: 300_000n, nonce: 9,
    });

    const result = await run();

    expect(result.success).toBe(false);
    expect(result.output).toContain("not the router");
    expect(result.data).toMatchObject({ status: "not_attempted", failureCode: "build_integrity" });
  });

  it("refuses a request that attaches native value to an ERC-20 input trade", async () => {
    alteredRequest = (tx) => ({
      to: tx.to as `0x${string}`, data: tx.data, value: 1n, gas: 300_000n, nonce: 9,
    });

    const result = await run();

    expect(result.success).toBe(false);
    expect(result.output).toContain("native value");
    expect(result.data).toMatchObject({ status: "not_attempted", failureCode: "build_integrity" });
  });
});
