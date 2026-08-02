/**
 * Starter chips — one horizontal row of compact hairline chips DETACHED
 * below the Signal Console. Each chip pairs a small intent icon with a
 * `.vex-micro` small-caps label (the register's support face — the mono
 * stamp is retired); picking a chip seeds the draft via `onPick`. The 01–03
 * numbering was dropped in the redesign — these are parallel starters, not an
 * ordered sequence, so a number would encode order that isn't there. Real
 * buttons → keyboard focusable.
 *
 * The row only ever renders on the welcome/idle stage (empty conversation)
 * while the draft is EMPTY — the parent (`SessionComposer`) fades it out the
 * moment the user starts typing and brings it back when the field clears
 * (owner decree 2026-07-21). It carries the stage's one-shot rise
 * choreography at the d3 stagger (logo row → console → chips), which also
 * replays on each return.
 *
 * Surface (composer rebuild, owner decree 2026-07-29): a SOLID ink band —
 * opaque --vex-surface-1 + a --vex-line hairline, rounded-2xl to match the
 * console surface directly above it. The band was previously translucent
 * glass with a backdrop filter (a legibility assist over the bright regions of
 * the current shell backdrop photo); solid ink solves the same legibility problem
 * outright, so the row left the glass family and its shell-design-guard
 * whitelist entry was deleted with it.
 */

import type { JSX } from "react";
import { VexIcon } from "../../components/icons/index.js";
import { QUICK_ACTIONS } from "./composer-quick-actions.js";

export function ComposerQuickActions({
  onPick,
}: {
  readonly onPick: (prompt: string) => void;
}): JSX.Element {
  return (
    // w-fit + mx-auto: the glass band hugs the three chips instead of
    // spanning the composer's full width (owner report 2026-07-21 — the
    // empty glass margins read as a stray bar); max-w-full keeps the
    // wrap behavior on narrow windows.
    <div className="vex-rise vex-rise-d3 mx-auto mt-4 flex w-fit max-w-full flex-wrap items-center justify-center gap-2 rounded-2xl border border-[var(--vex-line)] bg-[var(--vex-surface-1)] p-1.5">
      {QUICK_ACTIONS.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={() => onPick(action.prompt)}
          // macOS-grade micro-interaction (motion pass, 2026-07-20): a 1.02
          // hover lift + press settle on the Tailwind transition — transform
          // only, stilled by the global reduced-motion rule.
          className="vex-micro inline-flex min-w-0 items-center gap-2 rounded-lg border border-[var(--vex-line)] px-3 py-1.5 text-[var(--vex-text-2)] transition duration-150 hover:scale-[1.02] hover:border-[var(--vex-accent-border)] hover:text-foreground active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        >
          {/* Intent glyph — decorative accent mark, not part of the label. */}
          <VexIcon
            icon={action.icon}
            size={13}
            className="shrink-0 text-[var(--vex-accent-text)]"
            aria-hidden
          />
          <span className="truncate">{action.label}</span>
        </button>
      ))}
    </div>
  );
}
