/**
 * THE CONFINEMENT OWNER for every path the Studio installer touches.
 *
 * The chain is short and has no user-supplied link in it:
 *
 *     projectId -> the `projects` row -> slug -> anchored projects root
 *                -> `<root>/<slug>` -> a STATIC registry-relative path
 *
 * Nothing a renderer sends, nothing a model produces and nothing read out of a
 * file on disk ever becomes part of a path here. `.codex/config.toml` and
 * `AGENTS.md` are literals in the agent registry, compiled into the app.
 *
 * That already makes traversal impossible, so everything below is defence in
 * depth against a future caller that reaches this module from somewhere else -
 * and against the one attack the derivation alone cannot stop: a SYMLINK. A
 * repo is a folder the user (and every tool they run) can write to. `mkdir
 * .codex && ln -s ~/.ssh/authorized_keys .codex/config.toml` turns a perfectly
 * derived path into a write outside the project. So resolution walks the chain
 * one segment at a time and refuses the moment any component is a link, and
 * the containment check is REPEATED after the real path is known.
 *
 * `lstat`, never `stat`: `stat` follows the very link we are looking for.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";

import type { StudioRefusalReason } from "@shared/schemas/studio-installer.js";

/** A resolved, confined, safe-to-open absolute path, plus what is there now. */
export interface ResolvedArtifactPath {
  readonly kind: "resolved";
  readonly absolutePath: string;
  /** The parent directory. Absent parents are created by the writer. */
  readonly directory: string;
  /** True when a regular file already exists at the path. */
  readonly exists: boolean;
  /** The existing file's mode, so a replacement preserves it. */
  readonly mode: number | null;
  /** The existing file's size in bytes, for the size bound. */
  readonly size: number | null;
}

/** Why a path may not be used. Carries the same closed reason set as an outcome. */
export interface RefusedArtifactPath {
  readonly kind: "refused";
  readonly reason: StudioRefusalReason;
  readonly detail: string;
}

export type ArtifactPathResolution = ResolvedArtifactPath | RefusedArtifactPath;

/**
 * The size bound for any file the installer will parse and rewrite.
 *
 * 1 MiB. An MCP config, an `AGENTS.md` or a `CLAUDE.md` is kilobytes; a file
 * two orders of magnitude larger is not the artifact we think it is, and
 * reading it into memory to run a JSONC parse over it is work with no upside.
 * The bound is NAMED in the refusal so the user learns what the limit was
 * rather than seeing a generic failure.
 */
export const STUDIO_ARTIFACT_MAX_BYTES = 1024 * 1024;

function refuse(reason: StudioRefusalReason, detail: string): RefusedArtifactPath {
  return { kind: "refused", reason, detail };
}

/**
 * Is `candidate` inside `root`? Compared on resolved, separator-terminated
 * prefixes so `/a/b-evil` is not accepted as being inside `/a/b`.
 */
export function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const prefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;
  return path.resolve(candidate).startsWith(prefix);
}

/**
 * Resolve one registry-relative artifact path inside a project directory.
 *
 * `projectDirectory` must ALREADY be the realpath of `<projects root>/<slug>`;
 * this function never derives it, so it cannot be handed a directory a caller
 * invented. `relativePath` is a static POSIX path from the agent registry.
 */
