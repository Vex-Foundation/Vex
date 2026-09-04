/**
 * The Studio filesystem containment boundary for model-supplied image paths.
 *
 * WHY THIS EXISTS. On the Studio MCP surface an external coding agent hands us
 * an `imagePath` instead of a locker id. That string is MODEL output reaching a
 * filesystem sink (rule 07), and the bytes behind it are uploaded to a public
 * content-addressed host whose URL then goes ON CHAIN. The threat modelled here
 * is NOT the user: Vex is local-first and the user's own machine is the user's
 * business (rule 90). The threat is a provider or a model steering the
 * privileged engine process at files OUTSIDE the project directory the user
 * pointed it at. This module is where that steering stops.
 *
 * WHAT IT OWNS: containment. Project-root confinement, no-follow opening,
 * regular-file-ness, and a byte bound.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN: image policy. It sniffs the FORMAT from
 * magic bytes and stops there. It does not read dimensions. The public asset
 * host re-sniffs by magic bytes and owns the dimension bounds, so duplicating
 * the locker's full header readers (`vex-app/src/main/images/image-validation.ts`)
 * here would create a SECOND source of truth for a rule the host already
 * enforces. Format sniffing stays because it is a containment fact: it is how we
 * refuse to upload a file whose extension lied.
 *
 * THE ORDER OF THE CHECKS IS THE CONTRACT, and it is what the tests pin:
 * root shape, request shape, containment BEFORE any open, no-follow open,
 * containment again after the open (intermediate directories), fstat on the
 * HANDLE, the size bound from that stat before a byte is read, then the bytes.
 *
 * TOCTOU, stated honestly. `O_NOFOLLOW` makes the kernel refuse a symlink at
 * the FINAL path component atomically, which removes the classic
 * stat-then-open race on the file itself. It says nothing about INTERMEDIATE
 * directories, so after the open we resolve the real path and re-check
 * containment. On Linux that resolution reads `/proc/self/fd/<fd>`, which is a
 * property of the OPEN HANDLE and therefore cannot be swapped underneath us.
 * Where `/proc` is unavailable we fall back to a path-based `fs.realpath` and
 * then prove the resolved path is the SAME FILE we hold open by comparing
 * device and inode against the handle's stat. That fallback has a real, if
 * narrow, residual window: an attacker able to rewrite an intermediate
 * directory symlink between our `realpath` and our stat comparison could in
 * principle produce a containment verdict for a path that no longer names the
 * open file. Every subsequent decision (type, size, bytes) is taken from the
 * HANDLE and never from the path, so the worst case of that window is a wrong
 * containment verdict, never a read of a file we did not open.
 *
 * We do not use `SymlinkSupport` from the VS Code reference here: its job is to
 * DESCRIBE a link (following it, reporting `dangling`), and ours is to REFUSE
 * one before it is ever followed.
 */

import { constants as fsConstants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";

/** Hard ceiling on the bytes this module will ever pull into memory: 2 MiB. */
export const NO_FOLLOW_IMAGE_MAX_BYTES = 2_097_152;

/** How much of an untrusted, model-supplied string may appear in a refusal. */
const REQUEST_ECHO_MAX_CHARS = 120;

/** The one byte no filesystem path can carry; Node would cut the string there. */
const NUL = "\u0000";

/** C0 controls plus DEL: never echoed back into a log or an agent message. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

export interface NoFollowImageOpenInput {
  /** The Studio project root. Must be an absolute path; the caller owns resolving it. */
  readonly projectRoot: string;
  /** The model-supplied path: relative to the root, or absolute inside it. */
  readonly requestedPath: string;
}

export type NoFollowImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type NoFollowRefusal =
  | { readonly kind: "not_absolute_root"; readonly detail: string }
  | { readonly kind: "escapes_root"; readonly detail: string }
  | { readonly kind: "symlink"; readonly detail: string }
  | { readonly kind: "not_found"; readonly detail: string }
  | { readonly kind: "not_a_regular_file"; readonly detail: string }
  | { readonly kind: "permission_denied"; readonly detail: string }
  | { readonly kind: "too_large"; readonly byteLength: number; readonly maxBytes: number }
  | { readonly kind: "empty_file" }
  | { readonly kind: "unsupported_image"; readonly detail: string }
  | { readonly kind: "read_failed"; readonly detail: string };

