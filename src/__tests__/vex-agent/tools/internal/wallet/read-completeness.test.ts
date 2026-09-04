/**
 * `WalletBalances` reports TWO independent completeness axes (frozen contract
 * C3), on the DEFAULT path and not only under a concise trim.
 *
 * WHY THIS FILE EXISTS. The tool could already tell an agent which chains
 * failed, but it could not tell it what that cost: a snapshot from a wallet
 * whose indexer was down and a snapshot from a fully read wallet were the same
 * shape, and the only "unpriced" figure it carried (`unpricedOmitted`) counted
 * what a CONCISE TRIM dropped, so it was 0 on every default call no matter how
 * many holdings had no price. Both references ship exactly this defect
 * (MetaMask swallows the detection failure into an empty result, Rabby returns
 * early looking identical to a full read), which is why each axis is asserted
 * independently here: an inventory failure must never be readable as an
 * unvalued portfolio, and an unpriced wallet must never be readable as an
 * unenumerated one.
 *
 * The handler under test is the REAL one; only the provider boundaries are
 * scripted. Scaffold mirrors `read-concise-unpriced.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ChainFamily } from "@tools/khalani/types.js";
import type { SolanaWalletSnapshot } from "@tools/solana-ecosystem/balances/wallet-snapshot.js";
import { makeTestContext } from "../../_test-context.js";

const SOLANA_CHAIN_ID = 20_011_000_000;
const ROBINHOOD_CHAIN_ID = 4663;

const mockScan = vi.fn();
// The shared Khalani price enrichment now runs on this path too, so its ONE
// provider boundary is scripted to answer nothing: rows Khalani left unpriced
// stay unpriced, and no test in this suite reaches the network.
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: () => Promise.resolve([]),
  readTokenPools: () => Promise.resolve([]),
}));

vi.mock("@tools/khalani/balances.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/khalani/balances.js")>();
  return {
    getSelectedChainIdsForFamily: original.getSelectedChainIdsForFamily,
    calculateTokensTotalUsd: original.calculateTokensTotalUsd,
    parseBalanceChainSelection: async (raw: string | undefined) => {
      if (!raw) return { rawProvided: false, byFamily: new Map() };
      const byFamily = new Map<ChainFamily, number[]>();
      const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
      const evm = parts.filter((part) => part === "ethereum").map(() => 1);
      const solana = parts.filter((part) => part === "solana").map(() => SOLANA_CHAIN_ID);
      if (evm.length > 0) byFamily.set("eip155", evm);
      if (solana.length > 0) byFamily.set("solana", solana);
      return { rawProvided: true, byFamily };
    },
    getTokenBalancesAcrossChains: (...a: unknown[]) => mockScan(...a),
  };
});

vi.mock("@tools/evm-chains/resolver.js", () => ({
  resolveInclusiveEvmChain: async (input: string) => {
    const part = input.trim().toLowerCase();
    if (part === "robinhood") return { source: "local", chainId: ROBINHOOD_CHAIN_ID, family: "eip155" };
    return { source: "khalani", chainId: 1, family: "eip155" };
  },
}));

const mockReadLocal = vi.fn();
vi.mock("@tools/evm-chains/balances.js", () => ({
  readLocalChainBalances: (...a: unknown[]) => mockReadLocal(...a),
}));

const mockScanSet = vi.fn();
vi.mock("@vex-agent/sync/local-chain-balance-sync.js", () => ({
  buildLocalChainInventory: (...a: unknown[]) => mockScanSet(...a),
}));

/** Flipped by the one test that needs a whole wallet FAMILY to be unavailable. */
let solanaWalletAvailable = true;
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: (_r: unknown, _p: unknown, family: string) => {
    if (family !== "solana") return "0xWALLET";
    if (!solanaWalletAvailable) throw new Error("no Solana wallet is configured");
    return "SOLWALLET";
  },
}));

import { buildLocalChainScanSet } from "@vex-agent/wallet-inventory/local-chain.js";

/**
 * The enumeration the mocked sync lane answers with: a seeds-and-pins scan set,
 * built by the REAL union owner so the shape under test is never a hand-written
 * imitation of it. No indexer, which is exactly the state a local chain reports
 * when Blockscout answered nothing.
 */
