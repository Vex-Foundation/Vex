/**
 * ApiKeysSkipPanel — the "already configured" skip surface of
 * ApiKeysStep.
 *
 * Rendered only in `first-pass` flow when JUPITER_API_KEY is set (the
 * `canSkip` gate lives in the parent). Presentational: it owns no state.
 * The parent passes the skip-continue handler, the advance-pending flag,
 * and the current form error.
 *
 * Markup, accessibility (role="alert", focus-visible ring), and the
 * `panelDataAttr` forwarded to `WizardStepPanel` are preserved verbatim
 * from the inlined branch.
 */

import type { ComponentType, JSX } from "react";
import type { GlyphProps } from "../../../../components/icons/index.js";
import { Button } from "../../../../components/ui/button.js";
import { WizardStepPanel } from "../../WizardStepPanel.js";

export interface ApiKeysSkipPanelProps {
  readonly icon: ComponentType<GlyphProps>;
  readonly formError: string | null;
  readonly advancePending: boolean;
  readonly onContinue: () => void;
}

export function ApiKeysSkipPanel({
  icon,
  formError,
  advancePending,
  onContinue,
}: ApiKeysSkipPanelProps): JSX.Element {
  return (
    <WizardStepPanel
      panelDataAttr={{ kind: "apikeys", value: "skip" }}
      icon={icon}
      title="API keys already configured"
      description="A Jupiter API key is already saved on this install. Continue to keep using it - Tavily and Rettiwt stay editable from the review at the end, or later in Settings."
      footer={
        <Button
          onClick={() => {
            onContinue();
          }}
          disabled={advancePending}
        >
          {advancePending ? "Continuing…" : "Continue"}
        </Button>
      }
    >
      {formError ? (
        <p className="text-sm text-danger" role="alert">
          {formError}
        </p>
      ) : null}
    </WizardStepPanel>
  );
}
