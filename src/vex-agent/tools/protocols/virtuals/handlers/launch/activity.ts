/**
 * The `agent_activity` rows a Virtuals launch writes, and the order they are
 * written in.
 *
 * ONE EXECUTION, up to four rows, and the order is a safety property:
 *
 *   0. `allowance_reset` - only when a non-zero allowance is short and must be
 *      zeroed first (the USDT-style rule every EVM venue here follows).
 *   1. `allowance`       - only when the current allowance is short. EXACT
 *      amount, spender BondingV5 (NOT FRouterV3), its own transaction and its
 *      own row.
 *   2. `token_launch`    - the `preLaunch` itself, `kind = 'launch'`, venue
 *      `virtuals-bonding`.
 *   3. `vex_fee`         - LAST, planned before anything is broadcast and
 *      signed only after the KEEPER's launch has been OBSERVED.
 *
 * ## Why the fee row exists before the broadcast, and why it may never be signed
 *
 * A leg that is signed but never recorded is a transfer with no audit row; a
 * leg that is recorded but never signed is finalized as never-attempted. So the
 * intent carries every row it might sign, and the ones that never run are
 * terminalized explicitly.
 *
 * On this lane the fee row not running is a NORMAL outcome rather than an
 * exception, and that is owner F3. The fee is collectible only while the
 * handler still owns the approved signer AND the keeper's `Launched` has been
 * observed; a bounded wait that elapses first waives it permanently. The row is
 * then aborted with that reason, which is why the abort text says "waived"
 * rather than "failed": a reader of the feed must not see a fee Vex chose not
 * to take as a fee that went wrong.
 *
 * ## The cancel is its own execution
 *
 * `launch_cancel` (migration 107) rides the `launch` kind and is written by
 * `virtuals.launch.cancel` as a SEPARATE execution, not as a fifth row on the
 * launch's. The two are different user actions minutes or hours apart, and
 * folding the second into the first would make one feed entry claim both
 * happened at once.
 */

import { formatUnits, type Address } from "viem";

