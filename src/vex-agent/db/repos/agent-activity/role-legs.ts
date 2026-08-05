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
  | "tokenIn2Address"
  | "tokenOut2Address"
>;

/**
 * Roles that carry settlement amounts at all. Excluded, by evidence rather than
 * by omission: `allowance`/`allowance_reset` (an approve moves nothing), the fee
 * legs (their single amount already rides the row's own first leg),
 * `bridge_fill_expected` (proven by the provider lane, not by a decode), the
 * externally-observed evidence rows, and `bridge_deposit` — a deposit legitimately
 * carries an executed INPUT and no output, so demanding both would leave every
 * healthy deposit permanently "incomplete".
 */
const AMOUNT_BEARING_ROLES: ReadonlySet<AgentActivityEventRole> = new Set([
  "swap",
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
 * `yield_py`/`yield_lp` require their second legs ONLY where the row itself
 * populated the second-leg tokens, exactly as migration 053's CHECK does.
 */
export function roleLegsIncomplete(row: RoleLegRow): boolean {
  const role = row.eventRole;
  if (!isAmountBearingRole(role)) return false;

  if (role === "yield_claim") return !row.executedAmountOutRaw;

  if (!row.executedAmountInRaw || !row.executedAmountOutRaw) return true;

  if (role === "yield_py" || role === "yield_lp") {
    if (row.tokenIn2Address && !row.executedAmountIn2Raw) return true;
    if (row.tokenOut2Address && !row.executedAmountOut2Raw) return true;
  }
  return false;
}
