/**
 * `virtuals.trade.execute` - the orchestrator of a Virtuals bonding-curve trade.
 *
 * It owns the order in which authority is acquired and evidence is gathered, and
 * the order IS the safety property:
 *
 *   forbidden params -> slippage policy -> chain -> wallet ADDRESS (never
 *   decrypts) -> CLAIM the approved quote -> re-read the whole chain state at
 *   the head -> re-price -> hold every "yes" row of the authority table against
 *   the sealed snapshot -> resolve the signing key -> plan the rows -> stage the
 *   allowance -> stage the trade -> decode the receipt -> only then the fee leg.
 *
 * ## What `simulateOnly` is, and why it stops where it does
 *
 * `simulateOnly: true` proves the path to the EDGE OF SIGNING and no further: no
 * signing key is opened, no prequote is CONSUMED, no row is written and nothing
 * is broadcast.
 *
 * It is still GATED. `virtuals.trade.execute` is a registered execute on the
 * prequote gate, and the gate runs in the runtime before this handler is
 * entered - so a simulation needs a fresh quote for the identical parameters
 * just as a real execute does. That is deliberate rather than a limitation, and
 * the alternative was worse: skipping the gate on a caller-supplied boolean
 * would put a param-driven bypass on a trust boundary, and if this branch were
 * ever reordered the bypass would admit an unquoted execute. Selecting the row
 * is not claiming it (`claimVirtualsExecutionSnapshot` below is what consumes
 * one), so the quote survives the simulation intact. Measured live 2026-09-04. It re-reads the chain, re-prices, builds the exact transactions
 * the signing path would carry, and asks the node to `eth_call` them from the
 * wallet address. The answer carries `executed: false` and the would-be
 * requests. It is the same shape the pools launch lane uses for the same reason:
 * a plan a person can inspect must be the plan that would actually run.
 *
 * ## What is NEVER retried
 *
 * Nothing. A signed trade whose outcome is unknown stays pending and is
 * reconciled; the fee leg is never re-sent; a reverted trade needs a fresh quote
 * and fresh authority. Rabby's retry path re-signs an approved payload under a
 * bumped nonce and a 1.3x gas multiplier (`rpcFlow.ts:424-465`); our own
 * wallet-reference audit records that as an explicit REJECTION, and this lane
 * keeps it rejected.
 */

import { formatUnits, getAddress, type Address, type Hex } from "viem";

