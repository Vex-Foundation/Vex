/**
 * `virtuals.creator_fees` - what a Virtuals agent's creator has accrued from the
 * bonding-curve trading tax, where it is sitting right now, and the measured
 * reason Vex cannot collect it.
 *
 * READ-ONLY, AND THE REFUSAL IS THE POINT. AgentTaxV2 converts collected tax
 * into a creator payout only inside `_swapAndDistribute`, reachable only through
 * `swapForTokenAddress` / `batchSwapForTokenAddress`, both
 * `onlyRole(SWAP_ROLE)` (`contracts/tax/AgentTaxV2.sol:211,227,300`). Virtuals'
 * own backend holds that role and runs the swap; the creator does not. This
 * handler READS `hasRole(SWAP_ROLE, creator)` at the same block as the amounts,
 * so `claim.supported: false` ships with a measurement rather than an assertion,
 * and it names where the creator does collect (the Virtuals app, which drives
 * the same backend).
 *
 * A REFUSAL IS NEVER A ZERO AND NEVER AN ERROR. Three states an agent must not
 * confuse, and this handler keeps them apart by name:
 *
 *   - the chain has no AgentTaxV2 at all (solana, ethereum) -> `supported: false`
 *     with that reason, no amounts;
 *   - the token has no tax recipient registered -> `registered: false`, the
 *     amounts still reported, and the note that the contract itself would revert
 *     "Token not registered" on a swap;
 *   - the chain would not answer -> a failure with its reason, and explicitly
 *     NOT a statement that the creator has earned nothing.
 *
 * TWO ASSETS, TWO SCALES, NEVER MIXED. Collected/swapped/pending are VIRTUAL at
 * 18 decimals; the creator is paid USDC (6) on Base and USDG (6) on Robinhood.
 * Every amount in the reply carries its asset address, its symbol, its decimals,
 * its raw integer and its human string.
 *
 * THE PROVIDER'S OWN REVENUE NUMBER RIDES ALONG, LABELLED. `api2.virtuals.io`'s
 * revenue-connect summary answered all zeros for every agent probed on
 * 2026-09-04, including three of the largest on Base, while those same agents
 * had thousands of VIRTUAL of accrued tax on chain. It is reported as the
 * provider's claim about a DIFFERENT revenue stream, with that measurement
 * attached, so nobody reads its zero as an answer to this question.
 */

import { getAddress, isAddress, type Address } from "viem";

import { getVirtualsClient } from "@tools/virtuals/client.js";
import {
  AGENT_TAX_DENOM,
  VIRTUALS_TAX_CHAIN_SLUGS,
  virtualsTaxDeployment,
} from "@tools/virtuals/creator-fees/deployments.js";
import { getVirtualsTaxPublicClient } from "@tools/virtuals/creator-fees/evm-client.js";
import {
  ratePercent,
  readVirtualsCreatorFeeStatus,
  taxAmount,
} from "@tools/virtuals/creator-fees/read-tax-status.js";
import { readVirtualsRevenueConnectSummary } from "@tools/virtuals/creator-fees/revenue-connect.js";
import type { VirtualsAgent } from "@tools/virtuals/types.js";
import { VexError } from "../../../../../errors.js";
import logger from "@utils/logger.js";
import { describeFailureForAgent, describeFailureForLog } from "../../runtime/errors.js";
import { ok, fail, num, str } from "../../handler-helpers.js";
import type { ProtocolHandler } from "../../types.js";
import { virtualsChainSlug } from "../chain-param.js";
import { readChain } from "../list-params.js";

const TOOL_ID = "virtuals.creator_fees";
const PUBLIC_NAME = "virtuals__creator_fees_get";

/**
 * The venue sentence. It names WHERE the creator collects rather than leaving a
 * refusal with no next step - the backend that holds SWAP_ROLE is driven from
 * Virtuals' own app, and that is the only place this payout is triggered.
 */
