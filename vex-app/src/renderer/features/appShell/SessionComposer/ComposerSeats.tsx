/**
 * Composer bar seats (B18/B20/B21), R3 (docs/design/R3-MINIMAL.md section 7):
 * the ONE options control, "{model name} · Reasoning: {effort}", and the
 * legacy-plan chip, both in the bar's LEADING cluster.
 *
 * The options control is one 30 high frame holding two keys (`.vex-composer-
 * options`, console.css): the model's name and the reasoning effort. The
 * runtime model is GLOBAL (env-resolved, no per-session mutation channel), so
 * the model key opens Settings -> Model instead of offering a picker and draws
 * no chevron; the effort key is the `ReasoningEffortSelect` menu and carries
 * the chevron at the end of the frame. The name comes from the model catalogue
 * (`useAvailableModels`, the shared cache key), else the id.
 *
 * SHRINK CONTRACT (codex Bug 3). The frame and the model key may shrink
 * (`min-w-0`, no `shrink-0`), and the model label owns the ellipsis. Labels
 * truncate FIRST; the trailing cluster never concedes.
 */

import { lazy, Suspense, type JSX, type ReactNode } from "react";
import { useUiStore } from "../../../stores/uiStore.js";
import { useSessionPlan } from "../../../lib/api/sessions.js";
import { useAvailableModels } from "../../../lib/api/models.js";
import { Tooltip } from "../../../components/ui/tooltip.js";

// Lazy: the plan modal pulls the markdown pipeline - a heavy graph the
// composer must not pay for until the review actually opens.
const PlanDisplayModal = lazy(async () => ({
  default: (await import("../PlanDisplayModal.js")).PlanDisplayModal,
}));

/**
 * The keys inside the options frame: 13 sans in ink, no box of their own (the
 * frame is the box), a hover tint on the type and a visible focus ring. A
 * shrinking control must never become an unreachable or invisible focus
 * target.
 */
const OPTIONS_KEY =
  "inline-flex h-7 min-w-0 items-center font-sans text-[13px] leading-5 text-ink-primary transition-colors duration-100 hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/** The legacy plan seat: 30 high, 13 sans in ink 2 on the quiet frame. */
const SEAT_CHIP =
  "vex-composer-chip inline-flex h-[30px] min-w-0 items-center gap-1.5 px-2 font-sans text-[13px] leading-5 text-ink-secondary transition-colors duration-100 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/**
 * DISPLAY-ONLY trim of the routing prefix: `deepseek/deepseek-v4-pro` reads
 * as `deepseek-v4-pro` (owner QA round 3 follow-up). Only the FIRST segment
 * is cut - an id with no `/` passes through, and a variant suffix (`:free`)
 * survives. The FULL id stays the source of truth everywhere else: the
 * accessible name, the tooltip, the settings screen, and every request path.
 */
export function modelDisplayName(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 && slash < modelId.length - 1
    ? modelId.slice(slash + 1)
    : modelId;
}

/** The catalogue's name for the model, else its id; the routing prefix trimmed. */
function useModelName(modelId: string): string {
  const models = useAvailableModels();
  const entry =
    models.data?.ok === true
      ? models.data.data.models.find((model) => model.modelId === modelId)
      : undefined;
  const name =
    entry !== undefined && typeof entry.displayName === "string" && entry.displayName.length > 0
      ? entry.displayName
      : modelId;
  return modelDisplayName(name);
}

export function ComposerModelChip({
  modelId,
}: {
  readonly modelId: string | null;
}): JSX.Element | null {
  if (modelId === null) return null;
  return <ModelKey modelId={modelId} />;
}

function ModelKey({ modelId }: { readonly modelId: string }): JSX.Element {
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const name = useModelName(modelId);
  return (
    <Tooltip label={`${modelId} - change it in Settings`} side="top" delayMs={300}>
      <button
        type="button"
        data-vex-area="composer-model-chip"
        aria-label={`Model: ${modelId}. Opens model settings.`}
        className={`vex-composer-options__model ${OPTIONS_KEY}`}
        onClick={() =>
          setShellRoute({ kind: "settings", origin: null, section: "model" })
        }
      >
        <span data-vex-model-label className="min-w-0 max-w-48 flex-1 truncate">
          {name}
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * The options control: the model key, the muted dot and "Reasoning:", then the
 * effort key (the menu, or its quiet placeholder while the catalogue loads).
 * Renders nothing when neither half has anything to show.
 */
export function ComposerOptions({
  modelId,
  effort,
  effortResolved,
}: {
  readonly modelId: string | null;
  /** The effort key, or `null` when the model has no reasoning selector. */
  readonly effort: ReactNode | null;
  /** False while the catalogue is unresolved: no "Reasoning:" before a placeholder. */
  readonly effortResolved: boolean;
}): JSX.Element | null {
  if (modelId === null && effort === null) return null;
  return (
    <div
      data-vex-area="composer-options"
      className="vex-composer-options min-w-0"
    >
      <ComposerModelChip modelId={modelId} />
      {effort !== null && effortResolved ? (
        <>
          {modelId !== null ? (
            <span aria-hidden="true" className="vex-composer-options__key">
              ·
            </span>
          ) : null}
          <span aria-hidden="true" className="vex-composer-options__key">
            Reasoning:
          </span>
        </>
      ) : null}
      {effort}
    </div>
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