function scanSetOf(addresses: readonly string[], chainId = 4663) {
  return buildLocalChainScanSet({
    chainId,
    seedAddresses: addresses,
    pinnedAddresses: [],
    indexer: null,
  });
}

const { handleWalletBalances } = await import(
  "../../../../../vex-agent/tools/internal/wallet/read.js"
);

const CONTEXT = makeTestContext();

const ONE = 1_000000000000000000n;

interface InventorySourceRow {
  chainId: number;
  source: string;
  result: string;
  exhaustive: boolean;
  observedAt: string | null;
}

interface RejectedEntryRow {
  chainId: number;
  address: string;
  symbol: string;
  balanceRaw: string | null;
  reason: string;
}

interface Envelope {
  totalUsd: number;
  inventoryComplete: boolean;
  inventorySources: InventorySourceRow[];
  inventoryIncompleteReason?: string;
  valuationComplete: boolean;
  unpricedHeldCount: number;
  pricedTotalUsd: string;
  totalUsdBasis: string;
  failedChainIds: number[];
  walletErrors: Array<{ wallet: string; message: string }>;
  wallets: Snapshot[];
}

interface Snapshot extends Omit<Envelope, "walletErrors" | "wallets"> {
  wallet: string;
  tokenCount: number;
  tokens: Array<{ symbol: string | null }>;
  rejectedEntryCount: number;
  rejectedEntries: RejectedEntryRow[];
  rejectedEntriesOmitted?: number;
  truncated: boolean;
  truncationNote?: string;
}

/** A scripted Solana snapshot, so the Solana lane never reaches a real RPC. */
const solanaSnapshot: SolanaWalletSnapshot = {
  address: "SOLWALLET",
  rows: [
    {
      mint: "So11111111111111111111111111111111111111112",
      isNative: true,
      symbol: "SOL",
      name: "Solana",
      decimals: 9,
      amountRaw: "1000000000",
      priceUsd: 2,
      usdValue: 2,
    },
  ],
  totalUsd: 2,
  accountFailures: [],
  stats: {
    accountsScanned: 0,
    zeroSkipped: 0,
    frozenAccounts: 0,
    metadataMissing: 0,
    unpriced: 0,
    priceTiers: { tier0: 1, tier1: 0, unpriced: 0 },
  },
};

async function read(params: Record<string, unknown>): Promise<Envelope> {
  const res = await handleWalletBalances({ ...params }, CONTEXT, {
    readSolanaSnapshot: async () => solanaSnapshot,
  });
  expect(res.success).toBe(true);
  // Read the SERIALIZED answer, which is the one the model actually sees.
  const envelope: Envelope = JSON.parse(res.output);
  return envelope;
}

/** An empty Khalani scan result, as the scan owner shapes it. */
function emptyScan(overrides: Record<string, unknown> = {}) {
  return {
    address: "0xWALLET",
    family: "eip155",
    tokens: [],
    scannedChainIds: [1],
    chainErrors: [],
    totalUsd: 0,
    rejectedEntries: [],
    ...overrides,
  };
}

/** One Khalani balance row, in the provider's own shape. */
function khalaniToken(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "AAA",
    name: "Alpha",
    address: "0xa",
    chainId: 1,
    decimals: 18,
    extensions: { balance: (ONE * 2n).toString(), price: { usd: "3" } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  solanaWalletAvailable = true;
  mockScanSet.mockResolvedValue(scanSetOf([]));
  mockReadLocal.mockResolvedValue({ nativeWei: 0n, nativePriceUsd: null, tokens: [], tokenFailures: [] });
  mockScan.mockResolvedValue(emptyScan());
});

/** The one snapshot every case expects; a missing one fails with the envelope, not a TypeError. */
function firstWallet<E extends { wallets: readonly unknown[] }>(envelope: E): NonNullable<E["wallets"][number]> {
  const wallet = envelope.wallets[0];
  if (wallet === undefined || wallet === null) {
    throw new Error(`expected one wallet snapshot, got: ${JSON.stringify(envelope)}`);
  }
  return wallet as NonNullable<E["wallets"][number]>;
}

