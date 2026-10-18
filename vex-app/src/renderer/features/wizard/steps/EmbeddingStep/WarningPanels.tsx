/**
 * EmbeddingStep server-error warning panels - extracted VERBATIM from
 * `EmbeddingStep.tsx` (god-file split); zero behavior change.
 *
 * Error rendering is specialised by VexErrorCode:
 *   - embedding.dim_locked → warning card with the existing/target row
 *     count + "memory unavailable" guidance.
 *   - embedding.db_unavailable → retry card with hint to verify the
 *     System Check screen first.
 *
 * Both are the risk callout (`.vex-callout`, set by `RAIL_*_CHROME`): the
 * callout owns its frame, type size and ink, so only spacing is added here.
 */

import type { JSX } from "react";
import {
  RAIL_DANGER_CHROME,
  RAIL_WARNING_CHROME,
} from "../step-chrome.js";
import type { ServerError } from "./form.js";

export interface EmbeddingWarningPanelsProps {
  readonly isDimLocked: boolean;
  readonly isDbDown: boolean;
  readonly serverError: ServerError | null;
}

export function EmbeddingWarningPanels({
  isDimLocked,
  isDbDown,
  serverError,
}: EmbeddingWarningPanelsProps): JSX.Element {
  return (
    <>
      {isDimLocked && serverError?.details ? (
        <div
          role="alert"
          data-vex-embedding-warning="dim-locked"
          className={RAIL_DANGER_CHROME}
        >
          <strong className="block font-medium">Dim change blocked.</strong>
          <p className="mt-1">
            {serverError.details.existingRowCount} existing long-term memory
            entries use a different embedding dimension. Changing to
            dim={serverError.details.targetDim} would make them
            unavailable.
          </p>
          <p className="mt-2 text-[13px] text-ink-secondary">
            Safe path: export your memory first, clear the stored entries,
            then change the dimension and re-import.
          </p>
        </div>
      ) : null}
      {isDbDown ? (
        <div
          role="alert"
          data-vex-embedding-warning="db-unavailable"
          className={RAIL_WARNING_CHROME}
        >
          <strong className="block font-medium">
            Database unavailable.
          </strong>
          <p className="mt-1">{serverError?.message}</p>
          <p className="mt-2 text-[13px] text-ink-secondary">
            Verify Docker services are running, then retry.
          </p>
        </div>
      ) : null}
    </>
  );
}
