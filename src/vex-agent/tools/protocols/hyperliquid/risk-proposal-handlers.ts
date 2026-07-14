import { hyperliquidPolicySchema } from "../../../../lib/hyperliquid-policy.js";
import { createHyperliquidSessionPolicyProposal } from "@vex-agent/db/repos/hyperliquid-policies.js";
import { hyperliquidRiskProposalBus } from "@vex-agent/engine/events/hyperliquid-risk-bus.js";
import type { ProtocolExecutionContext, ProtocolHandler } from "../types.js";
import {
  fail,
  infoClient,
  ok,
  requiredNumber,
  requiredString,
  signingAddress,
} from "./handler-shared.js";

export const HYPERLIQUID_RISK_PROPOSAL_HANDLERS: Record<string, ProtocolHandler> = {
  "hyperliquid.risk.proposeSetup": proposeRiskSetup,
};

async function proposeRiskSetup(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  if (context.sessionId === undefined) return fail("Hyperliquid risk setup requires an active session.");
  if (context.hyperliquidPolicy?.kind !== "available") {
    return fail("Hyperliquid risk setup is unavailable until the user acknowledges the Hyperliquid risk disclosure.");
  }
  const coin = requiredString(params, "coin");
  const { HyperliquidMetaCache } = await import("@tools/hyperliquid/meta-cache.js");
  const asset = (await new HyperliquidMetaCache(infoClient()).get()).perpsByCoin.get(coin);
  if (!asset) return fail(`Unknown Hyperliquid Core market "${coin}".`);
  const leverageCapDefault = requiredNumber(params, "leverageCapDefault");
  if (!Number.isInteger(leverageCapDefault) || leverageCapDefault > asset.maxLeverage) {
    return fail(`Proposed leverage must be a whole number no greater than ${asset.maxLeverage}x for ${coin}.`);
  }
  const policy = hyperliquidPolicySchema.parse({
    ...context.hyperliquidPolicy.snapshot.policy,
    leverageCapDefault,
    perOrderNotionalPct: requiredNumber(params, "perOrderNotionalPct"),
    totalNotionalPct: requiredNumber(params, "totalNotionalPct"),
  });
  const walletAddress = await signingAddress(context);
  const proposal = await createHyperliquidSessionPolicyProposal({
    sessionId: context.sessionId,
    walletAddress,
    coin,
    policy,
    proposedBy: "agent",
  });
  const displayProposal = {
    proposalId: proposal.proposalId,
    sessionId: proposal.sessionId,
    coin: proposal.coin,
    policy: proposal.policy,
    proposedBy: proposal.proposedBy,
    status: proposal.status,
    confirmedAt: proposal.confirmedAt,
    expiresAt: proposal.expiresAt,
    createdAt: proposal.createdAt,
  };
  hyperliquidRiskProposalBus.emit({ sessionId: proposal.sessionId, proposalId: proposal.proposalId });
  return ok({
    proposal: displayProposal,
    _displayBlock: { namespace: "hyperliquid", kind: "risk_proposal", proposal: displayProposal },
  });
}

