/**
 * Agent | Studio segmented capsule - THE control that switches the shell's
 * runtime mode. LIVE since stage B4a.
 *
 * It lives here, at the appShell root, rather than inside either welcome
 * screen, because BOTH shells mount it: the agent hero
 * (`SessionWelcomeHero`) and the Studio welcome
 * (`studio/welcome/StudioWelcome`). One module means the two mounts cannot
 * drift into two different affordances, two labels or two orderings for one
 * decision, and it is why Studio is not a one-way door: whichever welcome
 * screen the user is on, the way back is the same capsule in the same words.
 *
 * CONTRACT, stated because two tests pinned an older one: the Studio segment
 * used to be a disabled button wearing a lock and a "coming soon" title, and
 * the Agent segment used to be an inert `<span aria-current>`. Both are now
 * real radios in a `role="radiogroup"`, the current one carries `aria-checked`,
 * and choosing one dispatches the shell.
 *
 * A radiogroup rather than a tablist: the two segments select a MODE for the
 * whole shell, not a panel this capsule labels, and neither segment is the
 * accessible owner of the columns it switches. The choice is a UI intent and
 * nothing more (rule 08) - it decides which surfaces mount and grants no
 * authority; every privileged Studio call is still checked in main.
 *
 * It takes the mode and the setter as props rather than reading the store
 * itself: each mount already holds the store subscription it needs, and a
 * component that renders a choice is not the owner of where that choice is
 * kept.
 *
 * LOOK (docs/design/V10-SPREAD.md section 3): two 24px words in Departure
 * Mono caps, the chosen one in a box. On paper (the Studio rail, a welcome
 * hero) the box is the paper-2 step under the blue word; on the left page's
 * print the mast restyles it as a label box (left-page.css).
 */

import { useRef, type JSX } from "react";
import { cn } from "../../lib/utils.js";
import type { RuntimeMode } from "../../stores/uiStore.js";

const RUNTIME_MODE_SEGMENTS: readonly {
  readonly mode: RuntimeMode;
  readonly label: string;
}[] = [
  { mode: "agent", label: "Agent" },
  { mode: "studio", label: "Studio" },
];

export function RuntimeModeToggle({
  runtimeMode,
  onChange,
  className,
}: {
  readonly runtimeMode: RuntimeMode;
  readonly onChange: (mode: RuntimeMode) => void;
  /** The seat's own placement and, on the print, its restyle hook. */
  readonly className?: string;
}): JSX.Element {
  // ROVING TABINDEX, the radiogroup contract: the group is ONE tab stop (the
  // checked segment), and the arrow keys move between the segments, selecting
  // as they go. Before this the capsule was two tab stops that answered no key
  // at all, so a keyboard user tabbed through both segments and could still
  // only switch modes with Space on the one they happened to land on. Now that
  // the capsule also sits in the Studio rail, that is the difference between
  // Studio having a keyboard-reachable way back and not having one.
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, delta: number): void => {
    const next =
      (from + delta + RUNTIME_MODE_SEGMENTS.length) % RUNTIME_MODE_SEGMENTS.length;
    const segment = RUNTIME_MODE_SEGMENTS[next];
    if (segment === undefined) return;
    buttons.current[next]?.focus();
    onChange(segment.mode);
  };
  return (
    <div
      role="radiogroup"
      aria-label="Runtime mode"
      className={cn("vex-mode-seg inline-flex items-center gap-0.5", className)}
    >
      {RUNTIME_MODE_SEGMENTS.map((segment, index) => {
        const current = runtimeMode === segment.mode;
        return (
          <button
            key={segment.mode}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={current}
            tabIndex={current ? 0 : -1}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(index, -1);
              }
            }}
            onClick={() => onChange(segment.mode)}
            className={cn(
              "inline-flex h-6 items-center px-2 font-mono text-[11px] font-normal uppercase tracking-[var(--tracking-chip)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--vex-alias-focus)]",
              current
                ? "bg-accent-wash text-accent-primary"
                : "text-ink-secondary hover:text-accent-primary",
            )}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}
