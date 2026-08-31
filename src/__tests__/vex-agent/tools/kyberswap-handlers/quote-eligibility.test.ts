/**
 * `kyberswap.swap.quote` - which quotes may authorize a swap, and what the
 * agent is told when one may not.
 *
 * The quote handler is the ONLY place the execution snapshot is produced, so
 * these tests pin three things at once: the eligibility the classifier
 * reached, what reaches the agent (`output`), and what reaches the recorder
 * (the PRIVATE `quoteAuthority` channel, which must never appear in `output`).
 *
 * The provider facts driven here are measured, not invented: KyberSwap answers
 * `amountOutUsd: "0"` for pairs it cannot price on robinhood - including every
 * native/wrapped-native pair - while `amountInUsd` is a real number
 * (2026-08-27).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAddress } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const mockReadErc20Metadata = vi.fn(async (_slug: string, address: string) => ({
  address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
}));

vi.mock("@tools/kyberswap/evm-utils.js", async () => ({
  ...(await import("./evm-client.test-fixtures.js")).kyberEvmClientMocks(),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: vi.fn().mockResolvedValue({ needsReset: false, needsApprove: false }),
  buildApproveCalldata: vi.fn(),
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
/**
 * The quote asks `/route/build` for the ACTUAL transaction shape so the native
 * debit can be priced from the call that would really run. `gas` is required by
 * the provider's own response validator, so a build without it is a response the
 * client would already have refused. MEASURED live on Base 2026-08-31.
 */
