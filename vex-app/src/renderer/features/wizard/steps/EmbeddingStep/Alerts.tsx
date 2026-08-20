/**
 * EmbeddingStep inline form alerts — validation / server / advance error
 * lines rendered below the fields. Extracted VERBATIM from
 * `EmbeddingStep.tsx` (god-file split); zero behavior change.
 *
 * The generic server-error line is suppressed when the error is a
 * dim-locked or db-unavailable case (those render their own warning
 * panel), preserving the original `!isDimLocked && !isDbDown` gate.
 */

import type { JSX } from "react";
import type { ServerError } from "./form.js";

export interface EmbeddingAlertsProps {
  readonly validationError: string | null;
  readonly serverError: ServerError | null;
  readonly isDimLocked: boolean;
  readonly isDbDown: boolean;
  readonly advanceError: string | null;
}

export function EmbeddingAlerts({
  validationError,
  serverError,
  isDimLocked,
  isDbDown,
  advanceError,
}: EmbeddingAlertsProps): JSX.Element {
  return (
    <>
      {validationError ? (
        <p className="text-sm text-danger" role="alert">
          {validationError}
        </p>
      ) : null}
      {!isDimLocked && !isDbDown && serverError?.message ? (
        <p className="text-sm text-danger" role="alert">
          {serverError.message}
        </p>
      ) : null}
      {advanceError ? (
        <p className="text-sm text-danger" role="alert">
          {advanceError}
        </p>
      ) : null}
    </>
  );
}
