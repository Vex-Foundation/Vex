/**
 * Branch: error.unhealthy - Compose came up but one of the containers
 * failed its health probe (e.g., Postgres started but won't accept
 * connections, or embeddings runtime didn't reach 200 OK on /health
 * within the probe budget). Usually a flake; retry resolves it. It is a
 * failure the user acts on, so it is the ink callout.
 */

import type { JSX } from "react";

import { Button } from "../../../../components/ui/button.js";
import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";
import { OpenLogsLink } from "../../../../components/common/OpenLogsLink.js";

interface UnhealthyBodyProps {
  readonly message: string;
  readonly onRetry: () => void;
}

export function UnhealthyBody({
  message,
  onRetry,
}: UnhealthyBodyProps): JSX.Element {
  return (
    <>
      <SetupStatusCard
        tone="error"
        title="Service started but health probe failed"
        detail={message}
      />
      <p className="vex-fr-text">
        This usually clears after a short wait while the container
        warms up. Click Try again to re-probe the stack.
      </p>
      <div className="vex-fr-acts">
        <Button onClick={onRetry} className="w-[420px] max-w-full">
          Try again
        </Button>
        <OpenLogsLink className="vex-fr-link" />
      </div>
    </>
  );
}
