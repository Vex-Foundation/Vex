/**
 * `uniswap.swap.quote` - a route the wallet cannot pay for is still a route,
 * and it authorizes nothing.
 *
 * ## The defect this file pins
 *
 * Before WP2-U the Uniswap quote answered a route and recorded it as
 * `executable` without ever asking whether the selected wallet held the input
 * token or enough native to broadcast the swap's legs. A successful quote was
 * therefore readable as a confirmation that the balance was there, which is the
 * exact reading contract C2 removes: the route and the authority are two fields,
 * and the wallet decides the second.
 *
 * ## What is asserted, and why in this shape
 *
 * The handler is driven end to end over a fake public client, so the assertions
 * run through the REAL leg planner, the REAL debit arithmetic and the REAL
 * shared evaluator - the same three the pre-sign gate uses. A test that stubbed
 * `evaluateSpendability` would prove only that the venue calls something.
 *
 * The three balance verdicts are kept apart on purpose (rule 04, contract C2.3):
 * a wallet that is SHORT, a wallet whose balance could not be READ, and a wallet
 * that cannot cover the NATIVE debit have three different remedies, and
 * collapsing any two of them is the defect.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, parseUnits } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import {
  uniswapSpendabilityFake,
  type UniswapSpendabilityFakeOptions,
} from "./_uniswap-spendability-fake.js";

const TOKEN_IN = getAddress("0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b");
const TOKEN_OUT = getAddress("0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31");
const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const ROUTER = getAddress("0x89e5db8b5aa49aa85ac63f691524311aeb649eba");
const CHAIN_ID = 4663;
/** The shared EVM native sentinel, as every Vex row spells it. */
const NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const AMOUNT_IN = "1";
const AMOUNT_IN_RAW = parseUnits(AMOUNT_IN, 18);
const QUOTED_OUT = parseUnits("1000", 18);

const quoteBestRoute = vi.fn();
const resolveSelectedAddress = vi.fn(() => WALLET as string);
let clientOptions: UniswapSpendabilityFakeOptions = {};
let nativeInput = false;
let feeDeclined = false;

