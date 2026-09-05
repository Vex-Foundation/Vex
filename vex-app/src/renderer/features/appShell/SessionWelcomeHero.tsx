/**
 * Welcome stage crown - the rebrand hero (accepted mockup, 2026-08-20): the
 * vx script mark over a micro-label date eyebrow and the time-of-day greeting
 * headline. The parent (`SessionPanel`) seats this directly above the composer
 * and centers the column; the "BACKED BY" footer band is retired. Load-in
 * rides the one-shot `.vex-rise` choreography; the composer and chips stagger
 * on sibling elements.
 *
 * THE MODE CAPSULE SITS UNDER THE WORDMARK WHILE NO SESSION IS ACTIVE (owner
 * decree 2026-09-04: "the Agent | Studio switch also under the vex wordmark on
 * the welcome screen, as it was before"). The `Runtime mode` radiogroup still
 * has exactly ONE home per page, and the seat is decided by ONE store fact,
 * `activeSessionId`: null, the capsule is here under the mark; non-null, the
 * agent rail header (`AgentSidebarHeader`) carries it and this hero mounts
 * none. Both consumers read the same field, which is what keeps the count at
 * one without a second flag (e2e/studio.spec.ts pins the count). An IDLE
 * session still shows this hero (`SessionPanel` keeps the hero phase for a
 * session with no transcript), and in that state the capsule is the rail's,
 * not this hero's - a session is active, so the rail is its seat.
 *
 * deepseek's `EmptyHero`/`HeroShell` seats one primary choice directly under
 * the brand mark in the hero stack and keeps everything else quiet; the
 * capsule takes that seat here (mark -> capsule -> eyebrow -> headline).
 */

import { useState, type JSX } from "react";
import { VexMark } from "../../components/common/VexMark.js";
import { pickGreeting } from "../../lib/greeting.js";
import { useUserProfile } from "../../lib/api/user-profile.js";
import { useUiStore } from "../../stores/uiStore.js";
import { RuntimeModeToggle } from "./RuntimeModeToggle.js";

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
  // The capsule takes the mode and the setter as props by contract; this hero
  // holds the store subscription. `activeSessionId` is the ONE fact that seats
  // the capsule (module note): null here, non-null in the rail header.
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const setRuntimeMode = useUiStore((s) => s.setRuntimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);

  return (
    <div className="relative z-10 flex w-full flex-col items-center px-8 pb-2 text-center">
      <div className="vex-rise flex flex-col items-center justify-center gap-3">
        {/* vx script mark on the brand-mark token (owner rule 2026-08-21:
          * white everywhere in chronos, brand blue in celeris) - one inline
          * mark, the theme flip lives in tokens.css. */}
        <span aria-hidden className="text-brand-mark">
          <VexMark size={64} />
        </span>
        {activeSessionId === null ? (
          <RuntimeModeToggle runtimeMode={runtimeMode} onChange={setRuntimeMode} />
        ) : null}
        <span
          className="vex-micro-label vex-micro-label--wide uppercase text-ink-secondary"
          title={PREVIEW_TITLE}
        >
          {eyebrowDate()}
        </span>
        <h1 className="font-display text-[30px] font-medium leading-[38px] tracking-[-0.01em] text-ink-primary">
          {headline}
        </h1>
      </div>
    </div>
  );
}
