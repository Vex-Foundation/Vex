/**
 * The chains the Watchlist page offers when adding a token (F01).
 *
 * The engine is the authority: it resolves the chain against its own closed
 * set (`resolveWatchChain`, the KyberSwap EVM chains and Solana) and refuses
 * anything else by name. This list only keeps the picker to chains that
 * resolve; a test proves each one does.
 */

export interface WatchlistChainOption {
  readonly slug: string;
  readonly name: string;
  /** What a token address on this chain looks like, for the field's hint. */
  readonly family: "evm" | "solana";
}

export const WATCHLIST_CHAINS: ReadonlyArray<WatchlistChainOption> = [
  { slug: "base", name: "Base", family: "evm" },
  { slug: "ethereum", name: "Ethereum", family: "evm" },
  { slug: "solana", name: "Solana", family: "solana" },
  { slug: "arbitrum", name: "Arbitrum", family: "evm" },
  { slug: "bsc", name: "BSC", family: "evm" },
  { slug: "polygon", name: "Polygon", family: "evm" },
  { slug: "optimism", name: "Optimism", family: "evm" },
  { slug: "avalanche", name: "Avalanche", family: "evm" },
  { slug: "robinhood", name: "Robinhood Chain", family: "evm" },
  { slug: "linea", name: "Linea", family: "evm" },
  { slug: "mantle", name: "Mantle", family: "evm" },
  { slug: "sonic", name: "Sonic", family: "evm" },
  { slug: "berachain", name: "Berachain", family: "evm" },
  { slug: "ronin", name: "Ronin", family: "evm" },
  { slug: "unichain", name: "Unichain", family: "evm" },
  { slug: "hyperevm", name: "HyperEVM", family: "evm" },
  { slug: "plasma", name: "Plasma", family: "evm" },
  { slug: "monad", name: "Monad", family: "evm" },
  { slug: "megaeth", name: "MegaETH", family: "evm" },
  { slug: "arc", name: "Arc", family: "evm" },
];
