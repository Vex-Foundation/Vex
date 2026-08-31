/**
 * Reading and replacing ONE artifact file, safely, inside a folder the user
 * also owns.
 *
 * `paths.ts` decided the path is confined. This module owns what happens once
 * it is opened, and every rule here exists because the file belongs to somebody
 * else:
 *
 *   - MALFORMED UTF-8 REFUSES. Node's default decoding replaces invalid bytes
 *     with U+FFFD, so a lenient read followed by a write would silently corrupt
 *     a file it never understood. The decoder is `fatal`, and the refusal names
 *     the file.
 *   - REPLACEMENT IS ATOMIC AND SAME-DIRECTORY. The temp file is created with
 *     `wx` (exclusive) in the TARGET's own directory, so the final `rename` is
 *     an atomic same-filesystem operation and a crash mid-write leaves either
 *     the old bytes or the new ones - never half a config. A temp file in the
 *     OS temp directory would make the rename a cross-device copy, which is not
 *     atomic and would also move the file off the volume the user's permissions
 *     and quotas apply to.
 *   - MODE IS PRESERVED. A replaced file keeps the mode it had. A user who
 *     chmod-ed their config, or a repo on a umask that matters, does not have
 *     that quietly reset by Vex.
 *   - THE SOURCE HASH IS VERIFIED IMMEDIATELY BEFORE THE RENAME. The read, the
 *     parse and the render take time, and another process (the user's editor,
 *     a formatter, another agent) can write in that window. Replacing then
 *     would destroy an edit that was made after we looked. So the file is
 *     re-read and re-hashed at the last possible moment and the replacement
 *     REFUSES with `source_changed` if anything moved. This is optimistic
 *     concurrency, not a lock: it cannot stop a write that lands between the
 *     check and the rename, but it closes the window that actually matters -
 *     the whole render - down to microseconds.
 *   - CONTAINMENT IS REVALIDATED AFTER RESOLUTION, AND THE PARENT CHAIN'S
 *     IDENTITY IS RE-CHECKED IMMEDIATELY BEFORE THE RENAME. Between the path
 *     walk and the write, a directory on the way could be swapped for a symlink.
 *     A lexical containment check cannot see that - the path string is
 *     unchanged - so the chain from the project root down to the artifact's
 *     folder is captured as `dev`+`ino` after `mkdir` and compared again
 *     microseconds before the one irreversible syscall. The temp file is opened
 *     `O_EXCL|O_NOFOLLOW`.
 *
 *     THE RESIDUAL, STATED PLAINLY: `rename(2)` re-resolves its path from the
 *     root and Node exposes no `renameat`/`openat2`, so the microseconds between
 *     the final check and the rename are NOT covered. An attacker who can
 *     already write inside the project folder and wins that race can still
 *     redirect the final rename. What the pair does close is the whole
 *     read-parse-render window, which is where a real editor or formatter
 *     actually writes. See `captureDirectoryChain` in `paths.ts`.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { StudioRefusalReason } from "@shared/schemas/studio-installer.js";
import { log } from "../../logger/index.js";
import {
  STUDIO_ARTIFACT_MAX_BYTES,
  captureDirectoryChain,
  isEnoent,
  isInside,
  verifyDirectoryChain,
} from "./paths.js";

/**
 * `wx` plus `O_NOFOLLOW`: create exclusively, and never through a link.
 *
 * `O_NOFOLLOW` is POSIX and absent on Windows, where `fsConstants` simply does
 * not define it; `?? 0` degrades to plain `wx` there rather than emitting a
 * `NaN` flag word. On Windows the attack this defends against needs a symlink
 * the user must be privileged to create in the first place.
 */
const TEMP_FILE_FLAGS = fsConstants.O_WRONLY
  | fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | (fsConstants.O_NOFOLLOW ?? 0);

/** What is currently at an artifact path. */
export type ConfinedRead =
  | { readonly kind: "absent" }
  | {
    readonly kind: "file";
    readonly text: string;
    /** SHA-256 of the exact bytes read, hex. */
    readonly hash: string;
    readonly mode: number | null;
  }
  | {
    readonly kind: "refused";
    readonly reason: StudioRefusalReason;
    readonly detail: string;
  };

