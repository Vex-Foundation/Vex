/**
 * The SIX agent-facing Morpho Blue market tools that move real funds. Four are
 * the BORROWER'S side - `morpho.market.supplyCollateral`,
 * `morpho.market.withdrawCollateral`, `morpho.market.borrow` and
 * `morpho.market.repay` - and two are the LENDER'S: `morpho.market.supply` and
 * `morpho.market.withdraw`, which lend the loan asset into the market and take
 * it back out. A supply earns the market's own borrow rate; it is not collateral
 * and it changes no health factor.
 *
 * ONE SPINE, SIX TOOLS. The operation is the only thing that differs between
 * them at this layer and it is passed as an argument rather than duplicated,
 * exactly as `./vault-execute.ts` does for its two. Everything
 * operation-specific is either a param key (owned by
 * `../read-params/market-operations.ts`) or a sentence (owned by
 * `./market-shared.ts`).
 *
 * ── WHAT THIS HANDLER OWNS, AND WHAT IT REFUSES TO OWN ──────────────────────
 *
 *   1. VALIDATION. Model input is untrusted until parsed. There is no fee, no
 *      limit, no destination and no recipient param, another operation's amount
 *      key is refused BY NAME rather than dropped, and `walletAddress` is
 *      refused outright: an execute signs with the session's wallet and nothing
 *      a model sends can redirect where borrowed funds land.
 *   2. THE CHAIN ID, resolved from Vex's own registry, never from model input.
 *   3. THE CLIENTS, and the signing wallet from the session's resolution.
 *   4. THE DISCLOSURE and the outcome wording the agent reads.
 *
 * It owns NOTHING about the transaction. The market gate, the health-factor
 * floor, the build, the decode, the exact-amount approval, the leg ordering, the
 * durable rows and the proven amounts all belong to
 * `./signed-broadcast.ts`, the one owner of sign+broadcast+record here.
 *
 * ── TWO SHAPES, STATED HONESTLY RATHER THAN AVERAGED ────────────────────────
 *
 * `supplyCollateral`, `repay` and `supply` PULL a token, so each is up to two
 * transactions behind one consent: an exact-amount approve() then a Bundler3
 * bundle. `borrow`, `withdrawCollateral` and `withdraw` only RECEIVE, so each is
 * a single direct Morpho Blue call with no approval and no standing allowance at
 * any point. The output says which shape ran rather than describing all six the
 * same way.
 *
 * ── WHY THERE IS NO GENERIC ERROR IN THIS FILE ──────────────────────────────
 *
 * Rules/04's owner decree: an agent-facing tool error surfaces the REAL cause in
 * agent-friendly words, sanitized, never silenced into a generic label. Every
 * failure path below names what happened and what to do about it, and the four
 * execution endings are reported as themselves rather than collapsed into
 * success-or-failure.
 */

import { getAddress, type Address, type Hex } from "viem";

import { getMorphoEvmClients, getMorphoPublicClient } from "@tools/morpho/evm-client.js";
import {
  describeMorphoBorrowLeg,
  morphoActionsExtension,
  previewMorphoMarketOperation,
  readMorphoBlueMarket,
  resolveMorphoBorrowIntent,
  readMorphoRemainingAllowance,
  type MorphoBorrowIntent,
  type MorphoRemainingAllowance,
} from "@tools/morpho/mutations.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import {
  resolveSelectedAddress,
  resolveSigningWallet,
  walletScopeErrorToResult,
} from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../types.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import {
  parseMorphoMarketExecuteParams,
  type MorphoMarketDirection,
  type MorphoMarketExecuteQuery,
} from "../read-params.js";
import {
  executeMorphoMarketOperation,
  recordMorphoBorrowRefusal,
  type MorphoExecutionOutcome,
} from "./signed-broadcast.js";
import {
  MORPHO_MARKET_PLAN_NOTE,
  MORPHO_ONE_LEG_NOTE,
  MORPHO_REPAY_ASSETS_NOTE,
  MORPHO_REPAY_SHARES_NOTE,
  morphoMarketLegKeys,
  morphoSettledLegKeys,
  projectMorphoMarketDisclosure,
} from "./market-shared.js";
import { morphoFailureDetail } from "./shared.js";

