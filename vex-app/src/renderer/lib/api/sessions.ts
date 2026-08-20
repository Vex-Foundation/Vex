/**
 * Sessions TanStack Query hooks (M12 multi-session shell).
 *
 * `useSessionsList` is the sidebar's primary read; its query key matches
 * `sessionKeys.list()` so a successful `useCreateSession` invalidates the
 * sidebar atomically. `useSession(id)` is the per-session detail read,
 * keyed independently so opening a session in the panel doesn't refetch
 * the whole list.
 *
 * Mutation `onSuccess` invalidates the list AND seeds the detail cache
 * with the freshly-created row — the panel can render mission-mode
 * metadata immediately without an extra IPC roundtrip.
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
  SessionBranchInput,
  SessionBranchResult,
  SessionCreateInput,
  SessionCreateResult,
  SessionDeleteInput,
  SessionDeleteResult,
  SessionExportMarkdownInput,
  SessionExportMarkdownResult,
  SessionList,
  SessionListItem,
  SessionModelDto,
  SessionSetPinnedInput,
  SessionSetPinnedResult,
  SessionRenameInput,
  SessionRenameResult,
} from "@shared/schemas/sessions.js";
import type {
  PlanGetResult,
  PlanSetEnabledInput,
  PlanSetEnabledResult,
  PlanAcceptInput,
  PlanAcceptResult,
} from "@shared/schemas/session-plan.js";
import { sessionModelKeys } from "./queryKeys.js";
import { useUiStore } from "../../stores/uiStore.js";

export const sessionKeys = {
  all: ["sessions"] as const,
  list: () => ["sessions", "list"] as const,
  detail: (id: string) => ["sessions", "detail", id] as const,
  plan: (id: string) => ["sessions", "plan", id] as const,
};

function sessionsListOptions() {
  return queryOptions({
    queryKey: sessionKeys.list(),
    queryFn: () => window.vex.sessions.list(),
    staleTime: 5_000,
  });
}

function sessionDetailOptions(id: string) {
  return queryOptions({
    queryKey: sessionKeys.detail(id),
    queryFn: () => window.vex.sessions.get({ id }),
    staleTime: 5_000,
    enabled: id.length > 0,
  });
}

export function useSessionsList(): UseQueryResult<Result<SessionList>> {
  return useQuery(sessionsListOptions());
}

export function useSession(
  id: string | null,
): UseQueryResult<Result<SessionListItem | null>> {
  // `enabled: false` when id is null keeps the hook order stable while
  // still letting us early-skip the IPC when nothing is selected.
  return useQuery({
    ...sessionDetailOptions(id ?? ""),
    enabled: id !== null && id.length > 0,
  });
}

export function useCreateSession(): UseMutationResult<
  Result<SessionCreateResult>,
  Error,
  SessionCreateInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SessionCreateInput) =>
      window.vex.sessions.create(input),
    onSuccess: (result) => {
      if (!result.ok) return;
      // Seed detail cache with the canonical row — panel opens
      // without a round-trip.
      queryClient.setQueryData(
        sessionKeys.detail(result.data.id),
        { ok: true, data: result.data } satisfies Result<SessionListItem>,
      );
      // List query gets invalidated so the sidebar re-fetches in order
      // (pinned-first then started_at DESC).
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

/**
 * Pin/unpin a session. The DB helper returns a canonical `SessionListItem`
 * with `missionStatus` already enriched, so seeding the detail cache is
 * safe — no risk of wiping an active mission status with `null`.
 *
 * List invalidation fires every time so the sidebar re-sorts (pinned
 * rows surface in the new Pinned bucket and disappear from time buckets).
 */
