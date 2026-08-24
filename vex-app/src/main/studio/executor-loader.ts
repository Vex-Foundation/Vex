/**
 * The ONE owner of the Studio executor chunk's dynamic import.
 *
 * `runStudioCall` resolves this module BEFORE it loads the authoritative scope
 * snapshot, so the pre-dispatch abort gate is the LAST statement before
 * `executeStudioTool` with no await in between. An import left below the gate
 * reopens exactly the window the gate exists to close: a client cancellation or
 * a peer FIN landing inside the chunk load would abort the signal after the
 * gate had already answered "not aborted", and a mutating tool would dispatch
 * for a call nobody is waiting for.
 *
 * The import stays DYNAMIC because the main bundle's static graph must not gain
 * the engine's executor at module load, exactly as the other engine
 * touch-points in main do. Hoisting moves WHEN it resolves, not whether it is a
 * separate chunk.
 *
 * The loader is replaceable for tests only. There is no production path that
 * sets it, and the test seam restores the real loader rather than leaving a
 * process-wide override behind.
 */

type StudioExecutorModule = typeof import("@vex-agent/mcp/executor.js");

export type StudioExecutorLoader = () => Promise<StudioExecutorModule>;

const defaultLoader: StudioExecutorLoader = () => import("@vex-agent/mcp/executor.js");

let loader: StudioExecutorLoader = defaultLoader;

/** Resolve the executor chunk. Called once per Studio call, before the snapshot. */
export function loadStudioExecutor(): Promise<StudioExecutorModule> {
  return loader();
}

/** Test seam: hold or replace the chunk load. `null` restores the real one. */
export function setStudioExecutorLoaderForTests(
  next: StudioExecutorLoader | null,
): void {
  loader = next ?? defaultLoader;
}
