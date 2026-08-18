/**
 * THE ONE PREDICATE for "which executed legs does this row's role require, and
 * does it have them all?" — extracted from the guards `confirmActivityEvent`
 * already encodes (`./swap-lifecycle.ts`, the per-role throws and
 * `assertYieldConfirmLegs`).
 *
 * WHY IT IS SHARED AND NOT COPIED. Three callers ask the same question from
 * different sides: the strict confirm guard ("may this caller confirm?"), the
 * late-fill CAS ("is this confirmed row still missing money?") and the
 * settlement-decline writer ("is this row actually incomplete, or is the caller
 * about to record a missing-amount claim about a row whose amounts are all
 * present?"). The pending-fallback lane's candidate query imports it too. A
 * divergence between the confirm guard and the fallback's eligibility is how a
 * row starts satisfying one and violating the other — the same argument
 * migration 053's header made for keeping its CHECK and its repo guard in
 * lockstep.
 *
 * "Complete" here means the EXECUTED legs the role requires are all non-null. It
 * says nothing about whether those amounts are correct — that is
 * `settlement_source`'s job.
 */

import type { AgentActivityEvent, AgentActivityEventRole } from "./types.js";

/** The executed-amount fields this predicate reads. Accepts a full row or a projection of it. */
export type RoleLegRow = Pick<
  AgentActivityEvent,
  | "eventRole"
  | "executedAmountInRaw"
  | "executedAmountOutRaw"
  | "executedAmountIn2Raw"
  | "executedAmountOut2Raw"
  | "tokenInAddress"
  | "tokenOutAddress"
  | "tokenIn2Address"
  | "tokenOut2Address"
>;

/**
 * Roles that carry settlement amounts at all. Excluded, by evidence rather than
 * by omission: `allowance`/`allowance_reset` (an approve moves nothing), the fee
 * legs (their single amount already rides the row's own first leg),
 * `bridge_fill_expected` (proven by the provider lane, not by a decode) and the
 * externally-observed evidence rows.
 *
 * `bridge_deposit` IS included, under the INPUT-ONLY rule below. A deposit
 * legitimately carries an executed input and no output — the output lands on the
 * destination chain, in a different transaction, on the fill row — so requiring
 * both would leave every healthy deposit permanently "incomplete". Requiring the
 * INPUT only is what a deposit can actually prove, and it is the amount AgentScan
 * prices; the same asymmetry `yield_claim` has on the opposite side.
 */
const AMOUNT_BEARING_ROLES: ReadonlySet<AgentActivityEventRole> = new Set([
  "swap",
  "bridge_deposit",
  "wrap",
  "unwrap",
  "token_launch",
  "yield_pt",
  "yield_yt",
  "yield_py",
  "yield_lp",
  "yield_sy",
  "yield_claim",
  "lend_deposit",
  "lend_withdraw",
  "lend_borrow_operate",
  "predict_buy",
  "predict_sell",
  "predict_claim",
  "predict_close",
]);

export function isAmountBearingRole(role: AgentActivityEventRole): boolean {
  return AMOUNT_BEARING_ROLES.has(role);
}

/**
 * `true` iff this row's role requires an executed leg it does not have.
 *
 * A role that bears no amounts is never "incomplete" — there is nothing to be
 * missing. `yield_claim` requires the OUTPUT only (a claim spends nothing, so an
 * executed input would be evidence the decoder read the wrong thing).
 * `bridge_deposit` requires the INPUT only (its output lands on the destination
 * chain, in another transaction, on the fill row).
 * `yield_py`/`yield_lp` require their second legs ONLY where the row itself
 * populated the second-leg tokens, exactly as migration 053's CHECK does.
 * The three LEND roles require each FIRST leg on the same terms, for the same
 * reason: a vault deposit or withdrawal swaps asset for shares and populates
 * BOTH token sides, so both are required, while every Morpho Blue direct-market
 * operation and every Jupiter /operate leg moves ONE token (supply and
 * supply_collateral and repay send, withdraw and withdraw_collateral and borrow
 * receive), so the row populates one side's token and leaves the other null.
 * Reading the row's own tokens covers both shapes with one rule. Demanding both
 * legs unconditionally held every one-sided confirmed row incomplete forever -
 * the full reporting grace on each, then re-swept by the executed-amount
 * fallback for an amount that was never coming.
 */
export function roleLegsIncomplete(row: RoleLegRow): boolean {
  const role = row.eventRole;
  if (!isAmountBearingRole(role)) return false;

  if (role === "yield_claim") return !row.executedAmountOutRaw;
  if (role === "bridge_deposit") return !row.executedAmountInRaw;

  if (role === "lend_deposit" || role === "lend_withdraw" || role === "lend_borrow_operate") {
    if (row.tokenInAddress && !row.executedAmountInRaw) return true;
    if (row.tokenOutAddress && !row.executedAmountOutRaw) return true;
    return false;
  }

  if (!row.executedAmountInRaw || !row.executedAmountOutRaw) return true;

  if (role === "yield_py" || role === "yield_lp") {
    if (row.tokenIn2Address && !row.executedAmountIn2Raw) return true;
    if (row.tokenOut2Address && !row.executedAmountOut2Raw) return true;
  }
  return false;
}
