/**
 * KyberSwap → the honest USD cost breakdown recorded on an `agent_activity`
 * swap row (migration 050's `usd_network_gas_est` / `usd_vex_fee_est`).
 *
 * Owns ONE decision: how a Kyber quote/build becomes the two cost figures the
 * durable record keeps. It lives beside `helpers.ts` (which projects the same
 * numbers for the AGENT to read) rather than inside the execute handler, so the
 * value the agent is shown and the value the row stores are derived by code a
 * reader can compare side by side.
 *
 * Two corrections over what `swap.ts` recorded before migration 050:
 *
 *  1. GAS INCLUDES THE L1 DATA FEE. The row used to store `buildResp.data.
 *     gasUsd` alone, which is the L2-EXECUTION cost only. Most supported chains
 *     are OP-stack, where `l1FeeUsd` "can rival or exceed gasUsd"
 *     (`helpers.ts`'s own note) - so the stored gas was materially understated.
 *     `l1FeeUsd` lives on the ROUTE SUMMARY, not the build response (see
 *     `tools/kyberswap/aggregator/types.ts`), which is why it was easy to miss
 *     at the write site.
 *  2. VEX'S OWN FEE IS RECORDED. Vex charges `KYBERSWAP_FEE_BPS` on every
 *     aggregator swap and stored it nowhere.
 *
 * Both are ESTIMATES built on the provider's own USD figures, exactly like the
 * `usd_in_est`/`usd_out_est` beside them, and both are returned as `undefined`
 * rather than as a guess when an input cannot be read as a finite number. An
 * absent value means "not known", never "zero".
 *
 * Precision: `Number` + `toFixed(6)`, the same arithmetic every other USD
 * estimate in this repo uses (`khalani/handlers/bridge-usd.ts#estimateUsd`,
 * `relay/handlers/bridge-output.ts#relayFeeUsdEstimate`). Double precision
 * carries ~15 significant digits, far more than 6-decimal USD needs at any
 * trade size this venue supports.
 */

import { KYBERSWAP_FEE_BPS } from "@tools/kyberswap/constants.js";

/** Basis-point base. Local to the arithmetic that consumes it so the two cannot drift. */
const BPS_DENOMINATOR = 10_000;

export interface KyberSwapCostEstimate {
  /**
   * Network gas in USD - L2 execution PLUS the L1 data fee where the chain has
   * one. `undefined` when either component is present but unreadable: an
   * understated gas figure is worse than none, because it reads as complete.
   */
  readonly usdNetworkGasEst: string | undefined;
  /** Vex's 25 bps integrator fee in USD. `undefined` when the provider gave no readable input-side USD. */
  readonly usdVexFeeEst: string | undefined;
}

export interface KyberSwapCostInput {
  /** `buildResp.data.gasUsd` - L2 execution only. */
  readonly gasUsd: string;
  /** `routeSummary.l1FeeUsd` - absent on chains with no L1 data fee. */
  readonly l1FeeUsd: string | undefined;
  /**
   * `buildResp.data.amountInUsd` - the USD value of the FULL input amount, which
   * is the base the integrator fee is charged on: `swap-calldata-guard.ts`
   * refuses to sign unless the decoded calldata charges exactly
   * `KYBERSWAP_FEE_BPS`, in bps mode (`FLAG_FEE_IN_BPS`), on the SOURCE token
   * (`FLAG_FEE_ON_DST` clear), over `desc.amount == approvedAmountIn`. So by the
   * time a row is written, "25 bps of the input" is a proven property of the
   * transaction being signed, not an assumption made here.
   */
  readonly amountInUsd: string;
}

export function estimateKyberSwapCostsUsd(input: KyberSwapCostInput): KyberSwapCostEstimate {
  return {
    usdNetworkGasEst: totalGasUsd(input.gasUsd, input.l1FeeUsd),
    usdVexFeeEst: applyBps(input.amountInUsd, KYBERSWAP_FEE_BPS),
  };
}

function totalGasUsd(gasUsd: string, l1FeeUsd: string | undefined): string | undefined {
  const l2 = finite(gasUsd);
  if (l2 === null) return undefined;
  if (l1FeeUsd === undefined) return renderUsd(l2);
  const l1 = finite(l1FeeUsd);
  // Present but unreadable - refuse rather than silently report L2-only as if
  // it were the whole cost.
  if (l1 === null) return undefined;
  return renderUsd(l2 + l1);
}

function applyBps(usdBase: string, bps: number): string | undefined {
  const base = finite(usdBase);
  if (base === null) return undefined;
  return renderUsd((base * bps) / BPS_DENOMINATOR);
}

function finite(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Compact fixed-point for a NUMERIC column, trailing zeros trimmed - matches `estimateUsd`'s rendering. */
function renderUsd(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  return value.toFixed(6).replace(/\.?0+$/, "") || "0";
}
