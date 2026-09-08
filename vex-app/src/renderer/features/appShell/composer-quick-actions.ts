/**
 * Starter chips shown under an empty conversation's composer - compact
 * hairline chips DETACHED below the Signal Console, text only (owner QA
 * round 2: the leading intent glyphs are gone). Pure data - each chip seeds
 * the composer draft with its full-sentence prompt; the short label is what the
 * chip renders. Hidden in mission mode and once the transcript has messages.
 */

export interface QuickAction {
  readonly label: string;
  readonly prompt: string;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    label: "Hunt trending memecoins",
    prompt:
      "Hunt the trendiest memecoins right now - combine DexScreener trending narratives with X sentiment if my X account is connected, and propose a plan before any trade.",
  },
  {
    label: "Scout Pendle yields",
    prompt:
      "Scout the highest-APY Pendle markets across chains, pick the best fit for my holdings, and walk me through a PT quote - ask me for the amount before quoting.",
  },
  {
    label: "Explore pools.fun launchpad",
    prompt:
      "Show me what's launching on the pools.fun launchpad on Robinhood Chain - which tokens are fresh, which are trading heaviest right now, and what a launch of my own would cost me there.",
  },
];
