/**
 * Branch: ready — Compose came back with kind="running" or "reused".
 * A quiet success stanza; the paper-pill Continue lives in the
 * orchestrator footer. (The NOTARY-era celebration glint is retired —
 * the green word is the celebration.)
 */

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
