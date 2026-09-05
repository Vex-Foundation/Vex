/**
 * The `agent_activity` rows a curve trade writes, and the order they are written
 * in.
 *
 * ONE EXECUTION, up to four rows, and the order is a safety property:
 *
 *   0. `allowance_reset` - only when a non-zero allowance is short and must be
 *      zeroed first (the USDT-style rule every EVM venue here follows).
 *   1. `allowance`        - only when the current allowance is short. EXACT
 *      amount, spender FRouterV3, its own transaction and its own row.
 *   2. `swap`             - the curve trade itself, `kind = 'swap'`, venue
 *      `virtuals-curve`.
 *   3. `vex_fee`          - LAST, planned before anything is broadcast and
 *      signed only after the trade CONFIRMS.
 *
 * WHY THE FEE ROW EXISTS BEFORE THE BROADCAST. A leg that is signed but never
 * recorded is a transfer with no audit row; a leg that is recorded but never
 * signed is finalized as never-attempted. The intent therefore carries every row
 * it might sign, and the ones that never run are terminalized explicitly.
 *
 * WHY THE FEE ROW IS A CHILD AND NOT A SECOND ENTRY. `vex_fee` (migration 102)
 * on the `swap` arm is what the fold read model looks for: the feed shows ONE
 * entry for the trade with the fee folded under it, and the fee's own
 * pending/failed status is visible there rather than as a separate line
 * (owner V1/V2).
 */

import { formatUnits, type Address } from "viem";

