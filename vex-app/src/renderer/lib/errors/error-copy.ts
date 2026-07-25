/**
 * Renderer-side mapping from `VexError` to user-facing copy.
 *
 * Centralises the message + auto-close hint for every error code so the same
 * UX text doesn't drift across modals (ExportPrivateKeyModal, UnlockScreen,
 * …). The helper returns ONLY copy — workflow decisions (bubble a confirm
 * modal, route the user to the unlock screen, retry the IPC) stay in the
 * caller. Codes that need special workflow handling are documented per-case
 * below; callers branch on the code first, then fall through to this helper
 * for the message.
 */
import type { VexError } from "@shared/ipc/result.js";

export type ErrorChain = "evm" | "solana";

export interface ErrorCopyContext {
  /**
   * Wallet chain to specialise wallet-keystore messages (e.g. "EVM key not
   * found for Solana export"). Omit for generic copy.
   */
  readonly chain?: ErrorChain;
}

export interface ErrorCopy {
  /** Plain message string the caller renders inline / in a modal body. */
  readonly message: string;
  /**
   * Optional auto-close hint, in milliseconds, for transient routing errors
   * (e.g. `wallet.keystore_locked` after the vault relocked between unlock
   * and use). When set, the caller may dismiss its modal after this delay so
   * the user lands on the global unlock screen. When absent, the caller
   * keeps the error inline until the user takes an action.
   */
  readonly autoCloseMs?: number;
}

function chainLabel(chain: ErrorChain): string {
  return chain === "evm" ? "EVM" : "Solana";
}

/**
 * Format a backoff hint expressed in milliseconds as a user-readable
 * "Xs" / "Xm" string. Floors to 1s so a 1-ms hint doesn't render as 0s.
 */
function formatBackoff(retryAfterMs: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}

const AUTO_CLOSE_AFTER_SESSION_LOCK_MS = 3000;

export function getErrorCopy(
  error: VexError,
  ctx: ErrorCopyContext = {},
): ErrorCopy {
  switch (error.code) {
    case "wallet.password_invalid":
      return { message: "Master password is incorrect." };
    case "wallet.export_throttled":
    case "secrets.unlock_throttled": {
      const wait = formatBackoff(error.retryAfterMs ?? 0);
      return { message: `Too many attempts. Try again in ${wait}.` };
    }
    case "wallet.keystore_locked":
      return {
        message:
          "Vault session locked. Close this window and unlock Vex again.",
        autoCloseMs: AUTO_CLOSE_AFTER_SESSION_LOCK_MS,
      };
    case "wallet.keystore_missing":
      return {
        message: ctx.chain
          ? `${chainLabel(ctx.chain)} wallet keystore not found.`
          : "Wallet keystore not found. Generate or import a wallet first.",
      };
    case "wallet.keystore_corrupt":
      return { message: "Wallet keystore is corrupt." };
    case "wallet.vault_not_configured":
      return {
        message: "Master password is not configured. Complete setup first.",
      };
    case "provider.unavailable":
      return {
        message: "The connected provider is temporarily unavailable. Try again in a moment.",
      };
    case "onboarding.env_persist_failed":
      return { message: "Failed to save credentials to vault." };
    default:
      // Trust the backend-supplied message as a safe fallback — main has
      // already redacted it (`redacted: true` invariant enforced by
      // `registerHandler`).
      return { message: error.message };
  }
}
