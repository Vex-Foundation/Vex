/**
 * The front door to the Lighter desk during the Perps Trading Arena. Before
 * this the desk opened only from a session rail's "Lighter" tab button or the
 * typed "light it up" - nothing on the welcome screen said Lighter at all.
 * The notice sits under the greeting, names the venue and the window, and
 * one button opens the desk on Robinhood Chain (the venue the campaign
 * counts). After the campaign, the same card remains a permanent
 * Lighter entry and preserves the user's last environment.
 */

import { useEffect, useState, type JSX } from "react";
import { IconArrowUpRight } from "../../components/icons/index.js";
import { useLighterAnalysisStore } from "../../stores/lighterAnalysisStore.js";
import {
  ARENA_CAMPAIGN,
  arenaCampaignDay,
  arenaCampaignPhase,
} from "./lighterTrading/arena-campaign.js";
import { recordFunnelStep } from "./lighterTrading/funnel.js";
import { enterLighterMode } from "./lighterTrading/workspace-command.js";

function openLighterDesk(campaignActive: boolean): void {
  const currentEnvironment = useLighterAnalysisStore.getState().desk.environment;
  const environment = campaignActive ? "rhc" : currentEnvironment;
  if (campaignActive) useLighterAnalysisStore.getState().saveDesk({ environment });
  recordFunnelStep(campaignActive ? "arena_banner" : "desk_entry_cta", environment);
  enterLighterMode();
}

export function ArenaCampaignNotice(): JSX.Element | null {
  const [phase, setPhase] = useState(() => arenaCampaignPhase(new Date()));
  useEffect(() => {
    const timer = setInterval(() => setPhase(arenaCampaignPhase(new Date())), 60_000);
    return () => clearInterval(timer);
  }, []);
  const campaignActive = phase !== "over";

  const timing = phase === "live"
    ? `Ends ${arenaCampaignDay(ARENA_CAMPAIGN.endsAt)} · 11:00 UTC`
    : phase === "upcoming"
      ? `Starts ${arenaCampaignDay(ARENA_CAMPAIGN.startsAt)} · 11:00 UTC`
      : "Live markets · Vex analysis · Orders you approve";

  return (
    <div
      role="status"
      data-vex-area="arena-campaign-notice"
      data-phase={phase}
      className="vex-rise vex-rise-d1 mt-5 flex w-full max-w-[680px] flex-wrap items-center gap-4 rounded-[18px] border border-accent-primary/40 bg-accent-primary/10 p-4 text-left shadow-lv1"
    >
      <div className="min-w-0 flex-[1_1_260px]">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em]">
          <span className="rounded-capsule bg-accent-primary px-2 py-0.5 text-ink-on-accent">
            {phase === "live" ? "Live now" : phase === "upcoming" ? "Upcoming event" : "Vex × Lighter"}
          </span>
          <span className="text-ink-secondary">{campaignActive ? "Robinhood Chain" : "AI trading desk"}</span>
        </div>
        <h2 className="text-[18px] font-semibold leading-6 text-ink-primary">
          {campaignActive ? ARENA_CAMPAIGN.name : "Trade with Vex on Lighter"}
        </h2>
        <p className="mt-1 text-[12px] leading-5 text-ink-secondary">{timing}</p>
      </div>
      <button
        type="button"
        onClick={() => openLighterDesk(campaignActive)}
        className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-capsule bg-accent-primary px-4 text-[13px] font-semibold text-ink-on-accent transition-colors duration-100 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2"
      >
        {campaignActive ? "Enter with Vex" : "Open Lighter"}
        <IconArrowUpRight size={16} />
      </button>
    </div>
  );
}