import {
  buildCurveApproveTx,
  buildCurveBuyTx,
  buildCurveSellTx,
  curveDeadlineFrom,
  decodeCurveSettlement,
  getVirtualsCurveClients,
  getVirtualsCurvePublicClient,
  readCurveQuote,
  readCurveState,
  virtualsCurveSellFeeFromProceeds,
  type BuiltCurveTx,
  type CurveState,
} from "@tools/virtuals/curve/index.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";
import { priorLegAnchorFrom, type ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import {
  confirmActivityEvent,
  createAgentActivityIntent,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import {
  resolveSelectedAddress,
  resolveSigningWallet,
  walletScopeErrorToResult,
} from "@vex-agent/tools/internal/wallet/resolve.js";
import { claimVirtualsExecutionSnapshot } from "@vex-agent/tools/protocols/prequote/claim.js";
import {
  antiSniperBoundExceededRefusal,
  compareVirtualsExecutionInputs,
  floorUnreachableRefusal,
} from "@vex-agent/tools/protocols/quote-authority/virtuals.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../types.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import { summarizeProtocolError } from "../../runtime/errors.js";
import { buildTradePreview } from "./trade/binding.js";
import {
  abortRemainingCurvePlans,
  failCurveTradePreBroadcast,
  planCurveTradeEvents,
  VIRTUALS_CURVE_VENUE,
  type LegToken,
} from "./trade/activity.js";
import { parseTradeAmount, readTradeParams, type PartialTradeParams, type TradeParams } from "./trade/params.js";
import { buyTaxedInFor, executionInputsFrom, human, priceCurveTrade, type PricedCurveTrade } from "./trade/pricing.js";
import { runCurveFeeLeg, type CurveFeeCollection } from "./trade/fee-leg.js";
import { runCurveLeg, type CurveLegOutcome } from "./trade/broadcast.js";
import { QUOTE_PUBLIC_NAME, PROTOCOL, TRADE_TOOL_ID } from "./trade/tool-ids.js";

/** The AMM tool that trades a graduated agent, per chain. */
const GRADUATED_VENUE: Readonly<Record<number, string>> = {
  8453: "kyberswap__swap_quote / kyberswap__swap_execute",
  4663: "uniswap__swap_quote / uniswap__swap_execute",
};

export async function virtualsTradeExecute(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  // The manifest declares no `dryRun`. A caller that still passes it must never
  // reach a real broadcast just because the runtime's preview matrix treated the
  // call as a preview - `simulateOnly` is this tool's own, declared, no-signing
  // mode and it is the only one.
  if (p.dryRun === true) {
    return fail(`${TRADE_TOOL_ID} does not support dryRun - pass simulateOnly: true for a no-signing plan, or call ${QUOTE_PUBLIC_NAME}.`);
  }

  const read = readTradeParams(p, TRADE_TOOL_ID);
  if (!read.ok) {
    if (read.handoff) {
      return ok({
        executed: false,
        supported: false,
        chain: read.handoff.chain,
        reason: read.handoff.reason,
        useInstead: read.handoff.useInstead,
      });
    }
    return fail(read.reason);
  }
  const partial = read.params;

  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${TRADE_TOOL_ID} requires an active session.`);

  // Address-only wallet resolution - NEVER decrypts. A failure from here on can
  // be durably recorded with a real wallet address; the signing key is resolved
  // much later, and only once nothing is left that could refuse.
  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  const wallet = getAddress(walletAddress);

  const client = getVirtualsCurvePublicClient(partial.deployment);

  // ── SIMULATE ONLY: the whole path to the edge of signing, and nothing past it ──
  //
  // Deliberately BEFORE the claim. A simulation that consumed the approved quote
  // would leave the real execute with nothing to claim, which would turn an
  // inspection into a denial of the trade it was inspecting.
  if (partial.simulateOnly) {
    return await simulateCurveTrade({ p, partial, client, wallet, context });
  }

  // THE PROPOSAL THE CALLER NAMED, checked for PRESENCE before the claim.
  //
  // The manifest cannot mark `proposalId` required, because `simulateOnly` must
  // work without one; so this handler owns the conditional rule. Its PRESENCE is
  // checked here, ahead of the claim, for the same reason every other parameter
  // refusal sits ahead of it: a caller who simply forgot the parameter must not
  // have their approved quote consumed by the mistake. Only the digest COMPARISON
  // needs the claimed row, and that happens below.
  const proposalId = typeof p.proposalId === "string" ? p.proposalId.trim() : "";
  if (proposalId === "") {
    return fail(
      `${TRADE_TOOL_ID} requires the proposalId from the quote it executes. Call ${QUOTE_PUBLIC_NAME} with the same `
      + "chain, token, side, amountIn and slippageBps, then pass the proposalId it returns. Nothing was claimed or "
      + "signed. (Pass simulateOnly: true instead to inspect the plan without a quote.)",
    );
  }

  // ── THE APPROVED QUOTE, claimed for exactly one execute ──
  //
  // Claimed BEFORE this handler prices anything, so two concurrent executes of
  // one quote resolve to a single winner before either reads a chain. The floor,
  // the fee and the amounts come from THIS snapshot; the fresh chain read below
  // decides only whether they still hold.
  const claimed = await claimVirtualsExecutionSnapshot(
    TRADE_TOOL_ID, sessionId, p, context, `${TRADE_TOOL_ID}:${sessionId}`,
  );
  if (!claimed.ok) return fail(claimed.refusal.message);
  const approved = claimed.snapshot;

  // The digest covers every bound field, so this proves the row that was claimed
  // is the one the quote described - a stronger statement than a row id, which
  // names a container rather than its contents.
  if (proposalId !== approved.digest) {
    return fail(
      "Refused before signing: the proposalId does not match the quote this session has for this trade. Nothing was "
      + `signed. Request a fresh ${QUOTE_PUBLIC_NAME} and execute against the proposalId it returns.`,
    );
  }

  // ── THE CHAIN, RE-READ AT THE HEAD, immediately before anything is signed ──
  let state: Awaited<ReturnType<typeof readCurveState>>;
  try {
    state = await readCurveState({
      client, deployment: partial.deployment, token: partial.token, side: partial.side, wallet,
    });
  } catch (err) {
    return fail(`Virtuals curve state unavailable (${summarizeProtocolError(err).message}). Nothing was signed.`);
  }
  if (!state.ok) {
    if (state.code === "graduated") {
      return fail(
        `Refused before signing: ${state.reason} Re-quote with `
        + `${GRADUATED_VENUE[partial.deployment.chainId] ?? "the AMM venue for this chain"}; the curve tools would revert against it.`,
      );
    }
    return fail(`Refused before signing: ${state.reason} Nothing was signed.`);
  }

  const decimals = partial.side === "buy" ? partial.deployment.virtualDecimals : state.tokenDecimals;
  const parsedAmount = parseTradeAmount(partial, decimals);
  if (!parsedAmount.ok) return fail(parsedAmount.reason);
  const params = parsedAmount.params;

  const agentToken: LegToken = {
    address: state.token, symbol: state.tokenSymbol, decimals: state.tokenDecimals,
  };
  const failEvent = {
    deployment: params.deployment,
    walletAddress: wallet,
    sessionId,
    spendToken: params.side === "buy" ? virtualLeg(params) : agentToken,
    receiveToken: params.side === "buy" ? agentToken : virtualLeg(params),
  };

  const quotedOutRaw = await freshQuote(client, params, state);
  if (quotedOutRaw === null) {
    return await failCurveTradePreBroadcast(p, failEvent, {
      code: "route_not_found",
      reason: `FRouterV3 could not price this ${params.side} at block ${state.blockNumber}. Nothing was signed.`,
    });
  }

  const priced = priceCurveTrade({ params, state, quotedOutRaw });
  if (!priced.ok) {
    // The anti-sniper refusal is the one that reaches here in practice, and it
    // is stated with the CURRENT percent and the bound the caller accepted.
    const anti = antiSniperBoundExceededRefusal({
      approvedPct: params.acceptAntiSniperTaxPct,
      currentPct: state.antiSniper[params.side === "buy" ? "rawBuyPct" : "rawSellPct"],
      side: params.side,
      remainingSeconds: state.antiSniper.remainingSeconds,
    });
    return await failCurveTradePreBroadcast(p, failEvent, {
      code: "simulation_reverted",
      reason: `${anti.message} ${anti.hint}`,
    });
  }
  const trade = priced.priced;

  // ── EVERY "YES" ROW OF THE AUTHORITY TABLE, held against the approval ──
  const drift = compareVirtualsExecutionInputs(approved, executionInputsFrom({ params, state, priced: trade }));
  if (drift) {
    return await failCurveTradePreBroadcast(p, failEvent, {
      code: "simulation_reverted",
      reason: `${drift.message} ${drift.hint}`,
    });
  }

  // THE APPROVED FLOOR, written into the calldata below. The fresh read decides
  // only whether the curve can still reach it; a fresh floor is never derived.
  // Re-deriving the floor from a fresher quote is exactly the 2026-08-27
  // incident on a sibling venue (quote 313,879.7, fill 1,190.145, no revert).
  const contractFloorRaw = BigInt(approved.contractFloorRaw);
  if (trade.quotedOutRaw < contractFloorRaw) {
    const refusal = floorUnreachableRefusal({
      snapshot: approved,
      outSymbol: trade.receiveTokenSymbol,
      outHuman: human(trade.quotedOutRaw, trade.receiveTokenDecimals),
      floorHuman: human(contractFloorRaw, trade.receiveTokenDecimals),
    });
    return await failCurveTradePreBroadcast(p, failEvent, {
      code: "slippage",
      reason: `${refusal.message} ${refusal.hint}`,
    });
  }

  // The signing key, resolved only now that every refusal above has passed.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
  if (getAddress(signer.address) !== wallet) {
    return fail("Refused before signing: the signing wallet is not the wallet this proposal was quoted for.");
  }

  const spendToken = params.side === "buy" ? params.deployment.virtual : state.token;
  const spendSymbol = trade.spendTokenSymbol;
  try {
    await ensureErc20Balance(client, {
      token: spendToken,
      owner: wallet,
      // The FULL amount this side spends. On a buy that is the committed VIRTUAL
      // including Vex's fee, because both legs come out of the same asset and a
      // balance that covered only the curve amount would leave the fee to fail
      // after the trade already spent the rest.
      required: trade.totalInRaw,
      decimals: trade.spendTokenDecimals,
      label: spendSymbol,
      chainId: params.deployment.chainId,
      blockTag: "pending",
    });
  } catch (err) {
    return await failCurveTradePreBroadcast(p, failEvent, {
      code: "allowance_or_balance",
      reason: summarizeProtocolError(err).message,
    });
  }

  // ── THE ROWS, before anything is signed ──
  const feePlannedRaw = trade.side === "buy"
    ? trade.feeRaw
    : virtualsCurveSellFeeFromProceeds(trade.walletNetQuotedRaw ?? 0n);
  const plan = planCurveTradeEvents({
    params,
    priced: trade,
    walletAddress: wallet,
    sessionId,
    agentToken,
    pair: state.pair,
    currentAllowanceRaw: state.allowanceRaw,
    contractFloorRaw,
    feePlannedRaw,
  });

  const { executionId, events: createdEvents } = await createAgentActivityIntent({
    toolId: TRADE_TOOL_ID, namespace: PROTOCOL, intentParams: p, events: [...plan.events],
  });
  const tradeEvents = createdEvents.slice(0, plan.tradeLegCount);
  const feeRowId = plan.hasFeeRow ? createdEvents[plan.tradeLegCount]?.id ?? null : null;

  const clients = getVirtualsCurveClients(params.deployment, signer.privateKey as Hex);
  const deadline = curveDeadlineFrom(Date.now());
  let priorLeg: ConfirmedPriorLeg | undefined;

  try {
    for (let i = 0; i < tradeEvents.length; i++) {
      const event = tradeEvents[i]!;
      const tx = buildTxForEvent(event, { params, state, trade, contractFloorRaw, deadline, spendToken });
      const outcome: CurveLegOutcome = await runCurveLeg({
        event, tx, clients, priorLeg, label: describeRole(event.eventRole),
      });

      if (outcome.kind === "ambiguous") {
        const next = createdEvents[i + 1];
        if (next) await abortRemainingCurvePlans(executionId, next.eventIndex, `earlier ${event.eventRole} ambiguous`);
        return {
          success: true,
          output:
            `${TRADE_TOOL_ID}: the ${describeRole(event.eventRole)} was broadcast (tx ${outcome.txHash}) but Vex could not prove `
            + "inclusion this turn. It is tracked automatically and is NEVER re-sent. Nothing after it was signed.",
          data: { txHash: outcome.txHash, _executionId: executionId, status: "pending_unknown", executed: false },
        };
      }
      if (outcome.kind === "failed") {
        const next = createdEvents[i + 1];
        if (next) {
          await abortRemainingCurvePlans(executionId, next.eventIndex, `earlier ${event.eventRole} failed`);
        }
        return {
          success: false,
          output: `${TRADE_TOOL_ID}: the ${describeRole(event.eventRole)} ${outcome.stage === "pre_broadcast" ? "was refused before signing" : "reverted on-chain"} - ${outcome.reason}`,
          data: { _executionId: executionId, ...(outcome.txHash ? { txHash: outcome.txHash } : {}), executed: false },
        };
      }

      priorLeg = priorLegAnchorFrom(outcome.settledAtBlock);
      if (event.eventRole !== "swap") {
        try {
          await confirmActivityEvent(event.id, {});
        } catch (err) {
          // Bookkeeping only - the allowance already confirmed on chain.
          logger.warn("virtuals.trade.execute.confirm_failed", {
            id: event.id, role: event.eventRole, error: summarizeProtocolError(err).message,
          });
        }
        continue;
      }

      return await finalizeConfirmedTrade({
        event, outcome, executionId, params, state, trade, contractFloorRaw,
        wallet, clients, priorLeg, feeRowId, tradeLegCount: plan.tradeLegCount,
      });
    }
    throw new Error(`${TRADE_TOOL_ID}: staged loop exited without a result`);
  } catch (err) {
    logger.warn("virtuals.trade.execute.post_intent_failure", {
      executionId, error: summarizeProtocolError(err).message,
    });
    return {
      success: false,
      output: `${TRADE_TOOL_ID} failed after the execution was recorded: ${summarizeProtocolError(err).message}`,
      data: { _executionId: executionId, executed: false },
    };
  }
}

function virtualLeg(params: TradeParams): LegToken {
  return {
    address: params.deployment.virtual,
    symbol: "VIRTUAL",
    decimals: params.deployment.virtualDecimals,
  };
}

function describeRole(role: AgentActivityEvent["eventRole"]): string {
  if (role === "allowance_reset") return "allowance-reset transaction";
  if (role === "allowance") return "approval transaction";
  return "curve trade";
}

/** The router's answer at the freshly pinned block, for the side being executed. */
async function freshQuote(
  client: ReturnType<typeof getVirtualsCurvePublicClient>,
  params: TradeParams,
  state: CurveState,
): Promise<bigint | null> {
  const amountRaw = params.side === "buy" ? buyTaxedInFor(params, state) : params.amountInRaw;
  if (amountRaw <= 0n) return null;
  const quoted = await readCurveQuote({
    client, deployment: params.deployment, token: state.token, side: params.side,
    amountRaw, blockNumber: state.blockNumber,
  });
  return quoted === null || quoted <= 0n ? null : quoted;
}

function buildTxForEvent(
  event: AgentActivityEvent,
  ctx: {
    readonly params: TradeParams;
    readonly state: CurveState;
    readonly trade: PricedCurveTrade;
    readonly contractFloorRaw: bigint;
    readonly deadline: bigint;
    readonly spendToken: Address;
  },
): BuiltCurveTx {
  if (event.eventRole === "allowance_reset") {
    return buildCurveApproveTx({ deployment: ctx.params.deployment, spendToken: ctx.spendToken, amountRaw: 0n });
  }
  if (event.eventRole === "allowance") {
    return buildCurveApproveTx({
      deployment: ctx.params.deployment, spendToken: ctx.spendToken, amountRaw: ctx.trade.curveAmountRaw,
    });
  }
  return ctx.trade.side === "buy"
    ? buildCurveBuyTx({
        deployment: ctx.params.deployment,
        token: ctx.state.token,
        curveAmountRaw: ctx.trade.curveAmountRaw,
        contractMinOutRaw: ctx.contractFloorRaw,
        deadlineSeconds: ctx.deadline,
      })
    : buildCurveSellTx({
        deployment: ctx.params.deployment,
        token: ctx.state.token,
        amountInRaw: ctx.trade.curveAmountRaw,
        contractGrossMinRaw: ctx.contractFloorRaw,
        deadlineSeconds: ctx.deadline,
      });
}

/**
 * The trade CONFIRMED. Decode what it actually moved, record it, then - and only
 * then - take the fee.
 *
 * NOTHING in here may turn a confirmed trade into a failure. The trade settled;
 * a decoder throw or a bookkeeping write that did not land is reported through
 * `status`, never through `success`.
 */
async function finalizeConfirmedTrade(x: {
  readonly event: AgentActivityEvent;
  readonly outcome: Extract<CurveLegOutcome, { kind: "confirmed" }>;
  readonly executionId: number;
  readonly params: TradeParams;
  readonly state: CurveState;
  readonly trade: PricedCurveTrade;
  readonly contractFloorRaw: bigint;
  readonly wallet: Address;
  readonly clients: ReturnType<typeof getVirtualsCurveClients>;
  readonly priorLeg: ConfirmedPriorLeg | undefined;
  readonly feeRowId: number | null;
  readonly tradeLegCount: number;
}): Promise<ToolResult> {
  const { params, state, trade, outcome } = x;
  const spendTokenAddress = trade.side === "buy" ? params.deployment.virtual : state.token;
  const receiveTokenAddress = trade.side === "buy" ? state.token : params.deployment.virtual;

  let settlement: ReturnType<typeof decodeCurveSettlement>;
  try {
    settlement = decodeCurveSettlement({
      logs: outcome.receipt.logs,
      wallet: x.wallet,
      spendToken: spendTokenAddress,
      receiveToken: receiveTokenAddress,
    });
  } catch (err) {
    logger.warn("virtuals.trade.execute.settlement_decode_threw", {
      id: x.event.id, txHash: outcome.txHash, error: summarizeProtocolError(err).message,
    });
    settlement = { executedInRaw: 0n, executedOutRaw: 0n, decoded: false, undecodedReason: "no_transfers" };
  }

  let status: "confirmed" | "confirmed_unrecorded" | "confirmed_pending_amounts" = "confirmed_pending_amounts";
  if (settlement.decoded) {
    try {
      const applied = await confirmActivityEvent(x.event.id, {
        executedAmountInRaw: settlement.executedInRaw.toString(),
        executedAmountInHuman: formatUnits(settlement.executedInRaw, trade.spendTokenDecimals),
        executedAmountOutRaw: settlement.executedOutRaw.toString(),
        executedAmountOutHuman: formatUnits(settlement.executedOutRaw, trade.receiveTokenDecimals),
      });
      status = applied.applied ? "confirmed" : "confirmed_unrecorded";
    } catch (err) {
      logger.warn("virtuals.trade.execute.confirm_failed", {
        id: x.event.id, error: summarizeProtocolError(err).message,
      });
      status = "confirmed_unrecorded";
    }
  }

  // THE SETTLEMENT DISCREPANCY CHECK, on the sell side only. `walletNetMin` is
  // an estimate the contract never enforced, so a receipt below it is reported
  // as a discrepancy - never as a failure, and never as a bound that held.
  const shortfall = trade.walletNetMinRaw !== null
    && settlement.decoded
    && settlement.executedOutRaw < trade.walletNetMinRaw
    ? {
        walletNetMin: human(trade.walletNetMinRaw, trade.receiveTokenDecimals),
        received: human(settlement.executedOutRaw, trade.receiveTokenDecimals),
        note:
          "The VIRTUAL that reached the wallet is below the estimate this proposal showed. The contract enforced only "
          + "the gross floor, which held; the difference is the curve's own tax applied to a realised gross lower than "
          + "the quoted one. Reported as a settlement discrepancy, not as a failed trade.",
      }
    : null;
  if (shortfall !== null) {
    logger.warn("virtuals.trade.execute.wallet_net_below_estimate", {
      id: x.event.id, txHash: outcome.txHash,
    });
  }

  // ── The fee leg, LAST, and only now that the trade is CONFIRMED ──
  const proceedsRaw = trade.side === "sell" && settlement.decoded ? settlement.executedOutRaw : null;
  const fee: CurveFeeCollection = await runCurveFeeLeg({
    side: trade.side,
    deployment: params.deployment,
    feeRowId: x.feeRowId,
    executionId: x.executionId,
    tradeLegCount: x.tradeLegCount,
    buyFeeRaw: trade.side === "buy" ? trade.feeRaw : null,
    provenProceedsRaw: proceedsRaw,
    clients: x.clients,
    priorLeg: x.priorLeg,
  });

  const payload = {
    executed: true,
    txHash: outcome.txHash,
    chain: params.deployment.key,
    chainId: params.deployment.chainId,
    venue: VIRTUALS_CURVE_VENUE,
    side: trade.side,
    token: state.token,
    symbol: state.tokenSymbol,
    status,
    settlement: settlement.decoded
      ? {
          spentRaw: settlement.executedInRaw.toString(),
          spent: human(settlement.executedInRaw, trade.spendTokenDecimals),
          spentSymbol: trade.spendTokenSymbol,
          receivedRaw: settlement.executedOutRaw.toString(),
          received: human(settlement.executedOutRaw, trade.receiveTokenDecimals),
          receivedSymbol: trade.receiveTokenSymbol,
        }
      : {
          decoded: false,
          reason: settlement.undecodedReason ?? "no_transfers",
          note:
            "The trade confirmed on chain but its ERC-20 transfers could not be read from the receipt. The exact "
            + "amounts are on the transaction; the record finalizes automatically.",
        },
    enforcedFloor: {
      contractFloorRaw: x.contractFloorRaw.toString(),
      contractFloor: human(x.contractFloorRaw, trade.receiveTokenDecimals),
      symbol: trade.receiveTokenSymbol,
    },
    ...(shortfall === null ? {} : { settlementDiscrepancy: shortfall }),
    vexFee: fee,
  };

  return {
    success: true,
    output: JSON.stringify(payload, null, 2),
    data: { ...payload, _executionId: x.executionId },
  };
}

/**
 * The no-signing mode: re-read, re-price, build the exact transactions, and ask
 * the node whether they would succeed from this wallet.
 *
 * NO KEY, NO ROW, NO CLAIM, NO BROADCAST. It is the coordinator's and the
 * reviewer's way to exercise the whole chain of reasoning on a real chain, and
 * the answer is deliberately shaped like the quote's preview plus the requests,
 * so what was inspected is what would run.
 */
async function simulateCurveTrade(x: {
  readonly p: Record<string, unknown>;
  readonly partial: PartialTradeParams;
  readonly client: ReturnType<typeof getVirtualsCurvePublicClient>;
  readonly wallet: Address;
  readonly context: ProtocolExecutionContext;
}): Promise<ToolResult> {
  const { client, wallet } = x;
  let state: Awaited<ReturnType<typeof readCurveState>>;
  try {
    state = await readCurveState({
      client, deployment: x.partial.deployment, token: x.partial.token, side: x.partial.side, wallet,
    });
  } catch (err) {
    return fail(`Virtuals curve state unavailable (${summarizeProtocolError(err).message}).`);
  }
  if (!state.ok) return fail(state.reason);

  const decimals = x.partial.side === "buy" ? x.partial.deployment.virtualDecimals : state.tokenDecimals;
  const parsed = parseTradeAmount(x.partial, decimals);
  if (!parsed.ok) return fail(parsed.reason);
  const params = parsed.params;

  const quotedOutRaw = await freshQuote(client, params, state);
  if (quotedOutRaw === null) {
    return fail(`FRouterV3 could not price this ${params.side} at block ${state.blockNumber}.`);
  }
  const priced = priceCurveTrade({ params, state, quotedOutRaw });
  if (!priced.ok) return fail(priced.hint === undefined ? priced.reason : `${priced.reason} ${priced.hint}`);
  const trade = priced.priced;

  const contractFloorRaw = trade.contractFloorRaw;
  const deadline = curveDeadlineFrom(Date.now());
  const spendToken = params.side === "buy" ? params.deployment.virtual : state.token;
  const allowanceLegNeeded = state.allowanceRaw < trade.curveAmountRaw;

  const requests: { readonly role: string; readonly tx: BuiltCurveTx }[] = [];
  if (allowanceLegNeeded && state.allowanceRaw > 0n) {
    requests.push({
      role: "allowance_reset",
      tx: buildCurveApproveTx({ deployment: params.deployment, spendToken, amountRaw: 0n }),
    });
  }
  if (allowanceLegNeeded) {
    requests.push({
      role: "allowance",
      tx: buildCurveApproveTx({ deployment: params.deployment, spendToken, amountRaw: trade.curveAmountRaw }),
    });
  }
  requests.push({
    role: "swap",
    tx: trade.side === "buy"
      ? buildCurveBuyTx({
          deployment: params.deployment, token: state.token, curveAmountRaw: trade.curveAmountRaw,
          contractMinOutRaw: contractFloorRaw, deadlineSeconds: deadline,
        })
      : buildCurveSellTx({
          deployment: params.deployment, token: state.token, amountInRaw: trade.curveAmountRaw,
          contractGrossMinRaw: contractFloorRaw, deadlineSeconds: deadline,
        }),
  });

  // `eth_call` from the wallet ADDRESS. A trade leg whose allowance leg has not
  // run yet will revert here, and that is the honest answer rather than a hidden
  // pass: the reply says which leg was simulated against which allowance state.
  const simulations = [] as {
    role: string; to: string; data: string; value: string; ok: boolean; revertReason?: string;
  }[];
  for (const request of requests) {
    let succeeded = true;
    let revertReason: string | undefined;
    try {
      await client.call({ account: wallet, to: request.tx.to, data: request.tx.data, value: request.tx.value });
    } catch (err) {
      succeeded = false;
      revertReason = summarizeProtocolError(err).message;
    }
    simulations.push({
      role: request.role,
      to: request.tx.to,
      data: request.tx.data,
      value: request.tx.value.toString(),
      ok: succeeded,
      ...(revertReason === undefined ? {} : { revertReason }),
    });
  }

  const preview = buildTradePreview({
    params, state, priced: trade,
    // Both null: a simulation seals no snapshot, so it authorizes nothing and
    // there is nothing for it to expire.
    proposalId: null,
    expiresAt: null,
    allowanceLegNeeded,
  });

  return ok({
    ...preview,
    executed: false,
    simulateOnly: true,
    simulateNote:
      "No signer was opened, no quote was consumed, no activity row was written and nothing was broadcast. The "
      + "transactions below are exactly what the signing path would carry, each eth_call'd from the session wallet "
      + `address at block ${state.blockNumber}. A leg that depends on an allowance the wallet does not yet hold `
      + "reverts here by construction, and that is reported rather than hidden.",
    wouldSend: simulations,
    deadlineSeconds: deadline.toString(),
  });
}
