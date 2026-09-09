import { TERMINAL_HOST_BEAT_INTERVAL_MS } from "@shared/schemas/terminal.js";

/** Owns the fail-safe timer. Stops admission and kills before announcing exit. */
export function watchParent(deps: {
  readonly parentPid: number;
  readonly exists: (pid: number) => boolean;
  readonly shutdown: () => Promise<void>;
  readonly exit: () => void;
  readonly heartbeat: () => void;
  readonly log: (message: string) => void;
}): () => void {
  let closing = false;
  const timer = setInterval(() => {
    if (closing) return;
    if (deps.exists(deps.parentPid)) { deps.heartbeat(); return; }
    closing = true;
    clearInterval(timer);
    void deps.shutdown().catch(() => deps.log("[pty-host] parent-loss cleanup failed"))
      .finally(deps.exit);
  }, TERMINAL_HOST_BEAT_INTERVAL_MS);
  return () => { closing = true; clearInterval(timer); };
}