vi.mock("@tools/uniswap/chains.js", () => ({
  resolveUniswapDeployment: vi.fn(() => ({
    key: "robinhood", name: "Robinhood Chain", chainId: CHAIN_ID, weth: WETH,
    v2: { router02: ROUTER, factory: "0x2222222222222222222222222222222222222222" },
  })),
  resolveUniswapChainId: vi.fn(() => CHAIN_ID),
}));
vi.mock("@tools/uniswap/evm-client.js", () => ({
  getUniswapPublicClient: vi.fn(() => uniswapSpendabilityFake(clientOptions)),
  getUniswapEvmClients: vi.fn(() => ({
    publicClient: uniswapSpendabilityFake(clientOptions), walletClient: {},
  })),
}));
vi.mock("@tools/uniswap/erc20.js", () => ({
  readUniswapErc20Metadata: vi.fn(async (_client: unknown, address: string) => ({
    address, symbol: "TKN", decimals: 18, isNative: false,
  })),
  validateUniswapSpender: vi.fn(),
  // Allowance in place by default: the allowance legs are a separate axis, and
  // the suite's subject is the balance verdict.
  readUniswapAllowance: vi.fn(async () => 10n ** 40n),
}));
// `applySlippage` stays REAL: the floor in the snapshot is real arithmetic.
vi.mock("@tools/uniswap/quote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/uniswap/quote.js")>()),
  quoteBestRoute: (...args: unknown[]) => quoteBestRoute(...args),
}));
vi.mock("@tools/uniswap/safety.js", () => ({
  checkRouteFactories: vi.fn(async () => ({ checked: true, allowlisted: true })),
  probeFotSignal: vi.fn(async () => false),
  UNISWAP_MIN_LIQUIDITY_USD: 5000,
}));
vi.mock("@tools/dexscreener/price-read.js", () => ({ readTokensPairs: vi.fn(async () => []) }));
vi.mock("@tools/evm-chains/registry.js", () => ({ getLocalChain: vi.fn(() => ({ chainId: CHAIN_ID })) }));
// The fee-eligibility oracle is a token fact, never a network call in a unit test.
vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    // `feeDeclined` makes Vex skip the fee for this token, which is the one
    // difference between the two runs in the fee-leg assertion below.
    getHoneypotFotInfo: async () => ({ isHoneypot: false, isFOT: feeDeclined, tax: 0 }),
  }),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (...args: unknown[]) => resolveSelectedAddress(...(args as [])),
  resolveSigningWallet: vi.fn(() => ({ family: "eip155", address: WALLET, privateKey: `0x${"ab".repeat(32)}` })),
  walletScopeErrorToResult: vi.fn((err: unknown) => ({ success: false, output: String(err) })),
}));
vi.mock("@utils/logger.js", () => {
  const stub = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { UNISWAP_SWAP_HANDLERS } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap.js");
const { PRICE_IMPACT_EXCESSIVE_FRACTION } = await import(
  "@vex-agent/tools/protocols/quote-authority/eligibility.js"
);

const quote = UNISWAP_SWAP_HANDLERS["uniswap.swap.quote"];
if (quote === undefined) throw new Error("uniswap.swap.quote is not registered");

const context: ProtocolExecutionContext = {
  sessionPermission: "full", approved: true, sessionId: "session-1",
  walletResolution: { source: "default" }, walletPolicy: { kind: "none" },
};

/** A direct V2 route with a benign measured impact - the route half is fine. */
function benignRoute(priceImpact = 0.001) {
  return {
    route: { version: "v2" as const, path: [TOKEN_IN, TOKEN_OUT], amountOut: QUOTED_OUT },
    priceImpact,
  };
}

async function run(): Promise<{
  readonly result: Awaited<ReturnType<typeof quote>>;
  readonly data: Record<string, unknown>;
}> {
  const result = await quote(
    {
      chain: "robinhood",
      tokenIn: nativeInput ? "native" : TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: AMOUNT_IN,
      slippageBps: 500,
    },
    context,
  );
  return { result, data: JSON.parse(result.output as string) as Record<string, unknown> };
}

/** The eligibility block the model sees. */
function eligibilityOf(data: Record<string, unknown>): Record<string, unknown> {
  return data.eligibility as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  nativeInput = false;
  feeDeclined = false;
  resolveSelectedAddress.mockReturnValue(WALLET);
  quoteBestRoute.mockResolvedValue(benignRoute());
  // A solvent wallet on a cheap chain: every figure below is overridden by the
  // test that is about it.
  clientOptions = { tokenBalanceRaw: 10n ** 30n, nativeBalanceWei: 10n ** 18n };
});

describe("uniswap.swap.quote spendability over the SOURCE asset", () => {
  it("refuses to authorize an execute when the wallet is short, and still returns the route", async () => {
    clientOptions = { ...clientOptions, tokenBalanceRaw: AMOUNT_IN_RAW - 1n };

    const { result, data } = await run();

    expect(result.success).toBe(true);
    // The ROUTE is still here - both wallet references keep a quote they cannot
    // fund rather than hiding it.
    expect((data.route as { path: string[] }).path).toEqual([TOKEN_IN, TOKEN_OUT]);
    expect(data.amountOutRaw).toBe(QUOTED_OUT.toString());
    // The AUTHORITY is not: a superseding, non-claimable row with no snapshot.
    expect(result.quoteAuthority?.eligibilityKind).toBe("insufficient_balance");
    expect(result.quoteAuthority?.routeSnapshot).toBeNull();
    expect(result.quoteAuthority?.spendability).toBeUndefined();
    expect(eligibilityOf(data)).toMatchObject({
      kind: "insufficient_balance", executable: false, balanceChecked: true,
    });
    const note = String(data.eligibilityNote);
    expect(note).toContain("does NOT authorize an execute");
    expect(note).toContain("required");
    expect(note).toContain("missing");
  });

  it("requires the FULL requested amount, not the router's net figure after the Vex fee", async () => {
    // Exactly the amount the ROUTER receives, one wei short of the total the
    // wallet is debited. The fee leg takes the remainder out of the same asset,
    // so this wallet cannot complete the trade it was quoted.
    const swapAmount = (data: Record<string, unknown>): bigint => BigInt(String(data.swapAmountRaw));
    clientOptions = { ...clientOptions, tokenBalanceRaw: AMOUNT_IN_RAW };
    const solvent = await run();
    expect(solvent.result.quoteAuthority?.eligibilityKind).toBe("executable");

    clientOptions = { ...clientOptions, tokenBalanceRaw: swapAmount(solvent.data) };
    const short = await run();

    expect(swapAmount(solvent.data)).toBeLessThan(AMOUNT_IN_RAW);
    expect(short.result.quoteAuthority?.eligibilityKind).toBe("insufficient_balance");
  });
});

describe("uniswap.swap.quote spendability over the NATIVE debit", () => {
  it("refuses an ERC-20 swap whose wallet cannot pay the gas of every leg plus the reserve", async () => {
    // Plenty of the input token, almost no native. An ERC-20 swap still needs
    // native (contract C2.5), and this is the leg that says so.
    clientOptions = { ...clientOptions, nativeBalanceWei: 1n };

    const { result, data } = await run();

    expect(result.quoteAuthority?.eligibilityKind).toBe("gas_reserve_insufficient");
    expect(result.quoteAuthority?.routeSnapshot).toBeNull();
    expect(eligibilityOf(data)).toMatchObject({ kind: "gas_reserve_insufficient", executable: false });
    const note = String(data.eligibilityNote);
    expect(note).toContain("native gas debit");
    expect(note).toContain("reserve");
  });

  it("counts the Vex fee leg from the first window: its gas is inside the total before anything is signed", async () => {
    const withFee = await run();
    const withFeeRequired = BigInt(withFee.result.quoteAuthority?.spendability?.native.required.raw ?? "0");

    // The SAME trade with no fee leg at all - a token Vex declines to skim.
    // The only difference between the two totals is that leg.
    feeDeclined = true;
    const withoutFee = await run();
    const withoutFeeRequired = BigInt(withoutFee.result.quoteAuthority?.spendability?.native.required.raw ?? "0");

    expect(withFee.result.quoteAuthority?.eligibilityKind).toBe("executable");
    expect(withoutFee.result.quoteAuthority?.eligibilityKind).toBe("executable");
    expect(withFeeRequired).toBeGreaterThan(withoutFeeRequired);
  });

  it("covers a NATIVE input's whole debit: the requested amount is not the whole cost", async () => {
    nativeInput = true;
    // Exactly the amount the user asked to spend. The source leg is satisfied by
    // it; the native leg is not, because the same balance also has to pay the
    // swap's gas, the fee transfer's gas and the follow-up reserve.
    clientOptions = { ...clientOptions, nativeBalanceWei: AMOUNT_IN_RAW };

    const { result } = await run();

    expect(result.quoteAuthority?.eligibilityKind).toBe("gas_reserve_insufficient");
    expect(result.quoteAuthority?.routeSnapshot).toBeNull();
  });
});

describe("uniswap.swap.quote when a balance cannot be READ", () => {
  it("fails closed as balance_unavailable rather than reporting a shortfall", async () => {
    clientOptions = { ...clientOptions, nativeReadFails: true };

    const { result, data } = await run();

    expect(result.quoteAuthority?.eligibilityKind).toBe("balance_unavailable");
    expect(result.quoteAuthority?.routeSnapshot).toBeNull();
    expect(eligibilityOf(data)).toMatchObject({ kind: "balance_unavailable", executable: false });
    const note = String(data.eligibilityNote);
    expect(note).toContain("could not be read");
    expect(note).toContain("fails closed");
    // NEVER the shortfall wording: "reduce the amount" is wrong advice for a
    // read that failed.
    expect(note).not.toContain("does not hold enough");
  });
});

describe("uniswap.swap.quote when the wallet CAN pay", () => {
  it("authorizes the execute and hands the recorder the quote-time observation", async () => {
    const { result, data } = await run();

    expect(result.quoteAuthority?.eligibilityKind).toBe("executable");
    expect(result.quoteAuthority?.routeSnapshot).not.toBeNull();
    expect(eligibilityOf(data)).toMatchObject({
      kind: "executable", executable: true, balanceChecked: true, impactMeasured: true,
    });

    const preview = result.quoteAuthority?.spendability;
    expect(preview?.cardVersion).toBe("spendability-v1");
    // Both legs, both read at the tag a spend may be authorized from.
    expect(preview?.source.blockTag).toBe("pending");
    expect(preview?.native.blockTag).toBe("pending");
    expect(preview?.source.asset.address).toBe(TOKEN_IN);
    expect(preview?.native.asset.address).toBe(NATIVE_SENTINEL);
    // The SOURCE requirement is the full debited amount, exactly.
    expect(preview?.source.required.raw).toBe(AMOUNT_IN_RAW.toString());
    // The NATIVE requirement is a real cost that includes the reserve, so it is
    // strictly more than the gas of the legs alone and never zero.
    expect(BigInt(preview?.native.required.raw ?? "0")).toBeGreaterThan(0n);
    // The note says WHEN the figures were true and where the authority is.
    expect(String(data.eligibilityNote)).toContain("authoritative read happens immediately before signing");
  });

  it("says out loud when the swap leg could not be priced yet, instead of implying the whole cost was checked", async () => {
    // The real shape: an ERC-20 the router may not move yet cannot be simulated,
    // so the SWAP leg's gas is unknown until the allowance lands, while the
    // approve leg and the reserve estimate normally.
    clientOptions = { ...clientOptions, estimateFailsForTargets: [ROUTER] };

    const { result, data } = await run();

    expect(result.quoteAuthority?.eligibilityKind).toBe("executable");
    const note = String(data.eligibilityNote);
    expect(note).toContain("LOWER BOUND");
    expect(note).toContain("could not be estimated");
  });
});

describe("uniswap.swap.quote reads no balance when it would decide nothing", () => {
  it("skips the wallet entirely for a route the ceiling already refused", async () => {
    quoteBestRoute.mockResolvedValue(benignRoute(PRICE_IMPACT_EXCESSIVE_FRACTION + 0.01));

    const { result, data } = await run();

    expect(result.quoteAuthority?.eligibilityKind).toBe("excessive_impact");
    expect(eligibilityOf(data)).toMatchObject({ executable: false, balanceChecked: false });
    // Re-funding the wallet would not make this route safe, and the answer says
    // so instead of reporting a balance verdict about it.
    expect(String(data.eligibilityNote)).toContain("not executable for a reason no balance would change");
  });

  it("states that nothing was read when the session has no EVM wallet selected", async () => {
    resolveSelectedAddress.mockImplementation(() => {
      throw new Error("no wallet selected");
    });

    const { result, data } = await run();

    // The route still stands - and so does the snapshot, because the recorder
    // writes no claimable row for a session with no resolvable wallet at all.
    expect(result.quoteAuthority?.eligibilityKind).toBe("executable");
    expect(eligibilityOf(data)).toMatchObject({ executable: true, balanceChecked: false });
    expect(result.quoteAuthority?.spendability).toBeUndefined();
    expect(String(data.eligibilityNote)).toContain("No EVM wallet is selected");
  });
});
