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
 */

import type { JSX } from "react";
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
}: {
  readonly runtimeMode: RuntimeMode;
  readonly onChange: (mode: RuntimeMode) => void;
}): JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label="Runtime mode"
      className="flex h-9 items-center gap-0.5 rounded-capsule border border-line-2 bg-surface-1 p-0.5 shadow-lv1"
    >
      {RUNTIME_MODE_SEGMENTS.map((segment) => {
        const current = runtimeMode === segment.mode;
        return (
          <button
            key={segment.mode}
            type="button"
            role="radio"
            aria-checked={current}
            onClick={() => onChange(segment.mode)}
            className={cn(
              "inline-flex h-full items-center rounded-capsule px-3.5 text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
              current
                ? "bg-interactive-active font-medium text-ink-primary"
                : "text-ink-tertiary hover:text-ink-primary",
            )}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}
