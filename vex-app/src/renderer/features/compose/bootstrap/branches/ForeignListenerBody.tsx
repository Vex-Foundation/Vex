/**
 * Branch: error.foreign_listener - the local Postgres port this install
 * publishes is answered by a database that is not this install's. Vex
 * stops here rather than migrating or writing into another install's
 * data, so the copy must not read as a flake: retrying alone does not
 * clear it, and Vex will not stop the other stack on the user's behalf.
 */

import type { JSX } from "react";

import { Button } from "../../../../components/ui/button.js";
import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";
import { OpenLogsLink } from "../../../../components/common/OpenLogsLink.js";

interface ForeignListenerBodyProps {
  readonly message: string;
  readonly onRetry: () => void;
}

export function ForeignListenerBody({
  message,
  onRetry,
}: ForeignListenerBodyProps): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <SetupStatusCard
        tone="error"
        word="Blocked"
        title="Another database owns this port"
        detail={message}
      />
      <p className="text-xs leading-relaxed text-ink-secondary">
        Vex stopped before touching that database: it belongs to another
        Vex installation or another Postgres, and writing to it could
        damage its data. Stop the database that holds the port, then try
        again. On Windows this happens when Docker Desktop and a second
        Docker environment (WSL2 with mirrored networking) both publish
        the same loopback port, and quitting one of them frees it.
      </p>
      <Button size="lg" className="w-full" onClick={onRetry}>
        Try again
      </Button>
      <OpenLogsLink />
    </div>
  );
}
