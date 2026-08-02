/**
 * Auto-downscale for the Trench Photos locker (C2).
 *
 * WHY THIS EXISTS, and why the cap does NOT move. The launchpad writes image
 * bytes INLINE in the `create()` calldata (verified: a foreign launch carries a
 * 1.7 KB WebP in its calldata; the Diamond ABI types the parameter as `bytes`).
 * Every byte is therefore gas the user pays, forever, on an irreversible
 * transaction. The 20 KB cap is a deliberate product decision about that cost,
 * not a storage limitation — so the fix for a 3 MB holiday photo is to
 * NORMALIZE it before storage, never to widen the cap.
 *
 * NO NEW DEPENDENCY. Electron's `nativeImage` is already in the runtime and
 * does resize + JPEG encode. This module is allowed to import `electron`
 * because it lives on the MAIN side beside the file picker; `byte-store.ts` and
 * `image-validation.ts` stay Electron-free so they remain testable as pure
 * units, and that separation is the reason this is its own file rather than
 * more logic inside the locker.
 *
 * SQUARE, ON THE RE-ENCODE PATH. Trench renders token images in 1:1 tiles
 * exclusively (owner observation, screenshot evidence). Since an oversized image
 * is being re-encoded anyway, it is center-cropped to a square first — so the
 * thumbnail in the locker is exactly what the venue's tile will show. Storing a
 * 16:9 photo that the venue silently crops at launch time would hand the user a
 * surprise on an irreversible transaction: the edges they were shown, and may
 * have composed around, would simply be gone.
 *
 * WHAT IT WILL NOT DO:
 *  - it never touches an image that already fits. A file within the cap and
 *    within the dimension bounds is stored BYTE-IDENTICAL — even a non-square
 *    one. Byte-identity outranks tile aesthetics for a file the user
 *    deliberately kept under the cap: re-encoding it would degrade it for no
 *    gain and would change the digest a launch authorization may already have
 *    been shown. The venue crops those on display, which is its call to make;
 *  - it never rasterizes a vector. `nativeImage` will not decode SVG, and that
 *    refusal is kept: silently turning a logo into a blurry JPEG is not an
 *    outcome the user asked for;
 *  - it never returns something over the cap. If even the smallest rung misses,
 *    it says so and the existing named refusal stands. Honest failure remains
 *    reachable.
 */

import { nativeImage } from "electron";
import {
  LOCKER_IMAGE_MAX_BYTES,
  LOCKER_IMAGE_MAX_DIMENSION,
  LOCKER_IMAGE_MIN_DIMENSION,
} from "@shared/schemas/images.js";

/**
 * Headroom under the cap.
 *
 * The rung that produces the stored bytes is chosen by measuring them, so this
 * is not a guess about encoder output — it is a margin against the shared cap
 * being the exact boundary a later validator compares with `>`. Landing on
 * 20_000 exactly would make the whole ladder depend on which comparison
 * operator a different module happens to use.
 */
const SAFETY_MARGIN_BYTES = 500;

/** The byte budget a re-encoded image must come in under. */
export const DOWNSCALE_TARGET_BYTES = LOCKER_IMAGE_MAX_BYTES - SAFETY_MARGIN_BYTES;

/**
 * The largest file we will read into memory to attempt an optimization.
 *
 * Above this, the refusal comes from `stat` without the bytes ever being read.
 * Auto-downscale means a picked file is no longer bounded by the 20 KB cap
 * before it is read, so SOME ceiling has to exist or a multi-gigabyte pick
 * becomes a memory-exhaustion path through the file picker.
 */
export const DOWNSCALE_MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/**
 * The ladder, widest first. `maxDimension` is the SIDE of the output square.
 *
 * Ordered so the FIRST rung that fits is also the best-looking one that fits —
 * the search stops immediately, so a mildly oversized photo pays one re-encode,
 * not six. Dimensions fall faster than quality because at this scale pixel
 * count dominates JPEG size, and dropping quality alone produces artefacts long
 * before it produces bytes.
 */
const LADDER: ReadonlyArray<{ readonly maxDimension: number; readonly quality: number }> = [
  { maxDimension: 512, quality: 78 },
  { maxDimension: 448, quality: 74 },
  { maxDimension: 400, quality: 72 },
  { maxDimension: 320, quality: 80 },
  { maxDimension: 256, quality: 80 },
  { maxDimension: 200, quality: 75 },
];

