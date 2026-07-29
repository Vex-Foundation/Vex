/**
 * Engine-error live sync — retention and invalidation, split on purpose.
 *
 * THE BUG THIS SPLIT FIXES. Retention used to live in the per-session hook,
 * which accepted only the SELECTED session's events, while the global hook
 * accepted only session-less ones. An event for session B arriving while A was
 * on screen matched neither and was recorded NOWHERE — and background failures
 * (wake ticks, compact jobs) are precisely the ones that arrive for a session
 * the user is not looking at. The failure the channel exists to surface was the
 * one it dropped.
 *
 * So the two jobs are now separated by what they are actually about:
 *
 *  - RETENTION is app-wide. One subscription at the shell keeps EVERY event in
 *    its proper partition, whichever session it belongs to, so selecting B
 *    later shows what happened while A was open.
 *  - INVALIDATION is session-scoped. Only the active session's queries can
 *    usefully be refetched, so that hook stays per-session and now does only
 *    that.
 *
 * PUSH ONLY. No fallback poll on either: a missed error event is not a
 * stale-state problem the way a missed control transition is. The durable
 * answer to "why did my run stop" lives in the runtime-state read, which has
 * its own fallback.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useEngineErrorStore } from "../../stores/engineErrorStore.js";
import { runtimeKeys } from "./queryKeys.js";

/**
 * App-wide retention. Mounted ONCE at the shell, never per session.
 *
 * Records every event the engine emits, routed by `sessionId` alone: `null`
 * goes to the global partition (a positive claim of "system-wide"), anything
 * else to that session's slot. No filtering by which session is on screen —
 * that filter was the defect.
 *
 * Nothing is cleared here. Entries are retired by an explicit user dismiss, so
 * a failure that happened in the background is still there when the user gets
 * to it.
 */
export function useEngineErrorRetentionSync(): void {
  const record = useEngineErrorStore((s) => s.record);

  useEffect(() => {
    const off = window.vex.engine.onEngineError((event) => {
      record(event);
    });
    return off;
  }, [record]);
}

/**
 * Active-session query invalidation. Mounted per session by `SessionPanel`.
 *
 * A failure that paused a run changes composer/mission gating, and the user
 * should not wait out the fallback interval to see it. Retention is NOT this
 * hook's job — see `useEngineErrorRetentionSync`.
 */
export function useEngineErrorLiveSync(sessionId: string | null): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (sessionId === null || sessionId.length === 0) return;

    const off = window.vex.engine.onEngineError((event) => {
      // EXPLICIT null guard, not merely an inequality that happens to reject
      // it. A null `sessionId` is a positive claim that the failure is
      // system-wide, so it never maps to a session's queries; stating the rule
      // keeps a future refactor of the comparison from making null a wildcard.
      if (event.sessionId === null) return;
      if (event.sessionId !== sessionId) return;
      void queryClient.invalidateQueries({
        queryKey: runtimeKeys.state(sessionId),
      });
    });

    return off;
  }, [sessionId, queryClient]);
}