export async function resolveArtifactPath(
  projectDirectory: string,
  relativePath: string,
): Promise<ArtifactPathResolution> {
  // Structural rejections first: cheap, and they name the exact problem.
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    return refuse("path_escape", `"${relativePath}" is an absolute path.`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return refuse(
      "path_escape",
      `"${relativePath}" contains an empty or relative path segment.`,
    );
  }

  const absolutePath = path.resolve(projectDirectory, ...segments);
  if (!isInside(projectDirectory, absolutePath)) {
    return refuse("path_escape", `"${relativePath}" resolves outside the project folder.`);
  }

  // Walk the chain. Every directory on the way, then the target itself.
  let walked = path.resolve(projectDirectory);
  for (const [index, segment] of segments.entries()) {
    walked = path.join(walked, segment);
    const isTarget = index === segments.length - 1;

    let entry;
    try {
      entry = await lstat(walked);
    } catch (cause) {
      if (isEnoent(cause)) {
        // Nothing here yet. A missing directory is created by the writer; a
        // missing target is a fresh render. Neither can be a symlink, and
        // nothing below this point can exist either, so the walk is done.
        return {
          kind: "resolved",
          absolutePath,
          directory: path.dirname(absolutePath),
          exists: false,
          mode: null,
          size: null,
        };
      }
      return refuse("io_error", `"${relativePath}" could not be inspected.`);
    }

    if (entry.isSymbolicLink()) {
      return refuse(
        "symlinked_path",
        `"${segments.slice(0, index + 1).join("/")}" is a symbolic link. Vex will not `
          + "write through a link, because the real target may be outside this project.",
      );
    }
    if (isTarget) {
      if (!entry.isFile()) {
        return refuse(
          "not_a_regular_file",
          `"${relativePath}" exists but is not a regular file.`,
        );
      }
      if (entry.size > STUDIO_ARTIFACT_MAX_BYTES) {
        return refuse(
          "too_large",
          `"${relativePath}" is larger than the ${String(STUDIO_ARTIFACT_MAX_BYTES)}-byte `
            + "limit Vex will parse, so it was left untouched.",
        );
      }
      return {
        kind: "resolved",
        absolutePath,
        directory: path.dirname(absolutePath),
        exists: true,
        mode: entry.mode,
        size: entry.size,
      };
    }
    if (!entry.isDirectory()) {
      return refuse(
        "not_a_regular_file",
        `"${segments.slice(0, index + 1).join("/")}" is not a directory, so `
          + `"${relativePath}" cannot exist.`,
      );
    }
  }

  // Unreachable: the loop returns on the final segment. Fail closed anyway.
  return refuse("io_error", `"${relativePath}" could not be resolved.`);
}

/**
 * Refuse a `.json` / `.jsonc` pair that both exist.
 *
 * Several clients read either spelling and document no precedence, or document
 * one and implement the other. When both files are present Vex cannot know
 * which one the client will actually load, and writing to the wrong one is a
 * config that silently does nothing. So the ambiguity is REPORTED and the user
 * decides which file survives - Vex never picks for them and never deletes one.
 */
export async function findAmbiguousTwin(
  projectDirectory: string,
  relativePath: string,
  alsoReads: readonly string[],
): Promise<RefusedArtifactPath | null> {
  const twins = alsoReads.filter((candidate) => isJsonTwin(relativePath, candidate));
  for (const twin of twins) {
    const resolution = await resolveArtifactPath(projectDirectory, twin);
    if (resolution.kind === "resolved" && resolution.exists) {
      return refuse(
        "ambiguous_twin",
        `Both "${relativePath}" and "${twin}" exist. Vex cannot tell which one this `
          + "client loads, so it changed neither. Remove or merge one of them.",
      );
    }
  }
  return null;
}

/** `x.json` and `x.jsonc` are twins; `.mcp.json` and `.cursor/mcp.json` are not. */
function isJsonTwin(a: string, b: string): boolean {
  const strip = (value: string): string =>
    value.endsWith(".jsonc")
      ? value.slice(0, -".jsonc".length)
      : value.endsWith(".json")
        ? value.slice(0, -".json".length)
        : value;
  if (a === b) return false;
  const isJson = (value: string): boolean =>
    value.endsWith(".json") || value.endsWith(".jsonc");
  return isJson(a) && isJson(b) && strip(a) === strip(b);
}

/**
 * The identity of one directory on the way to an artifact.
 *
 * `dev`+`ino` is the filesystem's own answer to "is this the same directory I
 * looked at a moment ago?". A path string cannot answer that: `rm -rf .codex &&
 * ln -s /etc .codex` leaves the path spelled identically and pointing somewhere
 * else entirely.
 */
export interface DirectoryIdentity {
  readonly absolutePath: string;
  readonly dev: number;
  readonly ino: number;
}

