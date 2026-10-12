/**
 * The front door to the Lighter desk during the Perps Trading Arena. Before
 * this the desk opened only from a session rail's "Lighter" tab button or the
 * typed "light it up" - nothing on the welcome screen said Lighter at all.
 * The notice sits under the greeting, names the venue and the window, and
 * one button opens the desk on Robinhood Chain (the venue the campaign
 * counts). After the campaign, the same card remains a permanent
 * Lighter entry and preserves the user's last environment.
 *
 * Drawn as the welcome spread draws it (docs/design/V10-SPREAD.md section 1,
 * reference d2): one ruled box on the paper, the phase as a status chip
 * (`[LIVE NOW]` behind the solid swatch, `[UPCOMING EVENT]` behind the
 * target), the window in mono caps, the event name in the 36px serif, the
 * reward line and the one blue key. Status by fill: nothing blinks.
 */

import { useEffect, useState, type JSX } from "react";
import { IconArrowUpRight, IconClose, IconGift } from "../../components/icons/index.js";
import { Button } from "../../components/ui/button.js";
import { Chip } from "../../components/ui/chip.js";
import { useLighterAnalysisStore } from "../../stores/lighterAnalysisStore.js";
import {
  ARENA_CAMPAIGN,
  arenaCampaignDay,
  arenaCampaignPhase,
} from "./lighterTrading/arena-campaign.js";
import { recordFunnelStep } from "./lighterTrading/funnel.js";
import { enterLighterMode } from "./lighterTrading/workspace-command.js";

/**
 * Dismissal lives in renderer-process memory, so it clears on the next app
 * reboot and the card returns. A module-level flag (not sessionStorage) keeps
 * the state out of any web-storage API the renderer is forbidden from touching,
 * while giving the same "gone until reboot" lifetime.
 */
let dismissedThisSession = false;

function readDismissed(): boolean {
  return dismissedThisSession;
}

function writeDismissed(): void {
  dismissedThisSession = true;
}

/**
 * Test hook only: reset the in-memory dismissal so a suite can model a fresh
 * app boot. Never called by production code.
 */
export function __resetArenaNoticeDismissalForTests(): void {
  dismissedThisSession = false;
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
      className="vex-arena vex-rise vex-rise-d1 text-left"
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center text-ink-secondary transition-colors duration-100 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <IconClose size={12} />
      </button>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 pr-8">
        {phase === "live" ? (
          <Chip state="done" data-vex-arena-live="">
            Live now
          </Chip>
        ) : phase === "upcoming" ? (
          <Chip state="warning">Upcoming event</Chip>
        ) : (
          <span className="inline-flex h-6 items-center px-2.5 font-mono text-[11px] uppercase tracking-chip text-accent-primary outline outline-1 -outline-offset-1 outline-rule">
            Vex × Lighter
          </span>
        )}
        <span className="font-mono text-[11px] uppercase tracking-status text-ink-secondary">
          {timing}
        </span>
      </div>
      <h2 className="vex-arena__title">
        {campaignActive ? ARENA_CAMPAIGN.name : "Trade with Vex on Lighter"}
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-4">
        {campaignActive ? (
          <span className="inline-flex items-center gap-2.5 text-[15px] leading-6 text-ink-primary">
            <span aria-hidden className="inline-flex text-accent-primary">
              <IconGift size={16} />
            </span>
            Rewards: {ARENA_CAMPAIGN.reward}
          </span>
        ) : (
          <span aria-hidden />
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={() => openLighterDesk(campaignActive)}
        >
          {campaignActive ? "Enter with Vex" : "Open Lighter"}
          <IconArrowUpRight size={14} />
        </Button>
      </div>
    </div>
  );
}
