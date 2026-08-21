/**
 * Single radio "card" for the New-session modal mode/permission grids,
 * speaking the landing's numbered trust-zone grammar (.zone/.prob-card):
 * mono spec-sheet index, display-register title, consequence line, and —
 * on the selected card only — the landing .zone 3px accent bar on the left
 * edge over an accent-fill surface. Purely presentational: the visible card
 * is a styled <label> wrapping a screen-reader-only native radio, so the
 * grids stay keyboard- and AT-navigable as real radio groups.
 */

import type { JSX } from "react";
import { cn } from "../../../lib/utils.js";

interface RadioCardProps {
  readonly name: string;
  readonly value: string;
  readonly checked: boolean;
  readonly onChange: () => void;
  /** Spec-sheet ordinal ("01"/"02") — rendered as the mono card mark. */
  readonly index: string;
  readonly title: string;
  readonly description: string;
  /**
   * Caution register: when checked, the consequence line takes the pin
   * warning amber instead of muted ink. Set by the "Full access"
   * permission option only — amber is a register, not a new warning.
   */
  readonly caution?: boolean;
}

export function RadioCard({
  name,
  value,
  checked,
  onChange,
  index,
  title,
  description,
  caution = false,
}: RadioCardProps): JSX.Element {
  return (
    <label
      className={cn(
        "relative flex min-h-[96px] cursor-pointer flex-col gap-1.5 rounded-xl border px-4 py-3.5 transition-colors",
        // Keyboard focus on the sr-only radio lights the card (hairline law:
        // the ring is the accent, never a glow).
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent-primary",
        // Selected reads as a solid raised card with the accent bar as the
        // marker (check-not-fill law) - never an accent-tinted surface.
        checked
          ? "border-line-4 bg-interactive-solid"
          : "border-line-2 hover:bg-interactive-hover",
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
      {/* Trust-boundary bar — the landing .zone.z-control border-left,
       * drawn only on the enforced (selected) card. Paint-only; the notch
       * geometry (16% inset) mirrors .vex-select-beam::before. */}
      {checked ? (
        <span
          aria-hidden
          className="absolute bottom-[16%] left-0 top-[16%] w-[3px] rounded-r-[3px] bg-accent-primary"
        />
      ) : null}
      <span
        className={cn(
          "vex-doto-label vex-doto-label--wide",
          checked
            ? "text-accent-primary"
            : "text-ink-tertiary",
        )}
      >
        {index}
      </span>
      <span
        className={cn(
          "font-display text-[15px] font-medium tracking-[-0.01em]",
          "text-ink-primary",
        )}
      >
        {title}
      </span>
      <span
        className={cn(
          "text-xs leading-relaxed",
          checked && caution
            ? "text-warning"
            : "text-ink-tertiary",
        )}
      >
        {description}
      </span>
    </label>
  );
}
