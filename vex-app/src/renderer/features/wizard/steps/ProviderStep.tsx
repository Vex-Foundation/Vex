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
 * Skip-card branch: when `envState.provider.configured` is true the
 * user sees the current provider + modelLabel summary (with the
 * resolved brand icon for the model prefix) + Continue button.
 * "Reconfigure" reveals the form.
 *
 * AGENT_MODEL is NOT a secret — model ids are public catalogue
 * entries — so it stays in React state. The API key inputs (primary +
 * optional fallback) are the ONLY secrets in this step, and both are
 * uncontrolled refs cleared synchronously before the await.
 *
 * Optional fallback provider: a collapsed "+ Add a fallback provider"
 * section adds a second key + model id. Validated both-or-neither in
 * the renderer AND at the IPC boundary, and BOTH providers are verified
 * before anything is persisted — a fallback that only fails mid-mission
 * (exactly when it is needed) is worse than no fallback at all. The
 * engine retries the primary first and switches over only once those
 * retries are exhausted (`src/vex-agent/inference/failover.ts`).
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
  useProviderModels,
  useInvalidateEnvStateAfterProviderWrite,
} from "../../../lib/api/provider.js";
import {
  useStepAdvance,
  type WizardFlowMode,
} from "../../../lib/api/wizard.js";
import { WIZARD_STEP_META } from "../wizard-icons.js";
import { WizardStepPanel } from "../WizardStepPanel.js";
import { CAUSE_HINTS, uiCopyFor, type ServerError } from "./provider/error-ui.js";
import { ModelBrandIcon } from "./provider/ModelBrandIcon.js";
import { ModelPicker } from "./provider/ModelPicker.js";

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
  const [submitting, setSubmitting] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<ServerError | null>(null);
  const [successLatencyMs, setSuccessLatencyMs] = useState<number | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const apiKeyRef = useRef<HTMLInputElement | null>(null);

  // ── Optional fallback provider ───────────────────────────────────
  // Collapsed by default: it is genuinely optional, and expanding the step
  // by two more required-looking fields would make the common single-provider
  // path feel heavier than it is.
  const [showFallback, setShowFallback] = useState(false);
  const [fallbackModel, setFallbackModel] = useState<string>("");
  const fallbackApiKeyRef = useRef<HTMLInputElement | null>(null);

  const providerState =
    envQuery.data?.ok === true ? envQuery.data.data.provider : null;
  const configured = providerState?.configured ?? false;
  const effectiveName = providerState?.name ?? null;
  const effectiveModel = providerState?.modelLabel ?? null;
  const providerModels = useProviderModels(!configured || showOverride);
  const providerModelsResult = providerModels.data;
  const catalogueModels =
    providerModelsResult?.ok === true ? providerModelsResult.data.models : [];
  const catalogueFailed =
    providerModels.isError || providerModelsResult?.ok === false;

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

      // Optional fallback — both-or-neither, validated before we touch the
      // network so the user fixes it inline rather than via a server error.
      const fallbackApiKeyRaw = showFallback
        ? (fallbackApiKeyRef.current?.value ?? "")
        : "";
      const fallbackApiKey = fallbackApiKeyRaw.trim();
      const fallbackModelTrim = showFallback ? fallbackModel.trim() : "";
      const hasFallbackKey = fallbackApiKey.length > 0;
      const hasFallbackModel = fallbackModelTrim.length > 0;

      if (hasFallbackKey !== hasFallbackModel) {
        setClientError(
          "The fallback provider needs both an API key and a model id — fill both, or clear both.",
        );
        return;
      }
      if (fallbackApiKey.length > 200 || fallbackModelTrim.length > 200) {
        setClientError(
          "API key and model id must each be shorter than 200 characters.",
        );
        return;
      }

      // Snapshot, clear refs SYNCHRONOUSLY before await (skill §14) — both
      // secrets, so neither is parked in a DOM node across the await.
      const payload: ProviderPersistInput = {
        provider: "openrouter",
        apiKey,
        model: modelTrim,
        ...(hasFallbackKey && hasFallbackModel
          ? { fallbackApiKey, fallbackModel: fallbackModelTrim }
          : {}),
      };
      if (apiKeyRef.current) {
        apiKeyRef.current.value = "";
      }
      if (fallbackApiKeyRef.current) {
        fallbackApiKeyRef.current.value = "";
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
          const scopeRaw = result.error.details?.scope;
          setServerError({
            code: result.error.code,
            correlationId: result.error.correlationId ?? null,
            causeCode:
              typeof causeCodeRaw === "string" ? causeCodeRaw : null,
            scope: scopeRaw === "fallback" ? "fallback" : "primary",
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
    [advanceToReview, invalidateEnvState, model, showFallback, fallbackModel],
  );

  const meta = WIZARD_STEP_META.provider;

  // ── Skip card ────────────────────────────────────────────────────
  if (configured && !showOverride) {
    return (
      <WizardStepPanel
        panelDataAttr={{ kind: "provider", value: "skip" }}
        icon={meta.icon}
        flowMode={flowMode}
        title="Provider is configured"
        description={
          effectiveName === "openrouter"
            ? "OpenRouter is active. Changes apply the next time the agent starts."
            : "A provider is configured."
        }
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setShowOverride(true)}
              disabled={stepAdvance.isPending}
            >
              Reconfigure
            </Button>
            <Button
              onClick={() => {
                void advanceToReview();
              }}
              disabled={stepAdvance.isPending}
            >
              {stepAdvance.isPending
                ? "Continuing…"
                : flowMode === "back-edit"
                  ? "Done"
                  : "Continue"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {effectiveModel ? (
            <div className="flex items-center gap-3 border-t border-white/[0.12] pt-4">
              <ModelBrandIcon modelId={effectiveModel} size={22} />
              <div className="flex min-w-0 flex-col">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
                  Active model
                </span>
                <code className="truncate font-mono text-sm text-[var(--color-text-primary)]">
                  {effectiveModel}
                </code>
              </div>
            </div>
          ) : null}
          {clientError ? (
            <p className="text-sm text-[var(--color-danger)]" role="alert">
              {clientError}
            </p>
          ) : null}
        </div>
      </WizardStepPanel>
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
            onChange={setModel}
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

        {/* Optional fallback provider — collapsed by default. */}
        {showFallback ? (
          <div
            className="flex flex-col gap-4 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4"
            data-vex-provider-fallback="open"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs text-[var(--color-text-muted)]">
                Used only if the model above keeps failing — the agent retries
                the primary first and switches over only after those retries
                are exhausted. A different key or model here is what makes it
                useful.
              </p>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  // Clear both fields on collapse so a hidden half-filled
                  // fallback can never be submitted.
                  if (fallbackApiKeyRef.current) {
                    fallbackApiKeyRef.current.value = "";
                  }
                  setFallbackModel("");
                  setShowFallback(false);
                }}
                disabled={submitting || stepAdvance.isPending}
              >
                Remove
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="vex-provider-fallback-key">
                Fallback API key
              </Label>
              <PasswordField
                id="vex-provider-fallback-key"
                ref={fallbackApiKeyRef}
                placeholder="sk-or-..."
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label
                htmlFor="vex-provider-fallback-model"
                className="flex items-center gap-2"
              >
                <ModelBrandIcon modelId={fallbackModel} size={16} />
                Fallback model id
              </Label>
              <ModelPicker
                id="vex-provider-fallback-model"
                value={fallbackModel}
                models={catalogueModels}
                loading={providerModels.isLoading}
                failed={catalogueFailed}
                disabled={submitting || stepAdvance.isPending}
                onChange={setFallbackModel}
                onRetry={() => {
                  void providerModels.refetch();
                }}
              />
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowFallback(true)}
            disabled={submitting || stepAdvance.isPending}
            data-vex-provider-fallback="collapsed"
            className="self-start text-sm text-[var(--vex-onboarding-accent)] underline-offset-2 hover:underline disabled:opacity-50"
          >
            + Add a fallback provider (optional)
          </button>
        )}

        {clientError ? (
          <p className="text-sm text-[var(--color-danger)]" role="alert">
            {clientError}
          </p>
        ) : null}

        {serverError ? (
          <div
            role="alert"
            data-vex-provider-error={String(serverError.code)}
            className="border-l-2 border-[color-mix(in_oklab,var(--color-danger)_45%,transparent)] py-1 pl-3 text-sm text-[var(--color-danger)]"
          >
            <strong className="block font-semibold">
              {serverError.scope === "fallback"
                ? `Fallback provider — ${uiCopyFor(String(serverError.code)).title}`
                : uiCopyFor(String(serverError.code)).title}
            </strong>
            {serverError.scope === "fallback" ? (
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                Your primary provider verified fine. Fix or remove the fallback
                to continue — nothing was saved.
              </p>
            ) : null}
            <p className="mt-1">
              {uiCopyFor(String(serverError.code)).body}
            </p>
            {serverError.causeCode !== null ? (
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                Cause:{" "}
                <code className="font-mono">{serverError.causeCode}</code>
              </p>
            ) : null}
            {serverError.causeCode !== null &&
            CAUSE_HINTS[serverError.causeCode] !== undefined ? (
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {CAUSE_HINTS[serverError.causeCode]}
              </p>
            ) : null}
            {serverError.correlationId ? (
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                Correlation id:{" "}
                <code className="font-mono">
                  {serverError.correlationId}
                </code>{" "}
                <button
                  type="button"
                  onClick={openLogsFolder}
                  className="text-[var(--color-text-primary)] underline underline-offset-2 hover:text-[var(--color-text-secondary)]"
                >
                  Open logs folder
                </button>
              </p>
            ) : null}
          </div>
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
