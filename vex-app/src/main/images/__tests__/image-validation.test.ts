/**
 * The image-locker validation matrix (C2).
 *
 * This is the whole trust boundary for locker bytes, so it is tested as a
 * matrix rather than a happy path. The rules under test:
 *
 *  - format is decided by MAGIC BYTES only — never by a file extension and
 *    never by anything a caller claims;
 *  - dimensions are read from the HEADER, with no decode and no transcode
 *    (no runtime image codec is packaged; `sharp` is devDependencies-only);
 *  - a 20 KB hard cap, because the bytes ride inside the `create` calldata of
 *    a real on-chain transaction and are therefore gas the user pays;
 *  - anything we cannot positively identify is REFUSED, never guessed at.
 *
 * Fixtures are built byte-by-byte in this file on purpose. A checked-in binary
 * would hide exactly the bytes the assertions are about, and these headers are
 * the specification being pinned.
 */

import { describe, expect, it } from "vitest";
import {
  LOCKER_IMAGE_MAX_SOURCE_BYTES,
  LOCKER_IMAGE_MIN_BYTES,
} from "@shared/schemas/images.js";
import {
  deriveLockerImageLabel,
  validateLockerImageBytes,
} from "../image-validation.js";

// ── Fixture builders ──────────────────────────────────────────────────────

/** Minimal PNG: signature + a well-formed IHDR carrying the dimensions. */
function pngFixture(width: number, height: number, pad = 64): Uint8Array {
  const out = new Uint8Array(33 + pad);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, 13); // IHDR length
  out.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

/**
 * Minimal JPEG: SOI, an APP0 segment to prove segment-walking works, then an
 * SOF0 frame header carrying the dimensions (height BEFORE width — the
 * ordering trap this test exists to pin).
 */
function jpegFixture(width: number, height: number, pad = 64): Uint8Array {
  const head = [
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, length 4 (2 payload bytes)
    0xff, 0xc0, 0x00, 0x11, 0x08, // SOF0, length 17, 8-bit precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
  ];
  const out = new Uint8Array(head.length + pad);
  out.set(head, 0);
  return out;
}

