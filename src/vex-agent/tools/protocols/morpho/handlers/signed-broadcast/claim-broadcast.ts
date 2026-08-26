/**
 * Sign, stage, broadcast and RECORD one Merkl reward claim.
 *
 * ── ONE ROW PER TRANSACTION, AND WHY THIS LANE CANNOT DO PER-TOKEN LEGS ─────
 *
 * A claim delivers N tokens in ONE transaction. The obvious ledger shape - one
 * `agent_activity` leg per claimed token - is forbidden, deliberately, by
 * migration 044:
 *
 *   CREATE UNIQUE INDEX idx_agent_activity_tx_hash ON agent_activity (tx_hash)
 *     WHERE tx_hash IS NOT NULL;
 *
 * whose own comment reads "each on-chain broadcast can back exactly one
 * agent_activity row", with the CAS in `markActivityBroadcast` as its repo-level
 * half. That invariant is what makes a staged hash unambiguous, and it is not
 * something a reward sweep gets to relax.
 *
 * So this lane mirrors `pendle.claim`, which met the same wall: ONE row, with
 * ONE token's proven credit as the recorded leg (the CREDIT ANCHOR), and the
 * complete multi-token breakdown carried in `intent_params` and in the tool's
 * own output, where nothing is length-limited. The anchor is the largest
 * delivered leaf, so the recorded figure is the most representative one
 * available rather than whichever token happened to sort first.
 *
 * THE ANCHOR IS A PART, NOT THE WHOLE, and every surface that shows it says so.
 * A single anchored figure read as the total is the exact misreading this
 * comment, `MORPHO_CLAIM_ANCHOR_NOTE`, and the tool's own wording exist to
 * prevent.
 *
 * ── NO APPROVAL LEG, EVER ──────────────────────────────────────────────────
 *
 * The distributor pays from its own balance against a Merkle proof. The wallet
 * grants no allowance and spends nothing but gas, so this lane has exactly one
 * leg and never plans an approval. See `@tools/merkl/distributor.js` for the
 * measurement behind that claim.
 */

