/**
 * Shared KyberSwap types — chain identifiers and common structures.
 * Domain-specific types live in their own subdirectory (aggregator/, token-api/, etc.).
 */

/**
 * Supported chain slugs for KyberSwap Aggregator API path parameter.
 *
 * Agent Scan (plan §4.2): Scroll (534352) and zkSync (324) were
 * `aggregator: false` — ZaaS/zap was their ONLY KyberSwap feature. Deleting
 * zap tooling left them with zero executable Vex surface, so they are
 * dropped from the registry entirely rather than kept as dead entries.
 */
export type KyberChainSlug =
  | "ethereum" | "bsc" | "arbitrum" | "polygon" | "optimism"
  | "avalanche" | "base" | "linea" | "mantle" | "sonic"
  | "berachain" | "ronin" | "unichain" | "hyperevm" | "plasma"
  | "etherlink" | "monad" | "megaeth" | "robinhood";

/** Chain IDs corresponding to supported KyberSwap chains. */
export type KyberChainId =
  | 1 | 56 | 42161 | 137 | 10
  | 43114 | 8453 | 59144 | 5000 | 146
  | 80094 | 2020 | 130 | 999 | 9745
  | 42793 | 143 | 4326 | 4663;

/** Chain info returned by the Common Service supported-chains endpoint. */
export interface KyberChainInfo {
  chainId: number;
  chainName: string;
  displayName: string;
  state: "active" | "inactive" | "new";
}

/** Feature availability per chain. */
export interface KyberChainFeatures {
  slug: KyberChainSlug;
  chainId: KyberChainId;
  name: string;
  aggregator: boolean;
}
