/**
 * `WalletBalances` on Robinhood Chain 4663 after the Blockscout identity union
 * (WP6b): what the agent is told the read enumerated, and what it is told when
 * the enumeration could not be trusted.
 *
 * WHY THIS FILE EXISTS. 4663 was read from four seed tokens plus the wallet's
 * pins, so a token held there and never pinned was invisible and the tool could
 * only ever answer `source_not_exhaustive`. The union removes the blindness,
 * and it introduces the failure this suite exists to pin down: when the indexer
 * cannot answer, the tool must return FEWER CLAIMS, never fewer facts. Both
 * wallet references get exactly this wrong (MetaMask's swallowed detection
 * error becomes an empty result indistinguishable from "no tokens here",
 * `TokenBalancesController.ts:958-1022`).
 *
 * The handler under test is the REAL one, and so are the enumeration union and
 * the Blockscout client. Scripted boundaries: the Electron transport (a Node
 * test process cannot host one), the pinned-token DB read, the chain RPC read,
 * and the Khalani scan. Scaffold mirrors `read-completeness.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { ChainFamily } from "@tools/khalani/types.js";
import { buildRobinhoodTokenBalancesUrl } from "@tools/blockscout/operation.js";
import {
  registerBlockscoutTransport,
  type BlockscoutTransport,
} from "@tools/blockscout/transport.js";
import { makeTestContext } from "../../_test-context.js";

const ROBINHOOD_CHAIN_ID = 4663;
const WALLET = "0x1234567890abcdef1234567890abcdef12345678";
/** Held, discovered by the indexer only: invisible to the seed list and pins. */
const DISCOVERED = "0x1111111111111111111111111111111111111111";
const VEX = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";

const encoder = new TextEncoder();

vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: () => Promise.resolve([]),
  readTokenPools: () => Promise.resolve([]),
}));

const mockScan = vi.fn();
vi.mock("@tools/khalani/balances.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/khalani/balances.js")>();
  return {
    getSelectedChainIdsForFamily: original.getSelectedChainIdsForFamily,
    calculateTokensTotalUsd: original.calculateTokensTotalUsd,
    parseBalanceChainSelection: async () => ({ rawProvided: true, byFamily: new Map() }),
    getTokenBalancesAcrossChains: (...a: unknown[]) => mockScan(...a),
  };
});

vi.mock("@tools/evm-chains/resolver.js", () => ({
  resolveInclusiveEvmChain: async () => ({
    source: "local",
    chainId: ROBINHOOD_CHAIN_ID,
    family: "eip155",
  }),
}));

const mockReadLocal = vi.fn();
vi.mock("@tools/evm-chains/balances.js", () => ({
  readLocalChainBalances: (...a: unknown[]) => mockReadLocal(...a),
}));

// The DB seam only. `buildLocalChainInventory` itself is REAL here, so the
// enumeration this suite asserts is the one production runs.
const mockPinned = vi.fn();
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  getTrackedTokenAddressesForChain: (...a: unknown[]) => mockPinned(...a),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: () => WALLET,
}));

const { handleWalletBalances } = await import(
  "../../../../../vex-agent/tools/internal/wallet/read.js"
);

const CONTEXT = makeTestContext();

interface InventorySourceRow {
  chainId: number;
  source: string;
  result: string;
  exhaustive: boolean;
  observedAt: string | null;
  failureImpact?: string;
  failureReason?: string;
}

interface TokenRow {
  symbol: string;
  address: string;
  decimals: number;
  balanceRaw: string;
  balance: string | null;
  providerFlags?: { reputation: string | null };
}

interface Snapshot {
  inventoryComplete: boolean;
  inventoryIncompleteReason?: string;
  inventorySources: InventorySourceRow[];
  failedChainIds: number[];
  chainErrors: Array<{ chainId: number; message: string }>;
  tokens: TokenRow[];
}

interface Envelope {
  inventoryComplete: boolean;
  inventoryIncompleteReason?: string;
  wallets: Snapshot[];
}

/** The one snapshot every case expects; a missing one fails with the envelope. */
function firstWallet(envelope: Envelope): Snapshot {
  const wallet = envelope.wallets[0];
  if (wallet === undefined) {
    throw new Error(`expected one wallet snapshot, got: ${JSON.stringify(envelope)}`);
  }
  return wallet;
}

function sourceOf(snapshot: Snapshot, source: string): InventorySourceRow {
  const row = snapshot.inventorySources.find((entry) => entry.source === source);
  if (row === undefined) {
    throw new Error(`no "${source}" inventory source in: ${JSON.stringify(snapshot.inventorySources)}`);
  }
  return row;
}

function tokenOf(snapshot: Snapshot, address: string): TokenRow {
  const row = snapshot.tokens.find(
    (token) => token.address.toLowerCase() === address.toLowerCase(),
  );
  if (row === undefined) {
    throw new Error(`no row for ${address} in: ${JSON.stringify(snapshot.tokens)}`);
  }
  return row;
}

