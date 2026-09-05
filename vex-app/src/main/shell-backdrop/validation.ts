/**
 * Backdrop validation - the trust boundary for the user's wallpaper bytes.
 *
 * ORDER IS THE CONTRACT, and each gate is cheaper than the next:
 *  1. SIZE. The caller checks `stat` against the 8 MiB bound BEFORE reading
 *     (`service.ts`); this module re-checks the buffer it was handed so a
 *     caller that skipped the stat gate is still refused.
 *  2. MAGIC BYTES + HEADER. Reused from the image locker's pure sniffer
 *     (`main/images/image-validation.ts`): PNG, JPEG and WebP are identified
 *     from their signatures and their header dimensions are read. The
 *     extension is never consulted.
 *  3. FORMAT ALLOWLIST. WebP is identified by the sniffer and REFUSED here by
 *     name. Electron 42's `nativeImage` cannot decode it (measured 2026-09-04
 *     against real VP8 and VP8L files and the app's own `midnight-lake.webp`:
 *     `isEmpty() === true` for all three), and a format the decoder cannot
 *     prove is not accepted on a header alone.
 *  4. DECODE PROOF. `nativeImage.createFromBuffer` must produce a non-empty
 *     image. A fake header over garbage, a truncated file, a PNG with a
 *     corrupt IDAT: all refused as `undecodable`, never painted as a black or
 *     half-drawn wall.
 *  5. DIMENSION BAND, on the DECODED size. The decoder's answer is the truth
 *     about what will be painted; the header is only what the file claims.
 *     Below 640x360 the image reads as a tile, above 8192 the bitmap alone is
 *     a quarter of a gigabyte.
 */

import { nativeImage } from "electron";
import {
  SHELL_BACKDROP_MAX_DIMENSION,
  SHELL_BACKDROP_MAX_SOURCE_BYTES,
  SHELL_BACKDROP_MIN_BYTES,
  SHELL_BACKDROP_MIN_HEIGHT,
  SHELL_BACKDROP_MIN_WIDTH,
  SHELL_BACKDROP_MIME_TYPES,
  type ShellBackdropMime,
} from "@shared/schemas/shell-backdrop.js";
import { validateLockerImageBytes } from "../images/index.js";

export type ShellBackdropRejection =
  | { readonly kind: "too_large"; readonly byteLength: number; readonly maxBytes: number }
  | { readonly kind: "too_small"; readonly byteLength: number }
  | { readonly kind: "unsupported_format"; readonly reason: string }
  | { readonly kind: "undecodable"; readonly reason: string };

export type ShellBackdropValidation =
  | {
      readonly ok: true;
      readonly mime: ShellBackdropMime;
      /** The DECODED size, not the header's claim. */
      readonly width: number;
      readonly height: number;
      readonly byteLength: number;
    }
  | { readonly ok: false; readonly rejection: ShellBackdropRejection };

const ACCEPTED: ReadonlySet<string> = new Set(SHELL_BACKDROP_MIME_TYPES);

function isAcceptedMime(mime: string): mime is ShellBackdropMime {
  return ACCEPTED.has(mime);
}

/** Validate raw file bytes against the full backdrop matrix. */
export function validateShellBackdropBytes(bytes: Uint8Array): ShellBackdropValidation {
  const byteLength = bytes.byteLength;
  if (byteLength > SHELL_BACKDROP_MAX_SOURCE_BYTES) {
    return {
      ok: false,
      rejection: { kind: "too_large", byteLength, maxBytes: SHELL_BACKDROP_MAX_SOURCE_BYTES },
    };
  }
  if (byteLength < SHELL_BACKDROP_MIN_BYTES) {
    return { ok: false, rejection: { kind: "too_small", byteLength } };
  }

  // The locker sniffer's own byte bounds (25 MiB, 16 B) are wider than ours
  // on top and equal on the bottom, so with the two checks above already
  // applied, its only remaining verdicts are the format ones.
  const sniffed = validateLockerImageBytes(bytes);
  if (!sniffed.ok) {
    const reason =
      sniffed.rejection.kind === "unsupported_format"
        ? sniffed.rejection.reason
        : "the file is not a PNG or JPEG image";
    return { ok: false, rejection: { kind: "unsupported_format", reason } };
  }
  if (!isAcceptedMime(sniffed.mime)) {
    return {
      ok: false,
      rejection: {
        kind: "unsupported_format",
        reason:
          `the file is a ${describeMime(sniffed.mime)}, which this build cannot decode ` +
          `for a backdrop`,
      },
    };
  }

  const decoded = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (decoded.isEmpty()) {
    return {
      ok: false,
      rejection: { kind: "undecodable", reason: "the image could not be decoded" },
    };
  }
  const { width, height } = decoded.getSize();
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return {
      ok: false,
      rejection: { kind: "undecodable", reason: "the image decoded to an empty picture" },
    };
  }
  if (width < SHELL_BACKDROP_MIN_WIDTH || height < SHELL_BACKDROP_MIN_HEIGHT) {
    return {
      ok: false,
      rejection: {
        kind: "undecodable",
        reason:
          `the image is ${width}x${height}, smaller than the ` +
          `${SHELL_BACKDROP_MIN_WIDTH}x${SHELL_BACKDROP_MIN_HEIGHT} a backdrop needs`,
      },
    };
  }
  if (width > SHELL_BACKDROP_MAX_DIMENSION || height > SHELL_BACKDROP_MAX_DIMENSION) {
    return {
      ok: false,
      rejection: {
        kind: "undecodable",
        reason:
          `the image is ${width}x${height}, larger than the ` +
          `${SHELL_BACKDROP_MAX_DIMENSION}x${SHELL_BACKDROP_MAX_DIMENSION} ceiling`,
      },
    };
  }
  return { ok: true, mime: sniffed.mime, width, height, byteLength };
}

function describeMime(mime: string): string {
  return mime === "image/webp" ? "WebP image" : mime;
}
