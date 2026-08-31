/**
 * wallet_balances concise+limit must not hide a holding just because it has no
 * price feed.
 *
 * WHY THIS FILE EXISTS - live 2026-08-10: with response_format "concise" and a
 * limit, tokens were sorted by held USD (an unpriced row scores 0) and sliced,
 * so a real balance with no DexScreener price was cut FIRST and was
 * indistinguishable from "you do not hold this token". Unpriced non-zero rows
 * are now always retained, after the priced rows, marked `priceUnavailable`.
 *
 * Mock scaffold mirrors `read.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ChainFamily } from "@tools/khalani/types.js";

const mockScan = vi.fn();
vi.mock("@tools/khalani/balances.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/khalani/balances.js")>();
  return {
    getSelectedChainIdsForFamily: original.getSelectedChainIdsForFamily,
    parseBalanceChainSelection: async (raw: string | undefined) => {
      if (!raw) return { rawProvided: false, byFamily: new Map() };
      return { rawProvided: true, byFamily: new Map<ChainFamily, number[]>() };
    },
    getTokenBalancesAcrossChains: (...a: unknown[]) => mockScan(...a),
  };
});

vi.mock("@tools/evm-chains/resolver.js", () => ({
  resolveInclusiveEvmChain: async (input: string) => {
    if (input.trim().toLowerCase() === "robinhood") {
      return { source: "local", chainId: 4663, family: "eip155" };
    }
    throw new Error(`Unsupported chain: ${input}`);
  },
}));

const mockReadLocal = vi.fn();
vi.mock("@tools/evm-chains/balances.js", () => ({
  readLocalChainBalances: (...a: unknown[]) => mockReadLocal(...a),
}));

const mockScanSet = vi.fn();
vi.mock("@vex-agent/sync/local-chain-balance-sync.js", () => ({
  buildTokenScanSet: (...a: unknown[]) => mockScanSet(...a),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: () => "0xWALLET",
}));

const { handleWalletBalances } = await import(
  "../../../../../vex-agent/tools/internal/wallet/read.js"
);

const CONTEXT = {
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
} as never;

const ONE = 1_000000000000000000n;

/** Mirrors `MAX_UNPRICED_TOKENS_PER_SNAPSHOT` in the handler. */
const UNPRICED_CAP = 20;

/** Four priced holdings ($40/$30/$20/$10) plus two unpriced non-zero ones. */
function localRead() {
  return {
    nativeWei: 0n,
    nativePriceUsd: null,
    tokens: [
      { address: "0xa", symbol: "AAA", decimals: 18, balanceWei: ONE * 40n, priceUsd: 1 },
      { address: "0xu", symbol: "UNP", decimals: 18, balanceWei: ONE * 5n, priceUsd: null },
      { address: "0xb", symbol: "BBB", decimals: 18, balanceWei: ONE * 30n, priceUsd: 1 },
      { address: "0xc", symbol: "CCC", decimals: 18, balanceWei: ONE * 20n, priceUsd: 1 },
      { address: "0xv", symbol: "UN2", decimals: 18, balanceWei: ONE * 7n, priceUsd: null },
      { address: "0xd", symbol: "DDD", decimals: 18, balanceWei: ONE * 10n, priceUsd: 1 },
    ],
    tokenFailures: [],
  };
}

type Row = { symbol: string; priceUsd?: string | null; priceUnavailable?: boolean };

/** Only the fields these tests assert on; the handler emits more. */
type Snapshot = {
  tokens: Row[];
  tokenCount: number;
  unpricedOmitted?: number;
  unpricedHeldCount: number;
  inventorySources: Array<{ chainId: number; observedAt: string | null }>;
  truncated: boolean;
  truncationNote?: string;
};

/**
 * A snapshot with its per-chain observation times replaced by a constant, so
 * two live reads taken milliseconds apart can be compared field for field.
 */