/** One provider row in the live shape measured in `BLOCKSCOUT.md`. */
function providerRow(address: string, overrides: Record<string, unknown> = {}) {
  return {
    token: {
      address_hash: address,
      // Deliberately WRONG against the chain below: an indexer scale must never
      // reach a wallet row, and this is how the suite can tell if one did.
      decimals: "9",
      exchange_rate: null,
      name: "Indexer Name",
      reputation: "ok",
      symbol: "INDEXER",
      type: "ERC-20",
      ...overrides,
    },
    token_id: null,
    token_instance: null,
    // Also wrong on purpose: the balance a trade is sized from comes from RPC.
    value: "999999999999999999999",
  };
}

let unregisterTransport: (() => void) | null = null;

function mountBlockscout(
  implementation: BlockscoutTransport["fetchAddressTokenBalances"],
): void {
  unregisterTransport?.();
  unregisterTransport = registerBlockscoutTransport({
    name: "electron_net",
    fetchAddressTokenBalances: implementation,
  });
}

function mountInventory(rows: readonly ReturnType<typeof providerRow>[]): void {
  mountBlockscout(async (address) => ({
    finalUrl: buildRobinhoodTokenBalancesUrl(address).toString(),
    status: 200,
    contentType: "application/json",
    body: encoder.encode(JSON.stringify(rows)),
  }));
}

/** What the CHAIN says about the discovered token: 18 decimals, 2 whole units. */
function chainRead() {
  return {
    nativeWei: 0n,
    nativePriceUsd: null,
    tokens: [
      {
        address: DISCOVERED,
        symbol: "AIRDROP",
        decimals: 18,
        balanceWei: 2_000000000000000000n,
        priceUsd: null,
      },
    ],
    tokenFailures: [],
    priceTiers: { tier0: 0, tier1: 0, unpriced: 1 },
  };
}

async function read(): Promise<Envelope> {
  const res = await handleWalletBalances(
    { walletFamily: "eip155", chainIds: "robinhood" },
    CONTEXT,
  );
  expect(res.success).toBe(true);
  return JSON.parse(res.output) as Envelope;
}

/** The addresses the chain read was actually asked for. */
function scannedAddresses(): string[] {
  const call = mockReadLocal.mock.calls[0];
  if (call === undefined) throw new Error("the chain RPC read was never called");
  const addresses = call[2];
  if (!Array.isArray(addresses)) {
    throw new Error(`unexpected scan-set argument: ${JSON.stringify(call)}`);
  }
  return addresses.map((address) => String(address).toLowerCase());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPinned.mockResolvedValue([]);
  mockReadLocal.mockResolvedValue(chainRead());
  mountInventory([providerRow(DISCOVERED)]);
});

afterEach(() => {
  unregisterTransport?.();
  unregisterTransport = null;
});

describe("WalletBalances on 4663 - a complete indexer answer", () => {
  it("scans the indexer's identities and finally reports a COMPLETE inventory", async () => {
    const snapshot = firstWallet(await read());

    // The seed list can see four tokens; the union added the fifth the wallet
    // actually holds and nobody pinned.
    expect(scannedAddresses()).toContain(DISCOVERED.toLowerCase());
    expect(scannedAddresses()).toContain(VEX.toLowerCase());
    expect(snapshot.inventoryComplete).toBe(true);
    expect(snapshot.inventoryIncompleteReason).toBeUndefined();
    expect(snapshot.failedChainIds).toEqual([]);
    expect(snapshot.inventorySources).toEqual([
      {
        chainId: ROBINHOOD_CHAIN_ID,
        source: "blockscout_erc20_inventory",
        result: "read",
        exhaustive: true,
        observedAt: expect.any(String),
      },
      {
        chainId: ROBINHOOD_CHAIN_ID,
        source: "local_chain_indexer_union",
        result: "read",
        exhaustive: true,
        observedAt: expect.any(String),
      },
    ]);
  });

  it("re-reads the row from the chain and never echoes an indexer number", async () => {
    const row = tokenOf(firstWallet(await read()), DISCOVERED);

    // Identity from the indexer, every NUMBER and the symbol from RPC.
    expect(row.symbol).toBe("AIRDROP");
    expect(row.decimals).toBe(18);
    expect(row.balanceRaw).toBe("2000000000000000000");
    expect(row.balance).toBe("2");
    // The indexer's own claims are not anywhere in the answer.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("999999999999999999999");
    expect(serialized).not.toContain("INDEXER");
  });

  it("carries the provider's reputation label verbatim and never filters on it", async () => {
    mountInventory([providerRow(DISCOVERED, { reputation: "spam" })]);

    const row = tokenOf(firstWallet(await read()), DISCOVERED);

    // Rabby drops these rows before its store, with no counter and no switch.
    // The owner's decision is the opposite: show the row, carry the label.
    expect(row.providerFlags).toEqual({ reputation: "spam" });
  });

  it("keeps one row when the indexer names a token the seed list already has", async () => {
    mountInventory([providerRow(VEX)]);
    mockReadLocal.mockResolvedValue({
      ...chainRead(),
      tokens: [
        { address: VEX, symbol: "VEX", decimals: 18, balanceWei: 1_000000000000000000n, priceUsd: null },
      ],
    });

    const snapshot = firstWallet(await read());

    expect(scannedAddresses().filter((address) => address === VEX.toLowerCase())).toHaveLength(1);
    expect(snapshot.tokens.filter((token) => token.address.toLowerCase() === VEX.toLowerCase())).toHaveLength(1);
  });
});