export type DownscaleOutcome =
  /** Already within budget: the ORIGINAL bytes, untouched. */
  | { readonly kind: "unchanged"; readonly bytes: Uint8Array }
  /** Re-encoded to JPEG. `bytes` is what must be stored, hashed and shown. */
  | {
      readonly kind: "optimized";
      readonly bytes: Uint8Array;
      readonly originalByteLength: number;
      readonly width: number;
      readonly height: number;
    }
  /** `nativeImage` could not decode it — an SVG, a fake header, a corrupt file. */
  | { readonly kind: "undecodable" }
  /** Every rung was still over budget. Pathological input; refuse honestly. */
  | { readonly kind: "exhausted"; readonly smallestByteLength: number };

/** Does this image already satisfy the locker's limits without being touched? */
function alreadyFits(bytes: Uint8Array, width: number, height: number): boolean {
  return (
    bytes.byteLength <= LOCKER_IMAGE_MAX_BYTES
    && width <= LOCKER_IMAGE_MAX_DIMENSION
    && height <= LOCKER_IMAGE_MAX_DIMENSION
    && width >= LOCKER_IMAGE_MIN_DIMENSION
    && height >= LOCKER_IMAGE_MIN_DIMENSION
  );
}

/**
 * Bring an image within the locker's byte budget, or explain why it cannot be.
 *
 * The returned bytes are the ONLY bytes any caller may store, hash, or display.
 * Hashing the original while storing a re-encode would put a digest in the
 * consent chain that does not describe what is on disk — and that digest is
 * what an on-chain authorization is compared against.
 */
export function downscaleLockerImage(bytes: Uint8Array): DownscaleOutcome {
  const decoded = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (decoded.isEmpty()) return { kind: "undecodable" };

  const size = decoded.getSize();
  if (alreadyFits(bytes, size.width, size.height)) return { kind: "unchanged", bytes };

  let smallest = Number.POSITIVE_INFINITY;
  for (const rung of LADDER) {
    const side = squareSideFor(size, rung.maxDimension);
    // Below the locker's own floor there is nothing legal left to try.
    if (side < LOCKER_IMAGE_MIN_DIMENSION) continue;

    // RESIZE THEN CROP. Scaling first means the crop is taken from pixels that
    // already carry the final detail, so the encoder is not asked to preserve
    // resolution that is about to be discarded.
    const scaled = scaleShorterSideTo(size, side);
    const resized = decoded.resize({ ...scaled, quality: "good" });
    const square = resized.crop({
      x: Math.max(0, Math.round((scaled.width - side) / 2)),
      y: Math.max(0, Math.round((scaled.height - side) / 2)),
      width: side,
      height: side,
    });

    const encoded = new Uint8Array(square.toJPEG(rung.quality));
    if (encoded.byteLength < smallest) smallest = encoded.byteLength;
    if (encoded.byteLength === 0) continue;

    if (encoded.byteLength <= DOWNSCALE_TARGET_BYTES) {
      const finalSize = square.getSize();
      return {
        kind: "optimized",
        bytes: encoded,
        originalByteLength: bytes.byteLength,
        width: finalSize.width,
        height: finalSize.height,
      };
    }
  }

  return {
    kind: "exhausted",
    smallestByteLength: smallest === Number.POSITIVE_INFINITY ? bytes.byteLength : smallest,
  };
}

/**
 * The side of the square this rung will produce.
 *
 * Bounded by the source's SHORTER side, because a square larger than that could
 * only be reached by scaling UP — inventing pixels to fill a tile is worse than
 * a smaller, honest image.
 */
function squareSideFor(
  size: { readonly width: number; readonly height: number },
  bound: number,
): number {
  return Math.min(bound, Math.min(size.width, size.height));
}

/**
 * Scale so the SHORTER side lands exactly on `side`, preserving aspect ratio —
 * the standard "cover" fit. The longer side overflows and is what the center
 * crop then removes, equally from both ends.
 */
function scaleShorterSideTo(
  size: { readonly width: number; readonly height: number },
  side: number,
): { readonly width: number; readonly height: number } {
  const shorter = Math.min(size.width, size.height);
  const scale = side / shorter;
  return {
    width: Math.max(side, Math.round(size.width * scale)),
    height: Math.max(side, Math.round(size.height * scale)),
  };
}
