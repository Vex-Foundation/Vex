/**
 * Compaction-PREPARATION hooks (compaction v2) — push-first.
 *
 * A separate file from `compaction.ts`, which owns the Track-2 `compact_jobs`
 * chip. This track is the `compaction_preparations` FSM behind the apply
 * button, and its freshness model is deliberately the OPPOSITE of the chip's:
 *
 *  - **push** (`usePreparationLiveSync`): every committed FSM transition
 *    broadcasts `EV.engine.compactionPreparation`, which invalidates the
 *    query. This is the primary freshness path.
 *  - **fallback poll**: a slow net for an event that was missed — dropped at
 *    the preload Zod gate, fired before the hook subscribed, or lost across a
 *    lifecycle edge.
 *
 * `useRequestCompactionApply` performs exactly ONE compare-and-swap and never
 * a cutover; the runner applies the standing request at its next iteration
 * boundary.
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
  CompactionApplyRequestInput,
  CompactionApplyRequestResult,
  CompactionPreparationResult,
} from "@shared/schemas/compaction-preparation.js";
import { compactionKeys, runtimeKeys } from "./queryKeys.js";

const STALE_MS = 5_000;

/**
 * Fallback invalidation cadence for the preparation query.
 *
 * 60s, matching `RUNTIME_STATE_FALLBACK_POLL_MS` and for the same reason: this
 * surface is PUSH-first, so the interval only has to cover a DROPPED event,
 * not to be a second freshness path. It is deliberately NOT
 * `COMPACTION_ACTIVE_POLL_MS` (5s) — that constant belongs to the poll-only
 * Track-2 chip, and copying it here would recreate the poll-first pattern this
 * track exists to remove. Exported for tests.
 */
export const PREPARATION_FALLBACK_POLL_MS = 60_000;

function preparationOptions(sessionId: string) {
  return queryOptions({
    queryKey: compactionKeys.preparation(sessionId),
    queryFn: () => window.vex.compaction.getPreparation({ sessionId }),
    staleTime: STALE_MS,
    enabled: sessionId.length > 0,
    refetchInterval: PREPARATION_FALLBACK_POLL_MS,
  });
}

export function usePreparation(
  sessionId: string | null,
): UseQueryResult<Result<CompactionPreparationResult>> {
  return useQuery(preparationOptions(sessionId ?? ""));
}

/**
 * Subscribe the active session to the preparation event spine. Pure side
 * effect — mount ONCE per active session, alongside the compaction chip's own
 * live sync. Foreign-session events are ignored; the payload is never used to
 * reconstruct state, only to invalidate.
 */
export function usePreparationLiveSync(sessionId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (sessionId === null || sessionId.length === 0) return;

    const off = window.vex.engine.onCompactionPreparation((event) => {
      if (event.sessionId !== sessionId) return;
      void queryClient.invalidateQueries({
        queryKey: compactionKeys.preparation(sessionId),
      });
    });

    const intervalId = window.setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: compactionKeys.preparation(sessionId),
      });
    }, PREPARATION_FALLBACK_POLL_MS);

    return () => {
      off();
      window.clearInterval(intervalId);
    };
  }, [sessionId, queryClient]);
}

/**
 * Queue the prepared cutover. `retry: false` — the button IS the retry, and a
 * financial-adjacent state transition is never auto-replayed. On success it
 * invalidates the preparation row and the session's runtime state (the queued
 * request changes what the next boundary will do).
 */
export function useRequestCompactionApply(): UseMutationResult<
  Result<CompactionApplyRequestResult>,
  Error,
  CompactionApplyRequestInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CompactionApplyRequestInput) =>
      window.vex.compaction.requestApply(input),
    retry: false,
    onSuccess: (result, variables) => {
      if (!result.ok) return;
      void queryClient.invalidateQueries({
        queryKey: compactionKeys.preparation(variables.sessionId),
      });
      void queryClient.invalidateQueries({
        queryKey: runtimeKeys.state(variables.sessionId),
      });
    },
  });
}
