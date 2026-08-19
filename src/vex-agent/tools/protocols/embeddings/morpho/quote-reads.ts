/**
 * Retrieval metadata for the Morpho PREVIEW lane - pricing a vault deposit or
 * withdrawal before anyone does one.
 *
 * The manifest at `morpho/manifests/vault-quote.ts` references this entry by
 * `toolId`.
 *
 * THE VOCABULARY IS DISJOINT FROM ALL THREE EXISTING MORPHO LANES, for the same
 * measured reason `vault-reads.ts` records. The collision risk here is sharper
 * than that one, because a preview shares its NOUNS with the vault lane almost
 * entirely: both talk about a vault, an asset, a share price and a deposit. The
 * separation is therefore built on the VERBS and the TENSE, which is where the
 * intents actually differ:
 *
 *   VAULT DETAIL intent - describe a thing that exists: who runs it, what it
 *                         holds, what it pays, whether it is gated. Present
 *                         tense, no amount, no wallet.
 *   PREVIEW intent      - price a specific hypothetical action: this much, this
 *                         way, what would come back, what would I have to do
 *                         first. Conditional tense, always an amount.
 *
 * So nothing below uses "who runs", "how much is in it", "what does it pay" or
 * any other vault-detail phrasing, and nothing below names a curator, a
 * timelock or an allocation. What it does own, exclusively in this namespace,
 * is the approval question: "what do I need to approve", "do I already have an
 * allowance" and their neighbours belong here rather than to the wallet lane,
 * because the wallet lane answers what a wallet HAS approved while this one
 * answers what a specific pending operation WOULD require.
 *
 * The chain list is not spelled into the passage. It has one home in the
 * structured `chains` field, for the reason batch 1 measured.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { MORPHO_CHAINS_FOR_DISCOVERY } from "../../morpho/discovery-text.js";

export const MORPHO_QUOTE_READ_DISCOVERY = {
  "morpho.vault.quote": {
    embeddingText: embeddingText(
      `Preview what putting a specific amount into a Morpho vault, or taking one out, would do, without doing it. ` +
      `Use when the user names an amount and wants the outcome before committing: how many shares it would buy, ` +
      `the price per share, what has to be approved or signed first, and the gas. ` +
      `Returns the shares minted or burned with their own scale, the share price and the ceiling the transaction ` +
      `would enforce, the steps still needed first, a gas bound and a simulation verdict. ` +
      `Nothing is signed and nothing is sent. ` +
      `Example queries: preview a vault deposit, how many shares would I get, what approvals are needed before ` +
      `depositing.`,
    ),
    aliases: [
      "preview a vault deposit",
      "quote a morpho deposit",
      "simulate a vault withdrawal",
      "how many shares would I get",
      "what approvals are needed",
      "do I need to approve first",
      "dry run a deposit",
      "price a vault withdrawal",
    ],
    exampleIntents: [
      "preview depositing 1000 usdc into this morpho vault",
      "how many shares would 500 usdc get me",
      "what do I need to approve before depositing into this vault",
      "simulate withdrawing from this morpho vault",
      "what would this vault deposit cost in gas",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 1;
if (Object.keys(MORPHO_QUOTE_READ_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `MORPHO_QUOTE_READ_DISCOVERY has ${Object.keys(MORPHO_QUOTE_READ_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