const mockBuildRoute = vi.fn().mockResolvedValue({
  data: {
    amountIn: "10000000", amountInUsd: "10", amountOut: "21335790672285165158400", amountOutUsd: "9.99",
    gas: "287581", gasUsd: "0.0042",
    data: "0xdeadbeef",
    routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    transactionValue: "0",
  },
});
vi.mock("@tools/kyberswap/aggregator/client.js", () => ({
  getKyberAggregatorClient: () => ({
    getRoute: (...a: unknown[]) => mockGetRoute(...a),
    buildRoute: (...a: unknown[]) => mockBuildRoute(...a),
  }),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { KYBERSWAP_HANDLERS } from "@vex-agent/tools/protocols/kyberswap/handlers.js";
import { digestSnapshotRaw } from "@vex-agent/tools/protocols/quote-authority/snapshot.js";
import { computeApprovedMinOut } from "@tools/kyberswap/swap-price-floor.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

const TOKEN_IN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOKEN_OUT = "0x17f31d221a86c091a32d398653f5306fc4d93c0d";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
/** Base's VERIFIED wrapped-native contract - the identity that makes a pair a wrap. */
const BASE_WRAPPED_NATIVE = "0x4200000000000000000000000000000000000006";
const AMOUNT_OUT = "21335790672285165158400";

/** Narrow an optional to a value, failing the test with a named reason instead of assuming. */
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

function routeWith(usd: { amountInUsd: unknown; amountOutUsd: unknown }, extra: Record<string, unknown> = {}) {
  return {
    data: {
      routeSummary: {
        tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT,
        amountIn: "10000000", amountOut: AMOUNT_OUT,
        gasUsd: "0.01", routeID: "r1", checksum: "c1", route: [],
        ...usd, ...extra,
      },
      routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    },
  };
}

/**
 * Resolved once, with a real check: an absent handler is a registry bug, and a
 * non-null assertion here would report it as an unrelated call-of-undefined
 * inside whichever test ran first.
 */
const QUOTE_HANDLER = KYBERSWAP_HANDLERS["kyberswap.swap.quote"];
if (QUOTE_HANDLER === undefined) throw new Error("kyberswap.swap.quote is not registered");

function quote(params: Record<string, unknown> = {}) {
  return QUOTE_HANDLER(
    { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "10", ...params },
    ctx(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
    address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
  }));
});

describe("an executable quote", () => {
  const priced = routeWith({ amountInUsd: "100", amountOutUsd: "99.9" });
  beforeEach(() => {
    mockGetRoute.mockResolvedValue(priced);
  });

  it("hands the recorder a digest-verifiable snapshot of the EXACT route it showed", async () => {
    const result = await quote();

    expect(result.success).toBe(true);
    expect(result.quoteAuthority?.eligibilityKind).toBe("executable");
    const snapshot = required(result.quoteAuthority?.routeSnapshot, "a stored route snapshot");
    const raw = String(snapshot.raw);
    expect(snapshot.provider).toBe("kyberswap");
    expect(snapshot.digest).toBe(digestSnapshotRaw(raw));
    // The stored string parses back to the provider's own summary, verbatim.
    expect(JSON.parse(raw)).toEqual(priced.data.routeSummary);
    expect(snapshot.approvedAmountOutRaw).toBe(AMOUNT_OUT);
    expect(snapshot.approvedMinOutRaw).toBe(computeApprovedMinOut(AMOUNT_OUT, VEX_DEFAULT_SLIPPAGE_BPS).toString());
    expect(snapshot.effectiveSlippageBps).toBe(VEX_DEFAULT_SLIPPAGE_BPS);
  });

  it("the snapshot is PRIVATE - it never reaches model context", async () => {
    const result = await quote();
    const snapshot = required(result.quoteAuthority?.routeSnapshot, "a stored route snapshot");
    const output = required(result.output, "the quote output");

    expect(output).not.toContain(String(snapshot.raw));
    expect(output).not.toContain(String(snapshot.digest));
    expect(result.data).not.toHaveProperty("quoteAuthority");
    expect(JSON.parse(output)).not.toHaveProperty("routeSnapshot");
  });

  it("shows the agent the floor its execute will be held to, in raw AND human units", async () => {
    const result = await quote();
    const data = JSON.parse(required(result.output, "the quote output")) as {
      approvedMinOut: { amountRaw: string; amountHuman: string; slippageBps: number };
      eligibility: { kind: string; executable: boolean };
    };

    expect(data.approvedMinOut.amountRaw).toBe(computeApprovedMinOut(AMOUNT_OUT, VEX_DEFAULT_SLIPPAGE_BPS).toString());
    expect(data.approvedMinOut.amountHuman).not.toBe(data.approvedMinOut.amountRaw);
    expect(data.approvedMinOut.slippageBps).toBe(VEX_DEFAULT_SLIPPAGE_BPS);
    expect(data.eligibility).toEqual({ kind: "executable", adverse: false, executable: true });
  });

  it("discloses an adverse but tradeable impact without refusing it", async () => {
    mockGetRoute.mockResolvedValue(routeWith({ amountInUsd: "100", amountOutUsd: "92" }));

    const result = await quote();

    expect(result.success).toBe(true);
    expect(result.quoteAuthority?.eligibilityKind).toBe("executable");
    expect(result.output).toContain("8.00% of the input's reference value");
    expect(result.output).toContain("still executable");
  });
});

describe("a quote that authorizes nothing still answers, and supersedes the older one", () => {
  it("unpriceable output: shows the route, seeds NO snapshot, marks the row ineligible", async () => {
    // The measured pathology. The old derivation reported this as a precise
    // 100.00% price impact; it must now be named for what it is.
    mockGetRoute.mockResolvedValue(routeWith({ amountInUsd: "30.27887792044092", amountOutUsd: "0" }));

    const result = await quote();

    expect(result.success).toBe(true);
    expect(result.quoteAuthority?.eligibilityKind).toBe("unpriceable_output");
    expect(result.quoteAuthority?.routeSnapshot).toBeNull();
    // The superseding marker: the recorder writes a row for THIS identity, so
    // an older priced quote for the same trade stops being claimable.
    // Addresses are the CHECKSUMMED ones the resolver produced, which is what
    // the prequote identity is computed from.
    expect(result.quoteAuthority?.ineligibleIdentity).toMatchObject({
      tokenIn: getAddress(TOKEN_IN), tokenOut: getAddress(TOKEN_OUT), amount: "10",
    });
    expect(result.output).toContain("no USD value for the output");
    expect(result.output).toContain("does NOT authorize an execute");
    expect(result.output).not.toContain("Price impact 100.00%");
    // The route itself is still fully reported.
    const shown = JSON.parse(required(result.output, "the quote output")) as { routeSummary: { amountOut: string } };
    expect(shown.routeSummary.amountOut).toBe(AMOUNT_OUT);
  });

  it("excessive impact: named with its own number and the ceiling", async () => {
    mockGetRoute.mockResolvedValue(routeWith({ amountInUsd: "100", amountOutUsd: "80" }));

    const result = await quote();

    expect(result.success).toBe(true);
    expect(result.quoteAuthority?.eligibilityKind).toBe("excessive_impact");
    expect(result.quoteAuthority?.routeSnapshot).toBeNull();
    expect(result.output).toContain("20.00%");
    expect(result.output).toContain("15% ceiling");
  });

  it("oversize snapshot: the price is fine, the route cannot be stored verbatim", async () => {
    mockGetRoute.mockResolvedValue(
      routeWith({ amountInUsd: "100", amountOutUsd: "99.9" }, { route: [{ blob: "x".repeat(300_000) }] }),
    );

    const result = await quote();

    expect(result.success).toBe(true);
    expect(result.quoteAuthority?.eligibilityKind).toBe("oversize_snapshot");
    expect(result.quoteAuthority?.routeSnapshot).toBeNull();
    expect(result.output).toContain("snapshot bound");
  });
});

describe("a provider-shape refusal is a FAILED quote that still retires the old one", () => {
  it("refuses when the provider states no usable USD on either side", async () => {
    mockGetRoute.mockResolvedValue(routeWith({ amountInUsd: "0", amountOutUsd: "0" }));

    const result = await quote();

    // FAILED: the model must not read a priced offer out of an answer whose
    // prices the provider did not state.
    expect(result.success).toBe(false);
    expect(result.quoteAuthority?.eligibilityKind).toBe("provider_usd_invalid");
    expect(result.quoteAuthority?.routeSnapshot).toBeNull();
    // THE HOLE THIS CLOSES: the pre-change recorder ran on SUCCESS only, so a
    // refusal here left an older priced quote as the newest claimable row.
    expect(result.quoteAuthority?.ineligibleIdentity).toBeDefined();
  });

  it("refuses a NEGATIVE USD leg before it can become an impact figure", async () => {
    mockGetRoute.mockResolvedValue(routeWith({ amountInUsd: "100", amountOutUsd: "-100" }));

    const result = await quote();

    expect(result.success).toBe(false);
    expect(result.quoteAuthority?.eligibilityKind).toBe("provider_usd_invalid");
  });

  it("points the CANONICAL native/wrapped-native pair at the wrap tool BY NAME", async () => {
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "WETH", name: "Wrapped Ether", decimals: 18, isNative: false as const,
    }));
    mockGetRoute.mockResolvedValue(routeWith({ amountInUsd: "0", amountOutUsd: "0" }));

    const result = await quote({ tokenIn: NATIVE, tokenOut: BASE_WRAPPED_NATIVE });

    expect(result.success).toBe(false);
    expect(result.output).toContain("WalletWrapPrepare");
    expect(result.output).toContain("WalletWrapConfirm");
    expect(result.output).toContain("1:1");
  });

  /**
   * The predicate this pins used to be "one leg is native", which is true of
   * most trades this venue ever quotes: an ordinary unpriceable native trade
   * was told to go and wrap the token it was trying to buy. Identity is now the
   * chain's VERIFIED wrapped-native contract.
   */
  it("does NOT send an ordinary native trade to the wrap tool", async () => {
    mockGetRoute.mockResolvedValue(routeWith({ amountInUsd: "0", amountOutUsd: "0" }));

    const result = await quote({ tokenIn: NATIVE });

    expect(result.success).toBe(false);
    expect(result.output).not.toContain("WalletWrapPrepare");
    expect(result.output).toContain("Request a fresh quote");
  });
});
