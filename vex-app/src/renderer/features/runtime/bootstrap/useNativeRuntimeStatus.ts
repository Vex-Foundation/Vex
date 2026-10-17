/**
 * The native runtime's start as main reports it. Subscribes BEFORE reading
 * the current status (nothing replays across IPC), and keeps whichever
 * status has the higher `seq`, so a status reply that crossed a newer event
 * in flight never moves the screen backwards. Null until the first arrives.
 */

import { useCallback, useEffect, useState } from "react";
import type { NativeRuntimeStatus } from "@shared/schemas/system.js";

export interface NativeRuntimeStatusHandle {
  readonly status: NativeRuntimeStatus | null;
  /** Ask main for another start; main ignores it unless the last one failed. */
  readonly retry: () => void;
}

export function useNativeRuntimeStatus(): NativeRuntimeStatusHandle {
  const [status, setStatus] = useState<NativeRuntimeStatus | null>(null);

  const apply = useCallback((next: NativeRuntimeStatus): void => {
    setStatus((prev) => (prev !== null && prev.seq >= next.seq ? prev : next));
  }, []);

  useEffect(() => {
    let live = true;
    const off = window.vex.system.onRuntimeProgress(apply);
    void window.vex.system.runtimeStatus().then((result) => {
      if (live && result.ok) apply(result.data);
    });
    return () => {
      live = false;
      off();
    };
  }, [apply]);

  const retry = useCallback((): void => {
    void window.vex.system.runtimeRetry().then((result) => {
      if (result.ok) apply(result.data);
    });
  }, [apply]);

  return { status, retry };
}
