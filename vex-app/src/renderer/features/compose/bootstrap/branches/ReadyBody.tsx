/**
 * Branch: ready - Compose came back with kind="running" or "reused".
 * A quiet card with the word Ready; the Continue lives in the
 * orchestrator's actions.
 */

import type { JSX } from "react";

import type { ComposeUpResult } from "@shared/schemas/docker.js";
import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";

interface ReadyBodyProps {
  readonly result: ComposeUpResult;
}

export function ReadyBody({ result }: ReadyBodyProps): JSX.Element {
  const detail =
    result.kind === "reused"
      ? "Existing stack reused - services already healthy."
      : (result.message ?? "All services started and answered health checks.");

  return (
    <SetupStatusCard
      tone="ok"
      word="Ready"
      title={result.kind === "reused" ? "Stack reused" : "All services ready"}
      detail={detail}
    />
  );
}