import { VIRTUALS_LAUNCH_FEE_ACTIVITY_EVENT_ROLE } from "@tools/virtuals/launch/index.js";
import type { VirtualsCurveDeployment } from "@tools/virtuals/curve/index.js";
import {
  abortPlannedEvents,
  createAgentActivityPreBroadcastFailure,
  type AgentActivityFailureCode,
  type CreatePendingActivityEventInput,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../../types.js";
import { summarizeProtocolError } from "../../../runtime/errors.js";
import { PROTOCOL, VIRTUALS_LAUNCH_VENUE } from "./tool-ids.js";
import type { LaunchPlan } from "./plan.js";

export type PlannedEvent = Omit<CreatePendingActivityEventInput, "protocolExecutionId">;

export interface LaunchLegToken {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

function leg(token: LaunchLegToken, amountRaw?: bigint): NonNullable<PlannedEvent["tokenIn"]> {
  return {
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
    ...(amountRaw === undefined
      ? {}
      : { amountRaw: amountRaw.toString(), amountHuman: formatUnits(amountRaw, token.decimals) }),
  };
}

/** VIRTUAL, as an activity leg token. The only asset a launch spends. */
export function virtualLeg(deployment: VirtualsCurveDeployment): LaunchLegToken {
  return { address: deployment.virtual, symbol: "VIRTUAL", decimals: deployment.virtualDecimals };
}

export interface LaunchActivityPlan {
  readonly events: readonly PlannedEvent[];
  /** How many planned events are the launch's OWN legs (fee excluded). */
  readonly launchLegCount: number;
  /** True when a fee row was planned at index `launchLegCount`. */
  readonly hasFeeRow: boolean;
}

/**
 * Plan every row this launch may write.
 *
 * The `token_launch` row carries NO `tokenOut`, deliberately. At planning time
 * the agent token does not exist yet - its address is created inside the
 * transaction and only the receipt names it - and a planned output leg with an
 * invented address would be worse than none. The confirm path fills the
 * identity in from the decoded `PreLaunched` event.
 */
export function planLaunchEvents(input: {
  readonly plan: LaunchPlan;
  readonly walletAddress: string;
  readonly sessionId: string;
  readonly intentId: string;
}): LaunchActivityPlan {
  const { plan } = input;
  const d = plan.deployment;
  const virtual = virtualLeg(d);

  const common = {
    kind: "launch",
    protocol: PROTOCOL,
    chainId: d.chainId,
    chainSlug: d.key,
    walletAddress: input.walletAddress,
    sessionId: input.sessionId,
  } as const;

  const events: PlannedEvent[] = [];
  let eventIndex = 0;

  if (plan.allowanceResetNeeded) {
    events.push({ eventIndex: eventIndex++, eventRole: "allowance_reset", ...common, tokenIn: leg(virtual) });
  }
  if (plan.allowanceLegNeeded) {
    events.push({
      eventIndex: eventIndex++,
      eventRole: "allowance",
      ...common,
      tokenIn: leg(virtual, plan.fee.launchAmountRaw),
    });
  }

  events.push({
    eventIndex: eventIndex++,
    eventRole: "token_launch",
    ...common,
    tokenIn: leg(virtual, plan.fee.launchAmountRaw),
    routeProvenance: {
      venue: VIRTUALS_LAUNCH_VENUE,
      intentId: input.intentId,
      bondingV5: d.bondingV5,
      bondingConfig: plan.state.bondingConfig,
      // The exact bytes a person approved, so a post-crash sweep can assess
      // what was authorized without re-reading anything.
      calldataFingerprint: plan.fingerprint,
      onChainName: plan.onChainName,
      antiSniperTaxType: plan.args.antiSniperTaxType,
      protocolLaunchFeeRaw: plan.state.protocolLaunchFeeRaw.toString(),
      imageUrl: plan.image.url,
      // NO `settlementDecode` HINT, and the absence is deliberate - the same
      // declared gap the curve trade lane records. The hint names a decoder the
      // sync-side repair sweep can dispatch, and no `virtuals_launch` decoder
      // exists there; writing one would name a decoder that lane cannot run.
      // This handler decodes its own receipt inline while it still owns the
      // execution, and the keeper sweep reads the intent rather than this row.
    },
  });

  const launchLegCount = events.length;
  const feeRaw = plan.fee.feeRaw;
  const hasFeeRow = feeRaw !== null && feeRaw > 0n;
  if (hasFeeRow && feeRaw !== null) {
    events.push({
      eventIndex: eventIndex++,
      eventRole: VIRTUALS_LAUNCH_FEE_ACTIVITY_EVENT_ROLE,
      ...common,
      // The fee IS this row: it lives in `tokenIn`/`amountIn`, exactly as the
      // sibling venues' fee rows do. The `vexFee` columns are deliberately NOT
      // set - those are for venues that take the fee inside the transaction
      // being recorded, and setting both stores the same money twice.
      tokenIn: leg(virtual, feeRaw),
    });
  }

  return { events, launchLegCount, hasFeeRow };
}

/** The one row a cancel writes: the refund the contract sent back. */
export function planCancelEvent(input: {
  readonly deployment: VirtualsCurveDeployment;
  readonly walletAddress: string;
  readonly sessionId: string;
  readonly tokenAddress: string;
  readonly expectedRefundRaw: bigint;
}): PlannedEvent {
  return {
    eventIndex: 0,
    eventRole: "launch_cancel",
    kind: "launch",
    protocol: PROTOCOL,
    chainId: input.deployment.chainId,
    chainSlug: input.deployment.key,
    walletAddress: input.walletAddress,
    sessionId: input.sessionId,
    // The refund is the OUTPUT of a cancel: VIRTUAL comes back to the wallet.
    // Planned at the amount the contract's own `initialPurchase` says it owes,
    // and confirmed from the receipt's `CancelledLaunch` event.
    tokenOut: leg(virtualLeg(input.deployment), input.expectedRefundRaw),
    routeProvenance: {
      venue: VIRTUALS_LAUNCH_VENUE,
      bondingV5: input.deployment.bondingV5,
      token: input.tokenAddress,
    },
  };
}

/**
 * A validation or pre-sign failure before anything could be signed - a hashless
 * `definitively_failed` row.
 *
 * NEVER called once the intent already exists: a second intent for one execute
 * would file two executions for one user action.
 */
export async function failLaunchPreBroadcast(
  toolId: string,
  p: Record<string, unknown>,
  event: {
    readonly deployment: VirtualsCurveDeployment;
    readonly walletAddress: string;
    readonly sessionId: string;
    readonly eventRole: "token_launch" | "launch_cancel";
  },
  failure: { readonly code: AgentActivityFailureCode; readonly reason: string },
): Promise<ToolResult> {
  const { executionId } = await createAgentActivityPreBroadcastFailure({
    toolId,
    namespace: PROTOCOL,
    intentParams: p,
    event: {
      eventIndex: 0,
      eventRole: event.eventRole,
      kind: "launch",
      protocol: PROTOCOL,
      chainId: event.deployment.chainId,
      chainSlug: event.deployment.key,
      walletAddress: event.walletAddress,
      sessionId: event.sessionId,
      tokenIn: leg(virtualLeg(event.deployment)),
      failureCode: failure.code,
      failureReason: failure.reason,
    },
  });
  return {
    success: false,
    output: `${toolId} failed: ${failure.reason}`,
    data: { _executionId: executionId, executed: false },
  };
}

/**
 * Finalize every planned event from `fromIndex` onward that was NEVER signed.
 *
 * Best-effort by contract: a throw here is logged, never propagated. The caller
 * has already decided its own return value - often about a launch that
 * SUCCEEDED - and must not flip to a misleading result because bookkeeping
 * failed. Returns whether the cleanup actually applied, so a caller reporting
 * on a confirmed launch can disclose the gap instead of implying the audit rows
 * were finalized.
 */
export async function abortRemainingLaunchPlans(
  executionId: number,
  fromIndex: number,
  reason: string,
): Promise<boolean> {
  try {
    await abortPlannedEvents(executionId, fromIndex, reason);
    return true;
  } catch (err) {
    logger.warn("virtuals.launch.abort_planned_events_failed", {
      executionId,
      fromIndex,
      error: summarizeProtocolError(err).message,
    });
    return false;
  }
}
