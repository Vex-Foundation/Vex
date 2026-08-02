/**
 * Planning the Vex fee leg for a Trench Express action.
 *
 * Produces the ready-to-sign native transfer, the `agent_activity` row it will
 * be recorded under, and the agent-facing disclosure — as ONE object, so a
 * caller cannot sign a leg it did not disclose or record.
 *
 * `null` means NO FEE AT ALL: the 25 bps floored to zero at this size. There is
 * then no leg, no row, and no index in the intent — a zero-value transfer would
 * burn gas, add a meaningless row, and move nothing. Callers must plan the
 * skipped disclosure (`buildTrenchFeeSkippedDisclosure`) rather than a zero one.
 *
 * The fee row is planned as the LAST event of the execution and driven OUTSIDE
 * whatever loop runs the action's own legs — see `run.ts` for why the ordering
 * is the safety property.
 */

import { formatEther, type Address, type Hex } from "viem";

import {
  TRENCH_FEE_ACTIVITY_EVENT_ROLE,
  buildTrenchFeeDisclosure,
  buildTrenchFeeTransfer,
  splitTrenchEthForFee,
  trenchFeeBaseWei,
  type TrenchFeeBaseInput,
  type TrenchFeeDisclosure,
} from "@tools/trench-express/fee/index.js";
import type { CreatePendingActivityEventInput } from "@vex-agent/db/repos/agent-activity.js";

const ETH_DECIMALS = 18;
const PROTOCOL = "trench";
const CHAIN_SLUG = "robinhood";
const NATIVE_LABEL = "ETH";
/** A plain value transfer carries no calldata. */
const EMPTY_CALLDATA = "0x" as Hex;

/** The parent execution's kind — the arm of the kind↔role CHECK the fee row lands on. */
export type TrenchFeeParentKind = "swap" | "launch";

export interface PlanTrenchFeeLegInput {
  /** Which ETH leg the fee is charged on, and its amount. */
  readonly base: TrenchFeeBaseInput;
  readonly parentKind: TrenchFeeParentKind;
  readonly chainId: number;
  /** The shared native sentinel — the fee row's identity token. */
  readonly nativeAddress: Address;
  readonly walletAddress: Address;
  readonly sessionId: string;
  /** Nullable ESTIMATE, stamped on the fee row ONLY. Omit rather than guess. */
  readonly usdVexFeeEst?: string | undefined;
}

export interface TrenchFeeLegPlan {
  /** Exact, in wei. What the treasury transfer sends. */
  readonly feeWei: bigint;
  /**
   * `base − fee`. Load-bearing on a BUY (the curve is quoted for it); on a sell
   * or a launch nothing consumes it, because the fee does not reduce the
   * principal there.
   */
  readonly netWei: bigint;
  /**
   * Native value transfer. `data` is the EMPTY calldata `0x` — the staged
   * broadcaster requires the field, and empty is what makes this a plain
   * transfer rather than a contract call.
   */
  readonly txParams: { readonly to: Address; readonly data: Hex; readonly value: bigint };
  readonly event: Omit<CreatePendingActivityEventInput, "protocolExecutionId" | "eventIndex">;
  readonly disclosure: TrenchFeeDisclosure;
}

/**
 * Plan the fee leg, or `null` when the fee floors to zero. Throws only on a
 * non-positive base, which is a programming error rather than a market
 * condition (`splitTrenchEthForFee` refuses it by name).
 */
export function planTrenchFeeLeg(input: PlanTrenchFeeLegInput): TrenchFeeLegPlan | null {
  const baseWei = trenchFeeBaseWei(input.base);
  const split = splitTrenchEthForFee(baseWei);
  if (!split.charged) return null;

  const transfer = buildTrenchFeeTransfer(split.feeRaw);
  const feeHuman = formatEther(split.feeRaw);
  return {
    feeWei: split.feeRaw,
    netWei: split.netRaw,
    txParams: { to: transfer.to, data: EMPTY_CALLDATA, value: transfer.value },
    event: {
      eventRole: TRENCH_FEE_ACTIVITY_EVENT_ROLE,
      kind: input.parentKind,
      protocol: PROTOCOL,
      chainId: input.chainId,
      chainSlug: CHAIN_SLUG,
      walletAddress: input.walletAddress,
      sessionId: input.sessionId,
      // The fee IS this row: it lives in `tokenIn`/`amountIn`, exactly as a
      // `bridge_fee` row does. The `vexFee` (`AgentActivityVexFeeCharge`) fields
      // are deliberately NOT set — those are for venues that take the fee inside
      // the transaction being recorded, and setting both stores the same money
      // twice.
      tokenIn: {
        tokenAddress: input.nativeAddress,
        tokenSymbol: NATIVE_LABEL,
        tokenDecimals: ETH_DECIMALS,
        amountHuman: feeHuman,
        amountRaw: split.feeRaw.toString(),
      },
      ...(input.usdVexFeeEst === undefined ? {} : { usdVexFeeEst: input.usdVexFeeEst }),
      routeProvenance: { feeBasis: input.base.basis, feeBaseWei: baseWei.toString() },
    },
    disclosure: buildTrenchFeeDisclosure({
      basis: input.base.basis,
      baseWei,
      feeWei: split.feeRaw,
      netWei: split.netRaw,
      feeUsdEstimate: input.usdVexFeeEst,
    }),
  };
}
