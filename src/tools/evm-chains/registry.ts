/**
 * Local EVM chain registry — chains Vex operates on directly, WITHOUT Khalani.
 *
 * Khalani exposes a large dynamic multi-chain registry (see
 * `tools/khalani/chains.ts`). Some chains are not covered by Khalani but Vex
 * still needs to read balances, resolve wallet clients, and (later) route
 * swaps/bridges on them. Those chains live here as a small, static,
 * chain-extensible registry.
 *
 * Capability boundary (LOCKED — Wave 2 correction #2): entries in THIS registry
 * are NOT Khalani-supported. Khalani quote/bridge code paths keep using the
 * strict Khalani resolver (`resolveChainId` in `tools/khalani/chains.ts`) so a
 * local chain id can never masquerade as Khalani-supported. Only the inclusive
 * resolver (`./resolver.ts`) and direct-RPC consumers (balances, wallet send,
 * portfolio mapping) see these chains.
 *
 * Every hardcoded address carries a provenance comment. All addresses below
 * were on-chain re-verified against https://rpc.mainnet.chain.robinhood.com on
 * 2026-07-05 (eth_chainId → 0x1237 = 4663; ERC-20 symbol()/decimals() read via
 * the canonical Multicall3).
 */

import { defineChain, type Chain } from "viem";
import { loadConfig } from "../../config/store.js";

/** Only EVM (eip155) chains live here today. Kept explicit for future families. */
export type LocalChainFamily = "eip155";

/**
 * A token Vex always checks a balance for on a local chain (the "seed set").
 * decimals/symbol are intentionally omitted — they are read on-chain at scan
 * time (see `sync/local-chain-balance-sync.ts`) so this table never drifts from
 * the token contracts.
 */
export interface LocalSeedToken {
  address: `0x${string}`;
  /** Human label for provenance/debugging only; the on-chain symbol is authoritative. */
  label: string;
}

export interface LocalChainConfig {
  id: number;
  name: string;
  family: LocalChainFamily;
  /** Lowercase alias tokens accepted by the inclusive resolver (never fed to Khalani). */
  aliases: readonly string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** Bundled default public RPC. A user override may replace it (see `getLocalChainRpcUrl`). */
  defaultRpcUrl: string;
  explorerUrl: string;
  /** Canonical Multicall3 (same deterministic-deploy address on every EVM chain). */
  multicall3: `0x${string}`;
  /** DexScreener chain slug used for price lookups (tokens/v1). */
  dexscreenerSlug: string;
  /**
   * Lowercased `_tradeCapture.chain` values that map to this chain, used by the
   * tracked-token derivation to find spot trades recorded on this chain. Kept
   * explicit so the 2c swap/bridge tools have one place to align their slug.
   */
  activityChainKeys: readonly string[];
  seedTokens: readonly LocalSeedToken[];
}

// ── Robinhood Chain (4663) ──────────────────────────────────────────
//
// Arbitrum Orbit L2 settling to Ethereum. Native gas token is ETH (18 decimals).
// Endpoint + explorer live-probed 2026-07-05; chain id confirmed 0x1237 (4663).
const ROBINHOOD_CHAIN: LocalChainConfig = {
  id: 4663,
  name: "Robinhood Chain",
  family: "eip155",
  aliases: ["robinhood", "robinhoodchain", "rhc"],
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  defaultRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  // Canonical Multicall3 (Deterministic Deployment Proxy address, present on
  // 4663 — verified 2026-07-05 via balanceOf/decimals/symbol batch). NOT the
  // Robinhood docs' "L2 Multicall" 0x2cAC2D89... which is a Multicall2.
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  dexscreenerSlug: "robinhood",
  activityChainKeys: ["robinhood", "robinhood chain", "robinhoodchain", "rhc", "4663"],
  seedTokens: [
    // On-chain symbol/decimals verified 2026-07-05.
    { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", label: "WETH" }, // WETH, 18 decimals
    { address: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", label: "VEX" }, // $VEX (Vex's own token), 18 decimals
    { address: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", label: "VIRTUAL" }, // VIRTUAL, 18 decimals
    { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", label: "USDG" }, // USDG, 6 decimals
  ],
};

const LOCAL_CHAINS: readonly LocalChainConfig[] = [ROBINHOOD_CHAIN];

/** chainId → config, built once. */
const BY_ID: ReadonlyMap<number, LocalChainConfig> = new Map(
  LOCAL_CHAINS.map((chain) => [chain.id, chain]),
);

/**
 * Alias/name → chainId. Lives HERE, never in Khalani's `CHAIN_ALIASES`, so a
 * local alias like "robinhood" can never leak into Khalani-only quote/bridge
 * resolution (LOCKED correction #2).
 */
export const LOCAL_CHAIN_ALIASES: Readonly<Record<string, number>> = (() => {
  const map: Record<string, number> = {};
  for (const chain of LOCAL_CHAINS) {
    for (const alias of chain.aliases) map[alias] = chain.id;
    map[chain.name.toLowerCase()] = chain.id;
    map[chain.name.toLowerCase().replace(/[^a-z0-9]+/g, "")] = chain.id;
  }
  return map;
})();

export function listLocalChains(family?: LocalChainFamily): readonly LocalChainConfig[] {
  if (!family) return LOCAL_CHAINS;
  return LOCAL_CHAINS.filter((chain) => chain.family === family);
}

export function getLocalChain(chainId: number): LocalChainConfig | undefined {
  return BY_ID.get(chainId);
}

/** Resolve an alias, chain name, or numeric id string to a LOCAL chain id. */
export function resolveLocalChainId(input: string): number | undefined {
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  if (normalized in LOCAL_CHAIN_ALIASES) return LOCAL_CHAIN_ALIASES[normalized];
  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric > 0 && BY_ID.has(numeric)) return numeric;
  return undefined;
}

/**
 * Resolve the RPC URL for a local chain: an optional user override from config
 * wins, otherwise the bundled default. The override is user-supplied and
 * validated as a plain http(s) URL — never a bundled key, never trusted blindly.
 */
export function getLocalChainRpcUrl(config: LocalChainConfig): string {
  return getConfiguredLocalChainRpcUrl(config) ?? config.defaultRpcUrl;
}

/** Explicit operator/user override, or null when only the public fallback exists. */
export function getConfiguredLocalChainRpcUrl(
  config: LocalChainConfig,
): string | null {
  const override = loadConfig().localChainRpcUrls?.[String(config.id)];
  if (typeof override === "string") {
    const trimmed = override.trim();
    if (/^https?:\/\/\S+$/i.test(trimmed)) return trimmed;
  }
  return null;
}

/**
 * Build a viem {@link Chain} for a local chain, wiring `contracts.multicall3`
 * so `publicClient.multicall(...)` batches through the canonical Multicall3.
 */
export function toLocalViemChain(config: LocalChainConfig): Chain {
  const rpcUrl = getLocalChainRpcUrl(config);
  return defineChain({
    id: config.id,
    name: config.name,
    nativeCurrency: config.nativeCurrency,
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "Blockscout", url: config.explorerUrl } },
    contracts: { multicall3: { address: config.multicall3 } },
  });
}
