/**
 * Branch: error - `database.migrate()` resolved to
 * `err({ code: "data.migration_failed", details: { failedAt? } })`.
 * The ink callout carries the message; the failed migration's version/file
 * (if the details payload contained the metadata, via the `extractFailedAt`
 * type guard) stands under it. The "Show N applied before failure"
 * disclosure exposes the migrations that DID complete before the failure
 * (from progress event history captured by the orchestrator - bounded
 * buffer) in the log block.
 */

import { useState, type JSX } from "react";

import { Button } from "../../../../components/ui/button.js";
import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";
import { OpenLogsLink } from "../../../../components/common/OpenLogsLink.js";
import type { FailedAt } from "../types.js";

interface ErrorBodyProps {
  readonly message: string;
  readonly failedAt: FailedAt | null;
  readonly appliedBeforeFailure: readonly string[];
  readonly onRetry: () => void;
}

export function ErrorBody({
  message,
  failedAt,
  appliedBeforeFailure,
  onRetry,
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

      <div className="vex-fr-acts">
        <Button onClick={onRetry} className="w-[420px] max-w-full">
          Retry
        </Button>
        <OpenLogsLink className="vex-fr-link" />
      </div>
    </>
  );
}
