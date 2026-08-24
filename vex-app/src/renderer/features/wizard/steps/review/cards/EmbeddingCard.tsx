import type { JSX } from "react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import { SummaryCard } from "./SummaryCard.js";

export interface EmbeddingCardProps {
  readonly envState: EnvState;
  readonly onEdit: () => void;
  readonly editDisabled: boolean;
}

export function EmbeddingCard({
  envState,
  onEdit,
  editDisabled,
}: EmbeddingCardProps): JSX.Element {
  const e = envState.embeddings;
  // Optional-connections model: embeddings never block finalize. Not
  // configured is a warning (no memory / semantic search), not a hard miss.
  const status = e.allFieldsConfigured ? "ok" : "warning";
  return (
    <SummaryCard
      title="Embedding"
      status={status}
      statusLabel={
        status === "ok"
          ? e.reachable
            ? "Configured · reachable"
            : "Configured · not reachable"
          : "Not configured"
      }
      onEdit={onEdit}
      editDisabled={editDisabled}
      testId="embedding"
    >
      {e.allFieldsConfigured ? (
        <span>Endpoint: {e.baseUrlRedacted ?? "-"}</span>
      ) : (
        <span>Memory and semantic search stay off until configured.</span>
      )}
    </SummaryCard>
  );
}
