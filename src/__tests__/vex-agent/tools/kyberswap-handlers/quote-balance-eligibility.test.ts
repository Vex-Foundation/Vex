/**
 * `kyberswap.swap.quote` - a route the wallet cannot pay for.
 *
 * THE DEFECT THIS CLOSES. Until WP2 a successful quote read as a confirmation
 * that the trade could be funded: the handler never asked the chain what the
 * wallet held, so "here is your route" and "you can do this" were the same
 * sentence. An agent that read the first as the second proposed trades the
 * wallet could not sign, and found out only when the execute burned an
 * allowance leg and then refused.
 *
 * WHAT MUST STAY TRUE. The route is STILL RETURNED whatever the verdict
 * (contract C2.1, and what both wallet references do): what a shortfall removes
 * is the AUTHORITY of the quote, never the agent's view of the route. And the
 * three balance states stay apart (C2.3): short, unreadable, and short-on-gas
 * have three different remedies, so they are never collapsed into one.
 *
 * The arithmetic is REAL throughout - the debit total, the L1 data fee, the
 * headroom and the reserve are computed by the production modules over the
 * fake chain's answers - so a refusal here is the handler's own decision.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const mockReadErc20Metadata = vi.fn(async (_slug: string, address: string) => ({
  address, symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false as const,
}));

const mockPlanKyberAllowance = vi.fn().mockResolvedValue({ needsReset: false, needsApprove: true });

vi.mock("@tools/kyberswap/evm-utils.js", async () => ({
  ...(await import("./evm-client.test-fixtures.js")).kyberEvmClientMocks(),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: (...args: unknown[]) => mockPlanKyberAllowance(...args),
  // REAL hex: the allowance leg's bytes are serialized to price the L1 data fee
  // an OP-stack chain charges for them, so a placeholder that is not hex would
  // be testing against a transaction no chain could carry.
  buildApproveCalldata: vi.fn(() => `0x095ea7b3${"0".repeat(128)}`),
  signStageBroadcast: vi.fn(),
  decodeKyberSwapSettlement: vi.fn(),
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
    getRoute: (...a: unknown[]) => mockGetRoute(...a),
    buildRoute: (...a: unknown[]) => mockBuildRoute(...a),
  }),
}));

const mockResolveSelectedAddressForRead = vi.fn(
  (..._args: unknown[]) => "0x1234567890AbcdEF1234567890aBcdef12345678",
);
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: (...args: unknown[]) => mockResolveSelectedAddressForRead(...args),
  resolveSelectedAddress: vi.fn(),
  resolveSigningWallet: vi.fn(),
  walletScopeErrorToResult: vi.fn(),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { KYBERSWAP_HANDLERS } from "@vex-agent/tools/protocols/kyberswap/handlers.js";
import { resetEvmFake, setEvmFake } from "./evm-client.test-fixtures.js";

const TOKEN_IN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOKEN_OUT = "0x4200000000000000000000000000000000000006";
/** 10 USDC at six decimals - the exact principal every case below is judged against. */
const AMOUNT_IN_HUMAN = "10";
const AMOUNT_IN_RAW = 10_000_000n;

/** Narrow an optional, naming what was expected instead of asserting non-null. */
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`test expected ${what} to be present`);
  return value;
}

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full", approved: true,
    walletResolution: { source: "default" }, walletPolicy: { kind: "none" },
    sessionId: "session-1",
  };
}

const QUOTE_HANDLER = KYBERSWAP_HANDLERS["kyberswap.swap.quote"];
if (QUOTE_HANDLER === undefined) throw new Error("kyberswap.swap.quote is not registered");

function quote(params: Record<string, unknown> = {}) {
  return QUOTE_HANDLER(
    { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT_IN_HUMAN, ...params },
    ctx(),
  );
}

/** A priced, storable, low-impact route: everything except balance is fine. */
const ROUTE = {
  data: {
    routeSummary: {
      tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT,
      amountIn: AMOUNT_IN_RAW.toString(), amountOut: "3900000000000000",
      amountInUsd: "10", amountOutUsd: "9.99",
      gas: "287581", gasPrice: "6000000", gasUsd: "0.0042", l1FeeUsd: "0.000034",
      routeID: "r1", checksum: "c1", route: [],
    },
    routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
  },
};

/**
 * The build response, with the figures MEASURED live on Base 2026-08-31 for a
 * real USDC route: `gas: "287581"`, `transactionValue: "0"` on an ERC-20 input,
 * and calldata the L1 fee is priced over.
 */
