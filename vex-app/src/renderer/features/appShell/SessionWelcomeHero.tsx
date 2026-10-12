/**
 * The welcome spread's chapter opening (docs/design/V10-SPREAD.md section 1,
 * reference d2): the date eyebrow in 13px Departure Mono caps, the
 * time-of-day greeting in the 96px serif, and the Arena notice under them,
 * flush left at the head of the page. The parent (`SessionPanel`) seats this
 * directly above the composer field; the vx mark is not repeated here, it is
 * the left page's mast. Load-in rides the one-shot `.vex-rise` choreography;
 * the field and the starters stagger on sibling elements.
 *
 * THE MODE CAPSULE SITS AT THE HEAD OF THE OPENING WHILE NO SESSION IS ACTIVE
 * AND THE LEFT PAGE IS A SPINE (owner decree 2026-09-04: the Agent | Studio
 * switch is on the welcome screen). The `Runtime mode` radiogroup still has
 * exactly ONE home per page. `activeSessionId` decides between the opening and
 * the agent rail header (`AgentSidebarHeader`): null, the capsule is here
 * above the date; non-null, the rail carries it and this opening mounts none
 * (e2e/studio.spec.ts pins the count). An IDLE session still shows this
 * opening (`SessionPanel` keeps the hero phase for a session with no
 * transcript), and in that state the capsule is the rail's, not this
 * opening's - a session is active, so the rail is its seat.
 *
 * WHILE THE LEFT PAGE IS OPEN its mast carries the capsule beside the vx mark,
 * on the welcome stage too (docs/design/V10-SPREAD.md section 3), so this
 * opening mounts its copy only while the page is a spine (`useLeftPageOpen`).
 * Outside the shell frame there is no page, and the opening keeps its seat.
 */

import { useState, type JSX } from "react";
import { pickGreeting } from "../../lib/greeting.js";
import { cn } from "../../lib/utils.js";
import { useUserProfile } from "../../lib/api/user-profile.js";
import { useUiStore } from "../../stores/uiStore.js";
import { RuntimeModeToggle } from "./RuntimeModeToggle.js";
import { useLeftPageOpen } from "./leftPage/leftPageContext.js";
import { ArenaCampaignNotice } from "./ArenaCampaignNotice.js";
import { OPENING_COLUMN } from "./session-page-columns.js";

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
  const leftPageOpen = useLeftPageOpen();

  const capsuleSeated = activeSessionId === null && !leftPageOpen;

  return (
    <div
      data-vex-area="welcome-opening"
      className={cn(
        OPENING_COLUMN,
        "vex-opening relative z-10 flex flex-col items-start text-left",
      )}
    >
      <div className="vex-rise flex w-full flex-col items-start">
        {capsuleSeated ? (
          <RuntimeModeToggle runtimeMode={runtimeMode} onChange={setRuntimeMode} />
        ) : null}
        {/* The date eyebrow: 13px Departure Mono caps in ink, the honest
            build-stage disclosure as its tooltip. */}
        <span
          className={cn(
            "vex-micro-label vex-opening__eyebrow",
            capsuleSeated && "mt-7",
          )}
          title={PREVIEW_TITLE}
        >
          {eyebrowDate()}
        </span>
        <h1 className="vex-opening__title">{headline}</h1>
      </div>
      <ArenaCampaignNotice />
    </div>
  );
}
