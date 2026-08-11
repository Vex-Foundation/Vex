/**
 * Measurability warnings for a mission draft - MODEL-FACING ONLY, pure, no IO.
 *
 * `validator.ts` answers "are the required fields present". This module answers
 * a different question that presence can never answer: "can anyone actually
 * decide whether this mission succeeded".
 *
 * The incident it exists for (2026-08-10): a live mission's success criterion
 * was "Portfolio value on Robinhood Chain reaches $15+ (50% gain on ~$10
 * deployed capital)". Nothing recorded what capital was deployed, so the agent
 * recomputed the comparison by hand each turn and disagreed with itself; and
 * because the target was an ABSOLUTE portfolio value, coins the wallet already
 * held counted toward it - the criterion was nearly satisfied before the first
 * trade.
 *
 * These are WARNINGS, never refusals. `deployedCapital` is optional by design
 * (a required field would strand every existing draft), so this applies the
 * pressure instead: the model sees the problem while the draft is still being
 * written and can fix it or explain to the user why it is leaving it.
 *
 * The rules are CONSERVATIVE ON PURPOSE. A false warning costs trust and
 * teaches the model to ignore the list, which is worse than not warning at all.
 * Every trigger below requires an explicit numeric or portfolio-scoped signal.
 */

import type { MissionDraft } from "../types.js";

export type MeasurabilityWarningCode =
  | "relative_target_without_deployed_capital"
  | "absolute_portfolio_target_without_deployed_capital"
  | "success_criterion_has_no_number";

export interface MeasurabilityWarning {
  readonly code: MeasurabilityWarningCode;
  readonly message: string;
}

/** A percentage, a multiple, an ROI, or a plain-word gain claim. */
const RELATIVE_TARGET_PATTERN =
  /(\d+(?:\.\d+)?\s*%)|(\b\d+(?:\.\d+)?\s*x\b)|\b(double|triple|roi|return on)\b/i;

/** The criterion is scoped to the WHOLE wallet, not to a named position. */
const PORTFOLIO_SCOPE_PATTERN = /\b(portfolio|total|balance|net worth|stack)\b/i;

/**
 * An absolute money target: a dollar figure, or - the broadened arm - a number
 * immediately followed by an asset symbol ("reaches 15 USDC").
 *
 * DELIBERATELY NOT case-insensitive. The `[A-Z]{2,6}` arm is what distinguishes
 * a ticker from an ordinary word, so folding case would make "Portfolio holds 4
 * tokens" read as a money target - a false positive that teaches the model to
 * ignore the whole warning list. Only the named tickers are matched
 * case-insensitively, and both arms still require the portfolio scope above.
 */
const ABSOLUTE_MONEY_PATTERN =
  /(\$\s?\d)|(\b\d+(?:\.\d+)?\s*(?:[A-Z]{2,6}\b|(?:[Uu][Ss][Dd][CcTt]?|[Ee][Tt][Hh]|[Ss][Oo][Ll])\b))/;

const W1_MESSAGE =
  "A success criterion states a relative gain (a percentage, a multiple, or an ROI) but this mission has no typed deployedCapital, so there is no denominator to measure it against. Set deployedCapital with the amount, its decimals, the asset and the chain, or restate the criterion as an absolute amount of a named asset.";

const W2_MESSAGE =
  "A success criterion states an absolute portfolio value. A balance the wallet already held counts toward that target, so the criterion can read as met before the mission does anything. Restate it as a change measured from the start of the run (the run baseline makes that measurable), or as an absolute amount of a named asset.";

/**
 * Assess whether this draft's success criteria can actually be decided.
 *
 * W1 is cleared by a valid declaration: a relative gain becomes measurable once
 * it has a denominator.
 *
 * W2 is NOT. It fires regardless of `deployedCapital`, because a declaration
 * does not change what an absolute WHOLE-PORTFOLIO target means: with no
 * computed success evaluator and a whole-portfolio baseline, "$15 portfolio"
 * stays pre-satisfiable by pre-existing holdings even when the deployed capital
 * is known. That is precisely the incident, so a declaration must not silence
 * it.
 */
export function assessMissionMeasurability(draft: Partial<MissionDraft>): MeasurabilityWarning[] {
  const warnings: MeasurabilityWarning[] = [];
  const criteria = draft.successCriteria ?? [];
  const hasDeployedCapital = draft.deployedCapital != null;

  const relativeTexts = [draft.goal ?? "", ...criteria];
  if (!hasDeployedCapital && relativeTexts.some((text) => RELATIVE_TARGET_PATTERN.test(text))) {
    warnings.push({ code: "relative_target_without_deployed_capital", message: W1_MESSAGE });
  }

  if (
    criteria.some(
      (text) => ABSOLUTE_MONEY_PATTERN.test(text) && PORTFOLIO_SCOPE_PATTERN.test(text),
    )
  ) {
    warnings.push({
      code: "absolute_portfolio_target_without_deployed_capital",
      message: W2_MESSAGE,
    });
  }

  criteria.forEach((text, index) => {
    if (/\d/.test(text)) return;
    warnings.push({
      code: "success_criterion_has_no_number",
      message: `Success criterion ${index + 1} contains no number, so nothing can decide whether it was met. Restate it with a figure and a named asset, or move it to the goal as intent.`,
    });
  });

  return warnings;
}
