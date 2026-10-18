/**
 * The morning, K2's one input from the wall clock (the owner, 2026-10-18: her morning coffee): local
 * 06:00 to 10:59. The host reads it and refreshes it every minute (`useMorning`) and passes it to
 * her (`VexK2` `morning`, `K2Engine.setMorning`), so her timeline (`k2-time.ts`) stays a pure
 * function of her own clock and its inputs. Kept apart from the engine: a host that reads the
 * morning carries only this.
 *
 * Review: the dev harness takes `?hour=<0..23>` in place of the local hour (`requestedHour`), so the
 * coffee can be seen at any time (`?hour=8`, with `?g=coffee` to play it a second after she is
 * awake). The app itself reads only the clock.
 */
import { useSyncExternalStore } from "react";

/** The morning's hours: from 06:00, up to (not including) 11:00. */
export const MORNING = { from: 6, to: 11 } as const;
/** How often the host reads the clock again (ms). */
export const MORNING_REFRESH_MS = 60000;

/** Whether a local hour (0..23) is in the morning. */
export function isMorning(hour: number): boolean {
  return hour >= MORNING.from && hour < MORNING.to;
}

/** The hour `?hour=<0..23>` asks for (review), or null. */
export function requestedHour(search: string): number | null {
  const q = new URLSearchParams(search).get("hour");
  if (q === null || !/^\d{1,2}$/.test(q)) return null;
  const h = Number(q);
  return h >= 0 && h <= 23 ? h : null;
}

/** Whether it is morning now, by the local clock. */
export function morningNow(): boolean {
  return isMorning(new Date().getHours());
}

function subscribe(listener: () => void): () => void {
  const id = window.setInterval(listener, MORNING_REFRESH_MS);
  return () => window.clearInterval(id);
}

/** `morningNow`, read again every minute while mounted. */
export function useMorning(): boolean {
  return useSyncExternalStore(subscribe, morningNow, morningNow);
}
