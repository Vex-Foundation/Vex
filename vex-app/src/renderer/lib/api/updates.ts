/**
 * User-triggered updater (M13) data-access — TanStack Query hooks over the
 * `window.vex.updater.*` bridge.
 *
 * Layering: main owns electron-updater and pushes sanitized `UpdateStatus`
 * transitions; the renderer reads the initial value with `useUpdateStatus`,
 * keeps it live with `useUpdaterLiveSync` (event → cache), and triggers the
 * two-step flow (download, then restart) via the mutations below. The renderer
 * never touches updater internals — main decides whether each action is safe.
 */

import { useEffect } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  UpdateCancelled,
  UpdateRestarting,
  UpdateStarted,
  UpdateStatus,
} from "@shared/schemas/updater.js";
import { updaterKeys } from "./queryKeys.js";

/**
 * Initial status read. Event-driven (no polling, no retry); `useUpdaterLiveSync`
 * keeps the cache current after mount.
 */
export function useUpdateStatus(): UseQueryResult<Result<UpdateStatus>> {
  return useQuery({
    queryKey: updaterKeys.status(),
    queryFn: () => window.vex.updater.getStatus(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
  });
}

/**
 * Push main-emitted status transitions into the query cache. Mount ONCE near
 * the root (in `UpdateLayer`). The event stream is the source of truth for
 * transitions; the query is only the first read.
 */
export function useUpdaterLiveSync(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const off = window.vex.updater.onStatus((status) => {
      queryClient.setQueryData<Result<UpdateStatus>>(updaterKeys.status(), () => ({
        ok: true,
        data: status,
      }));
    });
    return () => off();
  }, [queryClient]);
}

export function useCheckForUpdates(): UseMutationResult<
  Result<UpdateStatus>,
  Error,
  void
> {
  return useMutation({ mutationFn: () => window.vex.updater.checkNow() });
}

export function useStartUpdate(): UseMutationResult<
  Result<UpdateStarted>,
  Error,
  void
> {
  return useMutation({ mutationFn: () => window.vex.updater.startUpdateNow() });
}

export function useCancelDownload(): UseMutationResult<
  Result<UpdateCancelled>,
  Error,
  void
> {
  return useMutation({ mutationFn: () => window.vex.updater.cancelDownload() });
}

export function useRestartAndInstall(): UseMutationResult<
  Result<UpdateRestarting>,
  Error,
  void
> {
  return useMutation({
    mutationFn: () => window.vex.updater.restartAndInstallNow(),
  });
}

/** Open the external release-notes page (main builds the URL). */
export function openReleaseNotes(): void {
  void window.vex.updater.openReleaseNotes();
}
