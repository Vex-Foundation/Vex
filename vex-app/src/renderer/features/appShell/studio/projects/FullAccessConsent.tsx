/**
 * THE FULL-ACCESS GRANT STRIP: the one place Studio asks for this consent.
 *
 * `Full access` controls Vex MCP's execution gate: supported wallet actions
 * can execute without per-call approval, while tool-specific approval
 * requirements still apply. The coding client controls its own filesystem
 * permissions. The grant can be revoked; completed transactions cannot be
 * undone.
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
import { Tag } from "../../../../components/ui/stamp.js";
import { cn } from "../../../../lib/utils.js";
import {
  FULL_ACCESS_ACKNOWLEDGEMENT,
  FULL_ACCESS_CONSEQUENCE_UNDO,
  FULL_ACCESS_CONSEQUENCE_WHAT,
  fullAccessFolderLine,
  fullAccessWalletsLine,
} from "./projects-copy.js";

/**
 * THE KIT CHECKBOX, drawn on the native input (docs/design/R3-MINIMAL.md
 * section 1.5): 16 x 16, a 1.5px ink border, and when it is on the blue fill
 * with a white tick; focus is the kit's 2px outline, 3px clear. The input keeps
 * its checkbox semantics, its label and its `disabled` behaviour; only the
 * paint changed. Shared with the delete dialog's trash choice, which is the
 * other consent checkbox in this folder, so the two cannot drift.
 */
export const CONSENT_CHECKBOX_CLASS = cn(
  "relative mt-0.5 h-4 w-4 shrink-0 cursor-pointer appearance-none border-[1.5px] border-rule-ink bg-transparent",
  "checked:border-button-accent-edge checked:bg-button-accent",
  "checked:after:absolute checked:after:top-0 checked:after:left-[3.5px] checked:after:h-2 checked:after:w-1 checked:after:rotate-45 checked:after:border-solid checked:after:border-r-2 checked:after:border-b-2 checked:after:border-ink-on-button-accent checked:after:content-['']",
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus",
  "disabled:cursor-not-allowed disabled:border-dotted",
);

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
    <DialogConsequence
      tone="warning"
      data-vex-consent="full-access"
      // 13 / 1.45 on the dialog's own 32px gutter (the creator and the settings
      // editor both pad their header and body at 32).
      className="px-8 text-[13px] leading-[1.45]"
    >
      {/* The mark of the grant: the one outlined caps tag. The words below are
        * the consent; this only names what is being granted. */}
      <Tag className="self-start">Full access</Tag>
      <span className="font-medium">{FULL_ACCESS_CONSEQUENCE_WHAT}</span>
      {/* TO WHAT. Both lines always render: an empty wallet selection is a fact
        * about the grant, not a reason to say nothing about wallets. */}
      <span className="flex flex-col gap-0.5 text-ink-secondary">
        <span className="vex-num truncate text-[12px]">
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
          className={CONSENT_CHECKBOX_CLASS}
        />
        <span>{FULL_ACCESS_ACKNOWLEDGEMENT}</span>
      </label>
    </DialogConsequence>
  );
}
