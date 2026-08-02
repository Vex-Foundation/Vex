/**
 * Locker image validation (C2) — the trust boundary for image bytes.
 *
 * PURE by construction: no `fs`, no Electron, no I/O. It takes bytes and
 * returns a verdict, which is what makes the whole matrix testable without a
 * disk (`__tests__/image-validation.test.ts` builds every header by hand).
 *
 * THE RULE: we identify the file from its MAGIC BYTES and read its dimensions
 * out of its HEADER. We never trust an extension, never trust a claimed MIME,
 * and — critically — never DECODE or TRANSCODE. No runtime image codec is
 * packaged with the app (`sharp` is devDependencies-only and must not be
 * added), so "convert it for the user" is not an option that exists. Anything
 * we cannot positively identify is refused by name.
 *
 * Order matters: SIZE is checked before format. A 3 MB PDF should be told it
 * is too large, not lectured about its magic bytes — and refusing early means
 * the sniffers only ever walk a buffer already known to be ≤20 KB, so their
 * loops are bounded by the cap rather than by attacker-chosen length.
 */

import {
  LOCKER_IMAGE_LABEL_MAX_LENGTH,
  LOCKER_IMAGE_MAX_BYTES,
  LOCKER_IMAGE_MAX_DIMENSION,
  LOCKER_IMAGE_MIN_BYTES,
  LOCKER_IMAGE_MIN_DIMENSION,
  type LockerImageMime,
} from "@shared/schemas/images.js";

export type LockerImageRejection =
  | { readonly kind: "too_large"; readonly byteLength: number; readonly maxBytes: number }
  | { readonly kind: "too_small"; readonly byteLength: number }
  | { readonly kind: "unsupported_format"; readonly reason: string };

export type LockerImageValidation =
  | {
      readonly ok: true;
      readonly mime: LockerImageMime;
      readonly width: number;
      readonly height: number;
      readonly byteLength: number;
    }
  | { readonly ok: false; readonly rejection: LockerImageRejection };

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

function reject(reason: string): LockerImageValidation {
  return { ok: false, rejection: { kind: "unsupported_format", reason } };
}

/** Validate raw file bytes against the full C2 matrix. */
export function validateLockerImageBytes(bytes: Uint8Array): LockerImageValidation {
  const byteLength = bytes.byteLength;
  if (byteLength > LOCKER_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      rejection: { kind: "too_large", byteLength, maxBytes: LOCKER_IMAGE_MAX_BYTES },
    };
  }
  if (byteLength < LOCKER_IMAGE_MIN_BYTES) {
    return { ok: false, rejection: { kind: "too_small", byteLength } };
  }

  const sniffed = sniff(bytes);
  if (sniffed === null) {
    return reject("the file is not a JPEG, PNG, or WebP image");
  }

  const dimensions = sniffed.readDimensions(bytes);
  if (dimensions === null) {
    return reject(`the ${sniffed.mime} header does not carry readable dimensions`);
  }
  if (!isPlausible(dimensions)) {
    return reject(
      `the header declares implausible dimensions (${dimensions.width}x${dimensions.height})`,
    );
  }
  return { ok: true, mime: sniffed.mime, ...dimensions, byteLength };
}

function isPlausible({ width, height }: Dimensions): boolean {
  const inBand = (n: number): boolean =>
    Number.isInteger(n) && n >= LOCKER_IMAGE_MIN_DIMENSION && n <= LOCKER_IMAGE_MAX_DIMENSION;
  return inBand(width) && inBand(height);
}

// ── Magic-byte sniffing ───────────────────────────────────────────────────

interface SniffedFormat {
  readonly mime: LockerImageMime;
  readonly readDimensions: (bytes: Uint8Array) => Dimensions | null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

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

function sniff(bytes: Uint8Array): SniffedFormat | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return { mime: "image/png", readDimensions: readPngDimensions };
  }
  if (startsWith(bytes, JPEG_SIGNATURE)) {
    return { mime: "image/jpeg", readDimensions: readJpegDimensions };
  }
  // WebP is a RIFF container; the "WEBP" form type at offset 8 is what
  // separates it from a WAV or an AVI wearing the same first four bytes.
  if (readsAscii(bytes, 0, "RIFF") && readsAscii(bytes, 8, "WEBP")) {
    return { mime: "image/webp", readDimensions: readWebpDimensions };
  }
  return null;
}

// ── Header readers (no decoding — these only parse metadata) ──────────────

