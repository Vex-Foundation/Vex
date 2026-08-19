/**
 * The locker's ingest path, under the per-lane image decision (2026-08-19).
 *
 * THE PROPERTY THAT MATTERS MOST: the ORIGINAL bytes are stored VERBATIM and
 * `digest` describes them, while `onchain_digest` describes the derived Trench
 * copy. Before the split, a downscale rewrote what the locker held, so every
 * pools.fun launch published a degraded picture; after it, the ladder produces
 * a SECOND file that only Trench consumes.
 *
 * Also pinned: an image already inside the Trench budget is its own copy and no
 * second file is written; an EXHAUSTED ladder stores the image with no copy
 * instead of refusing the upload; a decode failure is still a refusal; and a
 * file too large to even read is refused from `stat`, without being pulled into
 * memory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const VARIANT_BYTES = new Uint8Array(Array.from({ length: 14_000 }, (_, i) => i % 251));
const FITTING_BYTES = new Uint8Array(Array.from({ length: 9_000 }, (_, i) => (i * 7) % 251));
/**
 * Stands in for the multi-megabyte photo. Kept small on purpose: the assertions
 * deep-compare it, and a literal 3 MB array turns each comparison into seconds.
 * The size that matters to the behaviour is `originalByteLength` on the ladder's
 * own report, which is stated independently below.
 */
const ORIGINAL_BYTES = new Uint8Array(Array.from({ length: 60_000 }, (_, i) => (i * 13) % 251));

