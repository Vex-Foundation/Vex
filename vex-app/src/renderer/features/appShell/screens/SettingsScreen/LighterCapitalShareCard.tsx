/**
 * The agent's capital ceiling on one Lighter account, as a percent.
 *
 * PRESENTATIONAL. It holds the typed value and nothing else; reading, writing
 * and classifying a refusal belong to `LighterTradingSetupSection`. That split
 * is what lets the states that matter - stale revision, invalid input, no limit
 * - be proved without a bridge.
 *
 * The revision is on screen on purpose. This value is written with a
 * compare-and-set (deepseek-harness `settings.update(ns, value, expectedRevision)`),
 * so a second window that saved first must be TOLD rather than overwritten, and
 * the number the person holds is the number the refusal talks about.
 */

import { useEffect, useId, useState, type JSX } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Input } from "../../../../components/ui/input.js";
import {
  CAPITAL_SHARE_CONFLICT,
  CAPITAL_SHARE_EMPTY_HINT,
  CAPITAL_SHARE_HELPER,
  CAPITAL_SHARE_LABEL,
  CAPITAL_SHARE_LOADING,
  CAPITAL_SHARE_RELOAD,
  CAPITAL_SHARE_SAVE,
  CAPITAL_SHARE_SAVED,
  CAPITAL_SHARE_SAVING,
  capitalShareReadFailed,
  capitalShareSaveFailed,
  capitalShareSavedLine,
} from "./lighter-trading-setup-copy.js";
import {
  capitalShareIsUnchanged,
  parseCapitalShareInput,
} from "./lighter-leverage-view.js";

/** What Vex currently knows about the saved share. */
export type CapitalShareReadState =
  | { readonly kind: "loading" }
  /** A null revision means no row is stored yet: the first write sends it back. */
  | {
      readonly kind: "ready";
      readonly percent: number | null;
      readonly revision: number | null;
    }
  | { readonly kind: "failed"; readonly reason: string };

/** What the last Save did. `conflict` is the stale-revision refusal. */
export type CapitalShareWriteState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "conflict" }
  | { readonly kind: "failed"; readonly reason: string };

export interface LighterCapitalShareCardProps {
  readonly read: CapitalShareReadState;
  readonly write: CapitalShareWriteState;
  readonly onSave: (percent: number | null, expectedRevision: number | null) => void;
  readonly onReload: () => void;
}

export function LighterCapitalShareCard({
  read,
  write,
  onSave,
  onReload,
}: LighterCapitalShareCardProps): JSX.Element {
  const fieldId = useId();
  const helperId = useId();
  const statusId = useId();
  const [raw, setRaw] = useState("");
  const [touched, setTouched] = useState(false);

  // The saved value seeds the field once it is known, and again whenever a
  // reload replaces it. A value the person is editing is not overwritten,
  // because `touched` stays true until the next successful write.
  const ready = read.kind === "ready";
  const savedPercent = read.kind === "ready" ? read.percent : null;
  const savedRevision = read.kind === "ready" ? read.revision : null;
  useEffect(() => {
    // Keyed on the VALUES rather than on the props object: the container builds
    // that object inline, so an object identity in this dependency list would
    // wipe the field on every render. A null revision is a real ready state (no
    // row stored yet), which is why readiness is its own flag.
    if (!ready) return;
    setRaw(savedPercent === null ? "" : String(savedPercent));
    setTouched(false);
  }, [ready, savedPercent, savedRevision]);

  const parsed = parseCapitalShareInput(raw);
  const unchanged = capitalShareIsUnchanged(parsed, savedPercent);
  const saving = write.kind === "saving";
  const canSave =
    read.kind === "ready" && parsed.kind !== "invalid" && !unchanged && !saving;

  const message = resolveMessage(read, write, touched && parsed.kind === "invalid" ? parsed.message : null);

  return (
    <div className="flex flex-col gap-2" data-vex-lighter-capital-share>
      <label htmlFor={fieldId} className="text-[13px] leading-[20px] text-ink-primary">
        {CAPITAL_SHARE_LABEL}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Input
            id={fieldId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            className="h-7 w-20 text-[13px]"
            value={raw}
            disabled={read.kind !== "ready" || saving}
            aria-describedby={`${helperId} ${statusId}`}
            aria-invalid={parsed.kind === "invalid"}
            onChange={(event) => {
              setTouched(true);
              setRaw(event.target.value);
            }}
          />
          <span aria-hidden="true" className="text-[13px] leading-[20px] text-ink-secondary">
            %
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!canSave}
          data-vex-lighter-capital-share-save
          onClick={() => {
            if (parsed.kind === "invalid") return;
            onSave(parsed.kind === "no_limit" ? null : parsed.percent, savedRevision);
          }}
        >
          {saving ? CAPITAL_SHARE_SAVING : CAPITAL_SHARE_SAVE}
        </Button>
        {write.kind === "conflict" ? (
          <Button
            variant="outline"
            size="sm"
            data-vex-lighter-capital-share-reload
            onClick={onReload}
          >
            {CAPITAL_SHARE_RELOAD}
          </Button>
        ) : null}
      </div>
      <p id={helperId} className="text-[12px] leading-[18px] text-ink-secondary">
        {CAPITAL_SHARE_HELPER} {CAPITAL_SHARE_EMPTY_HINT}
      </p>
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={
          message.tone === "warning"
            ? "text-[12px] leading-[18px] text-warning"
            : "text-[12px] leading-[18px] text-ink-tertiary"
        }
      >
        {message.text}
      </p>
    </div>
  );
}

function resolveMessage(
  read: CapitalShareReadState,
  write: CapitalShareWriteState,
  inputError: string | null,
): { readonly text: string; readonly tone: "neutral" | "warning" } {
  // The refusal outranks everything: it is the reason the value on screen and
  // the value on disk disagree.
  if (write.kind === "conflict") return { text: CAPITAL_SHARE_CONFLICT, tone: "warning" };
  if (write.kind === "failed") {
    return { text: capitalShareSaveFailed(write.reason), tone: "warning" };
  }
  if (inputError !== null) return { text: inputError, tone: "warning" };
  if (read.kind === "loading") return { text: CAPITAL_SHARE_LOADING, tone: "neutral" };
  if (read.kind === "failed") {
    return { text: capitalShareReadFailed(read.reason), tone: "warning" };
  }
  if (write.kind === "saved") {
    return {
      text: `${CAPITAL_SHARE_SAVED} ${capitalShareSavedLine(read.percent, read.revision)}`,
      tone: "neutral",
    };
  }
  return { text: capitalShareSavedLine(read.percent, read.revision), tone: "neutral" };
}
