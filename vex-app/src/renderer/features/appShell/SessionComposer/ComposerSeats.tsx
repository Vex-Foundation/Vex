/**
 * Composer toolbar seats (B18/B20/B21): the model chip and the legacy-plan
 * chip on the field's bottom row, both in the LEADING cluster. The runtime
 * model is GLOBAL (env-resolved, no per-session mutation channel), so the model
 * chip navigates to Settings -> Model instead of offering a picker - and so it
 * draws no chevron: there is no menu behind it.
 *
 * The permission seat left this file in round 3: it moved to the TRAILING
 * cluster beside the context meter and now owns a glyph and a container
 * collapse, so it has its own owner (`ComposerPermissionSeat`).
 *
 * SHRINK CONTRACT (codex Bug 3). These seats are the toolbar's concession
 * path: the chip box may shrink (`min-w-0`, no `shrink-0`), the brand icon is
 * fixed, and the text label owns the ellipsis. Labels truncate FIRST; the
 * trailing cluster never concedes.
 */

import { lazy, Suspense, type JSX } from "react";
import { useUiStore } from "../../../stores/uiStore.js";
import { useSessionPlan } from "../../../lib/api/sessions.js";
import { Tooltip } from "../../../components/ui/tooltip.js";

// Lazy: the plan modal pulls the markdown pipeline - a heavy graph the
// composer must not pay for until the review actually opens.
const PlanDisplayModal = lazy(async () => ({
  default: (await import("../PlanDisplayModal.js")).PlanDisplayModal,
}));

/**
 * Field seat chip (reference d3): 28px, 12px Departure Mono at the data
 * tracking, the second ink on a rule outline (`.vex-composer-chip`,
 * console.css). `min-w-0` and NO `shrink-0`: the box concedes, the label
 * inside truncates. A visible focus ring is kept - a shrinking control must
 * never become an unreachable or invisible focus target.
 */
const SEAT_CHIP =
  "vex-composer-chip inline-flex h-7 min-w-0 items-center gap-1.5 px-2 font-mono text-[12px] leading-5 tracking-[0.02em] text-ink-secondary transition-colors duration-100 hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-focus";

/**
 * DISPLAY-ONLY trim of the routing prefix: `deepseek/deepseek-v4-pro` reads
 * as `deepseek-v4-pro` on the chip (owner QA round 3 follow-up), the way the
 * field draws it (`claude-sonnet-4`). Only the FIRST segment is cut - an id
 * with no `/` passes through, and a variant suffix (`:free`) survives. The
 * FULL id stays the source of truth everywhere else: the accessible name, the
 * tooltip, the settings screen, and every request path.
 */
export function modelDisplayName(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 && slash < modelId.length - 1
    ? modelId.slice(slash + 1)
    : modelId;
}

export function ComposerModelChip({
  modelId,
}: {
  readonly modelId: string | null;
}): JSX.Element | null {
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  if (modelId === null) return null;
  return (
    <Tooltip label={`${modelId} - change it in Settings`} side="top" delayMs={300}>
      <button
        type="button"
        data-vex-area="composer-model-chip"
        aria-label={`Model: ${modelId}. Opens model settings.`}
        className={SEAT_CHIP}
        onClick={() =>
          setShellRoute({ kind: "settings", origin: null, section: "model" })
        }
      >
        <span data-vex-model-label className="min-w-0 max-w-40 flex-1 truncate">
          {modelDisplayName(modelId)}
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * Legacy Plan Mode chip: renders only for a session that still carries an
 * enabled pre-retirement plan (the same gate as the mission rail badge) and
 * opens the read-only `PlanDisplayModal`.
 */
export function ComposerPlanChip({
  sessionId,
  missionStatus,
  open,
  onOpenChange,
}: {
  readonly sessionId: string | null;
  readonly missionStatus: string | null;
  /** Controlled by the composer so the /plan command drives the same modal. */
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
}): JSX.Element | null {
  const planQuery = useSessionPlan(sessionId);
  const plan = planQuery.data?.ok ? planQuery.data.data : null;
  if (sessionId === null || plan === null || !plan.enabled) return null;
  return (
    <>
      <button
        type="button"
        data-vex-area="composer-plan-chip"
        data-accepted={plan.accepted ? "true" : "false"}
        aria-label="Review the legacy action plan"
        className={SEAT_CHIP}
        onClick={() => onOpenChange(true)}
      >
        <span data-vex-plan-label className="min-w-0 truncate">
          Plan{plan.accepted ? "" : " · unaccepted"}
        </span>
      </button>
      {open ? (
        <Suspense fallback={null}>
          <PlanDisplayModal
            sessionId={sessionId}
            missionStatus={missionStatus}
            open={open}
            onOpenChange={onOpenChange}
          />
        </Suspense>
      ) : null}
    </>
  );
}
