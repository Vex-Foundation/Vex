/**
 * The backdrop BYTE store: path containment, write-then-rename, listing.
 *
 * `resolveBackdropPath` is the last thing standing between an id and the
 * filesystem, so its refusals are tested directly rather than only through
 * the IPC layer. The route matcher and the IPC schema already reject a
 * malformed id, which means these cases are unreachable in production today;
 * that is exactly why they are pinned: if a future change loosens the id
 * format, this test fails instead of a `rm` succeeding somewhere it should
 * not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let tempConfigDir: string;

beforeEach(async () => {
  tempConfigDir = await mkdtemp(path.join(tmpdir(), "vex-backdrop-"));
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
  return import("../store.js");
}

const VALID_ID = "bg_0123456789abcdef0123456789abcdef";
const OTHER_ID = "bg_ffffffffffffffffffffffffffffffff";

describe("resolveBackdropPath - containment", () => {
  it.each([
    ["../../../etc/passwd", "posix traversal"],
    ["..\\..\\evil", "windows traversal"],
    ["/etc/passwd", "an absolute path"],
    ["bg_0123456789abcdef0123456789abcdef/../../evil", "traversal appended to a valid id"],
    ["bg_..", "traversal wearing the id prefix"],
    ["bg_0123456789ABCDEF0123456789ABCDEF", "uppercase hex"],
    ["img_0123456789abcdef0123456789abcdef", "a LOCKER id (different store, different prefix)"],
    ["bg_short", "a short id"],
    ["", "an empty id"],
  ])("refuses %s (%s)", async (imageId) => {
    const store = await loadStore();
    expect(() => store.resolveBackdropPath(imageId)).toThrow(store.BackdropPathEscapeError);
  });

  it("resolves a well-formed id to a `.bin` directly inside the backdrop directory", async () => {
    const store = await loadStore();
    const resolved = store.resolveBackdropPath(VALID_ID);
    expect(path.dirname(resolved)).toBe(path.resolve(store.SHELL_BACKDROP_DIR));
    expect(path.basename(resolved)).toBe(`${VALID_ID}.bin`);
  });

  it("keeps its directory apart from the launch locker's", async () => {
    const store = await loadStore();
    expect(store.SHELL_BACKDROP_DIR).toBe(path.join(tempConfigDir, "shell-backdrop"));
    expect(store.SHELL_BACKDROP_DIR).not.toContain("trench-images");
  });
});

describe("newShellBackdropId", () => {
  it("mints ids that match the opaque contract and do not repeat", async () => {
    const store = await loadStore();
    const ids = new Set(Array.from({ length: 200 }, () => store.newShellBackdropId()));
    for (const id of ids) expect(id).toMatch(/^bg_[0-9a-f]{32}$/);
    expect(ids.size).toBe(200);
  });
});

describe("write-then-rename", () => {
  it("writes, reads back identical bytes, leaves no temp file, and deletes", async () => {
    const store = await loadStore();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await store.writeBackdropBytes(VALID_ID, bytes);
    expect(await readdir(store.SHELL_BACKDROP_DIR)).toEqual([`${VALID_ID}.bin`]);
    expect(await store.readBackdropBytes(VALID_ID)).toEqual(bytes);
    await store.removeBackdropBytes(VALID_ID);
    expect(await store.readBackdropBytes(VALID_ID)).toBeNull();
  });

  it("returns null for an id with no stored bytes, and deletes an absent file as a success", async () => {
    const store = await loadStore();
    expect(await store.readBackdropBytes(VALID_ID)).toBeNull();
    await expect(store.removeBackdropBytes(VALID_ID)).resolves.toBeUndefined();
  });

  it("refuses to write or delete through a malformed id, and a bystander survives", async () => {
    const store = await loadStore();
    const bystander = path.join(tempConfigDir, "important.json");
    await writeFile(bystander, "{}");
    await expect(store.writeBackdropBytes("../important.json", new Uint8Array([1]))).rejects.toThrow(
      store.BackdropPathEscapeError,
    );
    await expect(store.removeBackdropBytes("../important.json")).rejects.toThrow(
      store.BackdropPathEscapeError,
    );
    await expect(readFile(bystander, "utf8")).resolves.toBe("{}");
  });
});

describe("listStoredBackdrops - what the reconcile sees", () => {
  it("reports an absent directory as an empty store", async () => {
    const store = await loadStore();
    expect(await store.listStoredBackdrops()).toEqual({ ids: [], pendingFiles: [] });
  });

  it("separates finished files, interrupted temp files, and strangers", async () => {
    const store = await loadStore();
    await mkdir(store.SHELL_BACKDROP_DIR, { recursive: true });
    await store.writeBackdropBytes(VALID_ID, new Uint8Array([1]));
    await store.writeBackdropBytes(OTHER_ID, new Uint8Array([2]));
    // An interrupted write (crash between writeFile and rename).
    await writeFile(path.join(store.SHELL_BACKDROP_DIR, `${OTHER_ID}.bin.tmp`), "x");
    // A stranger that does not parse as an id is neither listed nor touched.
    await writeFile(path.join(store.SHELL_BACKDROP_DIR, "notes.txt"), "keep");

    const listed = await store.listStoredBackdrops();
    expect([...listed.ids].sort()).toEqual([VALID_ID, OTHER_ID].sort());
    expect(listed.pendingFiles).toEqual([`${OTHER_ID}.bin.tmp`]);

    await store.removePendingBackdropFile(`${OTHER_ID}.bin.tmp`);
    // A name that is not `<id>.bin.tmp` is ignored, never resolved.
    await store.removePendingBackdropFile("notes.txt");
    await store.removePendingBackdropFile("../important.json.bin.tmp");
    const after = await readdir(store.SHELL_BACKDROP_DIR);
    expect(after.sort()).toEqual([`${VALID_ID}.bin`, `${OTHER_ID}.bin`, "notes.txt"].sort());
  });
});
