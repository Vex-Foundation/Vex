/**
 * The backdrop BYTE store - the only place in the app that holds the user's
 * wallpaper bytes.
 *
 * Bytes live under `CONFIG_DIR/shell-backdrop/`, one file, named from the
 * opaque `bg_<32 hex>` id alone with a neutral `.bin` extension. The METADATA
 * (mime, size) is NOT here: it lives in the `shell.backdrop` pointer of
 * `preferences.json`, written by the service AFTER the bytes were proven, so
 * there is exactly one record of what the backdrop IS and this module only
 * answers "give me the bytes for this id".
 *
 * Copied from the image locker's `main/images/byte-store.ts` pattern rather
 * than shared with it (brief section 4.1): the locker's directory has a launch
 * lifecycle (delete refused while an intent references an image) and this one
 * has none, so the two must not be reachable through one resolver.
 *
 * WHY THERE IS NO PATH PARAMETER ANYWHERE PUBLIC: every entry point takes an
 * id, never a path. The renderer cannot supply a path (main owns the picker),
 * and an id is anchored with no `/`, `\` or `.`, so it cannot be a relative
 * path segment. `resolveBackdropPath` still re-derives and re-checks
 * containment before touching the disk: the id pattern is the design,
 * containment is the proof, and a traversal test pins both.
 *
 * WRITE-THEN-RENAME. Bytes land in `<id>.bin.tmp` and are renamed into place,
 * so a crash mid-write leaves a temp file (swept by `listStoredBackdrops`'s owner)
 * and never a half-written `.bin` that a later reader could take for an image.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SHELL_BACKDROP_ID_PATTERN } from "@shared/schemas/shell-backdrop.js";
import { CONFIG_DIR } from "../paths/config-dir.js";

/**
 * Defined here rather than in `paths/config-dir.ts` because this directory is
 * an implementation detail of the backdrop: nothing outside this folder may
 * derive a path into it.
 */
export const SHELL_BACKDROP_DIR = path.join(CONFIG_DIR, "shell-backdrop");

const STORED_SUFFIX = ".bin";
const PENDING_SUFFIX = ".bin.tmp";

/** Thrown when an id could name something outside the backdrop directory. */
export class BackdropPathEscapeError extends Error {
  override readonly name = "BackdropPathEscapeError";
  constructor() {
    super("Refusing to resolve a backdrop path outside the backdrop directory.");
  }
}

/** Mint a fresh opaque id. 128 bits of randomness, never derived from the file. */
export function newShellBackdropId(): string {
  return `bg_${randomBytes(16).toString("hex")}`;
}

/**
 * Map an opaque id to its file. Two independent gates, on purpose:
 *  1. the id must match the anchored `bg_<32 hex>` pattern;
 *  2. the resolved absolute path must still sit directly inside the backdrop
 *     directory.
 * Gate 2 cannot fail while gate 1 holds, which is exactly why it is worth
 * asserting: if a future change loosens the id format, this throws instead of
 * quietly reading or deleting an arbitrary file.
 */
export function resolveBackdropPath(imageId: string): string {
  return resolveStoredPath(imageId, STORED_SUFFIX);
}

function resolveStoredPath(imageId: string, suffix: string): string {
  if (!SHELL_BACKDROP_ID_PATTERN.test(imageId)) throw new BackdropPathEscapeError();
  const resolved = path.resolve(SHELL_BACKDROP_DIR, `${imageId}${suffix}`);
  if (path.dirname(resolved) !== path.resolve(SHELL_BACKDROP_DIR)) {
    throw new BackdropPathEscapeError();
  }
  return resolved;
}

/**
 * Write proven bytes for a fresh id: temp file first, then an atomic rename
 * into the final name. A failure on either step removes the temp file and
 * propagates, so the directory never holds a `.bin` that was not fully
 * written.
 */
export async function writeBackdropBytes(imageId: string, bytes: Uint8Array): Promise<void> {
  const target = resolveBackdropPath(imageId);
  const pending = resolveStoredPath(imageId, PENDING_SUFFIX);
  await mkdir(SHELL_BACKDROP_DIR, { recursive: true });
  try {
    await writeFile(pending, bytes);
    await rename(pending, target);
  } catch (cause) {
    await rm(pending, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/**
 * Read stored bytes. `null` means "no such file", an expected answer the
 * caller acts on by name. Any OTHER failure propagates, because "the store is
 * broken" must not be reported as "there is no backdrop".
 */
export async function readBackdropBytes(
  imageId: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    // A fresh, exactly-sized ArrayBuffer (never Node's pooled slab), so the
    // protocol route can hand `.buffer` to a Response as the whole body.
    return new Uint8Array(await readFile(resolveBackdropPath(imageId)));
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }
}

/** Remove stored bytes. Idempotent: deleting an absent file is a success. */
export async function removeBackdropBytes(imageId: string): Promise<void> {
  await rm(resolveBackdropPath(imageId), { force: true });
}

/**
 * Every id that has a fully written `.bin` in the directory, plus every
 * pending temp file left by an interrupted write. The service reconciles
 * both against the pointer of record: a `.bin` the pointer does not name is
 * an orphan from a crash between write and commit, and a `.tmp` is always
 * garbage. A missing directory is an empty store, not a failure.
 */
export async function listStoredBackdrops(): Promise<{
  readonly ids: ReadonlyArray<string>;
  readonly pendingFiles: ReadonlyArray<string>;
}> {
  let entries: string[];
  try {
    entries = await readdir(SHELL_BACKDROP_DIR);
  } catch (cause) {
    if (isMissingFile(cause)) return { ids: [], pendingFiles: [] };
    throw cause;
  }
  const ids: string[] = [];
  const pendingFiles: string[] = [];
  for (const entry of entries) {
    if (entry.endsWith(PENDING_SUFFIX)) {
      pendingFiles.push(entry);
      continue;
    }
    if (!entry.endsWith(STORED_SUFFIX)) continue;
    const id = entry.slice(0, entry.length - STORED_SUFFIX.length);
    if (SHELL_BACKDROP_ID_PATTERN.test(id)) ids.push(id);
  }
  return { ids, pendingFiles };
}

/**
 * Remove an interrupted write's temp file by the NAME `listStoredBackdrops`
 * reported. The name is re-derived from its id through the same two gates as
 * every other path here, so a directory entry that does not parse as
 * `<id>.bin.tmp` is ignored rather than resolved.
 */
export async function removePendingBackdropFile(fileName: string): Promise<void> {
  if (!fileName.endsWith(PENDING_SUFFIX)) return;
  const id = fileName.slice(0, fileName.length - PENDING_SUFFIX.length);
  if (!SHELL_BACKDROP_ID_PATTERN.test(id)) return;
  await rm(resolveStoredPath(id, PENDING_SUFFIX), { force: true });
}

function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}
