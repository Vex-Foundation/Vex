import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureModel, modelDiskNeed, type ModelSpec } from "../native/model-store.js";

const BLOB = randomBytes(3 * 1024 * 1024 + 123);
const SHA = createHash("sha256").update(BLOB).digest("hex");
const ENOUGH_DISK = async (): Promise<number> => 10 * 1024 * 1024 * 1024;

type Behaviour = "ok" | "ignore-range" | "429" | "corrupt" | { readonly dropAfter: number };

interface Recorded {
  readonly url: string;
  readonly range: string | undefined;
}

let server: Server;
let base: string;
let dir: string;
let requests: Recorded[];
let behaviour: Record<string, Behaviour>;

function serve(req: IncomingMessage, res: ServerResponse): void {
  const route = (req.url ?? "/").slice(1);
  requests.push({ url: route, range: req.headers.range });
  const mode = behaviour[route] ?? "ok";
  if (mode === "429") {
    res.writeHead(429, { "retry-after": "30" }).end("rate limited");
    return;
  }
  const body = mode === "corrupt" ? Buffer.from(BLOB).fill(7, 1000, 2000) : BLOB;
  const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
  if (match !== null && mode !== "ignore-range") {
    const start = Number(match[1]);
    if (start >= body.length) {
      res.writeHead(416, { "content-range": `bytes */${body.length}` }).end();
      return;
    }
    res.writeHead(206, {
      "content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
      "content-length": String(body.length - start),
    });
    res.end(body.subarray(start));
    return;
  }
  res.writeHead(200, { "content-length": String(body.length) });
  if (typeof mode === "object") {
    // Send part of the body, then cut the connection mid-transfer.
    res.write(body.subarray(0, mode.dropAfter), () => res.destroy());
    return;
  }
  res.end(body);
}

function spec(...routes: string[]): ModelSpec {
  return { fileName: "model.gguf", sha256: SHA, bytes: BLOB.length, urls: routes.map((r) => `${base}/${r}`) };
}

const realFetch = (url: string, init: RequestInit): Promise<Response> => fetch(url, init);

