/**
 * `morpho.market.quote` - price ONE Morpho Blue market operation without
 * performing it.
 *
 * The market sibling of `./vault-quote.ts`, and the read that gates the four
 * executes. It signs nothing, sends nothing and approves nothing, and there is
 * no path in this file that could.
 *
 * ── IT REFUSES WHERE THE EXECUTE WOULD REFUSE ───────────────────────────────
 *
 * `previewMorphoMarketOperation` runs the execute's own path: the same market
 * gate, the same planner, the same builder and decoder, the same allowance
 * planner. So an unvouched oracle, a health factor below the 1.25 floor, a
 * market without the liquidity, or an assets repayment large enough to need the
 * shares path all fail HERE, before anything has been spent. That is what makes
 * quoting first worth doing rather than a formality.
 *
 * ── ONE DIRECTION PER QUOTE, AND IT DOES NOT AUTHORIZE ANOTHER ──────────────
 *
 * A quote records a prequote of the kind its direction names, and the gate pairs
 * each kind with exactly one execute. A `supplyCollateral` quote therefore
 * cannot authorize a borrow: they are different kinds, and the gate refuses the
 * mismatch by name. That is a money-safety property rather than bookkeeping -
 * supplying collateral is safe on its own, borrowing against it is the operation
 * that can be liquidated, and one must never stand in for the other.
 */

import { getAddress, type Address } from "viem";

import { getMorphoPublicClient } from "@tools/morpho/evm-client.js";
import { morphoActionsExtension, previewMorphoMarketOperation } from "@tools/morpho/mutations.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";

import type { ToolResult } from "../../../types.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import { parseMorphoMarketQuoteParams } from "../read-params.js";
import {
  MORPHO_MARKET_PLAN_NOTE,
  MORPHO_ONE_LEG_NOTE,
  MORPHO_REPAY_ASSETS_NOTE,
  MORPHO_REPAY_SHARES_NOTE,
  morphoMarketLegKeys,
  projectMorphoMarketDisclosure,
} from "./market-shared.js";
import { morphoFailureDetail } from "./shared.js";

const TOOL_ID = "morpho.market.quote";

/** Which execute a quote of this direction authorizes. One each, never a set. */
const EXECUTE_FOR: Readonly<Record<string, string>> = {
  supplyCollateral: "morpho.market.supplyCollateral",
  withdrawCollateral: "morpho.market.withdrawCollateral",
  borrow: "morpho.market.borrow",
  repay: "morpho.market.repay",
};

