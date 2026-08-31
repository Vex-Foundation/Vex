/**
 * THE OPERATING SYSTEM, adapted to this feature's contract.
 *
 * Separate from `files-composition.ts` for one reason: that file imports
 * `electron` and the `projects` table, and the real-filesystem test suite must
 * drive THESE adapters - the ones production uses - without starting Electron.
 * A test that built its own `subscribe` wrapper would prove the domain works
 * over a wrapper nothing ships.
 *
 * Nothing here holds state or makes a decision. The policy is in `watcher.ts`.
 */

import { watchFile as pollFile, unwatchFile as unpollFile } from "node:fs";
import { stat } from "node:fs/promises";

import watcher from "@parcel/watcher";

import { FILES_SUSPEND_POLL_MS } from "@shared/schemas/files.js";

import type { NativeSubscribe, RootPoller } from "./watcher.js";

/**
 * @parcel/watcher's `subscribe`, pinned to this feature's contract.
 *
 * The signature already matches, so this adapter exists to PIN it rather than
 * to translate: if the package's shape ever changes, the failure is one compile
 * error here instead of a runtime surprise inside the domain.
 *
 * Verified against @parcel/watcher 2.6.0 by probing a live subscription: paths
 * arrive ABSOLUTE, `type` is one of `create` / `update` / `delete`, the
 * `ignore` option suppresses events at the source, and removing the watched
 * directory emits a `delete` for the root itself rather than an error.
 */
export const subscribeNativeWatcher: NativeSubscribe = (
  directory,
  callback,
  options,
) => watcher.subscribe(directory, callback, { ignore: options.ignore });

/**
 * Poll for a vanished root with `fs.watchFile`.
 *
 * `fs.watchFile` on a path that does not exist is legal and is exactly what
 * VS Code's `baseWatcher` uses for this: it reports zeroed stats until the path
 * appears, and a non-zero `ino` is the signal that something is there.
 *
 * `persistent: false` so a suspended watcher never holds the process open, and
 * the returned stop passes the SAME listener reference to `unwatchFile` -
 * calling it without one removes every listener on that path, including another
 * suspended watcher's.
 */
export const pollForRootReturn: RootPoller = (directory, onAppeared) => {
  const listener = (current: { ino: number }): void => {
    if (current.ino !== 0) onAppeared();
  };
  pollFile(directory, { interval: FILES_SUSPEND_POLL_MS, persistent: false }, listener);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    unpollFile(directory, listener);
  };
};

/** Is the project root there, and is it a directory? */
export async function projectRootExists(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}
