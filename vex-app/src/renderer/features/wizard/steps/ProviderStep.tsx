/**
 * Wizard Step 6 — Provider configuration (M10; PR6 redesign — glass).
 *
 * OpenRouter inline flow. Single "Verify and save" action does
 * verify-then-persist atomically (codex turn 2 RED #1):
 *
 *   1. Renderer reads apiKey from uncontrolled DOM ref + model from
 *      regular React state.
 *   2. Clears `apiKeyRef.current.value = ""` SYNCHRONOUSLY before
 *      the await (skill §14 — never park secrets in observer state).
 *   3. Calls `providerPersist({apiKey, model, provider:"openrouter"})`.
 *      Main process verifies via OpenRouter SDK (16-token chat
 *      completion, hard 15s timeout) BEFORE storing OPENROUTER_API_KEY
 *      in the encrypted vault and writing non-secret model/provider
 *      values to `.env`.
 *   4. On success → advance to the Review step (Phase 2: Mode + Wake
 *      are session-config, not wizard steps).
 *   5. On error → render specialised UI copy per VexErrorCode (fixed
 *      strings; SDK raw messages NEVER surfaced — codex turn 3
 *      YELLOW).
 *
 * Configured branch: when `envState.provider.configured` is true the
 * whole screen is delegated to `ConfiguredProviderPanel`, which shows
 * the three configured facts (key status, model, routing) and hosts an
 * inline delta editor able to save a model/endpoint change WITHOUT the
 * operator re-typing the API key. "Reconfigure" there falls back to
 * THIS file's full first-run form, unchanged.
 *
 * AGENT_MODEL is NOT a secret — model ids are public catalogue
 * entries — so it stays in React state. The OPENROUTER_API_KEY input
 * is the ONLY secret in this step.
 *
 * PR6 — `ModelBrandIcon` parses the `<provider>/<model>` prefix and
 * shows a matching brand SVG from `@thesvg/react` (DeepSeek, Anthropic,
 * OpenAI, …) both next to the model input AND in the skip-card summary.
 *
 * Chrome lives in `WizardStepPanel` — `data-vex-wizard-provider`
 * forwarded onto the panel root. The `<form>` carries the existing
 * `data-vex-wizard-provider-form="openrouter"` attribute via the
 * panel's typed `formProps.providerFormAttr` slot.
 */

import { useCallback, useRef, useState, type JSX } from "react";
import { type ProviderPersistInput } from "@shared/schemas/provider.js";
import { type WizardStepId } from "@shared/schemas/wizard.js";
import { Button } from "../../../components/ui/button.js";
import { Label } from "../../../components/ui/label.js";
import { PasswordField } from "../../../components/common/PasswordField.js";
import { useEnvState } from "../../../lib/api/onboarding.js";
import {
  persistProvider,
  useProviderEndpoints,
  useProviderModels,
  useInvalidateEnvStateAfterProviderWrite,
} from "../../../lib/api/provider.js";
import {
  useStepAdvance,
  type WizardFlowMode,
} from "../../../lib/api/wizard.js";
import { WIZARD_STEP_META } from "../wizard-icons.js";
import { WizardStepPanel } from "../WizardStepPanel.js";
import { type ServerError } from "./provider/error-ui.js";
import { ConfiguredProviderPanel } from "./provider/ConfiguredProviderPanel.js";
import { ModelBrandIcon } from "./provider/ModelBrandIcon.js";
import { ModelPicker } from "./provider/ModelPicker.js";
import { EndpointPicker } from "./provider/EndpointPicker.js";
import { ProviderErrorAlert } from "./provider/ProviderErrorAlert.js";

export interface ProviderStepProps {
  readonly completedSteps: ReadonlyArray<WizardStepId>;
  readonly onAdvance: (next: WizardStepId) => void;
  readonly flowMode: WizardFlowMode;
}

const VERIFY_AND_SAVE_MIN_DELAY_MS = 0;

