/**
 * Numeric form row used by `AgentCoreStep` — extracted to keep the
 * step screen file under the 400-LOC scalability ceiling (V2 refactor).
 *
 * The row pairs a free-text input with a Reset toggle. The disabled
 * state when `state.kind === "clear"` is the visual signal that
 * submit will REMOVE the key from .env on save. The helper copy under
 * the input swaps to the will-clear hint so the operator is never
 * surprised by an empty input that "resets to default".
 */

import type { JSX } from "react";

import { Button } from "../../../../components/ui/button.js";
import { Input } from "../../../../components/ui/input.js";
import { Label } from "../../../../components/ui/label.js";
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
   * power users can still map the humanized label to their `.env` —
   * the label itself stays plain English (Phase 2b copy law).
   */
  readonly envName?: string;
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
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        {envName ? (
          <span
            aria-hidden
            className="font-mono text-[10px] tracking-[0.08em] text-[var(--color-text-muted)]"
          >
            {envName}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          disabled={cleared}
          className="h-11"
          onChange={(e) =>
            onChange(
              e.target.value.length === 0
                ? { kind: "unchanged" }
                : { kind: "set", raw: e.target.value },
            )
          }
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange(
              state.kind === "clear" ? { kind: "unchanged" } : { kind: "clear" },
            )
          }
        >
          {cleared ? "Undo reset" : "Reset"}
        </Button>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        {cleared
          ? `Will clear on save → ${defaultLabel}`
          : (hint ?? `Default: ${defaultLabel}`)}
      </p>
    </div>
  );
}