/** The outcome of one replacement attempt. */
export type ConfinedWrite =
  | { readonly kind: "written"; readonly hash: string }
  | {
    readonly kind: "refused";
    readonly reason: StudioRefusalReason;
    readonly detail: string;
  };

/** SHA-256, hex. One digest function for provenance, drift and the source check. */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The ONLY thing this module is allowed to say about a filesystem failure.
 *
 * A raw Node `fs` error carries `message`, `path`, `dest` and `syscall`, and the
 * path fields are ABSOLUTE - they name the user's home directory, their folder
 * layout, and often their username. Logs travel: they reach the log file, a
 * support bundle and Sentry. So a failure is reported as the closed pair the
 * operator can actually act on - the error's class name and its `errno` code -
 * beside the REPO-RELATIVE artifact label the caller already owns. Anything the
 * code cannot classify becomes `unknown`, never the payload.
 */
export function describeIoFailure(cause: unknown): string {
  if (!(typeof cause === "object" && cause !== null)) return "name=unknown code=unknown";
  const name = (cause as { name?: unknown }).name;
  const code = (cause as { code?: unknown }).code;
  return `name=${typeof name === "string" ? name : "unknown"} `
    + `code=${typeof code === "string" ? code : "unknown"}`;
}

/**
 * Read an artifact file as UTF-8, refusing anything Vex should not rewrite.
 *
 * `relativeLabel` is the repo-relative path used in user-facing detail text.
 * Absolute paths never travel to the renderer, so the label is what a refusal
 * names.
 */
export async function readConfinedFile(
  absolutePath: string,
  relativeLabel: string,
  mode: number | null,
): Promise<ConfinedRead> {
  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch (cause) {
    if (isEnoent(cause)) return { kind: "absent" };
    log.warn(
      `[studio:installer] could not read ${relativeLabel} ${describeIoFailure(cause)}`,
    );
    return { kind: "refused", reason: "io_error", detail: `"${relativeLabel}" could not be read.` };
  }

  // Re-checked here as well as during the path walk: the file could have grown
  // between the two, and the bound must hold on the object actually consumed.
  if (bytes.byteLength > STUDIO_ARTIFACT_MAX_BYTES) {
    return {
      kind: "refused",
      reason: "too_large",
      detail:
        `"${relativeLabel}" is larger than the ${String(STUDIO_ARTIFACT_MAX_BYTES)}-byte `
        + "limit Vex will parse, so it was left untouched.",
    };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      kind: "refused",
      reason: "invalid_utf8",
      detail:
        `"${relativeLabel}" is not valid UTF-8. Vex will not rewrite a file it cannot `
        + "decode without losing bytes.",
    };
  }

  return { kind: "file", text, hash: hashText(text), mode };
}

/**
 * Replace (or create) an artifact file with `text`.
 *
 * `expectedHash` is the digest of the bytes the caller rendered FROM, or `null`
 * when the caller expects the file not to exist. A mismatch refuses; it never
 * overwrites.
 */
/**
 * DELETE a file Vex owns, under the same confinement and ownership discipline
 * as a replacement (stage B0 teardown).
 *
 * Deletion is the one operation in this module that cannot be undone by writing
 * different bytes, so it is the narrowest:
 *
 *   - CONTAINMENT is revalidated after resolution AND THE PARENT CHAIN'S
 *     IDENTITY IS CAPTURED AND RE-CHECKED IMMEDIATELY BEFORE THE UNLINK, through
 *     the same `captureDirectoryChain`/`verifyDirectoryChain` pair the
 *     replacement uses. A lexical containment check cannot see a directory that
 *     kept its name and became a symlink since the path walk, and that is
 *     precisely how a delete lands somewhere it was never meant to. A
 *     destructive operation must be at least as strict as a write, and until
 *     this pair was here it was strictly weaker.
 *
 *     THE RESIDUAL IS THE SAME ONE THE REPLACEMENT DOCUMENTS: `unlink(2)`
 *     re-resolves its path from the root and Node exposes no `unlinkat`, so the
 *     microseconds between the final check and the syscall are NOT covered. What
 *     the pair closes is the whole decide-read-verify window.
 *   - `expectedHash` IS THE OWNERSHIP PROOF. The file is re-read and digested
 *     immediately before the unlink, and a mismatch refuses with
 *     `source_changed`. The caller passes the digest of the bytes it just
 *     verified as Vex's own, so a file edited between the decision and this
 *     call is never removed. Passing `null` means "only if it does not exist",
 *     which is a no-op rather than an unconditional delete: there is no way to
 *     ask this function to remove a file whose contents nobody checked.
 *   - ENOENT IS SUCCESS. The obligation is that the file is not there, and it
 *     is not there.
 *
 * There is deliberately no directory removal. An empty `.vex/` left behind is
 * inert; removing directories walks into "whose directory is this" questions
 * that a teardown has no authority to answer.
 */
