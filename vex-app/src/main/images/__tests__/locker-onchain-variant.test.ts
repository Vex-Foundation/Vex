/**
 * Reading and deleting an image once the locker holds TWO variants.
 *
 * WHAT THESE PIN, and why each one is a real failure mode:
 *  - the thumbnail is built from the TRENCH COPY, not the original. Getting
 *    this wrong puts a multi-megabyte base64 string on the IPC bus for every
 *    tile in the grid;
 *  - the copy's MIME is sniffed from the copy. The row describes the ORIGINAL,
 *    so a PNG whose copy the ladder re-encoded to JPEG would otherwise be
 *    served as `data:image/png`, which no renderer can decode;
 *  - an image with no copy has NO cheap thumbnail and answers `null` rather
 *    than being rendered expensively;
 *  - digest equality selects the file. Reading the wrong one is how a launch
 *    would sign over bytes nobody was shown;
 *  - deletion removes BOTH files. A leftover copy is an orphan the locker has
 *    no record of.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const IMAGE_ID = "img_0123456789abcdef0123456789abcdef";

/** A minimal but REAL 1x1 JPEG, so the thumbnail's magic-byte sniff is honest. */
const JPEG_COPY = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x40, 0x03, 0x01, 0x22, 0x00,
  0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

/** A real PNG header, used where the ORIGINAL is also the copy. */
const PNG_ORIGINAL = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
  0x52, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x40, 0x08, 0x06, 0x00, 0x00, 0x00, 0x00,
]);

const digestOfBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

let originalBytes: Uint8Array | null = null;
let variantBytes: Uint8Array | null = null;
const removeImageBytes = vi.fn(async (_id: string) => undefined);
const removeOnchainVariantBytes = vi.fn(async (_id: string) => undefined);

vi.mock("../byte-store.js", () => ({
  newLockerImageId: () => IMAGE_ID,
  writeImageBytes: async () => undefined,
  writeOnchainVariantBytes: async () => undefined,
  removeImageBytes: (id: string) => removeImageBytes(id),
  removeOnchainVariantBytes: (id: string) => removeOnchainVariantBytes(id),
  readImageBytes: async () => originalBytes,
  readOnchainVariantBytes: async () => variantBytes,
  digestOf: (bytes: Uint8Array) => digestOfBytes(bytes),
}));

let row: Record<string, unknown> | null = null;
let deleteOutcome: unknown = { deleted: true, row: {} };

vi.mock("@vex-agent/db/repos/launch-images.js", () => ({
  insertLaunchImage: async () => row,
  listLaunchImages: async () => (row === null ? [] : [row]),
  getLaunchImage: async () => row,
  deleteLaunchImage: async () => deleteOutcome,
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { deleteLockerImage, readLockerImageDataUrl, readLockerImageOnchainBytes } =
  await import("../locker.js");

/** A metadata row whose original and copy are DIFFERENT files. */
function rowWithSeparateCopy(): Record<string, unknown> {
  return {
    imageId: IMAGE_ID,
    label: "holiday.png",
    byteLength: PNG_ORIGINAL.byteLength,
    mime: "image/png",
    width: 4000,
    height: 3000,
    digest: digestOfBytes(PNG_ORIGINAL),
    onchainByteLength: JPEG_COPY.byteLength,
    onchainDigest: digestOfBytes(JPEG_COPY),
    uploadedAt: "2026-08-19T10:00:00.000Z",
  };
}

/** A metadata row where the original IS its own copy (the pre-083 shape). */
function rowThatIsItsOwnCopy(): Record<string, unknown> {
  return {
    ...rowWithSeparateCopy(),
    byteLength: PNG_ORIGINAL.byteLength,
    onchainByteLength: PNG_ORIGINAL.byteLength,
    onchainDigest: digestOfBytes(PNG_ORIGINAL),
  };
}

beforeEach(() => {
  originalBytes = PNG_ORIGINAL;
  variantBytes = JPEG_COPY;
  row = rowWithSeparateCopy();
  deleteOutcome = { deleted: true, row: rowWithSeparateCopy() };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("readLockerImageOnchainBytes picks the file by digest equality", () => {
  it("reads the SEPARATE copy when the two digests differ", async () => {
    const resolved = await readLockerImageOnchainBytes(IMAGE_ID);
    expect(resolved?.bytes).toBe(JPEG_COPY);
    expect(resolved?.digest).toBe(digestOfBytes(JPEG_COPY));
  });

  it("reads the ORIGINAL when it is its own copy, with no second file on disk", async () => {
    row = rowThatIsItsOwnCopy();
    variantBytes = null;

    const resolved = await readLockerImageOnchainBytes(IMAGE_ID);
    expect(resolved?.bytes).toBe(PNG_ORIGINAL);
    expect(resolved?.digest).toBe(digestOfBytes(PNG_ORIGINAL));
  });

  it("refuses bytes whose digest no longer matches, exactly like a missing image", async () => {
    variantBytes = new Uint8Array([1, 2, 3, 4]);
    await expect(readLockerImageOnchainBytes(IMAGE_ID)).resolves.toBeNull();
  });

  it("refuses a length that disagrees with the metadata", async () => {
    row = { ...rowWithSeparateCopy(), onchainByteLength: JPEG_COPY.byteLength + 1 };
    await expect(readLockerImageOnchainBytes(IMAGE_ID)).resolves.toBeNull();
  });

  it("answers null for an image with no on-chain copy at all", async () => {
    row = { ...rowWithSeparateCopy(), onchainByteLength: null, onchainDigest: null };
    await expect(readLockerImageOnchainBytes(IMAGE_ID)).resolves.toBeNull();
  });
});

describe("the thumbnail renders the on-chain copy", () => {
  it("builds the data URL from the COPY, and sniffs the COPY's mime", async () => {
    const dataUrl = await readLockerImageDataUrl(IMAGE_ID);

    // The ROW says image/png (that is the original). The copy is a JPEG, and
    // the `data:` URL has to say so or nothing can decode it.
    expect(dataUrl).toBe(
      `data:image/jpeg;base64,${Buffer.from(JPEG_COPY).toString("base64")}`,
    );
  });

  it("uses the original's own mime when the original IS the copy", async () => {
    row = rowThatIsItsOwnCopy();
    variantBytes = null;

    const dataUrl = await readLockerImageDataUrl(IMAGE_ID);
    expect(dataUrl).toBe(
      `data:image/png;base64,${Buffer.from(PNG_ORIGINAL).toString("base64")}`,
    );
  });

  it("returns null for a copy-less image rather than shipping the original", async () => {
    row = { ...rowWithSeparateCopy(), onchainByteLength: null, onchainDigest: null };
    await expect(readLockerImageDataUrl(IMAGE_ID)).resolves.toBeNull();
  });
});

describe("deletion removes both files", () => {
  it("removes the original AND the derived copy once the row is provably gone", async () => {
    await deleteLockerImage(IMAGE_ID);

    expect(removeImageBytes).toHaveBeenCalledWith(IMAGE_ID);
    expect(removeOnchainVariantBytes).toHaveBeenCalledWith(IMAGE_ID);
  });

  it("removes NOTHING when the repo refused the delete", async () => {
    deleteOutcome = { deleted: false, reason: "referenced_by_live_intent", intents: [] };

    await deleteLockerImage(IMAGE_ID);

    expect(removeImageBytes).not.toHaveBeenCalled();
    expect(removeOnchainVariantBytes).not.toHaveBeenCalled();
  });
});
