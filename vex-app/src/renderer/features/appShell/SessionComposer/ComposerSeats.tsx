/**
 * Composer bar seats (B18/B20/B21), R3 (docs/design/R3-MINIMAL.md section 7):
 * the ONE options control, "{model name} · Reasoning: {effort}", and the
 * legacy-plan chip, both in the bar's LEADING cluster.
 *
 * The options control is one 30 high frame holding two keys (`.vex-composer-
 * options`, console.css): the model's name and the reasoning effort. In a
 * resolved agent session the model key is the model menu (F06,
 * `ComposerModelMenu`: the session's own model, picked per session);
 * elsewhere (the welcome stage, a mission session) it shows the model and
 * opens Settings, with no chevron. The effort key is the
 * `ReasoningEffortSelect` menu and carries the chevron at the end of the
 * frame. The name comes from the model catalogue (`useAvailableModels`, the
 * shared cache key), else the id.
 *
 * SHRINK CONTRACT (codex Bug 3). The frame and the model key may shrink
 * (`min-w-0`, no `shrink-0`), and the model label owns the ellipsis. Labels
 * truncate FIRST; the trailing cluster never concedes.
 */

import { lazy, Suspense, type JSX, type ReactNode } from "react";
import { useUiStore } from "../../../stores/uiStore.js";
import { inferenceSettingsRoute } from "../../../stores/uiStore/shell-route.js";
import { useSessionPlan } from "../../../lib/api/sessions.js";
import { useAvailableModels } from "../../../lib/api/models.js";
import { Tooltip } from "../../../components/ui/tooltip.js";
import {
  PROVIDER_DISPLAY_NAME,
  ProviderMark,
} from "../../../components/common/ProviderMark.js";
import { providerNameSchema, type ProviderName } from "@shared/schemas/provider.js";
import { modelDisplayName } from "./model-display-name.js";
import { ComposerModelMenu, type ComposerModelMenuProps } from "./ComposerModelMenu.js";

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

/** The provider mark's box beside the 13 px model name. */
const MARK_PX = 16;

/** The legacy plan seat: 30 high, 13 sans in ink 2 on the quiet frame. */
const SEAT_CHIP =
  "vex-composer-chip inline-flex h-[30px] min-w-0 items-center gap-1.5 px-2 font-sans text-[13px] leading-5 text-ink-secondary transition-colors duration-100 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export { modelDisplayName };

/**
 * The catalogue's entry for the model: its name (else its id), the routing
 * prefix trimmed, and the provider that serves it (`providerId`, the same
 * `AGENT_PROVIDER` read the env state reports), or null when the catalogue
 * has not resolved or names a provider this build does not know.
 */
function useModelEntry(modelId: string): {
  readonly name: string;
  readonly provider: ProviderName | null;
} {
  const models = useAvailableModels();
  const entry =
    models.data?.ok === true
      ? models.data.data.models.find((model) => model.modelId === modelId)
      : undefined;
  const name =
    entry !== undefined && typeof entry.displayName === "string" && entry.displayName.length > 0
      ? entry.displayName
      : modelId;
  const provider = providerNameSchema.safeParse(entry?.providerId);
  return {
    name: modelDisplayName(name),
    provider: provider.success ? provider.data : null,
  };
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
  const { name, provider } = useModelEntry(modelId);
  // The mark shows WHO serves the model (Vex Inference or OpenRouter); the
  // accessible name and the tooltip say it in words. An unknown provider
  // draws no mark and claims nothing.
  const served = provider === null ? "" : ` on ${PROVIDER_DISPLAY_NAME[provider]}`;
  return (
    <Tooltip label={`${modelId}${served} - change it in Settings`} side="top" delayMs={300}>
      <button
        type="button"
        data-vex-area="composer-model-chip"
        aria-label={`Model: ${modelId}${served}. Opens inference settings.`}
        className={`vex-composer-options__model gap-1.5 ${OPTIONS_KEY}`}
        onClick={() =>
          setShellRoute(inferenceSettingsRoute(null))
        }
      >
        {provider === null ? null : <ProviderMark provider={provider} size={MARK_PX} />}
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
  menu,
}: {
  readonly modelId: string | null;
  /** The effort key, or `null` when the model has no reasoning selector. */
  readonly effort: ReactNode | null;
  /** False while the catalogue is unresolved: no "Reasoning:" before a placeholder. */
  readonly effortResolved: boolean;
  /** The model menu (F06) for a session that can pick; absent shows the display-only key. */
  readonly menu?: Omit<ComposerModelMenuProps, "modelId">;
}): JSX.Element | null {
  if (modelId === null && effort === null) return null;
  return (
    <div
      data-vex-area="composer-options"
      className="vex-composer-options min-w-0"
    >
      {modelId !== null && menu !== undefined ? (
        <ComposerModelMenu modelId={modelId} {...menu} />
      ) : (
        <ComposerModelChip modelId={modelId} />
      )}
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
