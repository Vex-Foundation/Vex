/**
 * User backdrop IPC - the rule-90 matrix over the REAL service chain.
 *
 * Electron's `dialog`, `nativeImage` and `app.getPath` are stubbed; the byte
 * store, the preferences store (a real `preferences.json` in a temp dir), the
 * validation matrix and `registerHandler` are the production ones. Pinned:
 *
 *  - POSITIVE: a picked PNG lands in the store, the pointer commits, the
 *    reply carries the opaque id and the `app://vex/user-backdrop/<id>` URL;
 *  - CANCELLED picker: ok, `cancelled: true`, nothing written;
 *  - OVERSIZE: refused from `stat` BEFORE any byte is read;
 *  - WRONG MAGIC BYTES: refused by name, no file stored;
 *  - UNDECODABLE: refused by name, no file stored;
 *  - UNTRUSTED SENDER: `validation.invalid_sender`, no dialog opened;
 *  - path smuggling: the empty strict payload rejects a path before the
 *    handler runs;
 *  - SINGLE-FLIGHT: two picks from one sender open ONE dialog;
 *  - REPLACE: the previous file is deleted after the new pointer commits;
 *  - REMOVE: the pointer clears and the file is gone;
 *  - RESTART PERSISTENCE: a fresh module graph over the same directories
 *    reads the same backdrop back;
 *  - ORPHAN CLEANUP: a crash-orphan `.bin` and a `.tmp` are swept on read,
 *    and a pointer whose file is gone is cleared;
 *  - no refusal message, on any path, contains a filesystem path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const showOpenDialog = vi.fn();
const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
let userDataDir = "";
let decodable = true;
let decodedSize = { width: 1920, height: 1080 };

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => {
      if (name === "userData") return userDataDir;
      throw new Error(`unexpected getPath('${name}')`);
    },
  },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog },
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => !decodable, getSize: () => decodedSize }),
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TRUSTED = { senderFrame: trustedFrame(), sender: { id: 7 } };

function trustedFrame(): { url: string; parent: null; top: unknown } {
  const frame: { url: string; parent: null; top: unknown } = {
    url: "app://vex/index.html",
    parent: null,
    top: null,
  };
  frame.top = frame;
  return frame;
}

interface ErrorResult {
  ok: false;
  error: { code: string; message: string; domain: string; redacted: true; retryable: boolean };
}

function isError(value: unknown): value is ErrorResult {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

function expectError(value: unknown, code: string): ErrorResult {
  expect(isError(value)).toBe(true);
  if (!isError(value)) throw new Error("unreachable");
  expect(value.error.code).toBe(code);
  return value;
}

interface OkResult<T> {
  ok: true;
  data: T;
}

function expectOk<T>(value: unknown): OkResult<T> {
  expect(isError(value)).toBe(false);
  return value as OkResult<T>;
}

interface Record_ {
  imageId: string;
  url: string;
  mime: string;
  width: number;
  height: number;
  byteLength: number;
}

let requestCounter = 0;

async function call(
  channel: string,
  payload: unknown,
  event: unknown = TRUSTED,
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (fn === undefined) throw new Error(`handler not registered: ${channel}`);
  requestCounter += 1;
  const requestId = `11111111-2222-4333-8444-${String(requestCounter).padStart(12, "0")}`;
  return fn(event, { requestId, payload });
}

let tempConfigDir = "";
let pickDir = "";
let teardown: ReadonlyArray<() => void> = [];
let CH: typeof import("@shared/ipc/channels.js").CH;
let SHELL_BACKDROP_DIR = "";

async function loadHandlers(): Promise<void> {
  vi.resetModules();
  const channels = await import("@shared/ipc/channels.js");
  CH = channels.CH;
  const store = await import("../../shell-backdrop/store.js");
  SHELL_BACKDROP_DIR = store.SHELL_BACKDROP_DIR;
  const { registerShellBackdropHandlers } = await import("../shell-backdrop.js");
  teardown = registerShellBackdropHandlers();
}

function pngBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1920);
  view.setUint32(20, 1080);
  return bytes;
}

async function pickFile(name: string, bytes: Uint8Array): Promise<string> {
  const file = path.join(pickDir, name);
  await writeFile(file, bytes);
  showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
  return file;
}

async function storedFiles(): Promise<string[]> {
  try {
    return (await readdir(SHELL_BACKDROP_DIR)).sort();
  } catch {
    return [];
  }
}

/** The pointer in `preferences.json`; `null` when no file was ever written. */
async function pointerOnDisk(): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path.join(userDataDir, "preferences.json"), "utf8");
  } catch {
    return null;
  }
  return (JSON.parse(raw) as { shell: { backdrop: unknown } }).shell.backdrop;
}

