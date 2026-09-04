/**
 * THE TERMINAL'S WORKING DIRECTORY, AS TEXT A PERSON MAY SEE.
 *
 * The pty host reads a real absolute path (`/proc/<pid>/cwd`, `lsof`, or the
 * spawn cwd on Windows). That path names the user's home directory and very
 * often their username, and the terminal's `cwd` property is delivered to the
 * RENDERER over the MessagePort - a process with no filesystem authority, whose
 * state ends up in screenshots, support bundles and crash reports. So the raw
 * path stops here: what crosses the port is a LABEL, and no handler anywhere
 * accepts one back.
 *
 * ## Why the derivation lives in the host and not in main
 *
 * The `cwd` property travels host -> port -> preload -> renderer. Main is not
 * in that path. Deriving in main would mean routing this one property through a
 * second transport, which would make terminal properties arrive on two streams
 * with different ordering guarantees - a second source of truth for the same
 * per-terminal fact. So the host applies the mechanic, and MAIN remains the
 * authority: it decides the project's directory and its label and hands both
 * down in the launch request. The host never resolves a project root itself.
 *
 * ## The policy, which is `formatProjectDisplayPath`'s policy
 *
 * `main/studio/projects-root.ts` settled this shape for the settings label, and
 * the reasoning transfers unchanged: there are exactly two answers, a location
 * PROVEN to sit under a known root and rendered relative to it, or a location
 * that is not proven and named abstractly. Containment is proven by a
 * BYTE-EXACT prefix match, deliberately, and the fallback is the safe one - so
 * a differently-cased home spelling (`C:\Users\Ada` vs `c:\users\ada`,
 * `/Users/Ada` vs `/users/ada`, the two platforms where one directory has many
 * spellings) degrades to `outside project` rather than to a username on screen.
 *
 * Note what is deliberately NOT reused: `files/node-path.ts`'s
 * `toProjectRelative` maps watcher paths back to project-relative ones and is
 * CASE-TOLERANT on purpose, because there a failed match drops a real file
 * event. Here a failed match must not be tolerated - tolerance is how the
 * absolute path gets through - so the two functions answer different questions
 * with opposite failure requirements and are not one function wearing two hats.
 *
 * The value is TEXT, never a capability. It is not persisted, not sent back to
 * the host, and not used to decide where any byte goes.
 */

import path from "node:path";

/**
 * Stands in for a directory the host could not prove sits inside the project.
 *
 * Deliberately path-shaped in neither direction: it is not `~/...` (which is a
 * promise about where the folder is) and not an absolute path (which is the
 * thing this module exists to keep off the wire). A user who has cd'd out of
 * their project sees that they have, and nothing about where they went.
 */
export const DISPLAY_CWD_OUTSIDE_PROJECT = "outside project";

/**
 * Stands in for a directory the host could not read at all.
 *
 * Distinct from `outside project`, because they are different facts: one says
 * the shell moved somewhere Vex will not name, the other says Vex does not know
 * where the shell is. Windows has no supported interface for reading another
 * process's cwd, so this is the ordinary steady state there rather than an
 * error, which is why it reads as a plain statement and not as a failure.
 */
export const DISPLAY_CWD_UNKNOWN = "location unknown";

/**
 * What MAIN tells the host about the project a terminal belongs to.
 *
 * `projectRoot` must ALREADY be resolved - `resolveProjectDirectory` in
 * `projects-root.ts` is the one place that produces it, and it returns a value
 * built with `path.resolve`. Passing a configured string here would compare
 * containment against a name rather than against the place it names.
 */
export interface DisplayCwdContext {
  readonly projectRoot: string;
  /** What the project is called on screen. Main's authority, not the host's. */
  readonly projectLabel: string;
}

/**
 * The label for `absoluteCwd`, given the project it is supposed to be in.
 *
 * Four answers, and every one of them is reachable:
 *
 *   - `null` cwd (the host could not read one) -> `location unknown`;
 *   - the project root itself -> the project's own label, so the header reads
 *     `vex-core` rather than `.`;
 *   - proven inside -> the project-relative path, POSIX-separated on every
 *     platform because it is being read, not opened;
 *   - anything else -> `outside project`.
 *
 * Separators are normalised to `/` for display only. The remainder is never
 * truncated: it is by construction shorter than the absolute path it came from,
 * which the wire schema already bounds.
 */
export function deriveDisplayCwd(
  context: DisplayCwdContext,
  absoluteCwd: string | null,
): string {
  if (absoluteCwd === null || absoluteCwd === "") return DISPLAY_CWD_UNKNOWN;

  const root = path.resolve(context.projectRoot);
  const current = path.resolve(absoluteCwd);
  if (current === root) return context.projectLabel;

  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!current.startsWith(prefix)) return DISPLAY_CWD_OUTSIDE_PROJECT;

  const remainder = current.slice(prefix.length);
  if (remainder === "") return context.projectLabel;
  // A `..` surviving `path.resolve` would mean the path left the root after
  // all; refuse rather than render it.
  const segments = remainder.split(path.sep);
  if (segments.some((segment) => segment === "" || segment === "..")) {
    return DISPLAY_CWD_OUTSIDE_PROJECT;
  }
  return segments.join("/");
}
