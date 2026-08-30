/**
 * THE EXCLUDE OWNER: one place decides what the tree does not show and what the
 * watcher does not report.
 *
 * Two mechanisms, and they are not interchangeable:
 *
 *  1. THE DEFAULT SET, `DEFAULT_FILE_EXCLUDE_DIRS`. Directory names that are
 *     never interesting and are frequently enormous. These go to the NATIVE
 *     watcher as its `ignore` option, which means the OS never delivers those
 *     events at all - measurably different from filtering afterwards, because a
 *     `node_modules` install produces tens of thousands of events per second
 *     and filtering them in JavaScript means receiving them first. Verified
 *     against @parcel/watcher 2.6.0 by probing the live subscription: with
 *     `ignore: ["**\/node_modules", "**\/node_modules/**"]` a write inside a
 *     nested `node_modules` produced NO event, while a sibling write did.
 *  2. IGNORE FILES, `.gitignore` and `.vexignore`, interpreted with the
 *     `ignore` package (7.0.6) for pattern SYNTAX and by this module for
 *     nesting SEMANTICS. These cannot go to the native watcher: they are
 *     discovered on disk, they change while we are running, and a rule can be
 *     negated deeper down. So they filter listings and emitted changes.
 *
 * ## Nesting semantics, which the `ignore` package does not own
 *
 * `ignore` answers "do THESE patterns match this path". Git's actual rule is
 * that patterns come from a CHAIN of files - the repository root's, then each
 * subdirectory's - each relative to its own directory, and the DEEPEST file
 * with an opinion wins, so a `!keep.log` in `logs/.gitignore` un-ignores a file
 * the root's `*.log` hid. That chaining is the semantics VS Code's
 * `ignoreFile.ts` implements over its own matcher, and it is what this module
 * implements over `ignore`.
 *
 * The default set is installed as the SHALLOWEST level in that chain rather
 * than as a hard filter, which is what makes it a default instead of a law: a
 * user who writes `!dist` in their own `.vexignore` gets to see `dist`. The
 * native watcher's ignore list is the one exception and is documented as such -
 * un-hiding `node_modules` in the tree does not start watching it, because the
 * OS cost of that is not the user's to spend by accident.
 *
 * ## Bounded
 *
 * An ignore file over `IGNORE_FILE_MAX_BYTES` is not read, and the fact is
 * carried on the chain rather than swallowed: `oversizeIgnoreFiles` names every
 * one that was skipped, so a listing can say why a rule the user wrote is not
 * taking effect instead of appearing to ignore it.
 *
 * ## What is NOT here, and why
 *
 * There is no `setExcludes` channel in stage B3a. A user-editable exclude list
 * is a SETTING, and a setting needs an owner that answers where it persists
 * (per project or per install), who may change it, and what happens to a live
 * watcher when it does. Shipping a mutation before those answers exist would
 * put a settings owner in this module by accident. The `.vexignore` file is the
 * user's editable surface in the meantime, and it is a better one: it lives
 * with the project and travels with it.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import ignore from "ignore";

import { log } from "../../logger/index.js";
import { describeFileFailure, isEnoentLike } from "./node-path.js";

/**
 * `ignore` uses a CJS `export =`, so its `Ignore` interface is a namespace
 * member rather than a named export. Deriving the type from the factory is the
 * one form that works under both module settings and stays correct if the
 * package renames it.
 */
type Ignore = ReturnType<typeof ignore>;

/**
 * Directory names hidden by default, and never delivered by the native watcher.
 *
 * Chosen because each is machine-generated, is regenerated wholesale, and is
 * routinely larger than everything a user actually wrote. `.git` is here for a
 * second reason as well: a single commit rewrites hundreds of files under it,
 * and a tree that redraws on every commit is a tree nobody can work in.
 *
 * `build` and `out` are DELIBERATELY ABSENT. Both are ordinary SOURCE directory
 * names as often as they are output ones - this repository keeps
 * `vex-app/build/afterPack.mjs`, a hand-written source file, in a `build/`
 * directory - and there is no UI yet that lets a user un-hide an excluded
 * entry, so a default that guessed wrong would hide a user's own code with no
 * way back. A project whose `build` really is output already says so in its own
 * `.gitignore`, which this module honours through the ignore chain below.
 */
export const DEFAULT_FILE_EXCLUDE_DIRS: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  "target",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".gradle",
  ".idea",
  ".DS_Store",
];

/** The ignore files this feature reads, shallowest meaning first. */
export const IGNORE_FILE_NAMES: readonly string[] = [".gitignore", ".vexignore"];

/**
 * The largest ignore file that will be read.
 *
 * 256 KiB. A `.gitignore` is a few kilobytes; something three orders of
 * magnitude larger is not a rule list, and compiling it into a matcher on the
 * path of every directory listing is work with no upside. A file over the bound
 * is NAMED on the chain rather than dropped silently.
 */
export const IGNORE_FILE_MAX_BYTES = 256 * 1024;

/**
 * The native watcher's ignore list.
 *
 * Two globs per name because @parcel/watcher matches the ENTRY and the entries
 * BENEATH it separately - probed, not assumed. Without the bare form the
 * directory's own create/delete still arrives; without the `/**` form
 * everything inside it does.
 */
