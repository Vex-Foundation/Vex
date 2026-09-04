/**
 * The backdrop validation matrix, gate by gate.
 *
 * `nativeImage` is stubbed: these tests own the MATRIX's decisions (order,
 * allowlist, band), not Chromium's decoder. The decoder's real answer on this
 * Electron is a MEASUREMENT recorded in the module header (PNG and JPEG
 * decode; WebP reports empty), and the WebP case below pins the consequence:
 * a WebP is refused BY NAME before the decoder is even asked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface StubSize {
  width: number;
  height: number;
}

let decodedSize: StubSize;
let decodable = true;
const createFromBuffer = vi.fn((_buffer: Buffer) => ({
  isEmpty: () => !decodable,
  getSize: () => decodedSize,
}));

vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: (buffer: Buffer) => createFromBuffer(buffer) },
}));

const { validateShellBackdropBytes } = await import("../validation.js");
const {
  SHELL_BACKDROP_MAX_SOURCE_BYTES,
  SHELL_BACKDROP_MIME_TYPES,
  SHELL_BACKDROP_PICKER_EXTENSIONS,
} = await import("@shared/schemas/shell-backdrop.js");

/** A PNG header (signature + IHDR) declaring the given size, padded past the byte floor. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A JPEG: SOI, one APP0 segment, then an SOF0 declaring the given size. */
function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0xff, 0xd8], 0);
  bytes.set([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], 2); // APP0, length 4
  const sof = 8;
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], sof);
  const view = new DataView(bytes.buffer);
  view.setUint16(sof + 5, height);
  view.setUint16(sof + 7, width);
  return bytes;
}

/** A lossy WebP (RIFF/WEBP/VP8 ) declaring the given size. */
function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  ascii(8, "WEBP");
  ascii(12, "VP8 ");
  const frame = 20;
  bytes.set([0x9d, 0x01, 0x2a], frame + 3);
  const view = new DataView(bytes.buffer);
  view.setUint16(frame + 6, width, true);
  view.setUint16(frame + 8, height, true);
  return bytes;
}

beforeEach(() => {
  decodable = true;
  decodedSize = { width: 1920, height: 1080 };
  createFromBuffer.mockClear();
});

describe("the size gates run first", () => {
  it("refuses a buffer over 8 MiB without sniffing or decoding", () => {
    const outcome = validateShellBackdropBytes(new Uint8Array(SHELL_BACKDROP_MAX_SOURCE_BYTES + 1));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.rejection).toEqual({
      kind: "too_large",
      byteLength: SHELL_BACKDROP_MAX_SOURCE_BYTES + 1,
      maxBytes: SHELL_BACKDROP_MAX_SOURCE_BYTES,
    });
    expect(createFromBuffer).not.toHaveBeenCalled();
  });

  it("refuses an empty or tiny file by name", () => {
    const outcome = validateShellBackdropBytes(new Uint8Array(3));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.rejection.kind).toBe("too_small");
    expect(createFromBuffer).not.toHaveBeenCalled();
  });
});

describe("format is decided by magic bytes, and the allowlist is PNG + JPEG", () => {
  it("accepts a PNG and a JPEG, recording the DECODED size", () => {
    decodedSize = { width: 2560, height: 1440 };
    for (const bytes of [png(1920, 1080), jpeg(1920, 1080)]) {
      const outcome = validateShellBackdropBytes(bytes);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("unreachable");
      // The decoder's answer, not the header's claim.
      expect(outcome.width).toBe(2560);
      expect(outcome.height).toBe(1440);
      expect(outcome.byteLength).toBe(64);
    }
  });

  it("names the mime from the bytes", () => {
    const asPng = validateShellBackdropBytes(png(1920, 1080));
    const asJpeg = validateShellBackdropBytes(jpeg(1920, 1080));
    expect(asPng.ok && asPng.mime).toBe("image/png");
    expect(asJpeg.ok && asJpeg.mime).toBe("image/jpeg");
  });

  it("refuses a WebP BY NAME before asking the decoder (measured: nativeImage cannot decode it)", () => {
    const outcome = validateShellBackdropBytes(webp(1920, 1080));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.rejection.kind).toBe("unsupported_format");
    expect(outcome.rejection.kind === "unsupported_format" && outcome.rejection.reason).toMatch(
      /WebP/,
    );
    expect(createFromBuffer).not.toHaveBeenCalled();
  });

  it("refuses bytes with no known signature, whatever the extension claimed", () => {
    const gif = new Uint8Array(64);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
    const outcome = validateShellBackdropBytes(gif);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.rejection.kind).toBe("unsupported_format");
    expect(createFromBuffer).not.toHaveBeenCalled();
  });

  it("keeps the picker filter and the mime allowlist in step", () => {
    // The picker OFFERS exactly the extensions of the mimes the matrix ACCEPTS.
    expect(SHELL_BACKDROP_MIME_TYPES).toEqual(["image/png", "image/jpeg"]);
    expect([...SHELL_BACKDROP_PICKER_EXTENSIONS].sort()).toEqual(["jpeg", "jpg", "png"]);
  });
});

describe("the decode proof and the band on the decoded size", () => {
  it("refuses a file the decoder cannot decode, whatever its header says", () => {
    decodable = false;
    const outcome = validateShellBackdropBytes(png(1920, 1080));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.rejection.kind).toBe("undecodable");
    expect(createFromBuffer).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ width: 639, height: 360 }, "one pixel under the width floor"],
    [{ width: 640, height: 359 }, "one pixel under the height floor"],
    [{ width: 8193, height: 4000 }, "over the width ceiling"],
    [{ width: 4000, height: 8193 }, "over the height ceiling"],
    [{ width: 0, height: 0 }, "an empty picture"],
  ])("refuses a decoded size of %o (%s) as undecodable", (size) => {
    decodedSize = size;
    const outcome = validateShellBackdropBytes(png(1920, 1080));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.rejection.kind).toBe("undecodable");
  });

  it.each([
    [{ width: 640, height: 360 }],
    [{ width: 8192, height: 8192 }],
  ])("accepts the band's own edges %o", (size) => {
    decodedSize = size;
    expect(validateShellBackdropBytes(png(1920, 1080)).ok).toBe(true);
  });
});
