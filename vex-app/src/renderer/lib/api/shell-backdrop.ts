/**
 * User backdrop TanStack Query hooks - the renderer half of the user's own
 * wallpaper under the glass shell.
 *
 * ONE QUERY, `shellBackdropKeys.current()`, read by the shell wall
 * (`ShellBackdrop.tsx`) and by the Settings row. The two never hold their own
 * copy: a pick or a clear resolves with the NEW record and writes it into
 * that one cache entry, so the wall repaints the instant the settings row
 * learns the answer, and nothing needs a second read.
 *
 * `staleTime: Infinity` is correct rather than lazy: the backdrop changes only
 * through this window's own pick/clear, both of which set the cache
 * explicitly. There is no background refetch and nothing to poll.
 *
 * `pick` takes no argument: main owns the file picker, so there is nothing
 * for the renderer to pass. A dismissed picker resolves OK with
 * `cancelled: true`, which callers absorb silently.
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
  ShellBackdropClearResult,
  ShellBackdropPickResult,
  ShellBackdropReadResult,
  ShellBackdropRecord,
} from "@shared/schemas/shell-backdrop.js";
import { shellBackdropKeys } from "./queryKeys.js";

function shellBackdropOptions() {
  return queryOptions({
    queryKey: shellBackdropKeys.current(),
    queryFn: () => window.vex.shellBackdrop.read(),
    staleTime: Infinity,
    retry: false,
  });
}

export function useShellBackdrop(): UseQueryResult<Result<ShellBackdropReadResult>> {
  return useQuery(shellBackdropOptions());
}

/**
 * The record a query result resolves to, or `null` for "shipped artwork":
 * a read that has not answered, a failed read, and an explicit `null` all
 * paint the default, because the shipped artwork is the fallback for every
 * state in which a custom image is not positively known.
 */
export function currentShellBackdrop(
  result: Result<ShellBackdropReadResult> | undefined,
): ShellBackdropRecord | null {
  if (result === undefined || !result.ok) return null;
  return result.data.backdrop;
}

/** Open main's file picker and install whatever the user chooses. */
export function usePickShellBackdrop(): UseMutationResult<
  Result<ShellBackdropPickResult>,
  Error,
  void
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => window.vex.shellBackdrop.pick(),
    onSuccess: (result) => {
      if (!result.ok) return;
      const next: Result<ShellBackdropReadResult> = {
        ok: true,
        data: { backdrop: result.data.backdrop },
      };
      queryClient.setQueryData(shellBackdropKeys.current(), next);
    },
  });
}

/** Return to the shipped artwork. */
export function useClearShellBackdrop(): UseMutationResult<
  Result<ShellBackdropClearResult>,
  Error,
  void
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => window.vex.shellBackdrop.clear(),
    onSuccess: (result) => {
      if (!result.ok) return;
      const next: Result<ShellBackdropReadResult> = { ok: true, data: { backdrop: null } };
      queryClient.setQueryData(shellBackdropKeys.current(), next);
    },
  });
}
