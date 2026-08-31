/**
 * A4 - `wallet_balances` surfaces PER-TOKEN read failures.
 *
 * The local scan reads each token through `multicall({ allowFailure: true })`,
 * so one token can fail while the rest of the chain answers. Those failures
 * used to be dropped on the floor: the chain reported successfully, the token
 * simply was not in the list, and "the read failed" was indistinguishable from
 * "you hold none of it" - the exact confusion the 2026-08-10 TOM incident ran
 * on for five minutes.
 *
 * A per-token failure is NOT a chain failure: the chain still scanned, and its
 * surviving tokens and totals stay in the answer. It is reported beside
 * `chainErrors`, bounded, so a chain with a huge broken scan set cannot flood
 * the model's context.
 *
 * Mock wiring mirrors `read-local-parallel.test.ts` (same seams, same fakes).
 */

import assert from "node:assert/strict";

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ChainFamily } from "@tools/khalani/types.js";
import { makeTestContext } from "../../_test-context.js";

const LOCAL_CHAIN_IDS = [4663, 4664] as const;

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
const TOKEN_A = "0x8BA2546F49799782bC799055c268d3c0C63699b8";

interface Snapshot {
  scannedChainIds: number[];
  chainErrors: Array<{ chainId: number; message: string }>;
  tokenErrors: Array<{ chainId: number; tokenAddress: string; reason: string }>;
  tokenErrorsOmitted?: number;
  tokenCount: number;
  totalUsd: number;
  inventoryComplete: boolean;
  inventoryIncompleteReason?: string;
  valuationComplete: boolean;
  totalUsdBasis: string;
}

function snapshotOf(res: { data?: unknown }): Snapshot {
  const [snapshot] = (res.data as { wallets: Snapshot[] }).wallets;
  assert.ok(snapshot, "handler returned no wallet snapshot");
  return snapshot;
}

function chainRead(tokenFailures: Array<{ address: string; reason: string }> = []) {
  return { nativeWei: 1_000000000000000000n, nativePriceUsd: 1, tokens: [], tokenFailures };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockScanSet.mockResolvedValue([]);
  mockReadLocal.mockResolvedValue(chainRead());
});

describe("wallet_balances - per-token read failures", () => {
  it("reports no tokenErrors when every read answered", async () => {
    const snap = snapshotOf(await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT));

    expect(snap.tokenErrors).toStrictEqual([]);
  });

  it("names the chain, the token and the reason for a failed per-token read", async () => {
    mockReadLocal.mockImplementation(async (config: { id: number }) =>
      config.id === 4663
        ? chainRead([{ address: TOKEN_A, reason: "balance-read-failed" }])
        : chainRead(),
    );

    const res = await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT);
    const snap = snapshotOf(res);

    expect(res.success).toBe(true);
    expect(snap.tokenErrors).toHaveLength(1);
    const [tokenError] = snap.tokenErrors;
    assert.ok(tokenError);
    expect(tokenError.chainId).toBe(4663);
    expect(tokenError.tokenAddress).toBe(TOKEN_A);
    expect(tokenError.reason).toBe("balance-read-failed");
  });

  it("keeps a per-token failure OUT of chainErrors - the chain itself answered", async () => {
    mockReadLocal.mockImplementation(async (config: { id: number }) =>
      config.id === 4663
        ? chainRead([{ address: TOKEN_A, reason: "metadata-read-failed" }])
        : chainRead(),
    );

    const snap = snapshotOf(await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT));

    expect(snap.chainErrors).toStrictEqual([]);
    expect(snap.scannedChainIds).toEqual([4663, 4664]);
    // Both chains still contribute their native dollar.
    expect(snap.totalUsd).toBeCloseTo(2);
  });

  it("bounds the list and says how many were omitted", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      address: `0x${String(index).padStart(40, "0")}`,
      reason: "balance-read-failed",
    }));
    mockReadLocal.mockImplementation(async (config: { id: number }) =>
      config.id === 4663 ? chainRead(many) : chainRead(),
    );

    const snap = snapshotOf(await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT));

    expect(snap.tokenErrors.length).toBeLessThanOrEqual(20);
    expect(snap.tokenErrorsOmitted).toBe(30 - snap.tokenErrors.length);
    // The bounded LIST does not bound the axis: every failed token is an
    // inventory gap, including the ones the 20-row cap left out.
    expect(snap.inventoryComplete).toBe(false);
    expect(snap.inventoryIncompleteReason).toBe("token_read_failed");
  });

  it("a per-token failure costs the INVENTORY axis and not the valuation axis", async () => {
    mockReadLocal.mockImplementation(async (config: { id: number }) =>
      config.id === 4663
        ? chainRead([{ address: TOKEN_A, reason: "balance-read-failed" }])
        : chainRead(),
    );

    const snap = snapshotOf(await handleWalletBalances({ walletFamily: "eip155" }, CONTEXT));

    expect(snap.inventoryComplete).toBe(false);
    expect(snap.inventoryIncompleteReason).toBe("token_read_failed");
    // The rows that DID answer are fully valued; only the basis degrades.
    expect(snap.valuationComplete).toBe(true);
    expect(snap.totalUsdBasis).toBe("priced_only");
  });
});