export function ProviderStep({
  completedSteps,
  onAdvance,
  flowMode,
}: ProviderStepProps): JSX.Element {
  const envQuery = useEnvState();
  const stepAdvance = useStepAdvance();
  const invalidateEnvState = useInvalidateEnvStateAfterProviderWrite();

  const [model, setModel] = useState<string>("");
  /** Pinned endpoint tag, or `null` for "Auto (recommended)". */
  const [endpointTag, setEndpointTag] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<ServerError | null>(null);
  const [successLatencyMs, setSuccessLatencyMs] = useState<number | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const apiKeyRef = useRef<HTMLInputElement | null>(null);

  const providerState =
    envQuery.data?.ok === true ? envQuery.data.data.provider : null;
  const configured = providerState?.configured ?? false;
  const effectiveName = providerState?.name ?? null;
  const effectiveModel = providerState?.modelLabel ?? null;
  const effectiveEndpointTag = providerState?.endpointTag ?? null;
  const providerModels = useProviderModels(!configured || showOverride);
  const providerModelsResult = providerModels.data;
  const catalogueModels =
    providerModelsResult?.ok === true ? providerModelsResult.data.models : [];
  const catalogueFailed =
    providerModels.isError || providerModelsResult?.ok === false;

  // The provider (endpoint) select appears only for an EXACT catalogue match.
  // A manually typed or unlisted model id has no endpoint list we can
  // authorise a pin against, so it stays Auto-only — and this also guarantees
  // one fetch per selected model instead of one per keystroke.
  const selectedCatalogueModelId =
    catalogueModels.find((option) => option.modelId === model.trim())
      ?.modelId ?? null;
  const providerEndpoints = useProviderEndpoints(selectedCatalogueModelId);
  const providerEndpointsResult = providerEndpoints.data;
  const endpointOptions =
    providerEndpointsResult?.ok === true
      ? providerEndpointsResult.data.endpoints
      : [];
  const endpointsFailed =
    providerEndpoints.isError || providerEndpointsResult?.ok === false;

  // Changing the model invalidates any pin: endpoint tags are per-model, and
  // carrying one across would submit a tag main will (correctly) reject.
  const onModelChange = useCallback((next: string) => {
    setModel(next);
    setEndpointTag(null);
  }, []);

  const openLogsFolder = useCallback(() => {
    // Fire-and-forget one-shot action: opening the OS file manager has no
    // renderer state to track; failures are logged main-side.
    void window.vex.support.openLogsFolder().catch(() => undefined);
  }, []);

  const advanceToReview = useCallback(async () => {
    setClientError(null);
    const result = await stepAdvance.advance({
      flowMode,
      completedSteps,
      current: "provider",
      forwardNext: "review",
      onAdvance,
    });
    if (!result.ok) setClientError(result.message);
  }, [stepAdvance, flowMode, completedSteps, onAdvance]);

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setClientError(null);
      setServerError(null);
      setSuccessLatencyMs(null);

      const apiKeyRaw = apiKeyRef.current?.value ?? "";
      const apiKey = apiKeyRaw.trim();
      const modelTrim = model.trim();

      if (apiKey.length === 0) {
        setClientError("Enter your OpenRouter API key.");
        return;
      }
      if (modelTrim.length === 0) {
        setClientError(
          "Enter the OpenRouter model id (e.g. anthropic/claude-sonnet-4.5).",
        );
        return;
      }
      if (apiKey.length > 200 || modelTrim.length > 200) {
        setClientError(
          "API key and model id must each be shorter than 200 characters.",
        );
        return;
      }

      // Snapshot, clear ref SYNCHRONOUSLY before await (skill §14).
      // Omitting `endpointTag` is the Auto contract: main REMOVES any
      // previously persisted pin rather than leaving a stale one behind.
      const payload: ProviderPersistInput = {
        provider: "openrouter",
        apiKey,
        model: modelTrim,
        ...(endpointTag !== null && { endpointTag }),
      };
      if (apiKeyRef.current) {
        apiKeyRef.current.value = "";
      }
      setSubmitting(true);
      try {
        if (VERIFY_AND_SAVE_MIN_DELAY_MS > 0) {
          await new Promise((r) => setTimeout(r, VERIFY_AND_SAVE_MIN_DELAY_MS));
        }
        const result = await persistProvider(payload);
        if (!result.ok) {
          // `details.causeCode` is the errno-shaped cause code attached by
          // main (mapSdkError) — narrow defensively like AgentCoreStep's
          // `details.violation`.
          const causeCodeRaw = result.error.details?.causeCode;
          setServerError({
            code: result.error.code,
            correlationId: result.error.correlationId ?? null,
            causeCode:
              typeof causeCodeRaw === "string" ? causeCodeRaw : null,
          });
          return;
        }
        invalidateEnvState();
        setSuccessLatencyMs(result.data.verifiedLatencyMs);
        await advanceToReview();
      } finally {
        setSubmitting(false);
      }
    },
    [advanceToReview, endpointTag, invalidateEnvState, model],
  );

  const meta = WIZARD_STEP_META.provider;

  // ── Configured screen ────────────────────────────────────────────
  // Owned by `ConfiguredProviderPanel`: status rows + an inline delta editor
  // that can save a model/routing change WITHOUT re-entering the API key.
  // "Reconfigure" still falls through to the full first-run form below.
  if (configured && !showOverride) {
    return (
      <ConfiguredProviderPanel
        providerName={effectiveName}
        activeModel={effectiveModel}
        activeEndpointTag={effectiveEndpointTag}
        flowMode={flowMode}
        onContinue={() => {
          void advanceToReview();
        }}
        onReconfigure={() => setShowOverride(true)}
        continuePending={stepAdvance.isPending}
        advanceError={clientError}
      />
    );
  }

  // ── Form ─────────────────────────────────────────────────────────
  // The inference provider is OPTIONAL at setup (configure later in
  // Settings), but it carries the strongest consequence: without a
  // provider the agent cannot run inference at all. In the forward setup
  // flow we let the operator advance, surfacing that warning prominently.
  const showConfigureLater = flowMode === "first-pass";
  return (
    <WizardStepPanel
      panelDataAttr={{ kind: "provider", value: "form" }}
      icon={meta.icon}
      flowMode={flowMode}
      title="Inference provider"
      description="OpenRouter is the model backend the agent thinks with. The key buys inference only — your wallet keys and vault contents are never sent to the model provider. Optional here, but the agent cannot run until one is configured."
      formProps={{
        onSubmit: (e) => {
          void onSubmit(e);
        },
        noValidate: true,
        providerFormAttr: "openrouter",
      }}
      footer={
        <>
          {showConfigureLater ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                void advanceToReview();
              }}
              disabled={submitting || stepAdvance.isPending}
              data-vex-provider-configure-later
            >
              {stepAdvance.isPending
                ? "Continuing..."
                : "Continue without a provider"}
            </Button>
          ) : null}
          <Button type="submit" disabled={submitting || stepAdvance.isPending}>
            {submitting
              ? "Verifying..."
              : stepAdvance.isPending
                ? "Continuing..."
                : "Verify and save"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {showConfigureLater ? (
          <p
            role="status"
            data-vex-provider-configure-later-alert
            className="border-l-2 border-[color-mix(in_oklab,var(--color-warning)_45%,transparent)] py-0.5 pl-3 text-sm text-[var(--color-warning)]"
          >
            The agent cannot run any inference without a provider — it will
            stay idle until you add an OpenRouter key and model. You can do
            this later from Settings, but nothing will run until then.
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Label htmlFor="vex-provider-key">OpenRouter API key</Label>
          <PasswordField
            id="vex-provider-key"
            ref={apiKeyRef}
            placeholder="sk-or-..."
            autoFocus
          />
          <p className="text-xs text-[var(--color-text-muted)]">
            Create or copy your key at{" "}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-text-primary)] underline underline-offset-2 hover:text-[var(--color-text-secondary)]"
            >
              openrouter.ai/keys
            </a>
            . Stored on this machine in your local config and sent only
            to OpenRouter when you invoke the agent.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label
            htmlFor="vex-provider-model"
            className="flex items-center gap-2"
          >
            <ModelBrandIcon modelId={model} size={16} />
            Model id
          </Label>
          <ModelPicker
            id="vex-provider-model"
            value={model}
            models={catalogueModels}
            loading={providerModels.isLoading}
            failed={catalogueFailed}
            disabled={submitting || stepAdvance.isPending}
            onChange={onModelChange}
            onRetry={() => {
              void providerModels.refetch();
            }}
          />
          <p className="text-xs text-[var(--color-text-muted)]">
            Browse tool-capable models or enter any OpenRouter model id. View
            the full catalogue at{" "}
            <a
              href="https://openrouter.ai/models"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-text-primary)] underline underline-offset-2 hover:text-[var(--color-text-secondary)]"
            >
              openrouter.ai/models
            </a>
            .
          </p>
        </div>

        {selectedCatalogueModelId !== null ? (
          <EndpointPicker
            id="vex-provider-endpoint"
            value={endpointTag}
            endpoints={endpointOptions}
            loading={providerEndpoints.isLoading}
            failed={endpointsFailed}
            disabled={submitting || stepAdvance.isPending}
            onChange={setEndpointTag}
            onRetry={() => {
              void providerEndpoints.refetch();
            }}
          />
        ) : null}

        {clientError ? (
          <p className="text-sm text-[var(--color-danger)]" role="alert">
            {clientError}
          </p>
        ) : null}

        {serverError ? (
          <ProviderErrorAlert
            error={serverError}
            onOpenLogsFolder={openLogsFolder}
          />
        ) : null}

        {successLatencyMs !== null ? (
          <div
            role="status"
            data-vex-provider-success="true"
            className="text-sm text-[var(--color-success)]"
          >
            OpenRouter verified ({successLatencyMs}ms). Changes apply the
            next time the agent starts.
          </div>
        ) : null}
      </div>
    </WizardStepPanel>
  );
}
