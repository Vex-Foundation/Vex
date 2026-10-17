/**
 * Single radio "card" for the new-session form's mode and permission grids,
 * and for the Studio project dialogs that reuse it
 * (docs/design/R3-MINIMAL.md section 12, the option card of the inline panel).
 *
 * Square, 1px rule on the field fill. The selected card takes a 1.5px blue
 * frame (padding compensated so nothing jumps) and a solid swatch before its
 * title; an unselected card shows the empty outline swatch. The state is the
 * fill and the frame, never a wash. A short tag may sit at the right of the
 * title ("Funds require approval"). Purely presentational: the visible card is
 * a styled <label> wrapping a screen-reader-only native radio, so the grids
 * stay keyboard- and AT-navigable as real radio groups.
 */

import type { JSX } from "react";
import { Swatch } from "../../../components/ui/swatch.js";
import { Tag } from "../../../components/ui/stamp.js";
import { cn } from "../../../lib/utils.js";

interface RadioCardProps {
  readonly name: string;
  readonly value: string;
  readonly checked: boolean;
  readonly onChange: () => void;
  /**
   * An ordinal some callers still pass. R3 draws no ordinal on the card, so
   * it is accepted and not painted.
   */
  readonly index?: string;
  readonly title: string;
  readonly description: string;
  /** A quiet tag at the right of the title ("Funds require approval"). */
  readonly tag?: string | undefined;
  /**
   * Caution register: when checked, the consequence line steps up from ink 2
   * to the primary ink. Set by the "Full access" permission option only; it
   * is weight of ink, never a warning hue.
   */
  readonly caution?: boolean;
}

export function RadioCard({
  name,
  value,
  checked,
  onChange,
  title,
  description,
  tag,
  caution = false,
}: RadioCardProps): JSX.Element {
  return (
    <label
      data-vex-radio-card=""
      data-checked={checked ? "" : undefined}
      className={cn(
        "relative flex cursor-pointer flex-col bg-surface-field text-left",
        // Keyboard focus on the sr-only radio lights the card with the
        // focus outline, 3px clear of the frame.
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[3px] has-[:focus-visible]:outline-focus",
        checked
          ? "border-[1.5px] border-accent-primary px-[15.5px] pb-[14.5px] pt-[13.5px]"
          : "border border-rule px-4 pb-[15px] pt-3.5 hover:bg-interactive-hover",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      <span className="flex items-center gap-[9px] text-[15px] font-medium leading-[1.3] text-ink-primary">
        <Swatch
          state={checked ? "done" : "idle"}
          size={10}
          className="text-accent-primary"
        />
        {title}
        {tag === undefined ? null : (
          <Tag quiet className="ml-auto">
            {tag}
          </Tag>
        )}
      </span>
      <span
        className={cn(
          "mt-[5px] text-[13.5px] leading-[1.45]",
          checked && caution ? "text-ink-primary" : "text-ink-secondary",
        )}
      >
        {description}
      </span>
    </label>
  );
}
