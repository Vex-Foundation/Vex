/**
 * `morpho.rewards.claim` - sweep the session wallet's claimable Merkl rewards.
 *
 * ── WHAT THIS HANDLER OWNS ─────────────────────────────────────────────────
 *
 *   1. VALIDATION. There is NO wallet parameter, deliberately: a
 *      caller-supplied address could only ever be a wallet whose rewards this
 *      session pays gas to deliver to someone else. The signing wallet comes
 *      from the session's resolution. There is no fee, recipient, amount or
 *      destination parameter either, and rules/90 forbids one ever being added.
 *
 *      THE DESTINATION IS PROVED, NOT INFERRED FROM THE LEAF. An earlier
 *      version of this note said the distributor pays the wallet named in the
 *      leaf. It does not: `claim(...)` resolves the destination from the
 *      distributor's OWN `claimRecipient` state, so a redirect configured at
 *      any earlier point would have paid somebody else while this lane
 *      reported no credit. The lane therefore signs `claimWithRecipient` with
 *      every recipient hard-bound to the signing wallet, and
 *      `assertMerklClaimCalldata` checks that in the bytes. See
 *      `src/tools/merkl/distributor.ts` for the deployed-contract evidence.
 *   2. THE CHAIN ID, from Vex's own registry, never from model input.
 *   3. THE FRESH READ. Proofs expire when a new distribution root lands, so the
 *      claim is always built from a read taken moments before signing, never
 *      from anything the model carried in.
 *   4. THE DECODE-AND-ASSERT before signing, and the wording of every ending.
 *
 * Everything about signing, staging, recording and settling belongs to
 * `./signed-broadcast/claim-broadcast.ts`.
 *
 * ── WHY THERE IS NO QUOTE GATE ─────────────────────────────────────────────
 *
 * Every other Morpho write is refused without a fresh matching quote. This one
 * is exempt, mirroring `pendle.claim`, and the reason is that there is nothing
 * to quote: a claim has no price, no slippage, no counterparty and no size. It
 * moves an already-earned balance the distributor fixed. A quote tool here would
 * either restate `morpho.rewards.get` or invent a number, and the prequote gate
 * exists to bind an approval to a PRICE the user saw.
 */

import { getAddress, type Address, type Hex } from "viem";

import { getMerklClient } from "@tools/merkl/client.js";
import { attributeMerklRewards } from "@tools/merkl/rewards.js";
import { planMerklClaim, type MerklClaimExclusion } from "@tools/merkl/claim.js";
import {
  assertMerklClaimCalldata,
  buildMerklClaimCalldata,
  merklDistributorAddress,
} from "@tools/merkl/distributor.js";
import { getMorphoEvmClients } from "@tools/morpho/evm-client.js";
import { describeUnsupportedChain, resolveMorphoChainId, morphoChainSlug } from "@tools/morpho/chains.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../types.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import {
  MORPHO_CLAIM_ANCHOR_NOTE,
  broadcastMorphoClaim,
  recordMorphoClaimRefusal,
  type MorphoClaimBroadcastResult,
} from "./signed-broadcast/claim-broadcast.js";
import { morphoFailureDetail } from "./shared.js";

const TOOL_ID = "morpho.rewards.claim";

/** The consent model, restated in the OUTPUT rather than only in the manifest. */
const PLAN_NOTE =
  "A claim is ONE transaction: a single claim() call on Merkl's distributor, which pays from its own balance "
  + "against a Merkle proof. There is no approval, no allowance and no bundle, and the only cost is gas.";

interface ClaimQuery {
  readonly chainId: number;
  readonly chainSlug: string;
  readonly morphoOnly: boolean;
  readonly dryRun: boolean;
  readonly echo: Record<string, unknown>;
}

function parseParams(params: Record<string, unknown>): { ok: true; value: ClaimQuery } | { ok: false; message: string } {
  for (const forbidden of ["walletAddress", "wallet", "recipient", "to", "amount", "amountRaw", "feeBps"]) {
    if (params[forbidden] !== undefined) {
      return {
        ok: false,
        message:
          `${TOOL_ID} rejects \`${forbidden}\`: a claim is always for the session's own wallet, for the exact amounts `
          + "the distributor published, and it has no fee, amount or destination to set. Nothing was signed. Remove "
          + "the parameter and call again.",
      };
    }
  }

  const rawChain = params["chain"];
  if (typeof rawChain !== "string" || rawChain.trim().length === 0) {
    return { ok: false, message: `${TOOL_ID} needs \`chain\`: a claim is one transaction on one chain.` };
  }
  const chainId = resolveMorphoChainId(rawChain.trim());
  if (chainId === undefined) return { ok: false, message: describeUnsupportedChain(rawChain.trim()) };
  const chainSlug = morphoChainSlug(chainId) ?? rawChain.trim();

  const morphoOnly = params["morphoOnly"] === true;
  const dryRun = params["dryRun"] === true;
  return {
    ok: true,
    value: { chainId, chainSlug, morphoOnly, dryRun, echo: { chain: chainSlug, morphoOnly, dryRun } },
  };
}

