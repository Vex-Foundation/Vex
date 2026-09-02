/**
 * OPEN A FILE THAT MIGHT BE A TRAP, AND READ AT MOST WHAT YOU ASKED FOR.
 *
 * Two callers in this feature read a file whose path was derived from a
 * directory a user, their editor and every tool they run can write to:
 * `read.ts` reads a file for the viewer, and `excludes.ts` reads a
 * `.gitignore`. Both face the same hazards. The SYMLINK half of the answer
 * lives in `no-follow-open.ts`, which is the single owner of "this handle is
 * the regular file that path named"; what this module owns is the BOUND.
 *
 *  - A SYMLINK, or a file swapped for another between the walk and the open.
 *    `openWithoutFollowing` refuses a standing link before opening and refuses
 *    a link or an identity change after opening, before a byte is read. This
 *    module never sees a handle that failed either check.
 *  - A FILE THAT NEVER ANSWERS. A `.gitignore` that IS a FIFO is not a link.
 *    Opening a FIFO with no writer BLOCKS in `open(2)` forever, and because
 *    `fs.promises.open` runs on the libuv threadpool that is one of four
 *    default pool threads parked for the life of the process; four such files
 *    starve every other filesystem operation Vex makes. Measured on Linux 6.18
 *    with node's own `open`: the flags without `O_NONBLOCK` never returned
 *    (killed at 10 s), with it the open returned in 1 ms. `openWithoutFollowing`
 *    keeps that flag and refuses everything that is not a regular file.
 *  - AN UNBOUNDED LENGTH, which is this module's own responsibility.
 *    `readFile` reads the whole file into memory and THEN lets the caller
 *    compare its length to a limit, which is a limit that has already been
 *    exceeded by the time it is checked. A link to a huge file or to
 *    `/dev/zero` is unbounded main-process memory. So the bound is enforced on
 *    bytes actually read from the handle: at most `maxBytes + 1` are read, and
 *    the arrival of that one extra byte is the PROOF the file is over the
 *    bound, established without ever holding the rest of it.
 *
 * `read.ts` keeps its own body: the viewer's read interleaves a binary sniff
 * that CANCELS the read, a fatal UTF-8 decode and a content hash, and folding
 * those into a shared helper would either bloat this contract or flatten
 * semantics the viewer needs. What is shared is the part that is a security
 * property rather than a product decision, which is exactly the part that must
 * not exist twice.
 */

import { type NoFollowFs, nodeNoFollowFs, openWithoutFollowing } from "./no-follow-open.js";

/**
 * What a bounded read turned out to be.
 *
 * `absent` deliberately covers BOTH "there is no such file" and "the file is a
 * symbolic link this process will not follow". For an ignore file that is the
 * same answer twice: a rule set you may not read is a rule set that does not
 * apply, and inventing a third outcome would ask every caller to decide a
 * question with one safe answer.
 *
 * `changed` is NOT folded into `absent`, because it is not the same fact: the
 * file was there and was replaced while it was being opened. It gets its own
 * member so the caller can say so once rather than silently dropping a rule set
 * that does exist.
 */
export type BoundedTextRead =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "changed" }
  | { readonly kind: "oversize" }
  | { readonly kind: "error"; readonly cause: unknown };

/**
 * Read a small text file, refusing a link and stopping at the bound.
 *
 * Decoding is LENIENT: this is used for advisory rule files, nothing is written
 * back, and a replaced byte can only change which rows a tree hides. A caller
 * that needs the bytes to be honest UTF-8 owns that decision itself.
 *
 * `fs` is the injectable filesystem seam owned by `no-follow-open.ts`; only
 * tests pass one, and only to make a race deterministic.
 */
export async function readTextFileBounded(
  absolutePath: string,
  maxBytes: number,
  fs: NoFollowFs = nodeNoFollowFs,
): Promise<BoundedTextRead> {
  const opened = await openWithoutFollowing(absolutePath, fs);
  if (!opened.ok) {
    // A link, a FIFO and an absent file are the same answer for a rule set:
    // one this process will not read is one that does not apply.
    if (
      opened.reason === "not_found"
      || opened.reason === "symlinked_path"
      || opened.reason === "not_a_file"
    ) {
      return { kind: "absent" };
    }
    if (opened.reason === "path_changed") return { kind: "changed" };
    return { kind: "error", cause: opened.cause };
  }

  const handle = opened.handle;
  try {
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
