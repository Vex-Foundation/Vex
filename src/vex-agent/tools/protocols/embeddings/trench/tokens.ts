/**
 * Retrieval metadata for `trench.tokens`.
 *
 * Source-of-truth for the lexical scorer and the dense-retrieval pipeline; the
 * manifest at `trench/manifests/tokens.ts` references it by toolId. Read-only,
 * so no mutating action verb is required. Passage is English-only and free of
 * technical jargon per the embedding-text style linter.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { TRENCH_CHAINS } from "../../trench/discovery-text.js";

export const TRENCH_TOKENS_DISCOVERY = {
  "trench.tokens": {
    embeddingText: embeddingText(
      `Browse the Trench Express launchpad on Robinhood Chain — the coins minted on its bonding curve and the ones that have graduated into a pool. ` +
      `Use this when exploring or screening launches: what just launched, which are still on the curve versus graduated, or every launch from one creator wallet. ` +
      `Each row carries name, symbol, creator, curve stage, a display-grade price, links, and an image. ` +
      `Filter by stage, creator, the rug flag, or how close a coin is to graduating, and sort by newest or price. ` +
      `Example queries: new launches on trench, trench coins still on the bonding curve, trench coins close to graduating, launches by this creator.`,
    ),
    aliases: ["trench tokens", "trench launchpad tokens", "new trench launches", "trench bonding curve tokens", "trench express tokens"],
    exampleIntents: ["new token launches on trench", "trench tokens still on the bonding curve", "trench tokens close to graduating", "latest trench launchpad tokens"],
    chains: TRENCH_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(TRENCH_TOKENS_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `TRENCH_TOKENS_DISCOVERY has ${Object.keys(TRENCH_TOKENS_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
