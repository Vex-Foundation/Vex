/**
 * The `app://vex/user-backdrop/<id>` route: the pure matcher as a table, and
 * the REAL protocol responder (`handleAppRequest`) driven end to end over a
 * real temp store, so what is pinned is the chain a request actually walks:
 * traversal gate -> reserved route -> two-gate resolver -> sniff -> headers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const netFetch = vi.fn();

vi.mock("electron", () => ({
  net: { fetch: (url: string) => netFetch(url) },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const VALID_ID = "bg_0123456789abcdef0123456789abcdef";
const OTHER_ID = "bg_ffffffffffffffffffffffffffffffff";

let tempConfigDir: string;

beforeEach(async () => {
  tempConfigDir = await mkdtemp(path.join(tmpdir(), "vex-backdrop-serve-"));
  process.env["VEX_CONFIG_DIR"] = tempConfigDir;
  vi.resetModules();
  netFetch.mockReset();
});

afterEach(async () => {
  delete process.env["VEX_CONFIG_DIR"];
  await rm(tempConfigDir, { recursive: true, force: true });
});

function pngBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1920);
  view.setUint32(20, 1080);
  return bytes;
}

describe("matchUserBackdropRoute", () => {
  it.each([
    ["app://vex/index.html", { kind: "none" }],
    ["app://vex/assets/main.js", { kind: "none" }],
    ["app://vex/user-backdrop", { kind: "none" }],
    ["app://vex/user-backdrops/x", { kind: "none" }],
    ["app://other/user-backdrop/bg_0123456789abcdef0123456789abcdef", { kind: "none" }],
    ["not a url", { kind: "none" }],
    [
      "app://vex/user-backdrop/bg_0123456789abcdef0123456789abcdef",
      { kind: "backdrop", imageId: VALID_ID },
    ],
    [
      "app://vex/user-backdrop/bg_0123456789abcdef0123456789abcdef?v=1",
      { kind: "backdrop", imageId: VALID_ID },
    ],
    ["app://vex/user-backdrop/", { kind: "refused" }],
    ["app://vex/user-backdrop/bg_short", { kind: "refused" }],
    ["app://vex/user-backdrop/bg_0123456789ABCDEF0123456789ABCDEF", { kind: "refused" }],
    ["app://vex/user-backdrop/img_0123456789abcdef0123456789abcdef", { kind: "refused" }],
    ["app://vex/user-backdrop/bg_0123456789abcdef0123456789abcdef/extra", { kind: "refused" }],
    ["app://vex/user-backdrop/bg_0123456789abcdef0123456789abcdef.png", { kind: "refused" }],
  ])("%s -> %o", async (raw, expected) => {
    const { matchUserBackdropRoute } = await import("../serve.js");
    expect(matchUserBackdropRoute(raw, "vex")).toEqual(expected);
  });
});

describe("the protocol responder, driven end to end", () => {
  const root = path.resolve("/var/app/dist/renderer");

  // The RAW string, not a `Request`: the WHATWG constructor would normalise
  // `..` away before the handler saw it, and the traversal gate exists for the
  // raw form Chromium hands `protocol.handle`.
  async function respond(url: string): Promise<Response> {
    const { handleAppRequest } = await import("../../protocol/app-protocol.js");
    return handleAppRequest(root)({ url });
  }

  it("serves stored PNG bytes with the sniffed Content-Type and no-store", async () => {
    const store = await import("../store.js");
    const bytes = pngBytes();
    await store.writeBackdropBytes(VALID_ID, bytes);

    const response = await respond(`app://vex/user-backdrop/${VALID_ID}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(netFetch).not.toHaveBeenCalled();
  });

  it("404s an unknown id and never falls through to the renderer root", async () => {
    const response = await respond(`app://vex/user-backdrop/${OTHER_ID}`);
    expect(response.status).toBe(404);
    expect(netFetch).not.toHaveBeenCalled();
  });

  it("404s a malformed id under the reserved prefix rather than resolving it as a file", async () => {
    const response = await respond("app://vex/user-backdrop/index.html");
    expect(response.status).toBe(404);
    expect(netFetch).not.toHaveBeenCalled();
  });

  it.each([
    "app://vex/user-backdrop/../preferences.json",
    "app://vex/user-backdrop/%2e%2e/preferences.json",
    "app://vex/../etc/passwd",
    // The WHATWG parser would normalise the two above into a harmless path
    // before the route matcher saw them; these two it does NOT touch, so
    // only the raw-string gate in front of the route can refuse them, and a
    // WELL-FORMED id on disk still answers 403, never the bytes.
    `app://vex/user-backdrop/${VALID_ID}?next=/../preferences.json`,
    "app://vex/user-backdrop/bg_..\\..\\preferences.json",
  ])("403s traversal BEFORE the route is matched: %s", async (url) => {
    const store = await import("../store.js");
    await store.writeBackdropBytes(VALID_ID, pngBytes());
    const response = await respond(url);
    expect(response.status).toBe(403);
    expect(netFetch).not.toHaveBeenCalled();
  });

  it("404s stored bytes that no longer sniff as PNG or JPEG (a Content-Type is a promise)", async () => {
    const store = await import("../store.js");
    await mkdir(store.SHELL_BACKDROP_DIR, { recursive: true });
    await writeFile(store.resolveBackdropPath(VALID_ID), new Uint8Array(64).fill(0x41));

    const response = await respond(`app://vex/user-backdrop/${VALID_ID}`);
    expect(response.status).toBe(404);
  });

  it("still hands every other app:// request to the renderer-root resolver", async () => {
    netFetch.mockResolvedValue(new Response("ok"));
    const response = await respond("app://vex/assets/main.css");
    expect(response.status).toBe(200);
    expect(netFetch).toHaveBeenCalledTimes(1);
    const [fetched] = netFetch.mock.calls[0] as [string];
    expect(fetched.endsWith("/assets/main.css")).toBe(true);
  });

  it("403s an id that could escape the store even if the matcher were loosened", async () => {
    const { serveUserBackdrop } = await import("../serve.js");
    const response = await serveUserBackdrop("../preferences.json");
    expect(response.status).toBe(403);
  });
});
