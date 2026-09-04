/**
 * `uniswap.swap.execute` is bound to the quote the agent was shown.
 *
 * ## The incident shape this file reproduces
 *
 * 2026-08-27, on the sibling venue: a quote showed 313,879.7 CCF at 500 bps;
 * the CONFIRMED fill was 1,190.145 CCF - 263x worse - and nothing reverted. The
 * guard passed, because the execute RE-QUOTED at broadcast time and derived the
 * price floor from the FRESH route. A floor rederived from a 263x-worse route
 * is 263x lower, so it accepted the build and signed.
 *
 * The Uniswap lane had the same defect by construction: `computeQuote` produced
 * both the shown output AND the `minAmountOut` written into calldata, and the
 * execute called it again at broadcast time.
 *
 * ## How red is proved
 *
 * `oldFloor` below is literally what the previous code computed:
 * `applySlippage(freshRoute.amountOut, slippageBps)` - the REAL function, over
 * the fresh route. The first test asserts that this old floor is far below the
 * approved one AND that it would have been satisfied by the collapsed route,
 * while the handler refuses. If the handler ever goes back to deriving from the
 * fresh route, that refusal assertion fails.
 *
 * ## What must keep working
 *
 * Owner constraint (2026-08-28): "safe, and it has to keep working". Movement
 * WITHIN the approved slippage still signs - that is the second test - and no
 * refusal here is a zero-tolerance comparison.
 *
 * The route builder and the floor arithmetic are REAL throughout: the calldata
 * asserted below is decoded from bytes `buildSwapTx` actually encoded. Only the
 * provider, the chain, the wallet, the DB and the broadcaster are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { uniswapSpendabilityFake } from "./_uniswap-spendability-fake.js";
import { decodeFunctionData, getAddress, parseUnits, type Hex } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const TOKEN_IN = getAddress("0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b");
const TOKEN_OUT = getAddress("0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31");
const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const ROUTER = getAddress("0x89e5db8b5aa49aa85ac63f691524311aeb649eba");
const CHAIN_ID = 4663;

const quoteBestRoute = vi.fn();
const runStagedBroadcast = vi.fn();
const claimUniswapExecutionSnapshot = vi.fn();
const createAgentActivityPreBroadcastFailure = vi.fn();
const createAgentActivityIntent = vi.fn();

vi.mock("@tools/uniswap/chains.js", () => ({
  resolveUniswapDeployment: vi.fn(() => ({
    key: "robinhood", name: "Robinhood Chain", chainId: CHAIN_ID, weth: WETH,
    v2: { router02: ROUTER, factory: "0x2222222222222222222222222222222222222222" },
  })),
  resolveUniswapChainId: vi.fn(() => CHAIN_ID),
}));
vi.mock("@tools/uniswap/evm-client.js", () => ({
  // WP2-U: the quote and every leg's pre-sign gate read balances and price the
  // leg plan through this client. A SOLVENT default keeps each suite's own
  // subject the thing that decides its outcome.
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
// `applySlippage` stays REAL - it is the floor arithmetic under test on both
// sides of the change, and a mocked one would prove nothing about either.
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
vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: vi.fn(async (
    _p: unknown, _w: unknown, _tx: unknown,
    hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> },
  ) => {
    await hooks.onHashStaged({ txHash: "0xfee", fromAddress: WALLET, nonce: 9 });
    await hooks.onAccepted();
    return { kind: "confirmed", txHash: "0xfee", receipt: { blockNumber: 2n } };
  }),
}));
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
// The staged loop itself is exercised in `uniswap-execute-staged-broadcast`.
// Here it is the CAPTURE point for the calldata the handler decided to sign.
vi.mock("@vex-agent/tools/protocols/uniswap/handlers/swap/execute-broadcast.js", () => ({
  runStagedBroadcast: (...args: unknown[]) => runStagedBroadcast(...args),
}));
// The claim's DB half runs against real Postgres in
// `integration/repos/swap-prequotes-claim.int.test.ts`. Here it stands for "the
// store handed the execute THIS approved quote".
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
const { UNISWAP_V2_ROUTER_ABI } = await import("@tools/uniswap/abis.js");
const { approvedUniswapSnapshot } = await import("./_uniswap-approved-snapshot.js");
const { snapshotRefusal } = await import("@vex-agent/tools/protocols/quote-authority/refusal.js");

const execute = UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"];
if (execute === undefined) throw new Error("uniswap.swap.execute is not registered");
const quote = UNISWAP_SWAP_HANDLERS["uniswap.swap.quote"];
if (quote === undefined) throw new Error("uniswap.swap.quote is not registered");

const context: ProtocolExecutionContext = {
  sessionPermission: "full", approved: true, sessionId: "session-1",
  walletResolution: { source: "default" }, walletPolicy: { kind: "none" },
};

const SLIPPAGE_BPS = 500;
const AMOUNT_IN_HUMAN = "1";
const AMOUNT_IN_RAW = parseUnits(AMOUNT_IN_HUMAN, 18);

/** What the agent was SHOWN: 313,879.7 of the output token. */
const QUOTED_OUT = parseUnits("313879.7", 18);
/** What the market collapsed to before the execute ran: 263x worse. */
const COLLAPSED_OUT = parseUnits("1190.145", 18);

