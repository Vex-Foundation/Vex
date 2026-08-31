/**
 * `WalletBalances` runs the SHARED Khalani price enrichment, like the sync does.
 *
 * WHY THIS FILE EXISTS. The DexScreener fill for the prices Khalani stopped
 * returning on 2026-08-26 lived in `vex-agent/sync/khalani-price-fallback.ts`,
 * coupled to the persisted `BalanceRow`. Only the background sync could reach
 * it, so this tool - the one an agent actually calls to ask what a wallet holds
 * - handed the provider's nulls straight to the model and reported a smaller
 * portfolio than the sidebar showed for the same wallet at the same moment.
 * The pass now belongs to `tools/khalani/balance-price-enrichment.ts` and runs
 * on BOTH lanes, over the provider's own rows.
 *
 * The handler under test is the REAL one, driven over the REAL enrichment and
 * the REAL projection; only the two provider boundaries (the Khalani scan and
 * the DexScreener reads) are scripted. What is asserted is what the model sees:
 * the filled price on the row, the untouched Khalani price beside it, and both
 * completeness axes reflecting POST-enrichment reality - a row this pass priced
 * is a priced holding for `unpricedHeldCount`, `valuationComplete`,
 * `pricedTotalUsd` and `totalUsdBasis` (frozen contract C3), and the
 * compatibility `totalUsd` must not disagree with them.
 *
 * Scaffold mirrors `read-completeness.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ChainFamily } from "@tools/khalani/types.js";
import { makeTestContext } from "../../_test-context.js";

const BASE_CHAIN_ID = 8453;
/** Base's wrapped native and stable, from `evm-chain-quote-policy.ts`. */
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** The price-less holding under test. */
const TOKEN = "0x00000000000000000000000000000000000000aa";

const mockScan = vi.fn();
vi.mock("@tools/khalani/balances.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/khalani/balances.js")>();
  return {
    getSelectedChainIdsForFamily: original.getSelectedChainIdsForFamily,
    calculateTokensTotalUsd: original.calculateTokensTotalUsd,
    parseBalanceChainSelection: async (raw: string | undefined) => {
      if (!raw) return { rawProvided: false, byFamily: new Map() };
      return {
        rawProvided: true,
        byFamily: new Map<ChainFamily, number[]>([["eip155", [BASE_CHAIN_ID]]]),
      };
    },
    getTokenBalancesAcrossChains: (...a: unknown[]) => mockScan(...a),
  };
});

vi.mock("@tools/evm-chains/resolver.js", () => ({
  resolveInclusiveEvmChain: async () => ({ source: "khalani", chainId: BASE_CHAIN_ID, family: "eip155" }),
}));

vi.mock("@tools/evm-chains/balances.js", () => ({
  readLocalChainBalances: () => {
    throw new Error("no local chain is in scope for this suite");
  },
}));

vi.mock("@vex-agent/sync/local-chain-balance-sync.js", () => ({
  buildTokenScanSet: async () => [],
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: () => "0xWALLET",
}));

// The ONE provider boundary the enrichment owns. Real bytes go through the real
// validator, so what the projection sees is what the provider actually sends.
const mockReadTokensPairs = vi.fn();
const mockReadTokenPools = vi.fn();
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: (...a: unknown[]) => mockReadTokensPairs(...a),
  readTokenPools: (...a: unknown[]) => mockReadTokenPools(...a),
}));

const { handleWalletBalances } = await import(
  "../../../../../vex-agent/tools/internal/wallet/read.js"
);
const { validateTokensResponse } = await import("@tools/dexscreener/validation/pairs.js");

const CONTEXT = makeTestContext();
const TWO = 2_000000000000000000n;

interface TokenRow {
  symbol: string | null;
  address: string;
  priceUsd?: string | null;
  valueUsd?: string | null;
  priceUnavailable?: true;
}

interface Envelope {
  totalUsd: number;
  valuationComplete: boolean;
  inventoryComplete: boolean;
  unpricedHeldCount: number;
  pricedTotalUsd: string;
  totalUsdBasis: string;
  wallets: Array<{
    valuationComplete: boolean;
    unpricedHeldCount: number;
    pricedTotalUsd: string;
    totalUsdBasis: string;
    totalUsd: number;
    tokens: TokenRow[];
  }>;
}

/** One Khalani balance row, in the provider's own shape. */
function khalaniToken(fields: {
  address: string;
  symbol: string;
  priceUsd?: string;
}): Record<string, unknown> {
  return {
    symbol: fields.symbol,
    name: fields.symbol,
    address: fields.address,
    chainId: BASE_CHAIN_ID,
    decimals: 18,
    extensions: {
      balance: TWO.toString(),
      ...(fields.priceUsd === undefined ? {} : { price: { usd: fields.priceUsd } }),
    },
  };
}

/** A tier-0 pool: `base` quoted in the chain's recognised stable. */
function stablePool(base: string, priceUsd: string): unknown {
  return {
    chainId: "base",
    dexId: "test",
    url: "https://dexscreener.com/base/test",
    pairAddress: `0xpool-${base}`,
    baseToken: { address: base, name: "b", symbol: "B" },
    quoteToken: { address: BASE_USDC, name: "USD Coin", symbol: "USDC" },
    priceUsd,
    priceNative: "1",
    liquidity: { usd: 500_000, base: 0, quote: 0 },
  };
}

