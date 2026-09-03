/**
 * `solana.predict.closeAll` - the N-row fan-out prediction mutation (W5
 * design `w5-design.md` §5/R5). Split out of the sibling `predict-execute.ts`
 * (buy/sell/claim single-row mutations) purely for the 500-line cap; imports
 * that file's shared staged-write primitives (`sharedFields`/
 * `failPreBroadcast`/`stageAndSubmit`/`resolveSessionAndWallet`/
 * `isToolResult`/`usdEst`) rather than duplicating them.
 *
 * R5 exact contract: validate-all -> create-all-rows -> item-wise. Each item
 * gets its OWN `agent_activity` row (event_index 0..N-1) inside ONE
 * `protocol_execution`, created atomically BEFORE the first signature. A
 * per-item failure (post-intent sign refusal) finalizes ONLY that item's row
 * and the loop continues - no all-or-nothing pretense, no aggregate success
 * claim. `N=0` (no open positions) is an explicit success with zero rows.
 *
 * MANAGED EXECUTION (corrected 2026-07-25): a close/claim item whose build
 * carries an `execution` object routes through the provider's managed execute
 * endpoint (`resolveManagedExecution` / `stageAndSubmit` in
 * `predict-execute.ts`), signed under the co-signed contract. This applies to
 * keeper-filled items too, not just Forecast - the previous "keeper-filled
 * orders stay on the generic path" rule was proven false against the live API.
 *
 * `minSellPriceSlippageBps` is a REQUIRED agent param (no Vex-side default -
 * coordinator decision, Batch-4-closure blocker 2): the provider's own
 * `CloseAllPositionsRequest` marks it `required` with no documented min/max
 * (DOCS-GAP - `validation/body.ts` applies the transport-level 0-10,000 bps
 * arithmetic bound). Vex's PRODUCT ceiling is the tighter one and is enforced
 * here, in the agent tool layer, exactly as `handlers/core.ts` does for the
 * Jupiter swap: `slippage-policy.ts` refuses above 1000 bps rather than
 * clamping. Same layering as every other venue - the provider's wire bound is
 * not a licence to authorise the tolerance it happens to accept.
 */

import { Keypair } from "@solana/web3.js";

