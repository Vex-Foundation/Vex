/**
 * FROM A VERIFIED TOKEN TO AN ABSOLUTE PATH THAT IS SAFE TO OPEN.
 *
 * `node-id.ts` proved the caller did not invent the name. This module proves
 * the name still points inside the project, and it does so against the
 * FILESYSTEM rather than against the string - because a string check cannot
 * see the one attack that matters here.
 *
 * A project directory is a folder the user, their editor, their package manager
 * and every tool they run can write to. `ln -s ~/.ssh src/keys` turns a
 * perfectly derived, perfectly signed `src/keys/id_rsa` into a read outside the
 * project, and `path.resolve` reports it as contained because the string never
 * left. So resolution WALKS the chain one segment at a time with `lstat` and
 * refuses the moment any component is a symbolic link, then re-checks
 * containment after the walk. This is the same discipline the installer's
 * `paths.ts` applies to its own writes, applied to reads.
 *
 * `isInside` is imported from the installer's path owner rather than
 * reimplemented. It is a pure containment predicate with no installer policy in
 * it, and a SECOND copy of a security check is how the two copies eventually
 * disagree. It deserves a home neither feature owns; moving it is a refactor
 * for a change that owns both callers, not for this one.
 *
 * ## The residual, stated plainly
 *
 * Node exposes no `openat2`, so the microseconds between the last `lstat` and
 * the `open` are not covered: an attacker who can already write inside the
 * project folder and wins that race can still redirect the final open. What the
 * walk closes is the whole standing case - a link that is simply THERE, which
 * is what a checked-out repository or a careless build actually produces. The
 * reader additionally opens with `O_NOFOLLOW` on the final component, which
 * closes the common half of the residual.
 */

import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { isInside } from "../installer/paths.js";

/** The project root as a project-relative path: the empty string. */
export const PROJECT_ROOT_RELATIVE = "";

/** Why a relative path could not become an absolute one. */
export type NodePathRefusal =
  | "invalid_node"
  | "outside_project"
  | "symlinked_path"
  | "not_found"
  | "io_error";

export type NodePathResolution =
  | {
    readonly ok: true;
    readonly absolutePath: string;
    /** The entry as `lstat` sees it, so callers need no second syscall. */
    readonly kind: "file" | "directory" | "symlink" | "other";
    readonly size: number;
    readonly modifiedMs: number;
  }
  | { readonly ok: false; readonly reason: NodePathRefusal };

/**
 * Split a project-relative POSIX path into segments, refusing anything that is
 * not a plain forward walk.
 *
 * Absolute paths, empty segments, `.` and `..` are refused STRUCTURALLY, before
 * any syscall. A token carrying one of these could only come from this process
 * (the signature says so), so it is a bug rather than an attack - and a bug on
 * a path-resolution surface fails closed rather than being normalised away.
 */
export function splitRelativePath(relativePath: string): string[] | null {
  if (relativePath === PROJECT_ROOT_RELATIVE) return [];
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    return null;
  }
  const segments = relativePath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments;
}

function classify(entry: {
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}): "file" | "directory" | "symlink" | "other" {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

/**
 * Resolve `<projectDirectory>/<relativePath>`, proving every step.
 *
 * `projectDirectory` must ALREADY be a realpath; `resolveProjectFilesRoot`
 * below is the one place that produces one. Passing a configured string here
 * would compare containment against a name rather than against the place it
 * points to, which is the exact hole `projects-root.ts` exists to close.
 *
 * The FINAL component is allowed to be a symlink and is reported as `symlink`,
 * because the tree must be able to SHOW a link it will not open. Every
 * intermediate component being a link is a refusal: there is no way to display
 * a path that already left the project.
 */
export async function resolveNodePath(
  projectDirectory: string,
  relativePath: string,
): Promise<NodePathResolution> {
  const segments = splitRelativePath(relativePath);
  if (segments === null) return { ok: false, reason: "invalid_node" };

  const absolutePath = path.resolve(projectDirectory, ...segments);
  if (segments.length > 0 && !isInside(projectDirectory, absolutePath)) {
    return { ok: false, reason: "outside_project" };
  }

  let walked = path.resolve(projectDirectory);
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(walked);
  } catch {
    return { ok: false, reason: "not_found" };
  }

  for (const [index, segment] of segments.entries()) {
    walked = path.join(walked, segment);
    const isTarget = index === segments.length - 1;
    try {
      entry = await lstat(walked);
    } catch (cause) {
      if (isEnoentLike(cause)) return { ok: false, reason: "not_found" };
      return { ok: false, reason: "io_error" };
    }
    // An intermediate link is a refusal; the target itself is displayable.
    if (entry.isSymbolicLink() && !isTarget) {
      return { ok: false, reason: "symlinked_path" };
    }
    if (!isTarget && !entry.isDirectory()) {
      // A path that walks THROUGH a file cannot exist.
      return { ok: false, reason: "not_found" };
    }
  }

  return {
    ok: true,
    absolutePath,
    kind: classify(entry),
    size: entry.size,
    modifiedMs: Math.trunc(entry.mtimeMs),
  };
}

