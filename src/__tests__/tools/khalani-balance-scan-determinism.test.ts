/**
 * `getTokenBalancesAcrossChains` returns the SAME bytes for the same wallet,
 * whatever order the providers answer in.
 *
 * The scan fans out over chains with concurrency 4 and pushes rows in RPC
 * COMPLETION order. Held USD alone does not order them: an all-unpriced wallet
 * is one giant tie at 0, so a stable sort just preserves whichever chain
 * answered first. Two identical reads then showed the model two different
 * wallets, and `totalUsd` - a float sum - moved with the row order too.
 *
 * The experiment: script the provider so the SECOND read completes the chains
 * in the exact reverse order of the first, with everything else held equal, and
 * require byte-identical output. Ordering is established with gated promises
 * (rule 06: no wall-clock sleeps, the release order IS the experiment).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CHAIN_IDS = [1, 8453, 42161, 10] as const;

const CHAINS = CHAIN_IDS.map((id) => ({
  id,
  name: `Chain ${id}`,
  type: "eip155" as const,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
}));

const mockGetChains = vi.fn().mockResolvedValue(CHAINS);

/** Resolvers for each in-flight per-chain call, keyed by chain id. */
const gates = new Map<number, () => void>();

vi.mock("@tools/khalani/client.js", async () => {
  const { validateTokenBalancesResponse } = await import("@tools/khalani/validation.js");
  return {
    getKhalaniClient: () => ({
      getChains: mockGetChains,
      getTokenBalances: async (_address: string, chainIds?: number[]) => {
        const chainId = chainIds?.[0] ?? 1;
        await new Promise<void>((resolve) => gates.set(chainId, resolve));
        return validateTokenBalancesResponse(entriesForChain(chainId));
      },
    }),
  };
});

const { getTokenBalancesAcrossChains } = await import("@tools/khalani/balances.js");
const { clearKhalaniChainsCache } = await import("@tools/khalani/chains.js");

/**
 * Deliberately degenerate rows: NO price anywhere, so every row's held USD is
 * 0 and the whole result is one tie. Identical symbols and names on two rows
 * push the comparator down to the address tie-breakers. One entry per chain is
 * refused, to pin the rejection ordering too.
 */
function entriesForChain(chainId: number): unknown[] {
  return [
    {
      address: "0xBBBB",
      chainId,
      name: "Tied Token",
      symbol: "TIE",
      decimals: 18,
      extensions: { balance: "1000000000000000000" },
    },
    {
      address: "0xaaaa",
      chainId,
      name: "Tied Token",
      symbol: "TIE",
      decimals: 18,
      extensions: { balance: "1000000000000000000" },
    },
    {
      address: "0xAAAA",
      chainId,
      name: "Tied Token",
      symbol: "TIE",
      decimals: 6,
      extensions: { balance: "1000000000000000000" },
    },
    {
      address: "0xREFUSED",
      chainId,
      name: "Refused Token",
      symbol: "NOPE",
      decimals: Number.POSITIVE_INFINITY,
      extensions: { balance: "5" },
    },
  ];
}

/** Release the pending per-chain calls in `order`, waiting for each to arrive. */
async function releaseInOrder(order: readonly number[]): Promise<void> {
  for (const chainId of order) {
    // The call may not have reached its gate yet; yield until it registers.
    while (!gates.has(chainId)) {
      await Promise.resolve();
    }
    const release = gates.get(chainId);
    gates.delete(chainId);
    release?.();
    // Let the released continuation run to completion before the next release,
    // so the completion order is exactly `order`.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function scanWithCompletionOrder(order: readonly number[]) {
  const pending = getTokenBalancesAcrossChains({
    address: "0xWallet",
    family: "eip155",
    chainIds: [...CHAIN_IDS],
    // All four chains in flight at once, so every completion order is reachable.
    concurrency: CHAIN_IDS.length,
  });
  await releaseInOrder(order);
  return pending;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearKhalaniChainsCache();
  gates.clear();
  mockGetChains.mockResolvedValue(CHAINS);
});

describe("khalani balance scan determinism", () => {
  it("produces byte-identical output when the providers complete in reverse order", async () => {
    const forward = await scanWithCompletionOrder(CHAIN_IDS);
    const reversed = await scanWithCompletionOrder([...CHAIN_IDS].reverse());

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it("orders tied rows by chain, then lowercased address, then the raw address", async () => {
    const scan = await scanWithCompletionOrder([10, 1, 42161, 8453]);

    // Every row is unpriced, so held USD ties at 0 for all of them and the
    // identity tie-breakers decide. `0xAAAA` and `0xaaaa` share a lowercased
    // address, so the raw address (code points: uppercase before lowercase)
    // separates them.
    expect(scan.tokens.slice(0, 3).map((token) => [token.chainId, token.address])).toEqual([
      [1, "0xAAAA"],
      [1, "0xaaaa"],
      [1, "0xBBBB"],
    ]);
    expect(scan.tokens.map((token) => token.chainId)).toEqual([1, 1, 1, 10, 10, 10, 8453, 8453, 8453, 42161, 42161, 42161]);
  });

  it("orders rejected entries by chain and provider index", async () => {
    const scan = await scanWithCompletionOrder([42161, 10, 8453, 1]);

    expect((scan.rejectedEntries ?? []).map((entry) => entry.chainId)).toEqual([1, 10, 8453, 42161]);
    expect((scan.rejectedEntries ?? []).every((entry) => entry.entryIndex === 3)).toBe(true);
  });
});
