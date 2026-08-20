/**
 * Frame-throttled scheduling for non-essential visual updates, plus the value
 * form the stream preview uses: a snapshot that trails its source by at most
 * `intervalFrames` frames, with the trailing edge guaranteed (the last
 * scheduled frame always applies the latest value, so the snapshot can never
 * settle stale).
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";

const DEFAULT_INTERVAL_FRAMES = 3;

/**
 * Stable scheduler that coalesces visual updates over a frame interval:
 * calls during the wait are absorbed, and the update runs once with whatever
 * state is current when the interval elapses.
 */
export function useThrottledVisualUpdate(
  update: () => void,
  intervalFrames: number = DEFAULT_INTERVAL_FRAMES,
): () => void {
  const updateRef = useRef(update);
  updateRef.current = update;
  const pendingFrameRef = useRef<number | null>(null);

  useLayoutEffect(
    () => () => {
      if (pendingFrameRef.current === null) return;
      cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
    },
    [],
  );

  return useCallback(() => {
    if (pendingFrameRef.current !== null) return;
    let remainingFrames = intervalFrames;
    const advance = (): void => {
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        pendingFrameRef.current = requestAnimationFrame(advance);
        return;
      }
      pendingFrameRef.current = null;
      updateRef.current();
    };
    pendingFrameRef.current = requestAnimationFrame(advance);
  }, [intervalFrames]);
}

/**
 * The latest value, re-rendered at most once per `intervalFrames` frames.
 * A changed value schedules one throttled commit; the commit reads the
 * CURRENT value, so intermediate values are skipped, never queued.
 */
export function useFrameThrottledValue<T>(
  value: T,
  intervalFrames: number = DEFAULT_INTERVAL_FRAMES,
): T {
  const [snapshot, setSnapshot] = useState(value);
  const latestRef = useRef(value);
  latestRef.current = value;
  const schedule = useThrottledVisualUpdate(
    useCallback(() => {
      setSnapshot(latestRef.current);
    }, []),
    intervalFrames,
  );
  if (value !== snapshot) schedule();
  return snapshot;
}
