/**
 * Retrieval metadata for the DexScreener MARKET-CONTEXT family: narratives.
 *
 * The passage, summary, aliases and example intents below are used VERBATIM
 * from `tool-surface-spec/dexscreener-site/tool-descriptions-v1.md` section 14
 * (owner decision D-DS7: the coordinator authors all retrieval text personally
 * and builders consume it without rewording). Whitespace is re-wrapped to fit
 * this file; no word is changed. A correction belongs in that document first.
 *
 * IDENTITY CONTINUITY. `dexscreener.trending` is a RECLAIMED toolId. The
 * public-API narratives tool that held it was retired whole in S3.5 and this
 * tool answers the same user question ("which narrative is moving") off the
 * website channel, now per chain instead of globally. Both identities are
 * preserved deliberately, toolId and publicName alike, so no durable row,
 * audit record or classifier map needs a migration
 * (identity-and-migration.md section 1).
 *
 * It sits in its OWN module rather than in `./resolve.ts` because it is the
 * only tool on this surface whose rows are not pairs: it reads a different
 * channel (the Avro narratives endpoints), projects a different row type, and
 * will change for different reasons.
 *
 * The manifest at `dexscreener/manifests/market-context.ts` references this
 * entry by `toolId`.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { DEXSCREENER_CHAINS } from "../../dexscreener/discovery-text.js";

export const DEXSCREENER_MARKET_CONTEXT_DISCOVERY = {
  "dexscreener.trending": {
    canonicalSummary:
      "Narrative and meta aggregates per chain: market cap, change, volume, and token count per theme, with the IDs the screeners accept.",
    embeddingText: embeddingText(
      `Narratives and metas: themes like AI, cat and dog coins, or x402, aggregated ` +
        `per chain with total market cap, 5-minute to 24-hour change in percent and ` +
        `dollars, liquidity, volume, and token count, for any active chain (the site ` +
        `surfaces Solana, BSC, Base, and Ethereum). Each row carries the narrative ID ` +
        `the screening tools accept as a filter, so theme discovery drills into the ` +
        `theme's pairs. Use this when the user asks which narrative or sector is ` +
        `moving; individual pairs live in the screening tools. Example queries: which ` +
        `narrative is hot today, AI tokens market cap, what meta is pumping on solana, ` +
        `sector rotation in memecoins, cat coins versus dog coins.`
    ),
    aliases: [
      "narratives",
      "metas",
      "narracje",
      "jaki sektor rosnie",
      "motywy rynkowe",
    ],
    exampleIntents: [
      "ktora narracja dzisiaj rosnie",
      "jak radzi sobie meta AI na solanie",
      "which meta is moving",
    ],
    chains: DEXSCREENER_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

/**
 * Guard the count, matching the sibling embedding modules: a passage silently
 * dropped in a merge would degrade retrieval without failing any type check.
 */
const EXPECTED_COUNT = 1;
if (Object.keys(DEXSCREENER_MARKET_CONTEXT_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `DEXSCREENER_MARKET_CONTEXT_DISCOVERY has ${Object.keys(DEXSCREENER_MARKET_CONTEXT_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