const CLAIM_VENUE = "the Virtuals app at https://app.virtuals.io (the creator dashboard for the agent)";

/** How the agent token this reply is about was established. */
type TokenSource = "tokenAddress param" | "agent id lookup";

interface ResolvedToken {
  readonly token: Address;
  readonly source: TokenSource;
  readonly agent: VirtualsAgent | null;
  /** Why the provider row is absent, when it is. Never silently omitted. */
  readonly agentLookupNote: string | null;
}

/**
 * Establish which token AgentTaxV2 keys its accounting by.
 *
 * The tax contract is keyed by the BONDING token - `preToken` while the agent is
 * on the curve (where `tokenAddress` is still null) and the same address after
 * graduation - so an agent id resolves through the provider row and an explicit
 * address is taken as given.
 */
async function resolveToken(
  params: Record<string, unknown>,
  chainSlug: string,
  providerChain: Parameters<typeof virtualsChainSlug>[0],
): Promise<{ ok: true; value: ResolvedToken } | { ok: false; reason: string }> {
  const rawAddress = str(params, "tokenAddress").trim();
  const id = num(params, "id");

  if (rawAddress.length > 0 && id !== undefined) {
    return {
      ok: false,
      reason:
        `${PUBLIC_NAME} takes EITHER tokenAddress OR id, not both - two identities can name two `
        + "different agents and there is no rule for which one wins. Drop one and call again.",
    };
  }

  if (rawAddress.length > 0) {
    if (!isAddress(rawAddress)) {
      return { ok: false, reason: `"${rawAddress}" is not an EVM contract address.` };
    }
    const token = getAddress(rawAddress);
    // The provider row is a CROSS-CHECK, never a requirement: the chain answers
    // this question on its own, so a provider outage must not block the read.
    try {
      const result = await getVirtualsClient().listVirtuals({
        chain: providerChain,
        filters: { tokenAddress: token },
        pageSize: 2,
        skipStats: true,
      });
      if (result.agents.length === 1) {
        return { ok: true, value: { token, source: "tokenAddress param", agent: result.agents[0]!, agentLookupNote: null } };
      }
      const note = result.agents.length === 0
        ? `No Virtuals agent on ${chainSlug} carries this token address, so the provider's own creator `
          + "wallet could not be cross-checked against the contract's."
        : `${result.agents.length} Virtuals agents on ${chainSlug} carry this token address, so no single `
          + "provider row could be used as a cross-check.";
      return { ok: true, value: { token, source: "tokenAddress param", agent: null, agentLookupNote: note } };
    } catch {
      return {
        ok: true,
        value: {
          token,
          source: "tokenAddress param",
          agent: null,
          agentLookupNote:
            "The Virtuals API did not answer, so the provider's own creator wallet could not be "
            + "cross-checked against the contract's. Every on-chain number below is unaffected.",
        },
      };
    }
  }

  if (id === undefined) {
    return {
      ok: false,
      reason:
        `${PUBLIC_NAME} needs the agent it is about: either tokenAddress (the agent token's contract `
        + "address) or id (the numeric Virtuals agent id virtuals__agents_discover returns).",
    };
  }

  const agent = await getVirtualsClient().getVirtual({ id });
  if (!agent) return { ok: false, reason: `No Virtuals agent found for id ${id}.` };
  const agentChain = (agent.chain ?? "").toUpperCase();
  if (agentChain !== providerChain) {
    return {
      ok: false,
      reason:
        `Virtuals agent ${id} lives on ${agent.chain ?? "an unstated chain"}, not on ${chainSlug}. `
        + "Creator fees are held by a per-chain contract, so the chain and the agent must agree.",
    };
  }
  const token = agent.preToken ?? agent.tokenAddress;
  if (token === null || !isAddress(token)) {
    return {
      ok: false,
      reason:
        `Virtuals agent ${id} has neither a preToken nor a tokenAddress, so it has no token for the `
        + "tax contract to account against yet.",
    };
  }
  return { ok: true, value: { token: getAddress(token), source: "agent id lookup", agent, agentLookupNote: null } };
}