describe("WalletBalances completeness - the inventory axis", () => {
  it("reports a clean Khalani read as a complete, exhaustive inventory", async () => {
    mockScan.mockResolvedValue(emptyScan({ tokens: [khalaniToken()], totalUsd: 6 }));

    const envelope = await read({ walletFamily: "eip155", chainIds: "ethereum" });
    const snapshot = firstWallet(envelope);

    expect(snapshot.inventoryComplete).toBe(true);
    expect(snapshot.inventoryIncompleteReason).toBeUndefined();
    expect(snapshot.failedChainIds).toEqual([]);
    expect(snapshot.inventorySources).toEqual([
      {
        chainId: 1,
        source: "khalani_registry_scan",
        result: "read",
        exhaustive: true,
        observedAt: expect.any(String),
      },
    ]);
  });

  it("reports Robinhood Chain 4663 as source_not_exhaustive even on a clean read", async () => {
    // Until the seed-plus-pin enumeration is replaced, a token outside that set
    // is INVISIBLE on this chain, not absent - and the agent has to be told.
    const envelope = await read({ walletFamily: "eip155", chainIds: "robinhood" });
    const snapshot = firstWallet(envelope);

    expect(snapshot.inventoryComplete).toBe(false);
    expect(snapshot.inventoryIncompleteReason).toBe("source_not_exhaustive");
    expect(snapshot.failedChainIds).toEqual([]);
    expect(snapshot.inventorySources).toEqual([
      {
        chainId: ROBINHOOD_CHAIN_ID,
        source: "local_chain_seed_and_pins",
        result: "read",
        exhaustive: false,
        observedAt: expect.any(String),
      },
    ]);
    // The envelope carries the same verdict, not a rosier one.
    expect(envelope.inventoryComplete).toBe(false);
    expect(envelope.inventoryIncompleteReason).toBe("source_not_exhaustive");
  });

  it("never stamps a failed read with a fresh observation time", async () => {
    mockReadLocal.mockRejectedValue(new Error("rpc down"));

    const snapshot = firstWallet(await read({ walletFamily: "eip155", chainIds: "robinhood" }));

    expect(snapshot.inventoryIncompleteReason).toBe("chain_read_failed");
    expect(snapshot.failedChainIds).toEqual([ROBINHOOD_CHAIN_ID]);
    expect(snapshot.inventorySources[0]).toMatchObject({ result: "failed", observedAt: null });
  });

  it("a dead chain does not make the rows it DID read unvalued", async () => {
    mockScan.mockResolvedValue(emptyScan({
      tokens: [khalaniToken()],
      totalUsd: 6,
      chainErrors: [{ chainId: 8453, chainName: "Base", message: "indexer down" }],
    }));

    const snapshot = firstWallet(await read({ walletFamily: "eip155", chainIds: "ethereum" }));

    expect(snapshot.inventoryComplete).toBe(false);
    expect(snapshot.failedChainIds).toEqual([8453]);
    // The axes stay separate: the valuation of what we read is still complete.
    expect(snapshot.valuationComplete).toBe(true);
    expect(snapshot.totalUsdBasis).toBe("priced_only");
    expect(snapshot.pricedTotalUsd).toBe("6");
  });

  it("counts a token-level read failure as an inventory gap", async () => {
    mockReadLocal.mockResolvedValue({
      nativeWei: 0n,
      nativePriceUsd: null,
      tokens: [],
      tokenFailures: [{ address: "0xdead", reason: "call reverted" }],
    });

    const snapshot = firstWallet(await read({ walletFamily: "eip155", chainIds: "robinhood" }));

    // Worst cause wins, and a missing token outranks a bounded source.
    expect(snapshot.inventoryIncompleteReason).toBe("token_read_failed");
  });
});

