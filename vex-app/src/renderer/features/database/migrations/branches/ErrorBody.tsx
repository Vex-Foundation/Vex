/**
 * Branch: error — `database.migrate()` resolved to
 * `err({ code: "data.migration_failed", details: { failedAt? } })`.
 * Surfaces the message + the failed migration's version/file (if the
 * details payload contained the metadata, via the `extractFailedAt`
 * type guard). The "Show recent applied" disclosure exposes the
 * migrations that DID complete before the failure (from progress
 * event history captured by the orchestrator — bounded buffer).
 */

import { useState } from "react";
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
    <div className="flex flex-col gap-4">
      <SetupStatusCard tone="error" title="Migration failed" detail={message} />

      {failedAt !== null ? (
        <p className="text-xs leading-relaxed text-ink-secondary">
          Failed at migration{" "}
          <span className="font-mono text-ink-primary">
            v{failedAt.version}
          </span>{" "}
          ·{" "}
          <code className="font-mono text-ink-primary">
            {failedAt.file}
          </code>
        </p>
      ) : null}

      {appliedBeforeFailure.length > 0 ? (
        expanded ? (
          <pre className="max-h-40 overflow-auto rounded-lg border border-[var(--color-border)] bg-gate-code p-3 font-mono text-xs leading-relaxed text-ink-primary">
            <code>{appliedBeforeFailure.join("\n")}</code>
          </pre>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="self-start font-mono text-xs text-[var(--vex-accent-text,var(--color-accent-hover))] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
          >
            Show {appliedBeforeFailure.length} applied before failure
          </button>
        )
      ) : null}

      <Button size="lg" className="w-full" onClick={onRetry}>
        Retry
      </Button>
      <OpenLogsLink />
    </div>
  );
}
