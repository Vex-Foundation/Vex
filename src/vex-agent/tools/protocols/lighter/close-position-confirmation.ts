import { decimalToLighterInteger } from "@tools/lighter/order-preview.js";

/** A terminal order and a position update must describe the same reduction. */
export function confirmedLighterCloseDisposition(input: {
  readonly initialPosition: unknown;
  readonly initialSign: unknown;
  readonly filledAmount: unknown;
  readonly resultingPosition: unknown;
  readonly resultingSign: unknown;
  readonly sizeDecimals: unknown;
}): "closed" | "partially_closed" | "not_closed" | null {
  if (typeof input.initialPosition !== "string" || typeof input.filledAmount !== "string"
    || typeof input.resultingPosition !== "string" || typeof input.sizeDecimals !== "number"
    || (input.initialSign !== 1 && input.initialSign !== -1)) return null;
  try {
    const initial = decimalToLighterInteger(input.initialPosition, input.sizeDecimals, "initial position");
    const filled = decimalToLighterInteger(input.filledAmount, input.sizeDecimals, "filled amount", { allowZero: true });
    const remaining = decimalToLighterInteger(input.resultingPosition, input.sizeDecimals, "resulting position", { allowZero: true });
    if (filled > initial || remaining !== initial - filled) return null;
    if (remaining > 0n && input.resultingSign !== input.initialSign) return null;
    return remaining === 0n ? "closed" : filled === 0n ? "not_closed" : "partially_closed";
  } catch {
    return null;
  }
}