/** Why a row was left behind, in the agent's words rather than an enum. */
const EXCLUSION_WORDING: Record<MerklClaimExclusion["reason"], string> = {
  nothing_claimable: "already fully claimed, so there is nothing left to sweep",
  not_morpho: "excluded by morphoOnly: it carries no resolved Morpho campaign, and it stays claimable",
  no_proof_published:
    "REFUSED: the distributor published no readable proof for it, so Vex will not claim it blind. It stays claimable "
    + "and a later read will carry the proof",
};

function describeExclusions(excluded: readonly MerklClaimExclusion[]): readonly Record<string, unknown>[] {
  return excluded.map((row) => ({
    tokenAddress: row.tokenAddress,
    tokenSymbol: row.tokenSymbol,
    claimableRaw: row.claimableRaw,
    reason: row.reason,
    explanation: EXCLUSION_WORDING[row.reason],
  }));
}

export async function morphoRewardsClaim(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const parsed = parseParams(params);
  if (!parsed.ok) return fail(parsed.message);
  const query = parsed.value;

  const sessionId = context.sessionId;
  if (!sessionId) {
    return fail(`${TOOL_ID} requires an active session, because every attempt is recorded against one.`);
  }

  // THE DISTRIBUTOR FIRST, and refused by name for a chain Vex has not verified
  // the address on. Doing this before the wallet or the read means an
  // unsupported chain costs nothing at all.
  const distributor = merklDistributorAddress(query.chainId);
  if (distributor === undefined) {
    return fail(
      `${TOOL_ID} refused: Vex has not verified Merkl's distributor address on ${query.chainSlug}, and it will not `
      + "sign a claim to an address it has not checked. NOTHING was signed and no gas was spent. Rewards on this "
      + "chain stay claimable through Merkl's own interface.",
    );
  }

  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") {
    return fail(`${TOOL_ID} needs an EVM wallet; the session resolved a ${signer.family} one.`);
  }
  const walletAddress = getAddress(signer.address);

  // A FRESH READ, ALWAYS. A proof is only valid against the root it was
  // published for, and roots turn over on the distributor's own cadence.
  let plan;
  try {
    const client = getMerklClient();
    const page = await client.getUserRewards(walletAddress, query.chainId, context.abortSignal);
    const chain = await attributeMerklRewards(client, page, context.abortSignal);
    plan = planMerklClaim(chain, { morphoOnly: query.morphoOnly });
  } catch (err) {
    return fail(
      `${TOOL_ID} could not read the wallet's rewards from Merkl, so it did not build a claim. NOTHING was signed. `
      + `Cause: ${morphoFailureDetail(err)}`,
    );
  }

  // THE HONEST EMPTY PATH. Nothing claimable is a plain answer, not a failure,
  // and it must never spend gas to discover that on-chain.
  if (plan.leaves.length === 0) {
    return ok({
      toolId: TOOL_ID,
      chain: query.chainSlug,
      status: "nothing_to_claim",
      claimed: false,
      walletAddress: walletAddress.toLowerCase(),
      excluded: describeExclusions(plan.excluded),
      summary:
        plan.hasUnprovableRewards
          ? `Nothing was claimed on ${query.chainSlug}. This wallet DOES hold rewards Vex could not claim because `
            + "the distributor published no readable proof for them; they remain claimable and are listed below. "
            + "Nothing was signed and no gas was spent."
          : query.morphoOnly && plan.excluded.some((row) => row.reason === "not_morpho")
            ? `Nothing to claim on ${query.chainSlug} under morphoOnly. The wallet has other reward tokens it CAN `
              + "claim, listed below; call again without morphoOnly to sweep them. Nothing was signed."
            : `Nothing to claim on ${query.chainSlug}: this wallet has no reward balance the distributor will pay `
              + "right now. Nothing was signed and no gas was spent.",
      notes: { plan: PLAN_NOTE },
    });
  }

  const call = buildMerklClaimCalldata(distributor, walletAddress, plan.leaves);
  const assertion = assertMerklClaimCalldata(call, walletAddress, plan.leaves);
  if (!assertion.ok) {
    // A failed assertion is a Vex-side defect, not a user error, and it fires
    // BEFORE a signature exists. It is recorded so the attempt is auditable.
    const message =
      `${TOOL_ID} refused to sign: the claim transaction Vex built did not survive its own check (${assertion.failure}: `
      + `${assertion.detail ?? "no detail"}). NOTHING was signed and no gas was spent. This is a fault in Vex rather `
      + "than a problem with the rewards, which remain claimable; please report it.";
    logger.warn("morpho.claim.assertion_failed", { toolId: TOOL_ID, failure: assertion.failure });
    await recordMorphoClaimRefusal(
      { toolId: TOOL_ID, chainId: query.chainId, walletAddress, sessionId, intentParams: query.echo },
      "unknown",
      message,
    );
    return fail(message);
  }

  const claimable = plan.leaves.map((leaf) => ({
    tokenAddress: leaf.tokenAddress,
    tokenSymbol: leaf.tokenSymbol,
    tokenDecimals: leaf.tokenDecimals,
    deliveredAmountRaw: leaf.deliveredAmountRaw,
    cumulativeAmountRaw: leaf.cumulativeAmountRaw,
    root: leaf.root,
    proofNodeCount: leaf.proof.length,
  }));

  if (query.dryRun) {
    return ok({
      toolId: TOOL_ID,
      chain: query.chainSlug,
      status: "dry_run",
      claimed: false,
      dryRun: true,
      walletAddress: walletAddress.toLowerCase(),
      distributor: distributor.toLowerCase(),
      wouldClaim: claimable,
      excluded: describeExclusions(plan.excluded),
      calldataBytes: (call.data.length - 2) / 2,
      summary:
        `Rehearsal only, nothing signed. A real call would claim ${plan.leaves.length} reward token`
        + `${plan.leaves.length === 1 ? "" : "s"} on ${query.chainSlug} in ONE transaction. Each token's delivered `
        + "amount is at its OWN decimals and they must not be added together.",
      notes: { plan: PLAN_NOTE, assertion: "The built transaction was decoded back and matched this plan exactly." },
    });
  }

  const { publicClient, walletClient } = getMorphoEvmClients(query.chainId, signer.privateKey as Hex);

  let outcome: MorphoClaimBroadcastResult;
  try {
    outcome = await broadcastMorphoClaim(
      publicClient,
      walletClient,
      { to: call.to as Hex, data: call.data, value: call.value },
      {
        toolId: TOOL_ID,
        chainId: query.chainId,
        walletAddress,
        sessionId,
        distributor,
        leaves: plan.leaves,
        intentParams: {
          ...query.echo,
          walletAddress: walletAddress.toLowerCase(),
          distributor: distributor.toLowerCase(),
          // THE FULL BREAKDOWN LIVES HERE. The durable row can carry only one
          // token's credit (one transaction, one row - see claim-broadcast.ts),
          // so the complete per-token plan is recorded on the execution where
          // nothing is length-limited.
          claimedTokens: claimable,
          excluded: describeExclusions(plan.excluded),
        },
      },
    );
  } catch (err) {
    // Pre-signature only: broadcastMorphoClaim threads the hash through every
    // post-broadcast branch, so nothing reaching here was ever sent.
    return fail(
      `${TOOL_ID} failed before anything was signed, so no gas was spent and the rewards remain claimable. `
      + `Cause: ${morphoFailureDetail(err)}`,
    );
  }

  return renderOutcome(query, walletAddress, distributor, plan.excluded, outcome);
}

