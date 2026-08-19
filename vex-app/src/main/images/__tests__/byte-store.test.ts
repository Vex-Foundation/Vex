/**
 * The locker BYTE store — path containment and round-trip.
 *
 * `resolveImagePath` is the last thing standing between an id and the
 * filesystem, so its refusals are tested directly rather than only through
 * the IPC layer. The IPC schema already rejects a malformed id, which means
 * these cases are unreachable in production today — that is exactly why they
 * are pinned here: if a future change loosens the id format, this test fails
 * instead of a `rm` succeeding somewhere it should not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let tempConfigDir: string;

beforeEach(async () => {
  tempConfigDir = await mkdtemp(path.join(tmpdir(), "vex-locker-"));
  process.env["VEX_CONFIG_DIR"] = tempConfigDir;
  // CONFIG_DIR is resolved at module load, so the store must be imported
  // AFTER the override is in place.
  vi.resetModules();
});

afterEach(async () => {
  delete process.env["VEX_CONFIG_DIR"];
  await rm(tempConfigDir, { recursive: true, force: true });
});

async function loadStore() {
  return import("../byte-store.js");
}

const VALID_ID = "img_0123456789abcdef0123456789abcdef";

describe("resolveImagePath — containment", () => {
  it.each([
    ["../../../etc/passwd", "posix traversal"],
    ["..\\..\\evil", "windows traversal"],
    ["/etc/passwd", "an absolute path"],
    ["img_0123456789abcdef0123456789abcdef/../../evil", "traversal appended to a valid id"],
    ["img_..", "traversal wearing the id prefix"],
    ["img_0123456789ABCDEF0123456789ABCDEF", "uppercase hex"],
    ["img_short", "a short id"],
    ["", "an empty id"],
  ])("refuses %s (%s)", async (imageId) => {
    const store = await loadStore();
    expect(() => store.resolveImagePath(imageId)).toThrow(store.LockerPathEscapeError);
  });

  it("resolves a well-formed id to a file directly inside the locker directory", async () => {
    const store = await loadStore();
    const resolved = store.resolveImagePath(VALID_ID);
    expect(path.dirname(resolved)).toBe(path.resolve(store.LOCKER_IMAGES_DIR));
    expect(path.basename(resolved)).toBe(`${VALID_ID}.bin`);
  });

  it("names the stored file from the id alone, with a neutral extension", async () => {
    // The real type is recorded in the metadata row after magic-byte
    // validation; a `.png` on disk would invite a later reader to trust the
    // extension over the validation that actually happened.
    const store = await loadStore();
    expect(store.resolveImagePath(VALID_ID).endsWith(".bin")).toBe(true);
  });
});

/**
 * The Trench on-chain copy gets the SAME two gates as the original. It exists
 * only when the ladder re-encoded, so it is a second file in the same
 * directory, never a suffix a caller concatenates onto an id.
 */
describe("resolveOnchainVariantPath — the derived copy", () => {
  it("lands in the locker directory, named from the id and marked as the copy", async () => {
    const store = await loadStore();
    const resolved = store.resolveOnchainVariantPath(VALID_ID);
    expect(path.dirname(resolved)).toBe(path.resolve(store.LOCKER_IMAGES_DIR));
    expect(path.basename(resolved)).toBe(`${VALID_ID}.onchain.bin`);
    // Two distinct files: reading one must never reach the other.
    expect(resolved).not.toBe(store.resolveImagePath(VALID_ID));
  });

  it("refuses a malformed id exactly as the original path does", async () => {
    const store = await loadStore();
    expect(() => store.resolveOnchainVariantPath("../../../etc/passwd")).toThrow(
      store.LockerPathEscapeError,
    );
    await expect(
      store.writeOnchainVariantBytes("../evil", new Uint8Array([1])),
    ).rejects.toThrow(store.LockerPathEscapeError);
  });

  it("round-trips independently of the original, and both survive the other's delete", async () => {
    const store = await loadStore();
    const original = new Uint8Array([1, 2, 3]);
    const copy = new Uint8Array([9, 8]);
    await store.writeImageBytes(VALID_ID, original);
    await store.writeOnchainVariantBytes(VALID_ID, copy);

    expect(await store.readImageBytes(VALID_ID)).toEqual(original);
    expect(await store.readOnchainVariantBytes(VALID_ID)).toEqual(copy);

    await store.removeImageBytes(VALID_ID);
    expect(await store.readImageBytes(VALID_ID)).toBeNull();
    // Deleting one must not take the other with it - the locker's delete path
    // removes both explicitly, and an implicit removal here would hide a bug.
    expect(await store.readOnchainVariantBytes(VALID_ID)).toEqual(copy);

    await store.removeOnchainVariantBytes(VALID_ID);
    expect(await store.readOnchainVariantBytes(VALID_ID)).toBeNull();
  });

  it("treats removing an absent copy as a success, because most images have none", async () => {
    const store = await loadStore();
    await expect(store.removeOnchainVariantBytes(VALID_ID)).resolves.toBeUndefined();
  });
});

describe("newLockerImageId", () => {
  it("mints ids that match the opaque contract", async () => {
    const store = await loadStore();
    expect(store.newLockerImageId()).toMatch(/^img_[0-9a-f]{32}$/);
  });

  it("does not repeat", async () => {
    const store = await loadStore();
    const ids = new Set(Array.from({ length: 200 }, () => store.newLockerImageId()));
    expect(ids.size).toBe(200);
  });
});

describe("byte round-trip", () => {
  it("writes, reads back identical bytes, and deletes", async () => {
    const store = await loadStore();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await store.writeImageBytes(VALID_ID, bytes);
    expect(await store.readImageBytes(VALID_ID)).toEqual(bytes);
    await store.removeImageBytes(VALID_ID);
    expect(await store.readImageBytes(VALID_ID)).toBeNull();
  });

  it("returns null for an id with no stored bytes, rather than throwing", async () => {
    const store = await loadStore();
    expect(await store.readImageBytes(VALID_ID)).toBeNull();
  });

  it("treats deleting absent bytes as a success (idempotent)", async () => {
    const store = await loadStore();
    await expect(store.removeImageBytes(VALID_ID)).resolves.toBeUndefined();
  });

  it("creates the locker directory on first write", async () => {
    const store = await loadStore();
    await store.writeImageBytes(VALID_ID, new Uint8Array([9]));
    expect(store.LOCKER_IMAGES_DIR.startsWith(tempConfigDir)).toBe(true);
  });

  it("refuses to write through a malformed id", async () => {
    const store = await loadStore();
    await expect(store.writeImageBytes("../evil", new Uint8Array([1]))).rejects.toThrow(
      store.LockerPathEscapeError,
    );
  });

  it("cannot be tricked into deleting a file outside the locker", async () => {
    const store = await loadStore();
    const bystander = path.join(tempConfigDir, "important.json");
    await writeFile(bystander, "{}");
    await expect(store.removeImageBytes("../important.json")).rejects.toThrow(
      store.LockerPathEscapeError,
    );
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(bystander, "utf8")).resolves.toBe("{}");
  });
});

describe("digestOf", () => {
  it("is sha256, lowercase hex", async () => {
    const store = await loadStore();
    // sha256 of the empty input — a fixed, externally checkable vector.
    expect(store.digestOf(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("changes when a single byte changes", async () => {
    const store = await loadStore();
    const a = store.digestOf(new Uint8Array([1, 2, 3]));
    const b = store.digestOf(new Uint8Array([1, 2, 4]));
    expect(a).not.toBe(b);
  });
});