export function nativeWatcherIgnores(): string[] {
  const patterns: string[] = [];
  for (const name of DEFAULT_FILE_EXCLUDE_DIRS) {
    patterns.push(`**/${name}`, `**/${name}/**`);
  }
  return patterns;
}

/** One level of the chain: the rules declared at one directory. */
interface IgnoreLevel {
  /** Project-relative POSIX directory this level's patterns are relative to. */
  readonly directory: string;
  readonly matcher: Ignore;
}

/**
 * A resolved chain, root-first.
 *
 * Immutable once built. A chain is built for a directory listing and thrown
 * away, so a `.gitignore` the user edits takes effect on the next listing
 * rather than needing an invalidation protocol. That is the correct trade for a
 * tree: listings are user-paced and re-reading a handful of small files is far
 * cheaper than owning a cache whose staleness the user would notice.
 */
export interface IgnoreChain {
  readonly levels: readonly IgnoreLevel[];
  /** Project-relative paths of ignore files that exceeded the byte bound. */
  readonly oversizeIgnoreFiles: readonly string[];
}

function defaultsLevel(): IgnoreLevel {
  const matcher = ignore();
  for (const name of DEFAULT_FILE_EXCLUDE_DIRS) matcher.add(name);
  return { directory: "", matcher };
}

async function readIgnoreFile(
  absoluteDirectory: string,
  name: string,
): Promise<{ text: string | null; oversize: boolean }> {
  const target = path.join(absoluteDirectory, name);
  try {
    const bytes = await readFile(target);
    if (bytes.byteLength > IGNORE_FILE_MAX_BYTES) {
      return { text: null, oversize: true };
    }
    // A malformed byte in an ignore file is not worth refusing a whole listing
    // over, and a lenient decode here cannot corrupt anything: nothing is
    // written back, and a replaced byte can only affect which rows are hidden.
    return { text: bytes.toString("utf8"), oversize: false };
  } catch (cause) {
    if (!isEnoentLike(cause)) {
      log.warn(
        `[studio:files] an ignore file could not be read ${describeFileFailure(cause)}`,
      );
    }
    return { text: null, oversize: false };
  }
}

/**
 * Build the chain that governs entries directly inside `relativeDirectory`.
 *
 * Reads the ignore files at the project root and at every directory on the way
 * down, INCLUDING `relativeDirectory` itself, because a `.gitignore` sitting in
 * a folder governs that folder's own children.
 */
export async function buildIgnoreChain(
  projectDirectory: string,
  relativeDirectory: string,
): Promise<IgnoreChain> {
  const levels: IgnoreLevel[] = [defaultsLevel()];
  const oversize: string[] = [];
  const segments = relativeDirectory === "" ? [] : relativeDirectory.split("/");

  for (let depth = 0; depth <= segments.length; depth += 1) {
    const relative = segments.slice(0, depth).join("/");
    const absolute = path.join(projectDirectory, ...segments.slice(0, depth));
    const matcher = ignore();
    let declared = false;
    for (const name of IGNORE_FILE_NAMES) {
      const read = await readIgnoreFile(absolute, name);
      if (read.oversize) {
        oversize.push(relative === "" ? name : `${relative}/${name}`);
        continue;
      }
      if (read.text === null) continue;
      matcher.add(read.text);
      declared = true;
    }
    if (declared) levels.push({ directory: relative, matcher });
  }

  return { levels, oversizeIgnoreFiles: oversize };
}

/**
 * Is this project-relative path hidden?
 *
 * Levels are consulted ROOT-FIRST and the LAST one with an opinion wins, which
 * is git's rule and the reason a deeper `!pattern` can un-hide something a
 * shallower file hid. A level whose directory does not contain the path has no
 * opinion at all - it is not consulted with a path outside its scope, because
 * `ignore` would interpret the leading `../` as a pattern miss rather than as
 * "not mine", and a miss reads as "not ignored", which would silently defeat
 * every level above it.
 *
 * `isDirectory` matters: git's `dist/` matches a directory and not a file of
 * the same name, and `ignore` expresses that by being given a trailing slash.
 */
export function isPathIgnored(
  chain: IgnoreChain,
  relativePath: string,
  isDirectory: boolean,
): boolean {
  let ignored = false;
  for (const level of chain.levels) {
    const scoped = relativeTo(level.directory, relativePath);
    if (scoped === null) continue;
    const candidate = isDirectory ? `${scoped}/` : scoped;
    const verdict = level.matcher.test(candidate);
    if (verdict.ignored) ignored = true;
    else if (verdict.unignored) ignored = false;
  }
  return ignored;
}

/** `null` when `relativePath` is not inside `directory`. */
function relativeTo(directory: string, relativePath: string): string | null {
  if (directory === "") return relativePath === "" ? null : relativePath;
  const prefix = `${directory}/`;
  if (!relativePath.startsWith(prefix)) return null;
  const remainder = relativePath.slice(prefix.length);
  return remainder === "" ? null : remainder;
}
