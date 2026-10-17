/**
 * Branch: noop - schema is already up to date, nothing to apply. The
 * orchestrator's auto-advance effect transitions to the wizard after
 * `NOOP_AUTO_ADVANCE_MS`; this body is a confirmation flash, not
 * content the user needs to read in detail (codex plan v2).
 */

import type { JSX } from "react";

import { SetupStatusCard } from "../../../../components/onboarding/SetupStatusCard.js";

export function NoopBody(): JSX.Element {
  return (
    <SetupStatusCard
      tone="muted"
      state="done"
      word="Up to date"
      title="Schema already up to date"
      detail="Advancing to the setup wizard…"
    />
  );
}
