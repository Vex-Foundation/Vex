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
  | "cancelled"
  // ── funding (phase 2) ──
  /** No Vex Cloud session is stored, or the backend no longer accepts it. */
  | "not_signed_in"
  /** Signed in to a different Vex Cloud account than the one a held request was sent from. */
  | "account_changed"
  /** This build pins no deposit address yet ("Deposits open soon"). */
  | "deposits_not_open"
  /** The pinned deposit address differs from the backend's: funding is disabled. */
  | "deposit_address_mismatch"
  /** The wallet is not one of this app's in-app EVM wallets (any more). */
  | "wallet_not_in_inventory"
  /**
   * The deposit sender is not linked to the signed-in account: Vex Cloud
   * attributes a deposit by its on-chain sender, so VEX from it would land
   * unattributed (or credit the account it is linked to).
   */
  | "sender_not_linked"
  /** The typed amount is not a positive VEX amount with at most 18 decimals. */
  | "invalid_amount"
  /** Under the backend minimum at its current rate. */
  | "below_minimum"
  /** The wallet holds less VEX than the amount, or less ETH than the fee bound. */
  | "insufficient_funds"
  /** The backend has no valid VEX/USD rate, so no minimum can be checked. */
  | "rate_unavailable"
  /** The proposal's own expiry passed; nothing was signed or sent. */
  | "proposal_expired"
  /** No such proposal: already used, never prepared, or dropped. */
  | "proposal_missing"
  /** The submit's figures differ from the approved proposal, or a bound field moved since. */
  | "proposal_changed"
  /** The local runtime is not ready to sign (the execution gate is closed). */
  | "execution_not_ready"
  /** Robinhood Chain could not be read or reached. */
  | "chain_unavailable"
  /** The live network fee is above the approved bound. */
  | "fee_above_bound"
  /** Withdrawal refusals named by the backend (plan 15.2). */
  | "destination_not_linked"
  | "account_paused"
  | "insufficient_withdrawable"
  | "daily_limit_exceeded"
  | "idempotency_key_reused"
  /** A history page cursor the backend no longer accepts. */
  | "invalid_cursor"
  /** No such withdrawal on this account. */
  | "withdrawal_not_found"
  /** The backend refused a cashback destination this build does not offer. */
  | "unsupported_destination"
  /** The backend has no custody configured: withdrawals are not open yet (503 `withdrawals_unavailable`). */
  | "withdrawals_not_open"
  /** The backend has no cancel endpoint (a build from before the cooling period). */
  | "cancel_unsupported"
  /** A withdrawal notice the user dismissed is not (or no longer) one this app raised. */
  | "notice_missing"
  /** A page size the backend refused (400 `invalid_limit`). */
  | "invalid_limit"
  /**
   * The backend refused a field THIS app sent (400 `forbidden_field`,
   * `invalid_field`, `invalid_idempotency_key`): a contract drift between
   * this build and Vex Cloud, never the user's input to fix.
   */
  | "request_rejected"
  // ── agent deposit and auto top-up ──
  /**
   * The agent's deposit needs a human decision: no approval was given, the
   * session is restricted and no active auto top-up rule covers it.
   */
  | "needs_user_approval"
  /** The auto top-up rule changed since it was reviewed, or no longer exists. */
  | "rule_changed"
  /** The rule is paused, revoked, expired, or bound to another account. */
  | "rule_not_active"
  /** The rule's daily count or 30-day VEX cap would be exceeded (unknown outcomes count). */
  | "rule_cap_reached"
  /** An account may hold one live rule; a second one is refused. */
  | "rule_exists"
  /** A rule field is outside its bounds (amount, count, cap, expiry). */
  | "invalid_rule"
  /** The rule already has an execution in flight. */
  | "rule_execution_in_flight"
  /** The deposit's network fee bound is above the rule's user-approved ceiling. */
  | "network_fee_above_limit";

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
  "Vex Inference could not be reached. Check your connection and try again in a moment.";
export const INVALID_RESPONSE_DETAIL =
  "Vex Inference answered in a way this version of Vex does not understand. Nothing was changed; update Vex or try again later.";
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
      case "account_changed":
        return { code: "permissions.denied", retryable: true, userActionable: true };
      case "not_signed_in":
      case "destination_not_linked":
      case "sender_not_linked":
      case "account_paused":
        return { code: "permissions.denied", retryable: false, userActionable: true };
      case "deposits_not_open":
      case "deposit_address_mismatch":
        return { code: "wallet.policy_blocked", retryable: false, userActionable: false };
      case "daily_limit_exceeded":
        return { code: "wallet.policy_blocked", retryable: false, userActionable: true };
      case "fee_above_bound":
        return { code: "wallet.policy_blocked", retryable: true, userActionable: true };
      case "wallet_not_in_inventory":
        return { code: "wallets.invalid_selection", retryable: false, userActionable: true };
      case "invalid_amount":
      case "below_minimum":
      case "invalid_cursor":
      case "withdrawal_not_found":
        return { code: "validation.invalid_input", retryable: false, userActionable: true };
      case "proposal_changed":
        return { code: "validation.invalid_input", retryable: true, userActionable: true };
      case "insufficient_funds":
      case "insufficient_withdrawable":
        return { code: "wallet.insufficient_funds", retryable: false, userActionable: true };
      case "rate_unavailable":
      case "chain_unavailable":
        return { code: "provider.unavailable", retryable: true, userActionable: true };
      case "proposal_expired":
        return { code: "approvals.expired", retryable: true, userActionable: true };
      case "proposal_missing":
        return { code: "approvals.already_resolved", retryable: true, userActionable: true };
      case "execution_not_ready":
        return { code: "services.runtime_starting", retryable: true, userActionable: true };
      case "idempotency_key_reused":
      case "unsupported_destination":
      case "request_rejected":
        return { code: "internal.unexpected", retryable: false, userActionable: false };
      case "withdrawals_not_open":
      case "cancel_unsupported":
        return { code: "wallet.policy_blocked", retryable: false, userActionable: false };
      case "notice_missing":
        return { code: "validation.invalid_input", retryable: false, userActionable: true };
      case "invalid_limit":
        return { code: "validation.invalid_input", retryable: false, userActionable: false };
      case "needs_user_approval":
        return { code: "permissions.denied", retryable: true, userActionable: true };
      case "rule_changed":
        return { code: "validation.invalid_input", retryable: true, userActionable: true };
      case "rule_not_active":
      case "rule_cap_reached":
        return { code: "wallet.policy_blocked", retryable: false, userActionable: true };
      case "rule_exists":
      case "invalid_rule":
        return { code: "validation.invalid_input", retryable: false, userActionable: true };
      case "rule_execution_in_flight":
        return { code: "validation.invalid_input", retryable: true, userActionable: true };
      case "network_fee_above_limit":
        return { code: "wallet.policy_blocked", retryable: true, userActionable: true };
    }
  })();
  return { ...shape, domain, message: refusal.detail, redacted: true, correlationId };
}
