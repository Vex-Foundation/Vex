/**
 * Branch: error.unhealthy — Compose came up but one of the containers
 * failed its health probe (e.g., Postgres started but won't accept
 * connections, or embeddings runtime didn't reach 200 OK on /health
 * within the probe budget). Usually a flake; retry resolves it.
 */

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
    <div className="flex flex-col gap-4">
      <SetupStatusCard
        tone="warn"
        word="Unhealthy"
        title="Service started but health probe failed"
        detail={message}
      />
      <p className="text-xs leading-relaxed text-ink-secondary">
        This usually clears after a short wait while the container
        warms up. Click Try again to re-probe the stack.
      </p>
      <Button size="lg" className="w-full" onClick={onRetry}>
        Try again
      </Button>
      <OpenLogsLink />
    </div>
  );
}
