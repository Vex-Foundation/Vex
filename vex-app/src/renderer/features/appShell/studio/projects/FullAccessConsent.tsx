/**
 * THE FULL-ACCESS GRANT STRIP: the one place Studio asks for this consent.
 *
 * `Full access` means agents in a project may act OUTSIDE its folder and with
 * its wallets, and it was granted by pressing a radio card whose only
 * distinguishing mark was one sentence of caution in the same register as the
 * option beside it (audit finding B2). Nothing separated granting it from
 * picking Restricted, on a self-custodial product where the grant reaches the
 * user's disk and their keys.
 *
 * Owner decision, 2026-09-02: the grant is CONFIRMED, not merely picked. This
 * component is the confirmation, and both surfaces that can make the grant - the
 * creator and the settings editor - render this one component rather than two
 * strips that could drift on what Full access means. It follows deepseek's
 * `RiskConfirmation` (`ui-primitives/src/RiskConfirmation.tsx`): consequence
 * first with a warning glyph, an explicit checkbox acknowledgement, and the
 * primary action unavailable until it is given.
 *
 * ## What it owns, and what it does not
 *
 * It owns the words, the layout and the checkbox. It does NOT own the
 * acknowledgement state or the enforcement: the dialog holds the flag, drops it
 * whenever the proposal changes, and re-checks it on the submit path. A
 * `disabled` attribute is a statement about dispatch, not a rule - the same
 * reasoning `AgentPicker`'s module note records - so the gate that matters lives
 * where the wire input is built.
 *
 * ## The acknowledgement is never persisted
 *
 * There is no "do not ask again". A grant acknowledged once for one project says
 * nothing about the next one, and a suppression that survives the dialog would
 * turn the only deliberate step in this flow into a checkbox somebody ticked
 * months ago.
 */

import { useId, type JSX } from "react";
import { DialogConsequence } from "../../../../components/ui/dialog.js";
import {
  FULL_ACCESS_ACKNOWLEDGEMENT,
  FULL_ACCESS_CONSEQUENCE_UNDO,
  FULL_ACCESS_CONSEQUENCE_WHAT,
  fullAccessFolderLine,
  fullAccessWalletsLine,
} from "./projects-copy.js";

export interface FullAccessConsentProps {
  /** The project's folder, or `null` in the creator where it does not exist yet. */
  readonly displayPath: string | null;
  /** The wallet names currently in the proposal, in fieldset order. */
  readonly walletLabels: readonly string[];
  readonly acknowledged: boolean;
  /** A submit is in flight; the choice is made and must not move under it. */
  readonly disabled?: boolean;
  readonly onAcknowledgedChange: (next: boolean) => void;
}

export function FullAccessConsent({
  displayPath,
  walletLabels,
  acknowledged,
  disabled = false,
  onAcknowledgedChange,
}: FullAccessConsentProps): JSX.Element {
  const checkboxId = useId();
  return (
    <DialogConsequence tone="warning" data-vex-consent="full-access">
      <span className="font-medium">{FULL_ACCESS_CONSEQUENCE_WHAT}</span>
      {/* TO WHAT. Both lines always render: an empty wallet selection is a fact
        * about the grant, not a reason to say nothing about wallets. */}
      <span className="flex flex-col gap-0.5 text-ink-secondary">
        <span className="truncate font-mono text-[11px]">
          {fullAccessFolderLine(displayPath)}
        </span>
        <span>{fullAccessWalletsLine(walletLabels)}</span>
      </span>
      <span className="text-ink-secondary">{FULL_ACCESS_CONSEQUENCE_UNDO}</span>
      <label
        htmlFor={checkboxId}
        className="mt-0.5 flex cursor-pointer items-start gap-2"
      >
        <input
          id={checkboxId}
          type="checkbox"
          checked={acknowledged}
          disabled={disabled}
          data-vex-consent-acknowledge=""
          onChange={(event) => onAcknowledgedChange(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-warning)]"
        />
        <span>{FULL_ACCESS_ACKNOWLEDGEMENT}</span>
      </label>
    </DialogConsequence>
  );
}
