/**
 * WP1 - `WalletBalances` emits the human amount on EVERY lane, end to end.
 *
 * The unit contract is pinned at the conversion owner in
 * `protocols/balance-row-unit-contract.test.ts`. This suite drives the REAL
 * handler over scripted provider boundaries, because the defect was not that
 * the conversion was wrong: it was that the handler shipped the raw integer and
 * left the division to the model, which got it wrong by three orders of
 * magnitude on a balance it then sized a trade against.
 *
 * Mock wiring mirrors `read-local-token-errors.test.ts` (same seams, same fakes).
 */

import assert from "node:assert/strict";

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ChainFamily } from "@tools/khalani/types.js";
import type {
  SolanaBalanceRow,
  SolanaWalletSnapshotReader,
} from "@tools/solana-ecosystem/balances/wallet-snapshot.js";
import { makeTestContext } from "../../_test-context.js";

const LOCAL_CHAIN_ID = 4663;
const SOLANA_CHAIN_ID = 20_011_000_000;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
/** The exact raw balance from the incident transcript, at 18 decimals. */
const INCIDENT_RAW = 9873301706589007n;
const INCIDENT_HUMAN = "0.009873301706589007";

function localChainConfig(id: number) {
  return {
    id,
    name: `Local ${id}`,
    nativeCurrency: { symbol: "ETH", name: "Ether", decimals: 18 },
  };
}

vi.mock("@tools/evm-chains/registry.js", () => ({
  listLocalChains: () => [localChainConfig(LOCAL_CHAIN_ID)],
  getLocalChain: (id: number) => (id === LOCAL_CHAIN_ID ? localChainConfig(id) : undefined),
}));

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
    parseBalanceChainSelection: async () => ({ rawProvided: false, byFamily: new Map() }),
    getTokenBalancesAcrossChains: async ({ family }: { family: ChainFamily }) => ({
      address: "0xWALLET",
      family,
      tokens: [],
      scannedChainIds: [],
      chainErrors: [],
      totalUsd: 0,
    }),
  };
});

vi.mock("@tools/evm-chains/resolver.js", () => ({
  resolveInclusiveEvmChain: async () => { throw new Error("not used"); },
}));

const mockScanSet = vi.fn();
vi.mock("@vex-agent/sync/local-chain-balance-sync.js", () => ({
  buildTokenScanSet: (...a: unknown[]) => mockScanSet(...a),
}));

const mockReadLocal = vi.fn();
vi.mock("@tools/evm-chains/balances.js", () => ({
  readLocalChainBalances: (...a: unknown[]) => mockReadLocal(...a),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: () => "0xWALLET",
}));

const { handleWalletBalances } = await import(
  "../../../../../vex-agent/tools/internal/wallet/read.js"
);

const CONTEXT = makeTestContext();

interface Row {
  symbol: string | null;
  address: string;
  decimals: number;
  balanceRaw?: string;
  balance?: string | null;
  valueUsd?: string | null;
  priceUsd?: string | null;
  priceUnavailable?: true;
  unprojectableReason?: string;
}

function rowsOf(res: { data?: unknown }, index = 0): Row[] {
  const snapshot = (res.data as { wallets: Array<{ tokens: Row[] }> }).wallets[index];
  assert.ok(snapshot, "handler returned no wallet snapshot");
  return snapshot.tokens;
}

/** The completeness half of a snapshot: the axes these rows have to agree with. */
interface SnapshotAxes {
  inventoryComplete: boolean;
  inventoryIncompleteReason?: string;
  valuationComplete: boolean;
  unpricedHeldCount: number;
  pricedTotalUsd: string;
  totalUsdBasis: string;
}

function snapshotOf(res: { data?: unknown }, index = 0): SnapshotAxes {
  const snapshot = (res.data as { wallets: SnapshotAxes[] }).wallets[index];
  assert.ok(snapshot, "handler returned no wallet snapshot");
  return snapshot;
}

function find(rows: Row[], address: string): Row {
  const row = rows.find((candidate) => candidate.address === address);
  assert.ok(row, `no row for ${address}`);
  return row;
}

