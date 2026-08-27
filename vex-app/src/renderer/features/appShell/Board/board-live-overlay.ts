/**
 * THE PUBLISHED LIVE OVERLAY - what the board's ONE lease holder has on hand,
 * readable by the surfaces that do not hold it.
 *
 * THE PROBLEM THIS SOLVES, and it is a structural one rather than a
 * convenience. The lease is a single owner (A1): the modal's header toggle
 * asks for it, and `selectBoardLiveOwnerKey` derives that only an OPEN modal
 * may hold one. But the figures that lease produces are needed by components
 * the header does not contain - the card grid beside it, and the preview card
 * out in the transcript, which are sibling slots of the modal host and
 * therefore have no React ancestor to share a context through. Lifting a
 * provider above the host would put a lease-shaped thing in the shell; giving
 * each surface its own `useBoardLive` would open a SECOND lease, which is the
 * exact invariant the store exists to prevent.
 *
 * So the holder PUBLISHES and everyone else READS. One tiny module store,
 * keyed by the board the figures belong to, in the same book-local Zustand
 * shape as `board-surface-store` - and deliberately separate from it, because
 * that store is the owner of DECISIONS (which board, which view, live or not)
 * and this is a cache of the ANSWER to one of them.
 *
 * THE KEY IS THE POINT. Every read is guarded on the board key, so figures
 * published for one board can never be painted on another: a reader who
 * closes a board and opens a newer one sees the new board's own snapshot
 * until its lease produces a tick, never the previous board's live rows.
 * Publishing null (which the holder does on unmount) clears it.
 */

import { create } from "zustand";
import type { BoardHydratedRow } from "@vex-lib/board/index.js";
import type { BoardDataMode } from "../../../lib/api/board-live.js";
import type { BoardKey, BoardLiveReadout } from "./board-surface-contracts.js";

/** The figures one lease holder has published, and the board they belong to. */
export interface BoardLivePublication {
  readonly boardKey: BoardKey;
  readonly mode: BoardDataMode;
  readonly rowsByKey: ReadonlyMap<string, BoardHydratedRow> | null;
  readonly fetchedAtMs: number | null;
  /** An honest sentence about a terminal or unsupported state, or null. */
  readonly notice: string | null;
  /** False until capability is known, and while a request is in flight. */
  readonly canToggle: boolean;
}

interface BoardLiveOverlayState {
  readonly published: BoardLivePublication | null;
  readonly publishBoardLive: (publication: BoardLivePublication | null) => void;
}

export const useBoardLiveOverlayStore = create<BoardLiveOverlayState>((set) => ({
  published: null,
  publishBoardLive: (publication) => {
    set({ published: publication });
  },
}));

/** The publication for THIS board, or null when it belongs to another. */
export function selectBoardLivePublication(
  state: BoardLiveOverlayState,
  boardKey: BoardKey,
): BoardLivePublication | null {
  const published = state.published;
  if (published === null || published.boardKey !== boardKey) return null;
  return published;
}

/**
 * The snapshot readout a surface may show when nothing is published for it.
 *
 * `snapshot`, not `live-off`: those two are different facts (`board-live.ts`
 * documents the distinction) and a board that has never been live in this
 * mount owes the reader no sentence about why it is not.
 */
export const BOARD_LIVE_READOUT_SNAPSHOT: BoardLiveReadout = {
  mode: "snapshot",
  isLiveOwner: false,
  lastTickAtMs: null,
};

/** The read-only lease view a non-owner surface renders from. */
export function boardLiveReadout(
  publication: BoardLivePublication | null,
): BoardLiveReadout {
  if (publication === null) return BOARD_LIVE_READOUT_SNAPSHOT;
  return {
    mode: publication.mode,
    isLiveOwner: true,
    lastTickAtMs: publication.fetchedAtMs,
  };
}

/**
 * Is this mode one in which the lease is HELD?
 *
 * The bridge between the store's `liveRequested` INTENT and the lease hook's
 * own state: the hook owns a toggle, not a setter, so the holder reconciles
 * the two by comparing them and toggling on a difference. `live-unsupported`
 * is deliberately "not held" AND not retryable - the holder must not toggle
 * into it in a loop, which is why the reconciler checks capability too.
 */
export function isBoardLiveHeld(mode: BoardDataMode): boolean {
  return (
    mode === "live-connecting" ||
    mode === "live-connected" ||
    mode === "live-degraded"
  );
}
