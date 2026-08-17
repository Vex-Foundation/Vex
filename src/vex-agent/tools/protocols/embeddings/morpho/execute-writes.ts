/**
 * Retrieval metadata for the Morpho EXECUTE lane - actually moving the user's
 * money into or out of a vault.
 *
 * The manifests at `morpho/manifests/{vault-deposit,vault-withdraw}.ts`
 * reference these entries by `toolId`.
 *
 * THE VOCABULARY IS DISJOINT FROM ALL FIVE EXISTING MORPHO LANES, and the
 * collision this file manages is the most expensive one in the namespace: the
 * PREVIEW lane in `quote-reads.ts` prices exactly the same two operations on
 * exactly the same nouns. A deposit passage and a deposit-quote passage share
 * their vault, their asset, their amount and their shares almost word for word,
 * so retrieval cannot be separated on nouns at all. It is separated the way
 * `quote-reads.ts` separated itself from the vault lane: on the VERBS and the
 * TENSE, which is where the two intents genuinely differ.
 *
 *   PREVIEW intent - price a hypothetical before anyone commits. CONDITIONAL
 *                    tense, and it owns "would", "preview", "simulate", "dry
 *                    run", "price it", "what do I need to approve first".
 *   EXECUTE intent - do it, now, with real funds. IMPERATIVE and COMMITTING
 *                    tense, and it owns "deposit", "supply", "put my money in",
 *                    "withdraw", "pull out", "redeem", "take my money out".
 *
 * So every passage below LEADS WITH ITS ACTION VERB, and none of them uses a
 * conditional construction, the word "preview", the word "simulate", or the
 * approval QUESTION ("what do I need to approve") that belongs to the preview
 * lane. What this lane does own about approval is the approval as an ACT that
 * gets sent: the deposit passage states plainly that two transactions go out
 * one after another behind one confirmation, because that is a fact about
 * running it, not a fact about pricing it. The withdrawal passage states the
 * absence of an approval for the same reason.
 *
 * The two passages are also kept apart from each other by DIRECTION, which is
 * their only real difference; nothing about withdrawing appears in the deposit
 * passage and nothing about approving appears in the withdrawal one.
 *
 * The chain list is not spelled into the passage. It has one home in the
 * structured `chains` field, for the reason batch 1 measured.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { MORPHO_CHAINS_FOR_DISCOVERY } from "../../morpho/discovery-text.js";

export const MORPHO_EXECUTE_WRITE_DISCOVERY = {
  "morpho.vault.deposit": {
    embeddingText: embeddingText(
      `Deposit the wallet's own assets into a Morpho vault and take the vault shares, for real and on chain. ` +
      `Use when the user has already decided and tells Vex to go ahead: put this much in, supply it, buy in. ` +
      `A fresh quote of the same operation has to exist first, and the run sends TWO transactions behind a single ` +
      `confirmation: permission for exactly this amount, then the deposit. ` +
      `Returns the shares received with their own scale, the transaction hashes and a ledger row. ` +
      `A rehearsal mode walks the run and signs nothing. ` +
      `Example queries: deposit into this morpho vault, supply my usdc now, put a thousand into the vault.`,
    ),
    aliases: [
      "deposit into a morpho vault",
      "supply into a vault",
      "put my money in the vault",
      "buy vault shares",
      "go ahead with the deposit",
      "execute the vault deposit",
      "park my stablecoins in this vault now",
      "lend it into the vault",
    ],
    exampleIntents: [
      "deposit 1000 usdc into this morpho vault",
      "supply my usdc to the vault now",
      "go ahead and put the money in",
      "do the vault deposit",
      "buy into this curated vault with my wallet",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },

  "morpho.vault.withdraw": {
    embeddingText: embeddingText(
      `Withdraw assets out of a Morpho vault back to the wallet, burning the caller's shares, for real and on chain. ` +
      `Use when the user tells Vex to take the money out: withdraw it, pull my funds out, redeem my shares, exit this vault. ` +
      `A fresh quote of the same withdrawal has to exist first. ONE direct call on the vault, nothing to grant and ` +
      `nothing bundled. ` +
      `Returns the assets received and the shares burned, each with its own scale, the transaction hash and a ledger row. ` +
      `A rehearsal mode walks the run and signs nothing. ` +
      `Example queries: withdraw from this morpho vault, take my money out, redeem my vault shares.`,
    ),
    aliases: [
      "withdraw from a morpho vault",
      "take my money out of the vault",
      "pull my funds out",
      "redeem vault shares",
      "cash out of this vault",
      "exit the vault",
      "execute the vault withdrawal",
      "get my deposit back now",
    ],
    exampleIntents: [
      "withdraw 500 usdc from this morpho vault",
      "take my money out of the vault",
      "redeem my vault shares now",
      "exit this morpho vault",
      "pull everything out of the vault",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(MORPHO_EXECUTE_WRITE_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `MORPHO_EXECUTE_WRITE_DISCOVERY has ${Object.keys(MORPHO_EXECUTE_WRITE_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
