/**
 * The locker's ingest path, with auto-downscale wired in.
 *
 * THE PROPERTY THAT MATTERS MOST: the metadata — width, height, mime, and above
 * all the DIGEST — describes the bytes that were STORED, never the bytes the
 * user picked. That digest travels into a launch authorization and is compared
 * on the signing path, so a hash of the original next to a re-encoded file on
 * disk would refuse every launch that used an optimized image (or, worse, put a
 * digest on-chain that nothing can reproduce).
 *
 * Also pinned: an already-fitting file is written through untouched with NO
 * optimization report; a decode failure and an exhausted ladder both keep their
 * existing named refusals; and a file too large to even read is refused from
 * `stat`, without being pulled into memory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const OPTIMIZED_BYTES = new Uint8Array(Array.from({ length: 14_000 }, (_, i) => i % 251));
const FITTING_BYTES = new Uint8Array(Array.from({ length: 9_000 }, (_, i) => (i * 7) % 251));

let statSize = 3_000_000;
let fileBytes: Uint8Array = new Uint8Array(3_000_000);

vi.mock("node:fs/promises", () => ({
  stat: async () => ({ size: statSize }),
  readFile: async () => Buffer.from(fileBytes),
}));

const downscaleLockerImage = vi.fn();
vi.mock("../downscale.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../downscale.js")>();
  return {
    ...actual,
    downscaleLockerImage: (bytes: Uint8Array) => downscaleLockerImage(bytes),
  };
});

const validateLockerImageBytes = vi.fn();
vi.mock("../image-validation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../image-validation.js")>();
  return {
    ...actual,
    validateLockerImageBytes: (bytes: Uint8Array) => validateLockerImageBytes(bytes),
  };
});

const writeImageBytes = vi.fn(async (_id: string, _bytes: Uint8Array) => undefined);
vi.mock("../byte-store.js", () => ({
  newLockerImageId: () => "img_0123456789abcdef0123456789abcdef",
  writeImageBytes: (id: string, bytes: Uint8Array) => writeImageBytes(id, bytes),
  removeImageBytes: async () => undefined,
  readImageBytes: async () => null,
  digestOf: (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex"),
}));

const insertLaunchImage = vi.fn();
vi.mock("@vex-agent/db/repos/launch-images.js", () => ({
  insertLaunchImage: (input: unknown) => insertLaunchImage(input),
  listLaunchImages: async () => [],
  getLaunchImage: async () => null,
  deleteLaunchImage: async () => ({ deleted: false }),
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { storeLockerImageFromFile } = await import("../locker.js");
const { LOCKER_IMAGE_MAX_BYTES } = await import("@shared/schemas/images.js");

const digestOfStored = createHash("sha256").update(OPTIMIZED_BYTES).digest("hex");

beforeEach(() => {
  statSize = 3_000_000;
  fileBytes = new Uint8Array(3_000_000);
  downscaleLockerImage.mockReturnValue({
    kind: "optimized",
    bytes: OPTIMIZED_BYTES,
    originalByteLength: 3_000_000,
    width: 512,
    height: 384,
  });
  validateLockerImageBytes.mockImplementation((bytes: Uint8Array) => ({
    ok: true,
    mime: "image/jpeg",
    width: 512,
    height: 384,
    byteLength: bytes.byteLength,
  }));
  insertLaunchImage.mockImplementation(async (input: Record<string, unknown>) => ({
    ...input,
    uploadedAt: "2026-08-02T10:00:00.000Z",
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("an oversized image is optimized, not refused", () => {
  it("stores bytes under the cap and reports the reduction", async () => {
    const outcome = await storeLockerImageFromFile("/picked/holiday.jpg");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.image.byteLength).toBeLessThanOrEqual(LOCKER_IMAGE_MAX_BYTES);
    expect(outcome.optimization).toEqual({
      originalByteLength: 3_000_000,
      storedByteLength: OPTIMIZED_BYTES.byteLength,
    });
  });

  it("hashes and validates the STORED bytes, never the original", async () => {
    const outcome = await storeLockerImageFromFile("/picked/holiday.jpg");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    // The digest is the consent chain's anchor — it must describe what is on
    // disk, or a launch signed against it can never be reproduced.
    expect(outcome.image.digest).toBe(digestOfStored);
    expect(writeImageBytes).toHaveBeenCalledWith(expect.any(String), OPTIMIZED_BYTES);
    expect(validateLockerImageBytes).toHaveBeenCalledWith(OPTIMIZED_BYTES);
    const written = insertLaunchImage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.digest).toBe(digestOfStored);
    expect(written.byteLength).toBe(OPTIMIZED_BYTES.byteLength);
  });

  it("runs the ladder on the ORIGINAL file bytes", async () => {
    fileBytes = new Uint8Array([9, 9, 9]);
    await storeLockerImageFromFile("/picked/holiday.jpg");
    const passed = downscaleLockerImage.mock.calls[0]?.[0] as Uint8Array;
    expect(Array.from(passed)).toEqual([9, 9, 9]);
  });
});

describe("an image that already fits", () => {
  it("is stored byte-identical with NO optimization report", async () => {
    downscaleLockerImage.mockReturnValue({ kind: "unchanged", bytes: FITTING_BYTES });

    const outcome = await storeLockerImageFromFile("/picked/small.png");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    // Absence is the claim "we did not touch your file".
    expect(outcome.optimization).toBeUndefined();
    expect(writeImageBytes).toHaveBeenCalledWith(expect.any(String), FITTING_BYTES);
    expect(outcome.image.digest).toBe(
      createHash("sha256").update(FITTING_BYTES).digest("hex"),
    );
  });
});

describe("refusals that survive auto-downscale", () => {
  it("refuses a file it cannot decode rather than storing something else", async () => {
    downscaleLockerImage.mockReturnValue({ kind: "undecodable" });

    const outcome = await storeLockerImageFromFile("/picked/logo.svg");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.rejection.kind).toBe("unsupported_format");
    expect(writeImageBytes).not.toHaveBeenCalled();
  });

  it("refuses when the ladder is exhausted, reporting its best attempt", async () => {
    downscaleLockerImage.mockReturnValue({ kind: "exhausted", smallestByteLength: 44_000 });

    const outcome = await storeLockerImageFromFile("/picked/pathological.png");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.rejection).toEqual({
      kind: "too_large",
      byteLength: 44_000,
      maxBytes: LOCKER_IMAGE_MAX_BYTES,
    });
    expect(writeImageBytes).not.toHaveBeenCalled();
  });

  it("refuses an enormous file from stat, without reading it into memory", async () => {
    statSize = 900 * 1024 * 1024;

    const outcome = await storeLockerImageFromFile("/picked/huge.tif");

    expect(outcome.ok).toBe(false);
    // The ladder is never even reached — the bytes were never read.
    expect(downscaleLockerImage).not.toHaveBeenCalled();
  });

  it("still refuses bytes that fail validation after optimization", async () => {
    validateLockerImageBytes.mockReturnValue({
      ok: false,
      rejection: { kind: "unsupported_format", reason: "not an image" },
    });

    const outcome = await storeLockerImageFromFile("/picked/weird.jpg");

    expect(outcome.ok).toBe(false);
    expect(writeImageBytes).not.toHaveBeenCalled();
  });
});
