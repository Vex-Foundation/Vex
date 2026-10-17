/**
 * Branch: ready - `database.migrate()` returned `kind: "applied"`.
 * A quiet card with the word Applied; the Continue lives in the
 * orchestrator's actions.
 */

import type { JSX } from "react";

import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";

interface ReadyBodyProps {
  readonly appliedCount: number;
}

export function ReadyBody({ appliedCount }: ReadyBodyProps): JSX.Element {
  const word = appliedCount === 1 ? "migration" : "migrations";
  const detail = `${appliedCount} ${word} applied - schema is up to date.`;

  return (
    <SetupStatusCard
      tone="ok"
      word="Applied"
      title="Schema updated"
      detail={detail}
    />
  );
}
