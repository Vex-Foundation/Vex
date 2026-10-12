/**
 * Starter chips - a wrapping row of square, rule-outlined prompts under the
 * welcome field (reference d2). Each chip is its label and nothing else;
 * picking a chip seeds the draft via `onPick`. Renders only on the
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
    // Bare chip row: no band behind it - the chips are the surface, set flush
    // with the field's leading edge and wrapping onto a second row.
    <div className="vex-rise vex-rise-d3 mt-3.5 flex max-w-full flex-wrap items-center gap-2">
      {QUICK_ACTIONS.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={() => onPick(action.prompt)}
          // Starter: 32px, 14px sans in ink on a rule outline; hover moves
          // both the type and the line to the blue - no fill, no motion.
          className="inline-flex h-8 min-w-0 items-center border border-rule px-3 font-sans text-[14px] leading-5 text-ink-primary transition-colors duration-100 hover:border-accent-primary hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <span className="truncate">{action.label}</span>
        </button>
      ))}
    </div>
  );
}