export async function deleteConfinedFile(options: {
  readonly projectDirectory: string;
  readonly absolutePath: string;
  readonly relativeLabel: string;
  readonly expectedHash: string | null;
}): Promise<ConfinedWrite> {
  const { absolutePath, relativeLabel } = options;

  if (!isInside(options.projectDirectory, absolutePath)) {
    return {
      kind: "refused",
      reason: "path_escape",
      detail: `"${relativeLabel}" no longer resolves inside the project folder.`,
    };
  }

  // THE PARENT CHAIN'S IDENTITY. Captured before the digest is read and
  // re-checked below, exactly as the replacement does around its rename.
  const directory = path.dirname(absolutePath);
  const captured = await captureDirectoryChain(options.projectDirectory, directory);
  if (captured.kind === "refused") {
    // A folder that is not there means the file is not there either, which is
    // the post-condition a delete owes. Every other refusal stands.
    if (captured.reason === "io_error" && !(await pathExists(directory))) {
      return { kind: "written", hash: hashText("") };
    }
    return { kind: "refused", reason: captured.reason, detail: captured.detail };
  }

  const current = await readCurrentDigest(absolutePath, relativeLabel);
  if (current.kind === "refused") return current;
  if (current.digest === null) {
    // Already gone. The post-condition holds, so this is not a failure.
    return { kind: "written", hash: hashText("") };
  }
  if (current.digest !== options.expectedHash) {
    return {
      kind: "refused",
      reason: "source_changed",
      detail:
        `"${relativeLabel}" changed on disk after Vex checked it, so it was left `
        + "in place. Remove it by hand if you no longer want it.",
    };
  }

  // THE LAST CHECK BEFORE THE ONE IRREVERSIBLE SYSCALL.
  const swapped = await verifyDirectoryChain(captured.chain);
  if (swapped !== null) {
    return { kind: "refused", reason: swapped.reason, detail: swapped.detail };
  }

  try {
    await unlink(absolutePath);
  } catch (cause) {
    if (isEnoent(cause)) return { kind: "written", hash: hashText("") };
    log.warn(
      `[studio:installer] could not remove ${relativeLabel} ` + describeIoFailure(cause),
    );
    return {
      kind: "refused",
      reason: "io_error",
      detail: `"${relativeLabel}" could not be removed.`,
    };
  }
  return { kind: "written", hash: hashText("") };
}

