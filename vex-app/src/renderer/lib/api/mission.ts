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
 */

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
  MissionStopInput,
  MissionStopResult,
} from "@shared/schemas/mission.js";
import {
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
