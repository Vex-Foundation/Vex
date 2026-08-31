/**
 * READING ONE FILE FOR THE VIEWER, with every bound enforced on the thing
 * actually consumed.
 *
 * ## The size bound is on the HANDLE, not on a `stat`
 *
 * The obvious implementation stats the file, compares the size to the limit,
 * and then reads it. That check is a lie in two directions. A file can GROW
 * between the stat and the read - a log being appended to is the ordinary case,
 * not a contrived one - so the "checked" read can return far more than the
 * limit. And on a filesystem where `stat` reports a size the file does not have
 * (`/proc`, some network mounts), the check is meaningless in both directions.
 *
 * So the file is OPENED, and the bound is enforced on bytes actually read from
 * that handle: at most `FILE_READ_MAX_BYTES + 1` are read, and the presence of
 * that one extra byte is what proves the file is over the limit. The real size
 * reported in the refusal comes from `fstat` ON THE OPEN HANDLE, which is the
 * same object the bytes came from - not from a second `stat` of a path that may
 * name something else by now.
 *
 * ## A file over the bound is REFUSED, never truncated
 *
 * `too_large` carries the real size so the UI can say "12 MB, larger than the
 * 2 MB the viewer will open", and that size is the LARGER of what `fstat` said
 * and what the handle actually produced: the fstat ran first and a growing file
 * can outrun it, while a byte already read cannot become unread. Serving the first 2 MB and rendering it as if it
 * were the file is exactly the silent cut the repository forbids: the reader
 * cannot tell what was left out or how to get it.
 *
 * ## The binary sniff CANCELS the read
 *
 * The first `FILE_BINARY_SNIFF_BYTES` are examined for a NUL byte before the
 * rest is read, which is what VS Code's text-file service does. A NUL means the
 * remaining bytes are never read at all - the point is to avoid pulling
 * megabytes of a video file through the IPC channel to display mojibake, and a
 * sniff that ran after the read would avoid nothing.
 *
 * ## `O_NOFOLLOW` on the final component
 *
 * `resolveNodePath` already refused every intermediate symlink and reported a
 * final one as a link the tree may show but not open. This flag closes the
 * race between that walk and this open on the one component the walk cannot
 * hold still. It is POSIX-only; on Windows `fsConstants` does not define it and
 * `?? 0` degrades to a plain read-only open, where creating the symlink the
 * flag defends against requires a privilege the attacker would not need to
 * have.
 *
 * ## `fatal` UTF-8
 *
 * A lenient decode replaces malformed bytes with U+FFFD, so a file the viewer
 * cannot honestly read would be shown as if it could, with silent corruption
 * scattered through it. The decoder is fatal and the refusal is `invalid_utf8`,
 * the same posture `confined-fs.ts` takes before it rewrites a file.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

import {
  FILE_BINARY_SNIFF_BYTES,
  FILE_READ_MAX_BYTES,
  type FileContent,
  type FilesOutcome,
} from "@shared/schemas/files.js";

import { log } from "../../logger/index.js";
import { describeFileFailure, isEnoentLike } from "./node-path.js";

/** Read-only, and never through a link on the final component. */
const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * Read a file for the viewer.
 *
 * `absolutePath` has already been resolved and containment-checked. Every
 * refusal below is a typed outcome the UI renders as a statement about the
 * file, never as a failure of Vex.
 */
export async function readFileForViewer(options: {
  readonly nodeId: string;
  readonly relativePath: string;
  readonly absolutePath: string;
}): Promise<FilesOutcome<FileContent>> {
  let handle;
  try {
    handle = await open(options.absolutePath, READ_FLAGS);
  } catch (cause) {
    if (isEnoentLike(cause)) return { ok: false, code: "not_found" };
    const code = typeof cause === "object" && cause !== null
      ? (cause as { code?: unknown }).code
      : undefined;
    // `ELOOP` is what `O_NOFOLLOW` produces when the final component became a
    // symlink between the walk and this open. It is the race the flag exists
    // to catch, and it is reported as what it is rather than as an I/O error.
    if (code === "ELOOP") return { ok: false, code: "symlinked_path" };
    if (code === "EISDIR") return { ok: false, code: "not_a_file" };
    log.warn(
      `[studio:files] a file could not be opened ${describeFileFailure(cause)}`,
    );
    return { ok: false, code: "io_error" };
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { ok: false, code: "not_a_file" };

    // THE SNIFF, before the body. A NUL in the first bytes ends the read here.
    const sniffLength = Math.min(FILE_BINARY_SNIFF_BYTES, FILE_READ_MAX_BYTES + 1);
    const sniff = Buffer.allocUnsafe(sniffLength);
    const sniffRead = await handle.read(sniff, 0, sniffLength, 0);
    if (sniff.subarray(0, sniffRead.bytesRead).includes(0)) {
      return { ok: false, code: "binary", size: stats.size };
    }

    // THE BODY. One byte past the limit is read deliberately: its arrival is
    // the proof that the file is over the bound, measured on the handle rather
    // than inferred from a size somebody else reported.
    const ceiling = FILE_READ_MAX_BYTES + 1;
    const body = Buffer.allocUnsafe(ceiling);
    sniff.copy(body, 0, 0, sniffRead.bytesRead);
    let total = sniffRead.bytesRead;
    while (total < ceiling) {
      const chunk = await handle.read(body, total, ceiling - total, total);
      if (chunk.bytesRead === 0) break;
      total += chunk.bytesRead;
    }
    if (total > FILE_READ_MAX_BYTES) {
      // The size comes from the SAME handle these bytes came from - and the
      // BYTES READ are the floor under it. `fstat` ran before the read, and a
      // file being appended to between the two (a log, the ordinary case) has
      // an fstat size that is already stale and can be SMALLER than what was
      // actually read. Reporting that would tell the user their 3 MB file is
      // 1 MB and still refused. The count of bytes this handle produced can
      // never be stale, so it is the one that wins when the two disagree.
      return { ok: false, code: "too_large", size: Math.max(stats.size, total) };
    }

    const bytes = body.subarray(0, total);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, code: "invalid_utf8", size: total };
    }

    return {
      ok: true,
      value: {
        nodeId: options.nodeId,
        path: options.relativePath,
        text,
        size: total,
        modifiedMs: Math.trunc(stats.mtimeMs),
        hash: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  } catch (cause) {
    log.warn(`[studio:files] a file could not be read ${describeFileFailure(cause)}`);
    return { ok: false, code: "io_error" };
  } finally {
    await handle.close().catch(() => {
      // The read already produced its outcome; a close failure must not
      // replace it, and the descriptor is released when the process exits
      // regardless.
    });
  }
}
