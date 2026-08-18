/**
 * The health-factor floor: how much room a position must keep after an
 * operation Vex performs.
 *
 * WHY THE FLOOR IS 1.25 AND NOT SOMETHING JUST ABOVE 1.0. Morpho Blue HAS NO
 * CLOSE FACTOR. On most lending protocols crossing the liquidation threshold
 * lets a liquidator repay some fraction of the debt, which gives a position a
 * partial haircut and a chance to recover. On Blue, crossing a health factor of
 * 1.0 permits the position to be liquidated IN FULL, in one transaction, with a
 * liquidation incentive of up to 15% paid out of the borrower's collateral.
 * There is no cushion and there is no second chance.
 *
 * So the floor is not "close to liquidation is fine as long as we are above it".
 * It is a distance chosen so that ordinary price movement between Vex deciding
 * to borrow and the transaction landing cannot cross the cliff. 1.25 leaves the
 * collateral room to fall about 20% before liquidation becomes possible.
 *
 * OWNER-TUNABLE, DELIBERATELY NOT AGENT-TUNABLE. The number below is a product
 * decision and lives in one place so it can be changed in one reviewed edit. It
 * is never read from a tool parameter, a prompt, or model output: a floor the
 * borrower can talk its way past is not a floor, and rules/90 puts limit
 * parameters outside model reach for exactly this reason.
 */

import { VexError, ErrorCodes } from "../../../../errors.js";
import { formatWad } from "./refusal.js";

/**
 * The minimum health factor a position may hold AFTER an operation Vex
 * performs, in WAD (18 decimals), matching the scale the Morpho SDK reports a
 * health factor in.
 */
export const MORPHO_MIN_HEALTH_FACTOR_WAD = 1_250_000_000_000_000_000n;

/** The same floor as a decimal string, for messages a person and an agent read. */
export const MORPHO_MIN_HEALTH_FACTOR_DECIMAL = "1.25";

/** WAD, the fixed-point scale Morpho states health factors and LLTVs in. */
const WAD = 10n ** 18n;

/**
 * The position's health after the operation, measured against the floor.
 *
 * `healthFactorWad` is `null` when the position carries NO DEBT, which is not a
 * failure and not an infinite number to be compared: a position that owes
 * nothing cannot be liquidated, so it passes. Modelling that as `null` rather
 * than as a very large number keeps the caller from ever comparing a sentinel.
 *
 * @throws {VexError} `MORPHO_HEALTH_FACTOR_FLOOR` carrying the projected number
 * and the floor, so the agent can size a smaller operation instead of guessing.
 */
export function assertMorphoHealthFactorFloor(
  healthFactorWad: bigint | null,
  operation: string,
): void {
  if (healthFactorWad === null) return;
  if (healthFactorWad >= MORPHO_MIN_HEALTH_FACTOR_WAD) return;

  const projected = formatWad(healthFactorWad);
  const belowOne = healthFactorWad < WAD;
  const severity = belowOne
    ? "That is below 1.0, which means the position would be liquidatable the moment the transaction lands."
    : "That is above 1.0, so the position would not be instantly liquidatable, but it sits inside the margin Vex "
      + "keeps for ordinary price movement.";

  throw new VexError(
    ErrorCodes.MORPHO_HEALTH_FACTOR_FLOOR,
    `Refusing this ${operation}: it would leave the position at a health factor of ${projected}, below Vex's floor `
    + `of ${MORPHO_MIN_HEALTH_FACTOR_DECIMAL}. ${severity} Morpho Blue has no close factor, so a position that `
    + "crosses 1.0 can be liquidated IN FULL in a single transaction, with a liquidation incentive of up to 15% "
    + "taken out of the collateral.",
    `Nothing was signed or sent. Borrow less, or supply more collateral first, so the health factor after the `
    + `operation stays at or above ${MORPHO_MIN_HEALTH_FACTOR_DECIMAL}.`,
  );
}