function renderOutcome(
  query: ClaimQuery,
  walletAddress: Address,
  distributor: Address,
  excluded: readonly MerklClaimExclusion[],
  outcome: MorphoClaimBroadcastResult,
): ToolResult {
  const shared = {
    toolId: TOOL_ID,
    chain: query.chainSlug,
    walletAddress: walletAddress.toLowerCase(),
    distributor: distributor.toLowerCase(),
    executionId: outcome.executionId,
    // The runtime's adoption key: without it capture records a SECOND
    // protocol_executions row and this lane's intent row is stranded.
    _executionId: outcome.executionId,
    excluded: describeExclusions(excluded),
    plan: PLAN_NOTE,
  };

  if (outcome.kind === "confirmed") {
    logger.info("morpho.claim.confirmed", { toolId: TOOL_ID, chainId: query.chainId, tokens: outcome.credits.length });
    return ok({
      ...shared,
      status: "confirmed",
      claimed: true,
      txHash: outcome.txHash,
      // PROVEN from the receipt's own transfers, never the planned figures.
      credited: outcome.credits,
      anchorToken: outcome.anchor.tokenAddress,
      summary:
        `Claimed ${outcome.credits.length} reward token${outcome.credits.length === 1 ? "" : "s"} on `
        + `${query.chainSlug} in one transaction. Each amount below is PROVEN from the receipt and is at its own `
        + "decimals; they are different assets and must not be summed.",
      notes: {
        ledger: MORPHO_CLAIM_ANCHOR_NOTE,
        independence:
          "Reward tokens are separate assets whose value moves independently of whatever was supplied to earn them. "
          + "Claiming them does not lock in a price.",
      },
    });
  }

  if (outcome.kind === "unproven") {
    return {
      success: false,
      output: outcome.message,
      data: {
        ...shared,
        status: "unproven",
        reason: outcome.reason,
        txHash: outcome.txHash,
        claimed: false,
        // Present only when the receipt proved a sibling credit the anchored
        // row cannot carry. The tokens arrived; the ledger row did not move.
        ...(outcome.credits === undefined ? {} : { credited: outcome.credits }),
      },
    };
  }

  return {
    success: false,
    output: outcome.message,
    data: { ...shared, status: "reverted", txHash: outcome.txHash, claimed: false },
  };
}