import { formatUnits, getAddress, type Account, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";

import { signStageBroadcast } from "@tools/evm-chains/staged-broadcast.js";
import type { MerklClaimLeaf } from "@tools/merkl/distributor.js";
import {
  confirmActivityEvent,
  createAgentActivityIntent,
  createAgentActivityPreBroadcastFailure,
  failActivityEvent,
  markActivityBroadcast,
  reserveActivityEvmNonce,
  markBroadcastAccepted,
  settlementDecodeProvenance,
  type AgentActivityFailureCode,
} from "@vex-agent/db/repos/agent-activity.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import logger from "@utils/logger.js";

import { finalizeMorphoFailSoft, noteMorphoSettledBlockTime } from "./leg-broadcast.js";
import {
  MORPHO_ACTIVITY_CHAIN_FAMILY,
  MORPHO_ACTIVITY_PROTOCOL,
  MORPHO_CLAIM_ACTIVITY_KIND,
  MORPHO_CLAIM_ROLE,
  morphoActivityChainSlug,
} from "./protocol.js";
import { provenClaimCredit, resolveClaimAnchor } from "./claim-settlement.js";

/**
 * The sentence every surface owes when it shows the anchored amount. Stated
 * once, as a constant, because the wording IS the contract: a claim that swept
 * three tokens must never read as having swept one.
 */
export const MORPHO_CLAIM_ANCHOR_NOTE =
  "The recorded amount is ONE token's credit (the largest), not the whole sweep. A claim delivers every token "
  + "in the same transaction; the full per-token breakdown is on this result and in the execution's intent_params.";

/** What the caller gathered before signing. Amounts here are intent, not result. */
export interface MorphoClaimPlan {
  readonly toolId: string;
  readonly chainId: number;
  readonly walletAddress: string;
  readonly sessionId: string;
  readonly intentParams: Record<string, unknown>;
  readonly leaves: readonly MerklClaimLeaf[];
  readonly distributor: string;
}

export interface MorphoClaimExecutedCredit {
  readonly tokenAddress: string;
  readonly tokenSymbol: string | null;
  readonly tokenDecimals: number;
  readonly amountRaw: string;
  readonly amountHuman: string;
}

export type MorphoClaimBroadcastResult =
  | {
      readonly kind: "confirmed";
      readonly txHash: Hex;
      readonly executionId: number;
      readonly anchor: MorphoClaimExecutedCredit;
      readonly credits: readonly MorphoClaimExecutedCredit[];
    }
  | { readonly kind: "reverted"; readonly txHash: Hex; readonly executionId: number; readonly message: string }
  | {
      readonly kind: "unproven";
      readonly reason: "ambiguous" | "no_credit" | "anchor_unpaid";
      readonly txHash: Hex;
      readonly executionId: number;
      readonly message: string;
      /** Present for `anchor_unpaid`: what the receipt DID prove was credited. */
      readonly credits?: readonly MorphoClaimExecutedCredit[];
    };

export const MORPHO_CLAIM_AMBIGUOUS_MESSAGE =
  "Cannot prove whether this claim landed. Do not retry; this attempt is recorded as pending and resolves "
  + "automatically. A claim is idempotent on-chain, but a second broadcast still costs gas for nothing.";

function noCreditMessage(txHash: Hex): string {
  return (
    `The claim mined successfully (tx ${txHash}) but credited no decodable token to the wallet, so nothing is `
    + "recorded as claimed. This is what an already-claimed or newly-superseded proof looks like. Do not retry; "
    + "the attempt is recorded as pending and resolves automatically."
  );
}

/**
 * The claim landed and paid SOMETHING, but not the token this row is keyed to.
 *
 * The tokens are the wallet's and nothing is lost; only the ledger row cannot
 * carry them, because it names the anchor's decimals and a sibling's raw amount
 * read at that scale would be a wrong number, not a rounded one.
 */
function anchorUnpaidMessage(
  txHash: Hex,
  anchor: MerklClaimLeaf,
  credits: readonly MorphoClaimExecutedCredit[],
): string {
  const paid = credits
    .map((credit) => `${credit.amountHuman} ${credit.tokenSymbol ?? credit.tokenAddress}`)
    .join(", ");
  return (
    `The claim mined successfully (tx ${txHash}) and credited ${paid} to the wallet. Those tokens ARE yours and `
    + `nothing was lost. The recorded row is keyed to ${anchor.tokenSymbol ?? anchor.tokenAddress}, which this `
    + "transaction credited nothing of, most likely because that leaf had already been claimed or its proof was "
    + "superseded. The row stays pending rather than recording one token's amount at another token's decimals. Do "
    + "not retry to fix the record; re-read the rewards to see the current claimable balance."
  );
}

/** The leaf whose delivered amount is largest. The anchor, and never a total. */
export function selectCreditAnchor(leaves: readonly MerklClaimLeaf[]): MerklClaimLeaf | null {
  let best: MerklClaimLeaf | null = null;
  for (const leaf of leaves) {
    if (best === null || BigInt(leaf.deliveredAmountRaw) > BigInt(best.deliveredAmountRaw)) best = leaf;
  }
  return best;
}

/**
 * Record a refusal decided BEFORE anything could be signed - no claimable
 * rewards, an unverified chain, a failed assertion. A hashless
 * `definitively_failed` row: there was never a payload to broadcast, so there is
 * nothing to stage or sweep. Fail-soft, because a bookkeeping error must not
 * turn a clean funds-untouched refusal into something that reads as on-chain.
 */
export async function recordMorphoClaimRefusal(
  plan: Pick<MorphoClaimPlan, "toolId" | "chainId" | "walletAddress" | "sessionId" | "intentParams">,
  failureCode: AgentActivityFailureCode,
  failureReason: string,
): Promise<number | null> {
  try {
    const chainSlug = morphoActivityChainSlug(plan.chainId);
    const { executionId } = await createAgentActivityPreBroadcastFailure({
      toolId: plan.toolId,
      namespace: MORPHO_ACTIVITY_PROTOCOL,
      intentParams: plan.intentParams,
      event: {
        eventIndex: 0,
        eventRole: MORPHO_CLAIM_ROLE,
        kind: MORPHO_CLAIM_ACTIVITY_KIND,
        protocol: MORPHO_ACTIVITY_PROTOCOL,
        chainId: plan.chainId,
        ...(chainSlug === undefined ? {} : { chainSlug }),
        chainFamily: MORPHO_ACTIVITY_CHAIN_FAMILY,
        walletAddress: plan.walletAddress.toLowerCase(),
        sessionId: plan.sessionId,
        failureCode,
        failureReason,
      },
    });
    return executionId;
  } catch (err) {
    logger.warn("morpho.claim.pre_broadcast_record_failed", {
      toolId: plan.toolId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}

/**
 * The full write protocol for one claim: durable intent, staged hash before the
 * raw submit, accept, then a definitive receipt or nothing terminal at all.
 *
 * THROWS only before a signature exists. Once a hash exists every branch returns
 * a result carrying it, so no post-broadcast throw can make an on-chain
 * transaction read as "nothing happened".
 */
export async function broadcastMorphoClaim(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain, Account>,
  tx: { readonly to: Hex; readonly data: Hex; readonly value: bigint },
  plan: MorphoClaimPlan,
): Promise<MorphoClaimBroadcastResult> {
  const anchor = selectCreditAnchor(plan.leaves);
  if (anchor === null) throw new Error(`${plan.toolId}: refusing to broadcast a claim with no leaves`);

  const chainSlug = morphoActivityChainSlug(plan.chainId);
  const { executionId, events } = await createAgentActivityIntent({
    toolId: plan.toolId,
    namespace: MORPHO_ACTIVITY_PROTOCOL,
    intentParams: plan.intentParams,
    events: [
      {
        eventIndex: 0,
        eventRole: MORPHO_CLAIM_ROLE,
        kind: MORPHO_CLAIM_ACTIVITY_KIND,
        protocol: MORPHO_ACTIVITY_PROTOCOL,
        chainId: plan.chainId,
        ...(chainSlug === undefined ? {} : { chainSlug }),
        chainFamily: MORPHO_ACTIVITY_CHAIN_FAMILY,
        walletAddress: plan.walletAddress.toLowerCase(),
        sessionId: plan.sessionId,
        // NO `tokenIn`, ever. `agent_activity_yield_confirmed_legs` requires a
        // confirmed `yield_claim` to carry an output and NO input, which is the
        // database agreeing that a claim spends nothing.
        tokenOut: {
          tokenAddress: anchor.tokenAddress,
          ...(anchor.tokenSymbol === null ? {} : { tokenSymbol: anchor.tokenSymbol }),
          tokenDecimals: anchor.tokenDecimals,
          amountHuman: formatUnits(BigInt(anchor.deliveredAmountRaw), anchor.tokenDecimals),
          amountRaw: anchor.deliveredAmountRaw,
        },
        routeProvenance: {
          action: "merkl_claim",
          claimedTokenCount: plan.leaves.length,
          // The anchor is named as an anchor in the durable row itself, so a
          // later reader cannot mistake the recorded leg for the whole sweep.
          creditAnchor: anchor.tokenAddress,
          claimedTokens: plan.leaves.map((leaf) => ({
            tokenAddress: leaf.tokenAddress,
            tokenSymbol: leaf.tokenSymbol,
            tokenDecimals: leaf.tokenDecimals,
            deliveredAmountRaw: leaf.deliveredAmountRaw,
          })),
          ...settlementDecodeProvenance({
            decoder: "morpho",
            chainId: plan.chainId,
            routerAddress: getAddress(plan.distributor),
          }),
        },
      },
    ],
  });
  const eventRow = events[0];
  if (eventRow === undefined) throw new Error(`${plan.toolId}: intent creation returned no event row`);

  const outcome = await signStageBroadcast(
    publicClient,
    walletClient,
    { to: tx.to, data: tx.data, value: tx.value },
    {
      onNonceReserved: (request) => reserveActivityEvmNonce(eventRow.id, request),
      onHashStaged: async (handles) => {
        const staged = await markActivityBroadcast(eventRow.id, handles);
        if (!staged.applied) {
          throw new Error(
            `${plan.toolId}: markActivityBroadcast CAS miss for event ${eventRow.id} - refusing to broadcast untracked`,
          );
        }
      },
      onAccepted: async () => {
        const accepted = await markBroadcastAccepted(eventRow.id);
        if (!accepted.applied) {
          logger.warn("morpho.claim.broadcast_accept_miss", { id: eventRow.id, toolId: plan.toolId });
        }
      },
    },
  );

  if (outcome.kind === "ambiguous") {
    logger.info("morpho.claim.ambiguous", { id: eventRow.id, toolId: plan.toolId, stage: outcome.stage });
    await noteHandlerPendingReason(
      plan.toolId, eventRow.id,
      outcome.stage === "send" ? "broadcast_ambiguous_send" : "broadcast_ambiguous_confirm",
    );
    return {
      kind: "unproven", reason: "ambiguous", txHash: outcome.txHash, executionId,
      message: MORPHO_CLAIM_AMBIGUOUS_MESSAGE,
    };
  }

  if (outcome.kind === "reverted") {
    await finalizeMorphoFailSoft(plan.toolId, () =>
      failActivityEvent(eventRow.id, {
        failureCode: "mined_revert",
        failureReason:
          `${plan.toolId}: the Merkl claim reverted on-chain. The usual cause is a proof that a newer Merkle root `
          + "has superseded; no rewards were lost, and a fresh read will carry the current proof.",
      }),
    );
    return {
      kind: "reverted", txHash: outcome.txHash, executionId,
      message:
        `${plan.toolId}: the claim (${outcome.txHash}) reverted on-chain. No rewards moved and nothing was lost `
        + "beyond the gas spent; the proof was most likely superseded by a newer distribution root.",
    };
  }

  // Mined successfully. From here a bookkeeping throw must never read as the
  // claim having failed.
  const credits = provenClaimCredit(outcome.receipt.logs, plan.walletAddress, plan.leaves);
  // Only the anchored token may confirm this row; `./claim-settlement.ts` owns
  // that rule and the reason for it.
  const resolution = resolveClaimAnchor(credits, anchor.tokenAddress);

  if (resolution.kind === "anchor_unpaid") {
    logger.warn("morpho.claim.anchor_unpaid", {
      id: eventRow.id, toolId: plan.toolId, credited: credits.length,
    });
    await noteHandlerPendingReason(plan.toolId, eventRow.id, "settlement_undecodable");
    return {
      kind: "unproven", reason: "anchor_unpaid", txHash: outcome.txHash, executionId, credits,
      message: anchorUnpaidMessage(outcome.txHash, anchor, credits),
    };
  }
  if (resolution.kind === "no_credit") {
    logger.warn("morpho.claim.no_credit", { id: eventRow.id, toolId: plan.toolId });
    await noteHandlerPendingReason(plan.toolId, eventRow.id, "settlement_undecodable");
    return {
      kind: "unproven", reason: "no_credit", txHash: outcome.txHash, executionId,
      message: noCreditMessage(outcome.txHash),
    };
  }
  const provenAnchor = resolution.provenAnchor;

  await finalizeMorphoFailSoft(plan.toolId, () =>
    confirmActivityEvent(eventRow.id, {
      executedAmountOutRaw: provenAnchor.amountRaw,
      executedAmountOutHuman: provenAnchor.amountHuman,
    }),
  );
  await noteMorphoSettledBlockTime(publicClient, eventRow.id, outcome.receipt);

  return { kind: "confirmed", txHash: outcome.txHash, executionId, anchor: provenAnchor, credits };
}
