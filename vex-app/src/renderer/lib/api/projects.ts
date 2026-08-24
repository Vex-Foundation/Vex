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
  ProjectGetResult,
  ProjectList,
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
      queryClient.setQueryData(
        projectKeys.detail(result.data.id),
        { ok: true, data: result.data } satisfies Result<ProjectGetResult>,
      );
      void queryClient.invalidateQueries({ queryKey: projectKeys.list() });
    },
  });
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
      queryClient.setQueryData(
        projectKeys.detail(result.data.id),
        { ok: true, data: result.data } satisfies Result<ProjectGetResult>,
      );
      void queryClient.invalidateQueries({ queryKey: projectKeys.list() });
    },
  });
}
