/**
 * Runtime TanStack Query/Mutation hooks (agent integration puzzle 1).
 *
 * `useRuntimeState` is read-only and kept fresh by
 * `useControlStateLiveSync` (F5): push invalidation on
 * `EV.engine.controlState`, plus a 60s fallback poll for missed events.
 *
 * The four control mutation hooks (`useRequestPause`, `useRequestStop`,
 * `useRequestResume`, `useCancelWake`) call the LIVE puzzle-03 control
 * plane; each resolves to a `Result` wrapping that action's per-action
 * discriminated union — narrow on `outcome`. `retry: false` so a
 * control request is never auto-replayed. Exported for the UI
 * (puzzle 08) to wire against; no component consumes them yet.
 */

import { useEffect } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  RuntimeCancelWakeResult,
  RuntimeRequestInput,
  RuntimeRequestPauseResult,
  RuntimeRequestResumeResult,
  RuntimeRequestStopResult,
  RuntimeStateDto,
} from "@shared/schemas/runtime.js";
import { approvalsKeys, missionKeys, runtimeKeys } from "./queryKeys.js";

const STALE_MS = 2_000;

function stateOptions(sessionId: string) {
  return queryOptions({
    queryKey: runtimeKeys.state(sessionId),
    queryFn: () => window.vex.runtime.getState({ sessionId }),
    staleTime: STALE_MS,
    enabled: sessionId.length > 0,
  });
}

export function useRuntimeState(
  sessionId: string | null,
): UseQueryResult<Result<RuntimeStateDto>> {
  return useQuery(stateOptions(sessionId ?? ""));
}

/**
 * Runtime-state fallback invalidation cadence — covers a `controlState`
 * event that is missed (dropped at the preload Zod gate, fired before
 * this hook subscribed, or lost across a lifecycle edge). Exported for
 * tests.
 *
 * Slowed 8s → 60s: every committed transition already pushes, so this only
 * needs to cover composer gating after a DROPPED event. Pending approvals no
 * longer keep a faster poll anywhere — they are push-first too — so this is a
 * true net rather than a second freshness path.
 */
export const RUNTIME_STATE_FALLBACK_POLL_MS = 60_000;

/**
 * Subscribe the active session to the engine control-state spine (F5).
 *
 * Push: every committed control transition (`EV.engine.controlState`)
 * invalidates `runtimeKeys.state(sessionId)` (composer gating),
 * `approvalsKeys.pending(sessionId)` (inline approval card),
 * `missionKeys.draft(sessionId)` (draft badge), and the session's mission
 * diff queries (contract-status card) for the matching session — near-
 * instant, instead of waiting on a poll. The draft/diff pair closes issue
 * #41: a main-side draft→ready promotion (`reconcileDraftReadiness`, e.g.
 * from the async edit-stop finalizer) fires a `controlState` event but not
 * a renderer mutation, so `useMissionRenew`'s own `onSuccess` invalidation
 * never runs — this push path is what reaches the badge. A 30s fallback
 * re-invalidates `runtimeKeys.state` in case an event is missed; pending
 * approvals retain their own faster fallback poll in `ApprovalsRegion`
 * (the `controlState` emit is post-commit on lease release, not part of
 * the approval transaction, so the approval card must not depend on it
 * alone). Pure side effect — mount once per active session
 * (`SessionPanel`).
 */
export function useControlStateLiveSync(sessionId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (sessionId === null || sessionId.length === 0) return;

    const off = window.vex.engine.onControlState((event) => {
      if (event.sessionId !== sessionId) return;
      void queryClient.invalidateQueries({
        queryKey: runtimeKeys.state(sessionId),
      });
      void queryClient.invalidateQueries({
        queryKey: approvalsKeys.pending(sessionId),
      });
      void queryClient.invalidateQueries({
        queryKey: missionKeys.draft(sessionId),
      });
      // No `missionKeys.diffsForSession(sessionId)` helper exists in
      // queryKeys.ts (out of this package's write set) — invalidate via
      // the `missionKeys.diff(sessionId, missionId)` PREFIX instead.
      // TanStack matches by prefix by default, so this hits every diff
      // query cached for the session regardless of missionId.
      void queryClient.invalidateQueries({
        queryKey: ["mission", "diff", sessionId],
      });
    });

    const intervalId = window.setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: runtimeKeys.state(sessionId),
      });
    }, RUNTIME_STATE_FALLBACK_POLL_MS);

    return () => {
      off();
      window.clearInterval(intervalId);
    };
  }, [sessionId, queryClient]);
}

// One mutation shape per control verb. Parameterised on the verb's
// per-action discriminated union so the eventual UI (puzzle 08) can
// narrow `data.data.outcome` to drive the correct transition.
type ControlMutation<TResult> = UseMutationResult<
  Result<TResult>,
  Error,
  RuntimeRequestInput
>;

export function useRequestPause(): ControlMutation<RuntimeRequestPauseResult> {
  return useMutation({
    mutationFn: (input) => window.vex.runtime.requestPause(input),
    // `retry: false` — a control request is never auto-replayed. The
    // committed transition surfaces via `useControlStateLiveSync`.
    retry: false,
  });
}

export function useRequestStop(): ControlMutation<RuntimeRequestStopResult> {
  return useMutation({
    mutationFn: (input) => window.vex.runtime.requestStop(input),
    retry: false,
  });
}

export function useRequestResume(): ControlMutation<RuntimeRequestResumeResult> {
  return useMutation({
    mutationFn: (input) => window.vex.runtime.requestResume(input),
    retry: false,
  });
}

export function useCancelWake(): ControlMutation<RuntimeCancelWakeResult> {
  return useMutation({
    mutationFn: (input) => window.vex.runtime.cancelWake(input),
    retry: false,
  });
}
