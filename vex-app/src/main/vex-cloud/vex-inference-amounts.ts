/**
 * Amount views for the agent surface (the engine host seam): every VEX amount
 * as raw wei, its exact decimal, and the backend's USD estimate when a rate
 * exists. Ungrouped digits (no thousands separators) because the model may
 * pass a figure back as `amountIn`, which refuses separators. Exact bigint
 * arithmetic throughout; never a float.
 */

import type { PricePerMillionView, VexAmountView } from "@vex-agent/tools/internal/vex-inference/host.js";
import { microUsdToWeiCeil, weiToMicroUsdFloor } from "@shared/vex-cloud-money.js";

/** A raw base-unit integer as its exact decimal, trailing zeros removed, no grouping. */
export function exactDecimal(raw: bigint, decimals: number): string {
  if (raw < 0n) throw new RangeError("exactDecimal expects a non-negative amount");
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const fraction = (raw % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

export function vexAmountView(wei: bigint, rateX18: bigint | null): VexAmountView {
  const usdMicro = rateX18 === null ? null : weiToMicroUsdFloor(wei, rateX18);
  return {
    wei: wei.toString(),
    vex: exactDecimal(wei, 18),
    usdMicroEstimate: usdMicro === null ? null : usdMicro.toString(),
    usdEstimate: usdMicro === null ? null : exactDecimal(usdMicro, 6),
  };
}

/** A backend amount `{wei, usd_micro_estimate}` as a view, keeping the backend's own USD estimate. */
export function backendAmountView(amount: { readonly wei: string; readonly usd_micro_estimate: string | null }): VexAmountView {
  const wei = BigInt(amount.wei);
  return {
    wei: amount.wei,
    vex: exactDecimal(wei, 18),
    usdMicroEstimate: amount.usd_micro_estimate,
    usdEstimate: amount.usd_micro_estimate === null ? null : exactDecimal(BigInt(amount.usd_micro_estimate), 6),
  };
}

/**
 * USD per token as the gateway publishes it (at most 12 decimals) -> the
 * price per ONE MILLION tokens in micro-USD, exactly: per-token USD times
 * 10^6 tokens times 10^6 micro is the per-token price scaled by 10^12, which
 * is the published text read as a 12-decimal fixed point integer.
 */
export function perMillionMicroUsd(usdPerTokenText: string): bigint | null {
  const match = /^([0-9]{1,12})(?:\.([0-9]{1,12}))?$/.exec(usdPerTokenText);
  if (match === null) return null;
  return BigInt(match[1] ?? "0") * 10n ** 12n + BigInt((match[2] ?? "").padEnd(12, "0") || "0");
}

export function pricePerMillionView(usdPerTokenText: string, rateX18: bigint | null): PricePerMillionView | null {
  const microUsd = perMillionMicroUsd(usdPerTokenText);
  if (microUsd === null) return null;
  return {
    usd: exactDecimal(microUsd, 6),
    microUsd: microUsd.toString(),
    vexAtCurrentRate: rateX18 === null ? null : exactDecimal(microUsdToWeiCeil(microUsd, rateX18), 18),
  };
}