describe("WalletBalances completeness - the valuation axis", () => {
  it("counts EVERY unpriced holding on the default path, where nothing is trimmed", async () => {
    mockReadLocal.mockResolvedValue({
      nativeWei: 0n,
      nativePriceUsd: null,
      tokens: Array.from({ length: 25 }, (_unused, index) => ({
        address: `0x${index}`,
        symbol: `U${index}`,
        decimals: 18,
        balanceWei: ONE,
        priceUsd: null,
      })),
      tokenFailures: [],
    });

    const snapshot = firstWallet(await read({ walletFamily: "eip155", chainIds: "robinhood" }));

    // The defect this replaces: `unpricedOmitted` is a drop counter and is
    // absent here because the detailed path drops nothing at all.
    expect(snapshot).not.toHaveProperty("unpricedOmitted");
    expect(snapshot.unpricedHeldCount).toBe(25);
    expect(snapshot.valuationComplete).toBe(false);
    expect(snapshot.totalUsdBasis).toBe("priced_only");
  });

  it("does not let a concise trim move any completeness field", async () => {
    mockReadLocal.mockResolvedValue({
      nativeWei: 0n,
      nativePriceUsd: null,
      tokens: [
        { address: "0xa", symbol: "AAA", decimals: 18, balanceWei: ONE * 40n, priceUsd: 1 },
        { address: "0xu", symbol: "UNP", decimals: 18, balanceWei: ONE * 5n, priceUsd: null },
        { address: "0xb", symbol: "BBB", decimals: 18, balanceWei: ONE * 30n, priceUsd: 1 },
      ],
      tokenFailures: [],
    });

    const detailed = firstWallet(await read({ walletFamily: "eip155", chainIds: "robinhood" }));
    const concise = firstWallet(await read({
      walletFamily: "eip155",
      chainIds: "robinhood",
      response_format: "concise",
      limit: 1,
    }));

    expect(concise.tokens.length).toBeLessThan(detailed.tokens.length);
    for (const field of [
      "inventoryComplete",
      "inventoryIncompleteReason",
      "valuationComplete",
      "unpricedHeldCount",
      "pricedTotalUsd",
      "totalUsdBasis",
    ] as const) {
      expect(concise[field]).toEqual(detailed[field]);
    }
    expect(concise.failedChainIds).toEqual(detailed.failedChainIds);
  });

  it("a zero-balance unpriced row is not an unpriced HOLDING", async () => {
    mockReadLocal.mockResolvedValue({
      nativeWei: 0n,
      nativePriceUsd: null,
      tokens: [{ address: "0xz", symbol: "ZRO", decimals: 18, balanceWei: 0n, priceUsd: null }],
      tokenFailures: [],
    });

    const snapshot = firstWallet(await read({ walletFamily: "eip155", chainIds: "robinhood" }));

    expect(snapshot.unpricedHeldCount).toBe(0);
    expect(snapshot.valuationComplete).toBe(true);
  });

  it("sums pricedTotalUsd exactly, as a decimal string beside the compatibility number", async () => {
    mockScan.mockResolvedValue(emptyScan({
      tokens: [
        khalaniToken({ address: "0xa", extensions: { balance: ONE.toString(), price: { usd: "0.1" } } }),
        khalaniToken({ address: "0xb", extensions: { balance: ONE.toString(), price: { usd: "0.2" } } }),
      ],
      totalUsd: 0.30000000000000004,
    }));

    const envelope = await read({ walletFamily: "eip155", chainIds: "ethereum" });

    expect(firstWallet(envelope).pricedTotalUsd).toBe("0.3");
    // The compatibility number keeps its float identity, and now always
    // travels with the basis that says what it counted.
    expect(envelope.totalUsd).toBeCloseTo(0.3, 10);
    expect(envelope.totalUsdBasis).toBe("complete");
  });
});

