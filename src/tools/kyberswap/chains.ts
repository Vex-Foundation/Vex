/**
 * KyberSwap chain registry — slug/ID mapping, aliases, feature matrix, and caching.
 */

import type { KyberChainSlug, KyberChainId, KyberChainFeatures, KyberChainInfo } from "./types.js";
import { VexError, ErrorCodes } from "../../errors.js";

// ── Static chain registry ───────────────────────────────────────────

interface ChainEntry {
  slug: KyberChainSlug;
  chainId: KyberChainId;
  name: string;
  aggregator: boolean;
}

/**
 * Agent Scan (plan §4.2): Scroll (534352) and zkSync (324) are DROPPED here —
 * both had `aggregator: false`, so ZaaS/zap was their ONLY KyberSwap feature.
 * Deleting zap tooling left them with zero executable Vex surface.
 */
const CHAINS: readonly ChainEntry[] = [
  { slug: "ethereum",  chainId: 1,     name: "Ethereum",   aggregator: true },
  { slug: "bsc",       chainId: 56,    name: "BSC",        aggregator: true },
  { slug: "arbitrum",  chainId: 42161, name: "Arbitrum",   aggregator: true },
  { slug: "polygon",   chainId: 137,   name: "Polygon",    aggregator: true },
  { slug: "optimism",  chainId: 10,    name: "Optimism",   aggregator: true },
  { slug: "avalanche", chainId: 43114, name: "Avalanche",  aggregator: true },
  { slug: "base",      chainId: 8453,  name: "Base",       aggregator: true },
  { slug: "linea",     chainId: 59144, name: "Linea",      aggregator: true },
  { slug: "mantle",    chainId: 5000,  name: "Mantle",     aggregator: true },
  { slug: "sonic",     chainId: 146,   name: "Sonic",      aggregator: true },
  { slug: "berachain", chainId: 80094, name: "Berachain",  aggregator: true },
  { slug: "ronin",     chainId: 2020,  name: "Ronin",      aggregator: true },
  { slug: "unichain",  chainId: 130,   name: "Unichain",   aggregator: true },
  { slug: "hyperevm",  chainId: 999,   name: "HyperEVM",   aggregator: true },
  { slug: "plasma",    chainId: 9745,  name: "Plasma",     aggregator: true },
  { slug: "etherlink", chainId: 42793, name: "Etherlink",  aggregator: true },
  { slug: "monad",     chainId: 143,   name: "Monad",      aggregator: true },
  { slug: "megaeth",   chainId: 4326,  name: "MegaETH",    aggregator: true },
  // Robinhood Chain — aggregator only. Provisional per KyberSwap docs (declared
  // "initial observation period; support may be discontinued"). Aggregator
  // support verified live 2026-07-13 (GET /robinhood/api/v1/routes → code:0 with
  // real routes) and on-chain (MetaAggregationRouterV2 0x6131…37b5 has bytecode;
  // eth_chainId 0x1237 = 4663).
  { slug: "robinhood", chainId: 4663,  name: "Robinhood Chain", aggregator: true },
] as const;

// ── Alias map ───────────────────────────────────────────────────────

const ALIASES: Record<string, KyberChainSlug> = {
  eth: "ethereum",
  arb: "arbitrum",
  poly: "polygon",
  matic: "polygon",
  op: "optimism",
  avax: "avalanche",
  bera: "berachain",
};

// ── Lookup maps (built once) ────────────────────────────────────────

const slugMap = new Map<string, ChainEntry>();
const idMap = new Map<number, ChainEntry>();

for (const chain of CHAINS) {
  slugMap.set(chain.slug, chain);
  idMap.set(chain.chainId, chain);
}

// ── Public API ──────────────────────────────────────────────────────

/** Get all supported chains with feature availability. */
export function getKyberChains(): KyberChainFeatures[] {
  return CHAINS.map((c) => ({ ...c }));
}

/** Resolve a chain slug or alias to a validated KyberChainSlug. Throws on unknown. */
export function resolveChainSlug(input: string): KyberChainSlug {
  const normalized = input.toLowerCase().trim();
  const aliased = ALIASES[normalized] ?? normalized;
  const entry = slugMap.get(aliased);
  if (!entry) {
    throw new VexError(
      ErrorCodes.KYBER_UNSUPPORTED_CHAIN,
      `Unsupported KyberSwap chain: "${input}"`,
      `Supported: ${CHAINS.map((c) => c.slug).join(", ")}`,
    );
  }
  return entry.slug;
}

/** Resolve a chain ID to a KyberChainSlug. */
export function chainIdToSlug(chainId: number): KyberChainSlug | undefined {
  return idMap.get(chainId)?.slug;
}

/** Get chain ID for a slug. */
export function slugToChainId(slug: KyberChainSlug): KyberChainId {
  const entry = slugMap.get(slug);
  if (!entry) {
    throw new VexError(ErrorCodes.KYBER_UNSUPPORTED_CHAIN, `Unknown chain slug: ${slug}`);
  }
  return entry.chainId;
}

/** Get full feature info for a chain. */
export function getChainFeatures(slug: KyberChainSlug): KyberChainFeatures {
  const entry = slugMap.get(slug);
  if (!entry) {
    throw new VexError(ErrorCodes.KYBER_UNSUPPORTED_CHAIN, `Unknown chain slug: ${slug}`);
  }
  return { ...entry };
}

/**
 * Check if a chain supports a specific feature. `aggregator` is the only
 * KyberSwap feature Vex executes since limit-order + zap were deleted (plan
 * §4.2); kept feature-parameterized (not a bare boolean getter) because
 * `tools/uniswap/venue-router.ts` shares this call shape.
 */
export function chainSupportsFeature(slug: KyberChainSlug, feature: "aggregator"): boolean {
  const entry = slugMap.get(slug);
  return entry?.[feature] ?? false;
}

// ── Dynamic chain cache (populated from Common Service API) ─────────

let cachedDynamicChains: KyberChainInfo[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function setCachedDynamicChains(chains: KyberChainInfo[]): void {
  cachedDynamicChains = chains;
  cacheTimestamp = Date.now();
}

export function getCachedDynamicChains(): KyberChainInfo[] | null {
  if (!cachedDynamicChains || Date.now() - cacheTimestamp > CACHE_TTL_MS) {
    return null;
  }
  return cachedDynamicChains;
}

export function clearDynamicChainsCache(): void {
  cachedDynamicChains = null;
  cacheTimestamp = 0;
}
