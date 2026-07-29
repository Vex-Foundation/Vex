/**
 * Reasoning-effort selector (S6/D4) — the composer pill's quiet "Grok slot"
 * control, seated in the right cluster LEFT of the round send key.
 *
 * Presentational only: the parent (SessionComposer) owns the effective
 * selection (the stored per-session pick validated against the model's
 * FINAL selectable set, else the shared TESTED preselect
 * `selectDefaultReasoningEffort`) and the store write — this component
 * never re-derives preselect logic. Options are the DTO's already-
 * normalized `SessionModelDto.reasoning.supportedEfforts` VERBATIM
 * (provider order, exactly one "none" iff the model is not mandatory —
 * `normalizeReasoningCapability` in `shared/schemas/reasoning.ts` owns
 * that set), with "none" labelled "Off".
 *
 * Anatomy: the {@link SelectMenu} primitive restyled into the composer's
 * quiet grammar — a ghost text trigger (no border, no fill at rest; the label
 * in --vex-text-2 lifting to foreground over a --vex-surface-2 wash on
 * hover), `rounded-xl` + h-10 so it sits level with the send key and echoes
 * the surface's rounded-2xl, opening UPWARD (the composer sits low on the
 * session stage). Sans, not serif: this is a CONTROL, not prose. Menu physics, the ARIA combobox/listbox contract and the
 * selected-dot convention all come from SelectMenu as-is. The trigger's
 * min-width doubles as the floating panel's width (SelectMenu's panel spans
 * its trigger), sized so the longest label ("Minimal") never truncates.
 */

import { useMemo, type JSX } from "react";
import {
  reasoningEffortSchema,
  type ReasoningCapability,
  type ReasoningEffort,
} from "@shared/schemas/reasoning.js";
import {
  SelectMenu,
  type SelectMenuOption,
} from "../../components/ui/select-menu.js";

/**
 * Operator-facing labels for the FULL transport enum (total map, so a
 * widened enum fails the typecheck here instead of rendering a raw value).
 * "none" reads as "Off" — the user is switching reasoning off, not picking
 * a "none" tier.
 */
const EFFORT_LABEL: Readonly<Record<ReasoningEffort, string>> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

export interface ReasoningEffortSelectProps {
  /** Normalized non-null capability from `SessionModelDto.reasoning`. */
  readonly capability: ReasoningCapability;
  /** The effective selection (parent-derived; always in the final set). */
  readonly value: ReasoningEffort;
  readonly onChange: (effort: ReasoningEffort) => void;
}

export function ReasoningEffortSelect({
  capability,
  value,
  onChange,
}: ReasoningEffortSelectProps): JSX.Element {
  const options = useMemo<ReadonlyArray<SelectMenuOption>>(
    () =>
      capability.supportedEfforts.map((effort) => ({
        value: effort,
        label: EFFORT_LABEL[effort],
      })),
    [capability.supportedEfforts],
  );

  return (
    <SelectMenu
      shimmerLabels
      value={value}
      options={options}
      onChange={(next) => {
        // SelectMenu speaks plain strings; the options above only ever hold
        // transport-enum values, but re-validate at the boundary instead of
        // casting.
        const parsed = reasoningEffortSchema.safeParse(next);
        if (parsed.success) onChange(parsed.data);
      }}
      ariaLabel="Reasoning effort"
      placement="top"
      // Quiet-grammar overrides on the SelectMenu trigger (cn/tailwind-merge:
      // later classes win): h-10 sits level with the round send key;
      // border/bg go transparent so the control reads as text at rest (no
      // glass-on-glass); justify-start seats the chevron right after the
      // label (the Grok "Szybki ⌄" read); min-w keeps the upward panel wide
      // enough for every label. Focus ring stays SelectMenu's repo default.
      className="h-10 w-auto min-w-[6.5rem] justify-start rounded-xl border-transparent bg-transparent px-3 font-sans text-[13px] text-[var(--vex-text-2)] transition-colors hover:bg-[var(--vex-surface-2)] hover:text-foreground"
      />
  );
}

/**
 * Quiet INERT placeholder for the control slot while the global
 * model-capability query (`useAvailableModels`) hasn't resolved yet —
 * welcome's cold-start case, and occasionally an existing session opened
 * before the app's first models fetch settles. Same box as the resolved
 * trigger (`h-10 min-w-[6.5rem] rounded-full px-3`) so the slot never
 * reflows once the real selector mounts or the gate resolves to hidden.
 * Deliberately STATIC (no shimmer, no pulse): this is "we don't know yet",
 * not "a value is loading in" — an animated hint here would overstate what
 * is actually happening. No role, no onChange — Send stays enabled while
 * this shows; it never blocks the primary action.
 */
export function ReasoningEffortPlaceholder(): JSX.Element {
  return (
    <span
      aria-hidden
      data-vex-reasoning-placeholder
      className="inline-flex h-10 min-w-[6.5rem] shrink-0 items-center rounded-xl px-3"
    >
      <span className="h-2.5 w-10 rounded-full bg-[var(--vex-line-strong)] opacity-60" />
    </span>
  );
}
