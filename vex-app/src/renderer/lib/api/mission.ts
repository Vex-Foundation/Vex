/**
 * Mission TanStack hooks (puzzle 04 phase 6).
 *
 * Per-command typed mutations + onSuccess invalidation:
 *
 *   - `missionKeys.draft` invalidates on every mutation that may
 *     change the mission row (acceptContract, start, continue,
 *     recover, edit, renew, setAutoRetry, stop)
 *   - `missionKeys.diff` invalidates on acceptContract / start
 *   - `runtimeKeys.state` invalidates on start / continue / recover /
 *     stop (runtime control state changes)
 *
 * `useMissionDiff` query reader follows the same staleTime as
 * `useMissionDraft`.
 *
 * `useMissionLiveSync` (mission review-&-accept bar) keeps the draft + diff
 * queries fresh the same way `useTranscriptLiveSync`/`useUsageLiveSync` do:
 * event-driven invalidation on `engine.transcriptAppend` plus a 30s fallback
 * poll, so a dropped IPC event can never strand the review bar invisible.
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
  MissionAcceptContractInput,
  MissionAcceptContractResult,
  MissionContinueInput,
  MissionContinueResult,
  MissionGetDiffInput,
  MissionGetDiffResult,
  MissionGetDraftResult,
  MissionGetRenewableSourceResult,
  MissionRecoverInput,
  MissionRecoverResult,
  MissionRenewInput,
  MissionRenewResult,
  MissionEditInput,
  MissionEditResult,
  MissionRetryInput,
  MissionRetryResult,
  MissionSetAutoRetryInput,
  MissionSetAutoRetryResult,
  MissionStartInput,
  MissionStartResult,
  MissionRestartWithInstructionInput,
  MissionRestartWithInstructionResult,
  MissionStopInput,
  MissionStopResult,
} from "@shared/schemas/mission.js";
import {
  approvalsKeys,
  missionKeys,
  runtimeKeys,
} from "./queryKeys.js";

const STALE_MS = 5_000;

// ── Queries (read-only) ─────────────────────────────────────────

function draftOptions(sessionId: string) {
  return queryOptions({
    queryKey: missionKeys.draft(sessionId),
    queryFn: () => window.vex.mission.getDraft({ sessionId }),
    staleTime: STALE_MS,
    enabled: sessionId.length > 0,
  });
}

export function useMissionDraft(
  sessionId: string | null,
): UseQueryResult<Result<MissionGetDraftResult>> {
  return useQuery(draftOptions(sessionId ?? ""));
}

function diffOptions(input: { sessionId: string; missionId: string }) {
  return queryOptions({
    queryKey: missionKeys.diff(input.sessionId, input.missionId),
    queryFn: () =>
      window.vex.mission.getDiff({
        sessionId: input.sessionId,
        missionId: input.missionId,
      }),
    staleTime: STALE_MS,
    enabled: input.sessionId.length > 0 && input.missionId.length > 0,
  });
}

export function useMissionDiff(
  sessionId: string | null,
  missionId: string | null,
): UseQueryResult<Result<MissionGetDiffResult>> {
  return useQuery(diffOptions({
    sessionId: sessionId ?? "",
    missionId: missionId ?? "",
  }));
}

/**
 * Phase 7 — resolve the latest terminal accepted mission for
 * `/mission-renew`. Returns `{ missionId }` when one exists, `null`
 * otherwise. Renderer calls this before dispatching `useMissionRenew`.
 */
function renewableSourceOptions(sessionId: string) {
  return queryOptions({
    queryKey: missionKeys.renewableSource(sessionId),
    queryFn: () => window.vex.mission.getRenewableSource({ sessionId }),
    staleTime: STALE_MS,
    enabled: sessionId.length > 0,
  });
}

export function useRenewableMissionSource(
  sessionId: string | null,
): UseQueryResult<Result<MissionGetRenewableSourceResult>> {
  return useQuery(renewableSourceOptions(sessionId ?? ""));
}

/**
 * Fallback invalidation cadence for the mission draft/diff queries.
 *
 * Slowed 30s → 60s because `useMissionUpdateLiveSync` now pushes the same
 * invalidation the moment the mission row commits. This is no longer the path
 * that makes the review bar appear — it is the safety net for an event that
 * never arrived (dropped at the preload Zod gate, fired before the hook
 * subscribed, lost across a window lifecycle edge). It is deliberately NOT
 * deleted: without it a dropped event strands the review bar invisible with no
 * way back. Exported for tests.
 */
export const MISSION_LIVE_FALLBACK_POLL_MS = 60_000;

/**
 * Keep a mission session's draft + diff queries fresh so the review-&-accept
 * bar (and the MISSION badge) can never be stranded by a dropped
 * `transcriptAppend` event: the agent's draft patches land via the same
 * transcript writes the transcript/usage live-sync hooks already key off, so
 * this mounts the identical two-layer refresh — event-driven invalidation +
 * a 30s fallback poll. Pure side effect — mount once per active mission
 * session (in `MissionControls`).
 */
