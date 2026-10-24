/**
 * Watchlist and price alerts (F01): the page's query, its mutations, and the
 * app-wide fired-alert notices.
 *
 * Main owns every read and write through `window.vex.alerts`; a refusal comes
 * back as a value (`{ ok: false, reason, message }`) inside an ok Result, and
 * an IPC error means the database could not be reached.
 */

import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { PriceAlertFiredEventDto, SearchTokensResult, WatchlistSnapshotDto } from "@shared/schemas/alerts.js";
import { firedAlertSentence } from "@shared/alerts-copy.js";
import { notify } from "../notifications/index.js";
import { useUiStore } from "../../stores/uiStore.js";
import { alertsKeys } from "./queryKeys.js";

/** While the page is open, prices refresh this often (DexScreener's own cache is ~30 s). */
export const WATCHLIST_REFRESH_MS = 60_000;

export function useWatchlist(): UseQueryResult<Result<WatchlistSnapshotDto>> {
  return useQuery({
    queryKey: alertsKeys.watchlist(),
    queryFn: () => window.vex.alerts.getWatchlist(),
    refetchInterval: WATCHLIST_REFRESH_MS,
    retry: 0,
  });
}

/**
 * The add form's token search. One read per chain and settled query; a
 * superseded query aborts through TanStack's signal, and an answer is kept
 * for 30 s so retyping the same ticker does not ask DexScreener again.
 */
export function useTokenSearch(
  chain: string,
  query: string,
  enabled: boolean,
): UseQueryResult<Result<SearchTokensResult>> {
  return useQuery({
    queryKey: alertsKeys.tokenSearch(chain, query),
    queryFn: () => window.vex.alerts.searchTokens({ chain, query }),
    enabled,
    staleTime: 30_000,
    retry: 0,
  });
}

export function invalidateWatchlist(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: alertsKeys.watchlist() });
}

/** Open the Watchlist page from anywhere. */
export function openWatchlistPage(): void {
  useUiStore.getState().setShellRoute({ kind: "watchlist", origin: null });
}

/**
 * Raise the in-app notice for one fired alert. Closing it (by the user or by
 * its "Open watchlist" action) acknowledges the alert, so it is not shown
 * again on the next launch; a replacement or eviction does not.
 */
export function notifyFiredAlert(alert: PriceAlertFiredEventDto): void {
  const handle = notify({
    dedupKey: `price_alert:${alert.alertId}`,
    severity: "info",
    scope: { kind: "global" },
    source: "alerts.price",
    title: "Price alert",
    message: firedAlertSentence(alert),
    actions: [{ id: "open", label: "Open watchlist", rank: "primary", run: openWatchlistPage }],
  });
  handle.onDidClose((reason) => {
    if (reason !== "user" && reason !== "action") return;
    void window.vex.alerts.acknowledgeFired({ alertIds: [alert.alertId], clear: false });
  });
}

/**
 * Mounted once in the app shell. On mount it shows every fired alert not yet
 * acknowledged (one that fired with no window open, or before this window
 * booted); afterwards each pushed alert raises its notice and refreshes the
 * page. Main's request to open the Watchlist (an OS notification click)
 * routes here too.
 */
export function usePriceAlertNotices(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    // A preload or harness without the bridge renders a working shell with no
    // alert notices, as the other app-wide push hooks do.
    const bridge = window.vex?.alerts;
    if (bridge === undefined || typeof bridge.getWatchlist !== "function") return;
    let cancelled = false;
    void bridge.getWatchlist().then((result) => {
      if (cancelled || !result.ok) return;
      for (const fired of result.data.firedAlerts) {
        if (fired.acknowledgedAt !== null || fired.triggeredAt === null || fired.triggeredPrice === null) continue;
        notifyFiredAlert({
          type: "engine.alerts.price_alert_fired",
          alertId: fired.id,
          assetKey: fired.assetKey,
          chain: fired.chain,
          label: fired.label,
          condition: fired.condition,
          value: fired.value,
          direction: fired.direction,
          triggerPrice: fired.triggerPrice,
          triggeredPrice: fired.triggeredPrice,
          triggeredAt: fired.triggeredAt,
          note: fired.note,
        });
      }
    });
    const offFired = bridge.onPriceAlertFired((alert) => {
      notifyFiredAlert(alert);
      void invalidateWatchlist(queryClient);
    });
    const offOpen = bridge.onOpenWatchlist(openWatchlistPage);
    return () => {
      cancelled = true;
      offFired();
      offOpen();
    };
  }, [queryClient]);
}
