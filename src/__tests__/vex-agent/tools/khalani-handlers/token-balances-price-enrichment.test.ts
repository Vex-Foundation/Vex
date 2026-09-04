/**
 * `khalani.tokens.balances` runs the SAME price-enrichment pass as
 * `WalletBalances` and the background sync.
 *
 * WHY THIS FILE EXISTS. Until 2026-08-31 the enrichment ran on the sync and
 * (since WP5) on `WalletBalances`, but not here - so the two agent-visible
 * balance surfaces could answer DIFFERENT prices for the same token at the
 * same moment, and the model had no way to know which one to trust. This file
 * pins the parity: a null Khalani price is filled from the same pass, a real
 * Khalani price is never overwritten, and the compatibility `totalUsd` is
 * re-derived from the enriched rows.
 *
 * The handler under test is the REAL one; only the scan and the DexScreener
 * boundary are scripted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { makeProtocolContext } from "../_test-context.js";

const EVM_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const BASE_CHAIN_ID = 8453;
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TOKEN = "0x00000000000000000000000000000000000000aa";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockScan = vi.fn();
vi.mock("@tools/khalani/balances.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/khalani/balances.js")>();
  return { ...original, getTokenBalancesAcrossChains: (...args: unknown[]) => mockScan(...args) };
});

vi.mock("../../../../vex-agent/tools/internal/wallet/resolve.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../vex-agent/tools/internal/wallet/resolve.js")
  >();
  return { ...actual, resolveSelectedAddress: () => EVM_WALLET };
});

const mockReadTokensPairs = vi.fn();
const mockReadTokenPools = vi.fn();
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: (...a: unknown[]) => mockReadTokensPairs(...a),
  readTokenPools: (...a: unknown[]) => mockReadTokenPools(...a),
}));

const { handleTokenBalances } = await import(
  "@vex-agent/tools/protocols/khalani/handlers/read.js"
);
const { validateTokensResponse } = await import("@tools/dexscreener/validation/pairs.js");

const CONTEXT = makeProtocolContext();

interface TokenRow {
  symbol: string;
  extensions?: { price?: { usd?: string } };
}

interface Payload {
  totalUsd: number;
  tokens: TokenRow[];
}

function khalaniToken(fields: { address: string; symbol: string; priceUsd?: string }) {
  return {
    symbol: fields.symbol,
    name: fields.symbol,
    address: fields.address,
    chainId: BASE_CHAIN_ID,
    decimals: 18,
    extensions: {
      balance: (2n * 10n ** 18n).toString(),
      ...(fields.priceUsd === undefined ? {} : { price: { usd: fields.priceUsd } }),
    },
  };
}

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

function priceOf(rows: TokenRow[], symbol: string): string | undefined {
  const row = rows.find((candidate) => candidate.symbol === symbol);
  if (row === undefined) throw new Error(`expected a ${symbol} row`);
  return row.extensions?.price?.usd;
}

async function read(): Promise<Payload> {
  const res = await handleTokenBalances({ wallet: "eip155" }, CONTEXT);
  expect(res.success).toBe(true);
  return res.data as Payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadTokenPools.mockResolvedValue([]);
  mockReadTokensPairs.mockResolvedValue([]);
  mockScan.mockResolvedValue({
    address: EVM_WALLET,
    family: "eip155",
    tokens: [
      khalaniToken({ address: BASE_WETH, symbol: "KHL", priceUsd: "3" }),
      khalaniToken({ address: TOKEN, symbol: "UNP" }),
    ],
    scannedChainIds: [BASE_CHAIN_ID],
    chainErrors: [],
    totalUsd: 6,
    rejectedEntries: [],
  });
});

describe("khalani.tokens.balances price enrichment parity", () => {
  it("fills a price Khalani left null through the shared pass", async () => {
    mockReadTokensPairs.mockResolvedValue(validateTokensResponse([stablePool(TOKEN, "2.5")]));

    const payload = await read();

    expect(priceOf(payload.tokens, "UNP")).toBe("2.5");
    // 2 KHL x $3 + 2 UNP x $2.5, re-derived from the ENRICHED rows, so this
    // surface cannot disagree with WalletBalances for the same wallet.
    expect(payload.totalUsd).toBeCloseTo(11, 6);
  });

  it("never overwrites a price Khalani supplied", async () => {
    mockReadTokensPairs.mockResolvedValue(
      validateTokensResponse([stablePool(BASE_WETH, "999"), stablePool(TOKEN, "2.5")]),
    );

    const payload = await read();

    expect(priceOf(payload.tokens, "KHL")).toBe("3");
  });

  it("keeps every row and the priced subtotal when the provider fails (fail-soft)", async () => {
    mockReadTokensPairs.mockRejectedValue(new Error("provider down"));
    mockReadTokenPools.mockRejectedValue(new Error("provider down"));

    const payload = await read();

    expect(payload.tokens.map((row) => row.symbol)).toEqual(["KHL", "UNP"]);
    expect(priceOf(payload.tokens, "KHL")).toBe("3");
    expect(priceOf(payload.tokens, "UNP")).toBeUndefined();
    expect(payload.totalUsd).toBeCloseTo(6, 6);
  });
});