const TOKEN_IN_LEG = { address: TOKEN_IN, symbol: "TKN", decimals: 18, isNative: false } as const;
const TOKEN_OUT_LEG = { address: TOKEN_OUT, symbol: "TKN", decimals: 18, isNative: false } as const;

function freshRoute(amountOut: bigint) {
  return { route: { version: "v2" as const, path: [TOKEN_IN, TOKEN_OUT], amountOut }, priceImpact: 0.001 };
}

async function approved(overrides: {
  readonly approvedAmountOutRaw?: bigint;
  readonly approvedMinOutRaw?: bigint;
  readonly amountInRaw?: bigint;
  readonly tokenIn?: typeof TOKEN_IN_LEG;
} = {}) {
  const amountInRaw = overrides.amountInRaw ?? AMOUNT_IN_RAW;
  const approvedAmountOutRaw = overrides.approvedAmountOutRaw ?? QUOTED_OUT;
  return approvedUniswapSnapshot({
    chainId: CHAIN_ID,
    tokenIn: overrides.tokenIn ?? TOKEN_IN_LEG,
    tokenOut: TOKEN_OUT_LEG,
    amountInRaw,
    approvedAmountOutRaw,
    approvedMinOutRaw: overrides.approvedMinOutRaw ?? applySlippage(approvedAmountOutRaw, SLIPPAGE_BPS),
    slippageBps: SLIPPAGE_BPS,
  });
}

function run(params: Record<string, unknown> = {}) {
  return execute(
    { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT_IN_HUMAN, slippageBps: SLIPPAGE_BPS, ...params },
    context,
  );
}

/** The `amountOutMin` in the bytes the handler actually decided to sign. */
function signedFloor(): bigint {
  const call = runStagedBroadcast.mock.calls.at(-1);
  if (!call) throw new Error("nothing was broadcast");
  const tx = call[1] as { to: Hex; data: Hex; value: bigint };
  const decoded = decodeFunctionData({ abi: UNISWAP_V2_ROUTER_ABI, data: tx.data });
  if (decoded.functionName !== "swapExactTokensForTokensSupportingFeeOnTransferTokens") {
    throw new Error(`unexpected router call: ${decoded.functionName}`);
  }
  return decoded.args[1];
}

beforeEach(async () => {
  vi.clearAllMocks();
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
    ok: true, prequoteId: "prequote-incident", snapshot: await approved(),
  });
  quoteBestRoute.mockResolvedValue(freshRoute(QUOTED_OUT));
});