export function useMissionLiveSync(sessionId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (sessionId === null || sessionId.length === 0) return;

    const invalidate = (): void => {
      void queryClient.invalidateQueries({
        queryKey: missionKeys.draft(sessionId),
      });
      void queryClient.invalidateQueries({
        queryKey: missionKeys.diffsForSession(sessionId),
      });
    };

    const off = window.vex.engine.onTranscriptAppend((event) => {
      if (event.sessionId !== sessionId) return;
      invalidate();
    });

    const intervalId = window.setInterval(invalidate, MISSION_LIVE_FALLBACK_POLL_MS);

    return () => {
      off();
      window.clearInterval(intervalId);
    };
  }, [sessionId, queryClient]);
}

/**
 * Subscribe a session to `EV.engine.missionUpdate` — the push that replaces
 * poll latency on the two affordances the user notices most: "Start mission"
 * appearing after acceptance, and a new approval card appearing after the
 * agent asks for one.
 *
 * WHERE THIS MOUNTS, AND WHY NOT IN `MissionControls`. `useMissionLiveSync`
 * lives inside mission-gated `MissionControls`, so an agent (non-mission)
 * session never mounts it — and an agent session is exactly where a chat
 * approval gets enqueued. This hook therefore mounts in `SessionPanel`
 * alongside `useControlStateLiveSync`, which is rendered for every active
 * session regardless of kind.
 *
 * Invalidation is split by `kind` so a consumer that only cares about
 * approvals does not refetch a draft on every model patch:
 *   - `approval_enqueued` → the session's pending list ONLY. The app-wide
 *     inbox is NOT invalidated here: this hook drops foreign-session events
 *     (its keys are session-scoped), so it structurally cannot serve a
 *     background session's approval. That job belongs to the session-agnostic
 *     `useGlobalApprovalsLiveSync`, which owns `pendingAll`.
 *   - everything else → the draft + the session's diff prefix, which is what
 *     the contract card and the review bar read.
 *
 * The engine emits only AFTER the producing transaction commits, so a refetch
 * triggered here can never race ahead of the row it is going to read.
 */
export function useMissionUpdateLiveSync(sessionId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (sessionId === null || sessionId.length === 0) return;

    const off = window.vex.engine.onMissionUpdate((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.kind === "approval_enqueued") {
        void queryClient.invalidateQueries({
          queryKey: approvalsKeys.pending(sessionId),
        });
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: missionKeys.draft(sessionId),
      });
      void queryClient.invalidateQueries({
        queryKey: missionKeys.diffsForSession(sessionId),
      });
    });

    return off;
  }, [sessionId, queryClient]);
}

// ── Mutations ───────────────────────────────────────────────────

export function useAcceptMissionContract(): UseMutationResult<
  Result<MissionAcceptContractResult>,
  Error,
  MissionAcceptContractInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.mission.acceptContract(input),
    retry: false,
    onSuccess: (_result, input) => {
      qc.invalidateQueries({ queryKey: missionKeys.draft(input.sessionId) });
      qc.invalidateQueries({
        queryKey: missionKeys.diff(input.sessionId, input.missionId),
      });
    },
  });
}

/**
 * Phase 4d-5 — host-only auto-retry opt-in toggle. Persists
 * `constraints_json.autoRetryEnabled` for a draft/ready mission.
 *
 * Invalidate-based (no optimistic write): the toggle reflects whatever
 * the draft refetch reports, so a server refusal (blocked_permission /
 * blocked_status / not_found) — or a transport error — cleanly snaps the
 * control back to the persisted value. `onSettled` covers both the
 * resolved-outcome and thrown-error paths. The engine is the authority;
 * the card hides the toggle for non-full sessions (UX only).
 */
export function useSetAutoRetry(): UseMutationResult<
  Result<MissionSetAutoRetryResult>,
  Error,
  MissionSetAutoRetryInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.mission.setAutoRetry(input),
    retry: false,
    onSettled: (_result, _error, input) => {
      qc.invalidateQueries({ queryKey: missionKeys.draft(input.sessionId) });
    },
  });
}

export function useMissionGetDiff(): UseMutationResult<
  Result<MissionGetDiffResult>,
  Error,
  MissionGetDiffInput
> {
  return useMutation({
    mutationFn: (input) => window.vex.mission.getDiff(input),
    retry: false,
  });
}

