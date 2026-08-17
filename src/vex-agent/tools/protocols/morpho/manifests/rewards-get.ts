import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_WALLET_READ_DISCOVERY } from "../../embeddings/morpho/wallet-reads.js";
import { MORPHO_REWARDS_MAX_CHAINS } from "../read-params/rewards.js";

/**
 * `morpho.rewards.get` - claimable Morpho reward campaigns, read through Merkl.
 *
 * Every concrete claim in the description comes from the 2026-08-14 live probe
 * rather than from documentation: the accrued-minus-claimed arithmetic, the
 * one-leaf-per-token claim shape, the mixed-protocol row, and the fact that
 * attribution is a second lookup that can fail honestly.
 */
export const MORPHO_REWARDS_GET_TOOL: ProtocolToolManifest = {
  toolId: "morpho.rewards.get",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "Read the reward tokens ONE wallet can claim on top of its Morpho lending rate, and what is still accruing. "
    + "Morpho's incentive campaigns settle through Merkl (Morpho's own distributor is deprecated), so that is the "
    + "source. Use this when the user asks about unclaimed rewards, incentive tokens, or what they have earned "
    + "beyond the rate; use morpho.positions.get for the lending position itself and morpho.vault.get for the "
    + "campaign's vault. ONE WALLET PER CALL, by design, because a reward read maps an account to its holdings. "
    + "THREE NUMBERS, ONLY ONE OF WHICH IS CLAIMABLE. `claimable` is the lifetime accrued amount MINUS what has "
    + "already been claimed on-chain, and it is the only figure a claim would deliver now. `pending` is accrual "
    + "the distributor has computed but NOT yet published into a claimable root: it is not claimable and can still "
    + "change. `lifetimeAccrued` and `alreadyClaimed` are shown so the arithmetic is auditable. Reporting accrued "
    + "as claimable is the standing hazard here: a live Base wallet had accrued 27,159 of a token and already "
    + "claimed 26,977 of it, so the real claim was under 1 percent of the headline. "
    + "A CLAIM TAKES A WHOLE TOKEN ROW, NOT ONE CAMPAIGN. The distributor publishes one claimable entry per wallet "
    + "per reward token, and the campaigns beneath it can belong to DIFFERENT PROTOCOLS. So every reward token is "
    + "returned by default, each labelled with the protocols inside it, rather than a Morpho-only view that would "
    + "understate what one claim delivers. Set morphoOnly true for the narrow view. "
    + "ATTRIBUTION IS RESOLVED, NEVER GUESSED. A reward row names a campaign, not a protocol, so each campaign's "
    + "opportunity is fetched to read its protocol id, and Morpho's share is marked from that alone and never from "
    + "a campaign's name. When a campaign cannot be resolved its slice is labelled UNRESOLVED and counted, and "
    + "`attribution.complete` goes false: an unlabelled slice then means unknown, not not-Morpho. Never report "
    + "that a wallet has no Morpho rewards while attribution is incomplete. "
    + "RETURNS per chain: `rewards` with the token (address, symbol, decimals, the price used) and claimable, "
    + "pending, lifetimeAccrued and alreadyClaimed each as {raw, decimals, symbol, human, usd}, plus `sources` "
    + "naming each contributing protocol, its opportunity, its campaign count and its share of the claimable "
    + "amount. Plus per-chain `attribution` and, across chains, `totals` with the claimable USD, the count of "
    + "tokens the distributor could not price, and how many rows carry a Morpho campaign. A chain that could not "
    + "be read carries its own `error`, so a failure never reads as an empty wallet. "
    + "LIMITS: USD is the distributor's own price for the reward token, not a traded price, and incentive tokens "
    + "are frequently thin, so treat every dollar figure as an estimate. A reward token is a SEPARATE asset whose "
    + "price moves independently of whatever was supplied to earn it, so an unclaimed reward is not guaranteed "
    + "income: it can lose its value before it is claimed and a campaign can end. TO ACTUALLY CLAIM, use "
    + "morpho.rewards.claim, which sweeps one chain's claimable rows in a single transaction and needs no quote. "
    + "Read-only - it signs nothing and spends nothing.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "walletAddress",
      required: true,
      type: "string",
      description:
        "The ONE account address whose rewards to read, 0x-prefixed and 40 hex. A second address is rejected by "
        + "name; call the tool once per wallet.",
    },
    {
      key: "chainIds",
      type: "string",
      acceptsStringArray: true,
      description:
        "Comma-separated chains, an array of the same, or 'all'. Slugs or numeric chain ids; discovery ships the "
        + "supported slugs on this tool's `chains` metadata and an unsupported entry is rejected with the full set. "
        + `This is a FAN-OUT and not a filter: the distributor answers one chain per request, so at most `
        + `${MORPHO_REWARDS_MAX_CHAINS} chains are read per call and a longer list is rejected by name rather than `
        + "trimmed. Omit it only when the user genuinely does not know where they earned.",
    },
    {
      key: "morphoOnly",
      type: "boolean",
      description:
        "Keep only reward rows carrying a resolved Morpho campaign (default false). Leave it false when reporting "
        + "what a claim would deliver, because one claim takes the whole token row whatever produced it. Set it "
        + "true only when the question is specifically about Morpho's own incentives.",
    },
  ],
  exampleParams: { walletAddress: "0x1a364e522a5af6187dc50b6de9e41458f413c3b5", chainIds: "base" },
  discovery: MORPHO_WALLET_READ_DISCOVERY["morpho.rewards.get"],
};