export function useSetSessionPinned(): UseMutationResult<
  Result<SessionSetPinnedResult>,
  Error,
  SessionSetPinnedInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SessionSetPinnedInput) =>
      window.vex.sessions.setPinned(input),
    onSuccess: (result) => {
      if (!result.ok) return;
      if (result.data !== null) {
        queryClient.setQueryData(
          sessionKeys.detail(result.data.id),
          { ok: true, data: result.data } satisfies Result<SessionListItem>,
        );
      }
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

/**
 * Rename a session via main (`vex.sessions.rename`). Mirrors the pin
 * mutation's cache behavior: a returned row refreshes the detail cache, a
 * `null` (stale id) just falls through to the list invalidation.
 */
export function useRenameSession(): UseMutationResult<
  Result<SessionRenameResult>,
  Error,
  SessionRenameInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SessionRenameInput) =>
      window.vex.sessions.rename(input),
    onSuccess: (result) => {
      if (!result.ok) return;
      if (result.data !== null) {
        queryClient.setQueryData(
          sessionKeys.detail(result.data.id),
          { ok: true, data: result.data } satisfies Result<SessionListItem>,
        );
      }
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

/**
 * Fork a session at a message (A14). `retry: false` is contract, not
 * preference: each successful call creates a NEW session, so an auto-retry
 * after an ambiguous transport failure could mint duplicates. On
 * `created`, cache handling mirrors `useCreateSession`; blocked outcomes
 * change nothing and are surfaced by the caller.
 */
export function useBranchSession(): UseMutationResult<
  Result<SessionBranchResult>,
  Error,
  SessionBranchInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SessionBranchInput) =>
      window.vex.sessions.branch(input),
    retry: false,
    onSuccess: (result) => {
      if (!result.ok || result.data.outcome !== "created") return;
      const session = result.data.session;
      queryClient.setQueryData(
        sessionKeys.detail(session.id),
        { ok: true, data: session } satisfies Result<SessionListItem>,
      );
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

/**
 * Terminal hidden outcomes — the session is no longer reachable from
 * the app. The hook cleans detail cache, invalidates the list, and
 * clears `activeSessionId` if it matches the deleted id. Blocked /
 * state_changed outcomes leave everything intact so the dialog can
 * surface actionable copy and the user can retry.
 */
const TERMINAL_DELETE_OUTCOMES = new Set<SessionDeleteResult["outcome"]>([
  "removed",
  "not_found",
  "already_removed",
]);

/**
 * Soft-delete a session via main. Main fails closed when a mission run
 * is active/paused or an approval is pending — the discriminated
 * `outcome` tells callers what happened so the confirmation dialog can
 * either close (terminal outcomes) or surface a blocked-state message
 * with a retry path.
 */
export function useDeleteSession(): UseMutationResult<
  Result<SessionDeleteResult>,
  Error,
  SessionDeleteInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SessionDeleteInput) =>
      window.vex.sessions.delete(input),
    onSuccess: (result, variables) => {
      if (!result.ok) return;
      if (!TERMINAL_DELETE_OUTCOMES.has(result.data.outcome)) return;
      queryClient.removeQueries({
        queryKey: sessionKeys.detail(variables.id),
      });
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
      if (useUiStore.getState().activeSessionId === variables.id) {
        useUiStore.getState().setActiveSessionId(null);
      }
    },
  });
}

/**
 * Export the session as a Markdown transcript. Main owns the native save
 * dialog and the destination path — this hook never sees or caches a path,
 * only the `saved | cancelled` outcome. No cache invalidation: the export
 * does not change any session state the sidebar/detail queries depend on.
 */
export function useExportSessionMarkdown(): UseMutationResult<
  Result<SessionExportMarkdownResult>,
  Error,
  SessionExportMarkdownInput
> {
  return useMutation({
    mutationFn: (input: SessionExportMarkdownInput) =>
      window.vex.sessions.exportMarkdown(input),
    retry: false,
  });
}

// ── Global runtime model (read-only) ─────────────────────────────────────
//
// `useSessionModel` reports the global model the engine resolves from
// `AGENT_PROVIDER`/`AGENT_MODEL` (source: `"global_default"` vs.
// `"unconfigured"`). Vex uses one global model for every session — there
// is no per-session model write.

const SESSION_MODEL_STALE_MS = 30_000;

function sessionModelOptions(sessionId: string) {
  return queryOptions({
    queryKey: sessionModelKeys.detail(sessionId),
    queryFn: () => window.vex.sessions.getModel({ sessionId }),
    staleTime: SESSION_MODEL_STALE_MS,
    enabled: sessionId.length > 0,
  });
}

export function useSessionModel(
  sessionId: string | null,
): UseQueryResult<Result<SessionModelDto>> {
  return useQuery(sessionModelOptions(sessionId ?? ""));
}

// ── Plan mode (session-scoped) ───────────────────────────────────────────
//
// `useSessionPlan` reads the plan-mode state for a session (null when never
// used). `useSetPlanMode` / `useAcceptPlan` are invalidate-based (no optimistic
// write): the control reflects whatever the plan refetch reports, so a server
// refusal cleanly snaps back. `useAcceptPlan` also invalidates the session
// detail (its run status may flip from paused_plan_acceptance to running).

const SESSION_PLAN_STALE_MS = 5_000;

export function useSessionPlan(
  sessionId: string | null,
): UseQueryResult<Result<PlanGetResult>> {
  return useQuery(
    queryOptions({
      queryKey: sessionKeys.plan(sessionId ?? ""),
      queryFn: () => window.vex.sessions.plan.get({ sessionId: sessionId ?? "" }),
      staleTime: SESSION_PLAN_STALE_MS,
      enabled: (sessionId?.length ?? 0) > 0,
    }),
  );
}

export function useSetPlanMode(): UseMutationResult<
  Result<PlanSetEnabledResult>,
  Error,
  PlanSetEnabledInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.sessions.plan.setEnabled(input),
    retry: false,
    onSettled: (_result, _error, input) => {
      void qc.invalidateQueries({ queryKey: sessionKeys.plan(input.sessionId) });
    },
  });
}

export function useAcceptPlan(): UseMutationResult<
  Result<PlanAcceptResult>,
  Error,
  PlanAcceptInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.sessions.plan.accept(input),
    retry: false,
    onSettled: (_result, _error, input) => {
      void qc.invalidateQueries({ queryKey: sessionKeys.plan(input.sessionId) });
      // Accept may resume a paused_plan_acceptance run → refresh session detail.
      void qc.invalidateQueries({ queryKey: sessionKeys.detail(input.sessionId) });
    },
  });
}