async function read(): Promise<Envelope> {
  const res = await handleWalletBalances({ walletFamily: "eip155", chainIds: "base" }, CONTEXT);
  expect(res.success).toBe(true);
  // Read the SERIALIZED answer, which is the one the model actually sees.
  return JSON.parse(res.output) as Envelope;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadTokenPools.mockResolvedValue([]);
  mockReadTokensPairs.mockResolvedValue([]);
  mockScan.mockResolvedValue({
    address: "0xWALLET",
    family: "eip155",
    tokens: [
      khalaniToken({ address: BASE_WETH, symbol: "KHL", priceUsd: "3" }),
      khalaniToken({ address: TOKEN, symbol: "UNP" }),
    ],
    scannedChainIds: [BASE_CHAIN_ID],
    chainErrors: [],
    // What the scan owner reduces from those rows: 2 x $3, plus nothing for the
    // row it could not price.
    totalUsd: 6,
    rejectedEntries: [],
  });
});

/** The one snapshot every case expects; absence fails with the payload, not a TypeError. */
function firstWallet(envelope: Envelope): Envelope["wallets"][number] {
  const wallet = envelope.wallets[0];
  if (wallet === undefined) throw new Error(`expected one wallet snapshot: ${JSON.stringify(envelope)}`);
  return wallet;
}

/** A row the case requires; a missing symbol fails by name instead of exploding later. */
function mustFind(rows: TokenRow[], symbol: string): TokenRow {
  const row = rows.find((candidate) => candidate.symbol === symbol);
  if (row === undefined) throw new Error(`expected a ${symbol} row, got: ${rows.map((r) => r.symbol).join(", ")}`);
  return row;
}

describe("WalletBalances price enrichment", () => {
  it("fills a price Khalani left null and counts the row as PRICED everywhere", async () => {
    mockReadTokensPairs.mockResolvedValue(validateTokensResponse([stablePool(TOKEN, "2.5")]));

    const envelope = await read();
    const snapshot = firstWallet(envelope);
    const filled = mustFind(snapshot.tokens, "UNP");

    // The row the model reads carries the filled price and its value, and is
    // NOT flagged as price-unavailable.
    expect(filled.priceUsd).toBe("2.5");
    expect(Number(filled.valueUsd)).toBeCloseTo(5, 6);
    expect(filled.priceUnavailable).toBeUndefined();

    // Post-enrichment reality on BOTH completeness axes (C3): nothing held is
    // unpriced any more, so the valuation is complete and the compatibility
    // total says it counted everything.
    expect(snapshot.unpricedHeldCount).toBe(0);
    expect(snapshot.valuationComplete).toBe(true);
    expect(snapshot.inventoryComplete).toBe(true);
    expect(Number(snapshot.pricedTotalUsd)).toBeCloseTo(6 + 5, 6);
    expect(snapshot.totalUsdBasis).toBe("complete");
    // The compatibility number must not disagree with `pricedTotalUsd`: it is
    // re-derived from the ENRICHED rows, not from the scan's pre-enrichment sum.
    expect(snapshot.totalUsd).toBeCloseTo(6 + 5, 6);
    expect(envelope.totalUsd).toBeCloseTo(6 + 5, 6);
    expect(envelope.unpricedHeldCount).toBe(0);
    expect(envelope.totalUsdBasis).toBe("complete");

    // One batched request for the chain, seeded with the wrapped native anchor.
    expect(mockReadTokensPairs).toHaveBeenCalledTimes(1);
    expect(String(mockReadTokensPairs.mock.calls[0]?.[1]).toLowerCase()).toContain(BASE_WETH);
  });

  it("NEVER overwrites a price Khalani supplied", async () => {
    // The provider would price the Khalani-priced row at $999 if this pass ever
    // looked at it. Khalani owns the balance and its own price.
    mockReadTokensPairs.mockResolvedValue(
      validateTokensResponse([stablePool(BASE_WETH, "999"), stablePool(TOKEN, "2.5")]),
    );

    const snapshot = firstWallet(await read());
    const khalaniPriced = mustFind(snapshot.tokens, "KHL");

    expect(khalaniPriced.priceUsd).toBe("3");
    expect(Number(khalaniPriced.valueUsd)).toBeCloseTo(6, 6);
  });

  it("leaves the row unpriced, and says so on both numbers, when the provider prices nothing", async () => {
    const snapshot = firstWallet(await read());
    const unpriced = mustFind(snapshot.tokens, "UNP");

    expect(unpriced.priceUsd).toBe(null);
    expect(unpriced.valueUsd).toBe(null);
    expect(unpriced.priceUnavailable).toBe(true);
    // An unvalued holding is reported as unvalued, never as a zero (C1.5).
    expect(snapshot.unpricedHeldCount).toBe(1);
    expect(snapshot.valuationComplete).toBe(false);
    expect(snapshot.totalUsdBasis).toBe("priced_only");
    expect(snapshot.totalUsd).toBeCloseTo(6, 6);
  });

  it("keeps the whole snapshot when the pricing provider fails (fail-soft)", async () => {
    mockReadTokensPairs.mockRejectedValue(new Error("provider down"));
    mockReadTokenPools.mockRejectedValue(new Error("provider down"));

    const snapshot = firstWallet(await read());

    expect(snapshot.tokens.map((row) => row.symbol)).toEqual(["KHL", "UNP"]);
    expect(snapshot.tokens.find((row) => row.symbol === "KHL")?.priceUsd).toBe("3");
    expect(snapshot.unpricedHeldCount).toBe(1);
    expect(snapshot.inventoryComplete).toBe(true);
  });
});
