/**
 * Engine-error INGESTION SEAM: the one place an `EV.engine.error` event turns
 * into something a person can see.
 *
 * Holds the most recent bounded failure signal PER SESSION, and raises a
 * notification for every failure. UI-only Zustand state, never persisted and
 * never mirroring a Query Cache source of truth - the durable record of a
 * session failure lives in `mission_runs` evidence, server-side.
 *
 * ## Why the global partition is gone (B2.2)
 *
 * Session-less failures used to be kept here as a capped list of five and
 * rendered by a header pill with its own popover, its own dismiss control and
 * NO live region - a failure could arrive, sit in the flank and never be
 * announced to anyone. That surface is now the notification model: it
 * announces once, retains with a stated cap, reports what it evicted and is
 * read in the notification center. Keeping a second list here would be a
 * second answer to "which system failures exist", so the partition and its
 * cap were deleted rather than left in place unread.
 *
 * ## Why the session partition stayed
 *
 * The session card above the composer renders the TYPED event - the sanitized
 * detail in a technical register, the remedy or retry-after action line, the
 * bounded code trailer - and a notification message is one sanitized string.
 * So the event stays here for the card, and the notification is raised beside
 * it for the app-wide signal.
 *
 * The two are BOUND, in one direction each, so they can never disagree:
 * `clear` closes the notification, and the notification closing by a USER
 * gesture (in the toast or in the center) clears the entry. A close for any
 * other reason - a replacement, the retention cap, this store's own close -
 * does not clear, because none of those is the user saying "I have read it".
 *
 * A null `sessionId` is a positive claim that the failure is system-wide, so
 * routing is by that field alone and never by a fallback: a global failure
 * must never land in `bySessionId`, where a session banner would render it and
 * tell the user their conversation broke when it did not.
 *
 * The payload is bounded codes - category, error type/class, status, retry
 * hint - plus the SANITIZED `detail` and the `remedy` classification (owner
 * decree 2026-08-02). `detail` is stripped of secrets at the main-side bridge
 * before it can reach this store or the DOM.
 */

import { create } from "zustand";
import type { EngineErrorEvent } from "@shared/schemas/engine-error.js";
import { notify } from "../lib/notifications/index.js";
import type { NotificationHandle } from "../lib/notifications/types.js";
import {
  globalEngineErrorNotification,
  sessionEngineErrorNotification,
} from "./engine-error-notice.js";

interface EngineErrorState {
  /** Latest failure per session id. NEVER contains a session-less event. */
  readonly bySessionId: Readonly<Record<string, EngineErrorEvent>>;
  readonly record: (event: EngineErrorEvent) => void;
  /** Dismiss a session banner, or clear on session change / successful retry. */
  readonly clear: (sessionId: string) => void;
}

/**
 * The live notification per session, so `clear` can close the one it raised.
 *
 * Module-level rather than store state for the same reason the model itself
 * is: a handle is a live object with listeners, not a value to render, and
 * putting it in the store would make every card re-render on a subscription
 * change it cannot see.
 */
const sessionHandles = new Map<string, NotificationHandle>();

function closeSessionNotification(sessionId: string): void {
  const handle = sessionHandles.get(sessionId);
  if (handle === undefined) return;
  sessionHandles.delete(sessionId);
  handle.close();
}

export const useEngineErrorStore = create<EngineErrorState>((set) => ({
  bySessionId: {},
  record: (event) => {
    if (event.sessionId === null) {
      // Nothing to retain here: the model IS the retention, the bound and the
      // report for a failure that belongs to no conversation.
      notify(globalEngineErrorNotification(event));
      return;
    }
    const sessionId = event.sessionId;
    // Close the previous one FIRST so its listener cannot fire against the
    // handle we are about to store.
    closeSessionNotification(sessionId);
    const handle = notify(sessionEngineErrorNotification(event, sessionId));
    sessionHandles.set(sessionId, handle);
    handle.onDidClose((reason) => {
      if (sessionHandles.get(sessionId) === handle) sessionHandles.delete(sessionId);
      // Only a real gesture clears the card. A replacement, an eviction or
      // this store's own close must leave the card standing.
      if (reason !== "user") return;
      useEngineErrorStore.getState().clear(sessionId);
    });
    set((state) => ({
      ...state,
      bySessionId: { ...state.bySessionId, [sessionId]: event },
    }));
  },
  clear: (sessionId) => {
    closeSessionNotification(sessionId);
    set((state) => {
      if (state.bySessionId[sessionId] === undefined) return state;
      const next = { ...state.bySessionId };
      delete next[sessionId];
      return { ...state, bySessionId: next };
    });
  },
}));
