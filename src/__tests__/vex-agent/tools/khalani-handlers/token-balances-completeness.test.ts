/**
 * `khalani.tokens.balances` reports the SAME completeness envelope as
 * `WalletBalances`, with the same meanings (frozen contract C3).
 *
 * WHY THIS FILE EXISTS. This tool is the second agent-visible balance surface,
 * and its own description tells the model to use it to find a funded source
 * asset before quoting a bridge or a swap. Until 2026-09-01 it disclosed
 * refused entries but none of the two completeness axes, so a Khalani chain
 * that failed to scan produced a SHORT LIST that reads exactly like a complete
 * one - the failure mode C3 exists to prevent, and the one both wallet
 * references ship. Divergence between the two surfaces is itself the defect:
 * an agent reading both must find one contract, not two.
 *
 * The handler under test is the REAL one; only the scan, the price boundary and
 * the Solana snapshot are scripted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { makeProtocolContext } from "../_test-context.js";

const EVM_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const SOL_WALLET = "8ZkY8mHnDpQxYqvVc7wYh1BF4ZQ9nQKkQnKX9WbmFgHt";
const CHAIN_ID = 8453;
const OTHER_CHAIN_ID = 1;
const SOLANA_CHAIN_ID = 20011000000;
const TOKEN_A = "0x00000000000000000000000000000000000000aa";
const TOKEN_B = "0x00000000000000000000000000000000000000bb";

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
  return {
    ...actual,
    resolveSelectedAddress: (family: string) => (family === "solana" ? SOL_WALLET : EVM_WALLET),
  };
});

// The enrichment pass is the REAL one; its provider boundary answers nothing,
// so a price in the payload is the price the scan carried.
const mockReadTokensPairs = vi.fn();
const mockReadTokenPools = vi.fn();
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: (...a: unknown[]) => mockReadTokensPairs(...a),
  readTokenPools: (...a: unknown[]) => mockReadTokenPools(...a),
}));

const { handleTokenBalances } = await import(
  "@vex-agent/tools/protocols/khalani/handlers/read.js"
);

const CONTEXT = makeProtocolContext();

/** One held row: 2 whole units at 18 decimals, priced or not. */
function heldToken(fields: { address: string; symbol: string; priceUsd?: string; balance?: string }) {
  return {
    symbol: fields.symbol,
    name: fields.symbol,
    address: fields.address,
    chainId: CHAIN_ID,
    decimals: 18,
    extensions: {
      balance: fields.balance ?? (2n * 10n ** 18n).toString(),
      ...(fields.priceUsd === undefined ? {} : { price: { usd: fields.priceUsd } }),
    },
  };
}

interface ScanOverrides {
  tokens?: ReturnType<typeof heldToken>[];
  scannedChainIds?: number[];
  chainErrors?: Array<{ chainId: number; message: string }>;
  rejectedEntries?: Array<Record<string, unknown>>;
}

function scan(overrides: ScanOverrides = {}) {
  return {
    address: EVM_WALLET,
    family: "eip155" as const,
    tokens: overrides.tokens ?? [heldToken({ address: TOKEN_A, symbol: "AAA", priceUsd: "3" })],
    scannedChainIds: overrides.scannedChainIds ?? [CHAIN_ID],
    chainErrors: overrides.chainErrors ?? [],
    totalUsd: 6,
    rejectedEntries: overrides.rejectedEntries ?? [],
  };
}

/**
 * Read BOTH representations the tool publishes. A completeness field present in
 * `data` but missing from the rendered `output` would be invisible to the model,
 * which is the only reader that matters here.
 */
async function readBalances(params: Record<string, unknown> = { walletFamily: "eip155" }) {
  const result = await handleTokenBalances(params, CONTEXT);
  expect(result.success).toBe(true);
  const data = result.data;
  if (data === undefined || data === null || typeof data !== "object") {
    throw new Error("expected a structured payload");
  }
  return {
    payloads: [
      data as Record<string, unknown>,
      JSON.parse(result.output) as Record<string, unknown>,
    ],
    data: data as Record<string, unknown>,
  };
}

/** Read one `inventorySources` row without an assertion escape. */
function sourcesOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const sources = payload.inventorySources;
  if (!Array.isArray(sources)) throw new Error("expected inventorySources to be an array");
  return sources.map((entry) => {
    if (entry === null || typeof entry !== "object") throw new Error("expected a source row");
    return entry as Record<string, unknown>;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadTokenPools.mockResolvedValue([]);
  mockReadTokensPairs.mockResolvedValue([]);
  mockScan.mockResolvedValue(scan());
});