const BUILD = {
  data: {
    amountIn: AMOUNT_IN_RAW.toString(), amountInUsd: "10",
    amountOut: "3900000000000000", amountOutUsd: "9.99",
    gas: "287581", gasUsd: "0.0042",
    data: `0x${"e2".repeat(400)}`,
    routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    transactionValue: "0",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  resetEvmFake();
  mockGetRoute.mockResolvedValue(ROUTE);
  mockBuildRoute.mockResolvedValue(BUILD);
  mockPlanKyberAllowance.mockResolvedValue({ needsReset: false, needsApprove: true });
  mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
    address, symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false as const,
  }));
  mockResolveSelectedAddressForRead.mockReturnValue("0x1234567890AbcdEF1234567890aBcdef12345678");
});

describe("a wallet that cannot pay the principal", () => {
  beforeEach(() => {
    // One raw unit short of the 10 USDC the trade spends. The shortfall is the
    // smallest one that exists, which is the point: the comparison is exact
    // atomic arithmetic, never a rounded human figure.
    setEvmFake({ erc20BalanceRaw: AMOUNT_IN_RAW - 1n });
  });

  it("still answers with the route, and refuses to authorize an execute", async () => {
    const result = await quote();

    expect(result.success).toBe(true);
    const data = JSON.parse(result.output) as {
      routeSummary: { amountOut: string };
      eligibility: { kind: string; executable: boolean };
    };
    // THE ROUTE IS STILL THERE. This is the half that must never regress.
    expect(data.routeSummary.amountOut).toBe("3900000000000000");
    expect(data.eligibility).toEqual({ kind: "insufficient_balance", executable: false });
  });

  it("seeds NO claimable snapshot and supersedes with an ineligible marker", async () => {
    const result = await quote();

    expect(result.quoteAuthority?.eligibilityKind).toBe("insufficient_balance");
    expect(result.quoteAuthority?.routeSnapshot).toBeNull();
    const identity = required(result.quoteAuthority?.ineligibleIdentity, "an ineligible identity");
    expect(identity.amount).toBe(AMOUNT_IN_HUMAN);
    // No card to render for a quote that authorizes nothing.
    expect(result.quoteAuthority?.spendability).toBeUndefined();
  });

  it("names required, current and missing in the agent's own summary", async () => {
    const result = await quote();
    const { summary } = JSON.parse(result.output) as { summary: string };

    expect(summary).toContain("does not hold enough of the input token");
    expect(summary).toContain("required 10 USDC");
    expect(summary).toContain("current 9.999999 USDC");
    expect(summary).toContain("missing 0.000001 USDC");
    expect(summary).toContain("does NOT authorize an execute");
  });
});

describe("a wallet that holds the principal but cannot pay for gas", () => {
  it("refuses as gas_reserve_insufficient, never as insufficient_balance", async () => {
    // Enough for the two legs' execution gas at the fake's own price, and NOT
    // enough once the L1 data fee and the follow-up reserve join the total -
    // which is exactly the class of wallet a gas-only check would have signed.
    setEvmFake({ nativeBalanceRaw: 1_000_000_000_000n });
    const result = await quote();

    const data = JSON.parse(result.output) as {
      summary: string;
      eligibility: { kind: string };
    };
    expect(data.eligibility.kind).toBe("gas_reserve_insufficient");
    expect(data.summary).toContain("cannot cover this swap's native gas debit");
    expect(data.summary).toContain("every transaction this swap would broadcast plus a reserve");
    expect(result.quoteAuthority?.routeSnapshot).toBeNull();
  });

  it("counts every leg: dropping the allowance leg lowers the required figure", async () => {
    setEvmFake({ nativeBalanceRaw: 1n });

    mockPlanKyberAllowance.mockResolvedValue({ needsReset: true, needsApprove: true });
    const withThreeLegs = requiredAmountFrom(await quote());

    mockPlanKyberAllowance.mockResolvedValue({ needsReset: false, needsApprove: false });
    const withOneLeg = requiredAmountFrom(await quote());

    // A reset plus an approve plus the swap must cost strictly more than the
    // swap alone. Charging one leg at a time is how a wallet funds the approval
    // and then cannot pay for the trade it approved.
    expect(withThreeLegs).toBeGreaterThan(withOneLeg);
  });
});

