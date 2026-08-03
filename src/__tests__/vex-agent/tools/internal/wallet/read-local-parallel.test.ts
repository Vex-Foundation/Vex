/**
 * S5 — `wallet_balances` scans local chains with bounded concurrency.
 *
 * Each local chain costs a scan-set build, an RPC read and a DexScreener price
 * batch. Running them one after another made the tool's latency scale linearly
 * with the number of local chains — the `wallet_balances` complaint. They are
 * independent reads, so they now run at most 4 at a time.
 *
 * This is a PERF change, and the whole point of pinning it is that the
 * behaviour around it must not move. Everything below the concurrency
 * assertion is a preservation check:
 *   - a dead chain stays SOFT (the family snapshot survives it),
 *   - `totalUsd` / `tokenCount` are computed off the FULL scan,
 *   - the per-chain error text stays sanitized (never a raw RPC URL),
 *   - the output order is CHAIN order, not completion order — otherwise the
 *     same wallet would render differently run to run.
 */

import assert from "node:assert/strict";

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ChainFamily } from "@tools/khalani/types.js";
import { makeTestContext } from "../../_test-context.js";

const LOCAL_CHAIN_IDS = [4663, 4664, 4665, 4666, 4667] as const;

function localChainConfig(id: number) {
  return {
    id,
    name: `Local ${id}`,
    nativeCurrency: { symbol: "ETH", name: "Ether", decimals: 18 },
  };
}

vi.mock("@tools/evm-chains/registry.js", () => ({
  listLocalChains: () => LOCAL_CHAIN_IDS.map((id) => localChainConfig(id)),
  getLocalChain: (id: number) =>
    LOCAL_CHAIN_IDS.includes(id as (typeof LOCAL_CHAIN_IDS)[number])
      ? localChainConfig(id)
      : undefined,
}));

vi.mock("@tools/khalani/balances.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/khalani/balances.js")>();
  return {
    getSelectedChainIdsForFamily: original.getSelectedChainIdsForFamily,
    // No Khalani chains at all: this suite is about the LOCAL side.
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

interface Snapshot {
  scannedChainIds: number[];
  chainErrors: Array<{ chainId: number; message: string }>;
  tokenCount: number;
  totalUsd: number;
}

function snapshotOf(res: { data?: unknown }): Snapshot {
  const [snapshot] = (res.data as { wallets: Snapshot[] }).wallets;
  assert.ok(snapshot, "handler returned no wallet snapshot");
  return snapshot;
}

/** Each chain holds exactly 1 native unit priced at $1 — so totals are countable. */
function oneDollarPerChain() {
  return { nativeWei: 1_000000000000000000n, nativePriceUsd: 1, tokens: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockScanSet.mockResolvedValue([]);
  mockReadLocal.mockResolvedValue(oneDollarPerChain());
});

describe("wallet_balances — local chain scan", () => {
  it("runs the chains in parallel, bounded at 4", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    mockReadLocal.mockImplementation(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      inFlight -= 1;
      return oneDollarPerChain();
    });

    const res = await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT);

    expect(res.success).toBe(true);
    expect(mockReadLocal).toHaveBeenCalledTimes(LOCAL_CHAIN_IDS.length);
    // Serial would peak at 1. Unbounded would peak at 5 and walk straight into
    // the provider's rate limit, which is why the bound exists.
    expect(peakInFlight).toBeGreaterThan(1);
    expect(peakInFlight).toBeLessThanOrEqual(4);
  });

  it("keeps a dead chain SOFT and still totals the ones that answered", async () => {
    mockReadLocal.mockImplementation(async (config: { id: number }) => {
      if (config.id === 4665) throw new Error("connect ECONNREFUSED https://rpc.secret/key");
      return oneDollarPerChain();
    });

    const res = await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT);
    const snap = snapshotOf(res);

    expect(res.success).toBe(true);
    expect(snap.scannedChainIds).toEqual([4663, 4664, 4666, 4667]);
    expect(snap.chainErrors).toHaveLength(1);
    const [chainError] = snap.chainErrors;
    assert.ok(chainError);
    expect(chainError.chainId).toBe(4665);
    // Sanitized: the RPC endpoint (and its key) never reaches the model.
    expect(chainError.message).not.toContain("rpc.secret");

    // Computed off the FULL scan — four surviving chains at $1 each.
    expect(snap.totalUsd).toBeCloseTo(4);
    expect(snap.tokenCount).toBe(4);
  });

  it("reports chains in CHAIN order even when they finish out of order", async () => {
    // Later chains answer first; a completion-ordered implementation would
    // render the same wallet differently on every run.
    mockReadLocal.mockImplementation(async (config: { id: number }) => {
      const delayMs = (4667 - config.id) * 4;
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
      return oneDollarPerChain();
    });

    const snap = snapshotOf(await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT));

    expect(snap.scannedChainIds).toEqual([...LOCAL_CHAIN_IDS]);
  });

  it("stops the scan when the operator stops the run", async () => {
    const controller = new AbortController();
    controller.abort();

    const res = await handleWalletBalances(
      { walletFamily: "eip155" },
      makeTestContext({ abortSignal: controller.signal }),
    );

    // The abort surfaces as the family's error rather than a fabricated empty
    // snapshot — a wallet reported as holding nothing would be a lie.
    expect(res.success).toBe(false);
    expect(mockReadLocal).not.toHaveBeenCalled();
  });
});
