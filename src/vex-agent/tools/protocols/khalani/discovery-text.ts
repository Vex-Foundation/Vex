/**
 * Khalani retrieval-only chain enumeration.
 *
 * Feeds the structured `chains` field on each Khalani manifest's `discovery`
 * metadata. Not interpolated into `embeddingText` — the agent-style passages
 * name only the top 5–8 chains; the full live chain list lives here so the
 * lexical scorer can recall rarer chain names when an agent queries by chain
 * (e.g. "bridge to monad", "send tokens to katana", "bridge on 0G").
 *
 * These are the chains Khalani serves live AFTER Vex's family filter
 * (eip155 + solana — bitcoin/tron are returned live but Vex cannot sign them,
 * and Khalani's marketing table over-promises ~41). Derive from the live
 * `/v1/chains` registry, never from `CHAIN_ALIASES` or the marketing page.
 * Ground truth 2026-07-23 (18 chains); the DYNAMIC system-prompt bridge section
 * (W6 capability snapshot) is the runtime source of truth for what is currently
 * routable.
 */

export const KHALANI_CHAINS: readonly string[] = [
  "Ethereum", "Optimism", "BNB Chain", "BSC", "Unichain", "Polygon",
  "Monad", "ZKsync Era", "Abstract", "Mantle", "Base", "0G",
  "Arbitrum", "Avalanche", "Linea", "Berachain", "Katana", "Jovay",
  "Solana",
];
