/**
 * Branch: ready — `database.migrate()` returned `kind: "applied"`.
 * A quiet success stanza; the paper-pill Continue lives in the
 * orchestrator footer. (The NOTARY-era celebration glint is retired —
 * the green word is the celebration.)
 */

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
