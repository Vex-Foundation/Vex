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
import { IconArrowUpRight, IconClose, IconGift } from "../../components/icons/index.js";
import { useLighterAnalysisStore } from "../../stores/lighterAnalysisStore.js";
import {
  ARENA_CAMPAIGN,
  arenaCampaignDay,
  arenaCampaignPhase,
} from "./lighterTrading/arena-campaign.js";
import { recordFunnelStep } from "./lighterTrading/funnel.js";
import { enterLighterMode } from "./lighterTrading/workspace-command.js";

const DISMISS_STORAGE_KEY = "vex-arena-notice-dismissed";

/** Dismissal lives in sessionStorage, so it clears on the next app reboot and the card returns. */
function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    sessionStorage.setItem(DISMISS_STORAGE_KEY, "1");
  } catch {
    /* a refused write just means the card returns on the next reload */
  }
}

function openLighterDesk(campaignActive: boolean): void {
  const currentEnvironment = useLighterAnalysisStore.getState().desk.environment;
  const environment = campaignActive ? "rhc" : currentEnvironment;
  if (campaignActive) useLighterAnalysisStore.getState().saveDesk({ environment });
  recordFunnelStep(campaignActive ? "arena_banner" : "desk_entry_cta", environment);
  enterLighterMode();
}

export function ArenaCampaignNotice(): JSX.Element | null {
  const [phase, setPhase] = useState(() => arenaCampaignPhase(new Date()));
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    const timer = setInterval(() => setPhase(arenaCampaignPhase(new Date())), 60_000);
    return () => clearInterval(timer);
  }, []);
  const campaignActive = phase !== "over";

  if (dismissed) return null;

  const dismiss = (): void => {
    writeDismissed();
    setDismissed(true);
  };

  const timing = phase === "live"
    ? `Ends ${arenaCampaignDay(ARENA_CAMPAIGN.endsAt)}`
    : phase === "upcoming"
      ? `Starts ${arenaCampaignDay(ARENA_CAMPAIGN.startsAt)}`
      : "Live markets · Vex analysis · Orders you approve";

  return (
    <div
      role="status"
      data-vex-area="arena-campaign-notice"
      data-phase={phase}
      className="vex-rise vex-rise-d1 vex-arena-pulse relative mt-5 flex w-full max-w-[680px] flex-wrap items-center gap-x-4 gap-y-3 rounded-[18px] border border-accent-primary/40 bg-accent-primary/10 py-3 pl-11 pr-4 text-left shadow-lv1"
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute left-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full text-ink-secondary transition-colors duration-100 hover:bg-accent-primary/15 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2"
      >
        <IconClose size={14} />
      </button>
      <div className="min-w-0 flex-[1_1_260px]">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="inline-flex items-center gap-1.5 rounded-capsule bg-accent-primary px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-on-accent">
            {phase === "live" ? (
              <span className="vex-live-dot h-1.5 w-1.5 rounded-full bg-danger" aria-hidden="true" />
            ) : null}
            {phase === "live" ? "Live now" : phase === "upcoming" ? "Upcoming event" : "Vex × Lighter"}
          </span>
          <h2 className="text-[17px] font-semibold leading-6 text-ink-primary">
            {campaignActive ? ARENA_CAMPAIGN.name : "Trade with Vex on Lighter"}
          </h2>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-5 text-ink-secondary">
          {campaignActive ? (
            <span className="inline-flex items-center gap-1 rounded-capsule bg-accent-wash px-2 py-0.5 font-semibold text-accent-primary">
              <IconGift size={13} />
              Rewards: {ARENA_CAMPAIGN.reward}
            </span>
          ) : null}
          <span>{timing}</span>
        </div>
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
