/**
 * The process-wide owner of the board live service.
 *
 * Why a module rather than a construction inside the IPC handler: the service
 * owns timers, an AbortController and a listener on a renderer's webContents,
 * and rule 05 gives every such handle ONE named lifecycle owner. The handler is
 * a request boundary, not a lifetime; the app's startup path is. This module is
 * the seam between them, and it mirrors `snapshot-cache.ts`, which plays the
 * same role for the VEX market poller.
 *
 * `setup` returns an idempotent async stop for the quit cleanup. Calling it
 * closes every live lease with `shutdown` and drains the in-flight cycle before
 * the windows go away, which is what keeps a terminal event from being sent
 * into a destroyed webContents.
 */

import {
  BoardLiveService,
  type BoardLiveServiceDeps,
} from "./board-live-service.js";

let current: BoardLiveService | null = null;

/**
 * Start the board live service and claim the process slot.
 *
 * Called once from the app's startup path. A second call while one is live
 * replaces nothing: it returns the existing service's stop, so a mis-wired
 * double setup cannot silently orphan a service that still owns timers.
 */
export function setupBoardLiveService(
  deps: Partial<BoardLiveServiceDeps> = {},
): () => Promise<void> {
  const service = current ?? new BoardLiveService(deps);
  current = service;
  let stopped = false;
  return async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    await service.stop();
    if (current === service) current = null;
  };
}

/**
 * The live service, or null when the app never started one.
 *
 * Null is a real answer rather than a crash: a headless or partially started
 * process has no service, and the handler turns that into the same honest
 * "not supported here" the renderer already knows how to render.
 */
export function getBoardLiveService(): BoardLiveService | null {
  return current;
}

/** Test-only: release the process slot between cases. */
export function __resetBoardLiveOwnerForTests(): void {
  current = null;
}
