/**
 * Composer toolbar seats (B18/B20/B21): the model chip, the permission pill,
 * and the legacy-plan chip on the capsule's bottom row. The runtime model is
 * GLOBAL (env-resolved, no per-session mutation channel), so the model chip
 * navigates to Settings -> Model instead of offering a picker. Permission is
 * session-static and display-only (approval boundary - never a toggle).
 */

import { lazy, Suspense, type JSX } from "react";
import type { SessionPermission } from "@shared/schemas/sessions.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { useSessionPlan } from "../../../lib/api/sessions.js";
import { Pill } from "../../../components/ui/pill.js";
import { Tooltip } from "../../../components/ui/tooltip.js";
import { ModelBrandIcon } from "../../wizard/steps/provider/ModelBrandIcon.js";

// Lazy: the plan modal pulls the markdown pipeline - a heavy graph the
// composer must not pay for until the review actually opens.
const PlanDisplayModal = lazy(async () => ({
  default: (await import("../PlanDisplayModal.js")).PlanDisplayModal,
}));

/** Capsule seat chip: h28, r8, 13/20 w500 (catalog select-chip geometry). */
const SEAT_CHIP =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium leading-5 text-ink-secondary transition-colors duration-100 hover:bg-interactive-hover";

const PERMISSION_TOOLTIP: Readonly<Record<SessionPermission, string>> = {
  restricted: "Restricted: every mutating transaction requires your approval.",
  full: "Full access: auto-executes approved tools without prompting per call.",
};

export function ComposerModelChip({
  modelId,
}: {
  readonly modelId: string | null;
}): JSX.Element | null {
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  if (modelId === null) return null;
  return (
    <Tooltip label="Runtime model - change it in Settings" side="top" delayMs={300}>
      <button
        type="button"
        data-vex-area="composer-model-chip"
        aria-label={`Model: ${modelId}. Opens model settings.`}
        className={SEAT_CHIP}
        onClick={() =>
          setShellRoute({ kind: "settings", origin: null, section: "model" })
        }
      >
        <ModelBrandIcon modelId={modelId} size={14} />
        <span className="max-w-40 truncate">{modelId}</span>
      </button>
    </Tooltip>
  );
}

export function ComposerPermissionChip({
  permission,
}: {
  readonly permission: SessionPermission | null;
}): JSX.Element | null {
  if (permission === null) return null;
  return (
    <Tooltip label={PERMISSION_TOOLTIP[permission]} side="top" delayMs={300}>
      <span
        data-vex-area="composer-permission-chip"
        data-permission={permission}
        className="inline-flex"
        // The tooltip needs a hoverable, focusable box; the Pill itself stays
        // static - permission is locked at creation and never toggles here.
        tabIndex={0}
      >
        <Pill variant={permission === "full" ? "accent" : "neutral"}>
          {permission === "full" ? "Full access" : "Restricted"}
        </Pill>
      </span>
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
        Plan{plan.accepted ? "" : " · unaccepted"}
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
