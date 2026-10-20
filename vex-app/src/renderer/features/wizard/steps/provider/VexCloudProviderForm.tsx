/**
 * The provider step's Vex Cloud branch: sign in (the shared account panel),
 * pick a model from the Vex Cloud list, save.
 *
 * Saving sends `{provider: "vexcloud", model}` and nothing else: no key is
 * typed here, because the credential is the session the sign-in stored. Main
 * re-checks that session against Vex Cloud and the model against its list
 * before anything is written, and the agent switches on its next start.
 *
 * Efforts: Vex Cloud models always reason (no Off), and the composer reads
 * the levels from the Vex Cloud list once this provider is active.
 */

import { useCallback, useState, type FormEvent, type JSX, type ReactNode } from "react";
import type { EnvState } from "@shared/schemas/onboarding.js";
import { Button } from "../../../../components/ui/button.js";
import { Label } from "../../../../components/ui/label.js";
import {
  persistProvider,
  useInvalidateEnvStateAfterProviderWrite,
  useProviderModels,
} from "../../../../lib/api/provider.js";
import { useVexCloudAccount } from "../../../../lib/api/vex-cloud.js";
import type { WizardFlowMode } from "../../../../lib/api/wizard.js";
import { VexCloudAccountPanel } from "../../../vexCloud/VexCloudAccountPanel.js";
import { WizardStepPanel } from "../../WizardStepPanel.js";
import { ModelBrandIcon } from "./ModelBrandIcon.js";
import { ModelPicker } from "./ModelPicker.js";

export interface VexCloudProviderFormProps {
  readonly env: EnvState | null;
  readonly flowMode: WizardFlowMode;
  /** The OpenRouter / Vex Cloud choice, rendered at the top. */
  readonly choice: ReactNode;
  /** The model already in effect when Vex Cloud is the active provider. */
  readonly activeModel: string | null;
  readonly onSaved: () => Promise<void>;
  /** First-pass setup only: advance without a provider. */
  readonly onContinueWithout: (() => void) | null;
  readonly advancePending: boolean;
  readonly advanceError: string | null;
}

export function VexCloudProviderForm({
  env,
  flowMode,
  choice,
  activeModel,
  onSaved,
  onContinueWithout,
  advancePending,
  advanceError,
}: VexCloudProviderFormProps): JSX.Element {
  const invalidateEnvState = useInvalidateEnvStateAfterProviderWrite();
  const account = useVexCloudAccount();
  const signedIn = account.data?.ok === true && account.data.data.state === "signed_in";
  const models = useProviderModels(true, "vexcloud");
  const catalogue = models.data?.ok === true ? models.data.data.models : [];
  const catalogueFailed = models.isError || models.data?.ok === false;

  const [model, setModel] = useState<string>(activeModel ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMs, setSavedMs] = useState<number | null>(null);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      setSavedMs(null);
      const modelId = model.trim();
      if (!signedIn) {
        setError("Sign in to Vex Cloud first.");
        return;
      }
      if (!catalogue.some((option) => option.modelId === modelId)) {
        setError("Pick a model from the Vex Cloud list.");
        return;
      }
      setSubmitting(true);
      try {
        const result = await persistProvider({ provider: "vexcloud", model: modelId });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        invalidateEnvState();
        setSavedMs(result.data.verifiedLatencyMs);
        await onSaved();
      } finally {
        setSubmitting(false);
      }
    },
    [catalogue, invalidateEnvState, model, onSaved, signedIn],
  );

  const busy = submitting || advancePending;
  return (
    <WizardStepPanel
      panelDataAttr={{ kind: "provider", value: "form" }}
      flowMode={flowMode}
      env={env}
      title="Inference provider"
      description="Vex Cloud runs the agent's models and charges your VEX balance per request. Your wallet keys and vault contents never leave this computer; only the conversation is sent to the model."
      formProps={{
        onSubmit: (event) => {
          void onSubmit(event);
        },
        noValidate: true,
        providerFormAttr: "vexcloud",
      }}
      footer={
        <>
          {onContinueWithout !== null ? (
            <Button type="button" variant="quiet" onClick={onContinueWithout} disabled={busy}>
              {advancePending ? "Continuing..." : "Continue without a provider"}
            </Button>
          ) : null}
          <Button type="submit" disabled={busy || !signedIn || model.trim().length === 0}>
            {submitting ? "Checking..." : advancePending ? "Continuing..." : "Use Vex Cloud"}
          </Button>
        </>
      }
    >
      <div className="vex-wz-stack">
        {choice}
        <VexCloudAccountPanel />
        <div className="vex-wz-group">
          <Label htmlFor="vex-provider-cloud-model" className="flex items-center gap-2">
            <ModelBrandIcon modelId={model} size={16} />
            Model
          </Label>
          <ModelPicker
            id="vex-provider-cloud-model"
            value={model}
            models={catalogue}
            loading={models.isLoading}
            failed={catalogueFailed}
            disabled={busy}
            onChange={setModel}
            onRetry={() => {
              void models.refetch();
            }}
          />
          <p className="vex-wz-hint">
            <span>The models Vex Cloud offers. Prices include the Vex Cloud margin and are charged in VEX.</span>
          </p>
        </div>
        {error !== null || advanceError !== null ? (
          <p className="text-sm text-ink-primary" role="alert">
            {error ?? advanceError}
          </p>
        ) : null}
        {savedMs !== null ? (
          <div role="status" data-vex-provider-success="vexcloud" className="text-sm text-ink-primary">
            Vex Cloud saved ({savedMs}ms). Changes apply the next time the agent starts.
          </div>
        ) : null}
      </div>
    </WizardStepPanel>
  );
}
