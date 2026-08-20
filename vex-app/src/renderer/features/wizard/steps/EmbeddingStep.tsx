/**
 * Wizard Step 4 — Embedding configuration (M9; PR6 redesign — glass).
 *
 * Skip-card when `envState.embeddings.allFieldsConfigured` is true.
 * Otherwise: form with the 4 EMBEDDING_* fields. URL is validated
 * against `new URL()` before submit (renderer mirrors the schema
 * refine so the user gets immediate feedback). DIM has a numeric
 * range hint.
 *
 * Error rendering is specialised by VexErrorCode:
 *   - embedding.dim_locked → warning card with the
 *     existing/target row count + "knowledge unavailable" guidance.
 *     User keeps the form filled so they can decide to step back
 *     and pick the existing dim, or cancel.
 *   - embedding.db_unavailable → retry card with hint to verify
 *     the System Check screen first.
 *   - validation.invalid_input → inline field-level error.
 *
 * Reload UX: Step 4 success card notes "Embedding settings apply on
 * the next knowledge operation" because `loadEmbeddingConfig()` is
 * called per-tool invocation in the engine (no agent restart needed
 * for embeddings).
 *
 * Chrome lives in `WizardStepPanel` — `data-vex-wizard-embedding`
 * forwarded onto the panel root.
 *
 * Presentational subcomponents (skip card, warning panels, fields,
 * inline alerts) and the pure form helpers live co-located under
 * `EmbeddingStep/`. This file keeps the public export(s) and the shell
 * wiring (env state / step advance / configure mutation + submit side
 * effects).
 */

import { useCallback, useState, type JSX } from "react";
import {
  type EmbeddingConfigureInput,
} from "@shared/schemas/embedding.js";
import {
  DEFAULT_EMBED_PORT,
} from "@shared/embedding-defaults.js";
import {
  type WizardStepId,
} from "@shared/schemas/wizard.js";
import { Button } from "../../../components/ui/button.js";
import { cn } from "../../../lib/utils.js";
import { RAIL_WARNING_CHROME } from "./step-chrome.js";
import { useEnvState } from "../../../lib/api/onboarding.js";
import { useEmbeddingConfigure } from "../../../lib/api/embedding.js";
import {
  useStepAdvance,
  type WizardFlowMode,
} from "../../../lib/api/wizard.js";
import { WIZARD_STEP_META } from "../wizard-icons.js";
import { WizardStepPanel } from "../WizardStepPanel.js";
import {
  narrowDimLockDetails,
  validateForm,
  type FormState,
  type ServerError,
} from "./EmbeddingStep/form.js";
import { EmbeddingSkipCard } from "./EmbeddingStep/SkipCard.js";
import { EmbeddingWarningPanels } from "./EmbeddingStep/WarningPanels.js";
import { EmbeddingFields } from "./EmbeddingStep/Fields.js";
import { EmbeddingAlerts } from "./EmbeddingStep/Alerts.js";

export interface EmbeddingStepProps {
  readonly completedSteps: ReadonlyArray<WizardStepId>;
  readonly onAdvance: (next: WizardStepId) => void;
  readonly flowMode: WizardFlowMode;
}

