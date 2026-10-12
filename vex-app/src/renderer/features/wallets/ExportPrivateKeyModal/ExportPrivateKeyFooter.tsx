/**
 * Footer actions for the export-private-key modal: always-present Cancel, plus
 * the idle-phase submit button. The submit button stays a `type="submit"`
 * associated with the form via `form="vex-export-private-key-form"`, so the
 * footer can live outside the `<form>` element without breaking submission.
 *
 * Extracted verbatim from `ExportPrivateKeyModal.tsx`.
 */

import type { JSX } from "react";
import { Button } from "../../../components/ui/button.js";
import type { Phase } from "./types.js";

export interface ExportPrivateKeyFooterProps {
  readonly phase: Phase;
  readonly pending: boolean;
  readonly canSubmit: boolean;
  readonly onCancel: () => void;
}

export function ExportPrivateKeyFooter({
  phase,
  pending,
  canSubmit,
  onCancel,
}: ExportPrivateKeyFooterProps): JSX.Element {
  return (
    <>
      <Button
        type="button"
        variant="bare"
        onClick={onCancel}
        disabled={pending}
        data-vex-export-cancel
      >
        Cancel
      </Button>
      {phase === "idle" ? (
        <Button
          type="submit"
          form="vex-export-private-key-form"
          disabled={!canSubmit}
          data-vex-export-submit
        >
          {pending ? "Copying…" : "Copy to clipboard"}
        </Button>
      ) : null}
    </>
  );
}
