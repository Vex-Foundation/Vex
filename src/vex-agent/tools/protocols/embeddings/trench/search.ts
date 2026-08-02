/**
 * Retrieval metadata for `trench.search`. Read-only; English-only passage.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { TRENCH_CHAINS } from "../../trench/discovery-text.js";

export const TRENCH_SEARCH_DISCOVERY = {
  "trench.search": {
    embeddingText: embeddingText(
      `Look up a specific token on the Trench Express launchpad on Robinhood Chain by its name or symbol. ` +
      `Use this when the user names a Trench token — a ticker or a partial name — and you need to resolve it to its address and current curve state before reading its trades or previewing a launch. ` +
      `Results carry the name, symbol, creator, curve-versus-graduated stage, a display-grade price, links, and an image. ` +
      `This is a direct lookup on Trench Express, not a broad multi-venue screener. ` +
      `Example queries: find a trench token called vex, look up the trench token with symbol pepe, resolve a trench ticker by name.`,
    ),
    aliases: ["trench search", "find trench token", "search trench launchpad", "trench token by symbol", "trench token lookup"],
    exampleIntents: ["find a trench token called vex", "look up the trench token with symbol pepe", "resolve a trench ticker by name"],
    chains: TRENCH_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(TRENCH_SEARCH_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `TRENCH_SEARCH_DISCOVERY has ${Object.keys(TRENCH_SEARCH_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
