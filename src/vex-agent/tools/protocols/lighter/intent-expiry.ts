import { ErrorCodes, VexError } from "../../../../errors.js";

export type LighterConsentExpiryReason =
  | "consent_expired_before_plan"
  | "consent_expired_before_reservation"
  | "consent_expired_after_reservation"
  | "consent_expired_before_signing"
  | "consent_expired_after_signing"
  | "consent_expired_before_submission";
export type LighterIntentRefusalReason = LighterConsentExpiryReason
  | "submission_admission_refused"
  | "cancelled_before_reservation" | "cancelled_after_reservation"
  | "cancelled_before_signing" | "cancelled_after_signing" | "cancelled_before_submission";

export class LighterIntentRefusal extends VexError {
  constructor(readonly reason: LighterIntentRefusalReason) {
    super(ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Lighter authority refused: ${reason}. No new submission is authorized.`,
      "Read the durable intent status. A new action requires fresh approval.");
  }
}

/** Human consent only. Never pass a provider wire or integrator expiry here. */
export function assertIntentUnexpired(
  expiresAt: string | Date,
  nowMs: number,
  why: LighterConsentExpiryReason,
): void {
  const expiry = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(nowMs) || expiry <= nowMs) {
    throw new LighterIntentRefusal(why);
  }
}

export function assertIntentAuthority(
  expiresAt: string | Date,
  nowMs: number,
  phase: "before_reservation" | "after_reservation" | "before_signing" | "after_signing" | "before_submission",
  signal?: AbortSignal,
): void {
  if (signal?.aborted) throw new LighterIntentRefusal(`cancelled_${phase}`);
  assertIntentUnexpired(expiresAt, nowMs, `consent_expired_${phase}`);
}
