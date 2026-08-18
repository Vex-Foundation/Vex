/**
 * Retrieval metadata for the Morpho REWARD and WALLET reads.
 *
 * Manifests at `morpho/manifests/{rewards-get,wallet-balance}.ts` reference these
 * entries by `toolId`.
 *
 * THE NAMESPACE'S VOCABULARY IS NOW SPLIT FOUR WAYS, and this file carries the
 * fourth constraint. The market, vault and portfolio lanes were already pulled
 * apart because their verbs collide; these two tools add a lane that would
 * otherwise be swallowed by the portfolio one, since "my rewards" and "my
 * balance" both sound like "my positions".
 *
 *   MARKET intent    - screening a venue to enter.
 *   VAULT intent     - handing money to a manager.
 *   PORTFOLIO intent - the lending position itself: what I lent, what I owe,
 *                      health factor, liquidation, transaction history.
 *   WALLET intent    - the two things that are NOT the position. What the
 *                      incentive programme owes me on top of the rate
 *                      (claimable, unclaimed, rewards, airdropped tokens,
 *                      what did I earn), and what the wallet holds and has
 *                      granted before it acts (token balance, approval,
 *                      allowance, spending permission).
 *
 * The separators are deliberate and each passage respects them. The rewards
 * passage never says "position", "lent", "owe" or "health"; it speaks of
 * incentives, claiming and earning on top. The balance passage never says
 * "position" or "deposit" either; it speaks of holdings, approvals and
 * permissions, in the tense of something checked BEFORE acting rather than
 * something already inside Morpho. `position-reads.ts`, `market-reads.ts` and
 * `vault-reads.ts` carry the reciprocal constraints.
 *
 * Neither passage enumerates chain slugs: that list has one home in the
 * structured `chains` field, and duplicating it into prose measurably distorted
 * an unrelated eval query during batch 1.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { MORPHO_CHAINS_FOR_DISCOVERY } from "../../morpho/discovery-text.js";

export const MORPHO_WALLET_READ_DISCOVERY = {
  "morpho.rewards.get": {
    embeddingText: embeddingText(
      `Read the incentive tokens a wallet can claim on top of its lending rate, and how much is still accruing. ` +
      `Use when the user asks what rewards they have waiting, what they earned in extra tokens, or whether ` +
      `anything is unclaimed. ` +
      `Returns each reward token with the amount claimable now, the amount still accruing, a rough dollar ` +
      `estimate, and which campaign produced it. ` +
      `Reward tokens are separate assets whose price moves on its own, and this answer is a reading rather than a ` +
      `transaction. ` +
      `Example queries: what rewards can I claim, do I have unclaimed tokens, what have I earned in incentives.`,
    ),
    aliases: [
      "claimable rewards",
      "unclaimed rewards",
      "incentive tokens",
      "merkl rewards",
      "what have I earned",
      "reward tokens waiting",
      "accrued incentives",
      "airdropped reward tokens",
    ],
    exampleIntents: [
      "what rewards can I claim",
      "do I have unclaimed rewards",
      "how much have I earned in incentives",
      "claimable reward tokens for this wallet",
      "are there rewards still accruing",
      "what incentive tokens am I owed",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },

  "morpho.wallet.balance": {
    embeddingText: embeddingText(
      `Read what a wallet holds of named token contracts on one chain, and which Morpho contracts it has already ` +
      `granted permission to move those tokens. ` +
      `Use when checking a wallet before acting, or when auditing standing permissions: has this contract been ` +
      `approved, is there an unlimited spending allowance, is there enough gas to send anything. ` +
      `Returns each token's balance with its decimals, plus the approval granted to each Morpho contract and ` +
      `whether it is the unlimited maximum. An unanswered read is reported as unknown rather than zero. ` +
      `Example queries: check my token balance and approvals, do I have an unlimited allowance, is this contract approved.`,
    ),
    aliases: [
      "token allowance",
      "spending approval",
      "unlimited approval",
      "approved contracts",
      "check balance before acting",
      "erc20 allowance",
      "standing permissions",
      "how much of this token do I hold",
    ],
    exampleIntents: [
      "check my token balance and approvals",
      "do I have an unlimited allowance granted",
      "which contracts can move my tokens",
      "how much usdc is in this wallet on base",
      "is this token already approved",
      "audit the spending permissions on this wallet",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(MORPHO_WALLET_READ_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `MORPHO_WALLET_READ_DISCOVERY has ${Object.keys(MORPHO_WALLET_READ_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