/**
 * PNG: the IHDR chunk is mandatory and must be FIRST, so its position is
 * fixed. Width and height are big-endian uint32 at offsets 16 and 20. We
 * verify the "IHDR" tag rather than trusting the signature alone, so a file
 * that borrowed a PNG header but carries something else is refused.
 */
function readPngDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.byteLength < 24) return null;
  if (!readsAscii(bytes, 12, "IHDR")) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * JPEG: dimensions live in a Start-Of-Frame marker, whose position depends on
 * how many APPn/COM segments precede it, so the segment chain must be walked.
 *
 * TWO TRAPS, both pinned by tests:
 *  - SOF stores HEIGHT BEFORE WIDTH. Reading them in field order silently
 *    transposes every image.
 *  - `0xFFC4` (DHT), `0xFFC8` (JPG), and `0xFFCC` (DAC) sit inside the
 *    0xC0–0xCF block but are NOT frame headers; treating them as SOF reads
 *    Huffman table bytes as a picture size.
 */
function readJpegDimensions(bytes: Uint8Array): Dimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2; // past SOI
  while (offset + 9 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null; // desynchronised — refuse, don't hunt
    const marker = bytes[offset + 1];
    if (marker === undefined) return null;
    // Padding bytes: a run of 0xFF is legal between segments.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (isStartOfFrame(marker)) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    const segmentLength = view.getUint16(offset + 2);
    if (segmentLength < 2) return null; // malformed length would loop forever
    offset += 2 + segmentLength;
  }
  return null;
}

function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * WebP: three sub-formats, each with its own header layout. We support all
 * three and refuse anything else rather than guessing:
 *  - `VP8 ` (lossy):     14-bit width/height, little-endian, after the
 *                        3-byte start code `9D 01 2A`.
 *  - `VP8L` (lossless):  14-bit width-1/height-1 packed across 4 bytes,
 *                        behind the `0x2F` signature byte.
 *  - `VP8X` (extended):  24-bit canvas width-1/height-1, little-endian.
 * The `-1` bias in VP8L/VP8X is the trap: forgetting it is an off-by-one on
 * every dimension the locker records.
 */
function readWebpDimensions(bytes: Uint8Array): Dimensions | null {
  const chunk = 12; // "RIFF" + size + "WEBP"
  if (readsAscii(bytes, chunk, "VP8 ")) return readVp8Lossy(bytes, chunk + 8);
  if (readsAscii(bytes, chunk, "VP8L")) return readVp8Lossless(bytes, chunk + 8);
  if (readsAscii(bytes, chunk, "VP8X")) return readVp8Extended(bytes, chunk + 8);
  return null;
}

function readVp8Lossy(bytes: Uint8Array, frame: number): Dimensions | null {
  if (bytes.byteLength < frame + 10) return null;
  if (bytes[frame + 3] !== 0x9d || bytes[frame + 4] !== 0x01 || bytes[frame + 5] !== 0x2a) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint16(frame + 6, true) & 0x3fff,
    height: view.getUint16(frame + 8, true) & 0x3fff,
  };
}

function readVp8Lossless(bytes: Uint8Array, frame: number): Dimensions | null {
  if (bytes.byteLength < frame + 5) return null;
  if (bytes[frame] !== 0x2f) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packed = view.getUint32(frame + 1, true);
  return {
    width: (packed & 0x3fff) + 1,
    height: ((packed >> 14) & 0x3fff) + 1,
  };
}

function readVp8Extended(bytes: Uint8Array, frame: number): Dimensions | null {
  if (bytes.byteLength < frame + 10) return null;
  const at = (index: number): number => bytes[frame + index] ?? 0;
  const width = at(4) | (at(5) << 8) | (at(6) << 16);
  const height = at(7) | (at(8) << 8) | (at(9) << 16);
  return { width: width + 1, height: height + 1 };
}

// ── Label derivation ──────────────────────────────────────────────────────

const FALLBACK_LABEL = "image";

/**
 * Turn the picked file's name into a DISPLAY label.
 *
 * A label is never a path and is never used to locate anything: the stored
 * file is named from the opaque `imageId`. This exists so the sidebar card can
 * say "moon.png" instead of "img_3f2a…". It is sanitized anyway, because it is
 * rendered and it originates outside the app: directories are dropped, and
 * separators, dot-runs, and control characters are stripped so a hostile file
 * name cannot masquerade as a path in the UI.
 */
export function deriveLockerImageLabel(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .trim();
  if (cleaned.length === 0) return FALLBACK_LABEL;
  return cleaned.slice(0, LOCKER_IMAGE_LABEL_MAX_LENGTH);
}