export function EmbeddingStep({
  completedSteps,
  onAdvance,
  flowMode,
}: EmbeddingStepProps): JSX.Element {
  const envQuery = useEnvState();
  const stepAdvance = useStepAdvance();
  const configure = useEmbeddingConfigure();

  const [form, setForm] = useState<FormState>({
    baseUrl: "",
    model: "",
    dim: "",
    provider: "",
  });
  const [validationError, setValidationError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<ServerError | null>(null);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [showOverride, setShowOverride] = useState(false);

  const embeddingsState =
    envQuery.data?.ok === true ? envQuery.data.data.embeddings : null;
  const allConfigured = embeddingsState?.allFieldsConfigured ?? false;

  const advanceToAgentCore = useCallback(async () => {
    setAdvanceError(null);
    const result = await stepAdvance.advance({
      flowMode,
      completedSteps,
      current: "embedding",
      forwardNext: "agentCore",
      onAdvance,
    });
    if (!result.ok) setAdvanceError(result.message);
  }, [stepAdvance, flowMode, completedSteps, onAdvance]);

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setValidationError(null);
      setServerError(null);
      const validation = validateForm(form);
      if (validation !== null) {
        setValidationError(validation);
        return;
      }
      const input: EmbeddingConfigureInput = {
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        dim: Number(form.dim),
        provider: form.provider.trim(),
      };
      const result = await configure.mutateAsync(input);
      if (!result.ok) {
        const details = narrowDimLockDetails(result.error.details);
        setServerError({
          code: result.error.code,
          message: result.error.message,
          ...(details !== null ? { details } : {}),
        });
        return;
      }
      await advanceToAgentCore();
    },
    [form, configure, advanceToAgentCore],
  );

  const meta = WIZARD_STEP_META.embedding;

  if (allConfigured && !showOverride) {
    return (
      <EmbeddingSkipCard
        icon={meta.icon}
        embeddingsState={embeddingsState}
        flowMode={flowMode}
        isPending={stepAdvance.isPending}
        advanceError={advanceError}
        onOverride={() => setShowOverride(true)}
        onContinue={() => {
          void advanceToAgentCore();
        }}
      />
    );
  }

  const isDimLocked = serverError?.code === "embedding.dim_locked";
  const isDbDown = serverError?.code === "embedding.db_unavailable";
  // Embeddings are OPTIONAL (configure later in Settings). In the forward
  // setup flow we let the operator advance without configuring an
  // endpoint, surfacing a consequence alert (no memory / semantic search
  // until it's set up). back-edit keeps the save-only footer.
  const showConfigureLater = flowMode === "first-pass";

  return (
    <WizardStepPanel
      panelDataAttr={{ kind: "embedding", value: "form" }}
      icon={meta.icon}
      flowMode={flowMode}
      title="Embedding configuration"
      description={
        <>
          Embeddings power Vex&apos;s long-term memory. The bundled model
          (EmbeddingGemma 300M) runs entirely on this machine at{" "}
          <code>127.0.0.1:{DEFAULT_EMBED_PORT}</code> - nothing leaves it.
          Point Base URL at your own OpenAI-compatible endpoint only if
          you&apos;re comfortable sending memory content there. Optional;
          you can configure this later.
        </>
      }
      formProps={{
        onSubmit: (e) => {
          void onSubmit(e);
        },
        noValidate: true,
      }}
      footer={
        <>
          {showConfigureLater ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                void advanceToAgentCore();
              }}
              disabled={configure.isPending || stepAdvance.isPending}
              data-vex-embedding-configure-later
            >
              {stepAdvance.isPending ? "Continuing…" : "Configure later"}
            </Button>
          ) : null}
          <Button
            type="submit"
            disabled={configure.isPending || stepAdvance.isPending}
          >
            {configure.isPending
              ? "Saving…"
              : stepAdvance.isPending
                ? "Continuing…"
                : flowMode === "back-edit"
                  ? "Save changes"
                  : "Save and continue"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {showConfigureLater ? (
          <p
            role="status"
            data-vex-embedding-configure-later-alert
            className={cn(
              "py-0.5 text-sm text-warning",
              RAIL_WARNING_CHROME,
            )}
          >
            Without an embedding endpoint, long-term memory and semantic
            search stay unavailable until you configure one. You can set this
            up later from Settings.
          </p>
        ) : null}
        <EmbeddingWarningPanels
          isDimLocked={isDimLocked}
          isDbDown={isDbDown}
          serverError={serverError}
        />

        <EmbeddingFields form={form} setForm={setForm} />

        <EmbeddingAlerts
          validationError={validationError}
          serverError={serverError}
          isDimLocked={isDimLocked}
          isDbDown={isDbDown}
          advanceError={advanceError}
        />
      </div>
    </WizardStepPanel>
  );
}