/**
 * Capture the identity of every directory from `projectDirectory` down to
 * `directory`, refusing any component that is not a real directory.
 *
 * Called AFTER `mkdir` and again immediately before the `rename`. The pair is
 * the strongest confinement Node makes available, and it is worth being precise
 * about why it is a pair rather than a guarantee:
 *
 * A truly race-free write needs the kernel to resolve the path ONCE and hand
 * back a handle the write is then performed against - `openat2(RESOLVE_BENEATH)`
 * plus `renameat2`, addressing directories by descriptor so no later swap can
 * redirect anything. Node exposes neither: `fs.promises` has no `openat`, no
 * `mkdirat` and no `renameat`, and a `FileHandle` cannot be used as a directory
 * base. `rename()` therefore re-resolves the path string from the root every
 * time it is called, and nothing in Node can stop it.
 *
 * So this is capture-and-recheck: the swap window is narrowed from "the whole
 * render" - a read, a parse and a render, i.e. milliseconds during which the
 * user's editor, a formatter or another agent is genuinely likely to act - down
 * to the few microseconds between the final `verifyDirectoryChain` and the
 * `rename` syscall. THAT REMAINING WINDOW IS REAL AND IS NOT CLOSED. An attacker
 * who can already write inside the project directory and who wins a microsecond
 * race can still redirect the final rename. It is documented here rather than
 * described as prevented, and closing it properly requires either a native
 * binding or `openat2`.
 *
 * What IS fully closed: a symlink present at any point during the walk, and any
 * swap that happens before the final recheck.
 *
 * ONE MEASURED LIMIT of `dev`+`ino`: a delete-and-recreate of a real directory
 * often REUSES the inode - measured on the development filesystem, same `dev`
 * and same `ino` across an `rm -r` followed by `mkdir` - so a same-path
 * recreate is not detected. That is deliberate and harmless: the property being
 * defended is confinement, and a real directory recreated at the same in-project
 * path is still inside the project. Redirection requires a symlink or a mount,
 * which changes the type or the device and IS caught.
 */
export async function captureDirectoryChain(
  projectDirectory: string,
  directory: string,
): Promise<{ kind: "ok"; chain: readonly DirectoryIdentity[] } | RefusedArtifactPath> {
  const root = path.resolve(projectDirectory);
  const target = path.resolve(directory);
  if (target !== root && !isInside(root, target)) {
    return refuse("path_escape", "the artifact folder is outside the project folder.");
  }

  // Every component from the project root down to the artifact's own directory.
  const relative = target === root ? "" : path.relative(root, target);
  const segments = relative === "" ? [] : relative.split(path.sep);

  const chain: DirectoryIdentity[] = [];
  let walked = root;
  for (const segment of [null, ...segments]) {
    if (segment !== null) walked = path.join(walked, segment);
    let entry;
    try {
      entry = await lstat(walked);
    } catch {
      return refuse("io_error", "a folder on the way to the artifact could not be inspected.");
    }
    if (entry.isSymbolicLink()) {
      return refuse(
        "symlinked_path",
        "a folder on the way to this file is a symbolic link. Vex will not write "
          + "through a link, because the real target may be outside this project.",
      );
    }
    if (!entry.isDirectory()) {
      return refuse("not_a_regular_file", "a folder on the way to this file is not a folder.");
    }
    chain.push({ absolutePath: walked, dev: entry.dev, ino: entry.ino });
  }
  return { kind: "ok", chain };
}

/**
 * Re-check a captured chain. `null` when every directory is still the same one.
 *
 * Compares `dev`+`ino`, not paths: the whole point is to catch a directory that
 * kept its name and became something else.
 */
export async function verifyDirectoryChain(
  chain: readonly DirectoryIdentity[],
): Promise<RefusedArtifactPath | null> {
  for (const recorded of chain) {
    let entry;
    try {
      entry = await lstat(recorded.absolutePath);
    } catch {
      return refuse("io_error", "a folder on the way to the artifact disappeared mid-write.");
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      return refuse(
        "symlinked_path",
        "a folder on the way to this file was replaced while Vex was preparing its "
          + "update, so nothing was written.",
      );
    }
    if (entry.dev !== recorded.dev || entry.ino !== recorded.ino) {
      return refuse(
        "symlinked_path",
        "a folder on the way to this file was replaced while Vex was preparing its "
          + "update, so nothing was written.",
      );
    }
  }
  return null;
}

export function isEnoent(cause: unknown): boolean {
  return (
    typeof cause === "object"
    && cause !== null
    && (cause as { code?: unknown }).code === "ENOENT"
  );
}
