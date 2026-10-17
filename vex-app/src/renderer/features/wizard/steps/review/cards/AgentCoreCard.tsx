import type { JSX } from "react";
import { SummaryCard } from "./SummaryCard.js";

export interface AgentCoreCardProps {
  readonly onEdit: () => void;
  readonly editDisabled: boolean;
}

/**
 * envState does not expose AGENT_* tuning values today (those keys are
 * read by the engine at registry build, not surfaced via the M11
 * envState probe). Card therefore renders a non-specific "configured"
 * acknowledgement - operator can re-edit any value via the Edit button.
 */
export function AgentCoreCard({
  onEdit,
  editDisabled,
}: AgentCoreCardProps): JSX.Element {
  return (
    <SummaryCard
      title="Agent core"
      status="info"
      statusLabel="Saved"
      onEdit={onEdit}
      editDisabled={editDisabled}
      testId="agentCore"
    >
      Tuning persisted to <code>.env</code>. Applies on next agent start.
    </SummaryCard>
  );
}
