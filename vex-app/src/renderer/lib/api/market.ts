/**
 * VEX market snapshot (T1) data-access — a TanStack Query hook over the
 * `window.vex.market.*` bridge.
 *
 * Layering mirrors the updater surface: main owns the external poll and pushes
 * sanitized `VexMarketSnapshot` broadcasts; the renderer reads the initial
 * value with `getVexSnapshot` and keeps it live via the `onVexUpdate`
 * subscription (event → cache). The event stream is the source of truth for
 * updates; the query is only the first read (so `null` — no poll yet — renders
 * a loading state, never an error).
 */

import { useEffect } from "react";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { VexMarketSnapshot } from "@shared/schemas/market.js";
import { marketKeys } from "./queryKeys.js";

type SnapshotResult = Result<VexMarketSnapshot | null>;

/**
 * Initial snapshot read + live-sync. Event-driven (no polling, no retry in the
 * renderer — main owns the poll). Mount once where the widget lives.
 */
export function useVexMarket(): UseQueryResult<SnapshotResult> {
  const queryClient = useQueryClient();

  useEffect(() => {
    const off = window.vex.market.onVexUpdate((snapshot) => {
      queryClient.setQueryData<SnapshotResult>(marketKeys.snapshot(), () => ({
        ok: true,
        data: snapshot,
      }));
    });
    return () => off();
  }, [queryClient]);

  return useQuery({
    queryKey: marketKeys.snapshot(),
    queryFn: () => window.vex.market.getVexSnapshot(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
  });
}
