/**
 * Ephemeral engine-error store — session-scoped and GLOBAL partitions.
 *
 * Holds the most recent bounded failure signals delivered by the
 * `EV.engine.error` push channel. UI-only Zustand state, never persisted and
 * never mirroring a Query Cache source of truth — the durable record of a
 * session failure lives in `mission_runs` evidence, server-side.
 *
 * TWO PARTITIONS, because the events genuinely are two kinds:
 *
 *  - `bySessionId` keeps the LATEST failure per session. A failing turn often
 *    produces a burst (turn fails, mission finalizes, resume fails) and a
 *    growing list of near-identical banners would bury the one thing the user
 *    needs to read. That surface is "what just went wrong", not a log.
 *
 *  - `global` is a short LIST of session-less failures (memory maintenance),
 *    because they are independent events from different jobs rather than one
 *    story retold — collapsing them to "latest" would hide a second failing
 *    job behind the first. Dismissal is therefore per-event, which needs a
 *    stable identity the payload does not carry, so one is minted on arrival.
 *
 * A null `sessionId` is a positive claim that the failure is system-wide, so
 * routing is by that field alone and never by a fallback: a global failure
 * must never land in `bySessionId`, where a session banner would render it and
 * tell the user their conversation broke when it did not.
 *
 * The payload is bounded codes — category, error type/class, status, retry
 * hint. There is no message field at any layer, so nothing here can leak
 * provider prose into the DOM.
 */

import { create } from "zustand";
import type { EngineErrorEvent } from "@shared/schemas/engine-error.js";

/**
 * Cap on retained global failures. Memory jobs retry with backoff before they
 * give up, so a burst here means several DISTINCT jobs died — past a handful,
 * older ones are noise and the newest are what an operator acts on.
 */
export const GLOBAL_ENGINE_ERROR_CAP = 5;

/** A global failure plus the client-minted identity used to dismiss it. */
export interface GlobalEngineError {
  /** Stable per-arrival key. The payload carries no id of its own. */
  readonly key: string;
  readonly event: EngineErrorEvent;
}

interface EngineErrorState {
  /** Latest failure per session id. NEVER contains a session-less event. */
  readonly bySessionId: Readonly<Record<string, EngineErrorEvent>>;
  /** Newest-first list of session-less failures. */
  readonly global: readonly GlobalEngineError[];
  readonly record: (event: EngineErrorEvent) => void;
  /** Dismiss a session banner, or clear on session change / successful retry. */
  readonly clear: (sessionId: string) => void;
  /** Dismiss ONE global failure. */
  readonly dismissGlobal: (key: string) => void;
}

let globalSequence = 0;

export const useEngineErrorStore = create<EngineErrorState>((set) => ({
  bySessionId: {},
  global: [],
  record: (event) => {
    set((state) => {
      if (event.sessionId === null) {
        globalSequence += 1;
        const entry: GlobalEngineError = {
          // `occurredAt` alone is not unique — two jobs can settle in the same
          // millisecond — and a dismissal keyed on a duplicate would remove
          // both.
          key: `${event.occurredAt}#${globalSequence}`,
          event,
        };
        return {
          ...state,
          global: [entry, ...state.global].slice(0, GLOBAL_ENGINE_ERROR_CAP),
        };
      }
      return {
        ...state,
        bySessionId: { ...state.bySessionId, [event.sessionId]: event },
      };
    });
  },
  clear: (sessionId) => {
    set((state) => {
      if (state.bySessionId[sessionId] === undefined) return state;
      const next = { ...state.bySessionId };
      delete next[sessionId];
      return { ...state, bySessionId: next };
    });
  },
  dismissGlobal: (key) => {
    set((state) => ({
      ...state,
      global: state.global.filter((entry) => entry.key !== key),
    }));
  },
}));
