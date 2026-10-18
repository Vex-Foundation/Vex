/**
 * Reasoning-effort selector (S6/D4) - the effort key inside the composer's
 * options control, after the muted "Reasoning:" (docs/design/R3-MINIMAL.md
 * section 7: "{model name} · Reasoning: {effort}" in one control).
 *
 * Presentational only: the parent (SessionComposer) owns the effective
 * selection (the stored per-session pick validated against the model's
 * FINAL selectable set, else the shared TESTED preselect
 * `selectDefaultReasoningEffort`) and the store write; this component
 * never re-derives preselect logic. Options are the DTO's already-
 * normalized `SessionModelDto.reasoning.supportedEfforts` VERBATIM
 * (provider order, exactly one "none" iff the model is not mandatory;
 * `normalizeReasoningCapability` in `shared/schemas/reasoning.ts` owns
 * that set), with "none" labelled "Off".
 *
 * Anatomy: the {@link SelectMenu} primitive with its field chrome cleared, so
 * the trigger reads as the effort word and the chevron inside the options
 * frame (13 sans in ink), opening UPWARD (the composer sits low on the
 * stage). Menu physics, the ARIA combobox/listbox contract and the
 * selected-swatch convention all come from SelectMenu as-is; the menu keeps
 * the width of its longest word through `.vex-composer-options` (console.css).
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
 * "none" reads as "Off": the user is switching reasoning off, not picking
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
      // Field chrome cleared on the SelectMenu trigger (cn/tailwind-merge:
      // later classes win): no border, no fill, no side padding, the 13 sans
      // word with its chevron right after it ("Medium ⌄"). The trigger sizes
      // to its word (`w-auto`) and may concede (`min-w-0`; SelectMenu's label
      // owns `min-w-0 truncate`, its chevron is `shrink-0`). The border focus
      // step has no border to paint, so the focus ring carries focus.
      className="vex-composer-options__effort h-7 w-auto min-w-0 justify-start gap-1.5 border-0 bg-transparent px-0 text-[13px] font-normal leading-5 text-ink-primary transition-colors duration-100 hover:text-accent-primary focus-visible:ring-2 focus-visible:ring-focus"
      />
  );
}

/**
 * Quiet INERT placeholder for the effort key while the global
 * model-capability query (`useAvailableModels`) hasn't resolved yet -
 * welcome's cold-start case, and occasionally an existing session opened
 * before the app's first models fetch settles. A short quiet bar inside the
 * options frame, so the frame keeps its place until the real selector mounts
 * or the gate resolves to hidden; it concedes width rather than pinning the
 * bar.
 * Deliberately STATIC (no shimmer, no pulse): this is "we don't know yet",
 * not "a value is loading in". No role, no onChange - Send stays enabled
 * while this shows; it never blocks the primary action.
 */
export function ReasoningEffortPlaceholder(): JSX.Element {
  return (
    <span
      aria-hidden
      data-vex-reasoning-placeholder
      className="inline-flex h-7 w-16 min-w-0 items-center"
    >
      <span className="h-2 w-10 bg-surface-skeleton" />
    </span>
  );
}
