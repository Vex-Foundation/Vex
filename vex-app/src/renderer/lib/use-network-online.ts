/**
 * Live network-connectivity flag for the connection banner (gap G10).
 *
 * The signal is the browser's own `navigator.onLine` + `online`/`offline`
 * window events - the same connectivity the engine's provider calls ride on.
 * There is no engine-level connection push channel today (the runtime is
 * in-process; only per-failure error events exist), so OS-level reachability
 * is the one real, live signal available without a new contract.
 */

import { useEffect, useState } from "react";

/** True while the OS reports network connectivity. */
export function useNetworkOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const onOnline = (): void => setOnline(true);
    const onOffline = (): void => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return online;
}
