/**
 * THE AUTO TOP-UP RULE POLICY (backend plan 4.4, owner decision D12), as pure
 * decisions over a rule row, its durable cap usage and the live runtime
 * conditions. No I/O: the executor, the poller, the agent deposit owner and
 * the funding page all decide through these functions, so there is one
 * policy and no second copy to drift.
 *
 * STATES. The durable status is what the USER decided (`active`, `paused`,
 * `revoked`, `expired`). The plan's `suspended` is DERIVED here from live
 * conditions and never stored: a lock or a quit can therefore never leave a
 * rule stuck, and an unlock resumes it with nothing to repair. A user pause
 * is reported as `suspended` with reason `user_paused`.
 *
 * CAPS. Counted on durable state over ROLLING windows (24 hours for the
 * daily count, 30 days for the VEX cap), so a month or day boundary never
 * doubles an allowance. Every execution that was not refused before signing
 * counts, INCLUDING unknown outcomes and the in-flight one.
 *
 * NETWORK FEE. Every top-up is signed under a fee bound (gas limit times max
 * fee per gas). A rule spends only under a bound at most its user-approved
 * `maxNetworkFeeWei`; a rule without one (approved before migration 179)
 * spends nothing. A plan above the ceiling is refused, and the rule reads
 * suspended `network_fee_above_limit` until a plan fits again.
 */

import type { AutoTopUpRuleRow, RuleUsage } from "@vex-agent/db/repos/vex-inference-funding.js";
import { AUTO_TOP_UP_MAX_NETWORK_FEE_WEI } from "@shared/schemas/vex-cloud-auto-top-up.js";

export const RULE_MAX_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
export const RULE_MAX_PER_DAY = 24;

export type RuleSuspendReason =
  | "user_paused"
  | "vault_locked"
  | "app_quitting"
  | "execution_not_ready"
  | "cap_reached"
  | "deposit_address_mismatch"
  | "balance_read_failing"
  | "account_changed"
  | "network_fee_above_limit";

export type EffectiveRuleState =
  | { readonly state: "active" }
  | { readonly state: "suspended"; readonly reason: RuleSuspendReason }
  | { readonly state: "revoked" }
  | { readonly state: "expired" };

/** Live facts the effective state depends on. `null` = not known right now (treated as not satisfied). */
export interface RuleConditions {
  readonly now: Date;
  readonly vaultUnlocked: boolean;
  readonly quitting: boolean;
  readonly executionReady: boolean;
  /** The signed-in Vex Inference account, or `null` when none is signed in. */
  readonly signedInAccountId: string | null;
  /** Pinned deposit address equal to the backend's. `null` = not read yet. */
  readonly depositAddressMatches: boolean | null;
  readonly balanceReadFailing: boolean;
  /** The poller's last plan for this rule had a fee bound above the rule's ceiling. */
  readonly networkFeeAboveLimit: boolean;
}

/** The live facts every caller supplies itself, per observation. */
export type ObservedRuleConditions = "depositAddressMatches" | "balanceReadFailing" | "networkFeeAboveLimit";

/** Whether a deposit signed under a fee bound of `maxNetworkFeeWei` fits the rule's approved ceiling. */
export function feeWithinRule(rule: Pick<AutoTopUpRuleRow, "maxNetworkFeeWei">, maxNetworkFeeWei: bigint): boolean {
  return rule.maxNetworkFeeWei !== null && maxNetworkFeeWei <= rule.maxNetworkFeeWei;
}

/** The sentence for a fee above the ceiling, shared by every refusal. */
export const NETWORK_FEE_ABOVE_LIMIT = "The network fee is above your auto top-up limit";

export type CapVerdict = { readonly ok: true } | { readonly ok: false; readonly which: "daily_count" | "monthly_cap" };

/**
 * Whether one more execution of `amountWei` fits the caps. `usage` is the
 * durable usage BEFORE this execution was recorded.
 */
export function capsAllow(rule: Pick<AutoTopUpRuleRow, "maxPerDay" | "monthlyCapWei">, usage: RuleUsage, amountWei: bigint): CapVerdict {
  if (usage.countLastDay + 1 > rule.maxPerDay) return { ok: false, which: "daily_count" };
  if (usage.sumLast30DaysWei + amountWei > rule.monthlyCapWei) return { ok: false, which: "monthly_cap" };
  return { ok: true };
}

/** Whether `usage` (which already INCLUDES the in-flight execution) is still within the caps. */
export function capsStillHold(rule: Pick<AutoTopUpRuleRow, "maxPerDay" | "monthlyCapWei">, usageIncludingThis: RuleUsage): boolean {
  return usageIncludingThis.countLastDay <= rule.maxPerDay && usageIncludingThis.sumLast30DaysWei <= rule.monthlyCapWei;
}