export const virtualsCreatorFeesHandler: ProtocolHandler = async (params) => {
  const chainRead = readChain(params);
  if (!chainRead.ok) return fail(chainRead.reason);
  const providerChain = chainRead.value;
  const chainSlug = virtualsChainSlug(providerChain);

  const deployment = virtualsTaxDeployment(chainSlug);
  if (!deployment) {
    // A MEASURED unsupported cell, not an empty answer: the launchpad V5 suite
    // that owns AgentTaxV2 is deployed on Base and Robinhood only.
    return ok({
      chain: chainSlug,
      supported: false,
      reason:
        `Virtuals holds creator trading fees in AgentTaxV2, an EVM contract deployed only on `
        + `${VIRTUALS_TAX_CHAIN_SLUGS.join(" and ")}. There is no such contract on ${chainSlug}, so there `
        + "is no creator-fee accounting to read there - this is not a statement that the creator has "
        + "earned nothing.",
      supportedChains: VIRTUALS_TAX_CHAIN_SLUGS,
    });
  }

  try {
    const resolved = await resolveToken(params, chainSlug, providerChain);
    if (!resolved.ok) return fail(resolved.reason);
    const { token, source, agent, agentLookupNote } = resolved.value;

    const client = getVirtualsTaxPublicClient(deployment);
    const read = await readVirtualsCreatorFeeStatus(client, deployment, token);
    if (!read.ok) {
      return fail(
        `${PUBLIC_NAME} could not read this agent's creator-fee accounting: ${read.reason}. This is NOT a `
        + "statement that the creator has earned nothing - nothing was measured.",
      );
    }
    const status = read.status;

    // The provider's claim about who the creator is, checked against the
    // contract's own answer. A disagreement is REPORTED, never resolved here:
    // the contract is what pays, and the API row is what a human reads.
    const apiCreatorWallet = agent?.walletAddress ?? null;
    const creatorMatchesProvider =
      status.creator !== null && apiCreatorWallet !== null && isAddress(apiCreatorWallet)
        ? getAddress(apiCreatorWallet) === status.creator
        : null;

    const revenue = agent?.id !== undefined && agent?.id !== null
      ? await readVirtualsRevenueConnectSummary(Number(agent.id))
      : ({ measured: false, reason: "no numeric agent id was resolved, and this endpoint is keyed by agent id" } as const);

    const notes: string[] = [];
    if (agentLookupNote !== null) notes.push(agentLookupNote);
    if (!status.registered) {
      notes.push(
        "This token has NO tax recipient registered with AgentTaxV2 (`getTokenRecipient` answers the zero "
        + "address). The contract accepts tax deposits for an unregistered token but refuses to distribute "
        + "them - `swapForTokenAddress` reverts \"Token not registered\" - so any pending amount below is "
        + "held and cannot be paid to anyone until Virtuals registers a creator.",
      );
    }
    if (!status.pendingReachesSwapThreshold && status.pendingRaw > 0n) {
      notes.push(
        `Pending is below the contract's own minSwapThreshold (${taxAmount(status.taxAsset, status.minSwapThresholdRaw).human} `
        + `${status.taxAsset.symbol}), so the next backend swap returns without moving it. It is accrued, not lost.`,
      );
    }
    if (status.pendingRaw > status.maxSwapThresholdRaw) {
      notes.push(
        `Pending exceeds maxSwapThreshold, so one backend swap would move at most `
        + `${taxAmount(status.taxAsset, status.maxSwapThresholdRaw).human} ${status.taxAsset.symbol} and the rest stays pending.`,
      );
    }
    if (!status.vaultCoversNextSwap && status.nextSwapAmountRaw > 0n) {
      notes.push(
        "The tax contract's own balance of the tax asset is smaller than the amount the next swap would "
        + "move, and the contract returns early in that case. The accounting number and the contract's "
        + "balance are different facts and this reply reports both.",
      );
    }
    if (status.partner !== null && status.partner.recipient === null) {
      notes.push(
        "A partner fee is configured for this token but the contract has no recipient set for that partner "
        + "id, and the distribution REVERTS in that state (\"Partner recipient not set\"). Nothing can be "
        + "paid out until Virtuals sets it.",
      );
    }
    if (!status.taxVaultMatchesPin || !status.implementationMatchesPin || !status.taxAsset.matchesPin || !status.payoutAsset.matchesPin) {
      notes.push(
        "At least one contract or asset identity differs from what this tool was measured against on "
        + "2026-09-04 (see the `pins` block). The numbers above are what the live contract says; treat the "
        + "difference as a change at the provider, not as a reading error.",
      );
    }
    if (creatorMatchesProvider === false) {
      notes.push(
        "The creator wallet the Virtuals API shows for this agent is NOT the address AgentTaxV2 pays. The "
        + "contract's address is the one that receives money; the API row is a display field.",
      );
    }

    return ok({
      chain: chainSlug,
      chainId: deployment.chainId,
      supported: true,
      blockNumber: status.blockNumber.toString(),
      agentToken: token,
      agentTokenSource: source,
      ...(agent
        ? {
            agentId: agent.id,
            symbol: agent.symbol,
            name: agent.name,
            agentStatus: agent.status,
          }
        : {}),

      contract: {
        name: "AgentTaxV2",
        address: status.agentTaxV2,
        source: "FFactoryV2.taxVault(), read live at this block",
        implementation: status.implementation,
        implementationNote:
          status.implementation === null
            ? "The proxy's implementation slot was not served by this node, so it was NOT MEASURED."
            : status.implementationMatchesPin
              ? "Matches the implementation this tool was measured against."
              : "DIFFERS from the implementation this tool was measured against.",
      },

      // The two assets, spelled out, because one answer carries both scales.
      assets: {
        taxAsset: {
          address: status.taxAsset.address,
          symbol: status.taxAsset.symbol,
          decimals: status.taxAsset.decimals,
          role: "what the curve collects as tax and what accrued/pending are denominated in",
        },
        payoutAsset: {
          address: status.payoutAsset.address,
          symbol: status.payoutAsset.symbol,
          decimals: status.payoutAsset.decimals,
          role: "what the creator is actually paid, after the backend swaps the tax",
        },
      },

      creator: {
        registered: status.registered,
        address: status.creator,
        tokenBoundAccount: status.tokenBoundAccount,
        source: "AgentTaxV2.getTokenRecipient(agentToken)",
        providerWalletAddress: apiCreatorWallet,
        matchesProviderWalletAddress: creatorMatchesProvider,
      },

      accrued: {
        collected: taxAmount(status.taxAsset, status.collectedRaw),
        swapped: taxAmount(status.taxAsset, status.swappedRaw),
        pending: taxAmount(status.taxAsset, status.pendingRaw),
        pendingIsDerived: "collected - swapped; the contract stores no third number",
        minSwapThreshold: taxAmount(status.taxAsset, status.minSwapThresholdRaw),
        maxSwapThreshold: taxAmount(status.taxAsset, status.maxSwapThresholdRaw),
        pendingReachesSwapThreshold: status.pendingReachesSwapThreshold,
        nextSwapWouldMove: taxAmount(status.taxAsset, status.nextSwapAmountRaw),
        contractTaxAssetBalance: taxAmount(status.taxAsset, status.vaultTaxAssetBalanceRaw),
        contractBalanceCoversNextSwap: status.vaultCoversNextSwap,
        contractBalanceNote:
          "The contract's balance is shared across every token it holds tax for; it is not this agent's "
          + "share and must never be read as one.",
      },

      split: {
        appliesTo: `the ${status.payoutAsset.symbol} output of the backend's swap, not to the ${status.taxAsset.symbol} above`,
        denominator: AGENT_TAX_DENOM,
        protocolFeeRate: status.protocolFeeRate,
        protocolFeePercent: ratePercent(status.protocolFeeRate),
        treasury: status.treasury,
        partner: status.partner === null
          ? null
          : {
              partnerId: status.partner.partnerId,
              feeRate: status.partner.feeRate,
              feePercent: ratePercent(status.partner.feeRate),
              recipient: status.partner.recipient,
            },
        creatorShareRate: status.creatorShareRate,
        creatorSharePercent: ratePercent(status.creatorShareRate),
        note:
          "Rates are parts in 10000 (AgentTaxV2's own DENOM), so 3000 is 30 percent. The creator takes what "
          + "is left after the protocol fee and any partner fee, exactly as `_swapAndDistribute` computes it.",
      },

      // The whole reason this tool is a status read and not a claim.
      claim: {
        supported: false,
        reason:
          "AgentTaxV2 pays a creator only inside `_swapAndDistribute`, which is reachable only through "
          + "`swapForTokenAddress` and `batchSwapForTokenAddress`, and both are `onlyRole(SWAP_ROLE)`. "
          + "Virtuals' own backend holds that role and executes the swap and the payout; the creator "
          + "wallet does not, so there is no transaction Vex could sign that collects this. Measured at "
          + `block ${status.blockNumber}: hasRole(SWAP_ROLE, creator) = ${String(status.creatorHasSwapRole)}`
          + `, hasRole(SWAP_ROLE, tokenBoundAccount) = ${String(status.tokenBoundAccountHasSwapRole)}.`,
        measured: {
          creatorHasSwapRole: status.creatorHasSwapRole,
          tokenBoundAccountHasSwapRole: status.tokenBoundAccountHasSwapRole,
          swapRole: "keccak256(\"SWAP_ROLE\")",
        },
        venue: CLAIM_VENUE,
        payoutIsAutomatic:
          "When the backend swaps, the creator's share is TRANSFERRED to the creator address above. There "
          + "is nothing for the creator to claim afterwards - the money arrives on its own.",
      },

      providerRevenueClaim: revenue.measured
        ? {
            measured: true,
            source: "api2.virtuals.io /api/revenue-connect-metrics/virtuals/{id}?metric=summary",
            totalRevenue: revenue.summary.totalRevenue,
            totalTokenAccumulated: revenue.summary.totalTokenAccumulated,
            totalTokenAccumulatedUsd: revenue.summary.totalTokenAccumulatedUsd,
            note:
              "This is Virtuals' own REVENUE-CONNECT number - a different stream from the bonding-curve tax "
              + "above, with no asset or scale stated by the provider. Measured 2026-09-04 it answered all "
              + "zeros for every agent probed, including the three largest on Base, while those agents held "
              + "thousands of VIRTUAL of accrued tax on chain. A zero here says nothing about the creator's "
              + "trading fees.",
          }
        : { measured: false, reason: revenue.reason },

      pins: {
        measuredOn: "2026-09-04",
        taxVaultMatchesPin: status.taxVaultMatchesPin,
        implementationMatchesPin: status.implementationMatchesPin,
        taxAssetMatchesPin: status.taxAsset.matchesPin,
        payoutAssetMatchesPin: status.payoutAsset.matchesPin,
      },

      ...(notes.length > 0 ? { notes } : {}),
    });
  } catch (err) {
    logger.warn("virtuals.handler.error", {
      toolId: TOOL_ID,
      code: err instanceof VexError ? err.code : "UNEXPECTED",
      error: describeFailureForLog(err),
    });
    return fail(
      `Virtuals creator fees unavailable (${describeFailureForAgent(err)}). Nothing was measured - this is `
      + "not a statement that the creator has earned nothing.",
    );
  }
};