beforeEach(async () => {
  requests = [];
  behaviour = {};
  server = createServer(serve);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(path.join(tmpdir(), "vex model store "));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

const run = (s: ModelSpec, extra: { signal?: AbortSignal; freeBytes?: (d: string) => Promise<number> } = {}) =>
  ensureModel({
    dir,
    spec: s,
    signal: extra.signal ?? new AbortController().signal,
    deps: { fetch: realFetch, freeBytes: extra.freeBytes ?? ENOUGH_DISK },
  });

describe("model store", () => {
  it("downloads, verifies and names the model atomically", async () => {
    const progress: number[] = [];
    const result = await ensureModel({
      dir,
      spec: spec("a"),
      signal: new AbortController().signal,
      onProgress: (p) => {
        if (p.phase === "downloading") progress.push(p.receivedBytes);
      },
      deps: { fetch: realFetch, freeBytes: ENOUGH_DISK },
    });
    expect(result).toEqual({ kind: "ready", path: path.join(dir, "model.gguf"), downloaded: true });
    expect(createHash("sha256").update(await readFile(path.join(dir, "model.gguf"))).digest("hex")).toBe(SHA);
    expect(existsSync(path.join(dir, "model.gguf.part"))).toBe(false);
    expect(progress.at(-1)).toBe(BLOB.length);
    expect(progress).toEqual([...progress].sort((x, y) => x - y));
  });

  it("does not touch the network or re-hash on a later start", async () => {
    await run(spec("a"));
    requests = [];
    await expect(run(spec("a"))).resolves.toMatchObject({ kind: "ready", downloaded: false });
    expect(requests).toEqual([]);
  });

  it("re-verifies when the file changed underneath the stamp, and replaces a wrong one", async () => {
    await run(spec("a"));
    const file = path.join(dir, "model.gguf");
    const tampered = Buffer.from(BLOB);
    tampered[42] = (tampered[42] ?? 0) ^ 0xff;
    await writeFile(file, tampered);
    requests = [];
    await expect(run(spec("a"))).resolves.toMatchObject({ kind: "ready", downloaded: true });
    expect(requests).toHaveLength(1);
    expect(createHash("sha256").update(await readFile(file)).digest("hex")).toBe(SHA);
  });

  it("resumes an interrupted download with a Range request", async () => {
    behaviour.a = { dropAfter: 1024 * 1024 };
    const first = await run(spec("a"));
    expect(first.kind).toBe("unavailable");
    const partial = (await stat(path.join(dir, "model.gguf.part"))).size;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(BLOB.length);

    behaviour.a = "ok";
    await expect(run(spec("a"))).resolves.toMatchObject({ kind: "ready", downloaded: true });
    expect(requests.at(-1)?.range).toBe(`bytes=${partial}-`);
    expect(createHash("sha256").update(await readFile(path.join(dir, "model.gguf"))).digest("hex")).toBe(SHA);
  });

  it("starts over when the server ignores the Range request", async () => {
    behaviour.a = { dropAfter: 512 * 1024 };
    await run(spec("a"));
    behaviour.a = "ignore-range";
    await expect(run(spec("a"))).resolves.toMatchObject({ kind: "ready" });
    expect(createHash("sha256").update(await readFile(path.join(dir, "model.gguf"))).digest("hex")).toBe(SHA);
  });

  it("refuses content that does not match the pin and leaves nothing behind", async () => {
    behaviour.a = "corrupt";
    const result = await run(spec("a"));
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(result.kind === "unavailable" && result.message).toMatch(/does not match the pinned/);
    expect(existsSync(path.join(dir, "model.gguf"))).toBe(false);
    expect(existsSync(path.join(dir, "model.gguf.part"))).toBe(false);
  });

  it("falls back to the next source when one is rate limited", async () => {
    behaviour.a = "429";
    await expect(run(spec("a", "b"))).resolves.toMatchObject({ kind: "ready" });
    expect(requests.map((r) => r.url)).toEqual(["a", "b"]);
  });

  it("reports every source failing as unavailable with the last reason", async () => {
    behaviour.a = "429";
    behaviour.b = "429";
    await expect(run(spec("a", "b"))).resolves.toEqual({ kind: "unavailable", message: "source 2: HTTP 429" });
  });

  it("checks free disk before downloading", async () => {
    const result = await run(spec("a"), { freeBytes: async () => 1024 });
    expect(result).toMatchObject({ kind: "disk_full", availableBytes: 1024 });
    expect(requests).toEqual([]);
  });

  it("rejects with AbortError when cancelled and keeps the bytes for a resume", async () => {
    behaviour.a = { dropAfter: 1024 * 1024 };
    await run(spec("a"));
    const controller = new AbortController();
    controller.abort();
    await expect(run(spec("a"), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(path.join(dir, "model.gguf.part"))).toBe(true);
  });
});

describe("what the model still needs from the disk (System Check)", () => {
  it("nothing yet: the whole model", async () => {
    await expect(modelDiskNeed(dir, spec("a"))).resolves.toEqual({ verified: false, bytesToWrite: BLOB.length });
  });

  it("an interrupted download: only the rest", async () => {
    behaviour.a = { dropAfter: 1024 * 1024 };
    await run(spec("a"));
    const partial = (await stat(path.join(dir, "model.gguf.part"))).size;
    expect(partial).toBeGreaterThan(0);
    await expect(modelDiskNeed(dir, spec("a"))).resolves.toEqual({
      verified: false,
      bytesToWrite: BLOB.length - partial,
    });
  });

  it("a model the store verified: nothing, without hashing it again", async () => {
    await run(spec("a"));
    await expect(modelDiskNeed(dir, spec("a"))).resolves.toEqual({ verified: true, bytesToWrite: 0 });
  });

  it("a file under the model's name the store never stamped is not verified, but takes no new space", async () => {
    await writeFile(path.join(dir, "model.gguf"), BLOB);
    await expect(modelDiskNeed(dir, spec("a"))).resolves.toEqual({ verified: false, bytesToWrite: 0 });
  });

  it("a model changed after it was stamped is no longer verified", async () => {
    await run(spec("a"));
    await writeFile(path.join(dir, "model.gguf"), Buffer.from(BLOB).fill(1, 0, 10));
    await expect(modelDiskNeed(dir, spec("a"))).resolves.toMatchObject({ verified: false });
  });
});
