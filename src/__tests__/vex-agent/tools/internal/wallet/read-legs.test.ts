/**
 * Kairos Phase 6, W-1: `WalletBalances` legs run in parallel, each bounded by
 * a deadline, and a leg that misses it is reported by NAME as not answered.
 *
 * Live evidence: one balances call took 18.1 s. Measured on the public
 * endpoints (2026-09-30), the read ran its legs in series: the Khalani EVM
 * scan (18 chains, 0.6 to 3.4 s per chain call, 4 in flight: 13.3 s), then its
 * price pass (one chain at a time: 1.9 s), then the local-chain lane, and only
 * THEN the Solana family (17.1 s for a large wallet on the public RPC). The
 * wall time was the SUM of the legs.
 *
 * What this suite pins, over the REAL handler, the REAL Khalani scan and the
 * REAL price pass (only the provider boundaries are scripted, with delays):
 *   - legacy bounds (parallel OFF, no deadline) produce the SAME answer as the
 *     parallel read, and their wall time is the sum of the legs;
 *   - with parallel legs the wall time is about the slowest leg;
 *   - a leg that hangs is cut at its deadline and the answer is PARTIAL and
 *     says so: the chain is named, its holdings are absent (never zero rows),
 *     it is in `failedChainIds`, and `totalUsdBasis` is `priced_only`;
 *   - a price pass that hangs leaves its rows unpriced, and a price that
 *     arrives after the deadline never lands in the answer;
 *   - an operator Stop during a hung leg is still a Stop, not a partial answer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { makeTestContext } from "../../_test-context.js";
import { requireValue } from "../../../../helpers/require-value.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../../constants/solana-chain.js";
import type { SolanaWalletSnapshot } from "@tools/solana-ecosystem/balances/wallet-snapshot.js";
import type { AgentWalletReadBounds } from "@vex-agent/tools/internal/wallet/leg-bounds.js";

const EVM_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const SOLANA_ADDRESS = "So1anaWa11et111111111111111111111111111111";
const SOLANA_CHAIN_ID = SOLANA_SYNTHETIC_CHAIN_ID;
const LOCAL_CHAIN_ID = 4663;
const BASE = 8453;
const ARBITRUM = 42161;
const KHALANI_CHAIN_IDS = [BASE, ARBITRUM, 10, 137, 56, 324, 59144, 130] as const;
const UNPRICED_TOKEN = "0x00000000000000000000000000000000000000aa";

/** Delays per leg, in ms. Tests override them. */
const delays = {
  khalaniPerChain: 100,
  nativePerChain: 20,
  pricingPerRequest: 100,
  local: 150,
  solana: 300,
};
/** Chains whose Khalani call never answers (until its signal aborts). */
const hungKhalaniChains = new Set<number>();
let pricingHangs = false;
let localHangs = false;
let solanaHangs = false;
/** Resolves a hung price read LATE, ignoring its signal, with a real price. */
let pricingLateAnswerMs: number | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Never settles on its own; rejects with the signal's reason when it aborts. */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function khalaniChain(id: number) {
  return {
    type: "eip155" as const,
    id,
    name: `Chain ${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  };
}

vi.mock("@tools/khalani/chains.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/khalani/chains.js")>();
  return {
    ...original,
    getCachedKhalaniChains: async () => KHALANI_CHAIN_IDS.map((id) => khalaniChain(id)),
  };
});

/** One Khalani balance row per chain; Base and Arbitrum rows carry no price. */
function khalaniRowsFor(chainId: number) {
  const priced = chainId !== BASE && chainId !== ARBITRUM;
  return [{
    symbol: priced ? `TK${chainId}` : "NOPRICE",
    name: priced ? `Token ${chainId}` : "No price",
    address: priced ? `0x${chainId.toString(16).padStart(40, "0")}` : UNPRICED_TOKEN,
    chainId,
    decimals: 6,
    extensions: {
      balance: "2000000",
      ...(priced ? { price: { usd: "1" } } : {}),
    },
  }];
}

vi.mock("@tools/khalani/client.js", () => ({
  getKhalaniClient: () => ({
    getTokenBalances: async (
      _address: string,
      chainIds: number[] | undefined,
      options?: { signal?: AbortSignal },
    ) => {
      const chainId = requireValue(chainIds?.[0]);
      if (hungKhalaniChains.has(chainId)) return hangUntilAborted(options?.signal);
      await sleep(delays.khalaniPerChain);
      return { tokens: khalaniRowsFor(chainId), rejectedEntries: [] };
    },
  }),
}));

// Native top-up: Base holds 1 ETH, every other chain holds none. The read
// IGNORES any signal on purpose, like viem's `getBalance`.
vi.mock("@tools/khalani/evm-client.js", () => ({
  createDynamicPublicClient: (chain: { id: number }) => ({
    getBalance: async () => {
      await sleep(delays.nativePerChain);
      return chain.id === BASE ? 1_000000000000000000n : 0n;
    },
  }),
}));

const pricingCalls: string[] = [];
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: async (slug: string, _addresses: string, options?: { signal?: AbortSignal }) => {
    pricingCalls.push(slug);
    if (pricingLateAnswerMs !== null) {
      await sleep(pricingLateAnswerMs);
      return [{
        chainId: slug,
        baseToken: { address: UNPRICED_TOKEN, symbol: "NOPRICE", name: "No price" },
        quoteToken: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC" },
        priceUsd: "5",
        liquidity: { usd: 5_000_000 },
      }];
    }
    if (pricingHangs) return hangUntilAborted(options?.signal);
    await sleep(delays.pricingPerRequest);
    return [];
  },
  readTokenPools: async () => [],
}));

vi.mock("@tools/evm-chains/registry.js", () => {
  const config = {
    id: LOCAL_CHAIN_ID,
    name: "Robinhood",
    family: "eip155",
    nativeCurrency: { symbol: "ETH", name: "Ether", decimals: 18 },
    seedTokens: [],
  };
  return {
    listLocalChains: () => [config],
    getLocalChain: (id: number) => (id === LOCAL_CHAIN_ID ? config : undefined),
  };
});

vi.mock("@tools/evm-chains/resolver.js", () => ({
  resolveInclusiveEvmChain: async () => {
    throw new Error("no chain filter in this suite");
  },
}));

vi.mock("@vex-agent/sync/local-chain-balance-sync.js", () => ({
  buildLocalChainInventory: async () => buildLocalChainScanSet({
    chainId: LOCAL_CHAIN_ID,
    seedAddresses: [],
    pinnedAddresses: [],
    indexer: null,
  }),
}));

vi.mock("@tools/evm-chains/balances.js", () => ({
  readLocalChainBalances: async () => {
    if (localHangs) return new Promise<never>(() => undefined);
    await sleep(delays.local);
    return {
      nativeWei: 3_000000000000000000n,
      nativePriceUsd: 2,
      tokens: [],
      tokenFailures: [],
      priceTiers: { tier0: 0, tier1: 0, unpriced: 0 },
    };
  },
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: (_resolution: unknown, _policy: unknown, family: string) =>
    family === "solana" ? SOLANA_ADDRESS : EVM_ADDRESS,
}));

import { buildLocalChainScanSet } from "@vex-agent/wallet-inventory/local-chain.js";

const { handleWalletBalances } = await import(
  "../../../../../vex-agent/tools/internal/wallet/read.js"
);
const { WALLET_READ_LEGACY_BOUNDS } = await import(
  "../../../../../vex-agent/tools/internal/wallet/leg-bounds.js"
);

function solanaSnapshot(): SolanaWalletSnapshot {
  return {
    address: SOLANA_ADDRESS,
    rows: [{
      mint: "So11111111111111111111111111111111111111112",
      symbol: "SOL",
      name: "Solana",
      decimals: 9,
      amountRaw: "1000000000",
      priceUsd: 100,
      usdValue: 100,
      isNative: true,
    }],
    totalUsd: 100,
    accountFailures: [],
    stats: {
      accountsScanned: 1,
      zeroSkipped: 0,
      frozenAccounts: 0,
      metadataMissing: 0,
      unpriced: 0,
      priceTiers: { tier0: 1, tier1: 0, unpriced: 0 },
    },
  };
}

const dependenciesFor = (legBounds: AgentWalletReadBounds) => ({
  legBounds,
  readSolanaSnapshot: async (_address: string, options?: { signal?: AbortSignal }) => {
    if (solanaHangs) return hangUntilAborted(options?.signal);
    await sleep(delays.solana);
    return solanaSnapshot();
  },
});

const PARALLEL: AgentWalletReadBounds = { parallelLegs: true, legTimeoutMs: 0 };

interface TokenRow {
  chainId: number;
  address: string;
  symbol: string | null;
  priceUsd?: string | null;
}

interface Snapshot {
  wallet: string;
  scannedChainIds: number[];
  failedChainIds: number[];
  chainErrors: Array<{ chainId: number; message: string }>;
  totalUsdBasis: string;
  inventoryComplete: boolean;
  valuationComplete: boolean;
  totalUsd: number;
  tokens: TokenRow[];
  legsNotAnswered?: Array<{ leg: string; chainId: number; timeoutMs: number }>;
}

interface Envelope {
  totalUsd: number;
  totalUsdBasis: string;
  failedChainIds: number[];
  partial?: boolean;
  partialNote?: string;
  wallets: Snapshot[];
}

async function run(
  bounds: AgentWalletReadBounds,
  context = makeTestContext(),
): Promise<{ envelope: Envelope; ms: number }> {
  const startedAt = Date.now();
  const res = await handleWalletBalances({ walletFamily: "all" }, context, dependenciesFor(bounds));
  const ms = Date.now() - startedAt;
  expect(res.success).toBe(true);
  return { envelope: requireValue(res.data) as Envelope, ms };
}

function walletOf(envelope: Envelope, family: string): Snapshot {
  return requireValue(envelope.wallets.find((wallet) => wallet.wallet === family));
}

/** Observation times differ run to run; everything else must not. */
function withoutObservedAt(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, inner: unknown) =>
    key === "observedAt" && inner !== null ? "<time>" : inner);
}

beforeEach(() => {
  delays.khalaniPerChain = 100;
  delays.nativePerChain = 20;
  delays.pricingPerRequest = 100;
  delays.local = 150;
  delays.solana = 300;
  hungKhalaniChains.clear();
  pricingHangs = false;
  localHangs = false;
  solanaHangs = false;
  pricingLateAnswerMs = null;
  pricingCalls.length = 0;
});

describe("WalletBalances legs: OFF is today, ON is the same answer sooner", () => {
  it("legacy bounds and parallel legs return the identical answer; wall time drops to about the slowest leg", async () => {
    const legacy = await run(WALLET_READ_LEGACY_BOUNDS);
    const parallel = await run(PARALLEL);

    expect(withoutObservedAt(parallel.envelope)).toEqual(withoutObservedAt(legacy.envelope));
    // The legacy read is the SUM: Khalani 2 waves of (100 + 20) ms, Base and
    // Arbitrum priced one after the other (2 x 100 ms), local 150 ms, then
    // Solana 300 ms. About 890 ms.
    expect(legacy.ms).toBeGreaterThanOrEqual(800);
    // Parallel: Khalani 8 in flight (120 ms) then both chains priced at once
    // (100 ms), beside local (150 ms) and Solana (300 ms): the slowest leg.
    expect(parallel.ms).toBeGreaterThanOrEqual(300);
    // Relative, not absolute, so a loaded machine slowing both runs cannot
    // flip it: the legacy read sleeps about 590 ms more than the parallel one.
    // Measured unloaded: 908 ms vs 302 ms.
    expect(parallel.ms).toBeLessThan(legacy.ms - 250);
    // Nothing about the answer is partial.
    expect(parallel.envelope.partial).toBeUndefined();
    expect(parallel.envelope.failedChainIds).toEqual([]);
  });

  it("legacy bounds keep today's serial order: Solana starts only after the EVM family finished", async () => {
    const legacy = await run(WALLET_READ_LEGACY_BOUNDS);
    // Sum of the legs, not the max: Solana alone (300 ms) plus the EVM family
    // (at least 2 x 120 ms scan + 200 ms pricing + 150 ms local).
    expect(legacy.ms).toBeGreaterThanOrEqual(300 + 240 + 200 + 150);
    expect(pricingCalls.sort()).toEqual(["arbitrum", "base"]);
  });
});

describe("WalletBalances legs: a leg that misses its deadline is named, never zero", () => {
  // The healthy legs answer in 5 ms against a 1000 ms deadline, so only the
  // leg a test hangs can miss it, even on a loaded machine. The wall bound
  // (4 s) only proves the call returns: a hung leg never settles on its own.
  const bounded: AgentWalletReadBounds = { parallelLegs: true, legTimeoutMs: 1000 };

  beforeEach(() => {
    delays.khalaniPerChain = 5;
    delays.nativePerChain = 5;
    delays.pricingPerRequest = 5;
    delays.local = 5;
    delays.solana = 5;
  });

  it("a hung Solana RPC read yields a PARTIAL answer naming Solana, bounded by the deadline", async () => {
    solanaHangs = true;
    const { envelope, ms } = await run(bounded);

    expect(ms).toBeLessThan(4_000);
    const solana = walletOf(envelope, "solana");
    expect(solana.tokens).toEqual([]);
    expect(solana.scannedChainIds).toEqual([]);
    expect(solana.failedChainIds).toEqual([SOLANA_CHAIN_ID]);
    expect(solana.chainErrors).toEqual([{
      chainId: SOLANA_CHAIN_ID,
      chainName: "Solana",
      message: "Solana RPC read timed out after 1000ms; holdings on this chain are unknown (not zero)",
    }]);
    expect(solana.legsNotAnswered).toEqual([{ leg: "solana_rpc", chainId: SOLANA_CHAIN_ID, timeoutMs: 1000 }]);
    expect(solana.totalUsdBasis).toBe("priced_only");
    expect(solana.inventoryComplete).toBe(false);
    // Totals say they are partial, in fields and in words.
    expect(envelope.totalUsdBasis).toBe("priced_only");
    expect(envelope.failedChainIds).toContain(SOLANA_CHAIN_ID);
    expect(envelope.partial).toBe(true);
    expect(envelope.partialNote).toContain("UNKNOWN, not zero");
    // The EVM family that DID answer is intact.
    const evm = walletOf(envelope, "eip155");
    expect(evm.legsNotAnswered).toBeUndefined();
    expect(evm.scannedChainIds).toContain(BASE);
  });

  it("a hung Khalani chain is left unscanned and named; the other chains still answer", async () => {
    hungKhalaniChains.add(137);
    const { envelope, ms } = await run(bounded);

    expect(ms).toBeLessThan(4_000);
    const evm = walletOf(envelope, "eip155");
    expect(evm.scannedChainIds).not.toContain(137);
    expect(evm.scannedChainIds).toContain(BASE);
    expect(evm.failedChainIds).toEqual([137]);
    expect(evm.tokens.some((token) => token.chainId === 137)).toBe(false);
    expect(evm.chainErrors).toContainEqual({
      chainId: 137,
      chainName: "Chain 137",
      message: "timed out after 1000ms; holdings on this chain are unknown (not zero)",
    });
    expect(evm.legsNotAnswered).toEqual([{ leg: "khalani_scan", chainId: 137, timeoutMs: 1000 }]);
    expect(evm.totalUsdBasis).toBe("priced_only");
    expect(envelope.partial).toBe(true);
  });

  it("a hung local-chain RPC read is named and its holdings are absent, not zero", async () => {
    localHangs = true;
    const { envelope, ms } = await run(bounded);

    expect(ms).toBeLessThan(4_000);
    const evm = walletOf(envelope, "eip155");
    expect(evm.scannedChainIds).not.toContain(LOCAL_CHAIN_ID);
    expect(evm.failedChainIds).toEqual([LOCAL_CHAIN_ID]);
    expect(evm.tokens.some((token) => token.chainId === LOCAL_CHAIN_ID)).toBe(false);
    expect(evm.chainErrors).toContainEqual({
      chainId: LOCAL_CHAIN_ID,
      message: "local chain RPC read timed out after 1000ms; holdings on this chain are unknown (not zero)",
    });
    expect(evm.legsNotAnswered).toEqual([{ leg: "local_chain_rpc", chainId: LOCAL_CHAIN_ID, timeoutMs: 1000 }]);
    expect(envelope.partial).toBe(true);
  });

  it("a hung price pass leaves its rows unpriced and named; balances are all still there", async () => {
    pricingHangs = true;
    const { envelope, ms } = await run(bounded);

    expect(ms).toBeLessThan(4_000);
    const evm = walletOf(envelope, "eip155");
    expect(evm.failedChainIds).toEqual([]);
    expect(evm.scannedChainIds).toEqual(expect.arrayContaining([...KHALANI_CHAIN_IDS, LOCAL_CHAIN_ID]));
    expect(evm.legsNotAnswered).toEqual([
      { leg: "price_enrichment", chainId: BASE, timeoutMs: 1000 },
      { leg: "price_enrichment", chainId: ARBITRUM, timeoutMs: 1000 },
    ]);
    expect(evm.valuationComplete).toBe(false);
    expect(evm.totalUsdBasis).toBe("priced_only");
    const unpriced = evm.tokens.filter((token) => token.address === UNPRICED_TOKEN);
    expect(unpriced).toHaveLength(2);
    expect(envelope.partial).toBe(true);
  });

  it("a price that arrives after the deadline never lands in the answer", async () => {
    pricingLateAnswerMs = 1_500;
    const { envelope } = await run({ parallelLegs: true, legTimeoutMs: 500 });
    const evm = walletOf(envelope, "eip155");
    const before = JSON.stringify(evm.tokens);
    // Let the late answers resolve; the returned rows must not move.
    await sleep(1_600);
    expect(JSON.stringify(evm.tokens)).toBe(before);
    for (const token of evm.tokens.filter((row) => row.address === UNPRICED_TOKEN)) {
      expect(token.priceUsd ?? null).toBeNull();
    }
    expect(requireValue(evm.legsNotAnswered).map((entry) => entry.leg)).toContain("price_enrichment");
  });

  it("an operator Stop during a hung leg is a Stop, not a partial answer", async () => {
    solanaHangs = true;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const context = makeTestContext({ abortSignal: controller.signal });
    await expect(
      handleWalletBalances({ walletFamily: "all" }, context, dependenciesFor({ parallelLegs: true, legTimeoutMs: 5_000 })),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