export function useMissionStart(): UseMutationResult<
  Result<MissionStartResult>,
  Error,
  MissionStartInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.mission.start(input),
    retry: false,
    onSuccess: (_result, input) => {
      qc.invalidateQueries({ queryKey: missionKeys.draft(input.sessionId) });
      qc.invalidateQueries({
        queryKey: missionKeys.diff(input.sessionId, input.missionId),
      });
      qc.invalidateQueries({ queryKey: runtimeKeys.state(input.sessionId) });
      // Start lifts the source mission OUT of terminal-latest state, so
      // its renewable status changes. Invalidate so `/mission-renew`
      // re-evaluates from the new mission_runs state.
      qc.invalidateQueries({
        queryKey: missionKeys.renewableSource(input.sessionId),
      });
    },
  });
}

export function useMissionContinue(): UseMutationResult<
  Result<MissionContinueResult>,
  Error,
  MissionContinueInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.mission.continue(input),
    retry: false,
    onSuccess: (_result, input) => {
      qc.invalidateQueries({ queryKey: runtimeKeys.state(input.sessionId) });
    },
  });
}

/**
 * Recover-after-error: claims + resumes a `paused_error` mission run (the
 * "Recover" button). Distinct from continue (paused_user/wake) and from
 * recover-from-failed (new run). Invalidates runtime state on success.
 */
export function useMissionRetry(): UseMutationResult<
  Result<MissionRetryResult>,
  Error,
  MissionRetryInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.mission.retry(input),
    retry: false,
    onSuccess: (_result, input) => {
      qc.invalidateQueries({ queryKey: runtimeKeys.state(input.sessionId) });
    },
  });
}

/**
 * Stop the active run to edit the mission: the run terminates and the mission
 * returns to `draft`, so the next user turn collaboratively edits the contract
 * (setup prompt + mission_draft_update). Invalidates draft + runtime state +
 * renewable-source (the run becomes terminal-stopped → renew eligibility shifts).
 */
export function useEditMission(): UseMutationResult<
  Result<MissionEditResult>,
  Error,
  MissionEditInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.mission.edit(input),
    retry: false,
    onSuccess: (_result, input) => {
      qc.invalidateQueries({ queryKey: missionKeys.draft(input.sessionId) });
      qc.invalidateQueries({ queryKey: runtimeKeys.state(input.sessionId) });
      qc.invalidateQueries({
        queryKey: missionKeys.renewableSource(input.sessionId),
      });
    },
  });
}

export function useMissionRecover(): UseMutationResult<
  Result<MissionRecoverResult>,
  Error,
  MissionRecoverInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.mission.recover(input),
    retry: false,
    onSuccess: (_result, input) => {
      qc.invalidateQueries({ queryKey: missionKeys.draft(input.sessionId) });
      qc.invalidateQueries({ queryKey: runtimeKeys.state(input.sessionId) });
      // Recover replaces the latest mission_run, so source eligibility
      // for `/mission-renew` may shift (terminal latest run is gone).
      qc.invalidateQueries({
        queryKey: missionKeys.renewableSource(input.sessionId),
      });
    },
  });
}

export function useMissionRenew(): UseMutationResult<
  Result<MissionRenewResult>,
  Error,
  MissionRenewInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.mission.renew(input),
    retry: false,
    onSuccess: (_result, input) => {
      // Renew creates a NEW draft row (different missionId). Invalidate
      // both draft (so the new row shows) and diff (so the old card
      // refreshes against the new mission id when it eventually picks
      // the new draft).
      qc.invalidateQueries({ queryKey: missionKeys.draft(input.sessionId) });
      qc.invalidateQueries({ queryKey: missionKeys.all });
    },
  });
}

export function useMissionStop(): UseMutationResult<
  Result<MissionStopResult>,
  Error,
  MissionStopInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.mission.stop(input),
    retry: false,
    onSuccess: (_result, input) => {
      qc.invalidateQueries({ queryKey: runtimeKeys.state(input.sessionId) });
      // Stop flips the latest mission_run terminal → mission becomes
      // a renewable source candidate (or stops being one if the new
      // terminal is `cancelled` rather than `completed`). Invalidate.
      qc.invalidateQueries({
        queryKey: missionKeys.renewableSource(input.sessionId),
      });
    },
  });
}

/**
 * Post-stop restart with a redirection instruction.
 *
 * A NEW run against the SAME accepted contract, so the invalidation set is the
 * one `useMissionStart` uses plus `renewableSource`: the previous terminal run
 * stops being the renew candidate the moment a new run exists, and leaving it
 * cached is what makes a "Renew mission" button linger next to a running
 * mission.
 */
export function useMissionRestartWithInstruction(): UseMutationResult<
  Result<MissionRestartWithInstructionResult>,
  Error,
  MissionRestartWithInstructionInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.mission.restartWithInstruction(input),
    retry: false,
    onSuccess: (_result, input) => {
      qc.invalidateQueries({ queryKey: runtimeKeys.state(input.sessionId) });
      qc.invalidateQueries({ queryKey: missionKeys.draft(input.sessionId) });
      qc.invalidateQueries({
        queryKey: missionKeys.renewableSource(input.sessionId),
      });
    },
  });
}
