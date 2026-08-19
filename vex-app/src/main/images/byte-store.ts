/**
 * The locker BYTE store — the only place in the app that holds image bytes.
 *
 * Bytes live under `CONFIG_DIR/trench-images/`, one file per image, named
 * from the opaque `imageId` alone. The METADATA is not here: it lives in the
 * `launch_images` table (Lane A's `@vex-agent/db/repos/launch-images.js`), so
 * there is exactly ONE source of truth for what an image IS and this module
 * only answers "give me the bytes for this id".
 *
 * WHY THERE IS NO PATH PARAMETER ANYWHERE PUBLIC: every entry point takes an
 * `imageId`, never a path. The renderer cannot supply a path (main owns the
 * file picker), the agent cannot supply a path (it only ever sees metadata),
 * and an `imageId` is `img_<32 hex>` — anchored, with no `/`, `\`, or `.`, so
 * it cannot be a relative path segment. `resolveImagePath` still re-derives
 * and re-checks containment before touching the disk: the id pattern is the
 * design, containment is the proof, and a path-traversal test pins both.
 *
 * Stored files carry a `.bin` extension deliberately. The real type is
 * recorded in the metadata row after magic-byte validation; giving the file a
 * `.png`/`.jpg` name would invite some later reader to trust the extension
 * over the validation that actually happened.
 *
 * TWO FILES PER IMAGE, AT MOST. Since the per-lane image decision
 * (2026-08-19) the ORIGINAL is stored verbatim and Trench consumes a derived
 * copy under its on-chain budget. When the original already fits, it IS the
 * copy and only one file exists. When the ladder re-encodes, the copy lands
 * beside the original as `<imageId>.onchain.bin`. Both live behind their own
 * named functions rather than a suffix a caller concatenates, so the id
 * pattern and the containment check gate the variant exactly as they gate the
 * original.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { LOCKER_IMAGE_ID_PATTERN } from "@shared/schemas/images.js";
import { CONFIG_DIR } from "../paths/config-dir.js";

/**
 * Defined here rather than in `paths/config-dir.ts` because this directory is
 * an implementation detail of the locker: nothing outside this module may
 * derive a path into it. `config-dir.ts` exports the paths that several
 * subsystems share; this is not one of them.
 */
export const LOCKER_IMAGES_DIR = path.join(CONFIG_DIR, "trench-images");

/** Thrown when an id could name something outside the locker directory. */
export class LockerPathEscapeError extends Error {
  override readonly name = "LockerPathEscapeError";
  constructor() {
    super("Refusing to resolve a locker image path outside the locker directory.");
  }
}

/** Mint a fresh opaque id. 128 bits of randomness — never a counter, never derived from the file. */
export function newLockerImageId(): string {
  return `img_${randomBytes(16).toString("hex")}`;
}

/** sha256 of the stored bytes, lowercase hex. Bound into the C0 authorization record. */
export function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Map an opaque id to its file. Two independent gates, on purpose:
 *  1. the id must match the anchored `img_<32 hex>` pattern;
 *  2. the resolved absolute path must still sit directly inside the locker
 *     directory.
 * Gate 2 cannot fail while gate 1 holds — which is exactly why it is worth
 * asserting. If a future change loosens the id format, this throws instead of
 * quietly reading or deleting an arbitrary file.
 */
export function resolveImagePath(imageId: string): string {
  return resolveStoredPath(imageId, ".bin");
}

/**
 * The Trench on-chain copy's file. Same two gates, same directory.
 *
 * Only exists when the ladder actually re-encoded: an original that already
 * fits IS its own copy, and the metadata row says so by carrying the same
 * digest in both places.
 */
export function resolveOnchainVariantPath(imageId: string): string {
  return resolveStoredPath(imageId, ".onchain.bin");
}

function resolveStoredPath(imageId: string, suffix: string): string {
  if (!LOCKER_IMAGE_ID_PATTERN.test(imageId)) throw new LockerPathEscapeError();
  const resolved = path.resolve(LOCKER_IMAGES_DIR, `${imageId}${suffix}`);
  if (path.dirname(resolved) !== path.resolve(LOCKER_IMAGES_DIR)) {
    throw new LockerPathEscapeError();
  }
  return resolved;
}

async function ensureDir(): Promise<void> {
  await mkdir(LOCKER_IMAGES_DIR, { recursive: true });
}

/** Write validated bytes for a fresh id. */
export async function writeImageBytes(imageId: string, bytes: Uint8Array): Promise<void> {
  await writeAt(resolveImagePath(imageId), bytes);
}

/** Write the derived Trench on-chain copy beside the original. */
export async function writeOnchainVariantBytes(
  imageId: string,
  bytes: Uint8Array,
): Promise<void> {
  await writeAt(resolveOnchainVariantPath(imageId), bytes);
}

async function writeAt(target: string, bytes: Uint8Array): Promise<void> {
  await ensureDir();
  await writeFile(target, bytes);
}

/**
 * Read stored bytes. `null` means "no such file" — an expected answer the
 * caller refuses on by name. Any OTHER failure (permissions, a corrupt
 * directory) propagates, because "the locker is broken" must not be reported
 * to the user as "that image does not exist".
 */
export async function readImageBytes(imageId: string): Promise<Uint8Array | null> {
  return readAt(resolveImagePath(imageId));
}

/** Read the derived Trench on-chain copy. Same `null` contract as the original. */
export async function readOnchainVariantBytes(
  imageId: string,
): Promise<Uint8Array | null> {
  return readAt(resolveOnchainVariantPath(imageId));
}

async function readAt(target: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(target));
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }
}

/** Remove stored bytes. Idempotent: deleting an absent file is a success. */
export async function removeImageBytes(imageId: string): Promise<void> {
  await rm(resolveImagePath(imageId), { force: true });
}

/**
 * Remove the derived copy. Idempotent, and an image whose original was its own
 * copy simply has no such file — which is why this is a separate, silent
 * removal rather than a failure the deletion path would have to interpret.
 */
export async function removeOnchainVariantBytes(imageId: string): Promise<void> {
  await rm(resolveOnchainVariantPath(imageId), { force: true });
}

function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}