describe("the 2026-08-27 incident shape", () => {
  it("refuses when the market collapsed 263x below the approved floor, and nothing is signed", async () => {
    const snapshot = await approved();
    quoteBestRoute.mockResolvedValue(freshRoute(COLLAPSED_OUT));

    // THE OLD BEHAVIOUR, computed with the real function the old code used.
    const oldFloor = applySlippage(COLLAPSED_OUT, SLIPPAGE_BPS);
    // It would have accepted the collapsed route: the floor moved WITH the
    // market instead of bounding it.
    expect(oldFloor).toBeLessThan(COLLAPSED_OUT);
    expect(oldFloor * 100n).toBeLessThan(BigInt(snapshot.approvedMinOutRaw));

    const result = await run();

    expect(result.success).toBe(false);
    expect(runStagedBroadcast).not.toHaveBeenCalled();
    // The way OUT leads the rendered line: a `VexError` hint is rendered first
    // and the message+hint pair is capped together, so an actionable tail would
    // be the part a long message loses.
    expect(result.output).toContain("the floor was not lowered");
    expect(result.output).toContain("uniswap__swap_quote");
    expect(result.output).toContain("no current Uniswap route reaches the approved floor");
    expect(result.output).toContain("298185.715");
  });

  it("signs the APPROVED floor, not one rederived from the fresh route", async () => {
    const snapshot = await approved();
    // Inside the 500 bps the human approved: the market moved 2%, the fresh
    // route is worse than the quote, and this MUST still execute.
    const movedWithinTolerance = (QUOTED_OUT * 98n) / 100n;
    quoteBestRoute.mockResolvedValue(freshRoute(movedWithinTolerance));

    const result = await run();

    expect(result.success).toBe(true);
    const floor = signedFloor();
    expect(floor.toString()).toBe(snapshot.approvedMinOutRaw);
    // The old derivation would have written a LOWER number into the calldata.
    expect(applySlippage(movedWithinTolerance, SLIPPAGE_BPS)).toBeLessThan(floor);
  });

  it("still executes when the market moved in the trader's favour", async () => {
    const snapshot = await approved();
    quoteBestRoute.mockResolvedValue(freshRoute(QUOTED_OUT * 2n));

    const result = await run();

    expect(result.success).toBe(true);
    // The floor is the approved one - a better market does not raise it, and
    // raising it would be a bound the human never authorized.
    expect(signedFloor().toString()).toBe(snapshot.approvedMinOutRaw);
  });
});

describe("the claim", () => {
  it("is taken BEFORE any route is priced, so a spent quote never re-quotes", async () => {
    claimUniswapExecutionSnapshot.mockResolvedValue({
      ok: false, refusal: snapshotRefusal("already_claimed", "uniswap__swap_quote"),
    });

    const result = await run();

    expect(result.success).toBe(false);
    expect(quoteBestRoute).not.toHaveBeenCalled();
    expect(runStagedBroadcast).not.toHaveBeenCalled();
    expect(result.output).toContain("authorizes exactly one attempt");
  });

  it.each(["superseded", "expired", "digest_mismatch", "not_executable"] as const)(
    "surfaces the typed %s refusal with a fresh quote as the way out",
    async (kind) => {
      claimUniswapExecutionSnapshot.mockResolvedValue({
        ok: false, refusal: snapshotRefusal(kind, "uniswap__swap_quote"),
      });

      const result = await run();

      expect(result.success).toBe(false);
      expect(result.output).toContain("uniswap__swap_quote");
      expect(runStagedBroadcast).not.toHaveBeenCalled();
    },
  );
});