beforeEach(async () => {
  tempConfigDir = await mkdtemp(path.join(tmpdir(), "vex-backdrop-ipc-"));
  userDataDir = await mkdtemp(path.join(tmpdir(), "vex-backdrop-prefs-"));
  pickDir = await mkdtemp(path.join(tmpdir(), "vex-backdrop-pick-"));
  process.env["VEX_CONFIG_DIR"] = tempConfigDir;
  decodable = true;
  decodedSize = { width: 1920, height: 1080 };
  showOpenDialog.mockReset();
  await loadHandlers();
});

afterEach(async () => {
  for (const off of teardown) off();
  handlers.clear();
  delete process.env["VEX_CONFIG_DIR"];
  await rm(tempConfigDir, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
  await rm(pickDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ── The boundary refuses to speak about paths ───────────────────────────

describe("the payloads are empty and strict", () => {
  it("rejects a path smuggled into pick before the handler runs", async () => {
    expectError(await call(CH.shellBackdrop.pick, { sourcePath: "/etc/passwd" }), "validation.invalid_input");
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it("rejects an id smuggled into clear and read", async () => {
    expectError(await call(CH.shellBackdrop.clear, { imageId: "../x" }), "validation.invalid_input");
    expectError(await call(CH.shellBackdrop.read, { imageId: "bg_x" }), "validation.invalid_input");
  });
});

describe("sender trust", () => {
  it("refuses an untrusted origin on every channel and opens no dialog", async () => {
    const hostile = { senderFrame: { ...trustedFrame(), url: "https://evil.example/" } };
    hostile.senderFrame.top = hostile.senderFrame;
    for (const channel of [CH.shellBackdrop.pick, CH.shellBackdrop.clear, CH.shellBackdrop.read]) {
      expectError(await call(channel, {}, hostile), "validation.invalid_sender");
    }
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it("refuses a subframe of the trusted origin", async () => {
    const top = trustedFrame();
    const child = { url: "app://vex/index.html", parent: top, top };
    expectError(await call(CH.shellBackdrop.read, {}, { senderFrame: child }), "validation.invalid_sender");
  });
});

// ── pick ────────────────────────────────────────────────────────────────

describe("pick", () => {
  it("installs a picked PNG: bytes stored, pointer committed, opaque id and app:// URL returned", async () => {
    const bytes = pngBytes();
    await pickFile("wall.png", bytes);

    const result = expectOk<{ backdrop: Record_; cancelled: boolean }>(
      await call(CH.shellBackdrop.pick, {}),
    );
    const record = result.data.backdrop;
    expect(result.data.cancelled).toBe(false);
    expect(record.imageId).toMatch(/^bg_[0-9a-f]{32}$/);
    expect(record.url).toBe(`app://vex/user-backdrop/${record.imageId}`);
    expect(record.mime).toBe("image/png");
    expect(record.width).toBe(1920);
    expect(record.height).toBe(1080);
    expect(record.byteLength).toBe(bytes.byteLength);

    expect(await storedFiles()).toEqual([`${record.imageId}.bin`]);
    expect(new Uint8Array(await readFile(path.join(SHELL_BACKDROP_DIR, `${record.imageId}.bin`)))).toEqual(bytes);
    expect(await pointerOnDisk()).toEqual({
      imageId: record.imageId,
      mime: "image/png",
      width: 1920,
      height: 1080,
      byteLength: bytes.byteLength,
    });
    // The picker offered PNG and JPEG only: the measured decode set. With no
    // parent window (`fromWebContents` stubs null) the options are the sole arg.
    const options = showOpenDialog.mock.calls[0]?.[0] as {
      filters: Array<{ extensions: string[] }>;
    };
    expect([...(options.filters[0]?.extensions ?? [])].sort()).toEqual(["jpeg", "jpg", "png"]);
  });

  it("treats a dismissed picker as ok + cancelled, echoing the unchanged current record", async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const result = expectOk<{ backdrop: Record_ | null; cancelled: boolean }>(
      await call(CH.shellBackdrop.pick, {}),
    );
    expect(result.data).toEqual({ backdrop: null, cancelled: true });
    expect(await storedFiles()).toEqual([]);
  });

  it("refuses an oversized file from stat, before reading a byte", async () => {
    const file = path.join(pickDir, "huge.png");
    // A sparse, UNREADABLE file: 8 MiB + 1 of stat size with no bytes written
    // and mode 000. `stat` still answers, so the size gate can; a read would
    // throw EACCES and surface as store_unavailable instead of too_large,
    // which is what makes "before reading a byte" an observable claim.
    const fs = await import("node:fs/promises");
    const handle = await fs.open(file, "w");
    await handle.truncate(8_388_609);
    await handle.close();
    await fs.chmod(file, 0o000);
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] });

    const result = expectError(await call(CH.shellBackdrop.pick, {}), "shellBackdrop.too_large");
    expect(result.error.message).toContain("8.0 MB");
    expect(result.error.message).not.toContain(pickDir);
    expect(await storedFiles()).toEqual([]);
  });

  it("refuses wrong magic bytes by name and stores nothing, whatever the extension claimed", async () => {
    const gif = new Uint8Array(64);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
    await pickFile("actually.png", gif);
    const result = expectError(await call(CH.shellBackdrop.pick, {}), "shellBackdrop.unsupported_format");
    expect(result.error.message).toMatch(/does not convert/i);
    expect(result.error.message).not.toContain(pickDir);
    expect(await storedFiles()).toEqual([]);
  });

  it("refuses a WebP by name: this Electron's decoder cannot prove it", async () => {
    const bytes = new Uint8Array(64);
    for (const [offset, text] of [[0, "RIFF"], [8, "WEBP"], [12, "VP8 "]] as const) {
      for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
    }
    bytes.set([0x9d, 0x01, 0x2a, 0x80, 0x07, 0x38, 0x04], 23);
    await pickFile("wall.webp", bytes);
    const result = expectError(await call(CH.shellBackdrop.pick, {}), "shellBackdrop.unsupported_format");
    expect(result.error.message).toContain("WebP");
    expect(await storedFiles()).toEqual([]);
  });

  it("refuses a file the decoder cannot decode and stores nothing", async () => {
    decodable = false;
    await pickFile("corrupt.png", pngBytes());
    expectError(await call(CH.shellBackdrop.pick, {}), "shellBackdrop.undecodable");
    expect(await storedFiles()).toEqual([]);
    expect(await pointerOnDisk()).toBeNull();
  });

  it("refuses a decoded size under the floor, naming the floor", async () => {
    decodedSize = { width: 320, height: 200 };
    await pickFile("tiny.png", pngBytes());
    const result = expectError(await call(CH.shellBackdrop.pick, {}), "shellBackdrop.undecodable");
    expect(result.error.message).toContain("640x360");
  });

  it("joins a second pick from the same sender onto the open dialog (single-flight)", async () => {
    let release: (value: { canceled: boolean; filePaths: string[] }) => void = () => undefined;
    showOpenDialog.mockReturnValueOnce(
      new Promise<{ canceled: boolean; filePaths: string[] }>((resolve) => {
        release = resolve;
      }),
    );
    const first = call(CH.shellBackdrop.pick, {});
    const second = call(CH.shellBackdrop.pick, {});
    await Promise.resolve();
    expect(showOpenDialog).toHaveBeenCalledTimes(1);
    release({ canceled: true, filePaths: [] });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(expectOk<{ cancelled: boolean }>(a).data.cancelled).toBe(true);
  });

  it("replaces: the previous file is deleted only after the new pointer commits", async () => {
    await pickFile("one.png", pngBytes());
    const first = expectOk<{ backdrop: Record_ }>(await call(CH.shellBackdrop.pick, {})).data.backdrop;
    await pickFile("two.png", pngBytes(80));
    const second = expectOk<{ backdrop: Record_ }>(await call(CH.shellBackdrop.pick, {})).data.backdrop;

    expect(second.imageId).not.toBe(first.imageId);
    expect(await storedFiles()).toEqual([`${second.imageId}.bin`]);
    expect((await pointerOnDisk()) as { imageId: string }).toMatchObject({ imageId: second.imageId });
  });
});

// ── clear ───────────────────────────────────────────────────────────────

describe("clear", () => {
  it("removes the pointer and the bytes, and is idempotent", async () => {
    await pickFile("one.png", pngBytes());
    await call(CH.shellBackdrop.pick, {});
    expect(await call(CH.shellBackdrop.clear, {})).toEqual({ ok: true, data: { backdrop: null } });
    expect(await storedFiles()).toEqual([]);
    expect(await pointerOnDisk()).toBeNull();
    expect(await call(CH.shellBackdrop.clear, {})).toEqual({ ok: true, data: { backdrop: null } });
    expect(expectOk<{ backdrop: null }>(await call(CH.shellBackdrop.read, {})).data.backdrop).toBeNull();
  });
});

// ── read, restart, reconcile ────────────────────────────────────────────

describe("read", () => {
  it("answers null when the shipped artwork is in use", async () => {
    expect(await call(CH.shellBackdrop.read, {})).toEqual({ ok: true, data: { backdrop: null } });
  });

  it("survives a restart: a fresh module graph over the same directories reads the same record", async () => {
    await pickFile("one.png", pngBytes());
    const picked = expectOk<{ backdrop: Record_ }>(await call(CH.shellBackdrop.pick, {})).data.backdrop;

    for (const off of teardown) off();
    handlers.clear();
    await loadHandlers();

    const read = expectOk<{ backdrop: Record_ }>(await call(CH.shellBackdrop.read, {})).data.backdrop;
    expect(read).toEqual(picked);
    expect(await storedFiles()).toEqual([`${picked.imageId}.bin`]);
  });

  it("sweeps a crash-orphan .bin and a .tmp on read, keeping the pointer's own file", async () => {
    await pickFile("one.png", pngBytes());
    const picked = expectOk<{ backdrop: Record_ }>(await call(CH.shellBackdrop.pick, {})).data.backdrop;
    const orphan = "bg_ffffffffffffffffffffffffffffffff";
    await writeFile(path.join(SHELL_BACKDROP_DIR, `${orphan}.bin`), pngBytes());
    await writeFile(path.join(SHELL_BACKDROP_DIR, `${orphan}.bin.tmp`), "half");

    const read = expectOk<{ backdrop: Record_ }>(await call(CH.shellBackdrop.read, {})).data.backdrop;
    expect(read.imageId).toBe(picked.imageId);
    expect(await storedFiles()).toEqual([`${picked.imageId}.bin`]);
  });

  it("clears a pointer whose file is gone, so the shell falls back to the shipped artwork", async () => {
    await pickFile("one.png", pngBytes());
    const picked = expectOk<{ backdrop: Record_ }>(await call(CH.shellBackdrop.pick, {})).data.backdrop;
    await rm(path.join(SHELL_BACKDROP_DIR, `${picked.imageId}.bin`));

    expect(await call(CH.shellBackdrop.read, {})).toEqual({ ok: true, data: { backdrop: null } });
    expect(await pointerOnDisk()).toBeNull();
  });

  it("loads a preferences.json written BEFORE the shell key existed without resetting it", async () => {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(
      path.join(userDataDir, "preferences.json"),
      JSON.stringify({
        version: 1,
        telemetry: { enabled: true, consentedAt: "2026-01-01T00:00:00.000Z" },
        window: { width: 1600, height: 900, x: 10, y: 20, maximized: false },
        updater: { lastCheckedAt: null },
        ui: { reducedMotion: "auto" },
      }),
    );
    await loadHandlers();
    expect(await call(CH.shellBackdrop.read, {})).toEqual({ ok: true, data: { backdrop: null } });
    const onDisk = JSON.parse(await readFile(path.join(userDataDir, "preferences.json"), "utf8")) as {
      telemetry: { enabled: boolean };
      window: { width: number };
    };
    // The consent and the window bounds survived: no full-defaults reset.
    expect(onDisk.telemetry.enabled).toBe(true);
    expect(onDisk.window.width).toBe(1600);
  });
});

describe("no refusal ever names a path", () => {
  it("maps a store failure to shellBackdrop.store_unavailable without the cause text", async () => {
    await pickFile("one.png", pngBytes());
    // Make the byte store unwritable: a FILE where the directory must go.
    await writeFile(SHELL_BACKDROP_DIR, "not a directory");
    const result = expectError(await call(CH.shellBackdrop.pick, {}), "shellBackdrop.store_unavailable");
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).not.toContain(tempConfigDir);
    expect(result.error.message).not.toContain("ENOTDIR");
    expect(result.error.message).not.toContain("EEXIST");
  });
});
