/**
 * Branch: error.port_collision - Compose detected a port already in use
 * (typical: Postgres :5432 already running on host, or a stale Vex
 * stack from a previous install holding :27432). Generic conflicts retain
 * manual guidance; inspect-authorized previous Vex containers get an explicit
 * stop-only action whose success automatically retries compose startup.
 */

import type { JSX } from "react";

import { Button } from "../../../../components/ui/button.js";
import { ErrorCallout } from "../../../../components/ui/error-callout.js";
import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";
import { OpenLogsLink } from "../../../../components/common/OpenLogsLink.js";

interface PortCollisionBodyProps {
  readonly message: string;
  readonly previousInstallHoldingPorts: boolean;
  readonly stoppingPreviousInstall: boolean;
  readonly stopPreviousInstallError: string | null;
  readonly onStopPreviousInstall: () => void;
  readonly onRetry: () => void;
}

export function PortCollisionBody({
  message,
  previousInstallHoldingPorts,
  stoppingPreviousInstall,
  stopPreviousInstallError,
  onStopPreviousInstall,
  onRetry,
}: PortCollisionBodyProps): JSX.Element {
  return (
    <>
      <SetupStatusCard
        tone="error"
        title="Port already in use"
        detail={message}
      />
      {previousInstallHoldingPorts ? (
        <>
          <p className="vex-fr-text">
            Containers from a previous Vex installation are holding the ports.
            Vex will stop only the inspected containers publishing the required
            ports.
          </p>
          {stopPreviousInstallError !== null ? (
            <ErrorCallout compact role="alert" title={stopPreviousInstallError} />
          ) : null}
          <Button
            variant="ink"
            disabled={stoppingPreviousInstall}
            onClick={onStopPreviousInstall}
            className="w-[420px] max-w-full"
          >
            {stoppingPreviousInstall
              ? "Stopping previous Vex services…"
              : "Stop previous Vex services"}
          </Button>
        </>
      ) : (
        <>
          <p className="vex-fr-text">
            Stop the conflicting process (another Postgres or Vex install may be
            holding the port) and click Try again. Vex needs free local ports for
            the bundled Postgres + embeddings runtime.
          </p>
          <Button onClick={onRetry} className="w-[420px] max-w-full">
            Try again
          </Button>
        </>
      )}
      <OpenLogsLink className="vex-fr-link" />
    </>
  );
}
