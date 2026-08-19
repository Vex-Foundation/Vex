/**
 * Image locker IPC (C2) — contract and NEGATIVE-path tests.
 *
 * The positive paths are cheap to believe; these tests exist for the ways the
 * boundary is supposed to REFUSE. Specifically pinned:
 *
 *  - path traversal is IMPOSSIBLE BY SHAPE, not by filtering — no handler
 *    accepts a path, and a traversal string is rejected by the schema before
 *    any handler body runs;
 *  - an unknown image id is `images.not_found`, never a silent empty success;
 *  - an oversized file is `images.too_large` and the picked file is never
 *    ingested;
 *  - a file whose MAGIC BYTES are not on the allowlist is
 *    `images.unsupported_format`, whatever its extension claimed;
 *  - deletion is REFUSED with `images.in_use` while a live launch intent
 *    references the image, and the refusal NAMES that launch (the C2
 *    lifecycle guarantee);
 *  - a cancelled file picker is `internal.cancelled`, not an error state;
 *  - no error message, on any path, contains a filesystem path.
 *
 * The locker module and Electron's `dialog` are mocked; `registerHandler` is
 * exercised for real, so schema validation and the `Result` envelope are the
 * production ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showOpenDialog = vi.fn();
const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
}));

vi.mock("../sender-validation.js", () => ({ assertTrustedSender: () => undefined }));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const listLockerImages = vi.fn();
const storeLockerImageFromFile = vi.fn();
const deleteLockerImage = vi.fn();
const readLockerImageDataUrl = vi.fn();

vi.mock("../../images/index.js", () => ({
  listLockerImages: () => listLockerImages(),
  storeLockerImageFromFile: (p: string) => storeLockerImageFromFile(p),
  deleteLockerImage: (id: string) => deleteLockerImage(id),
  readLockerImageDataUrl: (id: string) => readLockerImageDataUrl(id),
}));

const { CH } = await import("@shared/ipc/channels.js");
const { registerImagesHandlers } = await import("../images.js");

const VALID_ID = "img_0123456789abcdef0123456789abcdef";
const OTHER_ID = "img_ffffffffffffffffffffffffffffffff";

const IMAGE = {
  imageId: VALID_ID,
  label: "moon.png",
  byteLength: 4096,
  mime: "image/png" as const,
  width: 320,
  height: 200,
  digest: "a".repeat(64),
  onchainByteLength: 4096,
  uploadedAt: "2026-08-02T10:00:00.000Z",
};

interface ErrorResult {
  ok: false;
  error: { code: string; message: string; domain: string; redacted: true };
}

function isError(value: unknown): value is ErrorResult {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

async function call(channel: string, payload: unknown): Promise<unknown> {
  const fn = handlers.get(channel);
  if (fn === undefined) throw new Error(`handler not registered: ${channel}`);
  return fn({ sender: {} }, { requestId: "11111111-2222-4333-8444-555555555555", payload });
}

function expectError(value: unknown, code: string): ErrorResult {
  expect(isError(value)).toBe(true);
  if (!isError(value)) throw new Error("unreachable");
  expect(value.error.code).toBe(code);
  return value;
}

let teardown: ReadonlyArray<() => void> = [];

beforeEach(() => {
  teardown = registerImagesHandlers();
});

afterEach(() => {
  for (const off of teardown) off();
  handlers.clear();
  vi.clearAllMocks();
});

// ── Path traversal is designed out, not filtered out ─────────────────────

describe("the boundary refuses to speak about paths at all", () => {
  it.each([
    ["../../../etc/passwd", "posix traversal"],
    ["..\\..\\windows\\system32", "windows traversal"],
    ["/etc/passwd", "an absolute path"],
    ["img_0123456789abcdef0123456789abcdef/../../evil", "a traversal appended to a valid id"],
    ["img_../..", "a traversal wearing the id prefix"],
    ["img_0123456789ABCDEF0123456789ABCDEF", "uppercase hex (outside the anchored pattern)"],
    ["img_0123", "a short id"],
    ["", "an empty id"],
  ])("rejects %s (%s) before the handler runs", async (imageId) => {
    const result = await call(CH.images.readThumb, { imageId });
    expectError(result, "validation.invalid_input");
    expect(readLockerImageDataUrl).not.toHaveBeenCalled();
  });

  it("rejects the same traversal strings on delete", async () => {
    const result = await call(CH.images.delete, { imageId: "../../../etc/passwd" });
    expectError(result, "validation.invalid_input");
    expect(deleteLockerImage).not.toHaveBeenCalled();
  });

  it("ignores a path the renderer tries to smuggle into upload — the payload is strict and empty", async () => {
    const result = await call(CH.images.upload, { sourcePath: "/etc/passwd" });
    expectError(result, "validation.invalid_input");
    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(storeLockerImageFromFile).not.toHaveBeenCalled();
  });

  it("ignores a session id the renderer tries to add to list — the locker is global", async () => {
    const result = await call(CH.images.list, { sessionId: "abc" });
    expectError(result, "validation.invalid_input");
    expect(listLockerImages).not.toHaveBeenCalled();
  });
});

// ── Unknown ids ──────────────────────────────────────────────────────────

describe("an unknown image id", () => {
  it("is images.not_found on readThumb, never an empty success", async () => {
    readLockerImageDataUrl.mockResolvedValue(null);
    expectError(await call(CH.images.readThumb, { imageId: VALID_ID }), "images.not_found");
  });

  it("is images.not_found on delete", async () => {
    deleteLockerImage.mockResolvedValue({ deleted: false, reason: "not_found" });
    expectError(await call(CH.images.delete, { imageId: VALID_ID }), "images.not_found");
  });
});

// ── Upload refusals ──────────────────────────────────────────────────────

describe("upload", () => {
  it("returns internal.cancelled when the user dismisses the picker", async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expectError(await call(CH.images.upload, {}), "internal.cancelled");
    expect(storeLockerImageFromFile).not.toHaveBeenCalled();
  });

  it("returns internal.cancelled when the picker resolves with no file", async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
    expectError(await call(CH.images.upload, {}), "internal.cancelled");
    expect(storeLockerImageFromFile).not.toHaveBeenCalled();
  });

  it("refuses a file over the RESOURCE bound with images.too_large, naming both sizes", async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/home/u/huge.png"] });
    storeLockerImageFromFile.mockResolvedValue({
      ok: false,
      rejection: { kind: "too_large", byteLength: 40_000_000, maxBytes: 26_214_400 },
    });
    const result = expectError(await call(CH.images.upload, {}), "images.too_large");
    expect(result.error.message).toContain("40.0 MB");
    expect(result.error.message).toContain("26.2 MB");
    // The bound is about memory, not about launching. Saying otherwise would
    // teach the user a product limit that does not exist on either launchpad.
    expect(result.error.message).toContain("memory");
  });

  it("refuses wrong magic bytes with images.unsupported_format and says we do not convert", async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/home/u/actually.gif"] });
    storeLockerImageFromFile.mockResolvedValue({
      ok: false,
      rejection: {
        kind: "unsupported_format",
        reason: "the file is not a JPEG, PNG, or WebP image",
      },
    });
    const result = expectError(await call(CH.images.upload, {}), "images.unsupported_format");
    expect(result.error.message).toMatch(/does not convert/i);
  });

  it("never echoes the chosen file's path in the refusal", async () => {
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/home/secret-user/private/holiday.gif"],
    });
    storeLockerImageFromFile.mockResolvedValue({
      ok: false,
      rejection: { kind: "unsupported_format", reason: "the file is not a JPEG, PNG, or WebP image" },
    });
    const result = expectError(await call(CH.images.upload, {}), "images.unsupported_format");
    expect(result.error.message).not.toContain("/home/");
    expect(result.error.message).not.toContain("secret-user");
  });

  it("maps a thrown store failure to images.store_unavailable, not a leaked exception", async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/home/u/moon.png"] });
    storeLockerImageFromFile.mockRejectedValue(
      new Error("EACCES: permission denied, open '/home/u/.config/vex/trench-images/x.bin'"),
    );
    const result = expectError(await call(CH.images.upload, {}), "images.store_unavailable");
    expect(result.error.message).not.toContain("/home/");
    expect(result.error.message).not.toContain("EACCES");
  });

  it("returns the stored record on success", async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/home/u/moon.png"] });
    storeLockerImageFromFile.mockResolvedValue({ ok: true, image: IMAGE });
    expect(await call(CH.images.upload, {})).toEqual({ ok: true, data: { image: IMAGE } });
  });
});

// ── The C2 lifecycle guarantee ───────────────────────────────────────────

describe("delete refuses while a live launch intent holds the image (C2)", () => {
  it("returns images.in_use and NAMES the launch", async () => {
    deleteLockerImage.mockResolvedValue({
      deleted: false,
      reason: "referenced_by_live_intent",
      intents: [{ intentId: "int_1", status: "authorized", name: "MOONSHOT" }],
    });
    const result = expectError(await call(CH.images.delete, { imageId: VALID_ID }), "images.in_use");
    expect(result.error.message).toContain("MOONSHOT");
    // The user must be told what to do about it, not just that they cannot.
    expect(result.error.message).toMatch(/cancel/i);
  });

  // Owner decree 2026-08-02: a refusal states the REAL cause. "A launch in
  // progress" was true of four different situations with three different
  // remedies, and the one the user most often hit — a launch already broadcast,
  // which they can only wait out — was being told to "finish or cancel" a
  // transaction that is already on-chain.
  it("says what state each holding launch is actually in", async () => {
    deleteLockerImage.mockResolvedValue({
      deleted: false,
      reason: "referenced_by_live_intent",
      intents: [
        { intentId: "int_1", status: "broadcast_pending", name: "MOONSHOT" },
        { intentId: "int_2", status: "awaiting_user_form", name: "SECONDCOIN" },
      ],
    });
    const result = expectError(await call(CH.images.delete, { imageId: VALID_ID }), "images.in_use");
    expect(result.error.message).toContain("MOONSHOT (broadcast and waiting to settle on-chain)");
    expect(result.error.message).toContain(
      "SECONDCOIN (waiting for you to fill in its launch form)",
    );
    expect(result.error.message).toMatch(/wait/i);
  });

  it("names every holding launch, not just the first", async () => {
    deleteLockerImage.mockResolvedValue({
      deleted: false,
      reason: "referenced_by_live_intent",
      intents: [
        { intentId: "int_1", status: "authorized", name: "MOONSHOT" },
        { intentId: "int_2", status: "awaiting_user_form", name: "SECONDCOIN" },
      ],
    });
    const result = expectError(await call(CH.images.delete, { imageId: VALID_ID }), "images.in_use");
    expect(result.error.message).toContain("MOONSHOT");
    expect(result.error.message).toContain("SECONDCOIN");
  });

  it("is not retryable — retrying cannot make a live launch let go", async () => {
    deleteLockerImage.mockResolvedValue({
      deleted: false,
      reason: "referenced_by_live_intent",
      intents: [{ intentId: "int_1", status: "consuming", name: "MOONSHOT" }],
    });
    const result = await call(CH.images.delete, { imageId: VALID_ID });
    expect(isError(result) && (result.error as unknown as { retryable: boolean }).retryable).toBe(false);
  });

  it("deletes when nothing live references the image", async () => {
    deleteLockerImage.mockResolvedValue({ deleted: true, row: IMAGE });
    expect(await call(CH.images.delete, { imageId: OTHER_ID })).toEqual({
      ok: true,
      data: { imageId: OTHER_ID },
    });
  });
});

// ── list ─────────────────────────────────────────────────────────────────

describe("list", () => {
  it("returns the locker metadata", async () => {
    listLockerImages.mockResolvedValue([IMAGE]);
    expect(await call(CH.images.list, {})).toEqual({ ok: true, data: { images: [IMAGE] } });
  });

  it("returns an empty locker as an empty success, never an error", async () => {
    listLockerImages.mockResolvedValue([]);
    expect(await call(CH.images.list, {})).toEqual({ ok: true, data: { images: [] } });
  });

  it("maps a store failure to images.store_unavailable", async () => {
    listLockerImages.mockRejectedValue(new Error("connection refused"));
    const result = expectError(await call(CH.images.list, {}), "images.store_unavailable");
    expect(result.error.message).not.toContain("connection refused");
  });
});

// ── on-chain copy reporting ──────────────────────────────────────────────

describe("an upload reports the Trench copy it derived", () => {
  it("passes the variant report through to the renderer", async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/picked/holiday.jpg"] });
    storeLockerImageFromFile.mockResolvedValue({
      ok: true,
      image: IMAGE,
      onchainVariant: { originalByteLength: 3_000_000, variantByteLength: 14_000 },
    });

    const result = await call(CH.images.upload, {});

    expect(result).toEqual({
      ok: true,
      data: {
        image: IMAGE,
        onchainVariant: { originalByteLength: 3_000_000, variantByteLength: 14_000 },
      },
    });
  });

  it("OMITS the field entirely when the original is its own copy", async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/picked/small.png"] });
    storeLockerImageFromFile.mockResolvedValue({ ok: true, image: IMAGE });

    const result = await call(CH.images.upload, {});

    // Presence is the claim "a second copy was derived" — it must not be made
    // about a file that needed none.
    expect(result).toEqual({ ok: true, data: { image: IMAGE } });
  });
});
