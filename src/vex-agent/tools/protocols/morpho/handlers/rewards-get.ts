/**
 * `morpho.rewards.get` - what one wallet can claim from Morpho's reward
 * campaigns, read through Merkl.
 *
 * WHY MERKL AND NOT MORPHO. Morpho's own Universal Rewards Distributor is
 * deprecated; its campaigns settle through Merkl, so this is where the question
 * is actually answerable. The provider client is `src/tools/merkl/`, a separate
 * module because it is a separate provider.
 *
 * WHY EVERY REWARD TOKEN IS REPORTED, NOT ONLY MORPHO'S. Merkl publishes one
 * claimable leaf per wallet per reward token and a claim takes the whole leaf.
 * The campaigns underneath it can belong to different protocols - a live Base
 * wallet on 2026-08-14 carried a WELL row entirely from a Morpho vault campaign
 * beside a USDC row from a Moonwell one. Filtering to Morpho by default would
 * describe a transaction that delivers more than the answer admitted. So every
 * row is returned, each labelled with the protocols inside it, and `morphoOnly`
 * exists for a caller that explicitly wants the narrower view.
 *
 * A CHAIN THAT FAILS DOES NOT FAIL THE ANSWER, and it does not read as empty
 * either. The fan-out is per chain, and a chain that could not be read carries
 * its own `error` so "nothing to claim" and "we could not look" stay distinct.
 */

import { getMerklClient } from "@tools/merkl/client.js";
import { attributeMerklRewards } from "@tools/merkl/rewards.js";
import { morphoChainSlug } from "@tools/morpho/chains.js";
import { ok, fail } from "../../handler-helpers.js";
import { parseMorphoRewardsParams } from "../read-params.js";
import {
  MORPHO_REWARDS_CLAIM_NOTE,
  MORPHO_REWARDS_USD_NOTE,
  projectReward,
  summariseClaimableUsd,
  type ProjectedRewardChain,
} from "../projectors.js";
import { morphoFailureDetail } from "./shared.js";

export async function morphoRewardsGet(
  params: Record<string, unknown>,
  context?: { abortSignal?: AbortSignal },
): Promise<ReturnType<typeof ok>> {
  const parsed = parseMorphoRewardsParams(params);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;

  const client = getMerklClient();
  const chains: ProjectedRewardChain[] = [];
  let droppedByMorphoOnly = 0;

  for (const chainId of q.chainIds) {
    const slug = morphoChainSlug(chainId) ?? String(chainId);
    try {
      const page = await client.getUserRewards(q.walletAddress, chainId, context?.abortSignal);
      const attributed = await attributeMerklRewards(client, page, context?.abortSignal);
      const inScope = attributed.rewards.filter((reward) => (q.morphoOnly ? reward.hasMorphoSource : true));
      // `morphoOnly` NARROWS THE TOTALS, so what it removed is counted rather
      // than left to be inferred from `filtersApplied`. A live read dropped a
      // 0.19 USD non-Morpho row, and the wallet's real claim was 1.51 USD while
      // the narrowed answer said 1.32 - one claim takes the whole token row
      // whatever produced it, so the dropped rows are still claimable money.
      droppedByMorphoOnly += attributed.rewards.length - inScope.length;
      const rewards = inScope
        .map((reward) => projectReward(reward, slug))
        // A fully claimed row is history, not an answer to "what can I claim".
        .filter((reward) => reward.claimable.raw !== "0" || reward.pending.raw !== "0");
      chains.push({ chain: slug, chainId, rewards, attribution: attributed.attribution, error: null });
    } catch (err) {
      chains.push({
        chain: slug,
        chainId,
        rewards: [],
        attribution: {
          resolvedOpportunities: 0,
          unresolvedOpportunities: 0,
          unattributableRewards: 0,
          complete: false,
          lookupCapReached: false,
        },
        error: `Merkl could not be read for ${slug} ${morphoFailureDetail(err)}`,
      });
    }
  }

  const failedChains = chains.filter((chain) => chain.error !== null);
  if (failedChains.length === q.chainIds.length && q.chainIds.length > 0) {
    return fail(
      `morpho.rewards.get failed on every chain it was asked about. ${failedChains[0]?.error ?? ""}`.trim(),
    );
  }

  const totals = summariseClaimableUsd(chains);
  const rewardCount = chains.reduce((sum, chain) => sum + chain.rewards.length, 0);
  const incomplete = chains.some((chain) => !chain.attribution.complete || chain.attribution.lookupCapReached);

  return ok({
    summary:
      rewardCount === 0
        ? `No claimable or pending Merkl rewards for this wallet on ${chains.map((c) => c.chain).join(", ")}.`
        : `${rewardCount} reward token(s) with something to claim or still accruing, ${totals.morphoAttributedTokens} `
          + `of them carrying a Morpho campaign, worth roughly ${totals.claimableUsd.toFixed(2)} USD by Merkl's own `
          + `prices${totals.unpricedTokens > 0 ? ` plus ${totals.unpricedTokens} token(s) Merkl did not price` : ""}.`,
    asOf: new Date().toISOString(),
    filtersApplied: q.echo,
    chains,
    totals,
    droppedRows: droppedByMorphoOnly,
    notes: {
      claim: MORPHO_REWARDS_CLAIM_NOTE,
      ...(droppedByMorphoOnly > 0
        ? {
          morphoOnly:
            `\`morphoOnly\` REMOVED ${droppedByMorphoOnly} reward token row(s) from this answer and from `
            + "`totals`, so the totals here are LOWER than what a claim would actually deliver. Merkl pays one leaf "
            + "per token and a claim takes the whole leaf whatever campaign produced it, so the removed rows are "
            + "still claimable money. Re-read without `morphoOnly` before telling the user what they can claim.",
        }
        : {}),
      usd: MORPHO_REWARDS_USD_NOTE,
      attribution:
        "Merkl distributes for many protocols. A reward row names a campaign, not a protocol, so Vex resolves each "
        + "campaign's opportunity to get `protocolId` and marks Morpho's share from that - never from a campaign name. "
        + (incomplete
          ? "Some campaigns could NOT be resolved on this call, so an unlabelled slice means UNKNOWN rather than "
            + "not-Morpho. Read `attribution` per chain before saying a wallet has no Morpho rewards."
          : "Every campaign on this call resolved, so the labels are complete."),
      independence:
        "Reward tokens are separate assets whose price moves independently of whatever was supplied to earn them. "
        + "An unclaimed reward is not guaranteed income: its value can fall to nothing before it is claimed, and a "
        + "campaign can end.",
    },
    nextStep:
      "Vex cannot claim yet - this namespace is read-only, and claiming is an on-chain transaction that costs gas. "
      + "To see where the rewards came from, read the vault or market with morpho.vault.get or morpho.market.get.",
  });
}
