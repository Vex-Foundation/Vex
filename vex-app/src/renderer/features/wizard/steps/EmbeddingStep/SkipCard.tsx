/**
 * EmbeddingStep skip-card — rendered when
 * `envState.embeddings.allFieldsConfigured` is true and the user has not
 * chosen to override. Extracted VERBATIM from `EmbeddingStep.tsx` (god-file
 * split); zero behavior change.
 *
 * Chrome lives in `WizardStepPanel` — `data-vex-wizard-embedding="skip"`
 * forwarded onto the panel root.
 */

import type { JSX } from "react";
import type { IconGlyph } from "../../../../components/icons/index.js";
import { EMBEDDING_DIM } from "@shared/embedding-defaults.js";
import { type WizardFlowMode } from "../../../../lib/api/wizard.js";
import { Button } from "../../../../components/ui/button.js";
import { WizardStepPanel } from "../../WizardStepPanel.js";

interface EmbeddingsState {
  readonly baseUrlRedacted: string | null;
  readonly reachable: boolean;
}

export interface EmbeddingSkipCardProps {
  readonly icon: IconGlyph;
  readonly embeddingsState: EmbeddingsState | null;
  readonly flowMode: WizardFlowMode;
  readonly isPending: boolean;
  readonly advanceError: string | null;
  readonly onOverride: () => void;
  readonly onContinue: () => void;
}

export function EmbeddingSkipCard({
  icon,
  embeddingsState,
  flowMode,
  isPending,
  advanceError,
  onOverride,
  onContinue,
}: EmbeddingSkipCardProps): JSX.Element {
  return (
    <WizardStepPanel
      panelDataAttr={{ kind: "embedding", value: "skip" }}
      icon={icon}
      flowMode={flowMode}
      title="Embedding configuration is set"
      description={
        embeddingsState?.baseUrlRedacted ? (
          <>
            Vex is using <code>{embeddingsState.baseUrlRedacted}</code>{" "}
            (bundled EmbeddingGemma 300M, dim {EMBEDDING_DIM}) —{" "}
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
        <>
          <Button
            variant="ghost"
            onClick={onOverride}
            disabled={isPending}
          >
            Override
          </Button>
          <Button
            onClick={onContinue}
            disabled={isPending}
          >
            {isPending
              ? "Continuing…"
              : flowMode === "back-edit"
                ? "Done"
                : "Continue"}
          </Button>
        </>
      }
    >
      {advanceError ? (
        <p className="text-sm text-danger" role="alert">
          {advanceError}
        </p>
      ) : (
        <p className="text-sm text-ink-secondary">
          Override to point at a different OpenAI-compatible endpoint.
        </p>
      )}
    </WizardStepPanel>
  );
}
