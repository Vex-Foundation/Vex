/**
 * TanStack Query hooks over `vex.docker.*` IPC.
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
  ComposeUpResult,
  DockerStatus,
  InstallMethod,
  InstallResult,
  StartResult,
  StopPreviousInstallStacksResult,
} from "@shared/schemas/docker.js";
import { dockerKeys } from "./queryKeys.js";

export function dockerStatusOptions() {
  return queryOptions({
    queryKey: dockerKeys.status(),
    queryFn: () => window.vex.docker.detect(),
    // Detection runs CLI subprocesses (8s default timeout in main); refetch
    // on focus is intentional for the System Check screen but staleness is
    // longer than the default 5s to avoid thrashing.
    staleTime: 30_000,
  });
}

/**
 * `enabled: false` keeps the probe from running at all: on the native runtime
 * nothing may touch the container engine (System Check passes it).
 */
export function useDockerStatus(options?: { readonly enabled?: boolean }): UseQueryResult<Result<DockerStatus>> {
  return useQuery({ ...dockerStatusOptions(), enabled: options?.enabled ?? true });
}

export function useDockerInstall(): UseMutationResult<
  Result<InstallResult>,
  Error,
  { readonly method: InstallMethod }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly method: InstallMethod }) =>
      window.vex.docker.install(input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: dockerKeys.all });
    },
  });
}

export function useDockerStart(): UseMutationResult<Result<StartResult>, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => window.vex.docker.start(),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: dockerKeys.all });
    },
  });
}

export function useComposeUp(): UseMutationResult<
  Result<ComposeUpResult>,
  Error,
  { readonly pgPort?: number }
> {
  return useMutation({
    mutationFn: (input: { readonly pgPort?: number } = {}) =>
      window.vex.docker.composeUp(input),
  });
}

export function useStopPreviousInstallStacks(): UseMutationResult<
  Result<StopPreviousInstallStacksResult>,
  Error,
  void
> {
  return useMutation({
    mutationFn: () => window.vex.docker.stopPreviousInstallStacks(),
  });
}
