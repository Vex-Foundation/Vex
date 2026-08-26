/**
 * Planning a native Vex fee leg - shared by every venue on this lane.
 *
 * Produces the ready-to-sign native transfer, the `agent_activity` row it will
 * be recorded under, and the agent-facing disclosure - as ONE object, so a
 * caller cannot sign a leg it did not disclose or record.
 *
 * `null` means NO FEE AT ALL: the rate floored to zero at this size. There is
 * then no leg, no row, and no index in the intent - a zero-value transfer would
 * burn gas, add a meaningless row, and move nothing. Callers must plan the
 * skipped disclosure rather than a zero one.
 *
 * The fee row is planned as the LAST event of the execution and driven OUTSIDE
 * whatever loop runs the action's own legs - see `run.ts` for why the ordering
 * is the safety property.
 */

import { formatUnits, type Address, type Hex } from "viem";

import {
  buildNativeFeeDisclosure,
  buildNativeFeeTransfer,
  type NativeFeeDisclosure,
  type NativeFeeVenue,
} from "@tools/vex-fee/native-leg/index.js";
import { splitAmountForFeeBps } from "@tools/vex-fee/bps-split.js";
import type { CreatePendingActivityEventInput } from "@vex-agent/db/repos/agent-activity.js";

/**
 * A venue whose recorded role is one the DATABASE admits.
 *
 * The pure half (`@tools/vex-fee/native-leg/`) types the role as a plain string
 * on purpose - it must not import the agent's database vocabulary. The narrowing
 * belongs here, at the first point that actually writes a row: a venue whose
 * role is not in `agent_activity_event_role_valid` would be rejected by the CHECK
 * constraint at runtime, and this turns that into a compile error instead.
 */
export type ActivityWritingFeeVenue<Basis extends string> =
  NativeFeeVenue<Basis> & {
    readonly activityEventRole: CreatePendingActivityEventInput["eventRole"];
  };

/** A plain value transfer carries no calldata. */
const EMPTY_CALLDATA = "0x" as Hex;

/**
 * The parent execution's kind - the arm of the kind/role CHECK the fee row lands
 * on.
 *
 * `"transaction"` is the GENERIC SIGNING lane (migration 088): a fee leg
 * charged on the native value of a transaction Vex did not build. Its role
 * `tx_vex_fee` is admitted on the `transaction` arm ONLY, and only with
 * `chain_family = 'eip155'` - no Solana fee-leg runtime exists on that lane, and
 * the database enforces the gap rather than trusting this type to describe it.
 */
export type NativeFeeParentKind = "swap" | "launch" | "transaction";

export interface PlanNativeFeeLegInput<Basis extends string> {
  /** Which native leg the fee is charged on, and how it is named. */
  readonly basis: Basis;
  /** The amount the rate applies to, in wei. */
  readonly baseWei: bigint;
  /** Whether `netWei` is meaningful for this basis (only where the fee reduces the principal). */
  readonly netApplies: boolean;
  readonly parentKind: NativeFeeParentKind;
  readonly chainId: number;
  /** The shared native sentinel - the fee row's identity token. */
  readonly nativeAddress: Address;
  readonly walletAddress: Address;
  readonly sessionId: string;
  /** Nullable ESTIMATE, stamped on the fee row ONLY. Omit rather than guess. */
  readonly usdVexFeeEst?: string | undefined;
}

export interface NativeFeeLegPlan<Basis extends string = string> {
  /** Exact, in wei. What the treasury transfer sends. */
  readonly feeWei: bigint;
  /**
   * `base - fee`. Load-bearing where the fee reduces the principal (a buy, whose
   * quote is taken for it); elsewhere nothing consumes it.
   */
  readonly netWei: bigint;
  /**
   * Native value transfer. `data` is the EMPTY calldata `0x` - the staged
   * broadcaster requires the field, and empty is what makes this a plain
   * transfer rather than a contract call.
   */
  readonly txParams: { readonly to: Address; readonly data: Hex; readonly value: bigint };
  readonly event: Omit<CreatePendingActivityEventInput, "protocolExecutionId" | "eventIndex">;
  readonly disclosure: NativeFeeDisclosure<Basis>;
}

/**
 * Plan the fee leg, or `null` when the fee floors to zero. Throws only on a
 * non-positive base, which is a programming error rather than a market
 * condition (the shared split refuses it by name).
 */
export function planNativeFeeLeg<Basis extends string>(
  venue: ActivityWritingFeeVenue<Basis>,
  input: PlanNativeFeeLegInput<Basis>,
): NativeFeeLegPlan<Basis> | null {
  const split = splitAmountForFeeBps(input.baseWei, { bps: venue.bps, amountLabel: venue.amountLabel });
  if (!split.charged) return null;

  const transfer = buildNativeFeeTransfer(venue, split.feeRaw);
  // The VENUE's own decimals, never an assumed 18: this lane now carries venues
  // whose native is not ETH, and `amountHuman` is a figure a person reads.
  const feeHuman = formatUnits(split.feeRaw, venue.nativeDecimals);
  return {
    feeWei: split.feeRaw,
    netWei: split.netRaw,
    txParams: { to: transfer.to, data: EMPTY_CALLDATA, value: transfer.value },
    event: {
      eventRole: venue.activityEventRole,
      kind: input.parentKind,
      protocol: venue.protocol,
      chainId: input.chainId,
      chainSlug: venue.chainSlug,
      walletAddress: input.walletAddress,
      sessionId: input.sessionId,
      // The fee IS this row: it lives in `tokenIn`/`amountIn`, exactly as a
      // `bridge_fee` row does. The `vexFee` (`AgentActivityVexFeeCharge`) fields
      // are deliberately NOT set - those are for venues that take the fee inside
      // the transaction being recorded, and setting both stores the same money
      // twice.
      tokenIn: {
        tokenAddress: input.nativeAddress,
        tokenSymbol: venue.nativeLabel,
        tokenDecimals: venue.nativeDecimals,
        amountHuman: feeHuman,
        amountRaw: split.feeRaw.toString(),
      },
      ...(input.usdVexFeeEst === undefined ? {} : { usdVexFeeEst: input.usdVexFeeEst }),
      routeProvenance: { feeBasis: input.basis, feeBaseWei: input.baseWei.toString() },
    },
    disclosure: buildNativeFeeDisclosure(venue, {
      basis: input.basis,
      baseWei: input.baseWei,
      feeWei: split.feeRaw,
      netWei: split.netRaw,
      netApplies: input.netApplies,
      feeUsdEstimate: input.usdVexFeeEst,
    }),
  };
}
