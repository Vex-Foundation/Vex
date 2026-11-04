/**
 * Composer seats (B18/B20/B21): the MODEL CELL that leads the composer row
 * (docs/design/H3-DESKTOP.md section 1.8), and the status strip's first
 * cell over the row, the options control ("{model} HIGH") with the
 * legacy-plan chip.
 *
 * THE MODEL CELL is the model choice: the model's glyph in the row's first
 * cell (`ComposerModelGlyph`). In a resolved agent session it is the model
 * menu (F06, `ComposerModelMenu`: the session's own model, picked per
 * session); elsewhere (the welcome stage, a mission session) it opens
 * Settings, where the default model and the key live. Its accessible name
 * says the model and its provider in words either way.
 *
 * THE OPTIONS CONTROL is H3's "DeepSeek V4.1 Flash 1017 HIGH": the model the
 * next turn runs on, as words in sentence case, then the reasoning effort as
 * its caps word, the effort key (`ReasoningEffortSelect`, named "Reasoning
 * effort", its menu opening upward). The name comes from the model catalogue
 * (`useAvailableModels`, the shared cache key), else the id; the label owns
 * the ellipsis. A model with no reasoning selector shows its name alone.
 *
 * SHRINK CONTRACT (codex Bug 3). The frame and the name may shrink
 * (`min-w-0`, no `shrink-0`), and the model label owns the ellipsis. Labels
 * truncate FIRST; the trailing cluster never concedes.
 */

import { lazy, Suspense, type JSX, type ReactNode } from "react";
import { useUiStore } from "../../../stores/uiStore.js";
import { inferenceSettingsRoute } from "../../../stores/uiStore/shell-route.js";
import { useSessionPlan } from "../../../lib/api/sessions.js";
import { useAvailableModels } from "../../../lib/api/models.js";
import { Tooltip } from "../../../components/ui/tooltip.js";
import { PROVIDER_DISPLAY_NAME } from "../../../components/common/ProviderMark.js";
import { providerNameSchema, type ProviderName } from "@shared/schemas/provider.js";
import { modelDisplayName } from "./model-display-name.js";
import { ComposerModelMenu, type ComposerModelMenuProps } from "./ComposerModelMenu.js";
import { ComposerModelGlyph, MODEL_CELL_KEY_CLASS } from "./ComposerModelGlyph.js";

// Lazy: the plan modal pulls the markdown pipeline - a heavy graph the
// composer must not pay for until the review actually opens.
const PlanDisplayModal = lazy(async () => ({
  default: (await import("../PlanDisplayModal.js")).PlanDisplayModal,
}));

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

/**
 * The display-only model key, in the model cell where the model cannot be
 * picked here (the welcome stage, a mission session): the glyph, and a press
 * opens Settings, Inference.
 */
function ModelSettingsKey({ modelId }: { readonly modelId: string }): JSX.Element {
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const { provider } = useModelEntry(modelId);
  // The mark shows WHO serves the model (Vex Inference or OpenRouter); the
  // accessible name and the tooltip say it in words. An unknown provider
  // draws the line model glyph and claims nothing.
  const served = provider === null ? "" : ` on ${PROVIDER_DISPLAY_NAME[provider]}`;
  return (
    <Tooltip label={`${modelId}${served} - change it in Settings`} side="top" delayMs={300}>
      <button
        type="button"
        data-vex-area="composer-model-chip"
        aria-label={`Model: ${modelId}${served}. Opens inference settings.`}
        className={MODEL_CELL_KEY_CLASS}
        onClick={() => setShellRoute(inferenceSettingsRoute(null))}
      >
        <ComposerModelGlyph provider={provider} />
      </button>
    </Tooltip>
  );
}

/**
 * The model cell: the model menu for a session that can pick, else the key
 * to Settings. With no model resolved yet the cell stands empty, so the row
 * keeps its cells.
 */
export function ComposerModelCell({
  modelId,
  menu,
}: {
  readonly modelId: string | null;
  /** The model menu (F06) for a session that can pick; absent shows the Settings key. */
  readonly menu?: Omit<ComposerModelMenuProps, "modelId">;
}): JSX.Element {
  if (modelId === null) {
    return <div aria-hidden data-vex-area="composer-model-cell" className="vex-composer-model" />;
  }
  return menu !== undefined ? (
    <ComposerModelMenu modelId={modelId} {...menu} />
  ) : (
    <ModelSettingsKey modelId={modelId} />
  );
}

/** The model the next turn runs on, as words: the catalogue's name, else the id. */
function ModelName({ modelId }: { readonly modelId: string }): JSX.Element {
  const { name } = useModelEntry(modelId);
  return (
    <span
      data-vex-model-label
      title={modelId}
      className="vex-composer-options__model min-w-0 max-w-48 truncate font-sans text-[13px] leading-5 text-ink-primary"
    >
      {name}
    </span>
  );
}

/**
 * The options control: the model's name, then the effort key (the menu, or
 * its quiet placeholder while the catalogue loads), H3's "{model} HIGH".
 * Renders nothing when neither half has anything to show.
 */
export function ComposerOptions({
  modelId,
  effort,
}: {
  readonly modelId: string | null;
  /** The effort key, or `null` when the model has no reasoning selector. */
  readonly effort: ReactNode | null;
}): JSX.Element | null {
  if (modelId === null && effort === null) return null;
  return (
    <div
      data-vex-area="composer-options"
      className="vex-composer-options min-w-0"
    >
      {modelId === null ? null : <ModelName modelId={modelId} />}
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