/** The plan 4.4 state of a rule right now. Order: decided states first, then the user's pause, then live conditions. */
export function effectiveRuleState(
  rule: AutoTopUpRuleRow,
  usage: RuleUsage,
  conditions: RuleConditions,
): EffectiveRuleState {
  if (rule.status === "revoked") return { state: "revoked" };
  if (rule.status === "expired" || rule.expiresAt.getTime() <= conditions.now.getTime()) return { state: "expired" };
  if (rule.status === "paused") return { state: "suspended", reason: "user_paused" };
  if (conditions.quitting) return { state: "suspended", reason: "app_quitting" };
  if (!conditions.vaultUnlocked) return { state: "suspended", reason: "vault_locked" };
  if (!conditions.executionReady) return { state: "suspended", reason: "execution_not_ready" };
  if (conditions.signedInAccountId === null || conditions.signedInAccountId !== rule.accountId) {
    return { state: "suspended", reason: "account_changed" };
  }
  // `null` = the backend could not be read, so the pin could not be compared: that is a failing read, not a mismatch.
  if (conditions.depositAddressMatches === null) return { state: "suspended", reason: "balance_read_failing" };
  if (conditions.depositAddressMatches !== true) return { state: "suspended", reason: "deposit_address_mismatch" };
  if (conditions.balanceReadFailing) return { state: "suspended", reason: "balance_read_failing" };
  if (rule.maxNetworkFeeWei === null || conditions.networkFeeAboveLimit) return { state: "suspended", reason: "network_fee_above_limit" };
  if (!capsAllow(rule, usage, rule.amountWei).ok) return { state: "suspended", reason: "cap_reached" };
  return { state: "active" };
}

export type CoverageVerdict = { readonly covered: true } | { readonly covered: false; readonly reason: string };

/**
 * Whether the rule covers an AGENT deposit of `amountWei` from `from`: the
 * rule is active right now, the source wallet is the rule's, the amount is at
 * most the rule's per-top-up amount, and one more execution fits the caps.
 * The trigger (balance below the alert) is NOT required for the agent: the
 * rule bounds how much may move without a card, and the agent's request is
 * the trigger. The intent's fee bound must fit the rule's network fee ceiling.
 */
export function ruleCoversAgentDeposit(
  rule: AutoTopUpRuleRow,
  usage: RuleUsage,
  conditions: RuleConditions,
  request: { readonly from: string; readonly amountWei: bigint; readonly maxNetworkFeeWei: bigint },
): CoverageVerdict {
  const state = effectiveRuleState(rule, usage, conditions);
  if (state.state !== "active") {
    return { covered: false, reason: state.state === "suspended" ? `the auto top-up rule is suspended (${state.reason})` : `the auto top-up rule is ${state.state}` };
  }
  if (rule.sourceWallet.toLowerCase() !== request.from.toLowerCase()) {
    return { covered: false, reason: "the auto top-up rule is for a different source wallet" };
  }
  if (request.amountWei > rule.amountWei) {
    return { covered: false, reason: "the amount is above the auto top-up rule's per-top-up amount" };
  }
  if (!feeWithinRule(rule, request.maxNetworkFeeWei)) {
    return { covered: false, reason: "the network fee bound is above the auto top-up rule's network fee limit" };
  }
  const caps = capsAllow(rule, usage, request.amountWei);
  if (!caps.ok) {
    return { covered: false, reason: caps.which === "daily_count" ? "the auto top-up rule's daily count is used up" : "the auto top-up rule's 30-day VEX cap would be exceeded" };
  }
  return { covered: true };
}

export interface RuleBounds {
  readonly sourceWallet: string;
  readonly amountWei: bigint;
  readonly maxPerDay: number;
  readonly monthlyCapWei: bigint;
  readonly maxNetworkFeeWei: bigint;
  readonly expiresAt: Date;
}

export type BoundsVerdict = { readonly ok: true } | { readonly ok: false; readonly field: keyof RuleBounds; readonly detail: string };

/**
 * The bounds a user may approve. `minimumWei` is the backend minimum deposit
 * at its CURRENT rate; a rule whose amount is below it could never execute.
 */
export function validateRuleBounds(bounds: RuleBounds, context: { readonly now: Date; readonly minimumWei: bigint }): BoundsVerdict {
  if (bounds.amountWei < context.minimumWei) {
    return { ok: false, field: "amountWei", detail: "The amount per top-up is below the $5 minimum deposit at the current rate." };
  }
  if (!Number.isInteger(bounds.maxPerDay) || bounds.maxPerDay < 1 || bounds.maxPerDay > RULE_MAX_PER_DAY) {
    return { ok: false, field: "maxPerDay", detail: `The maximum top-ups per day must be a whole number from 1 to ${RULE_MAX_PER_DAY}.` };
  }
  if (bounds.monthlyCapWei < bounds.amountWei) {
    return { ok: false, field: "monthlyCapWei", detail: "The 30-day cap must be at least one top-up amount." };
  }
  if (bounds.maxNetworkFeeWei <= 0n || bounds.maxNetworkFeeWei > AUTO_TOP_UP_MAX_NETWORK_FEE_WEI) {
    return { ok: false, field: "maxNetworkFeeWei", detail: "The network fee limit per top-up must be above zero and at most 0.01 ETH." };
  }
  const lifetime = bounds.expiresAt.getTime() - context.now.getTime();
  if (!Number.isFinite(lifetime) || lifetime <= 0) {
    return { ok: false, field: "expiresAt", detail: "The expiry must be in the future." };
  }
  if (lifetime > RULE_MAX_LIFETIME_MS) {
    return { ok: false, field: "expiresAt", detail: "A rule can last at most 90 days." };
  }
  return { ok: true };
}

/** Should the poller start a top-up now? Only for an active rule whose trigger fired. */
export function pollerShouldTopUp(state: EffectiveRuleState, belowAlert: boolean): boolean {
  return state.state === "active" && belowAlert;
}
