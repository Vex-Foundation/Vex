import type { JSX } from "react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import { SummaryCard } from "./SummaryCard.js";

export interface ApiKeysCardProps {
  readonly envState: EnvState;
  readonly onEdit: () => void;
  readonly editDisabled: boolean;
}

export function ApiKeysCard({
  envState,
  onEdit,
  editDisabled,
}: ApiKeysCardProps): JSX.Element {
  const k = envState.apiKeys;
  // Optional-connections model: API keys never block finalize. Jupiter
  // unconfigured is a warning (Solana swaps unavailable), not a hard miss.
  const status = k.jupiterConfigured ? "ok" : "warning";
  const items: string[] = [];
  items.push(
    `Jupiter: ${k.jupiterConfigured ? "set" : "not set — Solana swaps unavailable"}`,
  );
  items.push(`Tavily: ${k.tavilyConfigured ? "set" : "—"}`);
  items.push(`Rettiwt: ${k.rettiwtConfigured ? "set" : "—"}`);
  items.push(`Relay: ${k.relayConfigured ? "set" : "—"}`);
  return (
    <SummaryCard
      title="API keys"
      status={status}
      statusLabel={status === "ok" ? "Configured" : "Jupiter not set"}
      onEdit={onEdit}
      editDisabled={editDisabled}
      testId="apiKeys"
    >
      <ul className="m-0 list-none p-0">
        {items.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </SummaryCard>
  );
}