import {
  requestJupiterPredictionCloseAllPositionsTransactions,
  requireTransaction,
  resolveManagedExecution,
  type JupiterPredictionManagedExecution,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js";
import type { JupiterPredictionCloseAllPositionsItem } from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/types.js";
import { buildPredictionOrderProvenance } from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-order-provenance.js";
import { createAgentActivityIntent } from "@vex-agent/db/repos/agent-activity.js";

import type { ProtocolHandler } from "../types.js";
import { checkSlippageBps } from "../slippage-policy.js";
import { num, fail } from "../handler-helpers.js";
import {
  PREDICTION_PAYOUT_ASSET,
  PREDICTION_PAYOUT_LEG,
  PREDICTION_PAYOUT_SETTLEMENT_NOTE,
} from "./predict-payout-asset.js";
import {
  failPreBroadcast,
  isToolResult,
  resolveSessionAndWallet,
  sharedFields,
  stageAndSubmit,
  usdEst,
  type SharedEventInput,
} from "./predict-execute.js";

const NAMESPACE = "solana";

interface CloseAllPlan {
  readonly role: "predict_close" | "predict_claim";
  readonly transaction: string;
  /** Non-null whenever the item's build carried an `execution` object - see `resolveManagedExecution`. */
  readonly managed: JupiterPredictionManagedExecution | null;
  readonly positionPubkey: string;
  readonly payoutUsd: string | null | undefined;
  /**
   * The PROVIDER's protocol+venue fee for this item (migration 050's
   * `usd_venue_fee_est`). `predict.sell` recorded a fee and `closeAll` - which
   * is N of the same close - recorded none, so a fee appeared to depend on how
   * the close was invoked. A `predict_claim` item carries no order preview and
   * so genuinely has no fee figure: `undefined`, never 0.
   */
  readonly venueFeeUsd: string | null | undefined;
}

function planCloseAllItem(item: JupiterPredictionCloseAllPositionsItem): CloseAllPlan {
  if ("order" in item) {
    return {
      role: "predict_close", transaction: requireTransaction(item.transaction, "Close all positions"),
      managed: resolveManagedExecution(item, "Close all positions"),
      positionPubkey: item.order.positionPubkey, payoutUsd: item.order.newPayoutUsd,
      venueFeeUsd: item.order.estimatedTotalFeeUsd,
    };
  }
  return {
    role: "predict_claim", transaction: requireTransaction(item.transaction, "Close all positions"),
    managed: resolveManagedExecution(item, "Close all positions"),
    positionPubkey: item.position.positionPubkey, payoutUsd: item.position.payoutAmountUsd,
    // A claim item carries no order preview - no honest fee figure exists.
    venueFeeUsd: undefined,
  };
}

export const executePredictCloseAll: ProtocolHandler = async (p, ctx) => {
  const toolId = "solana.predict.closeAll";
  const minSellPriceSlippageBps = num(p, "minSellPriceSlippageBps");
  if (minSellPriceSlippageBps == null) return fail("Missing required: minSellPriceSlippageBps");
  // Vex's slippage ceiling, applied to the BATCH sell. One tolerance covers
  // EVERY position closed in this call, and the provider documents no maximum
  // - before this check a model could authorise a 100%-tolerance exit on the
  // one call that empties the whole book, while the identical single-position
  // swap was refused. Owner: `slippage-policy.ts`. REJECTED, never clamped, and
  // checked BEFORE wallet resolution or any provider call. The tolerance is
  // named explicitly so the retry sentence points at the param this tool has.
  const slippageViolation = checkSlippageBps(
    `Parameter "minSellPriceSlippageBps" for ${toolId}`,
    minSellPriceSlippageBps,
    undefined,
    "minSellPriceSlippageBps",
  );
  if (slippageViolation) return fail(slippageViolation);

  const resolved = resolveSessionAndWallet(toolId, p, ctx);
  if (isToolResult(resolved)) return resolved;
  const { sessionId, addr, secret } = resolved;
  const shared: SharedEventInput = { eventRole: "predict_close", walletAddress: addr, sessionId };

  let raw: { data: JupiterPredictionCloseAllPositionsItem[] };
  try {
    raw = await requestJupiterPredictionCloseAllPositionsTransactions({ ownerPubkey: addr, minSellPriceSlippageBps });
  } catch (err) {
    return failPreBroadcast(toolId, p, shared, err);
  }

  if (raw.data.length === 0) {
    return { success: true, output: JSON.stringify({ count: 0, message: "No open positions to close." }), data: { count: 0 } };
  }

  // Validate ALL items BEFORE creating any row (R5) - a malformed item
  // aborts the whole batch pre-broadcast; nothing was recorded yet.
  let plans: CloseAllPlan[];
  try {
    plans = raw.data.map(planCloseAllItem);
  } catch (err) {
    return failPreBroadcast(toolId, p, shared, err);
  }

  // Create ALL N rows atomically BEFORE the first signature (R5).
  const { executionId, events } = await createAgentActivityIntent({
    toolId, namespace: NAMESPACE, intentParams: p,
    events: plans.map((plan, i) => ({
      ...sharedFields({ eventRole: plan.role, walletAddress: addr, sessionId }), eventIndex: i,
      // PER-ITEM position truth. Every row of this fan-out shares ONE
      // `intentParams` echo, so without this a settlement sweep could not
      // tell which position a given row closed - and with two open positions
      // could match a row against its sibling's money.
      routeProvenance: buildPredictionOrderProvenance(plan.positionPubkey),
      // Payout ASSET only, for BOTH fan-out roles. `newPayoutUsd`/
      // `payoutAmountUsd` are USD estimates, not atomic JupUSD quantities -
      // see `predict-payout-asset.ts`. The estimate stays in `usdOutEst`.
      tokenOut: PREDICTION_PAYOUT_LEG,
      usdOutEst: usdEst(plan.payoutUsd),
      usdVenueFeeEst: usdEst(plan.venueFeeUsd),
      usdSource: "jupiter_prediction_order_preview",
    })),
  });

  const signer = Keypair.fromSecretKey(secret);
  const results: Array<{
    role: string; positionPubkey: string; status: "pending" | "rejected_before_broadcast" | "failed";
    signature?: string; explorerUrl?: string; reason?: string;
  }> = [];
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]!;
    const rowId = events[i]!.id;
    const staged = await stageAndSubmit(toolId, rowId, plan.transaction, signer, plan.managed);
    const base = { role: plan.role, positionPubkey: plan.positionPubkey };
    if (staged.status === "failed") {
      results.push({ ...base, status: "failed", reason: staged.reason });
    } else if (staged.status === "rejected") {
      // The landing service answered and refused - nothing went on-chain for
      // this item. Never counted as broadcast.
      results.push({ ...base, status: "rejected_before_broadcast", reason: staged.reason });
    } else {
      results.push({ ...base, status: "pending", signature: staged.signature, explorerUrl: staged.explorerUrl });
    }
  }

  const pendingCount = results.filter(r => r.status === "pending").length;
  const rejectedCount = results.filter(r => r.status === "rejected_before_broadcast").length;
  const failedCount = results.length - pendingCount - rejectedCount;
  return {
    success: false, // R5: never an aggregate success claim while any item is unconfirmed
    output: `${toolId}: ${pendingCount} of ${results.length} close/claim transaction(s) broadcast (confirmation pending, tracked automatically)`
      + (rejectedCount > 0 ? `; ${rejectedCount} rejected before broadcast (nothing went on-chain)` : "")
      + (failedCount > 0 ? `; ${failedCount} failed before broadcast` : "")
      + ". Do not retry - check individual results. "
      + PREDICTION_PAYOUT_SETTLEMENT_NOTE,
    data: {
      _executionId: executionId, count: results.length, results,
      settlementAsset: PREDICTION_PAYOUT_ASSET,
    },
  };
};