export async function replaceConfinedFile(options: {
  readonly projectDirectory: string;
  readonly absolutePath: string;
  readonly relativeLabel: string;
  readonly text: string;
  readonly expectedHash: string | null;
  readonly mode: number | null;
}): Promise<ConfinedWrite> {
  const { absolutePath, relativeLabel } = options;

  // Containment, revalidated after resolution. Cheap, and the one check that
  // catches a directory swapped for a symlink since the path walk.
  if (!isInside(options.projectDirectory, absolutePath)) {
    return {
      kind: "refused",
      reason: "path_escape",
      detail: `"${relativeLabel}" no longer resolves inside the project folder.`,
    };
  }

  const directory = path.dirname(absolutePath);
  try {
    await mkdir(directory, { recursive: true });
  } catch (cause) {
    log.warn(
      `[studio:installer] could not create the folder for ${relativeLabel} `
        + describeIoFailure(cause),
    );
    return {
      kind: "refused",
      reason: "io_error",
      detail: `The folder for "${relativeLabel}" could not be created.`,
    };
  }

  // THE PARENT CHAIN'S IDENTITY, captured after `mkdir` created whatever was
  // missing. Re-checked immediately before the rename; see
  // `captureDirectoryChain` for exactly what that pair does and does not close.
  const captured = await captureDirectoryChain(options.projectDirectory, directory);
  if (captured.kind === "refused") {
    return { kind: "refused", reason: captured.reason, detail: captured.detail };
  }

  // THE LAST-MOMENT SOURCE CHECK. Re-read and compare before anything is
  // renamed into place.
  const current = await readCurrentDigest(absolutePath, relativeLabel);
  if (current.kind === "refused") return current;
  if (current.digest !== options.expectedHash) {
    return {
      kind: "refused",
      reason: "source_changed",
      detail:
        `"${relativeLabel}" changed on disk while Vex was preparing its update, so `
        + "nothing was written. Run the repair again.",
    };
  }

  // Exclusive temp file in the target's OWN directory. `wx` fails rather than
  // reusing a file another run left behind, and the pid plus a random suffix
  // keeps two runs (or two Vex instances) from choosing the same name.
  const tempPath = path.join(
    directory,
    `.${path.basename(absolutePath)}.vex-${String(process.pid)}-${randomSuffix()}.tmp`,
  );

  try {
    // O_NOFOLLOW on the temp file's own final component. O_EXCL already refuses
    // an existing name (a symlink included), so this is the second lock on the
    // same door - and it is the only no-follow guarantee Node can give us, since
    // `rename` has no such flag and re-resolves its path from the root.
    const handle = await open(tempPath, TEMP_FILE_FLAGS, options.mode ?? 0o644);
    try {
      await handle.writeFile(options.text, "utf8");
      // Durable before the rename: a rename of a file whose contents are still
      // in the page cache can survive a crash as an empty file on some systems.
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.mode !== null) {
      // `open` applies the umask to its mode argument, so the preserved mode is
      // set explicitly afterwards rather than trusted from creation.
      await applyMode(tempPath, options.mode);
    }

    // THE LAST CHECK BEFORE THE ONE IRREVERSIBLE SYSCALL. Everything above took
    // time - a read, a digest, a write, an fsync - and `rename` resolves its
    // path string afresh. If any directory on the way became a different
    // directory in that window, the rename would land outside the project.
    const swapped = await verifyDirectoryChain(captured.chain);
    if (swapped !== null) {
      await discardTemp(tempPath);
      return { kind: "refused", reason: swapped.reason, detail: swapped.detail };
    }
    await rename(tempPath, absolutePath);
  } catch (cause) {
    await discardTemp(tempPath);
    log.warn(
      `[studio:installer] could not write ${relativeLabel} ${describeIoFailure(cause)}`,
    );
    return {
      kind: "refused",
      reason: "io_error",
      detail: `"${relativeLabel}" could not be written. Check the folder's permissions.`,
    };
  }

  return { kind: "written", hash: hashText(options.text) };
}

async function readCurrentDigest(
  absolutePath: string,
  relativeLabel: string,
): Promise<{ kind: "ok"; digest: string | null } | { kind: "refused"; reason: StudioRefusalReason; detail: string }> {
  try {
    const bytes = await readFile(absolutePath);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        kind: "refused",
        reason: "invalid_utf8",
        detail: `"${relativeLabel}" is no longer valid UTF-8; nothing was written.`,
      };
    }
    return { kind: "ok", digest: hashText(text) };
  } catch (cause) {
    if (isEnoent(cause)) return { kind: "ok", digest: null };
    return {
      kind: "refused",
      reason: "io_error",
      detail: `"${relativeLabel}" could not be re-read before the update.`,
    };
  }
}

/** `lstat`, never `stat`: a dangling symlink is still something being there. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function applyMode(target: string, mode: number): Promise<void> {
  const handle = await open(target, "r+");
  try {
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

/** Best-effort cleanup. A failure here must not hide the primary cause. */
async function discardTemp(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath);
  } catch (cause) {
    if (!isEnoent(cause)) {
      log.warn(
        "[studio:installer] a temporary installer file could not be removed "
          + describeIoFailure(cause),
      );
    }
  }
}

function randomSuffix(): string {
  return createHash("sha256")
    .update(`${String(Date.now())}:${String(Math.random())}`)
    .digest("hex")
    .slice(0, 8);
}