let statSize = 3_000_000;
let fileBytes: Uint8Array = ORIGINAL_BYTES;

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
const writeOnchainVariantBytes = vi.fn(async (_id: string, _bytes: Uint8Array) => undefined);
vi.mock("../byte-store.js", () => ({
  newLockerImageId: () => "img_0123456789abcdef0123456789abcdef",
  writeImageBytes: (id: string, bytes: Uint8Array) => writeImageBytes(id, bytes),
  writeOnchainVariantBytes: (id: string, bytes: Uint8Array) =>
    writeOnchainVariantBytes(id, bytes),
  removeImageBytes: async () => undefined,
  removeOnchainVariantBytes: async () => undefined,
  readImageBytes: async () => null,
  readOnchainVariantBytes: async () => null,
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
const { LOCKER_IMAGE_MAX_SOURCE_BYTES, TRENCH_ONCHAIN_IMAGE_MAX_BYTES } = await import(
  "@shared/schemas/images.js"
);

const digestOf = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

beforeEach(() => {
  statSize = 3_000_000;
  fileBytes = ORIGINAL_BYTES;
  // SQUARE: the re-encode path center-crops to 1:1 because Trench renders
  // token tiles at 1:1 exclusively (owner observation, screenshot evidence).
  downscaleLockerImage.mockReturnValue({
    kind: "optimized",
    bytes: VARIANT_BYTES,
    originalByteLength: 3_000_000,
    width: 512,
    height: 512,
  });
  validateLockerImageBytes.mockImplementation((bytes: Uint8Array) => ({
    ok: true,
    mime: "image/jpeg",
    width: 4000,
    height: 3000,
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

describe("an oversized image is stored whole, with a derived Trench copy", () => {
  it("stores the ORIGINAL verbatim and writes the copy to its own file", async () => {
    const outcome = await storeLockerImageFromFile("/picked/holiday.jpg");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    // The bytes the user picked, untouched. This is what pools.fun uploads.
    expect(writeImageBytes).toHaveBeenCalledWith(expect.any(String), ORIGINAL_BYTES);
    expect(outcome.image.byteLength).toBe(ORIGINAL_BYTES.byteLength);
    expect(outcome.image.digest).toBe(digestOf(ORIGINAL_BYTES));
    // The copy lands BESIDE it, never instead of it.
    expect(writeOnchainVariantBytes).toHaveBeenCalledWith(expect.any(String), VARIANT_BYTES);
    expect(outcome.image.onchainByteLength).toBe(VARIANT_BYTES.byteLength);
    expect(outcome.image.onchainByteLength ?? 0).toBeLessThanOrEqual(
      TRENCH_ONCHAIN_IMAGE_MAX_BYTES,
    );
    expect(outcome.onchainVariant).toEqual({
      originalByteLength: 3_000_000,
      variantByteLength: VARIANT_BYTES.byteLength,
    });
  });

  it("records the copy's own digest, so the signing path can verify what goes on-chain", async () => {
    await storeLockerImageFromFile("/picked/holiday.jpg");

    const written = insertLaunchImage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.digest).toBe(digestOf(ORIGINAL_BYTES));
    expect(written.onchainDigest).toBe(digestOf(VARIANT_BYTES));
    expect(written.onchainByteLength).toBe(VARIANT_BYTES.byteLength);
    // The two are DIFFERENT here, which is precisely what "a second file
    // exists" means to every reader of this row.
    expect(written.onchainDigest).not.toBe(written.digest);
  });

  it("validates the ORIGINAL, and runs the ladder on it too", async () => {
    const picked = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
    fileBytes = picked;
    await storeLockerImageFromFile("/picked/holiday.jpg");

    expect(validateLockerImageBytes).toHaveBeenCalledWith(picked);
    expect(downscaleLockerImage.mock.calls[0]?.[0]).toStrictEqual(picked);
  });
});

describe("an image that already fits is its own on-chain copy", () => {
  it("writes ONE file and records equal digests, even when NOT square", async () => {
    // Byte-identity outranks tile aesthetics for a file the user deliberately
    // kept under the budget: it is never re-encoded and never cropped.
    downscaleLockerImage.mockReturnValue({ kind: "unchanged", bytes: FITTING_BYTES });
    fileBytes = FITTING_BYTES;
    validateLockerImageBytes.mockReturnValue({
      ok: true,
      mime: "image/png",
      width: 800,
      height: 300,
      byteLength: FITTING_BYTES.byteLength,
    });

    const outcome = await storeLockerImageFromFile("/picked/small.png");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    // Absence is the claim "nothing had to be derived".
    expect(outcome.onchainVariant).toBeUndefined();
    expect(writeOnchainVariantBytes).not.toHaveBeenCalled();
    expect(outcome.image.width).toBe(800);
    expect(outcome.image.height).toBe(300);
    expect(outcome.image.onchainByteLength).toBe(FITTING_BYTES.byteLength);

    const written = insertLaunchImage.mock.calls[0]?.[0] as Record<string, unknown>;
    // Digest equality IS the encoding of "there is no second file".
    expect(written.onchainDigest).toBe(written.digest);
    expect(written.onchainDigest).toBe(digestOf(FITTING_BYTES));
  });

  it("is byte-for-byte what a pre-080 row was, so the C0 binding does not move", async () => {
    // Every image stored before the split satisfied the old 20 480 CHECK, and
    // migration 080 backfilled `onchain_* = byte_length/digest` for exactly that
    // reason. This asserts the live path produces the same shape for such a
    // file: the digest a Trench authorization binds is the digest of the stored
    // bytes, as it always was.
    downscaleLockerImage.mockReturnValue({ kind: "unchanged", bytes: FITTING_BYTES });
    fileBytes = FITTING_BYTES;
    validateLockerImageBytes.mockReturnValue({
      ok: true,
      mime: "image/png",
      width: 300,
      height: 300,
      byteLength: FITTING_BYTES.byteLength,
    });

    await storeLockerImageFromFile("/picked/legacy.png");

    const written = insertLaunchImage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.onchainDigest).toBe(written.digest);
    expect(written.onchainByteLength).toBe(written.byteLength);
  });
});

describe("an exhausted ladder is a pools-only image, not a refused upload", () => {
  it("stores the original with NO on-chain copy", async () => {
    downscaleLockerImage.mockReturnValue({ kind: "exhausted", smallestByteLength: 44_000 });

    const outcome = await storeLockerImageFromFile("/picked/pathological.png");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(writeImageBytes).toHaveBeenCalledWith(expect.any(String), ORIGINAL_BYTES);
    expect(writeOnchainVariantBytes).not.toHaveBeenCalled();
    expect(outcome.image.onchainByteLength).toBeNull();
    expect(outcome.onchainVariant).toBeUndefined();

    const written = insertLaunchImage.mock.calls[0]?.[0] as Record<string, unknown>;
    // BOTH null, never half a variant: the pairing CHECK in migration 080 makes
    // that a database fact, and this is the writer that has to honour it.
    expect(written.onchainByteLength).toBeNull();
    expect(written.onchainDigest).toBeNull();
  });
});

describe("refusals that survive the split", () => {
  it("refuses a file it cannot decode rather than storing something else", async () => {
    downscaleLockerImage.mockReturnValue({ kind: "undecodable" });

    const outcome = await storeLockerImageFromFile("/picked/logo.svg");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.rejection.kind).toBe("unsupported_format");
    expect(writeImageBytes).not.toHaveBeenCalled();
  });

  it("refuses an enormous file from stat, naming the RESOURCE bound", async () => {
    statSize = 900 * 1024 * 1024;

    const outcome = await storeLockerImageFromFile("/picked/huge.tif");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.rejection).toEqual({
      kind: "too_large",
      byteLength: statSize,
      maxBytes: LOCKER_IMAGE_MAX_SOURCE_BYTES,
    });
    // The ladder is never even reached — the bytes were never read.
    expect(downscaleLockerImage).not.toHaveBeenCalled();
  });

  it("refuses bytes that fail validation, before anything is written", async () => {
    validateLockerImageBytes.mockReturnValue({
      ok: false,
      rejection: { kind: "unsupported_format", reason: "not an image" },
    });

    const outcome = await storeLockerImageFromFile("/picked/weird.jpg");

    expect(outcome.ok).toBe(false);
    expect(writeImageBytes).not.toHaveBeenCalled();
    expect(downscaleLockerImage).not.toHaveBeenCalled();
  });
});