function riffContainer(fourCc: string, payload: number[]): Uint8Array {
  const body = [...new TextEncoder().encode("WEBP"), ...new TextEncoder().encode(fourCc), ...payload];
  const out = new Uint8Array(8 + body.length);
  out.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

/** Lossy WebP (`VP8 `): 14-bit width/height little-endian at chunk offset 6/8. */
function webpLossyFixture(width: number, height: number): Uint8Array {
  // payload[0..3] chunk size, payload[4..6] the 3-byte frame tag,
  // payload[7..9] the `9D 01 2A` start code, then 14-bit width/height LE.
  const payload = new Array<number>(14).fill(0);
  payload[7] = 0x9d;
  payload[8] = 0x01;
  payload[9] = 0x2a;
  payload[10] = width & 0xff;
  payload[11] = (width >> 8) & 0x3f;
  payload[12] = height & 0xff;
  payload[13] = (height >> 8) & 0x3f;
  return riffContainer("VP8 ", payload);
}

/** Extended WebP (`VP8X`): 24-bit canvas width-1 / height-1, little-endian. */
function webpExtendedFixture(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  const payload = [
    0x0a, 0x00, 0x00, 0x00, // chunk size
    0x00, 0x00, 0x00, 0x00, // flags + reserved
    w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff,
    h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff,
  ];
  return riffContainer("VP8X", payload);
}

function rejectionKind(bytes: Uint8Array): string {
  const outcome = validateLockerImageBytes(bytes);
  return outcome.ok ? "accepted" : outcome.rejection.kind;
}

// ── Accepted formats ──────────────────────────────────────────────────────

describe("validateLockerImageBytes - the allowlist", () => {
  it("accepts a PNG and reads its dimensions from IHDR", () => {
    const outcome = validateLockerImageBytes(pngFixture(320, 200));
    expect(outcome).toMatchObject({ ok: true, mime: "image/png", width: 320, height: 200 });
  });

  it("accepts a JPEG, walking past APP0 to SOF0, and does not transpose height/width", () => {
    const outcome = validateLockerImageBytes(jpegFixture(640, 480));
    // The trap: SOF0 stores HEIGHT first. A reader that takes them in field
    // order returns 480x640 and every downstream aspect decision is wrong.
    expect(outcome).toMatchObject({ ok: true, mime: "image/jpeg", width: 640, height: 480 });
  });

  it("accepts a lossy WebP (`VP8 `)", () => {
    const outcome = validateLockerImageBytes(webpLossyFixture(256, 144));
    expect(outcome).toMatchObject({ ok: true, mime: "image/webp", width: 256, height: 144 });
  });

  it("accepts an extended WebP (`VP8X`) and un-biases its width-1/height-1 canvas fields", () => {
    const outcome = validateLockerImageBytes(webpExtendedFixture(1000, 750));
    expect(outcome).toMatchObject({ ok: true, mime: "image/webp", width: 1000, height: 750 });
  });

  it("reports the exact byte length it validated", () => {
    const bytes = pngFixture(10, 10);
    const outcome = validateLockerImageBytes(bytes);
    expect(outcome.ok && outcome.byteLength).toBe(bytes.byteLength);
  });
});

// ── Refusals: size ────────────────────────────────────────────────────────

/**
 * THE CEILING HERE IS THE RESOURCE BOUND, not Trench's 20 KB on-chain budget.
 * Since the per-lane decision (2026-08-19) this validator runs on the ORIGINAL
 * the locker stores, and the original is what pools.fun publishes - a lane with
 * no size limit of ours. The Trench budget is enforced on the DERIVED copy, on
 * the launch path.
 */
describe("validateLockerImageBytes - the resource bound", () => {
  it("accepts a file exactly at the bound", () => {
    const bytes = pngFixture(8, 8, LOCKER_IMAGE_MAX_SOURCE_BYTES - 33);
    expect(bytes.byteLength).toBe(LOCKER_IMAGE_MAX_SOURCE_BYTES);
    expect(rejectionKind(bytes)).toBe("accepted");
  });

  it("refuses a file one byte over the bound", () => {
    const bytes = pngFixture(8, 8, LOCKER_IMAGE_MAX_SOURCE_BYTES - 32);
    expect(bytes.byteLength).toBe(LOCKER_IMAGE_MAX_SOURCE_BYTES + 1);
    expect(rejectionKind(bytes)).toBe("too_large");
  });

  it("reports both numbers on an oversized refusal, so the message can be specific", () => {
    const outcome = validateLockerImageBytes(pngFixture(8, 8, LOCKER_IMAGE_MAX_SOURCE_BYTES));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection).toMatchObject({
      kind: "too_large",
      maxBytes: LOCKER_IMAGE_MAX_SOURCE_BYTES,
    });
  });

  it("checks size BEFORE sniffing, so a huge non-image is not mis-blamed on its format", () => {
    const bytes = new Uint8Array(LOCKER_IMAGE_MAX_SOURCE_BYTES + 1);
    bytes.set(new TextEncoder().encode("%PDF-1.7"), 0);
    expect(rejectionKind(bytes)).toBe("too_large");
  });

  it("refuses an empty file", () => {
    expect(rejectionKind(new Uint8Array(0))).toBe("too_small");
  });

  it("refuses a file below the minimum header length", () => {
    expect(rejectionKind(new Uint8Array(LOCKER_IMAGE_MIN_BYTES - 1))).toBe("too_small");
  });
});

// ── Refusals: format ──────────────────────────────────────────────────────