export async function morphoMarketQuote(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const parsed = parseMorphoMarketQuoteParams(params);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;

  // The wallet the projection belongs to: the one the caller named, else the
  // session's selected address, else a stand-in with no position. A quote never
  // resolves a SIGNING wallet and never touches key material.
  let walletAddress = q.walletAddress;
  if (walletAddress === undefined) {
    try {
      walletAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
    } catch {
      walletAddress = undefined;
    }
  }

  // A PUBLIC client only. This tool never resolves a signing wallet and never
  // touches key material, and the client it holds could not sign if asked.
  const client = getMorphoPublicClient(q.chainId).extend(morphoActionsExtension());

  let preview;
  try {
    preview = await previewMorphoMarketOperation(client, {
      chainId: q.chainId,
      marketId: q.marketId,
      operation: q.operation,
      amountRaw: q.amountRaw,
      repayFullDebt: q.repayFullDebt,
      walletAddress: walletAddress === undefined ? undefined : getAddress(walletAddress) as Address,
      slippageBps: q.slippageBps,
    });
  } catch (err) {
    return fail(`${TOOL_ID} could not price this ${q.direction}: ${morphoFailureDetail(err)}. Nothing was signed or sent.`);
  }

  const { plan, transaction, allowance } = preview;
  const disclosure = projectMorphoMarketDisclosure(preview.market, plan);
  const isShares = preview.intent.repayMode === "shares";

  return ok({
    toolId: TOOL_ID,
    direction: q.direction,
    operation: q.operation,
    chain: q.chainSlug,
    asOf: new Date().toISOString(),
    filtersApplied: q.echo,
    summary: plan.explanation,
    market: disclosure,
    ...morphoMarketLegKeys(plan.leg),
    leg: {
      direction: plan.leg.direction,
      tokenAddress: plan.leg.tokenAddress,
      tokenSymbol: plan.leg.tokenSymbol,
      decimals: plan.leg.decimals,
      amountRaw: plan.leg.amountRaw,
      ...(q.operation === "repay"
        ? { borrowSharesRaw: preview.intent.sharesRaw === null ? null : preview.intent.sharesRaw.toString() }
        : {}),
    },
    position: {
      collateralRaw: plan.positionBefore.collateralRaw.toString(),
      borrowSharesRaw: plan.positionBefore.borrowSharesRaw.toString(),
      borrowAssetsRaw: plan.positionBefore.borrowAssetsRaw.toString(),
      maxBorrowAssetsRaw: plan.positionBefore.maxBorrowAssetsRaw === null
        ? null
        : plan.positionBefore.maxBorrowAssetsRaw.toString(),
    },
    allowancePlan: allowance === null
      ? null
      : {
        shape: allowance.shape,
        token: allowance.token.toLowerCase(),
        spender: allowance.spender.toLowerCase(),
        spenderRole: allowance.spenderRole,
        requiredAmountRaw: allowance.requiredAmountRaw.toString(),
        currentAllowanceRaw: allowance.currentAllowanceRaw.toString(),
        steps: allowance.steps.map((step) => ({
          kind: step.kind,
          amountRaw: step.amountRaw.toString(),
          explanation: step.explanation,
        })),
      },
    transaction: {
      to: transaction.txParams.to.toLowerCase(),
      shape: transaction.decoded.shape,
      decoded: transaction.decoded.report,
      pullAmountRaw: transaction.pullAmountRaw === null ? null : transaction.pullAmountRaw.toString(),
      approvalAmountRaw: transaction.approvalAmountRaw === null ? null : transaction.approvalAmountRaw.toString(),
    },
    gas: preview.gas,
    preflight: preview.preflight,
    notes: {
      committed:
        "NOTHING WAS SIGNED, SENT, APPROVED OR RECORDED AS EXECUTED. This prices what this exact call would do; it is "
        + "not a promise about what it will do, because interest accrues and the oracle moves between this block and "
        + "any real transaction.",
      oneLeg: MORPHO_ONE_LEG_NOTE,
      plan: MORPHO_MARKET_PLAN_NOTE[q.operation] ?? "",
      ...(q.operation === "repay"
        ? { repayMode: isShares ? MORPHO_REPAY_SHARES_NOTE : MORPHO_REPAY_ASSETS_NOTE }
        : {}),
      wallet: preview.walletAddressWasSupplied
        ? "Every projection above belongs to the wallet this quote priced, and `allowancePlan` reflects its CURRENT "
          + "allowance, so a step it has already satisfied is absent rather than repeated."
        : "No wallet was named and none is selected for this chain, so this ran against a stand-in address with NO "
          + "POSITION. The health-factor projection is therefore the fresh-wallet case and does not describe anybody's "
          + "real position. Re-run with `walletAddress` for the real one.",
      simulation: preview.preflight.explanation,
      scales:
        "The market's two tokens have their own decimals and they rarely match. Every amount above names the token "
        + "it is denominated in; never compare a collateral raw amount with a loan raw amount.",
    },
    nextStep:
      `This quote AUTHORIZES ${EXECUTE_FOR[q.direction]} for a limited time: call it with EXACTLY these params (same `
      + "marketId, same chain, same raw amount, same slippageBps) to perform it. A quote of any OTHER direction does "
      + `not authorize it, and ${EXECUTE_FOR[q.direction]} is refused without a fresh matching quote. Report the `
      + "health factor, the oracle vouching and any approval step plainly first: the execute spends real funds and "
      + "cannot be undone.",
  });
}
