/**
 * TanStack Query hooks over `vex.system.*` IPC. The async source of
 * truth for the System Check screen.
 */

import { queryOptions, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { HealthReport, OsInfo, NetworkProbe, RuntimeInfo } from "@shared/schemas/system.js";
import { systemKeys } from "./queryKeys.js";

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

/** Fixed for the process's lifetime (decided once at boot), so never stale. */
export function useRuntimeInfo(): UseQueryResult<Result<RuntimeInfo>> {
  return useQuery({
    queryKey: systemKeys.runtime(),
    queryFn: () => window.vex.system.runtime(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