describe("WalletBalances - refused balance entries (WP10-L)", () => {
  const rejected = (index: number, balanceRaw: string | null) => ({
    entryIndex: index,
    chainId: 1,
    address: `0xr${index}`,
    name: `Rejected ${index}`,
    symbol: `R${index}`,
    balanceRaw,
    reason: "token_decimals_invalid" as const,
  });

  it("reports a held decimals rejection without costing the INVENTORY axis", async () => {
    mockScan.mockResolvedValue(emptyScan({
      tokens: [khalaniToken()],
      totalUsd: 6,
      rejectedEntries: [rejected(0, "500")],
    }));

    const snapshot = firstWallet(await read({ walletFamily: "eip155", chainIds: "ethereum" }));

    expect(snapshot.rejectedEntryCount).toBe(1);
    expect(snapshot.rejectedEntries).toEqual([rejected(0, "500")]);
    // The entry's identity and exact amount are true facts, so the wallet was
    // still fully enumerated; only its VALUE is unknown.
    expect(snapshot.inventoryComplete).toBe(true);
    expect(snapshot.valuationComplete).toBe(false);
    expect(snapshot.totalUsdBasis).toBe("priced_only");
    expect(snapshot).not.toHaveProperty("rejectedEntriesOmitted");
    expect(snapshot.truncated).toBe(false);
  });

  it("never echoes the refused decimals", async () => {
    mockScan.mockResolvedValue(emptyScan({ rejectedEntries: [rejected(0, "500")] }));

    const snapshot = firstWallet(await read({ walletFamily: "eip155", chainIds: "ethereum" }));

    expect(snapshot.rejectedEntries[0]).not.toHaveProperty("decimals");
  });

  it("bounds the list at 20, counts the rest, and says how to read the total", async () => {
    mockScan.mockResolvedValue(emptyScan({
      rejectedEntries: Array.from({ length: 26 }, (_unused, index) => rejected(index, "1")),
    }));

    const snapshot = firstWallet(await read({ walletFamily: "eip155", chainIds: "ethereum" }));

    expect(snapshot.rejectedEntryCount).toBe(26);
    expect(snapshot.rejectedEntries).toHaveLength(20);
    expect(snapshot.rejectedEntriesOmitted).toBe(6);
    // A bound that cannot say what it left out is a silent cut.
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.truncationNote).toContain("rejectedEntriesOmitted");
    expect(snapshot.truncationNote).toContain("no parameter widens this list");
  });

  it("carries BOTH narrowing actions when rows and refusals were left out", async () => {
    mockScan.mockResolvedValue(emptyScan({
      tokens: [
        khalaniToken({ address: "0xa" }),
        khalaniToken({ address: "0xb", extensions: { balance: ONE.toString(), price: { usd: "1" } } }),
      ],
      rejectedEntries: Array.from({ length: 21 }, (_unused, index) => rejected(index, "1")),
    }));

    const snapshot = firstWallet(await read({
      walletFamily: "eip155",
      chainIds: "ethereum",
      response_format: "concise",
      limit: 1,
    }));

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.truncationNote).toContain("response_format:\"detailed\"");
    expect(snapshot.truncationNote).toContain("rejectedEntryCount");
  });

  it("a refused entry with an exact ZERO amount costs neither axis", async () => {
    mockScan.mockResolvedValue(emptyScan({
      tokens: [khalaniToken()],
      rejectedEntries: [rejected(0, "0")],
    }));

    const snapshot = firstWallet(await read({ walletFamily: "eip155", chainIds: "ethereum" }));

    expect(snapshot.rejectedEntryCount).toBe(1);
    expect(snapshot.inventoryComplete).toBe(true);
    expect(snapshot.valuationComplete).toBe(true);
    expect(snapshot.totalUsdBasis).toBe("complete");
  });
});

describe("WalletBalances completeness - the top-level envelope", () => {
  it("carries the identical field set as a wallet snapshot", async () => {
    const envelope = await read({ walletFamily: "eip155", chainIds: "ethereum" });
    const snapshot = firstWallet(envelope);

    for (const field of [
      "inventoryComplete",
      "inventorySources",
      "valuationComplete",
      "unpricedHeldCount",
      "pricedTotalUsd",
      "totalUsdBasis",
      "failedChainIds",
    ] as const) {
      expect(envelope).toHaveProperty(field);
      expect(snapshot).toHaveProperty(field);
    }
  });

  it("aggregates both families and keeps each lane's source attribution", async () => {
    const envelope = await read({ walletFamily: "all", chainIds: "ethereum,solana" });

    expect(envelope.wallets).toHaveLength(2);
    expect(envelope.inventorySources.map((entry) => entry.source)).toEqual([
      "khalani_registry_scan",
      "solana_rpc_accounts",
    ]);
    expect(envelope.failedChainIds).toEqual([]);
  });

  it("reports a wallet family that produced no snapshot as the envelope's own gap", async () => {
    solanaWalletAvailable = false;

    const envelope = await read({ walletFamily: "all", chainIds: "ethereum,solana" });

    // Half an answer must never be readable as a whole one, and this outranks
    // every per-wallet reason.
    expect(envelope.wallets).toHaveLength(1);
    expect(envelope.walletErrors).toHaveLength(1);
    expect(envelope.inventoryComplete).toBe(false);
    expect(envelope.inventoryIncompleteReason).toBe("wallet_read_failed");
    expect(envelope.totalUsdBasis).toBe("priced_only");
    // The surviving wallet's own axes are untouched by the sibling's failure.
    expect(firstWallet(envelope).inventoryComplete).toBe(true);
  });
});
