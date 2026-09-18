/**
 * Which conversation the desk talks to. The desk keeps its own sessions
 * (`sessions.workspace = 'lighter'`); these helpers pick the one to resume and
 * name a new one after the market on the desk.
 */

import type { SessionListItem } from "@shared/schemas/sessions.js";
import { useLighterTradingMarkets } from "../../../lib/api/lighter-trading.js";
import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { filterSessionsByWorkspace } from "../sessionListModel.js";

/** The desk session started most recently, or null when the desk has none. */
export function latestDeskSession(rows: readonly SessionListItem[]): SessionListItem | null {
  let latest: SessionListItem | null = null;
  for (const row of filterSessionsByWorkspace(rows, "lighter")) {
    if (latest === null || row.startedAt > latest.startedAt) latest = row;
  }
  return latest;
}

/** Default title for a desk session: `BTC · Sep 17`. */
export function deskSessionTitle(symbol: string, now: Date = new Date()): string {
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(now);
  return `${symbol} · ${day}`;
}

/**
 * The default name for a session created from the desk, or null outside it
 * (or before the market list has answered).
 */
export function useDeskSessionName(): string | null {
  const lighter = useUiStore((s) => s.runtimeMode === "lighter");
  const { environment, marketId } = useLighterAnalysisStore((s) => s.desk);
  const marketsQuery = useLighterTradingMarkets(environment, lighter);
  if (!lighter) return null;
  const market =
    marketsQuery.data?.ok === true
      ? marketsQuery.data.data.markets.find((row) => row.marketId === marketId) ?? null
      : null;
  return market === null ? null : deskSessionTitle(market.symbol);
}
