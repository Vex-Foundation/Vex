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
 *   - CONTAINMENT IS REVALIDATED AFTER RESOLUTION. Between the path walk and
 *     the write, a directory on the way could have been swapped for a symlink.
 *     The write re-derives the path and re-checks it is inside the project.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { StudioRefusalReason } from "@shared/schemas/studio-installer.js";
import { log } from "../../logger/index.js";
import {
  STUDIO_ARTIFACT_MAX_BYTES,
  isEnoent,
  isInside,
} from "./paths.js";

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
    log.warn(`[studio:installer] could not read ${relativeLabel}`, cause);
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
    log.warn(`[studio:installer] could not create the folder for ${relativeLabel}`, cause);
    return {
      kind: "refused",
      reason: "io_error",
      detail: `The folder for "${relativeLabel}" could not be created.`,
    };
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
    const handle = await open(tempPath, "wx", options.mode ?? 0o644);
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
    await rename(tempPath, absolutePath);
  } catch (cause) {
    await discardTemp(tempPath);
    log.warn(`[studio:installer] could not write ${relativeLabel}`, cause);
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
      log.warn("[studio:installer] a temporary installer file could not be removed", cause);
    }
  }
}

function randomSuffix(): string {
  return createHash("sha256")
    .update(`${String(Date.now())}:${String(Math.random())}`)
    .digest("hex")
    .slice(0, 8);
}
