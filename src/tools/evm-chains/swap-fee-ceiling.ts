import type { LegFeeCap } from "./swap-native-debit.js";

export class SwapApprovedGasPriceExceededError extends Error {
  readonly kind: "pricing_mode_changed" | "approved_gas_price_exceeded";
  constructor(readonly field: string, readonly requiredRaw: string, readonly approvedRaw: string, quoteTool: string) {
    super((field === "pricing mode"
      ? `Refused before signing: pricing mode changed from ${approvedRaw} to ${requiredRaw}; this ceiling cannot cover a different pricing mode. `
      : `Refused before signing: ${field} is ${requiredRaw} wei/gas, above the approved ceiling of ${approvedRaw} wei/gas. `)
      + `Nothing was signed or broadcast. Request a fresh ${quoteTool} and approve its new gas ceiling.`);
    this.kind = field === "pricing mode" ? "pricing_mode_changed" : "approved_gas_price_exceeded";
    this.name = field === "pricing mode" ? "SwapApprovedGasPricingModeChangedError" : "SwapApprovedGasPriceExceededError";
  }
}

/** Quote-time fee-price headroom, separate from gas-unit headroom. See the measurement note. */
export const SWAP_FEE_HEADROOM_BPS = 1500;

/** Establish authority at quote time only. Never widen an existing approved cap. */
export function swapFeeCeiling(observed: LegFeeCap): LegFeeCap {
  const raise = (value: bigint): bigint => {
    if (value < 0n) throw new Error("Cannot price a negative gas fee");
    return (value * BigInt(10_000 + SWAP_FEE_HEADROOM_BPS) + 9_999n) / 10_000n;
  };
  return observed.mode === "eip1559"
    ? {
        mode: "eip1559",
        maxFeePerGasWei: raise(observed.maxFeePerGasWei),
        maxPriorityFeePerGasWei: raise(observed.maxPriorityFeePerGasWei),
      }
    : { mode: "legacy", gasPriceWei: raise(observed.gasPriceWei) };
}
