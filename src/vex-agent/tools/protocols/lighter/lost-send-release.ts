import { LIGHTER_SIGNED_TX_MAX_EXPIRY_LEAD_MS } from "@tools/lighter/signed-tx-expiry.js";

/** Margin past the signed expiry before an unconsumed nonce is released. */
export const LIGHTER_LOST_SEND_RELEASE_GRACE_MS = 10 * 60_000;

/**
 * When a create-order or grouped-order send that may have left Vex, and whose
 * reserved nonce Lighter has still not consumed, can no longer execute.
 *
 * Lighter consumes the nonce of every transaction it executes, so an
 * unconsumed nonce proves this one has not executed yet; once its signed
 * `ExpiredAt` has passed, the sequencer refuses it, so it never will. The
 * grace absorbs clock skew between this machine and the sequencer.
 *
 * With the signed expiry recorded, that is the bound. A row signed before it
 * was recorded is bounded by its consent expiry instead: every signing path
 * refuses to sign after consent expires (`assertAuthority("before_signing")`),
 * and the signer set `ExpiredAt` at signing time plus at most
 * `LIGHTER_SIGNED_TX_MAX_EXPIRY_LEAD_MS`, the SDK default the signer-runtime
 * test pins. Returns `null` when neither is usable, so nothing is released.
 */
export function lighterLostSendReleaseAtMs(intent: {
  readonly signerExpiryMs?: number | null;
  readonly expiresAt: string | Date;
}): number | null {
  if (intent.signerExpiryMs != null) {
    return Number.isSafeInteger(intent.signerExpiryMs)
      ? intent.signerExpiryMs + LIGHTER_LOST_SEND_RELEASE_GRACE_MS
      : null;
  }
  const consentExpiryMs = intent.expiresAt instanceof Date
    ? intent.expiresAt.getTime()
    : Date.parse(intent.expiresAt);
  return Number.isFinite(consentExpiryMs)
    ? consentExpiryMs + LIGHTER_SIGNED_TX_MAX_EXPIRY_LEAD_MS + LIGHTER_LOST_SEND_RELEASE_GRACE_MS
    : null;
}