export type NoFollowImageOpen =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly mime: NoFollowImageMime;
      readonly byteLength: number;
      readonly resolvedPath: string;
      readonly relativePath: string;
    }
  | { readonly ok: false; readonly refusal: NoFollowRefusal };

/**
 * Open one image file that must live inside `projectRoot`, without ever
 * following a symbolic link, and return its bytes with a sniffed MIME type.
 *
 * Never throws for a filesystem condition: every reachable failure is a typed
 * `NoFollowRefusal`, because the caller renders it to an agent and to a human
 * approval card rather than to a stack trace.
 */
export async function openImageInsideRoot(
  input: NoFollowImageOpenInput,
): Promise<NoFollowImageOpen> {
  // 1. The root itself. Absolute by contract, and resolved ONCE so that a root
  //    which legitimately lives behind a symlink (macOS `/tmp`, a home moved
  //    onto another volume) is not refused by every later comparison.
  if (!path.isAbsolute(input.projectRoot)) {
    return refuse({
      kind: "not_absolute_root",
      detail: "The project root must be an absolute path.",
    });
  }
  let root: string;
  try {
    root = await fs.realpath(input.projectRoot);
  } catch (error) {
    return refuse({
      kind: "not_absolute_root",
      detail: `The project root could not be resolved on disk (${errnoLabel(error)}).`,
    });
  }

  // 2. The request shape, before any syscall touches it. A NUL byte would be
  //    cut at the C string boundary underneath Node, so a path carrying one
  //    never reaches the kernel from here.
  const requested = input.requestedPath;
  if (requested.length === 0) {
    return refuse({ kind: "read_failed", detail: "No image path was given." });
  }
  if (requested.includes(NUL)) {
    return refuse({
      kind: "read_failed",
      detail: "The image path contains a NUL character, which no file can carry.",
    });
  }

  // 3. Containment BEFORE the open, so an obviously escaping path never becomes
  //    a syscall at all.
  const candidate = path.normalize(
    path.isAbsolute(requested) ? requested : path.resolve(root, requested),
  );
  if (!isInsideRoot(root, candidate)) {
    return refuse(escapesRoot(requested, "outside the project root"));
  }

  // 4. The no-follow open. This is the core of the module: the kernel, not a
  //    prior stat, decides that the final component is not a symbolic link.
  const opened = await openWithoutFollowing(candidate);
  if (!opened.ok) {
    return refuse(opened.refusal);
  }
  const handle = opened.handle;
  try {
    // 5. `O_NOFOLLOW` protected the final component only. An intermediate
    //    directory could still be a symlink leaving the root, so resolve the
    //    real path of the file we now HOLD OPEN and check containment again.
    const real = await resolveOpenFile(handle, candidate);
    if (!real.ok) {
      return refuse(real.refusal);
    }
    const resolvedPath = real.path;
    if (!isInsideRoot(root, resolvedPath)) {
      return refuse(
        escapesRoot(requested, "outside the project root once its parent directories are resolved"),
      );
    }

    // 6. Everything from here reads the HANDLE, never the path: the path could
    //    have been swapped since the open, the handle cannot.
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return refuse({
        kind: "not_a_regular_file",
        detail: `The path is ${describeFileKind(stat)}, not a regular file.`,
      });
    }
    const size = stat.size;
    if (size === 0) {
      return refuse({ kind: "empty_file" });
    }
    if (size > NO_FOLLOW_IMAGE_MAX_BYTES) {
      // Refused from the stat, so a huge file is never pulled into memory.
      return refuse({ kind: "too_large", byteLength: size, maxBytes: NO_FOLLOW_IMAGE_MAX_BYTES });
    }

    // 7. Read at most the cap. The buffer carries one spare byte so that a file
    //    which GREW between the stat and the read is detected instead of being
    //    silently cut: a truncated image is a different picture.
    const bytes = await readAll(handle, Math.min(size, NO_FOLLOW_IMAGE_MAX_BYTES) + 1);
    if (bytes.byteLength > size) {
      return refuse({
        kind: "too_large",
        byteLength: bytes.byteLength,
        maxBytes: NO_FOLLOW_IMAGE_MAX_BYTES,
      });
    }
    if (bytes.byteLength < size) {
      return refuse({
        kind: "read_failed",
        detail: "The file changed while it was being read. Try again once it is stable.",
      });
    }

    // 8. Format from magic bytes. The extension is never consulted.
    const mime = sniffImageMime(bytes);
    if (mime === null) {
      return refuse({
        kind: "unsupported_image",
        detail: "The file is not a PNG, JPEG, WebP, or GIF image.",
      });
    }

    // 9. The relative path is what a human approval card shows; the absolute
    //    one is for the uploader, which does not render it.
    return {
      ok: true,
      bytes,
      mime,
      byteLength: bytes.byteLength,
      resolvedPath,
      relativePath: path.relative(root, resolvedPath),
    };
  } catch (error) {
    return refuse({
      kind: "read_failed",
      detail: `The image could not be read (${errnoLabel(error)}).`,
    });
  } finally {
    // The handle has exactly one owner: this function. It is closed on success,
    // on every refusal, and on a throw.
    await handle.close().catch(() => undefined);
  }
}

