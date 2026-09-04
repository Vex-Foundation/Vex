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
 *
 * `useStudioBridgeReadiness` (B1.6) lives here too, and it is the OPPOSITE
 * shape on purpose: a pull with no subscription, re-read on mount and on the
 * user's re-check. See its own note.
 */

import { useEffect } from "react";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { StudioBridgeReadiness } from "@shared/schemas/studio-bridge-readiness.js";
import type { StudioHostStatus } from "@shared/schemas/studio.js";
import { studioKeys } from "./queryKeys.js";

type HostStatusResult = Result<StudioHostStatus>;
type BridgeReadinessResult = Result<StudioBridgeReadiness>;

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

/**
 * Does this installation have a Studio bridge binary (B1.6)?
 *
 * NO SUBSCRIPTION, and that is a decision rather than a gap. The answer moves
 * only when somebody installs a toolchain or runs a build OUTSIDE Vex; main
 * observes neither, so a push channel would need a filesystem watcher and a
 * PATH watcher to publish a fact the user's own re-check already establishes.
 * Two honest triggers instead: mounting this hook (which happens on Studio
 * entry, because the welcome screen mounts it) and `refetch` from the panel's
 * re-check button.
 *
 * `staleTime: 0` so entering Studio after building the bridge shows the change
 * rather than a cached failure, and `retry: 0` because a failed read is a state
 * the panel RENDERS - with its own sentence and the same re-check button - not
 * something to silently paper over with attempts the user cannot see.
 */
export function useStudioBridgeReadiness(): UseQueryResult<BridgeReadinessResult> {
  return useQuery({
    queryKey: studioKeys.bridgeReadiness(),
    queryFn: () => window.vex.studio.getBridgeReadiness(),
    staleTime: 0,
    retry: 0,
  });
}
