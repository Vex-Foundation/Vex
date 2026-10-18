/**
 * Compaction apply control (compaction v2, package C10).
 *
 * **The button issues exactly ONE call — `compaction.requestApply` — and never
 * performs a cutover.** That call moves the preparation FSM
 * `summary_ready → apply_requested` and stops; the runner performs the actual
 * cutover at its next iteration boundary, where the lease, the lock order and
 * the money gate are held together. This is the whole extent of the renderer's
 * authority over the conversation's context, and it is the first
 * renderer-initiated context mutation in the app.
 *
 * Renders `null` when there is no preparation and when the preparation has
 * reached a terminal state that needs no affordance (`applied`, `superseded`)
 * — the runtime bar stays uncluttered, the same rule the compaction chip
 * follows.
 *
 * A `failed` preparation shows a disabled state and NO retry: retry is
 * runtime-owned (each branch gets its own bounded attempts, and capture
 * re-prepares when the transcript makes it material). A user retry here would
 * need a whole new CAS and a new FSM edge.
 *
 * At `permission: full` the button is still shown. Full-Autonomous auto-apply
 * usually wins the race and the button flips to "Queued" on its own; offering
 * it is simpler and honest, and the title says so rather than implying the
 * click is what makes compaction happen.
 */

import { useState, type JSX } from "react";
import type { SessionPermission } from "@shared/schemas/sessions.js";
import type {
  CompactionApplyRequestResult,
  CompactionPreparationDto,
} from "@shared/schemas/compaction-preparation.js";
import { Button } from "../../components/ui/button.js";
import { StateWord } from "../../components/ui/state-word.js";
import { useRequestCompactionApply } from "../../lib/api/compaction-preparation.js";

const APPLY_LABEL =
  "Apply prepared compaction: replaces older messages with a summary";

export interface CompactionApplyButtonProps {
  readonly sessionId: string;
  readonly preparation: CompactionPreparationDto | null;
  /**
   * Session permission, passed down from the shell rather than fetched here.
   * It is a session-STATIC axis (locked at creation), so a prop cannot go
   * stale, and a fifth query in the runtime bar for one enum is out of
   * proportion.
   */
  readonly permission: SessionPermission | null;
  readonly stack: boolean;
}

export function CompactionApplyButton({
  sessionId,
  preparation,
  permission,
  stack,
}: CompactionApplyButtonProps): JSX.Element | null {
  // The `no_live_runner` distinction is an outcome of the REQUEST, not a field
  // of the row — both outcomes leave the FSM in `apply_requested`. Kept here
  // until the next refetch so the copy can stay honest about it.
  const [lastOutcome, setLastOutcome] =
    useState<CompactionApplyRequestResult["outcome"] | null>(null);
  const requestApply = useRequestCompactionApply();

  if (preparation === null) return null;
  const status = preparation.status;
  if (status === "applied" || status === "superseded") return null;

  const ready = status === "summary_ready";
  const failed = status === "failed";
  const pending = requestApply.isPending;

  // No button at all for a failed preparation: there is no user action to
  // offer, and a permanently-disabled control reads as one that might enable.
  if (failed) {
    return (
      <StateWord
        state="error"
        word="Preparation failed"
        data-vex-compaction-apply={status}
        role="status"
        className={stack ? "w-full py-1.5" : undefined}
      />
    );
  }

  const copy = ready
    ? "Compact now"
    : status === "preparing"
      ? "Preparing memory…"
      : status === "applying"
        ? "Compacting…"
        : lastOutcome === "queued"
          ? "Queued - applies at the next step"
          : // Default for a request we did not issue (Full-Autonomous
            // auto-apply, the agent's own tool) — truthful either way.
            "Queued - will apply when the agent next runs";

  return (
    <span
      data-vex-compaction-apply={status}
      className={
        stack
          ? "flex w-full items-center gap-2 py-1.5"
          : "inline-flex items-center gap-2"
      }
    >
      {/* The small blue outline key (docs/design/R3-MINIMAL.md section 8.2,
        * the ghost button at 32 high): never a fill, so the view keeps its
        * single blue fill (send). */}
      <Button
        variant="ghost"
        size="sm"
        disabled={!ready || pending}
        onClick={() => {
          requestApply.mutate(
            { sessionId },
            {
              onSuccess: (result) => {
                if (result.ok) setLastOutcome(result.data.outcome);
              },
            },
          );
        }}
        aria-label={APPLY_LABEL}
        title={
          ready && permission === "full"
            ? "Runs automatically when safe"
            : undefined
        }
        // Opacity-only pulse, bound to a real pending action - exactly the
        // doctrine the class was written for. Reused, never re-keyframed.
        className={ready ? "vex-badge--shimmer" : undefined}
      >
        {copy}
      </Button>
      {/* Announces the queued → applying transition without re-rendering the
       * control itself into a focus trap. */}
      <span aria-live="polite" className="sr-only">
        {copy}
      </span>
    </span>
  );
}
