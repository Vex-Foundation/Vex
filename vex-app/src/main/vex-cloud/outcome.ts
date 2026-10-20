/**
 * The named outcomes of the Vex Cloud owner, before the IPC layer maps them
 * onto existing wire codes (`main/ipc/vex-cloud.ts`). Each refusal carries
 * the sentence the user reads: what did not happen, and what to do next.
 */

import type { VexDomain, VexError } from "@shared/ipc/result.js";

export type VexCloudRefusalKind =
  /** The vault is locked or unreadable; the vault's own error is carried whole. */
  | "vault"
  /** No in-app EVM wallet exists to sign with. */
  | "no_wallets"
  /** The inventory differs from the wallets the user consented with. */
  | "wallet_set_changed"
  /** The server's challenge did not match the host the app dialed, or the template. Nothing was signed. */
  | "challenge_rejected"
  /** The backend refused the signatures (401/403). */
  | "sign_in_rejected"
  /** A wallet is already linked to another Vex Cloud account. */
  | "wallet_linked_elsewhere"
  /** The wallets belong to different accounts; accounts are never merged automatically. */
  | "wallets_span_accounts"
  /** A decrypted key did not derive its recorded address. */
  | "signer_mismatch"
  /** Another sign-in is already running. */
  | "already_running"
  /** Network, deadline or a server error. */
  | "unavailable"
  /** The server answered off contract. */
  | "invalid_response"
  /** The caller cancelled. */
  | "cancelled";

export interface VexCloudRefusal {
  readonly kind: VexCloudRefusalKind;
  readonly detail: string;
  /** Present for `vault`: the session layer's own typed error. */
  readonly vaultError?: VexError;
}

export type VexCloudOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: VexCloudRefusal };

export function refused<T>(kind: VexCloudRefusalKind, detail: string, vaultError?: VexError): VexCloudOutcome<T> {
  return { ok: false, refusal: { kind, detail, ...(vaultError !== undefined && { vaultError }) } };
}

/** Sentences for the transport failures every Vex Cloud call can hit. */
export const UNAVAILABLE_DETAIL =
  "Vex Cloud could not be reached. Check your connection and try again in a moment.";
export const INVALID_RESPONSE_DETAIL =
  "Vex Cloud answered in a way this version of Vex does not understand. Nothing was changed; update Vex or try again later.";
export const CANCELLED_DETAIL = "Cancelled. Nothing was stored.";

/**
 * A named refusal as an EXISTING wire code (no new `VexErrorCode`, the
 * `poolsLaunch` precedent), carrying its own sentence. A vault refusal keeps
 * the vault's own typed error (locked, corrupt) whole.
 */
export function vexCloudRefusalError(
  refusal: VexCloudRefusal,
  correlationId: string,
  domain: VexDomain = "vexCloud",
): VexError {
  if (refusal.kind === "vault" && refusal.vaultError !== undefined) {
    return { ...refusal.vaultError, domain, correlationId };
  }
  const shape = ((): Pick<VexError, "code" | "retryable" | "userActionable"> => {
    switch (refusal.kind) {
      case "vault":
        return { code: "wallet.keystore_locked", retryable: false, userActionable: true };
      case "no_wallets":
        return { code: "wallets.invalid_selection", retryable: false, userActionable: true };
      case "wallet_set_changed":
        return { code: "wallets.invalid_selection", retryable: true, userActionable: true };
      case "sign_in_rejected":
        return { code: "permissions.denied", retryable: true, userActionable: true };
      case "wallet_linked_elsewhere":
      case "wallets_span_accounts":
        return { code: "permissions.denied", retryable: false, userActionable: true };
      case "signer_mismatch":
        return { code: "wallet.signer_mismatch", retryable: false, userActionable: true };
      case "already_running":
        return { code: "validation.invalid_input", retryable: true, userActionable: true };
      case "unavailable":
        return { code: "provider.unavailable", retryable: true, userActionable: true };
      case "cancelled":
        return { code: "internal.cancelled", retryable: true, userActionable: false };
      // OUR check refused the server's answer, not the user's input.
      case "challenge_rejected":
      case "invalid_response":
        return { code: "internal.unexpected", retryable: false, userActionable: false };
    }
  })();
  return { ...shape, domain, message: refusal.detail, redacted: true, correlationId };
}
