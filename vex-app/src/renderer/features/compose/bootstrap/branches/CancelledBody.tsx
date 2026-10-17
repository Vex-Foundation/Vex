/**
 * Branch: error.cancelled - user clicked Cancel and the IPC returned
 * `internal.cancelled`. A calm card, not a failure.
 */

import type { JSX } from "react";

import { Button } from "../../../../components/ui/button.js";
import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";

interface CancelledBodyProps {
  readonly onRetry: () => void;
}

export function CancelledBody({ onRetry }: CancelledBodyProps): JSX.Element {
  return (
    <>
      <SetupStatusCard
        tone="muted"
        word="Cancelled"
        state="sleeping"
        title="Startup cancelled."
        detail="Startup was cancelled before onboarding continued. Try again to reconcile the local stack."
      />
      <Button onClick={onRetry} className="w-[420px] max-w-full">
        Retry
      </Button>
    </>
  );
}