describe("WalletBalances on 4663 - the indexer could not answer", () => {
  beforeEach(() => {
    mountBlockscout(async () => ({
      finalUrl: buildRobinhoodTokenBalancesUrl(WALLET).toString(),
      status: 403,
      contentType: "text/html; charset=UTF-8",
      body: encoder.encode("<html>challenge</html>"),
    }));
    mockReadLocal.mockResolvedValue({
      ...chainRead(),
      tokens: [
        { address: VEX, symbol: "VEX", decimals: 18, balanceWei: 1_000000000000000000n, priceUsd: null },
      ],
    });
  });

  it("degrades the CLAIM to source_not_exhaustive, never the rows", async () => {
    const snapshot = firstWallet(await read());

    expect(snapshot.inventoryComplete).toBe(false);
    expect(snapshot.inventoryIncompleteReason).toBe("source_not_exhaustive");
    // The seed rows were still read live from the chain, and they are true.
    expect(tokenOf(snapshot, VEX).balanceRaw).toBe("1000000000000000000");
    expect(scannedAddresses()).toContain(VEX.toLowerCase());
  });

  it("does NOT report 4663 as a failed chain, whose holdings would be unknown", async () => {
    const snapshot = firstWallet(await read());

    expect(snapshot.failedChainIds).toEqual([]);
    expect(snapshot.chainErrors).toEqual([]);
  });

  it("names the indexer failure, its impact and the provider's own reason", async () => {
    const snapshot = firstWallet(await read());

    expect(sourceOf(snapshot, "blockscout_erc20_inventory")).toEqual({
      chainId: ROBINHOOD_CHAIN_ID,
      result: "failed",
      source: "blockscout_erc20_inventory",
      exhaustive: false,
      // C3.5: a read that observed nothing is never stamped fresh.
      observedAt: null,
      failureImpact: "enumeration_breadth",
      failureReason: "unavailable",
    });
    expect(sourceOf(snapshot, "local_chain_seed_and_pins").exhaustive).toBe(false);
  });

  it("reports the same verdict on the envelope, never a rosier one", async () => {
    const envelope = await read();

    expect(envelope.inventoryComplete).toBe(false);
    expect(envelope.inventoryIncompleteReason).toBe("source_not_exhaustive");
  });

  it("still refuses to claim completeness on a PARTIAL answer that carried candidates", async () => {
    mountInventory([
      providerRow(DISCOVERED),
      providerRow(VEX, { decimals: "not-a-number" }),
    ]);

    const snapshot = firstWallet(await read());

    // The candidate it did parse is scanned; the claim is still withheld.
    expect(scannedAddresses()).toContain(DISCOVERED.toLowerCase());
    expect(snapshot.inventoryComplete).toBe(false);
    expect(snapshot.inventoryIncompleteReason).toBe("source_not_exhaustive");
    expect(sourceOf(snapshot, "blockscout_erc20_inventory")).toEqual(
      expect.objectContaining({ result: "read", exhaustive: false, failureReason: "invalid_response" }),
    );
  });
});

describe("WalletBalances on 4663 - the chain itself failed", () => {
  it("reports a failed chain read while keeping the enumeration's own verdict", async () => {
    mockReadLocal.mockRejectedValue(new Error("rpc down"));

    const snapshot = firstWallet(await read());

    expect(snapshot.failedChainIds).toEqual([ROBINHOOD_CHAIN_ID]);
    expect(snapshot.inventoryIncompleteReason).toBe("chain_read_failed");
    // The identity enumeration DID answer, and its row says so with its own
    // observation time - the two outcomes are never folded into one.
    expect(sourceOf(snapshot, "blockscout_erc20_inventory")).toEqual({
      chainId: ROBINHOOD_CHAIN_ID,
      source: "blockscout_erc20_inventory",
      result: "read",
      exhaustive: true,
      observedAt: expect.any(String),
    });
    expect(sourceOf(snapshot, "local_chain_indexer_union")).toEqual({
      chainId: ROBINHOOD_CHAIN_ID,
      source: "local_chain_indexer_union",
      result: "failed",
      exhaustive: true,
      observedAt: null,
    });
  });

  it("PROPAGATES a pinned-token DB failure as a chain error, never as an empty chain", async () => {
    mockPinned.mockRejectedValue(new Error("db read down"));

    const snapshot = firstWallet(await read());

    expect(snapshot.failedChainIds).toEqual([ROBINHOOD_CHAIN_ID]);
    expect(snapshot.tokens).toEqual([]);
    // No scan set was ever built, so the chain reports the bounded source it
    // fell back to rather than a fresh claim about an indexer it never asked.
    expect(snapshot.inventorySources).toEqual([
      {
        chainId: ROBINHOOD_CHAIN_ID,
        source: "local_chain_seed_and_pins",
        result: "failed",
        exhaustive: false,
        observedAt: null,
      },
    ]);
  });
});
