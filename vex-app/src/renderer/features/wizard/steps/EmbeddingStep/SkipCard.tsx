/**
 * EmbeddingStep skip-card - rendered when
 * `envState.embeddings.allFieldsConfigured` is true and the user has not
 * chosen to override. Extracted VERBATIM from `EmbeddingStep.tsx` (god-file
 * split); zero behavior change.
 *
 * R3 composition: the facts the description states (endpoint, bundled model,
 * dim, reachable or not) stand again as label and value rows, the endpoint in
 * mono with its reachable state as a `StateWord` (a fill and a word); the
 * override is a text action at the end of its own sentence. The words are the
 * code's own: no row shows a value the env read does not carry.
 *
 * Chrome lives in `WizardStepPanel` - `data-vex-wizard-embedding="skip"`
 * forwarded onto the panel root. In Settings the head's lead is the Memory
 * section's own hint (the rows already state what the description says).
 */

import type { JSX } from "react";
import { EMBEDDING_DIM } from "@shared/embedding-defaults.js";
import type { EnvState } from "@shared/schemas/onboarding.js";
import { type WizardFlowMode } from "../../../../lib/api/wizard.js";
import { Button } from "../../../../components/ui/button.js";
import { StateWord } from "../../../../components/ui/state-word.js";
import { WizardStepPanel, settingsSectionFor } from "../../WizardStepPanel.js";

interface EmbeddingsState {
  readonly baseUrlRedacted: string | null;
  readonly reachable: boolean;
}

export interface EmbeddingSkipCardProps {
  /** The step's own env read, for the Settings section's status word. */
  readonly env: EnvState | null;
  readonly embeddingsState: EmbeddingsState | null;
  readonly flowMode: WizardFlowMode;
  readonly isPending: boolean;
  readonly advanceError: string | null;
  readonly onOverride: () => void;
  readonly onContinue: () => void;
}

export function EmbeddingSkipCard({
  env,
  embeddingsState,
  flowMode,
  isPending,
  advanceError,
  onOverride,
  onContinue,
}: EmbeddingSkipCardProps): JSX.Element {
  const baseUrl = embeddingsState?.baseUrlRedacted ?? null;
  const reachable = embeddingsState?.reachable === true;
  return (
    <WizardStepPanel
      panelDataAttr={{ kind: "embedding", value: "skip" }}
      flowMode={flowMode}
      env={env}
      title="Embedding configuration is set"
      settingsDescription={settingsSectionFor("embedding")?.hint}
      description={
        embeddingsState?.baseUrlRedacted ? (
          <>
            Vex is using <code>{embeddingsState.baseUrlRedacted}</code>{" "}
            (bundled EmbeddingGemma 300M, dim {EMBEDDING_DIM}) -{" "}
            {embeddingsState.reachable ? (
              <span className="text-success">reachable</span>
            ) : (
              <>
                <span className="text-warning">
                  not reachable
                </span>{" "}
                yet; the runtime may still be loading the model
              </>
            )}
            .
          </>
        ) : (
          "Bundled EmbeddingGemma 300M is configured."
        )
      }
      footer={
        <Button onClick={onContinue} disabled={isPending}>
          {isPending
            ? "Continuing…"
            : flowMode === "back-edit"
              ? "Done"
              : "Continue"}
        </Button>
      }
    >
      <div className="vex-wz-stack">
        {baseUrl !== null && baseUrl !== "" ? (
          <div className="vex-wz-kvl">
            <div className="vex-wz-kv">
              <span className="vex-wz-kv__k">Endpoint</span>
              <span className="vex-wz-kv__v">
                <code className="font-mono vex-num text-[13px]">{baseUrl}</code>
                {reachable ? null : (
                  <span className="vex-wz-kv__sub">
                    the runtime may still be loading the model
                  </span>
                )}
              </span>
              <span className="vex-wz-kv__a">
                <StateWord
                  state={reachable ? "done" : "awaiting"}
                  word={reachable ? "Reachable" : "Not reachable"}
                />
              </span>
            </div>
            <div className="vex-wz-kv">
              <span className="vex-wz-kv__k">Model</span>
              <span className="vex-wz-kv__v">
                EmbeddingGemma 300M{" "}
                <span className="text-ink-tertiary">(bundled)</span>
              </span>
            </div>
            <div className="vex-wz-kv">
              <span className="vex-wz-kv__k">Dim</span>
              <span className="vex-wz-kv__v font-mono vex-num text-[13px]">
                {EMBEDDING_DIM}
              </span>
            </div>
          </div>
        ) : null}

        {advanceError ? (
          <p className="text-sm text-danger" role="alert">
            {advanceError}
          </p>
        ) : null}

        <p className="vex-wz-text">
          Override to point at a different OpenAI-compatible endpoint.{" "}
          <button
            type="button"
            className="vex-wz-link"
            onClick={onOverride}
            disabled={isPending}
          >
            Override
          </button>
        </p>
      </div>
    </WizardStepPanel>
  );
}
