/**
 * `uniswap.swap.quote` - which quotes may authorize a swap on the venue that
 * measures its OWN price impact.
 *
 * ## The defect this file pins
 *
 * The agent's task shape promises that impact at or above 15% of the input's
 * reference value is refused. On the sibling venue that promise was enforced by
 * `classifyQuoteEligibility` over the provider's USD legs. Uniswap has no USD
 * legs - it measures impact itself from a direct V2 pair's reserves - and its
 * handler recorded `eligibilityKind: "executable"` unconditionally, so a
 * measured 16%-impact quote stayed claimable and the promise was false.
 *
 * The thresholds are NOT restated here: the expectations are derived from
 * `PRICE_IMPACT_WARN_FRACTION` / `PRICE_IMPACT_EXCESSIVE_FRACTION`, so a test
 * that passes cannot be one that copied a constant which later moved.
 *
 * ## The honest third case
 *
 * A V3 or multi-hop route has no reference at all: `computeV2DirectPriceImpact`
 * returns `undefined` by construction. That quote stays executable - refusing
 * every V3 trade would be a fabrication in the other direction - and the answer
 * SAYS the impact was not measurable, because a silent absence reads as "impact
 * was fine".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { uniswapSpendabilityFake } from "./_uniswap-spendability-fake.js";
import { getAddress, parseUnits } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const TOKEN_IN = getAddress("0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b");
const TOKEN_OUT = getAddress("0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31");
const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const ROUTER = getAddress("0x89e5db8b5aa49aa85ac63f691524311aeb649eba");
const CHAIN_ID = 4663;

const quoteBestRoute = vi.fn();

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
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => WALLET),
  resolveSigningWallet: vi.fn(() => ({ family: "eip155", address: WALLET, privateKey: `0x${"ab".repeat(32)}` })),
  walletScopeErrorToResult: vi.fn((err: unknown) => ({ success: false, output: String(err) })),
}));
vi.mock("@utils/logger.js", () => {
  const stub = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { UNISWAP_SWAP_HANDLERS } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap.js");
const {
  PRICE_IMPACT_WARN_FRACTION,
  PRICE_IMPACT_EXCESSIVE_FRACTION,
} = await import("@vex-agent/tools/protocols/quote-authority/eligibility.js");

const quote = UNISWAP_SWAP_HANDLERS["uniswap.swap.quote"];
if (quote === undefined) throw new Error("uniswap.swap.quote is not registered");

const context: ProtocolExecutionContext = {
  sessionPermission: "full", approved: true, sessionId: "session-1",
  walletResolution: { source: "default" }, walletPolicy: { kind: "none" },
};

const AMOUNT_IN = "1";
const QUOTED_OUT = parseUnits("1000", 18);

/** A direct V2 route WITH a measured impact - the case this venue can price. */
function measured(priceImpact: number) {
  return { route: { version: "v2" as const, path: [TOKEN_IN, TOKEN_OUT], amountOut: QUOTED_OUT }, priceImpact };
}

/**
 * A route with NO impact reference. Modelled as a MULTI-HOP V2 route, which is
 * one of the real shapes `computeV2DirectPriceImpact` declines to price (the
 * others being V3 and unreadable reserves); the handler sees the same
 * `priceImpact: undefined` for all three.
 */
function unmeasured() {
  return { route: { version: "v2" as const, path: [TOKEN_IN, WETH, TOKEN_OUT], amountOut: QUOTED_OUT } };
}

function run() {
  return quote(
    { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT_IN, slippageBps: 500 },
    context,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("uniswap.swap.quote eligibility over MEASURED impact", () => {
  it("refuses to authorize an execute at or above the shared ceiling, and says why", async () => {
    // Above the ceiling by a whole point, so the assertion cannot be an
    // artefact of a boundary rounding.
    quoteBestRoute.mockResolvedValue(measured(PRICE_IMPACT_EXCESSIVE_FRACTION + 0.01));

    const result = await run();
    const data = JSON.parse(result.output) as Record<string, unknown>;

    // What reaches the RECORDER: a superseding, non-claimable verdict with no
    // snapshot to execute against.
    expect(result.quoteAuthority?.eligibilityKind).toBe("excessive_impact");
    expect(result.quoteAuthority?.routeSnapshot).toBeNull();
    // What reaches the AGENT: the same verdict, and the way forward.
    expect(data.eligibility).toMatchObject({ kind: "excessive_impact", executable: false });
    expect(String(data.impactNote)).toContain("does NOT authorize an execute");
    expect(String(data.impactNote)).toContain("16.00%");
    // The private channel never leaks into model-visible output.
    expect(result.output).not.toContain("routeSnapshot");
  });

  it("is red if the ceiling stops being applied: the same route at the ceiling exactly is still refused", async () => {
    quoteBestRoute.mockResolvedValue(measured(PRICE_IMPACT_EXCESSIVE_FRACTION));

    const result = await run();

    expect(result.quoteAuthority?.eligibilityKind).toBe("excessive_impact");
    expect(result.quoteAuthority?.routeSnapshot).toBeNull();
  });

  it("stays executable below the ceiling but discloses an adverse fill", async () => {
    quoteBestRoute.mockResolvedValue(measured(PRICE_IMPACT_WARN_FRACTION + 0.01));

    const result = await run();
    const data = JSON.parse(result.output) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.quoteAuthority?.eligibilityKind).toBe("executable");
    expect(result.quoteAuthority?.routeSnapshot).not.toBeNull();
    expect(data.eligibility).toMatchObject({
      kind: "executable", executable: true, impactMeasured: true, adverse: true,
    });
    expect(String(data.impactNote)).toContain("6.00%");
    expect(String(data.impactNote)).toContain("still executable");
  });

  it("does not call a benign fill adverse", async () => {
    quoteBestRoute.mockResolvedValue(measured(0.001));

    const result = await run();
    const data = JSON.parse(result.output) as Record<string, unknown>;

    expect(result.quoteAuthority?.eligibilityKind).toBe("executable");
    expect(data.eligibility).toMatchObject({ adverse: false, executable: true });
  });
});

describe("uniswap.swap.quote where impact is STRUCTURALLY unmeasured", () => {
  it("stays executable and states the non-measurability instead of implying a good price", async () => {
    quoteBestRoute.mockResolvedValue(unmeasured());

    const result = await run();
    const data = JSON.parse(result.output) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.quoteAuthority?.eligibilityKind).toBe("executable");
    expect(result.quoteAuthority?.routeSnapshot).not.toBeNull();
    expect(data.priceImpact).toBeNull();
    expect(data.eligibility).toMatchObject({
      kind: "executable", executable: true, impactMeasured: false,
    });
    expect(String(data.impactNote)).toContain("NOT measurable");
  });
});