describe("router input and fee drift", () => {
  it("refuses when the amount reaching the router is not the approved one", async () => {
    // The approved quote was answered for a DIFFERENT total, so the router
    // input derived from it cannot match this execute's.
    claimUniswapExecutionSnapshot.mockResolvedValue({
      ok: true, prequoteId: "p", snapshot: await approved({ amountInRaw: AMOUNT_IN_RAW * 2n }),
    });

    const result = await run();

    expect(result.success).toBe(false);
    expect(runStagedBroadcast).not.toHaveBeenCalled();
    expect(result.output).toContain("the amount that would reach the router changed");
    expect(result.output).toContain("were not altered to make the swap fit");
  });

  it("refuses when the approved quote carried no fee and one now applies", async () => {
    const snapshot = await approved();
    claimUniswapExecutionSnapshot.mockResolvedValue({
      ok: true,
      prequoteId: "p",
      // Sealed by the codec, so the row is internally consistent: this is a
      // quote genuinely answered with no fee, met by an execute that charges.
      snapshot: (await import("@vex-agent/tools/protocols/quote-authority/uniswap.js")).sealUniswapSnapshot({
        ...snapshot,
        totalInRaw: AMOUNT_IN_RAW.toString(),
        swapAmountRaw: AMOUNT_IN_RAW.toString(),
        fee: { disposition: "not_charged", amountRaw: null, disclosureText: "No Vex fee was taken." },
      }),
    });

    const result = await run();

    expect(result.success).toBe(false);
    expect(runStagedBroadcast).not.toHaveBeenCalled();
    // The router input moved with the fee; the agent is told the figure that
    // decides what leaves the wallet.
    expect(result.output).toContain("the amount that would reach the router changed");
  });

  it("refuses when the fee alone resolved differently than it was disclosed", async () => {
    const snapshot = await approved();
    const { sealUniswapSnapshot } = await import("@vex-agent/tools/protocols/quote-authority/uniswap.js");
    claimUniswapExecutionSnapshot.mockResolvedValue({
      ok: true,
      prequoteId: "p",
      snapshot: sealUniswapSnapshot({
        ...snapshot,
        fee: { ...snapshot.fee, disclosureText: `${snapshot.fee.disclosureText} (older wording)` },
      }),
    });

    const result = await run();

    expect(result.success).toBe(false);
    expect(result.output).toContain("resolved differently than at quote time");
    expect(runStagedBroadcast).not.toHaveBeenCalled();
  });
});

describe("venue honesty", () => {
  it("refuses a canonical native/wrapped-native pair by name, on the quote", async () => {
    const result = await quote(
      { chain: "robinhood", tokenIn: "native", tokenOut: WETH, amountIn: "1" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("WalletWrapPrepare");
    expect(result.output).toContain("WalletWrapConfirm");
    expect(result.output).toContain("1:1");
    expect(quoteBestRoute).not.toHaveBeenCalled();
  });

  it("refuses the same pair on the execute, before any quote is claimed", async () => {
    const result = await run({ tokenIn: "native", tokenOut: WETH });

    expect(result.success).toBe(false);
    expect(result.output).toContain("WalletWrapPrepare");
    expect(claimUniswapExecutionSnapshot).not.toHaveBeenCalled();
  });

  it("states what was actually probed when no route exists, never 'may have no liquidity'", async () => {
    quoteBestRoute.mockResolvedValue(undefined);

    // The quote lane surfaces this through the runtime's error boundary, so the
    // contract under test is the authored VexError, not a ToolResult string.
    const err = await quote(
      { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" },
      context,
    ).then(() => null, (e: unknown) => e as { message: string; hint?: string });

    expect(err).not.toBeNull();
    const text = `${err?.message ?? ""} ${err?.hint ?? ""}`;
    expect(text).toContain("V2 pairs");
    expect(text).toContain("Uniswap v4");
    expect(text).toContain("not visible to this venue");
    expect(text).not.toContain("may have no liquidity");
  });
});

describe("the quote seals what it authorizes", () => {
  it("hands the recorder a snapshot on the PRIVATE channel, never model context", async () => {
    const result = await quote(
      { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT_IN_HUMAN, slippageBps: SLIPPAGE_BPS },
      context,
    );

    expect(result.success).toBe(true);
    const snapshot = result.quoteAuthority?.routeSnapshot;
    expect(snapshot).toBeDefined();
    if (!snapshot) return;
    expect(snapshot.provider).toBe("uniswap");
    expect(snapshot.approvedAmountOutRaw).toBe(QUOTED_OUT.toString());
    expect(snapshot.approvedMinOutRaw).toBe(applySlippage(QUOTED_OUT, SLIPPAGE_BPS).toString());
    // The router input is the amount AFTER the fee, which is what the route was
    // priced for - stating the gross would advertise an output nobody receives.
    expect(BigInt(String(snapshot.swapAmountRaw))).toBeLessThan(AMOUNT_IN_RAW);
    expect(snapshot.totalInRaw).toBe(AMOUNT_IN_RAW.toString());
    expect(String(result.output)).not.toContain(String(snapshot.digest));
  });
});
