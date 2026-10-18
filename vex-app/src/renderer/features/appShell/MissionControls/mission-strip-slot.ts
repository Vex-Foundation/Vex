/**
 * Where a running mission's keys land: the mission strip above the composer
 * (docs/design/R3-MINIMAL.md section 7: the strip carries the word, the
 * contract's own limits and only the controls that apply).
 *
 * The strip lives in the composer and `MissionControls` lives in the session
 * column, two branches of the tree. The keys stay OWNED by `MissionControls`
 * (one set of mutation hooks, so a control in flight still disables every
 * other one, and the paused-on-error Recover in the transcript shares that
 * gate); only their DOM moves, through a portal into these cells. A session
 * whose strip is not mounted publishes no cell, and `MissionControls` then
 * draws the keys in place, so a control is never unreachable.
 *
 * Two cells per session: `controls` (the keys at the strip's right end) and
 * `notes` (a refusal line just above the strip). Keyed by session id so a
 * strip that unmounts for one session never clears another session's cell.
 *
 *   const cells = useMissionStripSlot(sessionId);
 *   return cells.controls === null ? inline : createPortal(keys, cells.controls);
 */

import { useSyncExternalStore } from "react";

export type MissionStripCell = "controls" | "notes";

export interface MissionStripCells {
  readonly controls: HTMLElement | null;
  readonly notes: HTMLElement | null;
}

const EMPTY: MissionStripCells = { controls: null, notes: null };

let cells: ReadonlyMap<string, MissionStripCells> = new Map();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Publish (or, with `null`, withdraw) one cell of a session's strip. A
 * withdrawal only clears the cell it published: a late `null` from an
 * unmounting strip never wipes a newer strip's element.
 */
export function setMissionStripCell(
  sessionId: string,
  cell: MissionStripCell,
  element: HTMLElement | null,
): void {
  const current = cells.get(sessionId) ?? EMPTY;
  if (element === null && current[cell] === null) return;
  if (element !== null && current[cell] === element) return;
  const next = new Map(cells);
  next.set(sessionId, { ...current, [cell]: element });
  cells = next;
  for (const listener of listeners) listener();
}

/** Withdraw one cell only when it still holds `element`. */
export function clearMissionStripCell(
  sessionId: string,
  cell: MissionStripCell,
  element: HTMLElement,
): void {
  const current = cells.get(sessionId);
  if (current === undefined || current[cell] !== element) return;
  setMissionStripCell(sessionId, cell, null);
}

export function useMissionStripSlot(sessionId: string): MissionStripCells {
  return useSyncExternalStore(
    subscribe,
    () => cells.get(sessionId) ?? EMPTY,
    () => EMPTY,
  );
}
