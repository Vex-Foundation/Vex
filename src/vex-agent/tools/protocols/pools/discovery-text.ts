/**
 * pools.fun retrieval-only chain enumeration.
 *
 * pools.fun is a single-chain launchpad on Robinhood Chain (4663). Used as the
 * low-weight lexical `chains` field on each pools manifest so a query like
 * "new tokens on robinhood" recalls the namespace even when the chain is not
 * spelled out in the description or the embedding passage.
 */

export const POOLS_CHAINS: readonly string[] = ["Robinhood"];
