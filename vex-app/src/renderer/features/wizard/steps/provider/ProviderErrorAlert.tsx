/**
 * Failure alert for a `providerPersist` call.
 *
 * Extracted so the first-run form and the configured screen's delta-save
 * editor render the SAME failure surface from one owner — two copies would
 * drift, and this block encodes a security contract: only FIXED per-code copy
 * is shown. A raw SDK message is never surfaced (codex turn 3 YELLOW), and the
 * only provider-supplied string that reaches the DOM is the errno-shaped
 * `causeCode` main already narrowed.
 */

import type { JSX } from "react";
import { CAUSE_HINTS, uiCopyFor, type ServerError } from "./error-ui.js";

export interface ProviderErrorAlertProps {
  readonly error: ServerError;
  /** Opens the OS logs folder — the caller owns the bridge call. */
  readonly onOpenLogsFolder: () => void;
}

export function ProviderErrorAlert({
  error,
  onOpenLogsFolder,
}: ProviderErrorAlertProps): JSX.Element {
  const copy = uiCopyFor(String(error.code));
  return (
    <div
      role="alert"
      data-vex-provider-error={String(error.code)}
      className="border-l-2 border-[color-mix(in_oklab,var(--color-danger)_45%,transparent)] py-1 pl-3 text-sm text-[var(--color-danger)]"
    >
      <strong className="block font-semibold">{copy.title}</strong>
      <p className="mt-1">{copy.body}</p>
      {error.causeCode !== null ? (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          Cause: <code className="font-mono">{error.causeCode}</code>
        </p>
      ) : null}
      {error.causeCode !== null &&
      CAUSE_HINTS[error.causeCode] !== undefined ? (
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          {CAUSE_HINTS[error.causeCode]}
        </p>
      ) : null}
      {error.correlationId ? (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          Correlation id:{" "}
          <code className="font-mono">{error.correlationId}</code>{" "}
          <button
            type="button"
            onClick={onOpenLogsFolder}
            className="text-[var(--color-text-primary)] underline underline-offset-2 hover:text-[var(--color-text-secondary)]"
          >
            Open logs folder
          </button>
        </p>
      ) : null}
    </div>
  );
}
