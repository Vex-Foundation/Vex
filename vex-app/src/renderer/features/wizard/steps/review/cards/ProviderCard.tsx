import type { JSX } from "react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import { SummaryCard } from "./SummaryCard.js";

export interface ProviderCardProps {
  readonly envState: EnvState;
  readonly onEdit: () => void;
  readonly editDisabled: boolean;
}

export function ProviderCard({
  envState,
  onEdit,
  editDisabled,
}: ProviderCardProps): JSX.Element {
  const p = envState.provider;
  // Optional-connections model: the provider never blocks finalize, but
  // it carries the strongest consequence - without it the agent cannot
  // run inference. Surface that as a warning, not a hard miss.
  return (
    <SummaryCard
      title="Inference provider"
      status={p.configured ? "ok" : "warning"}
      statusLabel={
        p.configured ? p.name ?? "configured" : "Agent can't run"
      }
      onEdit={onEdit}
      editDisabled={editDisabled}
      testId="provider"
    >
      {p.configured && p.modelLabel ? (
        <span>Model: {p.modelLabel}</span>
      ) : p.configured ? null : (
        <span>The agent stays idle until a provider is configured.</span>
      )}
    </SummaryCard>
  );
}
