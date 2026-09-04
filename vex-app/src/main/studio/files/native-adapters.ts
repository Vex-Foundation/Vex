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

/** The three backends this product ever asks @parcel/watcher for. */
export type NativeWatcherBackend = "windows" | "inotify" | "fs-events";

/**
 * The native backend this process PINS, per platform.
 *
 * WHY PIN AT ALL. Omitting `backend` selects @parcel/watcher's `"default"`, and
 * its `getBackend` (2.6.0, `src/Backend.cc`, read in the installed package)
 * reads: FSEvents when compiled in, THEN
 * `WatchmanBackend::checkAvailable()`, then the platform backend. On macOS the
 * FSEvents branch short-circuits, but on Windows and Linux every `subscribe`
 * first tries to reach a Watchman server, and on a machine without Watchman
 * that lookup prints "'watchman' is not recognized as an internal or external
 * command" to the user's console on every single subscribe. Pinning removes the
 * probe rather than hiding its output.
 *
 * Adopted from VS Code's `ParcelWatcher.PARCEL_WATCHER_BACKEND`
 * (`src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts`), which pins
 * these same three values for the same reason.
 *
 * DEPARTURE from the reference: theirs is a ternary whose final arm hands
 * `"fs-events"` to EVERY non-Windows non-Linux platform, including ones where
 * that backend is not compiled in and `getBackend` therefore returns nothing at
 * all. Vex ships on exactly these three platforms, so an unknown platform here
 * returns `undefined` and the option is omitted - today's working behavior -
 * rather than naming a backend that provably cannot exist there.
 */
export function nativeWatcherBackend(
  platform: NodeJS.Platform,
): NativeWatcherBackend | undefined {
  if (platform === "win32") return "windows";
  if (platform === "linux") return "inotify";
  if (platform === "darwin") return "fs-events";
  return undefined;
}

/**
 * The exact options object handed to `@parcel/watcher`'s `subscribe`.
 *
 * Pure, and separate from the adapter below, so the per-platform backend can be
 * asserted as a table without the test reading `process.platform` or standing
 * up a native subscription.
 */
export function nativeWatcherSubscribeOptions(
  ignore: string[],
  platform: NodeJS.Platform,
): { readonly ignore: string[]; readonly backend?: NativeWatcherBackend } {
  const backend = nativeWatcherBackend(platform);
  return backend === undefined ? { ignore } : { ignore, backend };
}

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
) =>
  watcher.subscribe(
    directory,
    callback,
    nativeWatcherSubscribeOptions(options.ignore, process.platform),
  );

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
