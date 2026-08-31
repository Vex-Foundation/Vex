/**
 * WINDOW TEARDOWN for the three Studio registries, in ONE owner.
 *
 * Each registry keeps live objects outside React on purpose - xterm instances
 * with WebGL contexts and pty attachments, explorer sessions with watcher
 * subscriptions in main, file-viewer sessions with a highlight worker - and
 * each already exposes `disposeAll` for "the window is going away". Until this
 * module, NOTHING CALLED ANY OF THEM: a repo-wide search for `disposeAll` found
 * the three definitions, their unit tests, and no production caller. That was a
 * real leak, not a hypothetical one - closing the Vex window left the pty host
 * holding attachments and main holding watchers that no renderer would ever
 * release.
 *
 * One owner rather than three call sites, because the three have to run
 * together and in a stated order, and because a fourth registry added later
 * must have one obvious place to join.
 *
 * ## Why `pagehide`
 *
 * `pagehide` is the last event the renderer is reliably given before the window
 * goes away, and it fires for a close as well as a navigation. It is the event
 * VS Code's own main-window lifecycle listens to for exactly this job
 * (`src/vs/workbench/services/lifecycle/browser/lifecycleService.ts:45`,
 * `EventType.PAGE_HIDE`). `beforeunload` is not used: it is a CANCELLABLE
 * prompt point, not a teardown point, and disposing there would destroy live
 * terminals for a teardown the user may still cancel.
 *
 * ## Order
 *
 * Explorer first, because its dispose is asynchronous and unsubscribes watchers
 * in main - starting it before the synchronous work means the IPC is already in
 * flight while the terminals and viewers tear down. Nothing depends on the
 * other direction; the order is stated so it does not become accidental.
 */

import { explorerRegistry } from "./explorer/index.js";
import { terminalRegistry } from "./terminal/index.js";
import { fileViewerRegistry } from "./viewer/index.js";
import { clearProjectTerminals } from "./workspace/project-terminals.js";

/**
 * Dispose every Studio registry. Idempotent: each registry's `disposeAll`
 * empties its own map, so a second call has nothing left to do.
 *
 * The explorer's teardown is asynchronous; the returned promise is exposed for
 * tests and for a caller that can await it. The `pagehide` binding below cannot
 * await anything, which is fine - the unsubscribe is already dispatched and the
 * process is going away.
 */
export function disposeStudioRegistries(): Promise<void> {
  const explorerDone = explorerRegistry.disposeAll();
  terminalRegistry.disposeAll();
  fileViewerRegistry.disposeAll();
  clearProjectTerminals();
  return explorerDone;
}

/**
 * Bind the teardown to this window's `pagehide`.
 *
 * Returns the unbind function, so the binding has a named owner (rule 05) even
 * though the app's one call site keeps it for the life of the process.
 */
export function bindStudioRegistryTeardown(target: Window): () => void {
  const onPageHide = (): void => {
    void disposeStudioRegistries();
  };
  target.addEventListener("pagehide", onPageHide);
  return () => {
    target.removeEventListener("pagehide", onPageHide);
  };
}
