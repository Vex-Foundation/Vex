/**
 * The "Provider is configured" screen — status view plus an INLINE delta
 * editor.
 *
 * Why this exists: changing only the model used to force a full reconfigure,
 * which meant re-typing the API key for a change that had nothing to do with
 * it. Here the three configured facts are DISPLAYED (key status, model,
 * routing), and "Edit configuration" reveals the pickers prefilled with the
 * current values plus an OPTIONAL replace-key field. Leaving that field blank
 * omits `apiKey` from the persist payload entirely, and main verifies the new
 * selection against the key already in the vault.
 *
 * SECURITY — the stored key never reaches this component, in any form. There
 * is no value, no length, no prefix, no masked tail to render: the only thing
 * the renderer knows is `configured: true` from the env-state probe, so the
 * key row is a literal status word. The replace field is an UNCONTROLLED ref
 * cleared synchronously before the await (skill §14), exactly like the
 * first-run form — a new key is never parked in React state.
 *
 * Extracted from `ProviderStep.tsx`, which owns the first-run form and was at
 * the file-size ceiling; the configured state is a different reason to change.
 */

import { useCallback, useRef, useState, type JSX } from "react";
import type { ProviderPersistInput } from "@shared/schemas/provider.js";
import { Button } from "../../../../components/ui/button.js";
import { Label } from "../../../../components/ui/label.js";
import { PasswordField } from "../../../../components/common/PasswordField.js";
import {
  persistProvider,
  useProviderEndpoints,
  useProviderModels,
  useInvalidateEnvStateAfterProviderWrite,
} from "../../../../lib/api/provider.js";
import type { WizardFlowMode } from "../../../../lib/api/wizard.js";
import { WIZARD_STEP_META } from "../../wizard-icons.js";
import { WizardStepPanel } from "../../WizardStepPanel.js";
import type { ServerError } from "./error-ui.js";
import { ModelBrandIcon } from "./ModelBrandIcon.js";
import { ModelPicker } from "./ModelPicker.js";
import { EndpointPicker } from "./EndpointPicker.js";
import { ProviderErrorAlert } from "./ProviderErrorAlert.js";

export interface ConfiguredProviderPanelProps {
  readonly providerName: "openrouter" | null;
  /** Currently active `AGENT_MODEL`, or `null` when the probe found none. */
  readonly activeModel: string | null;
  /** Active `OPENROUTER_ENDPOINT_TAG`, or `null` for Auto routing. */
  readonly activeEndpointTag: string | null;
  readonly flowMode: WizardFlowMode;
  /** Advance out of this step (Continue / Done). */
  readonly onContinue: () => void;
  /** Reveal the full first-run form (unchanged legacy path). */
  readonly onReconfigure: () => void;
  readonly continuePending: boolean;
  /** Step-advance failure text owned by the hosting step. */
  readonly advanceError: string | null;
}

const AUTO_ROUTING_LABEL = "Auto (recommended)";

const ROW_CLASS =
  "flex items-center gap-3 border-t border-[var(--color-border)] pt-4";

