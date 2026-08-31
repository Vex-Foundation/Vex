/**
 * Welcome stage crown - the rebrand hero (accepted mockup, 2026-08-20): the
 * vx script mark over a micro-label date eyebrow, the time-of-day greeting headline, and the
 * Agent | Studio runtime-mode toggle (Studio reserved: disabled with a lock
 * until vex-studio ships - seam #2). The parent (`SessionPanel`) seats this
 * directly above the composer and centers the column; the "BACKED BY"
 * footer band is retired. Load-in rides the one-shot `.vex-rise`
 * choreography; the composer and chips stagger on sibling elements.
 */

import { useState, type JSX } from "react";
import { VexMark } from "../../components/common/VexMark.js";
import { pickGreeting } from "../../lib/greeting.js";
import { useUserProfile } from "../../lib/api/user-profile.js";
import { cn } from "../../lib/utils.js";
import { useUiStore, type RuntimeMode } from "../../stores/uiStore.js";

/** Honest build-stage disclosure (carried from the retired PREVIEW badge). */
const PREVIEW_TITLE =
  `Preview build (v${__VEX_APP_VERSION__}). Vex is pre-1.0 and evolving. ` +
  "Self-custodial - you control your keys and every action. " +
  "Verify before moving funds. Not financial advice.";

/** "WEDNESDAY · AUG 20" - computed once per mount; a date, not a clock. */
function eyebrowDate(): string {
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const day = now.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${weekday} · ${day}`.toUpperCase();
}

export function SessionWelcomeHero(): JSX.Element {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const setRuntimeMode = useUiStore((s) => s.setRuntimeMode);

  // Headline greeting (owner decision 2026-08-20, rotating pools): the
  // Vex-setup displayName through the SAME profile read SidebarProfile uses,
  // failing closed to the nameless draw for every non-success state. The
  // hour and the random draw are frozen ONCE PER MOUNT (useState
  // initializers) so the headline never flickers across re-renders, and no
  // ticking timer exists - the welcome stage remounts often enough that a
  // band flip never needs a live clock. Only the profile read resolving can
  // upgrade the line (nameless → name variant), and at most once.
  const profileQuery = useUserProfile();
  const displayName = profileQuery.data?.ok
    ? profileQuery.data.data.displayName
    : null;
  const [rand01] = useState(() => Math.random());
  const [hour] = useState(() => new Date().getHours());
  const headline = pickGreeting(hour, displayName, rand01);

  return (
    <div className="relative z-10 flex w-full flex-col items-center px-8 pb-2 text-center">
      <div className="vex-rise flex flex-col items-center justify-center gap-3">
        {/* vx script mark on the brand-mark token (owner rule 2026-08-21:
          * white everywhere in chronos, brand blue in celeris) - one inline
          * mark, the theme flip lives in tokens.css. */}
        <span aria-hidden className="text-brand-mark">
          <VexMark size={64} />
        </span>
        <span
          className="vex-micro-label vex-micro-label--wide uppercase text-ink-secondary"
          title={PREVIEW_TITLE}
        >
          {eyebrowDate()}
        </span>
        <h1 className="font-display text-[30px] font-medium leading-[38px] tracking-[-0.01em] text-ink-primary">
          {headline}
        </h1>
        <RuntimeModeToggle
          runtimeMode={runtimeMode}
          onChange={setRuntimeMode}
        />
      </div>
    </div>
  );
}

/**
 * Agent | Studio segmented capsule. LIVE since stage B4a.
 *
 * CONTRACT CHANGE, stated because two tests pinned the old one: the Studio
 * segment used to be a disabled button wearing a lock and a "coming soon"
 * title, and the Agent segment used to be an inert `<span aria-current>`. Both
 * are now real radios in a `role="radiogroup"`, the current one carries
 * `aria-checked`, and choosing one dispatches the shell.
 *
 * A radiogroup rather than a tablist: the two segments select a MODE for the
 * whole shell, not a panel this capsule labels, and neither segment is the
 * accessible owner of the columns it switches. The choice is a UI intent and
 * nothing more (rule 08) - it decides which surfaces mount and grants no
 * authority; every privileged Studio call is still checked in main.
 */
function RuntimeModeToggle({
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

const RUNTIME_MODE_SEGMENTS: readonly {
  readonly mode: RuntimeMode;
  readonly label: string;
}[] = [
  { mode: "agent", label: "Agent" },
  { mode: "studio", label: "Studio" },
];
