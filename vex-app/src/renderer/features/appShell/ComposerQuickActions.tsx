/**
 * Starter chips - one horizontal row of capsule chips detached below the
 * composer card. Each chip is its label and nothing else (owner QA round 2
 * dropped the leading intent glyphs); picking a chip seeds the draft via
 * `onPick`. Renders only on the
 * welcome/idle stage while the draft is empty - the parent fades it out the
 * moment the user types and brings it back when the field clears. Carries
 * the stage's one-shot rise choreography at the d3 stagger.
 */

import type { JSX } from "react";
import { QUICK_ACTIONS } from "./composer-quick-actions.js";

export function ComposerQuickActions({
  onPick,
}: {
  readonly onPick: (prompt: string) => void;
}): JSX.Element {
  return (
    // Bare chip row (tokens v2): no band behind it - the chips are the
    // surface. w-fit + mx-auto hugs the chips; max-w-full keeps wrapping.
    <div className="vex-rise vex-rise-d3 mx-auto mt-4 flex w-fit max-w-full flex-wrap items-center justify-center gap-2">
      {QUICK_ACTIONS.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={() => onPick(action.prompt)}
          // Capsule chip: h28, radius = h/2, 13/20 medium (the catalog chip
          // grammar); quiet hairline at rest, hover fill - no scale motion.
          className="inline-flex h-7 min-w-0 items-center rounded-capsule border border-line-2 px-3 text-[13px] font-medium leading-5 text-ink-secondary transition-colors duration-100 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          <span className="truncate">{action.label}</span>
        </button>
      ))}
    </div>
  );
}
