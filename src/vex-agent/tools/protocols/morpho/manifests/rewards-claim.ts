import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_EXECUTE_WRITE_DISCOVERY } from "../../embeddings/morpho/execute-writes.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { MORPHO_DRY_RUN_PARAM_DESCRIPTION } from "./vault-execute-shared.js";

/**
 * `morpho.rewards.claim` - sweep the wallet's claimable Merkl rewards.
 *
 * THE ONE MORPHO WRITE THAT IS NOT GATED ON A QUOTE, and the description says
 * why in the agent's own terms: there is nothing to quote. A claim has no price,
 * no slippage, no counterparty and no choice of size - it moves a fixed,
 * already-earned balance that the distributor computed. `pendle.claim` is exempt
 * from the prequote gate for exactly this reason and this tool mirrors it.
 *
 * Every concrete number and behaviour below was measured, not assumed: the live
 * Merkl probe of 2026-08-17 and a Base fork run at block 50,099,851 that claimed
 * three tokens in one transaction through this exact path.
 */
export const MORPHO_REWARDS_CLAIM_TOOL: ProtocolToolManifest = {
  toolId: "morpho.rewards.claim",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "CLAIM the reward tokens the wallet has already earned on Morpho, sweeping them from Merkl's distributor into "
    + "the wallet. This SPENDS real funds in the sense that it signs and broadcasts an on-chain transaction and "
    + "costs gas; it cannot be undone. Use it when the user asks to claim, collect, harvest or sweep their rewards. "
    + "Read morpho.rewards.get first to see what is claimable and on which chain. "
    + "NO QUOTE IS NEEDED AND NONE EXISTS. Unlike every other Morpho write, this tool is not gated on a fresh quote: "
    + "a claim has no price, no slippage, no counterparty and no size to choose. It moves an already-earned balance "
    + "the distributor has fixed, so there is nothing a quote could tell the user that the rewards read does not. "
    + "THE REWARDS ARE OTHER PROJECTS' TOKENS, NOT MORPHO'S RATE. They come from incentive campaigns a Morpho "
    + "position qualified for, they are separate assets whose price moves independently of whatever was supplied to "
    + "earn them, and one claim can deliver several different tokens at DIFFERENT DECIMALS in a single transaction. "
    + "Never add their amounts together and never present one token's figure as the total. "
    + "A CLAIM TAKES WHOLE TOKEN ROWS. The distributor publishes one claimable entry per wallet per reward token, "
    + "and the campaigns inside one entry can belong to different protocols. morphoOnly therefore narrows WHICH "
    + "TOKEN ROWS are claimed, and cannot make a claimed row deliver only its Morpho share: a narrowed claim still "
    + "pays out every campaign inside the rows it selects. Leave it false unless the user specifically wants only "
    + "the tokens carrying a Morpho campaign, and expect a narrowed claim to leave real money unclaimed. "
    + "SAFETY. The transaction is built by Vex and decoded back before signing: the target must be Merkl's pinned "
    + "distributor for that chain, the value must be zero, and every entry must claim FOR THIS WALLET with the exact "
    + "token, amount and proof Merkl published. A chain Vex has not verified the distributor on is refused by name "
    + "rather than assumed. No token approval is involved at any point, because the distributor pays from its own "
    + "balance. A wrong or expired proof makes the transaction REVERT, which costs gas but loses no rewards - they "
    + "stay claimable under the next distribution root. "
    + "RETURNS on success the transaction hash and the PROVEN per-token credits decoded from the receipt, each with "
    + "its own symbol, decimals, raw and human amount, plus what was deliberately left unclaimed and why. When "
    + "nothing is claimable it returns that plainly and signs nothing. On any non-success it returns the real cause "
    + "and what to do about it, never a generic error; if a broadcast's fate cannot be proven it says so and "
    + "explicitly refuses a retry.",
  mutating: true,
  actionKind: "user_wallet_broadcast",
  params: [
    {
      key: "chain",
      type: "string",
      required: true,
      description:
        `The chain whose rewards to claim. ${CANONICAL_CHAIN_SENTENCE} Required and singular: a claim is one `
        + "transaction on one chain, and rewards on another chain need their own call. There is no wallet "
        + "parameter - the claim is always for the session's own wallet, which is also the only wallet the "
        + "distributor would pay.",
    },
    {
      key: "morphoOnly",
      type: "boolean",
      description:
        "Claim only the reward token rows carrying a resolved Morpho campaign (default false). This narrows ROWS, "
        + "not the amounts inside them: a selected row still delivers every campaign it contains. Leaving it false "
        + "claims everything the wallet can claim on that chain in one transaction, which is almost always what the "
        + "user wants and always the cheaper way to get it.",
    },
    {
      key: "dryRun",
      type: "boolean",
      description: MORPHO_DRY_RUN_PARAM_DESCRIPTION,
    },
  ],
  exampleParams: { chain: "base" },
  discovery: MORPHO_EXECUTE_WRITE_DISCOVERY["morpho.rewards.claim"],
};