function localRead(tokens: Array<{
  address: string;
  symbol: string;
  decimals: number;
  balanceWei: bigint;
  priceUsd: number | null;
}> = []) {
  return { nativeWei: INCIDENT_RAW, nativePriceUsd: 2522.5, tokens, tokenFailures: [] };
}

function solanaSnapshot(
  rows: readonly SolanaBalanceRow[],
  totalUsd = 0,
): SolanaWalletSnapshotReader {
  return async (address) => ({
    address,
    rows,
    totalUsd,
    accountFailures: [],
    stats: {
      accountsScanned: 0,
      zeroSkipped: 0,
      frozenAccounts: 0,
      metadataMissing: 0,
      unpriced: 0,
      priceTiers: { tier0: 0, tier1: 0, unpriced: 0 },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockScanSet.mockResolvedValue([]);
  mockReadLocal.mockResolvedValue(localRead());
});

describe("WalletBalances - the incident row, end to end", () => {
  it("ships the human amount beside the raw one for the local-chain native row", async () => {
    const rows = rowsOf(await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT));
    const native = rows[0];
    assert.ok(native);

    expect(native.balanceRaw).toBe(INCIDENT_RAW.toString());
    // The model is handed the answer, not the division.
    expect(native.balance).toBe(INCIDENT_HUMAN);
    expect(native.decimals).toBe(18);
    expect(Number(native.valueUsd)).toBeLessThan(26);
    expect(native.priceUsd).toBe("2522.5");
  });

  it("ships the quartet on every ERC-20 row too, including a 0-decimals token", async () => {
    mockReadLocal.mockResolvedValue(localRead([
      { address: WETH, symbol: "WETH", decimals: 18, balanceWei: INCIDENT_RAW, priceUsd: 2522.5 },
      // `decimals || 18` would turn this whole-unit balance into dust.
      { address: "0xZERO", symbol: "ZED", decimals: 0, balanceWei: 42n, priceUsd: 2 },
    ]));

    const rows = rowsOf(await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT));

    for (const row of rows) {
      expect(row).toHaveProperty("balanceRaw");
      expect(row).toHaveProperty("balance");
      expect(row).toHaveProperty("valueUsd");
      expect(typeof row.decimals).toBe("number");
    }
    expect(find(rows, WETH).balance).toBe(INCIDENT_HUMAN);
    const zeroDecimals = find(rows, "0xZERO");
    expect(zeroDecimals.balance).toBe("42");
    expect(zeroDecimals.valueUsd).toBe("84");
  });

  it("reports an unpriced row as null-valued and flagged, never as zero", async () => {
    mockReadLocal.mockResolvedValue(localRead([
      { address: WETH, symbol: "WETH", decimals: 18, balanceWei: INCIDENT_RAW, priceUsd: null },
    ]));

    const row = find(rowsOf(await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT)), WETH);

    expect(row.balance).toBe(INCIDENT_HUMAN);
    expect(row.valueUsd).toBeNull();
    expect(row.valueUsd).not.toBe("0");
    expect(row.priceUnavailable).toBe(true);
  });

  it("keeps a row whose decimals are impossible, named, rather than guessing 18", async () => {
    mockReadLocal.mockResolvedValue(localRead([
      { address: WETH, symbol: "WETH", decimals: Number.POSITIVE_INFINITY, balanceWei: INCIDENT_RAW, priceUsd: 2522.5 },
    ]));

    const res = await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT);
    const row = find(rowsOf(res), WETH);

    expect(row.balanceRaw).toBe(INCIDENT_RAW.toString());
    expect(row.balance).toBeNull();
    expect(row.valueUsd).toBeNull();
    expect(row.unprojectableReason).toBe("decimals_invalid");
    // The row-level refusal and the envelope agree: the holding was ENUMERATED
    // and could not be VALUED, so the total is priced-only. The unconvertible
    // row adds NO inventory gap of its own - the only reason reported is the
    // local chain's bounded token set.
    const snapshot = snapshotOf(res);
    expect(snapshot.inventoryIncompleteReason).toBe("source_not_exhaustive");
    expect(snapshot.valuationComplete).toBe(false);
    expect(snapshot.totalUsdBasis).toBe("priced_only");
  });
});