function StatusRow({
  label,
  children,
  icon,
  testValue,
}: {
  readonly label: string;
  readonly children: JSX.Element | string;
  readonly icon?: JSX.Element;
  readonly testValue: string;
}): JSX.Element {
  return (
    <div className={ROW_CLASS} data-vex-provider-status={testValue}>
      {icon ?? null}
      <div className="flex min-w-0 flex-col">
        <span className="vex-micro text-[var(--color-text-muted)]">
          {label}
        </span>
        {typeof children === "string" ? (
          <span className="truncate text-sm text-[var(--color-text-primary)]">
            {children}
          </span>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

export function ConfiguredProviderPanel({
  providerName,
  activeModel,
  activeEndpointTag,
  flowMode,
  onContinue,
  onReconfigure,
  continuePending,
  advanceError,
}: ConfiguredProviderPanelProps): JSX.Element {
  const invalidateEnvState = useInvalidateEnvStateAfterProviderWrite();

  const [editing, setEditing] = useState(false);
  // Prefilled from the live configuration, so an untouched field saves the
  // value that is already in effect rather than clearing it.
  const [model, setModel] = useState<string>(activeModel ?? "");
  const [endpointTag, setEndpointTag] = useState<string | null>(
    activeEndpointTag,
  );
  const [submitting, setSubmitting] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<ServerError | null>(null);
  const [savedLatencyMs, setSavedLatencyMs] = useState<number | null>(null);
  const apiKeyRef = useRef<HTMLInputElement | null>(null);

  const providerModels = useProviderModels(editing);
  const providerModelsResult = providerModels.data;
  const catalogueModels =
    providerModelsResult?.ok === true ? providerModelsResult.data.models : [];
  const catalogueFailed =
    providerModels.isError || providerModelsResult?.ok === false;

  // While editing, endpoints are fetched for an EXACT catalogue match only
  // (same rule as the first-run form). While reading, they are fetched only
  // when a pin exists — purely to resolve its display name, and never for an
  // Auto configuration, which needs no lookup at all.
  const selectedCatalogueModelId =
    catalogueModels.find((option) => option.modelId === model.trim())
      ?.modelId ?? null;
  const endpointModelId = editing
    ? selectedCatalogueModelId
    : activeEndpointTag !== null
      ? activeModel
      : null;
  const providerEndpoints = useProviderEndpoints(endpointModelId);
  const providerEndpointsResult = providerEndpoints.data;
  const endpointOptions =
    providerEndpointsResult?.ok === true
      ? providerEndpointsResult.data.endpoints
      : [];
  const endpointsFailed =
    providerEndpoints.isError || providerEndpointsResult?.ok === false;

  // Fall back to the raw tag when the catalogue has not resolved a friendly
  // name: showing the tag is honest, showing nothing would hide the pin.
  const activeRoutingLabel =
    activeEndpointTag === null
      ? AUTO_ROUTING_LABEL
      : (endpointOptions.find((e) => e.tag === activeEndpointTag)
          ?.providerName ?? activeEndpointTag);

  const openLogsFolder = useCallback(() => {
    void window.vex.support.openLogsFolder().catch(() => undefined);
  }, []);

  const startEditing = useCallback(() => {
    setModel(activeModel ?? "");
    setEndpointTag(activeEndpointTag);
    setClientError(null);
    setServerError(null);
    setSavedLatencyMs(null);
    setEditing(true);
  }, [activeEndpointTag, activeModel]);

  const cancelEditing = useCallback(() => {
    if (apiKeyRef.current) apiKeyRef.current.value = "";
    setClientError(null);
    setServerError(null);
    setEditing(false);
  }, []);

  // Changing the model invalidates any pin: endpoint tags are per-model, and
  // carrying one across would submit a tag main will (correctly) reject.
  const onModelChange = useCallback(
    (next: string) => {
      setModel(next);
      setEndpointTag(next.trim() === (activeModel ?? "") ? activeEndpointTag : null);
    },
    [activeEndpointTag, activeModel],
  );

  const onSave = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setClientError(null);
      setServerError(null);
      setSavedLatencyMs(null);

      const replacementKey = (apiKeyRef.current?.value ?? "").trim();
      const modelTrim = model.trim();

      if (modelTrim.length === 0) {
        setClientError("Choose a model, or cancel to keep the current one.");
        return;
      }
      if (modelTrim.length > 200 || replacementKey.length > 200) {
        setClientError(
          "API key and model id must each be shorter than 200 characters.",
        );
        return;
      }

      // Blank replacement field ⇒ OMIT `apiKey` entirely. That is the whole
      // point of this screen: main then verifies against the stored key.
      const payload: ProviderPersistInput = {
        provider: "openrouter",
        model: modelTrim,
        ...(replacementKey.length > 0 && { apiKey: replacementKey }),
        ...(endpointTag !== null && { endpointTag }),
      };
      // Clear the ref SYNCHRONOUSLY before the await (skill §14).
      if (apiKeyRef.current) apiKeyRef.current.value = "";

      setSubmitting(true);
      try {
        const result = await persistProvider(payload);
        if (!result.ok) {
          const causeCodeRaw = result.error.details?.causeCode;
          setServerError({
            code: result.error.code,
            correlationId: result.error.correlationId ?? null,
            causeCode: typeof causeCodeRaw === "string" ? causeCodeRaw : null,
          });
          return;
        }
        invalidateEnvState();
        setSavedLatencyMs(result.data.verifiedLatencyMs);
        setEditing(false);
      } finally {
        setSubmitting(false);
      }
    },
    [endpointTag, invalidateEnvState, model],
  );

  const meta = WIZARD_STEP_META.provider;
  const busy = submitting || continuePending;

  const description =
    providerName === "openrouter"
      ? "OpenRouter is active. Changes apply the next time the agent starts."
      : "A provider is configured.";

  return (
    <WizardStepPanel
      panelDataAttr={{ kind: "provider", value: "skip" }}
      icon={meta.icon}
      flowMode={flowMode}
      title="Provider is configured"
      description={description}
      {...(editing && {
        formProps: {
          onSubmit: (e) => {
            void onSave(e);
          },
          noValidate: true,
        },
      })}
      footer={
        editing ? (
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={cancelEditing}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {submitting ? "Verifying…" : "Save changes"}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              onClick={onReconfigure}
              disabled={continuePending}
            >
              Reconfigure
            </Button>
            <Button
              variant="ghost"
              onClick={startEditing}
              disabled={continuePending}
              data-vex-provider-edit
            >
              Edit configuration
            </Button>
            <Button onClick={onContinue} disabled={continuePending}>
              {continuePending
                ? "Continuing…"
                : flowMode === "back-edit"
                  ? "Done"
                  : "Continue"}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {editing ? (
          <>
            <div className="flex flex-col gap-2">
              <Label
                htmlFor="vex-provider-edit-model"
                className="flex items-center gap-2"
              >
                <ModelBrandIcon modelId={model} size={16} />
                Model id
              </Label>
              <ModelPicker
                id="vex-provider-edit-model"
                value={model}
                models={catalogueModels}
                loading={providerModels.isLoading}
                failed={catalogueFailed}
                disabled={busy}
                onChange={onModelChange}
                onRetry={() => {
                  void providerModels.refetch();
                }}
              />
            </div>

            {selectedCatalogueModelId !== null ? (
              <EndpointPicker
                id="vex-provider-edit-endpoint"
                value={endpointTag}
                endpoints={endpointOptions}
                loading={providerEndpoints.isLoading}
                failed={endpointsFailed}
                disabled={busy}
                onChange={setEndpointTag}
                onRetry={() => {
                  void providerEndpoints.refetch();
                }}
              />
            ) : null}

            <div className="flex flex-col gap-2">
              <Label htmlFor="vex-provider-replace-key">
                Replace API key (optional)
              </Label>
              <PasswordField
                id="vex-provider-replace-key"
                ref={apiKeyRef}
                placeholder="sk-or-..."
              />
              <p className="text-xs text-[var(--color-text-muted)]">
                Leave blank to keep the current key. Your saved key is never
                shown here — it stays in the encrypted vault on this machine.
              </p>
            </div>
          </>
        ) : (
          <>
            <StatusRow label="API key" testValue="apiKey">
              Configured
            </StatusRow>
            {activeModel !== null ? (
              <StatusRow
                label="Active model"
                testValue="model"
                icon={<ModelBrandIcon modelId={activeModel} size={22} />}
              >
                <code className="truncate font-mono text-sm text-[var(--color-text-primary)]">
                  {activeModel}
                </code>
              </StatusRow>
            ) : null}
            <StatusRow label="Provider" testValue="endpoint">
              {activeRoutingLabel}
            </StatusRow>
          </>
        )}

        {(clientError ?? advanceError) !== null ? (
          <p className="text-sm text-[var(--color-danger)]" role="alert">
            {clientError ?? advanceError}
          </p>
        ) : null}

        {serverError ? (
          <ProviderErrorAlert
            error={serverError}
            onOpenLogsFolder={openLogsFolder}
          />
        ) : null}

        {savedLatencyMs !== null && !editing ? (
          <div
            role="status"
            data-vex-provider-success="true"
            className="text-sm text-[var(--color-success)]"
          >
            OpenRouter verified ({savedLatencyMs}ms). Changes apply the next
            time the agent starts.
          </div>
        ) : null}
      </div>
    </WizardStepPanel>
  );
}
