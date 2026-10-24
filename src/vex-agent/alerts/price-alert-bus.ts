/**
 * In-process price-alert-fired event bus (F01).
 *
 * Same shape as `engine/runtime/mission-bus.ts`: a `Set<listener>`,
 * idempotent unsubscribe, misbehaving-listener isolation. The poller emits
 * only AFTER the claim that marked the alert fired has committed, so every
 * event corresponds to a `triggered` row the app can read back.
 *
 * The `vex-app` main process subscribes through its agent bridges,
 * re-validates against `priceAlertFiredEventSchema`
 * (`vex-app/src/shared/schemas/alerts.ts`), broadcasts to the windows and
 * raises the OS notification. The payload is bounded: ids, the asset, the
 * level and the price, and the user's own short note. No provider text and no
 * error strings ride this bus.
 */

import type { PriceAlertCondition, PriceAlertDirection } from "./condition.js";

/** Literal kept in sync with the shared schema's `PRICE_ALERT_FIRED_EVENT_TYPE`. */
export const PRICE_ALERT_FIRED_EVENT_TYPE = "engine.alerts.price_alert_fired" as const;

export interface PriceAlertFiredEvent {
  readonly type: typeof PRICE_ALERT_FIRED_EVENT_TYPE;
  readonly alertId: string;
  readonly assetKey: string;
  readonly chain: string;
  readonly label: string;
  readonly condition: PriceAlertCondition;
  /** What the user said: a USD price or a percent. */
  readonly value: string;
  readonly direction: PriceAlertDirection;
  /** The absolute level it fired against. */
  readonly triggerPrice: string;
  /** The price it fired at. */
  readonly triggeredPrice: string;
  readonly triggeredAt: string;
  readonly note: string | null;
}

export type PriceAlertFiredListener = (event: PriceAlertFiredEvent) => void;

export class PriceAlertFiredBus {
  private readonly listeners = new Set<PriceAlertFiredListener>();

  emit(event: PriceAlertFiredEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a misbehaving listener must not poison the rest of the bus
      }
    }
  }

  subscribe(listener: PriceAlertFiredListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const priceAlertFiredBus = new PriceAlertFiredBus();

/** Emit after the claim committed. Stamps `type`. */
export function emitPriceAlertFired(event: Omit<PriceAlertFiredEvent, "type">): void {
  priceAlertFiredBus.emit({ type: PRICE_ALERT_FIRED_EVENT_TYPE, ...event });
}

/** Subscribe; returns the unsubscribe. */
export function onPriceAlertFired(listener: PriceAlertFiredListener): () => void {
  return priceAlertFiredBus.subscribe(listener);
}
