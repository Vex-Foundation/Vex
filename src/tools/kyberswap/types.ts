/**
 * Shared KyberSwap types — chain identifiers and common structures.
 * Domain-specific types live in their own subdirectory (aggregator/, token-api/, etc.).
 */

/** Supported chain slugs for KyberSwap Aggregator API path parameter. */
export type KyberChainSlug =
  | "ethereum" | "bsc" | "arbitrum" | "polygon" | "optimism"
  | "avalanche" | "base" | "linea" | "mantle" | "sonic"
  | "berachain" | "ronin" | "unichain" | "hyperevm" | "plasma"
  | "etherlink" | "monad" | "megaeth" | "robinhood"
  | "scroll" | "zksync";

/** Chain IDs corresponding to supported KyberSwap chains. */
export type KyberChainId =
  | 1 | 56 | 42161 | 137 | 10
  | 43114 | 8453 | 59144 | 5000 | 146
  | 80094 | 2020 | 130 | 999 | 9745
  | 42793 | 143 | 4326 | 4663
  | 534352 | 324;

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
  limitOrder: boolean;
  zaas: boolean;
}
