/**
 * Pendle chain registry — the network-free source of truth for the 11 chains
 * Pendle supports.
 *
 * Self-contained by design (NOT coupled to another venue's registry): the
 * prequote gate/recorder and the handlers resolve the chain id from the same
 * table so their identities agree, and the viem-client factory builds each
 * `Chain` (RPC + Multicall3) from it. Slugs are chosen to match the kyberswap
 * slug table AND the Khalani aliases so `resolveChainHint` / `activityChainKeys`
 * keep working unchanged.
 *
 * The Router is IDENTICAL on every chain (see `constants.ts`), so nothing here
 * pins a per-chain Router. RPCs are keyless public endpoints with Multicall3
 * deployed at the canonical address (live-verified); a user can override any
 * chain's RPC via the top-level `pendleRpcUrls` config map.
 */

import { getAddress, type Address } from "viem";

/** Multicall3 — deployed at this canonical address on ALL supported chains. */
export const PENDLE_MULTICALL3: Address = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");

export interface PendleWrappedNative {
  symbol: string;
  address: Address;
}

export interface PendleChain {
  chainId: number;
  /** Canonical slug (kyberswap + Khalani aligned). */
  slug: string;
  name: string;
  nativeSymbol: string;
  /** Lowercase aliases (in addition to the slug + stringified id). */
  aliases: readonly string[];
  /** Bundled keyless RPC (Multicall3 present). Overridable via config. */
  defaultRpcUrl: string;
  /** Multicall3 contract (identical on all chains). */
  multicall3: Address;
  /**
   * Canonical wrapped-native token, when its address is authoritatively known.
   * Used ONLY for the advisory "pass wrapped native" hint — never for calldata,
   * approvals, or valuation. Omitted where the address is not confidently known;
   * the hint then stays generic (NEVER invent token addresses).
   */
  wrappedNative?: PendleWrappedNative;
}

/**
 * The 11 Pendle chains (GET /core/v1/chains, live-verified 2026-07-06). Empty
 * chains (no active markets today) are included: the Router + RPC are verified,
 * and read/mutating paths degrade gracefully (empty lists / no-market) until
 * Pendle lists markets there.
 */
