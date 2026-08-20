/**
 * Branch: error.failed — Compose up itself failed (Docker daemon died
 * mid-run, image pull failed, lifecycle aborted, etc.). Shows the
 * error message + an expandable "Show recent logs" disclosure that
 * surfaces the last buffered log lines (capped at COMPOSE_LOG_BUFFER_MAX
 * — no full-log IPC yet per codex plan v2 SHOULD-FIX #10).
 */

import { useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";
import { OpenLogsLink } from "../../../../components/common/OpenLogsLink.js";

interface FailedBodyProps {
  readonly message: string;
  readonly recentLogs: readonly string[];
  readonly onRetry: () => void;
}

export function FailedBody({
  message,
  recentLogs,
  onRetry,
}: FailedBodyProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <SetupStatusCard tone="error" title="Compose up failed" detail={message} />

      {recentLogs.length > 0 ? (
        expanded ? (
          <pre className="max-h-40 overflow-auto rounded-lg border border-[var(--color-border)] bg-black/40 p-3 font-mono text-xs leading-relaxed text-ink-primary">
            <code>{recentLogs.join("\n")}</code>
          </pre>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="self-start font-mono text-xs text-[var(--vex-accent-text,var(--color-accent-hover))] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
          >
            Show recent logs ({recentLogs.length} line
            {recentLogs.length === 1 ? "" : "s"})
          </button>
        )
      ) : null}

      <Button size="lg" className="w-full" onClick={onRetry}>
        Try again
      </Button>
      <OpenLogsLink />
    </div>
  );
}
