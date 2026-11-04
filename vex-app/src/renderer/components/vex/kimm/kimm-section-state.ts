/**
 * WHETHER HER SECTION COVERS THE CONSOLE'S REST (docs/design/H3-DESKTOP.md
 * section 3.4; plan row S4-11): "The console's rest under her is inert while
 * she is open and until a close has ended." Her section lays itself over the
 * column, so what is under her is the console's, not hers: this is the seam
 * the console reads to make its rest inert, the same way the old sidebar read
 * `useVexClosing()` from `features/vex/vex-hide.ts`.
 *
 *   - covers: open, opening, and closing (until the close has ended);
 *   - does not cover: closed, the strip, which leaves the rest to the person.
 *
 * Module state, not store state: a phase is a moment of the one mounted
 * section, never persisted. `KimmSection` reports its phase here; the
 * console's rest (plan row S3, `VexConsole`) takes `inert={useKimmCovers()}`.
 * With no section mounted (the Lighter desk, a page's strip) nothing covers.
 */

import { useSyncExternalStore } from "react";

/**
 * Where her section is in its motion: resting `open` or `closed`, or on its
 * way, `opening` or `closing`, from the press until the wipe ends.
 */
export type KimmPhase = "open" | "closed" | "opening" | "closing";

let phase: KimmPhase | null = null;
const listeners = new Set<() => void>();

/** Her section reports its phase, or `null` as it unmounts. */
export function setKimmPhase(next: KimmPhase | null): void {
  if (phase === next) return;
  phase = next;
  for (const listener of listeners) listener();
}

/** Whether her section covers the console's rest right now. */
export function kimmCovers(): boolean {
  return phase !== null && phase !== "closed";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `kimmCovers()` as React state, for the console's rest. */
export function useKimmCovers(): boolean {
  return useSyncExternalStore(subscribe, kimmCovers, () => false);
}
