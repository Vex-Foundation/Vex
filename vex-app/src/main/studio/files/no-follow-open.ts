/**
 * OPENING THE FINAL COMPONENT WITHOUT EVER READING THROUGH A LINK.
 *
 * Two readers in this feature open a path that lives inside a directory the
 * user, their editor and every tool they run can write to: `read.ts` opens a
 * file for the viewer and `bounded-read.ts` opens a `.gitignore`. Both need the
 * same property - the bytes that come out of the handle are the bytes of the
 * REGULAR FILE THAT PATH NAMED, not of whatever a symbolic link pointed at -
 * and this module is the single owner of that mechanism so it cannot exist in
 * two copies that drift.
 *
 * ## `O_NOFOLLOW` is NOT available everywhere, and the gap was measured
 *
 * The previous version of this code opened with `O_NOFOLLOW ?? 0` and recorded
 * the Windows fallback as harmless, on the reasoning that creating a symbolic
 * link there needs a privilege an attacker would not have. That reasoning is
 * FALSE and was disproved on a Windows CI runner: Node 22 does not define
 * `O_NOFOLLOW` on win32 (the open-constants table in the Node documentation
 * lists it as POSIX-only), `symlinkSync` SUCCEEDED unprivileged, and a
 * symlinked `.gitignore` was followed, read and applied. Windows Developer Mode
 * makes unprivileged symlink creation ordinary, and developer machines are
 * exactly this product's audience.
 *
 * ## What replaces the missing flag
 *
 * Not an equivalent - there is no `openat2` in Node, so nothing here is atomic.
 * What there is instead is a STANDING-LINK REFUSAL before the open plus
 * FAIL-CLOSED VERIFICATION after it, so that a link either never gets opened or
 * never gets read:
 *
 *  1. `lstat` the final component. A link that is simply THERE - the whole
 *     standing case, which is what a checked-out repository or a careless build
 *     actually produces - is refused BEFORE any handle exists. This is the step
 *     that closes the measured Windows exploit: the ignore reader used to open
 *     first and ask questions afterwards.
 *  2. Open read-only, keeping `O_NOFOLLOW | O_NONBLOCK` where the platform
 *     defines them. On POSIX the flag still turns the swap-in race into `ELOOP`
 *     atomically; `O_NONBLOCK` keeps a FIFO with no writer from parking a libuv
 *     threadpool thread forever.
 *  3. Before a single byte is read: `fstat` the HANDLE and `lstat` the PATH
 *     again, both with `{ bigint: true }`.
 *  4. Refuse, closing the handle, when the post-`lstat` says symlink, when
 *     either stat says the thing is not a regular file, when an identity is
 *     missing or all-zero (dev and ino both 0 means "cannot prove", which fails
 *     closed exactly as the projects-root identity check does), or when
 *     (dev, ino) differ between the handle and the path.
 *  5. Only then does the caller read.
 *
 * `{ bigint: true }` on BOTH stats is required, not stylistic. libuv maps
 * Windows `st_dev` to the volume serial number and `st_ino` to the 64-bit file
 * ID, and a 64-bit file ID does not survive a JavaScript number: two different
 * files can round to the same `ino` and compare equal. The comparison is
 * therefore done on `bigint` values that came from `bigint` stats.
 *
 * ## The limitation, stated rather than implied
 *
 * On ReFS a file ID is 128 bits while Node and libuv expose 64, and Microsoft
 * documents that the truncated ID is NOT guaranteed unique there. The identity
 * check is the best mitigation Node offers and it is sound on local NTFS, where
 * Microsoft documents that the volume serial number plus the file ID identify a
 * file and that NTFS keeps the ID until the file is deleted. It is not a proof
 * against an active race on every Windows filesystem. Vex's supported posture
 * for Studio projects on Windows is a verified local NTFS volume.
 *
 * A second residual is honest to name: the window between the post-`lstat` and
 * the read is not covered by a repeated stat. It does not need to be. The
 * handle is already bound to an inode by the kernel, so a rename or a link
 * created after step 3 cannot change which bytes that handle produces. What the
 * check proves is that the OPEN did not land on a link or on a different file
 * than the path named; what it does not prove is that the path still names that
 * file by the time the caller is done.
 */