function withNormalisedObservationTimes(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    inventorySources: snapshot.inventorySources.map((source) => ({
      ...source,
      observedAt: source.observedAt === null ? null : "OBSERVED_AT",
    })),
  };
}

async function tokensFor(params: Record<string, unknown>): Promise<Row[]> {
  const res = await handleWalletBalances({ walletFamily: "eip155", chainIds: "robinhood", ...params }, CONTEXT);
  expect(res.success).toBe(true);
  const snap = (res.data as { wallets: Array<{ tokens: Row[] }> }).wallets[0]!;
  return snap.tokens;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockScanSet.mockResolvedValue([]);
  mockReadLocal.mockResolvedValue(localRead());
});

describe("wallet_balances concise+limit - unpriced holdings are never silently cut", () => {
  it("retains unpriced non-zero rows beyond the limit, marked and placed last", async () => {
    const tokens = await tokensFor({ response_format: "concise", limit: 2 });

    expect(tokens.map((t) => t.symbol)).toEqual(["AAA", "BBB", "UNP", "UN2"]);
    // Priced rows keep their exact ordering and slicing.
    expect(tokens.slice(0, 2).every((t) => t.priceUnavailable === undefined)).toBe(true);
    // The marker states WHY there is no USD figure, so "no price feed" can
    // never read as "not held".
    expect(tokens[2]).toMatchObject({ symbol: "UNP", priceUnavailable: true, priceUsd: null });
    expect(tokens[3]).toMatchObject({ symbol: "UN2", priceUnavailable: true });
  });

  it("treats a provider price of '0' as PRICED - a zero quote is a feed, not a missing one", async () => {
    mockReadLocal.mockResolvedValue({
      ...localRead(),
      tokens: [
        { address: "0xa", symbol: "AAA", decimals: 18, balanceWei: ONE, priceUsd: 1 },
        { address: "0x0", symbol: "ZED", decimals: 18, balanceWei: ONE, priceUsd: 0 },
        { address: "0xu", symbol: "UNP", decimals: 18, balanceWei: ONE, priceUsd: null },
      ],
    });

    const tokens = await tokensFor({ response_format: "concise", limit: 2 });
    // ZED counts against the priced limit and carries no marker; only the
    // feed-less UNP row is retained outside it.
    expect(tokens.map((t) => t.symbol)).toEqual(["AAA", "ZED", "UNP"]);
    expect(tokens[1]!.priceUnavailable).toBeUndefined();
    expect(tokens[1]!.priceUsd).toBe("0");
    expect(tokens[2]!.priceUnavailable).toBe(true);
  });

  it("drops a zero-balance unpriced row - retention is for real holdings only", async () => {
    mockReadLocal.mockResolvedValue({
      ...localRead(),
      tokens: [
        { address: "0xa", symbol: "AAA", decimals: 18, balanceWei: ONE, priceUsd: 1 },
        { address: "0xz", symbol: "ZERO", decimals: 18, balanceWei: 0n, priceUsd: null },
      ],
    });

    const tokens = await tokensFor({ response_format: "concise", limit: 1 });
    expect(tokens.map((t) => t.symbol)).toEqual(["AAA"]);
  });

  it("leaves totals untouched - the trim is a display concern", async () => {
    const res = await handleWalletBalances(
      { walletFamily: "eip155", chainIds: "robinhood", response_format: "concise", limit: 2 },
      CONTEXT,
    );
    const data = res.data as { totalUsd: number; wallets: Array<{ tokenCount: number }> };
    // 40 + 30 + 20 + 10, unpriced rows contribute nothing, and the count is off
    // the FULL scan.
    expect(data.totalUsd).toBeCloseTo(100);
    expect(data.wallets[0]!.tokenCount).toBe(6);
  });

  // The Khalani read requests EVERY holding the provider knows with no token
  // cap of its own (`tools/khalani/balances/scan.ts`), so a wallet full of
  // unpriced dust must not be able to turn concise limit:1 into unbounded
  // output. The cap here is what bounds it, not the scan set.
  it("caps retained unpriced rows on the uncapped Khalani path and says how many were dropped", async () => {
    const dust = Array.from({ length: 25 }, (_, i) => ({
      address: `0xdust${i}`,
      chainId: 8453,
      symbol: `DUST${i}`,
      name: `Dust ${i}`,
      decimals: 18,
      extensions: { balance: ONE.toString() },
    }));
    mockScan.mockResolvedValue({
      address: "0xWALLET",
      family: "eip155" as ChainFamily,
      tokens: [
        { address: "0xusdc", chainId: 8453, symbol: "USDC", name: "USD Coin", decimals: 6, extensions: { balance: "100000000", price: { usd: "1.00" } } },
        ...dust,
      ],
      scannedChainIds: [8453],
      chainErrors: [],
      totalUsd: 100,
    });
    mockReadLocal.mockResolvedValue({ nativeWei: 0n, nativePriceUsd: null, tokens: [], tokenFailures: [] });

    const res = await handleWalletBalances({ walletFamily: "eip155", response_format: "concise", limit: 1 }, CONTEXT);
    expect(res.success).toBe(true);
    const snap = (res.data as { wallets: Array<{ tokens: Row[]; unpricedOmitted?: number; tokenCount: number }> }).wallets[0]!;

    // 1 priced row (the limit) + exactly the cap, in stable scan order.
    expect(snap.tokens).toHaveLength(1 + UNPRICED_CAP);
    expect(snap.tokens[0]!.symbol).toBe("USDC");
    expect(snap.tokens.slice(1).map((t) => t.symbol)).toEqual(
      Array.from({ length: UNPRICED_CAP }, (_, i) => `DUST${i}`),
    );
    expect(snap.tokens.slice(1).every((t) => t.priceUnavailable === true)).toBe(true);
    expect(snap.unpricedOmitted).toBe(5);
    // The full scan is still reported honestly.
    expect(snap.tokenCount).toBe(26);
  });

  it("omits the unpricedOmitted field entirely when nothing was dropped", async () => {
    const res = await handleWalletBalances(
      { walletFamily: "eip155", chainIds: "robinhood", response_format: "concise", limit: 2 },
      CONTEXT,
    );
    const snap = (res.data as { wallets: Array<Record<string, unknown>> }).wallets[0]!;
    expect("unpricedOmitted" in snap).toBe(false);
  });

  it("detailed mode (the default) returns every row untouched and in scan order", async () => {
    const detailed = await tokensFor({});
    expect(detailed.map((t) => t.symbol)).toEqual(["AAA", "UNP", "BBB", "CCC", "UN2", "DDD"]);
    // `priceUnavailable` is now a ROW-LEVEL fact (WP1 C1.5): it means "this row
    // has no usable price feed", on every format, so it is no longer a proxy
    // for "the concise trim ran". The invariants this test owns are the full
    // row set, the untouched order, and `truncated`; the marker is asserted for
    // what it now means, which is that the PRICED rows never carry it.
    expect(detailed.filter((t) => t.priceUnavailable === true).map((t) => t.symbol))
      .toEqual(["UNP", "UN2"]);

    const explicitDetailedWithLimit = await tokensFor({ response_format: "detailed", limit: 1 });
    expect(explicitDetailedWithLimit).toEqual(detailed);
  });

  it("concise WITHOUT a limit still returns every row untouched", async () => {
    const tokens = await tokensFor({ response_format: "concise" });
    expect(tokens.map((t) => t.symbol)).toEqual(["AAA", "UNP", "BBB", "CCC", "UN2", "DDD"]);
    // `priceUnavailable` is now a ROW-LEVEL fact (WP1 C1.5): it means "this row
    // has no usable price feed", on every format, so it is no longer a proxy
    // for "the concise trim ran". The invariants this test owns are the full
    // row set, the untouched order, and `truncated`; the marker is asserted for
    // what it now means, which is that the PRICED rows never carry it.
    expect(tokens.filter((t) => t.priceUnavailable === true).map((t) => t.symbol))
      .toEqual(["UNP", "UN2"]);
  });
});

