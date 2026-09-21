/**
 * Leverage is selected as a whole multiplier in the renderer. Lighter keeps
 * the exact initial-margin fraction internally, but every visible leverage
 * label uses this one whole-number representation.
 */
export function wholeLeverageDisplay(value: string | number): string {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? String(Math.round(parsed)) : String(value);
}

export function wholeLeverageLabelFromFraction(initialMarginFraction: number): string {
  if (!Number.isFinite(initialMarginFraction) || initialMarginFraction <= 0) return "-";
  return `${wholeLeverageDisplay(10_000 / initialMarginFraction)}x`;
}