// -- containment -----------------------------------------------------------

/**
 * Segment-boundary containment. A bare `startsWith` would let `/home/u/projX`
 * pass for the root `/home/u/proj`, so the separator is part of the test; and
 * the root ITSELF is not a contained file, because we are opening a file.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  if (candidate === root) return false;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(prefix);
}

/**
 * An `escapes_root` refusal never names the resolved absolute path: confirming
 * filesystem layout outside the project is exactly what the model is probing
 * for. It echoes only the model's own request, bounded.
 */
function escapesRoot(requested: string, reason: string): NoFollowRefusal {
  return {
    kind: "escapes_root",
    detail: `The image path ${echoRequest(requested)} is ${reason}. Give a path to a file inside the project.`,
  };
}

/**
 * Untrusted text on its way into an agent-visible error and a log: control
 * characters stripped, length bounded, and the bound REPORTED rather than
 * hidden behind an ellipsis.
 */
function echoRequest(requested: string): string {
  const cleaned = requested.replace(CONTROL_CHARACTERS, " ");
  if (cleaned.length <= REQUEST_ECHO_MAX_CHARS) {
    return `"${cleaned}"`;
  }
  return `"${cleaned.slice(0, REQUEST_ECHO_MAX_CHARS)}" (first ${REQUEST_ECHO_MAX_CHARS} of ${cleaned.length} characters)`;
}

// -- opening ---------------------------------------------------------------

type OpenOutcome =
  | { readonly ok: true; readonly handle: FileHandle }
  | { readonly ok: false; readonly refusal: NoFollowRefusal };

async function openWithoutFollowing(candidate: string): Promise<OpenOutcome> {
  const noFollow: number | undefined = fsConstants.O_NOFOLLOW;
  if (noFollow === undefined) {
    // Windows has no `O_NOFOLLOW`. The lstat guard below is strictly WEAKER: it
    // is a check-then-open, so a link created in between would be followed. It
    // is the strongest tool the platform offers, and it is named as weaker
    // rather than presented as equivalent.
    try {
      const link = await fs.lstat(candidate);
      if (link.isSymbolicLink()) {
        return { ok: false, refusal: symlinkRefusal() };
      }
    } catch (error) {
      return { ok: false, refusal: openErrorRefusal(error) };
    }
  }
  try {
    // O_NONBLOCK is a LIVENESS guard, not a performance one. A read-only open of
    // a FIFO BLOCKS until a writer appears, so without it a model-supplied path
    // to a named pipe would hang the privileged engine process for as long as
    // the attacker liked, before any of our checks could run. On a regular file
    // the flag has no effect; on a FIFO the open returns at once and the stat
    // below refuses it as `not_a_regular_file`. Proven by the FIFO test, which
    // failed on its 5 second watchdog until this flag was added.
    const nonBlocking: number | undefined = fsConstants.O_NONBLOCK;
    const handle = await fs.open(
      candidate,
      fsConstants.O_RDONLY | (noFollow ?? 0) | (nonBlocking ?? 0),
    );
    return { ok: true, handle };
  } catch (error) {
    return { ok: false, refusal: openErrorRefusal(error) };
  }
}

function symlinkRefusal(): NoFollowRefusal {
  return {
    kind: "symlink",
    detail:
      "The image path is a symbolic link. Symbolic links are never followed. Give the path of the real file.",
  };
}

