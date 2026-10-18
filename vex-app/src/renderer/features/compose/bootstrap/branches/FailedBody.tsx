/**
 * Branch: error.failed - Compose up itself failed (Docker daemon died
 * mid-run, image pull failed, lifecycle aborted, etc.). The ink callout says
 * what failed and why, and the recent log lines (capped at
 * COMPOSE_LOG_BUFFER_MAX - no full-log IPC yet per codex plan v2
 * SHOULD-FIX #10) stand under it in the log block, so the cause is on the
 * screen without a click (`docs/design/R3-MINIMAL.md section 10.3`).
 */

import type { JSX } from "react";

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
  return (
    <>
      <SetupStatusCard tone="error" title="Compose up failed" detail={message} />

      {recentLogs.length > 0 ? (
        <div className="flex w-full flex-col gap-2">
          <p className="vex-fr-eyebrow">
            Recent logs ({recentLogs.length} line
            {recentLogs.length === 1 ? "" : "s"})
          </p>
          <pre className="vex-fr-code">
            <code>{recentLogs.join("\n")}</code>
          </pre>
        </div>
      ) : null}

      <div className="vex-fr-acts">
        <Button onClick={onRetry} className="w-[420px] max-w-full">
          Try again
        </Button>
        <OpenLogsLink className="vex-fr-link" />
      </div>
    </>
  );
}
