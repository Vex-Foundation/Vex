/**
 * OPEN A FILE THAT MIGHT BE A TRAP, AND READ AT MOST WHAT YOU ASKED FOR.
 *
 * Two callers in this feature read a file whose path was derived from a
 * directory a user, their editor and every tool they run can write to:
 * `read.ts` reads a file for the viewer, and `excludes.ts` reads a
 * `.gitignore`. Both face the same two hazards, and this module owns the
 * answer to both so there is one copy of it rather than two that drift.
 *
 *  - A SYMLINK. The file may be a link pointing anywhere - `~/.ssh/id_rsa`, a
 *    device node, a FIFO. `O_NOFOLLOW` on the open makes that `ELOOP` instead
 *    of a read outside the project, on the one component a containment walk
 *    cannot hold still between its last `lstat` and this open.
 *  - A FILE THAT NEVER ANSWERS. `O_NOFOLLOW` refuses a link to a FIFO, but a
 *    `.gitignore` that IS a FIFO is not a link and passes it. Opening a FIFO
 *    with no writer BLOCKS in `open(2)` forever, and because `fs.promises.open`
 *    runs on the libuv threadpool that is one of four default pool threads
 *    parked for the life of the process; four such files starve every other
 *    filesystem operation Vex makes. Measured on Linux 6.18 with node's own
 *    `open`: the flags below without `O_NONBLOCK` never returned (killed at
 *    10 s), with it the open returned in 1 ms. So the open is NON-BLOCKING and
 *    the handle is `fstat`ed BEFORE a byte is read: anything that is not a
 *    REGULAR FILE is refused without reading it. `O_NONBLOCK` is inert on a
 *    regular file, which is the only kind this reader will go on to read.
 *  - AN UNBOUNDED LENGTH. `readFile` reads the whole file into memory and THEN
 *    lets the caller compare its length to a limit, which is a limit that has
 *    already been exceeded by the time it is checked. A link to a huge file or
 *    to `/dev/zero` is unbounded main-process memory. So the bound is enforced
 *    on bytes actually read from the handle: at most `maxBytes + 1` are read,
 *    and the arrival of that one extra byte is the PROOF the file is over the
 *    bound, established without ever holding the rest of it.
 *
 * `read.ts` keeps its own body: the viewer's read interleaves a binary sniff
 * that CANCELS the read, a fatal UTF-8 decode and a content hash, and folding
 * those into a shared helper would either bloat this contract or flatten
 * semantics the viewer needs. What is shared is the part that is a security
 * property rather than a product decision, which is exactly the part that must
 * not exist twice.
 */

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

/**
 * Read-only, never through a link on the final component, and never blocking.
 *
 * `O_NONBLOCK` is what makes a FIFO with no writer an instant open instead of a
 * parked threadpool thread; `?? 0` degrades on a platform that does not define
 * a flag, exactly as the `O_NOFOLLOW` note in `read.ts` describes.
 */
const BOUNDED_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/**
 * What a bounded read turned out to be.
 *
 * `absent` deliberately covers BOTH "there is no such file" and "the file is a
 * symbolic link this process will not follow". For an ignore file that is the
 * same answer twice: a rule set you may not read is a rule set that does not
 * apply, and inventing a third outcome would ask every caller to decide a
 * question with one safe answer.
 */
export type BoundedTextRead =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "oversize" }
  | { readonly kind: "error"; readonly cause: unknown };

/**
 * Read a small text file, refusing a link and stopping at the bound.
 *
 * Decoding is LENIENT: this is used for advisory rule files, nothing is written
 * back, and a replaced byte can only change which rows a tree hides. A caller
 * that needs the bytes to be honest UTF-8 owns that decision itself.
 */
export async function readTextFileBounded(
  absolutePath: string,
  maxBytes: number,
): Promise<BoundedTextRead> {
  let handle;
  try {
    handle = await open(absolutePath, BOUNDED_READ_FLAGS);
  } catch (cause) {
    const code = typeof cause === "object" && cause !== null
      ? (cause as { code?: unknown }).code
      : undefined;
    // ENOENT: not there. ELOOP: there, and a link `O_NOFOLLOW` refused.
    if (code === "ENOENT" || code === "ELOOP") return { kind: "absent" };
    return { kind: "error", cause };
  }

  try {
    // WHAT DID THE OPEN ACTUALLY GET? The flags proved it is not a link and
    // that the open would not park, but they do not prove it is a file. A FIFO,
    // a device or a socket named `.gitignore` is not a rule set, and reading
    // one is either meaningless or unbounded. `absent` is the same answer this
    // module already gives a link, for the same reason: a rule set this process
    // will not read is a rule set that does not apply.
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: "absent" };

    // ONE BYTE PAST THE BOUND, deliberately: its arrival is what proves the
    // file is over the limit, measured on the handle rather than inferred from
    // a size somebody else reported.
    const ceiling = maxBytes + 1;
    const buffer = Buffer.allocUnsafe(ceiling);
    let total = 0;
    while (total < ceiling) {
      const chunk = await handle.read(buffer, total, ceiling - total, total);
      if (chunk.bytesRead === 0) break;
      total += chunk.bytesRead;
    }
    if (total > maxBytes) return { kind: "oversize" };
    return { kind: "text", text: buffer.subarray(0, total).toString("utf8") };
  } catch (cause) {
    return { kind: "error", cause };
  } finally {
    await handle.close().catch(() => {
      // The read already produced its outcome; a close failure must not replace
      // it, and the descriptor is released at process exit regardless.
    });
  }
}
