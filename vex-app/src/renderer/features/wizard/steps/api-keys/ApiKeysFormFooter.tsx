/**
 * ApiKeysFormFooter — the "Skip optional" + "Save…" action row rendered
 * in the `footer` slot of the ApiKeysStep form panel.
 *
 * Presentational: the parent owns submit/skip wiring and the busy flags.
 * The submit button stays `type="submit"` so it triggers the panel's
 * native `<form>` submit (the parent's `onSubmit`); the skip button is
 * `type="button"` and invokes the passed `onSkip` handler. Disabled
 * state and the busy/back-edit label logic are preserved verbatim.
 */

import type { JSX } from "react";
import type { WizardFlowMode } from "../../../../lib/api/wizard.js";
import { Button } from "../../../../components/ui/button.js";

export interface ApiKeysFormFooterProps {
  readonly flowMode: WizardFlowMode;
  readonly submitting: boolean;
  readonly advancePending: boolean;
  readonly onSkip: () => void;
}

export function ApiKeysFormFooter({
  flowMode,
  submitting,
  advancePending,
  onSkip,
}: ApiKeysFormFooterProps): JSX.Element {
  return (
    <>
      <Button
        type="button"
        variant="bare"
        onClick={() => {
          onSkip();
        }}
        disabled={submitting || advancePending}
      >
        Skip optional
      </Button>
      <Button type="submit" disabled={submitting || advancePending}>
        {submitting || advancePending
          ? "Saving…"
          : flowMode === "back-edit"
            ? "Save changes"
            : "Save and continue"}
      </Button>
    </>
  );
}
