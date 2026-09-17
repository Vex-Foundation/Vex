/**
 * VEX Perps Trading Arena - the Superboard campaign that counts trades on
 * Lighter Robinhood Chain only. Dates are the campaign's published window;
 * the phase is a pure read of a clock the caller freezes (the hero reads its
 * clock once per mount and never ticks).
 */

export const ARENA_CAMPAIGN = {
  name: "Perps Trading Arena",
  venue: "Lighter Robinhood Chain",
  startsAt: new Date("2026-09-18T11:00:00Z"),
  endsAt: new Date("2026-10-16T11:00:00Z"),
} as const;

export type ArenaCampaignPhase = "upcoming" | "live" | "over";

export function arenaCampaignPhase(now: Date): ArenaCampaignPhase {
  if (now.getTime() < ARENA_CAMPAIGN.startsAt.getTime()) return "upcoming";
  if (now.getTime() < ARENA_CAMPAIGN.endsAt.getTime()) return "live";
  return "over";
}

/** "Sep 18" - the campaign's own clock is UTC, so the day is too. */
export function arenaCampaignDay(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
