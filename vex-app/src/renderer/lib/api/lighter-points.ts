/**
 * The renderer's owner of the Lighter points read: one request at a time, with
 * a REQUEST IDENTITY so a slow first answer can never overwrite a newer one.
 *
 * Deliberately not a react-query hook. This read is on-demand (open the
 * section, press Refresh), takes seconds against a live provider, and must be
 * cancelled on unmount and on the next press - a cache keyed only by "settings,
 * lighterPoints" would hand a stale board to whoever mounted next, and the
 * points are a live campaign number rather than cacheable configuration.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { VexError } from "@shared/ipc/result.js";
import type { LighterPointsResult } from "@shared/schemas/lighter-points.js";

export type LighterPointsViewState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly result: LighterPointsResult }
  /**
   * `error` is null only for a rejected invocation - the bridge itself failing
   * rather than the handler answering. There is no VexError to show then, and
   * inventing a correlation id would be a lie about a log entry that does not
   * exist.
   */
  | { readonly kind: "failed"; readonly error: VexError | null };

export interface LighterPointsView {
  readonly state: LighterPointsViewState;
  /** True while a newer read is in flight over an already-rendered result. */
  readonly refreshing: boolean;
  readonly refresh: () => void;
}

/**
 * Runs one read on mount and one per `refresh()`. Every read carries a
 * monotonic id checked AT PUBLICATION, and the previous read is cancelled
 * before a new one starts, so the surface shows the latest answer or nothing.
 */
export function useLighterPoints(): LighterPointsView {
  const [state, setState] = useState<LighterPointsViewState>({ kind: "idle" });
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);
  const inFlight = useRef<(() => void) | null>(null);
  const mounted = useRef(true);

  const start = useCallback(() => {
    inFlight.current?.();
    const id = requestId.current + 1;
    requestId.current = id;
    setState((previous) => (previous.kind === "ready" ? previous : { kind: "loading" }));
    setRefreshing(true);
    const invocation = window.vex.settings.lighterPoints();
    inFlight.current = invocation.cancel;
    void invocation.promise
      .then((result) => {
        // Publication guard: a superseded or unmounted read publishes nothing.
        if (!mounted.current || requestId.current !== id) return;
        inFlight.current = null;
        setRefreshing(false);
        setState(result.ok ? { kind: "ready", result: result.data } : { kind: "failed", error: result.error });
      })
      .catch(() => {
        if (!mounted.current || requestId.current !== id) return;
        inFlight.current = null;
        setRefreshing(false);
        setState({ kind: "failed", error: null });
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    start();
    return () => {
      mounted.current = false;
      // Navigating away cancels the read; main stops between wallets.
      inFlight.current?.();
      inFlight.current = null;
    };
  }, [start]);

  return { state, refreshing, refresh: start };
}
