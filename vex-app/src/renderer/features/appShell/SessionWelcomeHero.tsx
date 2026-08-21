/**
 * Welcome stage crown - the rebrand hero (accepted mockup, 2026-08-20): the
 * vx script mark over a Doto date eyebrow, the time-of-day greeting headline, and the
 * Agent | Studio runtime-mode toggle (Studio reserved: disabled with a lock
 * until vex-studio ships - seam #2). The parent (`SessionPanel`) seats this
 * directly above the composer and centers the column; the "BACKED BY"
 * footer band is retired. Load-in rides the one-shot `.vex-rise`
 * choreography; the composer and chips stagger on sibling elements.
 */

import { useState, type JSX } from "react";
import { IconLock } from "../../components/icons/index.js";
import { pickGreeting } from "../../lib/greeting.js";
import { useUserProfile } from "../../lib/api/user-profile.js";
import { cn } from "../../lib/utils.js";
import { useUiStore } from "../../stores/uiStore.js";

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
  // READ-ONLY seam: the slot exists so the toggle can light up the moment
  // Studio ships; nothing here may switch it.
  const runtimeMode = useUiStore((s) => s.runtimeMode);

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
        {/* vx script mark - white over the chronos night photo, brand blue on
          * the celeris day scene (arbitrary parent variant on the theme
          * attribute; no JS theme read). */}
        <img
          src="/brand/vex-mark-white.svg"
          alt=""
          aria-hidden
          className="h-16 w-auto [[data-vex-theme=celeris]_&]:hidden"
        />
        <img
          src="/brand/vex-mark-color.svg"
          alt=""
          aria-hidden
          className="hidden h-16 w-auto [[data-vex-theme=celeris]_&]:block"
        />
        <span
          className="vex-doto-label vex-doto-label--wide vex-doto-chip uppercase text-ink-secondary"
          title={PREVIEW_TITLE}
        >
          {eyebrowDate()}
        </span>
        <h1 className="font-display text-[30px] font-medium leading-[38px] tracking-[-0.01em] text-ink-primary">
          {headline}
        </h1>
        <RuntimeModeToggle runtimeMode={runtimeMode} />
      </div>
    </div>
  );
}

/**
 * Agent | Studio segmented capsule. Studio is a reserved seat: disabled,
 * wearing the lock, explained by its title - the interaction space ships now
 * so the studio mode plugs in without a layout change. Neither segment
 * writes the store.
 */
function RuntimeModeToggle({
  runtimeMode,
}: {
  readonly runtimeMode: "agent" | "studio";
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Runtime mode"
      className="flex h-9 items-center gap-0.5 rounded-capsule border border-line-2 bg-surface-1 p-0.5 shadow-lv1"
    >
      <span
        aria-current={runtimeMode === "agent" ? "true" : undefined}
        className={cn(
          "inline-flex h-full items-center rounded-capsule px-3.5 text-[12.5px]",
          runtimeMode === "agent"
            ? "bg-interactive-active font-medium text-ink-primary"
            : "text-ink-tertiary",
        )}
      >
        Agent
      </span>
      <button
        type="button"
        disabled
        title="Vex Studio - coming soon"
        aria-label="Studio mode (coming soon)"
        className="inline-flex h-full cursor-not-allowed items-center gap-1.5 rounded-capsule px-3.5 text-[12.5px] text-ink-caption"
      >
        Studio
        <IconLock size={12} className="shrink-0" />
      </button>
    </div>
  );
}
