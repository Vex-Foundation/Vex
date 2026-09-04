/**
 * Vex Studio projects TanStack Query hooks (stage P).
 *
 * Mirrors `sessions.ts`: one list query, one detail query keyed independently,
 * and mutations that seed the detail cache with the canonical row the handler
 * just persisted so a settings screen renders without a second roundtrip.
 *
 * No optimistic update, on purpose. A project create claims a directory and a
 * scope edit rewrites authority (permission, wallet selection); showing either
 * as done before main commits would show the user a state that may not exist.
 * Both mutations wait for the real Result, and `useUpdateProjectScope` in
 * particular MUST NOT be retried automatically - its `expectedScopeVersion` is
 * consumed by the attempt, so a blind retry would either be a no-op conflict or
 * re-apply a stale intent.
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
  ProjectCreateInput,
  ProjectCreateResult,
  ProjectDeleteInput,
  ProjectDeleteResult,
  ProjectGetResult,
  ProjectList,
  ProjectRenderEnvelope,
  ProjectRepairFilesInput,
  ProjectRepairFilesResult,
  ProjectUpdateScopeInput,
  ProjectUpdateScopeResult,
} from "@shared/schemas/projects.js";

export const projectKeys = {
  all: ["projects"] as const,
  list: () => ["projects", "list"] as const,
  detail: (id: string) => ["projects", "detail", id] as const,
};

function projectsListOptions() {
  return queryOptions({
    queryKey: projectKeys.list(),
    queryFn: () => window.vex.projects.list(),
    staleTime: 5_000,
  });
}

function projectDetailOptions(projectId: string) {
  return queryOptions({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => window.vex.projects.get({ projectId }),
    staleTime: 5_000,
    enabled: projectId.length > 0,
  });
}

export function useProjects(): UseQueryResult<Result<ProjectList>> {
  return useQuery(projectsListOptions());
}

export function useProject(
  projectId: string | null,
): UseQueryResult<Result<ProjectGetResult>> {
  // `enabled: false` when the id is null keeps hook order stable while still
  // skipping the IPC when nothing is selected.
  return useQuery({
    ...projectDetailOptions(projectId ?? ""),
    enabled: projectId !== null && projectId.length > 0,
  });
}

export function useCreateProject(): UseMutationResult<
  Result<ProjectCreateResult>,
  Error,
  ProjectCreateInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectCreateInput) => window.vex.projects.create(input),
    // Creating a project claims a directory on disk. A retried attempt is a
    // second claim, not a repeat of the first.
    retry: false,
    onSuccess: (result) => {
      if (!result.ok) return;
      cacheProjectFromEnvelope(queryClient, result.data);
    },
  });
}

/**
 * Seed the detail cache with the row a handler just persisted, and invalidate
 * the list.
 *
 * `refreshFailure` is the case this function exists for. Main returns the row
 * as it was COMMITTED when it could not read it back, so that row is real but
 * may already be behind - seeding it as though it were canonical would leave
 * every screen rendering a stale project until something else happened to
 * refetch. So the detail entry is invalidated instead of seeded, and the next
 * read comes from main.
 *
 * The render report itself is never cached, on any path: it describes ONE run,
 * not the state of anything, and the project's own `files` field already
 * carries the state a screen renders from.
 */
function cacheProjectFromEnvelope(
  queryClient: ReturnType<typeof useQueryClient>,
  envelope: ProjectRenderEnvelope,
): void {
  if (envelope.refreshFailure !== null) {
    void queryClient.invalidateQueries({
      queryKey: projectKeys.detail(envelope.project.id),
    });
    void queryClient.invalidateQueries({ queryKey: projectKeys.list() });
    return;
  }
  queryClient.setQueryData(
    projectKeys.detail(envelope.project.id),
    { ok: true, data: envelope.project } satisfies Result<ProjectGetResult>,
  );
  void queryClient.invalidateQueries({ queryKey: projectKeys.list() });
}

export function useUpdateProjectScope(): UseMutationResult<
  Result<ProjectUpdateScopeResult>,
  Error,
  ProjectUpdateScopeInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectUpdateScopeInput) =>
      window.vex.projects.updateScope(input),
    // The scope version is consumed by the attempt; a retry cannot reuse it.
    retry: false,
    onSuccess: (result) => {
      if (!result.ok) return;
      // The returned row already carries the incremented `scopeVersion`, so
      // seeding the detail cache is what lets the next edit send a fresh
      // expected version instead of a stale one.
      cacheProjectFromEnvelope(queryClient, result.data);
    },
  });
}

/**
 * Repair a project's Vex files.
 *
 * NOT retried automatically. Repair overwrites artifacts a human edited, so a
 * blind retry would repeat a destructive-to-someone's-edit action the user
 * asked for exactly once.
 */
export function useRepairProjectFiles(): UseMutationResult<
  Result<ProjectRepairFilesResult>,
  Error,
  ProjectRepairFilesInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectRepairFilesInput) =>
      window.vex.projects.repairFiles(input),
    retry: false,
    onSuccess: (result) => {
      if (!result.ok) return;
      cacheProjectFromEnvelope(queryClient, result.data);
    },
  });
}

/**
 * Delete a project (B0).
 *
 * NOT retried automatically, and this is the strongest case for that rule in
 * the file: the call tombstones authority, refuses live approvals, and can move
 * the user's folder to the trash. A blind second attempt is not a repeat of the
 * first - it lands on the tombstone the first one wrote and resumes its
 * cleanup, which is a different operation the user did not ask for twice.
 *
 * On success the detail cache entry is REMOVED rather than reseeded. Every
 * sibling mutation returns the canonical row it just persisted, so seeding is
 * the right answer there; this one returns an outcome and no project, and
 * leaving the old row cached would let a screen keep rendering a project Vex
 * has declared gone. The list is invalidated for the same reason.
 *
 * The cleanup report (`cleanup`, `trash`, `attempts`) is deliberately NOT
 * cached: it describes what ONE pass did, not the state of anything that still
 * exists, and the caller renders it from the mutation result. This mirrors how
 * `useUpdateProjectScope` and `useRepairProjectFiles` treat `render`.
 *
 * Removal happens for EVERY successful Result, including `blocked_active_calls`
 * and `not_found`. Those wrote nothing, but they are also the two answers that
 * prove the renderer's cached row is not to be trusted - one says work is in
 * flight, the other says the row is not what the cache thinks it is - so the
 * next read comes from main either way.
 */
export function useDeleteProject(): UseMutationResult<
  Result<ProjectDeleteResult>,
  Error,
  ProjectDeleteInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectDeleteInput) => window.vex.projects.delete(input),
    retry: false,
    onSuccess: (result, input) => {
      if (!result.ok) return;
      queryClient.removeQueries({ queryKey: projectKeys.detail(input.projectId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.list() });
    },
  });
}