/**
 * The realpath of a project's directory, ANCHORED to the projects root.
 *
 * ## Why an anchor, and not just a realpath
 *
 * Resolving the directory and then blessing whatever came back is the hole this
 * function exists to close. Every containment check in this feature compares
 * against the value returned here, so if `<projectsRoot>/<slug>` is ITSELF a
 * symbolic link, `realpath` follows it out of the workspace and the target
 * becomes the confinement root: the root listing, every token minted under it,
 * every read and a RECURSIVE WATCH of an arbitrary directory all pass, and each
 * of them is doing exactly what it was told. `resolveNodePath` refuses an
 * intermediate link on the way DOWN, but nothing refused the link at the top,
 * because the walk starts at a directory it was handed as already-proven.
 *
 * ## The predicate
 *
 * A project directory is a REAL DIRECTORY LOCATED DIRECTLY UNDER THE ANCHORED
 * ROOT. Two comparisons say that, and both are needed:
 *
 *  - `realpath(dir) === path.resolve(dir)`. The lexical path is
 *    `<realRoot>/<slug>` and `realRoot` is already a realpath, so equality here
 *    means no component of the final name is a link. A link is refused whether
 *    it points out of the workspace or at a SIBLING PROJECT - the second is not
 *    an escape, but it is one project's slug serving another project's bytes,
 *    which is an identity confusion this surface has no way to describe.
 *  - the resolved directory's parent IS the anchored root. Projects are never
 *    nested, which `resolveProjectDirectory` in `projects-root.ts` already
 *    states on the write side; this is the same rule enforced on the read side.
 *
 * `isInside` is the shared containment predicate and is used for the anchor
 * check itself, so the two features cannot drift apart on what "inside" means.
 *
 * PROBED on Linux against a real temporary root: a real directory is accepted;
 * a symlink to an outside directory and a symlink to a sibling inside the root
 * are both refused by the first comparison; an absent directory is `not_found`.
 *
 * `anchoredRoot` must ALREADY be a realpath - `resolveProjectsRoot` returns
 * one - so a projects root that is itself a symlink (a very ordinary thing on
 * macOS, where `/tmp` is one) is compared as its target rather than as its name.
 */
export async function realProjectDirectory(
  anchoredRoot: string,
  projectDirectory: string,
): Promise<{ ok: true; directory: string } | { ok: false; reason: NodePathRefusal }> {
  let resolved: string;
  try {
    resolved = await realpath(projectDirectory);
  } catch (cause) {
    if (isEnoentLike(cause)) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "io_error" };
  }

  const lexical = path.resolve(projectDirectory);
  const root = path.resolve(anchoredRoot);
  // A link AT the slug: the name and the place it points to are not the same.
  if (resolved !== lexical) return { ok: false, reason: "outside_project" };
  if (!isInside(root, resolved)) return { ok: false, reason: "outside_project" };
  // Directly under the root. A project directory is never nested.
  if (path.dirname(resolved) !== root) return { ok: false, reason: "outside_project" };
  return { ok: true, directory: resolved };
}

/**
 * Turn an ABSOLUTE path reported by the watcher back into a project-relative
 * POSIX one, or `null` when it does not belong to this project.
 *
 * Three things happen here, and each one is a real defect somewhere without it:
 *
 *  - CASING. On a case-insensitive filesystem the OS can report the watched
 *    root with a different case than the one we subscribed with, and an exact
 *    prefix strip then yields a path that escapes. The fallback compares the
 *    prefix case-insensitively and maps the remainder back onto the root's own
 *    casing - so the ENTRY's case, which is the part the user sees and the part
 *    a case-only rename changes, is always preserved exactly as reported.
 *  - UNICODE FORM, and the fact that this function does NOT change it. Both
 *    sources of a path in this feature are the operating system - `readdir` in
 *    `listing.ts` and the native watcher here - so both already agree, and
 *    normalising one of them to NFC is what made them disagree. Measured on
 *    Linux: a file stored with a decomposed name is returned decomposed by
 *    `readdir`, and `lstat` of its composed spelling is ENOENT. A path that has
 *    been normalised is therefore a path that may name nothing, and a node
 *    token minted from one cannot be resolved. Normalisation is a DISPLAY
 *    concern and belongs where the value is displayed, not where it is minted.
 *  - CONTAINMENT. Anything that is not under the root after all of that is
 *    dropped rather than reported, because a change outside the project is not
 *    this project's change.
 */
export function toProjectRelative(
  realRoot: string,
  absolutePath: string,
): string | null {
  const root = path.resolve(realRoot);
  if (absolutePath === root) return PROJECT_ROOT_RELATIVE;

  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  let remainder: string | null = null;
  if (absolutePath.startsWith(prefix)) {
    remainder = absolutePath.slice(prefix.length);
  } else if (absolutePath.toLowerCase().startsWith(prefix.toLowerCase())) {
    // Same place, differently spelled root. The REMAINDER keeps its own case.
    remainder = absolutePath.slice(prefix.length);
  } else if (absolutePath.toLowerCase() === root.toLowerCase()) {
    return PROJECT_ROOT_RELATIVE;
  }
  if (remainder === null || remainder === "") return null;
  if (remainder.split(path.sep).some((s) => s === "" || s === "." || s === "..")) {
    return null;
  }
  return remainder.split(path.sep).join("/");
}

/** `ENOENT`, without asserting a shape onto an unknown catch value. */
export function isEnoentLike(cause: unknown): boolean {
  return (
    typeof cause === "object"
    && cause !== null
    && (cause as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * The ONLY thing this feature says about a filesystem failure in a log.
 *
 * A raw Node `fs` error carries absolute paths, which name the user's home
 * directory and often their username, and logs travel - to the log file, to a
 * support bundle, to Sentry. So a failure is recorded as the closed pair an
 * operator can act on and nothing else, exactly as `confined-fs.ts` does.
 */
export function describeFileFailure(cause: unknown): string {
  if (!(typeof cause === "object" && cause !== null)) return "name=unknown code=unknown";
  const name = (cause as { name?: unknown }).name;
  const code = (cause as { code?: unknown }).code;
  return `name=${typeof name === "string" ? name : "unknown"} `
    + `code=${typeof code === "string" ? code : "unknown"}`;
}