/**
 * D17 (R2) and D16 (`truncated`).
 *
 * The `detailed` default on `wallet_balances` is a RATIFIED exception, and the
 * reason is the first test here: because the default also gates the trim, a
 * `concise` default would make a bare `{limit: N}` call silently start dropping
 * and re-ranking rows on a money-adjacent read. This file is where that stays
 * pinned, so a later "make the defaults uniform" change fails loudly.
 *
 * `truncated` is the honesty half: the bounded_non_pageable class has no
 * continuation, so the field says whether rows are missing and the note says
 * how to widen the read.
 */
describe("wallet_balances - the detailed default (D17 R2) and `truncated` (D16)", () => {
  async function snapshotFor(params: Record<string, unknown>): Promise<Snapshot> {
    const res = await handleWalletBalances(
      { walletFamily: "eip155", chainIds: "robinhood", ...params },
      CONTEXT,
    );
    expect(res.success).toBe(true);
    const snap = (res.data as { wallets: Snapshot[] }).wallets[0];
    if (!snap) throw new Error("wallet_balances returned no snapshot for the eip155 wallet");
    return snap;
  }

  it("`{limit: N}` with NO response_format returns every row, unranked and untruncated", async () => {
    const snap = await snapshotFor({ limit: 2 });

    // The whole point of R2: `limit` is inert under the default format. If this
    // ever returns 4 rows, the default was flipped and a wallet read started
    // hiding holdings nobody asked it to hide.
    expect(snap.tokens.map((t) => t.symbol)).toEqual(["AAA", "UNP", "BBB", "CCC", "UN2", "DDD"]);
    // `priceUnavailable` is now a ROW-LEVEL fact (WP1 C1.5): it means "this row
    // has no usable price feed", on every format, so it is no longer a proxy
    // for "the concise trim ran". The invariants this test owns are the full
    // row set, the untouched order, and `truncated`; the marker is asserted for
    // what it now means, which is that the PRICED rows never carry it.
    expect(snap.tokens.filter((t) => t.priceUnavailable === true).map((t) => t.symbol))
      .toEqual(["UNP", "UN2"]);
    expect(snap.truncated).toBe(false);
    expect(snap.truncationNote).toBeUndefined();
  });

  it("the bare default and concise-without-limit are field-for-field identical", async () => {
    const bare = await snapshotFor({});
    const conciseNoLimit = await snapshotFor({ response_format: "concise" });

    // Not just the token list: every field, so `truncated`, the omission
    // counters, the completeness axes and the totals are all proven
    // equivalent, which is what makes "only the label differs" a measured
    // claim rather than a reading of `trimTokens`.
    //
    // `inventorySources[].observedAt` is the ONE legitimately time-varying
    // field - two calls read the chain at two different moments, and stamping
    // them with one clock would be the lie C3.5 forbids - so it is normalised
    // rather than compared, and its PRESENCE is asserted separately below.
    expect(withNormalisedObservationTimes(conciseNoLimit)).toEqual(
      withNormalisedObservationTimes(bare),
    );
    for (const source of bare.inventorySources) {
      expect(typeof source.observedAt).toBe("string");
    }
  });

  it("`truncated` is present as false on the detailed path", async () => {
    const snap = await snapshotFor({ response_format: "detailed", limit: 1 });
    // Present, not absent: an absent field reads as "no answer".
    expect("truncated" in snap).toBe(true);
    expect(snap.truncated).toBe(false);
  });

  it("concise with a limit BELOW the priced count is truncated, and the note names the recovery", async () => {
    // 4 priced + 2 unpriced held = 6 projected; limit 2 keeps 2 + 2 = 4.
    const snap = await snapshotFor({ response_format: "concise", limit: 2 });

    expect(snap.tokens).toHaveLength(4);
    expect(snap.truncated).toBe(true);
    // The recovery text is part of the contract: `detailed` is the one complete
    // recovery, and `limit` is promised only what it can deliver (the priced
    // rows it cut), never the unpriced-cap or zero-balance rows.
    expect(snap.truncationNote).toContain('response_format:"detailed" (the only complete recovery)');
    expect(snap.truncationNote).toContain("Raising `limit` recovers only the priced rows it cut");
    expect(snap.truncationNote).toContain("FULL projected scan");
    // bounded_non_pageable: there is nothing to page to, and the note must not
    // suggest otherwise.
    expect(snap.truncationNote).toContain("no continuation");
  });

  it("concise with a limit AT or ABOVE the priced count is not truncated", async () => {
    const atCount = await snapshotFor({ response_format: "concise", limit: 4 });
    expect(atCount.tokens).toHaveLength(6);
    expect(atCount.truncated).toBe(false);
    expect(atCount.truncationNote).toBeUndefined();

    const above = await snapshotFor({ response_format: "concise", limit: 99 });
    expect(above.tokens).toHaveLength(6);
    expect(above.truncated).toBe(false);
  });

  it("a zero-balance unpriced row the trim drops still counts as truncation", async () => {
    // This row is dropped by design (retention is for real holdings), and
    // `unpricedOmitted` deliberately does not count it - which is exactly why
    // `truncated` is measured against the full projected set instead.
    mockReadLocal.mockResolvedValue({
      ...localRead(),
      tokens: [
        { address: "0xa", symbol: "AAA", decimals: 18, balanceWei: ONE, priceUsd: 1 },
        { address: "0xz", symbol: "ZERO", decimals: 18, balanceWei: 0n, priceUsd: null },
      ],
    });

    const snap = await snapshotFor({ response_format: "concise", limit: 1 });
    expect(snap.tokens.map((t) => t.symbol)).toEqual(["AAA"]);
    expect(snap.unpricedOmitted).toBeUndefined();
    expect(snap.truncated).toBe(true);
  });

  it("the 20-row unpriced cap sets truncated too", async () => {
    const dust = Array.from({ length: 25 }, (_, i) => ({
      address: `0xdust${i}`,
      chainId: 8453,
      symbol: `DUST${i}`,
      name: `Dust ${i}`,
      decimals: 18,
      extensions: { balance: ONE.toString() },
    }));
    mockScan.mockResolvedValue({
      address: "0xWALLET",
      family: "eip155" as ChainFamily,
      tokens: [
        { address: "0xusdc", chainId: 8453, symbol: "USDC", name: "USD Coin", decimals: 6, extensions: { balance: "100000000", price: { usd: "1.00" } } },
        ...dust,
      ],
      scannedChainIds: [8453],
      chainErrors: [],
      totalUsd: 100,
    });
    mockReadLocal.mockResolvedValue({ nativeWei: 0n, nativePriceUsd: null, tokens: [], tokenFailures: [] });

    const res = await handleWalletBalances(
      { walletFamily: "eip155", response_format: "concise", limit: 1 },
      CONTEXT,
    );
    expect(res.success).toBe(true);
    const snap = (res.data as { wallets: Snapshot[] }).wallets[0];
    if (!snap) throw new Error("wallet_balances returned no snapshot for the eip155 wallet");

    expect(snap.unpricedOmitted).toBe(5);
    // The two figures answer different questions and must not be confused:
    // `unpricedOmitted` is what the CAP dropped, `unpricedHeldCount` is how
    // many unpriced holdings the wallet actually has. Only the second is
    // reported on the detailed path, where nothing is dropped at all.
    expect(snap.unpricedHeldCount).toBe(25);
    expect(snap.truncated).toBe(true);
    // Rows past the 20-row unpriced cap cannot come back through `limit`; the
    // note must send the agent to `detailed`, not to a bigger limit.
    expect(snap.truncationNote).toContain('response_format:"detailed" (the only complete recovery)');
    expect(snap.truncationNote).toContain("never the rows the 20-row unpriced cap");
  });
});
