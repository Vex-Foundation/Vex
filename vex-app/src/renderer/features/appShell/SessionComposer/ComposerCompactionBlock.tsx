/**
 * Compaction block inside the context meter's panel.
 *
 * OWNERSHIP NOTE. This is not new capability. The retired `SessionRuntimeCard`
 * (BOOK rail, removed in round 3 per owner QA item 1) was the ONLY renderer
 * mount of `CompactionApplyButton` - the single renderer-initiated context
 * mutation in the app - and the only mount of the compaction/preparation live
 * syncs. Deleting the card without a new host would have silently deleted that
 * affordance, which the owner did not ask for. The context meter is the
 * correct new owner: compaction is a CONTEXT-PRESSURE action, and this panel is
 * now the context-pressure surface.
 *
 * The card's cost/usage/model lines did NOT move here: transcript turn stats
 * remain the cost surface.
 */

import type { JSX } from "react";
import type { SessionPermission } from "@shared/schemas/sessions.js";
import type { CompactionStatusDto } from "@shared/schemas/compaction.js";
import {
  useCompactionLiveSync,
  useCompactionStatus,
} from "../../../lib/api/compaction.js";
import {
  usePreparation,
  usePreparationLiveSync,
} from "../../../lib/api/compaction-preparation.js";
import { StateDot } from "../../../components/ui/state-dot.js";
import { CompactionApplyButton } from "../CompactionApplyButton.js";

const COMPACTION_REMOTE_NOTE =
  "Builds session memory from older messages via your OpenRouter model; " +
  "the transcript is redacted before it is sent.";

export function ComposerCompactionBlock({
  sessionId,
  permission,
}: {
  readonly sessionId: string;
  /**
   * Session permission from the composer's own session row. Session-STATIC
   * (locked at creation), so a prop cannot go stale and this block adds no
   * query for one enum.
   */
  readonly permission: SessionPermission | null;
}): JSX.Element | null {
  useCompactionLiveSync(sessionId);
  usePreparationLiveSync(sessionId);

  const compactionQuery = useCompactionStatus(sessionId);
  const preparationQuery = usePreparation(sessionId);
  const compaction = compactionQuery.data?.ok ? compactionQuery.data.data : null;
  const preparation = preparationQuery.data?.ok
    ? preparationQuery.data.data
    : null;

  return (
    <>
      <CompactionApplyButton
        sessionId={sessionId}
        preparation={preparation}
        permission={permission}
        stack
      />
      <CompactionNote status={compaction} />
    </>
  );
}

function CompactionNote({
  status,
}: {
  readonly status: CompactionStatusDto | null;
}): JSX.Element | null {
  // `null` = session missing/deleted/out-of-scope -> no chip.
  if (status === null) return null;

  const running = status.latest?.status === "running";
  const active = status.activeCount > 0;

  let label: string;
  let state: "running" | "queued" | "failed";
  if (active) {
    label = running ? "Compacting…" : "Compaction queued";
    state = running ? "running" : "queued";
  } else if (status.latest?.status === "permanently_failed") {
    label = "Compaction failed";
    state = "failed";
  } else {
    // Nothing in flight and no terminal failure -> keep the panel uncluttered.
    return null;
  }

  // The remote-path note lives in `aria-label` (NOT title-only) so it is
  // accessible without hover; `title` mirrors it for sighted pointer users.
  return (
    <span
      data-vex-area="session-compaction-chip"
      data-state={state}
      title={`${label} · ${COMPACTION_REMOTE_NOTE}`}
      aria-label={`Compaction status: ${label}. ${COMPACTION_REMOTE_NOTE}`}
      className="inline-flex items-center gap-1.5 text-[11px] text-ink-tertiary"
    >
      {/* Status grammar: the word carries the meaning, the StateDot the
       * motion (running = pixel chase). */}
      <StateDot
        state={
          state === "failed" ? "error" : state === "running" ? "ongoing" : "warning"
        }
        size={8}
      />
      <span className={state === "failed" ? "text-warning-label" : undefined}>
        {label}
      </span>
    </span>
  );
}
