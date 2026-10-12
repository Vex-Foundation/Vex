/**
 * Reasoning-effort selector (S6/D4) - the composer field's effort chip,
 * seated in the leading cluster beside the model chip (reference d3).
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
 * Anatomy: the {@link SelectMenu} primitive restyled into the field's chip
 * grammar (28px, 12px Departure Mono on a rule outline) with a hover fill,
 * opening UPWARD (the composer sits low on the session stage). Menu
 * physics, the ARIA combobox/listbox contract and the selected-dot
 * convention all come from SelectMenu as-is. The trigger's min-width
 * doubles as the floating panel's width, sized so the longest label
 * ("Minimal") never truncates.
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
      // Chip-grammar overrides on the SelectMenu trigger (cn/tailwind-merge:
      // later classes win): the 28px mono chip on the rule outline
      // (`.vex-composer-chip`, console.css) with the border and fill cleared;
      // justify-start seats the chevron right after the label ("Medium ⌄").
      //
      // WIDTH (round 3, codex Bug 3): 6.5rem is a PREFERRED width, not a
      // floor. It was `min-w-[6.5rem]`, which pinned the trigger's outer box
      // and made this seat a hard 104px the toolbar row could not reclaim -
      // one of the row's overflow contributors. `w-[6.5rem]` keeps the same
      // resting size (the longest label, "Minimal", still fits, and the
      // `left-0 right-0` listbox still inherits it) while letting the seat
      // concede under container pressure; SelectMenu's own label already owns
      // `min-w-0 truncate` and its chevron is already `shrink-0`, so the
      // conceded state truncates rather than clipping the control.
      // Focus ring stays SelectMenu's repo default.
      className="vex-composer-chip h-7 min-w-0 w-[6.5rem] justify-start border-transparent bg-transparent px-2 font-mono text-[12px] font-normal leading-5 tracking-[0.02em] text-ink-secondary transition-colors duration-100 hover:bg-interactive-hover hover:text-ink-primary"
      />
  );
}

/**
 * Quiet INERT placeholder for the control slot while the global
 * model-capability query (`useAvailableModels`) hasn't resolved yet -
 * welcome's cold-start case, and occasionally an existing session opened
 * before the app's first models fetch settles. Same box as the resolved
 * trigger (h28 / 6.5rem preferred width) so the slot never reflows once
 * the real selector mounts or the gate resolves to hidden, and it concedes
 * width on the same terms rather than pinning the toolbar row.
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
      className="vex-composer-chip inline-flex h-7 w-[6.5rem] min-w-0 items-center px-2"
    >
      <span className="h-2.5 w-10 bg-surface-skeleton" />
    </span>
  );
}