const TOOL_ID: Readonly<Record<MorphoMarketDirection, string>> = {
  supplyCollateral: "morpho.market.supplyCollateral",
  withdrawCollateral: "morpho.market.withdrawCollateral",
  borrow: "morpho.market.borrow",
  repay: "morpho.market.repay",
  supply: "morpho.market.supply",
  withdraw: "morpho.market.withdraw",
};

export async function morphoMarketSupplyCollateral(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  return runMorphoMarketExecute("supplyCollateral", params, context);
}

export async function morphoMarketWithdrawCollateral(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  return runMorphoMarketExecute("withdrawCollateral", params, context);
}

export async function morphoMarketBorrow(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  return runMorphoMarketExecute("borrow", params, context);
}

export async function morphoMarketRepay(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  return runMorphoMarketExecute("repay", params, context);
}

/**
 * The LENDER'S side of the same market. It shares this spine because the
 * validation, the chain resolution, the wallet resolution and the four endings
 * are identical; what differs is the token it moves and the position it changes,
 * and both of those are already owned by the read-params table and the engine.
 */
export async function morphoMarketSupply(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  return runMorphoMarketExecute("supply", params, context);
}

export async function morphoMarketWithdraw(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  return runMorphoMarketExecute("withdraw", params, context);
}

async function runMorphoMarketExecute(
  direction: MorphoMarketDirection,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const toolId = TOOL_ID[direction];
  const parsed = parseMorphoMarketExecuteParams(toolId, direction, params);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const query = parsed.value;

  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${toolId} requires an active session, because every attempt is recorded against one.`);

  if (query.dryRun) return previewOnly(toolId, direction, query, context);

  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") {
    return fail(`${toolId} needs an EVM wallet; the session resolved a ${signer.family} one.`);
  }
  const walletAddress = getAddress(signer.address);

  const { publicClient, walletClient } = getMorphoEvmClients(query.chainId, signer.privateKey as Hex);
  const actionClient = publicClient.extend(morphoActionsExtension());
  const clients = { publicClient, walletClient, actionClient };

  // The intent is resolved HERE because a refusal must be recorded against the
  // same operation, market and scale a success would have carried. A full-debt
  // repayment reads the position's own borrow shares at this point, since that
  // is the only number that can close a debt completely.
  let intent: MorphoBorrowIntent;
  try {
    const market = await readMorphoBlueMarket(actionClient, query.chainId, query.marketId);
    intent = await resolveMorphoBorrowIntent(actionClient, market, {
      operation: query.operation,
      amountRaw: query.amountRaw,
      repayFullDebt: query.repayFullDebt,
      userAddress: walletAddress,
    });
  } catch (err) {
    // The market gate itself refused, or the position could not be read. There
    // is no resolved operation to file a row against, so this is reported
    // without one rather than recorded as something it is not.
    return fail(
      `${toolId} refused before anything was signed: ${morphoFailureDetail(err)}. No transaction was sent and no gas `
      + "was spent.",
    );
  }

  let outcome: MorphoExecutionOutcome;
  try {
    outcome = await executeMorphoMarketOperation(clients, {
      toolId,
      sessionId,
      intentParams: query.echo,
      chainId: query.chainId,
      marketId: query.marketId,
      intent,
      walletAddress,
      slippageBps: query.slippageBps,
    });
  } catch (err) {
    // A PLAN-time refusal: no durable row exists and nothing was signed, so the
    // refusal is recorded here with its real cause and the same normalized
    // shape a succeeded operation would have carried.
    const message =
      `${toolId} refused before signing anything: ${morphoFailureDetail(err)}. No transaction was sent and no gas `
      + "was spent.";
    await recordMorphoBorrowRefusal(
      { toolId, sessionId, intent, leg: describeMorphoBorrowLeg(intent) },
      "unknown",
      message,
    );
    return fail(message);
  }

  // AFTER settlement, and only for the operations that PULL. The approval
  // is sized to the operation's upper bound and the chain decides what was
  // actually spent, so what remains standing is a fact only a fresh read has.
  // Reporting-only: a null read never downgrades a confirmed operation.
  const settledLeg = describeMorphoBorrowLeg(intent);
  const remainingAllowance = outcome.kind === "confirmed" && settledLeg.direction === "in"
    ? await readMorphoRemainingAllowance(actionClient, {
      chainId: query.chainId,
      assetAddress: getAddress(settledLeg.tokenAddress) as Address,
      walletAddress,
      assetDecimals: settledLeg.decimals,
    })
    : null;

  return renderOutcome(toolId, direction, query, intent, outcome, remainingAllowance);
}

/**
 * `dryRun` - the full preview, signing nothing.
 *
 * It runs the SAME preview `morpho.market.quote` runs, against the session's
 * selected wallet rather than a stand-in, so the health-factor projection and
 * the allowance plan are the real ones this wallet would face. It does not
 * resolve a signing wallet and never touches key material.
 */
async function previewOnly(
  toolId: string,
  direction: MorphoMarketDirection,
  query: MorphoMarketExecuteQuery,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  let walletAddress: string | undefined;
  try {
    walletAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch {
    walletAddress = undefined;
  }

  const client = getMorphoPublicClient(query.chainId).extend(morphoActionsExtension());

  let preview;
  try {
    preview = await previewMorphoMarketOperation(client, {
      chainId: query.chainId,
      marketId: query.marketId,
      operation: query.operation,
      amountRaw: query.amountRaw,
      repayFullDebt: query.repayFullDebt,
      walletAddress: walletAddress === undefined ? undefined : getAddress(walletAddress) as Address,
      slippageBps: query.slippageBps,
    });
  } catch (err) {
    return fail(
      `${toolId} could not build the preview: ${morphoFailureDetail(err)}. Nothing was signed or sent.`,
    );
  }

  const { plan, transaction, allowance } = preview;
  return ok({
    dryRun: true,
    toolId,
    direction,
    chain: query.chainSlug,
    filtersApplied: query.echo,
    summary: plan.explanation,
    market: projectMorphoMarketDisclosure(preview.market, plan),
    ...morphoMarketLegKeys(plan.leg),
    allowancePlan: allowance === null
      ? null
      : {
        shape: allowance.shape,
        requiredAmountRaw: allowance.requiredAmountRaw.toString(),
        currentAllowanceRaw: allowance.currentAllowanceRaw.toString(),
        steps: allowance.steps.map((step) => ({ kind: step.kind, amountRaw: step.amountRaw.toString() })),
      },
    transaction: {
      to: transaction.txParams.to.toLowerCase(),
      shape: transaction.decoded.shape,
      decoded: transaction.decoded.report,
    },
    gas: preview.gas,
    preflight: preview.preflight,
    plan: MORPHO_MARKET_PLAN_NOTE[query.operation] ?? "",
    notes: {
      committed:
        "NOTHING WAS SIGNED, SENT, APPROVED OR RECORDED AS EXECUTED. This is a rehearsal of what this exact call "
        + "would do, not a promise about what it will do: interest accrues and the oracle moves before any real "
        + "transaction.",
      oneLeg: MORPHO_ONE_LEG_NOTE,
      ...(query.operation === "repay"
        ? {
          repayMode: preview.intent.repayMode === "shares"
            ? MORPHO_REPAY_SHARES_NOTE
            : MORPHO_REPAY_ASSETS_NOTE,
        }
        : {}),
      wallet: preview.walletAddressWasSupplied
        ? "The projection and the allowance plan reflect the session's selected wallet and its CURRENT state, so a "
          + "step it has already satisfied is absent rather than repeated."
        : "No wallet is selected for this chain in the session, so this ran against a stand-in address with NO "
          + "POSITION. The health-factor projection is the fresh-wallet case and describes nobody's real position.",
      simulation: preview.preflight.explanation,
    },
  });
}

/**
 * Turn one of the four execution endings into the tool's own result.
 *
 * FOUR ENDINGS, FOUR ANSWERS. Only `confirmed` is a success. `refused` and
 * `reverted` are failures whose real cause and remediation the execution layer
 * already worded, and they are passed through rather than reworded into
 * something vaguer. `unproven` is the one that must never read as either: it
 * carries an explicit do-not-retry, because the transaction may already have
 * moved real funds.
 */
function renderOutcome(
  toolId: string,
  direction: MorphoMarketDirection,
  query: MorphoMarketExecuteQuery,
  intent: MorphoBorrowIntent,
  outcome: MorphoExecutionOutcome,
  remainingAllowance: MorphoRemainingAllowance | null,
): ToolResult {
  const leg = describeMorphoBorrowLeg(intent);
  const shared = {
    toolId,
    direction,
    operation: query.operation,
    chain: query.chainSlug,
    marketId: query.marketId,
    executionId: outcome.executionId,
    // The adoption key `captureExecution` needs to settle THIS lane's intent row
    // instead of recording a second one. See `./vault-execute.ts` for the
    // measurement that found every Morpho execution writing two rows.
    _executionId: outcome.executionId,
    plan: MORPHO_MARKET_PLAN_NOTE[query.operation] ?? "",
  };

  if (outcome.kind === "confirmed") {
    logger.info("morpho.market.execute.confirmed", { toolId, marketId: query.marketId });
    const settledHuman = leg.direction === "in"
      ? outcome.executed.amountInHuman
      : outcome.executed.amountOutHuman;
    return ok({
      ...shared,
      status: "confirmed",
      txHash: outcome.txHash,
      executed: outcome.executed,
      ...morphoSettledLegKeys(leg, settledHuman),
      tokenSymbol: leg.tokenSymbol,
      tokenAddress: leg.tokenAddress,
      tokenDecimals: leg.decimals,
      summary: outcome.message,
      ...(remainingAllowance === null ? {} : { remainingAllowance }),
      notes: {
        proven:
          "The amount above is PROVEN from the receipt's own Morpho Blue event, not copied from the quote. It is "
          + "denominated in the token named beside it, at that token's own decimals.",
        oneLeg: MORPHO_ONE_LEG_NOTE,
        ...(intent.repayMode === "shares" ? { repayMode: MORPHO_REPAY_SHARES_NOTE } : {}),
        ...(remainingAllowance === null
          ? {}
          : {
            remainingAllowance:
              `${remainingAllowance.remainingHuman} (${remainingAllowance.remainingRaw} raw units) of this token is `
              + "STILL APPROVED to GeneralAdapter1 after this operation, read from the chain rather than inferred. "
              + "The approval is sized to the operation's upper bound and the chain decides what is actually spent, "
              + "so a remainder is normal, especially after a full repay or a shares repayment. Nothing but "
              + "GeneralAdapter1 can spend it. Vex does not revoke it on its own; ask the owner if you want it "
              + "set back to zero, which costs a transaction.",
          }),
      },
    });
  }

  if (outcome.kind === "unproven") {
    return {
      success: false,
      output: outcome.message,
      data: { ...shared, status: "unproven", reason: outcome.reason, txHash: outcome.txHash },
    };
  }

  return {
    success: false,
    output: outcome.message,
    data: {
      ...shared,
      status: outcome.kind,
      role: outcome.role,
      ...(outcome.kind === "reverted" ? { txHash: outcome.txHash } : {}),
    },
  };
}
