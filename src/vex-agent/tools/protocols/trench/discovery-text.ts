/**
 * Trench Express retrieval-only chain enumeration.
 *
 * Trench Express is a single-chain bonding-curve launchpad on Robinhood Chain
 * (RBC, id 4663). Used as the low-weight lexical `chains` field on each trench
 * manifest so a query like "new tokens on robinhood" recalls the namespace even
 * when the chain is not spelled out in the description or embedding passage.
 */

export const TRENCH_CHAINS: readonly string[] = ["Robinhood"];
