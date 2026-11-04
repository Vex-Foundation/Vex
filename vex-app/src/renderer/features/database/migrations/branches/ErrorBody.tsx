/**
 * Branch: error - `database.migrate()` resolved to
 * `err({ code: "data.migration_failed", details: { failedAt? } })`.
 * The failed status row carries the message; the failed migration's
 * version/file (if the details payload contained the metadata, via the
 * `extractFailedAt` type guard) stands under it. The "Show N applied before
 * failure" disclosure exposes the migrations that DID complete before the
 * failure (from progress event history captured by the orchestrator - bounded
 * buffer) in the log block. Retry is the bottom row's blue key and the logs
 * folder the bottom-left cell's link (`Migrations`).
 */

import { useState, type JSX } from "react";

import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";
import type { FailedAt } from "../types.js";

interface ErrorBodyProps {
  readonly message: string;
  readonly failedAt: FailedAt | null;
  readonly appliedBeforeFailure: readonly string[];
}

export function ErrorBody({
  message,
  failedAt,
  appliedBeforeFailure,
}: ErrorBodyProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <SetupStatusCard tone="error" title="Migration failed" detail={message} />

      {failedAt !== null ? (
        <p className="vex-fr-text">
          Failed at migration{" "}
          <span className="vex-num font-mono text-ink-primary">
            v{failedAt.version}
          </span>{" "}
          ·{" "}
          <code className="vex-num font-mono text-ink-primary">
            {failedAt.file}
          </code>
        </p>
      ) : null}

      {appliedBeforeFailure.length > 0 ? (
        expanded ? (
          <pre className="vex-fr-code">
            <code>{appliedBeforeFailure.join("\n")}</code>
          </pre>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="vex-fr-link"
          >
            Show {appliedBeforeFailure.length} applied before failure
          </button>
        )
      ) : null}
    </>
  );
}