describe("khalani.tokens.balances - the completeness envelope (EVM)", () => {
  it("reports a fully read, fully priced scan as complete on BOTH axes", async () => {
    const { payloads } = await readBalances();

    for (const payload of payloads) {
      expect(payload.inventoryComplete).toBe(true);
      expect(payload.valuationComplete).toBe(true);
      expect(payload).not.toHaveProperty("inventoryIncompleteReason");
      expect(payload.unpricedHeldCount).toBe(0);
      expect(payload.pricedTotalUsd).toBe("6");
      expect(payload.totalUsdBasis).toBe("complete");
      expect(payload.failedChainIds).toEqual([]);
      expect(sourcesOf(payload)).toEqual([
        {
          chainId: CHAIN_ID,
          source: "khalani_registry_scan",
          result: "read",
          exhaustive: true,
          observedAt: expect.any(String),
        },
      ]);
    }
  });

  it("a failed chain makes the inventory incomplete and names the chain", async () => {
    // The defect this pins: without the envelope, the rows of the chain that DID
    // scan render as the whole wallet, and a bridge is quoted against a source
    // asset the agent believes it does not hold.
    mockScan.mockResolvedValue(
      scan({ chainErrors: [{ chainId: OTHER_CHAIN_ID, message: "rpc down" }] }),
    );

    const { payloads } = await readBalances();

    for (const payload of payloads) {
      expect(payload.inventoryComplete).toBe(false);
      expect(payload.inventoryIncompleteReason).toBe("chain_read_failed");
      expect(payload.failedChainIds).toEqual([OTHER_CHAIN_ID]);
      // The valuation of the rows we DID read is untouched by the other chain's
      // failure: the two axes are independent (C3).
      expect(payload.valuationComplete).toBe(true);
      // A complete total cannot be claimed while a chain is unknown.
      expect(payload.totalUsdBasis).toBe("priced_only");
    }
  });

  it("never stamps a failed chain with an observation time", async () => {
    // C3.5: a read that failed observed nothing, and a fresh timestamp is how a
    // gap gets renamed fresh and the retry suppressed.
    mockScan.mockResolvedValue(
      scan({ chainErrors: [{ chainId: OTHER_CHAIN_ID, message: "rpc down" }] }),
    );

    const { data } = await readBalances();
    const failed = sourcesOf(data).filter((source) => source.result === "failed");

    expect(failed).toHaveLength(1);
    expect(failed[0]?.chainId).toBe(OTHER_CHAIN_ID);
    expect(failed[0]?.observedAt).toBeNull();
  });

  it("an unpriced held row costs the valuation axis, not the inventory", async () => {
    mockScan.mockResolvedValue(
      scan({
        tokens: [
          heldToken({ address: TOKEN_A, symbol: "AAA", priceUsd: "3" }),
          heldToken({ address: TOKEN_B, symbol: "BBB" }),
        ],
      }),
    );

    const { payloads } = await readBalances();

    for (const payload of payloads) {
      expect(payload.inventoryComplete).toBe(true);
      expect(payload.valuationComplete).toBe(false);
      expect(payload.unpricedHeldCount).toBe(1);
      // The exact decimal sum of the rows that DID carry a value, never a float
      // and never a stand-in for the whole portfolio.
      expect(payload.pricedTotalUsd).toBe("6");
      expect(payload.totalUsdBasis).toBe("priced_only");
    }
  });

  it("a zero-balance unpriced row costs neither axis", async () => {
    mockScan.mockResolvedValue(
      scan({ tokens: [heldToken({ address: TOKEN_B, symbol: "BBB", balance: "0" })] }),
    );

    const { data } = await readBalances();

    expect(data.unpricedHeldCount).toBe(0);
    expect(data.valuationComplete).toBe(true);
    expect(data.totalUsdBasis).toBe("complete");
  });

  it("a HELD refused entry leaves the inventory complete and the valuation not", async () => {
    // The frozen-contract case (C1.2 amendment): the entry's identity and atomic
    // amount are true facts, so the wallet does show the holding; only its value
    // is unknown.
    mockScan.mockResolvedValue(
      scan({
        rejectedEntries: [{
          entryIndex: 0,
          chainId: CHAIN_ID,
          address: TOKEN_B,
          name: "Refused",
          symbol: "REF",
          balanceRaw: "500",
          reason: "token_decimals_invalid",
        }],
      }),
    );

    const { data } = await readBalances();

    expect(data.inventoryComplete).toBe(true);
    expect(data.valuationComplete).toBe(false);
    expect(data.totalUsdBasis).toBe("priced_only");
    // The refusal disclosure is unchanged and still travels beside the axes.
    expect(data.rejectedEntryCount).toBe(1);
  });
});

describe("khalani.tokens.balances - the completeness envelope (Solana)", () => {
  const solanaRow = {
    mint: "So11111111111111111111111111111111111111112",
    symbol: "SOL",
    name: "Solana",
    decimals: 9,
    amountRaw: "1000000000",
    uiAmount: 1,
    priceUsd: 150,
    usdValue: 150,
    assetKind: "native" as const,
    nativeAssetId: "solana:native",
    routeMint: "So11111111111111111111111111111111111111112",
    pricingMint: "So11111111111111111111111111111111111111112",
  };

  async function readSolana(accountFailures: Array<{ pubkey: string; reason: string }>) {
    return handleTokenBalances(
      { walletFamily: "solana" },
      CONTEXT,
      {
        readSolanaSnapshot: async () => ({
          address: SOL_WALLET,
          rows: [solanaRow],
          totalUsd: 150,
          accountFailures,
        }),
      },
    );
  }

  it("reports the same fields on a clean Solana read", async () => {
    const result = await readSolana([]);
    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output) as Record<string, unknown>;

    expect(payload.inventoryComplete).toBe(true);
    expect(payload.valuationComplete).toBe(true);
    expect(payload.totalUsdBasis).toBe("complete");
    expect(payload.failedChainIds).toEqual([]);
    expect(sourcesOf(payload)).toEqual([
      {
        chainId: SOLANA_CHAIN_ID,
        source: "solana_rpc_accounts",
        result: "read",
        exhaustive: true,
        observedAt: expect.any(String),
      },
    ]);
  });

  it("an untrusted token ACCOUNT makes the inventory incomplete without failing the chain", async () => {
    const result = await readSolana([{ pubkey: "AcctPubkey1111111111111111111111111111111111", reason: "bad owner" }]);
    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output) as Record<string, unknown>;

    expect(payload.inventoryComplete).toBe(false);
    expect(payload.inventoryIncompleteReason).toBe("account_read_failed");
    // The chain itself was read, so it is not an unknown-holdings chain.
    expect(payload.failedChainIds).toEqual([]);
    expect(payload.totalUsdBasis).toBe("priced_only");
  });
});