function openErrorRefusal(error: unknown): NoFollowRefusal {
  switch (errnoCode(error)) {
    // ELOOP is the kernel refusing the link under O_NOFOLLOW. Some BSD-derived
    // platforms report EMLINK for the same condition.
    case "ELOOP":
    case "EMLINK":
      return symlinkRefusal();
    case "ENOENT":
      return { kind: "not_found", detail: "No file exists at that path in the project." };
    case "EACCES":
    case "EPERM":
      return {
        kind: "permission_denied",
        detail: "The file exists but cannot be read with the current permissions.",
      };
    case "EISDIR":
      return { kind: "not_a_regular_file", detail: "The path is a directory, not a regular file." };
    case "ENOTDIR":
      return { kind: "not_found", detail: "A parent of that path is not a directory." };
    case "ENAMETOOLONG":
      return { kind: "not_found", detail: "The image path is too long for this filesystem." };
    default:
      return {
        kind: "read_failed",
        detail: `The image could not be opened (${errnoLabel(error)}).`,
      };
  }
}

type ResolveOutcome =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly refusal: NoFollowRefusal };

/**
 * The real path of the file we hold open.
 *
 * Linux: `/proc/self/fd/<fd>` is a property of the HANDLE, so the answer cannot
 * be swapped by anything happening on the path.
 *
 * Elsewhere: `fs.realpath` on the path, and then the resolved path is proved to
 * be the same file as the handle by comparing device and inode. That comparison
 * is what turns a path answer into a handle answer.
 */
async function resolveOpenFile(handle: FileHandle, candidate: string): Promise<ResolveOutcome> {
  if (process.platform === "linux") {
    try {
      return { ok: true, path: await fs.readlink(`/proc/self/fd/${handle.fd}`) };
    } catch {
      // /proc may not be mounted (a minimal container). Fall through.
    }
  }
  try {
    const resolved = await fs.realpath(candidate);
    const [viaPath, viaHandle] = await Promise.all([fs.stat(resolved), handle.stat()]);
    if (viaPath.dev !== viaHandle.dev || viaPath.ino !== viaHandle.ino) {
      return {
        ok: false,
        refusal: {
          kind: "read_failed",
          detail: "The file at that path changed while it was being opened. Try again.",
        },
      };
    }
    return { ok: true, path: resolved };
  } catch (error) {
    return { ok: false, refusal: openErrorRefusal(error) };
  }
}

// -- reading ---------------------------------------------------------------

/** Read up to `capacity` bytes from the handle, returning exactly what arrived. */
async function readAll(handle: FileHandle, capacity: number): Promise<Uint8Array> {
  const buffer = Buffer.allocUnsafe(capacity);
  let filled = 0;
  while (filled < capacity) {
    const { bytesRead } = await handle.read(buffer, filled, capacity - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  // Copy out of the pooled allocation: the caller must not be able to reach
  // unrelated pool memory through `bytes.buffer`.
  return new Uint8Array(buffer.subarray(0, filled));
}

// -- magic bytes -----------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function readsAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.byteLength < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Identify the format from its magic bytes, or `null` for anything else. */
function sniffImageMime(bytes: Uint8Array): NoFollowImageMime | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  if (readsAscii(bytes, 0, "RIFF") && readsAscii(bytes, 8, "WEBP")) return "image/webp";
  if (readsAscii(bytes, 0, "GIF87a") || readsAscii(bytes, 0, "GIF89a")) return "image/gif";
  return null;
}

// -- errors ----------------------------------------------------------------

function errnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * A short, stable label for a filesystem error. Never the raw error object: it
 * carries the full local path and a stack, neither of which belongs in an
 * agent-visible message.
 */
function errnoLabel(error: unknown): string {
  return errnoCode(error) ?? "unknown filesystem error";
}

function describeFileKind(stat: {
  isDirectory(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
}): string {
  if (stat.isDirectory()) return "a directory";
  if (stat.isFIFO()) return "a named pipe";
  if (stat.isSocket()) return "a socket";
  if (stat.isBlockDevice()) return "a block device";
  if (stat.isCharacterDevice()) return "a character device";
  return "of an unknown kind";
}

function refuse(refusal: NoFollowRefusal): NoFollowImageOpen {
  return { ok: false, refusal };
}
