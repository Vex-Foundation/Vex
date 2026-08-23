/**
 * Branch A — engine + daemon running. The orchestrator's footer flips
 * the Recheck button to a Continue button so this body only needs the
 * "ready" status stanza.
 */

import type { DockerStatus } from "@shared/schemas/docker.js";
import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";

interface ReadyBodyProps {
  readonly status: DockerStatus | null;
}

export function ReadyBody({ status }: ReadyBodyProps): JSX.Element {
  const state = status?.engine.state ?? null;
  const engine =
    state !== null && state.kind !== "not_installed" && status?.engine.version
      ? `Engine ${status.engine.version}`
      : "Engine detected";
  const compose =
    status?.compose.present && status.compose.version
      ? `Compose ${status.compose.version}`
      : "Compose plugin present";
  const daemon = state?.kind === "ready" ? "Daemon up" : "Daemon idle";
  return (
    <SetupStatusCard
      tone="ok"
      word="Ready"
      title="Docker is ready"
      detail={`${engine} · ${daemon} · ${compose}`}
    />
  );
}
