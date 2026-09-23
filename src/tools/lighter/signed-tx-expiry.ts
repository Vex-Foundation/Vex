/**
 * The wire expiry a signed Lighter create-order or grouped-order transaction
 * carries, read from the official signer's own `txInfo`.
 *
 * Vex does not pass `ExpiredAt` for these transaction types. The official SDK
 * (lighter-go v1.0.7, `FullFillDefaultOps`) fills it with signing time + 9m59s,
 * and it is part of the signed hash, so the sequencer refuses the transaction
 * once it passes. That makes it the proof a lost send needs: once it has passed
 * and the reserved nonce is still unconsumed, nothing carrying that nonce can
 * execute. Before this was read, nothing recorded it and a lost send held the
 * account's nonce forever.
 *
 * Returns `null` when the info carries no `ExpiredAt` at all; recovery then
 * falls back to the consent-expiry bound, which rests on the same SDK default.
 * Throws when the evidence contradicts that default: a duplicated or
 * non-integer field, or an expiry further out than the default window. That
 * means the SDK changed under us and every bound built on its default would be
 * wrong, so the order is refused before it is sent.
 */
export const LIGHTER_SIGNED_TX_MAX_EXPIRY_LEAD_MS = 10 * 60_000;

export function readLighterSignedTxExpiredAtMs(txInfo: string, signedAtMs: number): number | null {
  const matches = [...txInfo.matchAll(/"ExpiredAt"\s*:\s*([^,}\s]+)/g)];
  if (matches.length === 0) return null;
  const raw = matches.length === 1 ? matches[0]?.[1] : undefined;
  const expiredAtMs = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(expiredAtMs) || expiredAtMs <= 0) {
    throw new Error("Lighter signed transaction info does not carry exactly one integer ExpiredAt.");
  }
  if (expiredAtMs > signedAtMs + LIGHTER_SIGNED_TX_MAX_EXPIRY_LEAD_MS) {
    throw new Error("Lighter signed transaction expiry lies beyond the signer's default window.");
  }
  return expiredAtMs;
}
