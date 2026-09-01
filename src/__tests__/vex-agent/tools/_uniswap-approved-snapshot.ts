/**
 * The approved-quote snapshot a `uniswap.swap.execute` claims, for suites whose
 * subject is something else.
 *
 * It is built through the SAME functions the handler uses - the real fee
 * resolution and the real snapshot codec - so a suite never hand-writes a fee
 * amount or a disclosure sentence that the handler would then reject as drift.
 * Callers state only what their own scenario is about: the pair, the amount and
 * the approved output.
 *
 * Not a test spec: a helper module (rule 06).
 */

import { parseUnits } from "viem";

import { resolveUniswapFeeCharge } from "@tools/uniswap/fee/index.js";
import type { UniswapDeployment } from "@tools/uniswap/deployments.js";
import type { UniswapToken } from "@tools/uniswap/types.js";
import { resolveUniswapToken } from "@vex-agent/tools/protocols/uniswap/handlers/swap/token-resolution.js";
import { buildUniswapQuoteSnapshot } from "@vex-agent/tools/protocols/uniswap/handlers/swap/execution-binding.js";
import type { UniswapExecutionSnapshot } from "@vex-agent/tools/protocols/quote-authority/uniswap.js";
import { buildBoundDebitPlan } from "@vex-agent/tools/protocols/quote-authority/debit-plan.js";
import type { LegFeeCap, NativeDebitLegRole } from "@tools/evm-chains/swap-native-debit.js";

/**
 * The transaction set a Uniswap quote binds, by the SAME rule
 * `planUniswapDebitLegs` applies at execute time: the allowance legs come from
 * the current allowance, the swap is always there, and the Vex fee transfer is
 * there whenever a fee actually applies.
 *
 * It is derived rather than listed because since WP2-B the execute REFUSES a leg
 * set that is not the approved one - so a suite that changes what the allowance
 * read answers must move the bound plan with it, exactly as a real re-quote
 * would.
 */
export function uniswapLegsFor(input: {
  readonly tokenInIsNative: boolean;
  readonly currentAllowance: bigint;
  readonly swapAmountRaw: bigint;
  readonly feeApplies: boolean;
}): readonly NativeDebitLegRole[] {
  const needsAllowance = !input.tokenInIsNative && input.currentAllowance < input.swapAmountRaw;
  const needsReset = needsAllowance && input.currentAllowance > 0n;
  return [
    ...(needsReset ? (["allowance_reset"] as const) : []),
    ...(needsAllowance ? (["allowance"] as const) : []),
    "swap" as const,
    ...(input.feeApplies ? (["swap_fee"] as const) : []),
  ];
}

/**
 * The default bound ceiling. It matches `uniswapSpendabilityFake`'s own default
 * legacy gas price, so a suite about something else sees the ceiling its fake
 * chain would have produced rather than an invented one.
 */
const DEFAULT_FEE_CAP: LegFeeCap = { mode: "legacy", gasPriceWei: 1_000n };

export interface ApprovedSnapshotInput {
  readonly chainId: number;
  readonly tokenIn: UniswapToken;
  readonly tokenOut: UniswapToken;
  /** The FULL requested input, before the fee. */
  readonly amountInRaw: bigint;
  readonly approvedAmountOutRaw: bigint;
  readonly approvedMinOutRaw: bigint;
  readonly slippageBps?: number;
  readonly expiresAt?: string;
  /**
   * The transaction set this quote bound, in broadcast order. Defaults to the
   * set {@link uniswapLegsFor} derives from `currentAllowance`.
   */
  readonly legs?: readonly NativeDebitLegRole[];
  /**
   * The router allowance the QUOTE saw. Defaults to a huge one, which is what
   * the suites whose subject is not the allowance mock.
   */
  readonly currentAllowance?: bigint;
  /** The per-gas ceiling every leg was quoted under, and is signed under. */
  readonly feeCap?: LegFeeCap;
  /** Roles whose gas units the quote could not measure (the unpriced marker). */
  readonly unpricedLegs?: readonly NativeDebitLegRole[];
}

export async function approvedUniswapSnapshot(
  input: ApprovedSnapshotInput,
): Promise<UniswapExecutionSnapshot> {
  const charge = await resolveUniswapFeeCharge({
    chainId: input.chainId,
    tokenIn: input.tokenIn,
    amountInRaw: input.amountInRaw,
  });
  return buildUniswapQuoteSnapshot({
    chainId: input.chainId,
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    charge,
    quoted: {
      route: { version: "v2", path: [input.tokenIn.address, input.tokenOut.address], amountOut: input.approvedAmountOutRaw },
      amountOut: input.approvedAmountOutRaw,
      minAmountOut: input.approvedMinOutRaw,
      slippageBps: input.slippageBps ?? 50,
    },
    expiresAt: input.expiresAt ?? "2026-08-28T10:00:00.000Z",
    debitPlan: buildBoundDebitPlan({
      legs: (input.legs ?? uniswapLegsFor({
        tokenInIsNative: input.tokenIn.isNative,
        currentAllowance: input.currentAllowance ?? 10n ** 40n,
        swapAmountRaw: charge.swapAmountRaw,
        feeApplies: charge.feeRaw !== null && charge.feeTokenAddress !== null,
      })).map((role) => ({
        role,
        unpriced: input.unpricedLegs?.includes(role) ?? false,
      })),
      feeCap: input.feeCap ?? DEFAULT_FEE_CAP,
    }),
  });
}

/** The claim result the store would hand an execute for that snapshot. */
export async function claimedUniswapSnapshot(input: ApprovedSnapshotInput): Promise<{
  readonly ok: true;
  readonly prequoteId: string;
  readonly snapshot: UniswapExecutionSnapshot;
}> {
  return { ok: true, prequoteId: "prequote-test", snapshot: await approvedUniswapSnapshot(input) };
}

/**
 * A `claimUniswapExecutionSnapshot` stand-in that answers with the quote THIS
 * call would have produced: it resolves the params' own legs through the same
 * resolver the handler uses, so a suite that swaps a native leg in and out of
 * its params needs no second fixture.
 *
 * Suites whose subject IS the binding drive the claim explicitly instead.
 */
export function claimStandingInForTheParams(deployment: {
  readonly chainId: number;
  readonly weth: string;
  readonly approvedAmountOutRaw?: bigint;
  readonly approvedMinOutRaw?: bigint;
  /**
   * The allowance the quote saw, read AT CLAIM TIME so a suite that changes its
   * allowance mock between tests gets a snapshot bound to the matching leg set.
   */
  readonly currentAllowance?: () => bigint;
}) {
  return async (_toolId: unknown, _sessionId: unknown, params: Record<string, unknown>) => {
    const dep = { chainId: deployment.chainId, weth: deployment.weth } as UniswapDeployment;
    const tokenIn = await resolveUniswapToken(dep, String(params.tokenIn));
    const tokenOut = await resolveUniswapToken(dep, String(params.tokenOut));
    return claimedUniswapSnapshot({
      chainId: deployment.chainId,
      tokenIn,
      tokenOut,
      amountInRaw: parseUnits(String(params.amountIn), tokenIn.decimals),
      approvedAmountOutRaw: deployment.approvedAmountOutRaw ?? 10n,
      approvedMinOutRaw: deployment.approvedMinOutRaw ?? 10n,
      ...(deployment.currentAllowance === undefined
        ? {}
        : { currentAllowance: deployment.currentAllowance() }),
    });
  };
}
