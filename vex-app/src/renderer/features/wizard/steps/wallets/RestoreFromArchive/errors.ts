import type { VexErrorCode } from "@shared/ipc/result.js";

/**
 * Friendly, user-actionable copy for the restore-specific error codes. The
 * restore flow has its own vocabulary (archive integrity, replace-cancel),
 * so it maps codes locally rather than reusing the export-oriented
 * `getErrorCopy` helper. Unknown codes fall back to the redacted main message.
 */
export function restoreErrorMessage(
  code: VexErrorCode,
  fallback: string,
): string {
  switch (code) {
    case "wallet.password_invalid":
      return "Master password is incorrect for this backup.";
    case "wallet.signer_mismatch":
      return "This backup is inconsistent: a restored key does not match its recorded address. The archive may be tampered with or corrupt.";
    case "validation.archive_incomplete":
      return "This backup is incomplete and can't be restored. Choose a different backup.";
    case "validation.archive_manifest_malformed":
      return "This backup's manifest is malformed and can't be read. Choose a different backup.";
    case "wallet.cap_reached":
      return "Restoring this backup would exceed the wallet limit. Remove some wallets first, or choose a smaller backup.";
    case "wallet.user_rejected":
      return "Restore cancelled - the existing wallets were not replaced.";
    case "validation.invalid_input":
      return "That backup could not be selected. Refresh the list and try again.";
    case "onboarding.env_persist_failed":
      // In the archive-restore flow this code is AUTO_BACKUP_FAILED: C1 aborts
      // BEFORE any live write because it could not snapshot the current wallets
      // first. So NOTHING was changed — the copy must say so (not "restored").
      return "Couldn't snapshot your current wallets before restoring, so nothing was changed. Free up disk space (and check folder permissions), then try again.";
    case "wallet.keystore_locked":
      return "Vault session locked. Unlock Vex again, then retry the restore.";
    default:
      return fallback;
  }
}
