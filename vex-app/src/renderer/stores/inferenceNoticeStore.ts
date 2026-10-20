/**
 * Inference NOTICES per session: the latest "this ran, but not as asked"
 * fact for each session (today the Vex Cloud D16 `max_tokens` clamp), shown
 * on that session's turn until the user dismisses it or a newer one replaces
 * it. UI-only state, never persisted: the engine log is the durable record.
 *
 * BOUNDED: one notice per session, at most {@link MAX_SESSIONS} sessions; the
 * oldest session's notice is evicted first.
 */

import { create } from "zustand";
import type { InferenceNoticeEvent } from "@shared/schemas/inference-notice.js";

export const MAX_SESSIONS = 64;

interface InferenceNoticeState {
  readonly bySessionId: Readonly<Record<string, InferenceNoticeEvent>>;
  readonly record: (event: InferenceNoticeEvent) => void;
  readonly clear: (sessionId: string) => void;
}

export const useInferenceNoticeStore = create<InferenceNoticeState>((set) => ({
  bySessionId: {},
  record: (event) =>
    set((state) => {
      const { [event.sessionId]: _previous, ...rest } = state.bySessionId;
      const next: Record<string, InferenceNoticeEvent> = { ...rest, [event.sessionId]: event };
      const ids = Object.keys(next);
      // Insertion order is recency: the re-inserted session is last.
      for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete next[id];
      return { bySessionId: next };
    }),
  clear: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.bySessionId)) return state;
      const { [sessionId]: _removed, ...rest } = state.bySessionId;
      return { bySessionId: rest };
    }),
}));
