/**
 * Numeric form row used by `AgentCoreStep` - extracted to keep the
 * step screen file under the 400-LOC scalability ceiling (V2 refactor).
 *
 * The row pairs a free-text input with a Reset toggle. The disabled
 * state when `state.kind === "clear"` is the visual signal that
 * submit will REMOVE the key from .env on save. The default line under the
 * input swaps to the will-clear note so the operator is never surprised by an
 * empty input that "resets to default".
 *
 * R3 number row (`.vex-wz-num`): the name with its variable at the left, the
 * help under it; the field at the right with its default line, the Reset
 * action at the end of that line. Figures are mono, words are sans.
 */

import type { JSX } from "react";

import { Input } from "../../../../components/ui/input.js";
import type { FieldState } from "./form-state.js";

export interface NumericRowProps {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  readonly hint?: string;
  readonly state: FieldState;
  readonly onChange: (next: FieldState) => void;
  readonly defaultLabel: string;
  /**
   * The raw .env key behind this field, shown as a tiny mono caption so
   * power users can still map the humanized label to their `.env` -
   * the label itself stays plain English (Phase 2b copy law).
   */
  readonly envName?: string;
}

/** A bare figure ("256000", "0.7"): set in mono; any words stay in sans. */
function isFigure(text: string): boolean {
  return /^[0-9.]+$/.test(text);
}

export function NumericRow({
  id,
  label,
  placeholder,
  hint,
  state,
  onChange,
  defaultLabel,
  envName,
}: NumericRowProps): JSX.Element {
  const value = state.kind === "set" ? state.raw : "";
  const cleared = state.kind === "clear";
  return (
    <div className="vex-wz-num">
      <p className="vex-wz-num__n">
        <label htmlFor={id}>{label}</label>
        {envName ? (
          <span aria-hidden className="vex-wz-num__env">
            {envName}
          </span>
        ) : null}
      </p>
      {hint ? <p className="vex-wz-num__h">{hint}</p> : null}
      <div className="vex-wz-num__f">
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          disabled={cleared}
          className={
            isFigure(placeholder)
              ? "text-ellipsis font-mono vex-num text-[14px]"
              : "text-ellipsis font-mono vex-num text-[14px] placeholder:font-sans placeholder:text-[13px]"
          }
          onChange={(e) =>
            onChange(
              e.target.value.length === 0
                ? { kind: "unchanged" }
                : { kind: "set", raw: e.target.value },
            )
          }
        />
      </div>
      <div className="vex-wz-num__dflt flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span>
          {cleared ? (
            `Will clear on save → ${defaultLabel}`
          ) : (
            <>
              Default:{" "}
              <span
                className={isFigure(defaultLabel) ? "font-mono vex-num" : undefined}
              >
                {defaultLabel}
              </span>
            </>
          )}
        </span>
        <button
          type="button"
          className="vex-wz-link"
          onClick={() =>
            onChange(
              state.kind === "clear" ? { kind: "unchanged" } : { kind: "clear" },
            )
          }
        >
          {cleared ? "Undo reset" : "Reset"}
        </button>
      </div>
    </div>
  );
}