/**
 * REGRESSION, found while writing this suite and not by the brief.
 *
 * `heldUsd` fed the row's decimals straight to `formatUnits`, which THROWS on a
 * non-integer scale. It runs inside the per-chain `try`, so ONE token whose
 * provider reported `Infinity` decimals threw past every good row on that chain
 * and the whole chain came back as a `chainError`: a funded wallet reported as
 * holding nothing there, from a single hostile or broken token's metadata.
 *
 * Delete the `isTokenDecimals` guard in `heldUsd` and this test goes red.
 */
describe("WalletBalances - one poisoned token never takes its chain down", () => {
  const GOOD = "0xGOOD";
  const POISONED = "0xPOISON";

  beforeEach(() => {
    mockReadLocal.mockResolvedValue(localRead([
      { address: GOOD, symbol: "GOOD", decimals: 18, balanceWei: 3_000000000000000000n, priceUsd: 10 },
      { address: POISONED, symbol: "BAD", decimals: Number.POSITIVE_INFINITY, balanceWei: 1n, priceUsd: 5 },
      { address: "0xGOOD2", symbol: "GD2", decimals: 6, balanceWei: 2_000000n, priceUsd: 1 },
    ]));
  });

  it("keeps every good row on the chain intact beside the unprojectable one", async () => {
    const rows = rowsOf(await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT));

    // The good rows survived, fully converted.
    expect(find(rows, GOOD).balance).toBe("3");
    expect(find(rows, GOOD).valueUsd).toBe("30");
    expect(find(rows, "0xGOOD2").balance).toBe("2");
    // The poisoned row is present, honest, and unusable for sizing.
    expect(find(rows, POISONED).balance).toBeNull();
    expect(find(rows, POISONED).unprojectableReason).toBe("decimals_invalid");
  });

  it("still reports the chain as scanned, with no chain error", async () => {
    const res = await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT);
    const snapshot = (res.data as {
      wallets: Array<{ scannedChainIds: number[]; chainErrors: unknown[]; totalUsd: number }>;
    }).wallets[0];
    assert.ok(snapshot);

    expect(snapshot.chainErrors).toStrictEqual([]);
    expect(snapshot.scannedChainIds).toContain(LOCAL_CHAIN_ID);
    // The native row (0.009873 ETH at 2522.5) plus the two good tokens. The
    // poisoned row contributes nothing rather than throwing the total away.
    expect(snapshot.totalUsd).toBeGreaterThan(30);
  });
});

describe("WalletBalances - the Solana lane carries the same contract", () => {
  it("emits balanceRaw + balance + valueUsd for a Solana row", async () => {
    const res = await handleWalletBalances(
      { walletFamily: "solana" },
      CONTEXT,
      {
        readSolanaSnapshot: solanaSnapshot([{
          mint: "So11111111111111111111111111111111111111112",
          symbol: "SOL",
          name: "Solana",
          decimals: 9,
          amountRaw: "1234567891",
          priceUsd: 150,
          usdValue: 185.185,
          isNative: true,
        }], 185.185),
      },
    );

    const row = rowsOf(res)[0];
    assert.ok(row);
    expect(row.balanceRaw).toBe("1234567891");
    expect(row.balance).toBe("1.234567891");
    expect(row.decimals).toBe(9);
    expect(Number(row.valueUsd)).toBeCloseTo(185.185, 3);
  });
});

describe("WalletBalances - the concise trim still sorts by the RAW amount", () => {
  it("keeps the richest priced row when limit trims, reading balanceRaw not balance", async () => {
    mockReadLocal.mockResolvedValue(localRead([
      { address: "0xSMALL", symbol: "SML", decimals: 18, balanceWei: 1n, priceUsd: 1 },
      { address: "0xBIG", symbol: "BIG", decimals: 18, balanceWei: 5_000000000000000000n, priceUsd: 100 },
    ]));

    const rows = rowsOf(await handleWalletBalances(
      { walletFamily: "eip155", response_format: "concise", limit: 1 },
      CONTEXT,
    ));

    // A trim that read the HUMAN string through `BigInt` would throw and score
    // every row 0, silently returning whichever row happened to come first.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.address).toBe("0xBIG");
    expect(rows[0]?.balance).toBe("5");
  });
});
