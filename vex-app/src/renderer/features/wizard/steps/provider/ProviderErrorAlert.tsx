/**
 * Failure alert for a `providerPersist` call.
 *
 * Extracted so the first-run form and the configured screen's delta-save
 * editor render the SAME failure surface from one owner - two copies would
 * drift, and this block encodes a security contract: only FIXED per-code copy
 * is shown. A raw SDK message is never surfaced (codex turn 3 YELLOW), and the
 * only provider-supplied string that reaches the DOM is the errno-shaped
 * `causeCode` main already narrowed.
 */

import type { JSX } from "react";
import { CAUSE_HINTS, uiCopyFor, type ServerError } from "./error-ui.js";
import { RAIL_DANGER_CHROME } from "../step-chrome.js";

export interface ProviderErrorAlertProps {
  readonly error: ServerError;
  /** Opens the OS logs folder - the caller owns the bridge call. */
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
      className={RAIL_DANGER_CHROME}
    >
      <strong className="block font-medium">{copy.title}</strong>
      <p className="mt-1">{copy.body}</p>
      {error.causeCode !== null ? (
        <p className="mt-2 text-[13px] text-ink-secondary">
          Cause: <code className="font-mono vex-num">{error.causeCode}</code>
        </p>
      ) : null}
      {error.causeCode !== null &&
      CAUSE_HINTS[error.causeCode] !== undefined ? (
        <p className="mt-1 text-[13px] text-ink-secondary">
          {CAUSE_HINTS[error.causeCode]}
        </p>
      ) : null}
      {error.correlationId ? (
        <p className="mt-2 text-[12.5px] text-ink-tertiary">
          Correlation id:{" "}
          <code className="font-mono vex-num">{error.correlationId}</code>{" "}
          <button
            type="button"
            onClick={onOpenLogsFolder}
            className="vex-wz-link"
          >
            Open logs folder
          </button>
        </p>
      ) : null}
    </div>
  );
}