export const PENDLE_CHAIN_REGISTRY: readonly PendleChain[] = [
  {
    chainId: 1,
    slug: "ethereum",
    name: "Ethereum",
    nativeSymbol: "ETH",
    aliases: ["eth", "mainnet", "ethereum-mainnet"],
    defaultRpcUrl: "https://ethereum-rpc.publicnode.com",
    multicall3: PENDLE_MULTICALL3,
    wrappedNative: { symbol: "WETH", address: getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2") },
  },
  {
    chainId: 10,
    slug: "optimism",
    name: "Optimism",
    nativeSymbol: "ETH",
    aliases: ["op"],
    defaultRpcUrl: "https://optimism-rpc.publicnode.com",
    multicall3: PENDLE_MULTICALL3,
    // Canonical OP-Stack WETH9 predeploy.
    wrappedNative: { symbol: "WETH", address: getAddress("0x4200000000000000000000000000000000000006") },
  },
  {
    chainId: 56,
    slug: "bsc",
    name: "BNB Smart Chain",
    nativeSymbol: "BNB",
    aliases: ["bnb", "binance", "bnb-chain"],
    defaultRpcUrl: "https://bsc-rpc.publicnode.com",
    multicall3: PENDLE_MULTICALL3,
    wrappedNative: { symbol: "WBNB", address: getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c") },
  },
  {
    chainId: 143,
    slug: "monad",
    name: "Monad",
    nativeSymbol: "MON",
    aliases: [],
    defaultRpcUrl: "https://rpc.monad.xyz",
    multicall3: PENDLE_MULTICALL3,
  },
  {
    chainId: 146,
    slug: "sonic",
    name: "Sonic",
    nativeSymbol: "S",
    aliases: [],
    defaultRpcUrl: "https://sonic-rpc.publicnode.com",
    multicall3: PENDLE_MULTICALL3,
  },
  {
    chainId: 999,
    slug: "hyperevm",
    name: "HyperEVM",
    nativeSymbol: "HYPE",
    aliases: ["hyperliquid", "hyper"],
    defaultRpcUrl: "https://rpc.hyperliquid.xyz/evm",
    multicall3: PENDLE_MULTICALL3,
  },
  {
    chainId: 5000,
    slug: "mantle",
    name: "Mantle",
    nativeSymbol: "MNT",
    aliases: [],
    defaultRpcUrl: "https://mantle-rpc.publicnode.com",
    multicall3: PENDLE_MULTICALL3,
  },
  {
    chainId: 8453,
    slug: "base",
    name: "Base",
    nativeSymbol: "ETH",
    aliases: [],
    // NOT publicnode: `base-rpc.publicnode.com` refuses `eth_getTransactionReceipt`
    // at the method level (-32602 "Archive requests require a personal token")
    // even for a head-block transaction, so a write sent through it can never be
    // confirmed. Funded live probe, 2026-08-17. drpc rather than the official
    // `mainnet.base.org`, which serves receipts but rate limits at about five
    // requests; `base.drpc.org` served a receipt from its own latest block and
    // took 30 consecutive requests with no throttling. This is the LAST RESORT
    // behind the `evm-client.ts` env override, and it is what a user without an
    // override actually gets.
    defaultRpcUrl: "https://base.drpc.org",
    multicall3: PENDLE_MULTICALL3,
    // Canonical OP-Stack WETH9 predeploy.
    wrappedNative: { symbol: "WETH", address: getAddress("0x4200000000000000000000000000000000000006") },
  },
  {
    chainId: 9745,
    slug: "plasma",
    name: "Plasma",
    nativeSymbol: "XPL",
    aliases: [],
    defaultRpcUrl: "https://rpc.plasma.to",
    multicall3: PENDLE_MULTICALL3,
  },
  {
    chainId: 42161,
    slug: "arbitrum",
    name: "Arbitrum One",
    nativeSymbol: "ETH",
    aliases: ["arb", "arbitrum-one"],
    // NOT publicnode, for the same reason as Base above: on 2026-08-17
    // `arbitrum-one-rpc.publicnode.com` refused `eth_getTransactionReceipt` with
    // the same -32602 method-level refusal. Live-verified to serve a receipt.
    defaultRpcUrl: "https://arb1.arbitrum.io/rpc",
    multicall3: PENDLE_MULTICALL3,
    wrappedNative: { symbol: "WETH", address: getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1") },
  },
  {
    chainId: 80094,
    slug: "berachain",
    name: "Berachain",
    nativeSymbol: "BERA",
    aliases: ["bera"],
    defaultRpcUrl: "https://berachain-rpc.publicnode.com",
    multicall3: PENDLE_MULTICALL3,
  },
];

/** All supported Pendle chain ids. */
export const PENDLE_SUPPORTED_CHAIN_IDS: readonly number[] = PENDLE_CHAIN_REGISTRY.map((c) => c.chainId);

const BY_CHAIN_ID = new Map<number, PendleChain>(PENDLE_CHAIN_REGISTRY.map((c) => [c.chainId, c]));

/** slug / alias / stringified-id → chainId. */
const BY_ALIAS = new Map<string, number>();
for (const c of PENDLE_CHAIN_REGISTRY) {
  BY_ALIAS.set(c.slug, c.chainId);
  BY_ALIAS.set(String(c.chainId), c.chainId);
  for (const alias of c.aliases) BY_ALIAS.set(alias, c.chainId);
}

/**
 * Resolve a chain param/alias/stringified-id to a supported Pendle chain id, or
 * `undefined` when unknown. Network-free; trims + lowercases the input.
 */
export function resolvePendleChainId(input: string): number | undefined {
  const normalized = input.trim().toLowerCase();
  if (normalized === "") return undefined;
  return BY_ALIAS.get(normalized);
}

/** The full registry entry for a chain id, or `undefined` when unsupported. */
export function getPendleChain(chainId: number): PendleChain | undefined {
  return BY_CHAIN_ID.get(chainId);
}

/** Canonical slug for a supported chain id, or `undefined` when unsupported. */
export function pendleChainSlug(chainId: number): string | undefined {
  return BY_CHAIN_ID.get(chainId)?.slug;
}

/**
 * Ethereum canonical slug. Sync/enrichment is now multichain (P2 loops the
 * registry), so this is retained only because `pendle-chain-hint.test.ts` pins
 * it as the "ethereum" capture slug; new code should use `pendleChainSlug(id)`.
 */
export const PENDLE_CHAIN_SLUG = "ethereum";
