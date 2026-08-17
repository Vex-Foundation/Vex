/**
 * The BLUE MARKET EXECUTION SPINE: gate the market, plan the operation, record
 * it, then send the legs in order.
 *
 * The sibling of `./run.ts`. Same sequencing discipline, and it reuses that
 * lane's approval legs unchanged, because approving an exact amount to a spender
 * is the same job whichever operation spends it.
 *
 * ── THE DISPATCH THIS FILE NO LONGER OWNS ───────────────────────────────────
 *
 * Building one operation into bytes belongs to
 * `@tools/morpho/mutations/market-dispatch.ts`, which knows that
 * `supply_collateral` and `repay` are Bundler3 multicalls carrying an approval
 * while `borrow` and `withdraw_collateral` are direct Blue calls carrying none.
 * It moved there when `morpho.market.quote` arrived: the preview and the execute
 * must build the SAME bytes the same way, or the gate would certify a
 * transaction the execute never produces. This file sequences; it does not
 * encode.
 *
 * ── WHY THE ORDER BELOW IS THE ORDER ────────────────────────────────────────
 *
 * The market policy gate and the health-factor floor run BEFORE any durable row
 * exists, because a refusal that never should have been attempted is not an
 * execution and should not be recorded as one. Everything after the rows exist
 * is a RETURNED outcome rather than a throw, because by then there is a record
 * that must be reported rather than discarded.
 */

import { getAddress } from "viem";

import {
  buildMorphoMarketTransaction,
  planMorphoAllowance,
  planMorphoBorrowOperation,
  readMorphoBlueMarket,
  requireMorphoBlue,
  type MorphoAllowancePlan,
  type MorphoBorrowIntent,
  type MorphoBorrowLeg,
} from "@tools/morpho/mutations.js";

import { createMorphoIntent } from "./intent.js";
import { morphoBorrowIntentParams, planMorphoBorrowLegs } from "./borrow-intent.js";
import { runAllowanceLegs } from "./allowance-legs.js";
import { runMarketOperationLeg } from "./market-operation-leg.js";
import type { MorphoExecutionClients } from "./allowance-context.js";
import type { MorphoExecutionOutcome } from "./outcome.js";
import type {
  MorphoMarketExecutionContext,
  MorphoMarketExecutionRequest,
} from "./market-context.js";

/** One label per operation, for every sentence the legs produce. */
function labelFor(intent: MorphoBorrowIntent): string {
  return intent.operation.replace(/_/g, " ");
}

/**
 * Run one Morpho Blue MARKET execution end to end.
 *
 * @throws for a PLAN-time refusal only - an ungated market, a health factor
 * below the floor, a repayment that cannot close its debt, an approval plan that
 * disagrees with its operation - all before any durable row exists and before
 * anything is signed. Every later failure is a RETURNED outcome carrying the
 * execution id.
 */
export async function executeMorphoMarketOperation(
  clients: MorphoExecutionClients,
  request: MorphoMarketExecutionRequest & {
    readonly chainId: number;
    readonly marketId: string;
    readonly intent: MorphoBorrowIntent;
  },
): Promise<MorphoExecutionOutcome> {
  // PHASE 1a. The market gate. An oracle no factory minted, or an IRM that is
  // not the chain's, is refused here and never reaches a row.
  const market = await readMorphoBlueMarket(clients.actionClient, request.chainId, request.marketId);

  // PHASE 1b. Fresh position read, liquidity check, repay-denomination rule and
  // the health-factor floor. Throws to refuse, pre-row and pre-signature.
  const plan = await planMorphoBorrowOperation(clients.actionClient, market, request.intent);

  const built = await buildMorphoMarketTransaction(
    clients.actionClient, market, request.intent, request.slippageBps,
  );
  const verifiedTarget = getAddress(built.txParams.to);

  const allowancePlan: MorphoAllowancePlan | null =
    built.approvalAmountRaw === null || built.pullToken === null
      ? null
      : await planMorphoAllowance(clients.actionClient, {
        chainId: request.chainId,
        assetAddress: built.pullToken,
        walletAddress: request.walletAddress,
        // THE CEILING, not this build's transfer amount, so ordinary accrual
        // between the approval and the send cannot refuse a correct operation.
        requiredAmountRaw: built.approvalAmountRaw,
      });

  const blueAddress = requireMorphoBlue(request.chainId);
  const legs = planMorphoBorrowLegs({
    sessionId: request.sessionId,
    walletAddress: request.walletAddress,
    intent: request.intent,
    leg: plan.leg,
    allowancePlan,
    blueAddress,
    verifiedTarget,
  });

  // The durable rows exist BEFORE a signature does.
  const { executionId, events } = await createMorphoIntent(
    request.toolId,
    morphoBorrowIntentParams({
      sessionId: request.sessionId,
      walletAddress: request.walletAddress,
      intent: request.intent,
      leg: plan.leg,
      allowancePlan,
      blueAddress,
      verifiedTarget,
    }),
    legs,
  );

  const leg: MorphoBorrowLeg = plan.leg;
  const context: MorphoMarketExecutionContext = {
    clients,
    request,
    intent: request.intent,
    market,
    leg,
    blueAddress,
    verifiedTarget,
    executionId,
    events,
    legs,
    allowancePlan,
    // The operation leg is planned LAST in this lane too, but the approval loop
    // is told rather than left to infer it.
    operationLegIndex: legs.length - 1,
    operationLabel: labelFor(request.intent),
    // The approval covers what the wallet AUTHORISED, which on a shares
    // repayment is the ceiling rather than one build's over-pull. The rebuild
    // check in `./market-operation-leg.ts` is measured against this.
    approvalAmountRaw: built.approvalAmountRaw ?? 0n,
    approvalDecimals: leg.decimals,
    approvalSymbol: leg.tokenSymbol,
    residual: null,
    priorLeg: undefined,
    // PHASE 2 GENUINELY REBUILDS. It runs the same dispatch again against state
    // as it is at signing time, so a bundled operation re-reads the position and
    // re-derives its price ceiling rather than signing bytes drawn earlier.
    rebuild: async () => {
      const fresh = await buildMorphoMarketTransaction(
        clients.actionClient, market, request.intent, request.slippageBps,
      );
      return { ...fresh.txParams, pullAmountRaw: fresh.pullAmountRaw };
    },
  };

  const allowanceOutcome = await runAllowanceLegs(context);
  if (allowanceOutcome !== null) return allowanceOutcome;
  return runMarketOperationLeg(context);
}
