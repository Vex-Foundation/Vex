/**
 * Vex Studio host status (stage B0) - the renderer's read adapter.
 *
 * Event-driven, exactly like `useVexMarket`: main owns the host and pushes
 * every transition, so the query is only the FIRST read and never polls or
 * retries. `staleTime: Infinity` because a status is a level, not a sample -
 * refetching it would only re-ask a question the subscription already answers.
 *
 * There are no UI components here. Stage B0 lands the contract; the Studio-mode
 * surfaces that render this are B4.
 */

import { useEffect } from "react";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { StudioHostStatus } from "@shared/schemas/studio.js";
import { studioKeys } from "./queryKeys.js";

type HostStatusResult = Result<StudioHostStatus>;

/**
 * Initial host-status read + live-sync. Mount once where the Studio indicator
 * lives; the effect's cleanup unsubscribes.
 */
export function useStudioHostStatus(): UseQueryResult<HostStatusResult> {
  const queryClient = useQueryClient();

  useEffect(() => {
    const off = window.vex.studio.onHostStatus((status) => {
      queryClient.setQueryData<HostStatusResult>(studioKeys.hostStatus(), {
        ok: true,
        data: status,
      });
    });
    return () => off();
  }, [queryClient]);

  return useQuery({
    queryKey: studioKeys.hostStatus(),
    queryFn: () => window.vex.studio.getHostStatus(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
  });
}
