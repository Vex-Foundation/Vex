/**
 * Retrieval metadata for the Virtuals creator-fee status read.
 *
 * Source-of-truth for the lexical scorer and the dense-retrieval pipeline.
 * Manifest at `virtuals/manifests/creator-fees.ts` references it by `toolId`.
 * Read-only, so no mutating action verb is required.
 *
 * The passage deliberately carries BOTH halves of the question - what has been
 * earned, and whether it can be claimed - because the queries that should land
 * here are phrased either way ("how much have my agent fees earned" and "claim
 * my virtuals creator fees" are the same tool), and the second phrasing must
 * reach the tool that can answer it with a measured no rather than falling
 * through to a generic claim tool that would sign something.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { VIRTUALS_TAX_CHAIN_SLUGS } from "@tools/virtuals/creator-fees/deployments.js";

export const VIRTUALS_CREATOR_FEES_DISCOVERY = {
  "virtuals.creator_fees": {
    embeddingText: embeddingText(
      `Check what the creator of a Virtuals agent token has earned from its bonding-curve trading tax: `
      + `how much collected, how much already swapped and paid out, how much still pending. `
      + `Use when the user asks what their agent token's trading fees have made them, whether those creator fees can be claimed or withdrawn here, `
      + `or how the fee split between the protocol treasury, any partner and the creator works. `
      + `Example queries: how much have my virtuals agent fees earned, claim the creator fees on my virtuals agent, how much agent tax is still pending for this token.`,
    ),
    aliases: [
      "virtuals creator fees",
      "agent creator revenue",
      "agent tax accrued",
      "claim virtuals creator fees",
      "creator fee split",
      "agent trading tax payout",
    ],
    exampleIntents: [
      "how much have my virtuals agent creator fees earned",
      "can I claim the creator fees on my virtuals agent",
      "how much agent tax is still pending for this token",
    ],
    chains: VIRTUALS_TAX_CHAIN_SLUGS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(VIRTUALS_CREATOR_FEES_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `VIRTUALS_CREATOR_FEES_DISCOVERY has ${Object.keys(VIRTUALS_CREATOR_FEES_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