describe("validateLockerImageBytes - magic bytes decide, nothing else", () => {
  it("refuses a GIF (a real image, but off the allowlist)", () => {
    const bytes = new Uint8Array(64);
    bytes.set(new TextEncoder().encode("GIF89a"), 0);
    expect(rejectionKind(bytes)).toBe("unsupported_format");
  });

  it("refuses an SVG - a scriptable document, never a raster image here", () => {
    const bytes = new Uint8Array(128);
    bytes.set(new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\">"), 0);
    expect(rejectionKind(bytes)).toBe("unsupported_format");
  });

  it("refuses a PDF", () => {
    const bytes = new Uint8Array(64);
    bytes.set(new TextEncoder().encode("%PDF-1.7"), 0);
    expect(rejectionKind(bytes)).toBe("unsupported_format");
  });

  it("refuses an ELF executable", () => {
    const bytes = new Uint8Array(64);
    bytes.set([0x7f, 0x45, 0x4c, 0x46], 0);
    expect(rejectionKind(bytes)).toBe("unsupported_format");
  });

  it("refuses a ZIP even though a .png could be renamed onto it", () => {
    const bytes = new Uint8Array(64);
    bytes.set([0x50, 0x4b, 0x03, 0x04], 0);
    expect(rejectionKind(bytes)).toBe("unsupported_format");
  });

  it("refuses a PNG whose signature is intact but whose IHDR is not", () => {
    const bytes = pngFixture(64, 64);
    bytes.set(new TextEncoder().encode("JUNK"), 12); // clobber the "IHDR" tag
    expect(rejectionKind(bytes)).toBe("unsupported_format");
  });

  it("refuses a RIFF container that is not WEBP (e.g. a WAV)", () => {
    const out = new Uint8Array(64);
    out.set(new TextEncoder().encode("RIFF"), 0);
    out.set(new TextEncoder().encode("WAVE"), 8);
    expect(rejectionKind(out)).toBe("unsupported_format");
  });

  it("refuses a WEBP whose chunk type is unknown to us, rather than guessing dimensions", () => {
    expect(rejectionKind(riffContainer("XXXX", new Array<number>(16).fill(0)))).toBe(
      "unsupported_format",
    );
  });

  it("refuses a JPEG with no SOF frame header", () => {
    const bytes = new Uint8Array(64);
    bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], 0);
    expect(rejectionKind(bytes)).toBe("unsupported_format");
  });

  it("refuses a truncated header instead of reading past the end of the buffer", () => {
    const full = pngFixture(64, 64);
    expect(rejectionKind(full.slice(0, 18))).toBe("unsupported_format");
  });
});

// ── Refusals: implausible dimensions ──────────────────────────────────────

describe("validateLockerImageBytes - the dimension plausibility band", () => {
  it("refuses a zero-width header", () => {
    expect(rejectionKind(pngFixture(0, 64))).toBe("unsupported_format");
  });

  it("refuses a zero-height header", () => {
    expect(rejectionKind(pngFixture(64, 0))).toBe("unsupported_format");
  });

  it("refuses an absurd dimension - a hostile header, not a large picture", () => {
    // 20 KB cannot contain a 100000px-wide raster; the header is lying.
    expect(rejectionKind(pngFixture(100_000, 10))).toBe("unsupported_format");
  });
});

// ── Label derivation ──────────────────────────────────────────────────────

describe("deriveLockerImageLabel", () => {
  it("keeps the base name and drops the directory - a label is never a path", () => {
    expect(deriveLockerImageLabel("/home/someone/pictures/moon.png")).toBe("moon.png");
  });

  it("drops a Windows directory too", () => {
    expect(deriveLockerImageLabel("C:\\Users\\someone\\moon.png")).toBe("moon.png");
  });

  it("strips path separators and control characters out of a hostile file name", () => {
    const label = deriveLockerImageLabel("../../etc/pass\u0000wd.png");
    expect(label).not.toContain("/");
    expect(label).not.toContain("..");
    expect(label).not.toContain("\u0000");
  });

  it("truncates a very long name rather than rejecting the upload", () => {
    const label = deriveLockerImageLabel(`${"a".repeat(500)}.png`);
    expect(label.length).toBeLessThanOrEqual(80);
  });

  it("falls back to a neutral label when nothing usable survives", () => {
    expect(deriveLockerImageLabel("///").length).toBeGreaterThan(0);
  });
});