import { constants as fsConstants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { log } from "../../logger/index.js";

/**
 * Read-only, never through a link on the final component, and never blocking.
 *
 * `?? 0` is retained deliberately for the platforms that do not define a flag,
 * and it is no longer load-bearing on its own: the steps above are what enforce
 * no-follow where the constant is missing.
 */
const NO_FOLLOW_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** The handle contract these readers use, and nothing wider. */
export interface NoFollowHandle {
  stat(options: { bigint: true }): Promise<BigIntStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/**
 * The filesystem, as an injectable seam.
 *
 * Every refusal below is a RACE, and a race cannot be produced deterministically
 * against a real disk. The seam exists so a test can answer `lstat` with a
 * regular file and hand back a handle whose `fstat` names a different one, which
 * is the only way to prove the ordering and the close-on-refusal contract.
 */
export interface NoFollowFs {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<NoFollowHandle>;
}

/** The real filesystem, with both stats pinned to `bigint`. */
export const nodeNoFollowFs: NoFollowFs = {
  lstat: (path) => lstat(path, { bigint: true }),
  open: (path, flags) => open(path, flags),
};

/**
 * Why a no-follow open did not produce a handle.
 *
 * Each member is a DIFFERENT fact and the callers map them to different
 * user-visible answers. `symlinked_path` is reserved for a DEFINITE link -
 * either standing before the open or reported by the post-open `lstat`.
 * `path_changed` is what an identity mismatch is: the path stopped naming the
 * file that was validated, which a second attempt can legitimately answer
 * differently. Calling that a symlink would invent evidence.
 */
export type NoFollowRefusal =
  | "not_found"
  | "symlinked_path"
  | "not_a_file"
  | "path_changed"
  | "io_error";

export type NoFollowOpen =
  | { readonly ok: true; readonly handle: NoFollowHandle; readonly stats: BigIntStats }
  | { readonly ok: false; readonly reason: NoFollowRefusal; readonly cause?: unknown };

function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Is this identity usable as proof at all?
 *
 * `dev` and `ino` both zero is what a platform reports when it has no identity
 * to give, and comparing two absences would make every unidentifiable file
 * "the same file". It is refused instead.
 */
function hasIdentity(stats: BigIntStats): boolean {
  return stats.dev !== 0n || stats.ino !== 0n;
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Open a path's final component for reading, proving it was not a link.
 *
 * `absolutePath` has already been resolved and containment-checked by
 * `resolveNodePath`; this is the mechanism-level second check, on the one
 * component that walk cannot hold still.
 *
 * On `ok: true` the caller owns the handle and must close it. Every refusal
 * closes the handle itself, so a caller never has to unwind one it never saw.
 */
export async function openWithoutFollowing(
  absolutePath: string,
  fs: NoFollowFs = nodeNoFollowFs,
): Promise<NoFollowOpen> {
  // STEP 1. The standing link, refused before a handle exists.
  let before: BigIntStats;
  try {
    before = await fs.lstat(absolutePath);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return { ok: false, reason: "not_found", cause };
    return { ok: false, reason: "io_error", cause };
  }
  if (before.isSymbolicLink()) return { ok: false, reason: "symlinked_path" };
  if (!before.isFile()) return { ok: false, reason: "not_a_file" };

  // STEP 2. The open. On POSIX `O_NOFOLLOW` still catches the swap-in race
  // atomically and reports it as `ELOOP`; the steps below are what catch it
  // where the flag does not exist.
  let handle: NoFollowHandle;
  try {
    handle = await fs.open(absolutePath, NO_FOLLOW_READ_FLAGS);
  } catch (cause) {
    const code = errorCode(cause);
    if (code === "ENOENT") return { ok: false, reason: "not_found", cause };
    if (code === "ELOOP") return { ok: false, reason: "symlinked_path", cause };
    if (code === "EISDIR") return { ok: false, reason: "not_a_file", cause };
    return { ok: false, reason: "io_error", cause };
  }

  // STEPS 3 AND 4. Everything below refuses by closing the handle, so no byte
  // is ever read from something that failed to prove what it is.
  const refuse = async (
    reason: NoFollowRefusal,
    note: string,
  ): Promise<NoFollowOpen> => {
    await handle.close().catch(() => {
      // The refusal is the outcome; a close failure must not replace it, and
      // the descriptor is released at process exit regardless.
    });
    log.warn(`[studio:files] a read was refused after opening: ${note}`);
    return { ok: false, reason };
  };

  let opened: BigIntStats;
  let after: BigIntStats;
  try {
    [opened, after] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(absolutePath),
    ]);
  } catch (cause) {
    // The path went away, or could not be stated, between the open and here.
    // Either way the no-follow proof cannot be completed, so the read does not
    // happen. ENOENT is a change under us rather than an infrastructure fault.
    const reason: NoFollowRefusal = errorCode(cause) === "ENOENT"
      ? "path_changed"
      : "io_error";
    await handle.close().catch(() => {
      // See the note in `refuse`.
    });
    return { ok: false, reason, cause };
  }

  // A LINK FIRST. A symlink is also "not a regular file", and answering
  // `not_a_file` for one would throw away the only evidence the user needs.
  if (after.isSymbolicLink()) {
    return await refuse("symlinked_path", "the path became a symbolic link");
  }
  if (!opened.isFile() || !after.isFile()) {
    return await refuse("not_a_file", "the open did not land on a regular file");
  }
  if (!hasIdentity(opened) || !hasIdentity(after)) {
    return await refuse("io_error", "the filesystem reported no file identity");
  }
  if (!sameFile(opened, after)) {
    return await refuse("path_changed", "the path stopped naming the file that was opened");
  }

  // STEP 5. The caller reads, and owns the handle from here.
  return { ok: true, handle, stats: opened };
}
