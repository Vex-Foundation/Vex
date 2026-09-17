/**
 * The front door to the Lighter desk during the Perps Trading Arena. Before
 * this the desk opened only from a session rail's "Lighter" tab button or the
 * typed "light it up" - nothing on the welcome screen said Lighter at all.
 * The notice sits under the greeting, names the venue and the window, and
 * one button opens the desk on Robinhood Chain (the venue the campaign
 * counts). It reads the clock once per mount like the hero and retires itself
 * after the window closes.
 */

import { useState, type JSX } from "react";
import { useLighterAnalysisStore } from "../../stores/lighterAnalysisStore.js";
import {
  ARENA_CAMPAIGN,
  arenaCampaignDay,
  arenaCampaignPhase,
} from "./lighterTrading/arena-campaign.js";
import { recordFunnelStep } from "./lighterTrading/funnel.js";
import { enterLighterMode } from "./lighterTrading/workspace-command.js";

function openArenaDesk(): void {
  // The desk remembers its last venue; the campaign only counts this one.
  useLighterAnalysisStore.getState().saveDesk({ environment: "rhc" });
  recordFunnelStep("arena_banner", "rhc");
  enterLighterMode();
}

export function ArenaCampaignNotice(): JSX.Element | null {
  const [phase] = useState(() => arenaCampaignPhase(new Date()));
  if (phase === "over") return null;

  const line = phase === "live"
    ? `${ARENA_CAMPAIGN.name} is live on ${ARENA_CAMPAIGN.venue} through ${arenaCampaignDay(ARENA_CAMPAIGN.endsAt)}.`
    : `${ARENA_CAMPAIGN.name} starts ${arenaCampaignDay(ARENA_CAMPAIGN.startsAt)}, 11:00 UTC, on ${ARENA_CAMPAIGN.venue}.`;

  return (
    <div
      role="status"
      data-vex-area="arena-campaign-notice"
      data-phase={phase}
      className="vex-rise vex-rise-d1 mt-4 flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-capsule border border-line-2 py-1.5 pl-4 pr-1.5 text-[13px] leading-5 text-ink-secondary"
    >
      <span className="inline-flex items-center gap-2">
        {phase === "live" ? (
          <span aria-hidden className="h-[6px] w-[6px] rounded-full bg-accent-primary" />
        ) : null}
        {line}
      </span>
      <button
        type="button"
        onClick={openArenaDesk}
        className="inline-flex h-7 items-center rounded-capsule border border-accent-primary/55 px-3 font-medium text-accent-primary transition-colors duration-100 hover:bg-accent-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
      >
        Open the desk
      </button>
    </div>
  );
}
