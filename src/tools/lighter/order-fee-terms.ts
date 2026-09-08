import { ErrorCodes, VexError } from "../../errors.js";
import { assertLighterIntegratorFees, type LighterIntegratorFees } from "./fee-policy.js";

/** Decode durable, public fee terms; malformed values never become a zero fee. */
export function readLighterOrderFeeTerms(value: unknown): LighterIntegratorFees | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw invalidFees();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "integratorAccountIndex,integratorMakerFee,integratorTakerFee") throw invalidFees();
  const fees = record as unknown as LighterIntegratorFees;
  assertLighterIntegratorFees(fees);
  return { integratorAccountIndex: fees.integratorAccountIndex, integratorMakerFee: fees.integratorMakerFee, integratorTakerFee: fees.integratorTakerFee };
}

export function lighterFeePercent(ticks: number): string {
  if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks > 1_000_000) throw invalidFees();
  return formatFeeInteger(BigInt(ticks), 4);
}

export function lighterOrderFeeCriticalArgs(fees: LighterIntegratorFees | null | undefined): Record<string, string | number> {
  if (fees == null) return {};
  assertLighterIntegratorFees(fees);
  return {
    integratorAccountIndex: fees.integratorAccountIndex,
    integratorMakerFee: fees.integratorMakerFee,
    integratorTakerFee: fees.integratorTakerFee,
    vexFeeSummary: `VEX fee: ${lighterFeePercent(fees.integratorMakerFee)}% maker / ${lighterFeePercent(fees.integratorTakerFee)}% taker on executed trade value, credited to Lighter account ${fees.integratorAccountIndex}. Spot fees are deducted from the asset received. Lighter exchange fees are separate.`,
  };
}

/** Exact estimate before provider rounding; never added again to spot input. */
export function estimateLighterOrderFee(amountInteger: string, decimals: number, feeTicks: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amountInteger) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw invalidFees();
  lighterFeePercent(feeTicks);
  return formatFeeInteger(BigInt(amountInteger) * BigInt(feeTicks), decimals + 6);
}

function formatFeeInteger(value: bigint, decimals: number): string {
  const raw = value.toString().padStart(decimals + 1, "0");
  const fraction = raw.slice(-decimals).replace(/0+$/, "");
  return `${raw.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}

function invalidFees(): VexError {
  return new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST, "The approved Lighter fee terms are invalid. Prepare a fresh order before signing.");
}