describe("a balance that could not be read", () => {
  it("fails closed as balance_unavailable and says the read failed, not that funds are missing", async () => {
    setEvmFake({ balanceReadFailure: new Error("rpc down") });
    const result = await quote();

    const data = JSON.parse(result.output) as {
      summary: string;
      eligibility: { kind: string };
    };
    expect(data.eligibility.kind).toBe("balance_unavailable");
    expect(data.summary).toContain("could not be read");
    expect(data.summary).toContain("an unreadable balance fails closed");
    expect(data.summary).not.toContain("does not hold enough");
    expect(result.quoteAuthority?.routeSnapshot).toBeNull();
  });

  it("refuses when no wallet is selected, rather than quoting as if one were", async () => {
    mockResolveSelectedAddressForRead.mockImplementation(() => {
      throw new Error("no EVM wallet selected");
    });
    const result = await quote();

    const data = JSON.parse(result.output) as {
      routeSummary: { amountOut: string };
      eligibility: { kind: string };
    };
    // The route is a read and still answers; the AUTHORITY is what is withheld.
    expect(data.routeSummary.amountOut).toBe("3900000000000000");
    expect(data.eligibility.kind).toBe("balance_unavailable");
  });

  it("refuses when the swap transaction shape cannot be obtained at all", async () => {
    mockBuildRoute.mockRejectedValue(new Error("build unavailable"));
    const result = await quote();

    const data = JSON.parse(result.output) as { eligibility: { kind: string } };
    // Without the built transaction there is no value, no gas and no bytes to
    // price, so the debit is unknown - and an unknown debit is not a small one.
    expect(data.eligibility.kind).toBe("balance_unavailable");
  });
});

describe("a wallet that can pay", () => {
  it("stays executable and hands the recorder the quote-time observation", async () => {
    const result = await quote();

    expect(result.quoteAuthority?.eligibilityKind).toBe("executable");
    expect(result.quoteAuthority?.routeSnapshot).not.toBeNull();

    const preview = required(result.quoteAuthority?.spendability, "a spendability preview");
    expect(preview.cardVersion).toBe("spendability-v2");
    // WP2-B: the card states the transaction set the binding will enforce, not
    // only what it costs - a person consents to a plan, not to a total.
    // This suite's wallet has granted no allowance yet, so the quote binds the
    // approve AND the swap - both of which the execute must reproduce exactly.
    expect(preview.debitPlan?.legs.map((leg) => leg.role)).toEqual(["allowance", "swap"]);
    // Gas UNITS are deliberately not bound (2.07x measured drift); every leg
    // this venue prices at quote time carries a real estimate, so none is
    // marked unpriced.
    expect(preview.debitPlan?.legs.every((leg) => !leg.unpriced)).toBe(true);
    // The tag is the whole point: `pending` is the only state that subtracts the
    // wallet's own in-flight spending (contract C2.4).
    expect(preview.source.blockTag).toBe("pending");
    expect(preview.native.blockTag).toBe("pending");
    expect(preview.source.required.raw).toBe(AMOUNT_IN_RAW.toString());
    expect(preview.source.required.symbol).toBe("USDC");
    // The native leg exists even though the input is an ERC-20: the source pays
    // the principal, the gas asset pays for the right to move it (C2.5).
    expect(BigInt(preview.native.required.raw)).toBeGreaterThan(0n);
  });

  it("does not let the built transaction replace the stored route snapshot", async () => {
    const result = await quote();
    const snapshot = required(result.quoteAuthority?.routeSnapshot, "a stored snapshot");

    // The snapshot is the ROUTE the agent was shown, serialized once. The build
    // is advisory - it exists so the debit can be priced, and its calldata must
    // not have leaked into what the execute will later be bound to.
    expect(String(snapshot.raw)).toContain('"routeID":"r1"');
    expect(String(snapshot.raw)).not.toContain(BUILD.data.data);
  });

  it("keeps the observation out of model context - it rides the private channel", async () => {
    const result = await quote();

    expect(result.output).not.toContain("spendability-v2");
    expect(result.output).not.toContain("debitPlan");
    expect(result.output).not.toContain("blockTag");
  });
});

/** The `required` figure the gas refusal states, in raw wei. */
function requiredAmountFrom(result: Awaited<ReturnType<typeof quote>>): bigint {
  const { summary } = JSON.parse(result.output) as { summary: string };
  const match = /required ([0-9]+) raw units/.exec(summary)
    ?? /required ([0-9.]+) ETH/.exec(summary);
  if (match === null) throw new Error(`no required figure in summary: ${summary}`);
  // The human spelling is exact base-10 scaling, so parsing it back to atoms is
  // lossless for the comparison this test makes.
  const figure = match[1];
  if (figure === undefined) throw new Error(`no captured figure in: ${match[0]}`);
  const [whole, fraction = ""] = figure.split(".");
  return BigInt(`${whole}${fraction.padEnd(18, "0")}`);
}
