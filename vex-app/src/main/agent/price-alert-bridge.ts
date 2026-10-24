/**
 * Engine -> renderer price alert bridge (F01).
 *
 * Subscribes to the in-process price-alert bus
 * (`src/vex-agent/alerts/price-alert-bus.ts`), which the poller emits on only
 * AFTER its single-shot claim has committed, and for each fired alert:
 *
 *  1. Projects the event field by field into the shared DTO and validates it
 *     (an internal field added tomorrow can neither leak nor drop the push),
 *     then broadcasts it to every window on `EV.alerts.priceAlertFired`. The
 *     renderer raises the in-app notice and re-reads the watchlist.
 *  2. Raises an OS notification when no Vex window is focused and the user
 *     has not turned them off (`preferences.notifications.priceAlertsOs`).
 *     While the vault is locked the body says only that an alert fired: a
 *     locked screen does not show the user's tokens and levels. A click
 *     brings Vex forward (recreating the window on macOS) on the Watchlist.
 *
 * Import discipline: the bus module is a leaf with no DB import, so mounting
 * this bridge pulls nothing of the engine's database graph into main.
 */

import { EV } from "@shared/ipc/channels.js";
import {
  LOCKED_PRICE_ALERT_BODY,
  PRICE_ALERT_TITLE,
  firedAlertSentence,
} from "@shared/alerts-copy.js";
import { priceAlertFiredEventSchema, type PriceAlertFiredEventDto } from "@shared/schemas/alerts.js";
import { onPriceAlertFired, type PriceAlertFiredEvent } from "@vex-agent/alerts/price-alert-bus.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { log } from "../logger/index.js";
import { showBackgroundNotice } from "../notifications/background-notice.js";
import { preferencesStore } from "../preferences/store.js";
import { isSecretSessionUnlocked } from "../secrets/session.js";
import { getMainWindow } from "../windows/main-window-ref.js";

/** A recreated window loads before React subscribes; the route is sent again after this. */
const REOPEN_ROUTE_DELAY_MS = 1_000;

/** The part of a `BrowserWindow` the click needs; a real window satisfies it. */
export interface WatchlistWindow {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  isDestroyed(): boolean;
  readonly webContents: { send(channel: string): void };
}

export interface PriceAlertBridgeDeps {
  readonly subscribe: typeof onPriceAlertFired;
  readonly broadcast: typeof broadcastToAllWindows;
  readonly showNotice: typeof showBackgroundNotice;
  readonly osNoticesEnabled: () => Promise<boolean>;
  readonly isUnlocked: () => boolean;
  readonly getWindow: () => WatchlistWindow | null;
  readonly createWindow: () => Promise<WatchlistWindow>;
}

const DEFAULT_DEPS: PriceAlertBridgeDeps = {
  subscribe: onPriceAlertFired,
  broadcast: broadcastToAllWindows,
  showNotice: showBackgroundNotice,
  osNoticesEnabled: async () => (await preferencesStore.load()).notifications.priceAlertsOs,
  isUnlocked: isSecretSessionUnlocked,
  getWindow: getMainWindow,
  // Imported lazily: the window module pulls the whole window graph.
  createWindow: async () => (await import("../windows/main-window.js")).createMainWindow(),
};

/** The DTO, named field by field: never `...event`. */
function project(event: PriceAlertFiredEvent): unknown {
  return {
    type: event.type,
    alertId: event.alertId,
    assetKey: event.assetKey,
    chain: event.chain,
    label: event.label,
    condition: event.condition,
    value: event.value,
    direction: event.direction,
    triggerPrice: event.triggerPrice,
    triggeredPrice: event.triggeredPrice,
    triggeredAt: event.triggeredAt,
    note: event.note,
  };
}

/** Bring Vex forward on the Watchlist page. */
export async function openWatchlistWindow(deps: PriceAlertBridgeDeps = DEFAULT_DEPS): Promise<void> {
  const existing = deps.getWindow();
  if (existing !== null) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    existing.webContents.send(EV.alerts.openWatchlist);
    return;
  }
  const created = await deps.createWindow();
  created.webContents.send(EV.alerts.openWatchlist);
  setTimeout(() => {
    if (!created.isDestroyed()) created.webContents.send(EV.alerts.openWatchlist);
  }, REOPEN_ROUTE_DELAY_MS);
}

async function deliver(event: PriceAlertFiredEventDto, deps: PriceAlertBridgeDeps): Promise<void> {
  deps.broadcast(EV.alerts.priceAlertFired, event);
  if (!(await deps.osNoticesEnabled())) return;
  deps.showNotice({
    title: PRICE_ALERT_TITLE,
    body: deps.isUnlocked() ? firedAlertSentence(event) : LOCKED_PRICE_ALERT_BODY,
    onClick: () => {
      void openWatchlistWindow(deps).catch((cause: unknown) => {
        log.warn("[agent:price-alert-bridge] could not open the watchlist", cause);
      });
    },
  });
}

/** Subscribe the bus. Returns the teardown the caller pushes into its cleanup. */
export function setupPriceAlertBridge(deps: PriceAlertBridgeDeps = DEFAULT_DEPS): () => void {
  return deps.subscribe((event) => {
    const parsed = priceAlertFiredEventSchema.safeParse(project(event));
    if (!parsed.success) {
      log.warn("[agent:price-alert-bridge] dropped invalid payload", { issues: parsed.error.issues });
      return;
    }
    void deliver(parsed.data, deps).catch((cause: unknown) => {
      log.warn("[agent:price-alert-bridge] delivery failed", cause);
    });
  });
}
