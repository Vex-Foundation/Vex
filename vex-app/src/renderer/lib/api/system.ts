/**
 * TanStack Query hooks over `vex.system.*` IPC. The async source of
 * truth for the System Check screen.
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
  RuntimeMigrationRemoveOldDataResult,
  RuntimeMigrationStatus,
} from "@shared/schemas/runtime-migration.js";
import type {
  HealthReport,
  LOCAL_DATA_RESET_PHRASE,
  LocalRuntimeInfo,
  NetworkProbe,
  OsInfo,
  RuntimeInfo,
  RuntimeResetResult,
  RuntimeRestartResult,
} from "@shared/schemas/system.js";
import { systemKeys } from "./queryKeys.js";
import type { LocalRuntimeCheck } from "@shared/schemas/system.js";

export function systemHealthOptions() {
  return queryOptions({
    queryKey: systemKeys.health(),
    queryFn: () => window.vex.system.health(),
  });
}

export function osInfoOptions() {
  return queryOptions({
    queryKey: systemKeys.osInfo(),
    queryFn: () => window.vex.system.osInfo(),
  });
}

export function networkOptions() {
  return queryOptions({
    queryKey: systemKeys.network(),
    queryFn: () => window.vex.system.network(),
  });
}

export function useSystemHealth(): UseQueryResult<Result<HealthReport>> {
  return useQuery(systemHealthOptions());
}

export function useOsInfo(): UseQueryResult<Result<OsInfo>> {
  return useQuery(osInfoOptions());
}

export function useNetwork(): UseQueryResult<Result<NetworkProbe>> {
  return useQuery(networkOptions());
}

/**
 * System Check's native-runtime facts (bundle, disk, memory). Read-only in
 * main (it starts nothing); read fresh each time the screen mounts.
 */
export function useLocalRuntimeCheck(): UseQueryResult<Result<LocalRuntimeCheck>> {
  return useQuery({
    queryKey: systemKeys.localRuntimeCheck(),
    queryFn: () => window.vex.system.localRuntimeCheck(),
    staleTime: 0,
  });
}

/** Fixed for the process's lifetime (decided once at boot), so never stale. */
export function useRuntimeInfo(): UseQueryResult<Result<RuntimeInfo>> {
  return useQuery({
    queryKey: systemKeys.runtime(),
    queryFn: () => window.vex.system.runtime(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** True only once main has said it runs the bundled runtime. */
export function useIsNativeRuntime(): boolean {
  const query = useRuntimeInfo();
  return query.data?.ok === true && query.data.data.native;
}

/**
 * Settings "Local runtime": release, versions and data sizes. Sizes move as
 * the database grows, so every mount measures again.
 */
export function useLocalRuntimeInfo(): UseQueryResult<Result<LocalRuntimeInfo>> {
  return useQuery({
    queryKey: systemKeys.localRuntime(),
    queryFn: () => window.vex.system.runtimeInfo(),
    staleTime: 0,
  });
}

/** Stop and start the native runtime; the sizes are measured again after. */
export function useRestartLocalRuntime(): UseMutationResult<Result<RuntimeRestartResult>, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => window.vex.system.runtimeRestart(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: systemKeys.localRuntime() }),
  });
}

/**
 * Delete the local database; on `reset` main relaunches the app into setup.
 * Takes what the user TYPED: preload and main check it against the phrase
 * themselves, so a confirmation the dialog let through by mistake still stops.
 */
export function useResetLocalData(): UseMutationResult<Result<RuntimeResetResult>, Error, string> {
  return useMutation({
    mutationFn: (typed: string) =>
      window.vex.system.runtimeReset({ confirmation: typed as typeof LOCAL_DATA_RESET_PHRASE }),
  });
}

/**
 * Remove the previous release's data once the move completed. Takes
 * `allowWithoutImport`: true only after a start-fresh, when the dialog has
 * said that data is its only copy. The section is read again after, so a
 * recorded removal takes the row away.
 */
export function useRemovePreviousReleaseData(): UseMutationResult<
  Result<RuntimeMigrationRemoveOldDataResult>,
  Error,
  boolean
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (allowWithoutImport: boolean) =>
      window.vex.system.runtimeMigrationRemoveOldData({ allowWithoutImport }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: systemKeys.localRuntime() }),
  });
}

/**
 * Whether this install's data must be moved before the native runtime
 * starts. Read fresh: main re-detects while it is pending. Only asked on the
 * native runtime (`enabled`); elsewhere main answers not_needed anyway.
 */
export function useRuntimeMigrationStatus(enabled: boolean): UseQueryResult<Result<RuntimeMigrationStatus>> {
  return useQuery({
    queryKey: systemKeys.runtimeMigration(),
    queryFn: () => window.vex.system.runtimeMigrationStatus(),
    enabled,
    staleTime: 0,
  });
}