import {
  VIRTUALS_CURVE_FEE_ACTIVITY_EVENT_ROLE,
  type VirtualsCurveDeployment,
} from "@tools/virtuals/curve/index.js";
import {
  abortPlannedEvents,
  createAgentActivityPreBroadcastFailure,
  type AgentActivityFailureCode,
  type CreatePendingActivityEventInput,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../../types.js";
import { summarizeProtocolError } from "../../../runtime/errors.js";
import { PROTOCOL, TRADE_TOOL_ID } from "./tool-ids.js";
import type { PricedCurveTrade } from "./pricing.js";
import type { TradeParams } from "./params.js";

export type PlannedEvent = Omit<CreatePendingActivityEventInput, "protocolExecutionId">;

/** The venue name every Virtuals curve row is filed under. */
export const VIRTUALS_CURVE_VENUE = "virtuals-curve";

export interface LegToken {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

function leg(token: LegToken, amountRaw?: bigint): NonNullable<PlannedEvent["tokenIn"]> {
  return {
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
    ...(amountRaw === undefined
      ? {}
      : { amountRaw: amountRaw.toString(), amountHuman: formatUnits(amountRaw, token.decimals) }),
  };
}

export interface CurveTradePlan {
  readonly events: readonly PlannedEvent[];
  /** How many of the planned events are the trade's OWN legs (fee excluded). */
  readonly tradeLegCount: number;
  /** True when a fee row was planned at index `tradeLegCount`. */
  readonly hasFeeRow: boolean;
}

/**
 * Plan every row this execution may write.
 *
 * `feePlannedRaw` is the amount the fee row is CREATED with. On a buy it is the
 * exact fee; on a sell it is the quote-time ESTIMATE, replaced by the proven
 * figure when the row is confirmed - the ordinary planned-versus-executed
 * distinction the schema already carries. A sell with no estimate at all plans
 * no fee row, because there would be nothing to charge.
 */
export function planCurveTradeEvents(input: {
  readonly params: TradeParams;
  readonly priced: PricedCurveTrade;
  readonly walletAddress: string;
  readonly sessionId: string;
  readonly agentToken: LegToken;
  readonly pair: string;
  readonly currentAllowanceRaw: bigint;
  /** The floor written into the calldata, duplicated onto the trade row. */
  readonly contractFloorRaw: bigint;
  readonly feePlannedRaw: bigint | null;
}): CurveTradePlan {
  const { params, priced, agentToken } = input;
  const d = params.deployment;
  const virtualToken: LegToken = { address: d.virtual, symbol: "VIRTUAL", decimals: d.virtualDecimals };
  const spendToken = priced.side === "buy" ? virtualToken : agentToken;
  const receiveToken = priced.side === "buy" ? agentToken : virtualToken;

  const common = {
    kind: "swap",
    protocol: PROTOCOL,
    chainId: d.chainId,
    chainSlug: d.key,
    walletAddress: input.walletAddress,
    sessionId: input.sessionId,
  } as const;

  const events: PlannedEvent[] = [];
  let eventIndex = 0;

  const needsAllowance = input.currentAllowanceRaw < priced.curveAmountRaw;
  const needsReset = needsAllowance && input.currentAllowanceRaw > 0n;
  if (needsReset) {
    events.push({ eventIndex: eventIndex++, eventRole: "allowance_reset", ...common, tokenIn: leg(spendToken) });
  }
  if (needsAllowance) {
    events.push({
      eventIndex: eventIndex++,
      eventRole: "allowance",
      ...common,
      tokenIn: leg(spendToken, priced.curveAmountRaw),
    });
  }

  events.push({
    eventIndex: eventIndex++,
    eventRole: "swap",
    ...common,
    tokenIn: leg(spendToken, priced.curveAmountRaw),
    tokenOut: leg(receiveToken, priced.quotedOutRaw),
    routeProvenance: {
      venue: VIRTUALS_CURVE_VENUE,
      side: priced.side,
      pair: input.pair,
      bondingV5: d.bondingV5,
      frouterV3: d.frouterV3,
      // The floor actually written into the calldata, non-attested, so a
      // post-crash settlement sweep can assess the fill against what was
      // authorized without re-reading the prequote.
      contractFloorRaw: input.contractFloorRaw.toString(),
      protocolTaxPct: priced.protocolTaxPct,
      antiSniperPct: priced.antiSniper.effectivePct,
      // NO `settlementDecode` HINT, and the absence is deliberate. The hint is
      // a discriminated union of decoders the sync-side repair sweep can
      // dispatch (`agent-activity/settlement-decode.ts`), and no
      // `virtuals_curve` decoder exists there yet: writing one would name a
      // decoder the repair lane cannot run. An absent hint is a supported
      // state - the reader falls back to the row's own columns - and this
      // handler decodes its own receipt inline while it still owns the
      // execution. Declared gap: the sweep-side decoder is its own change.
    },
  });

  const tradeLegCount = events.length;
  const hasFeeRow = input.feePlannedRaw !== null && input.feePlannedRaw > 0n;
  if (hasFeeRow) {
    events.push({
      eventIndex: eventIndex++,
      eventRole: VIRTUALS_CURVE_FEE_ACTIVITY_EVENT_ROLE,
      ...common,
      // The fee IS this row: it lives in `tokenIn`/`amountIn`, exactly as the
      // sibling venues' fee rows do. The `vexFee` columns are deliberately NOT
      // set - those are for venues that take the fee inside the transaction
      // being recorded, and setting both stores the same money twice.
      tokenIn: leg(virtualToken, input.feePlannedRaw ?? 0n),
    });
  }

  return { events, tradeLegCount, hasFeeRow };
}

/**
 * A validation or pre-sign failure before anything could be signed - a hashless
 * `definitively_failed` row.
 *
 * NEVER called once the intent already exists: a second intent for one execute
 * would file two executions for one user action.
 */
export async function failCurveTradePreBroadcast(
  p: Record<string, unknown>,
  event: {
    readonly deployment: VirtualsCurveDeployment;
    readonly walletAddress: string;
    readonly sessionId: string;
    readonly spendToken?: LegToken;
    readonly receiveToken?: LegToken;
  },
  failure: { readonly code: AgentActivityFailureCode; readonly reason: string },
): Promise<ToolResult> {
  const { executionId } = await createAgentActivityPreBroadcastFailure({
    toolId: TRADE_TOOL_ID,
    namespace: PROTOCOL,
    intentParams: p,
    event: {
      eventIndex: 0,
      eventRole: "swap",
      kind: "swap",
      protocol: PROTOCOL,
      chainId: event.deployment.chainId,
      chainSlug: event.deployment.key,
      walletAddress: event.walletAddress,
      sessionId: event.sessionId,
      ...(event.spendToken ? { tokenIn: leg(event.spendToken) } : {}),
      ...(event.receiveToken ? { tokenOut: leg(event.receiveToken) } : {}),
      failureCode: failure.code,
      failureReason: failure.reason,
    },
  });
  return {
    success: false,
    output: `${TRADE_TOOL_ID} failed: ${failure.reason}`,
    data: { _executionId: executionId },
  };
}

/**
 * Finalize every planned event from `fromIndex` onward that was NEVER signed.
 *
 * Best-effort: a throw here is logged, never propagated. The caller has already
 * decided its own return value and must not flip to a misleading result because
 * this bookkeeping call failed. Returns whether the cleanup actually applied, so
 * a caller reporting on an ALREADY-CONFIRMED leg can disclose the gap instead of
 * implying the audit rows were finalized.
 */
export async function abortRemainingCurvePlans(
  executionId: number,
  fromIndex: number,
  reason: string,
): Promise<boolean> {
  try {
    await abortPlannedEvents(executionId, fromIndex, reason);
    return true;
  } catch (err) {
    logger.warn("virtuals.trade.execute.abort_planned_events_failed", {
      executionId,
      fromIndex,
      error: summarizeProtocolError(err).message,
    });
    return false;
  }
}
