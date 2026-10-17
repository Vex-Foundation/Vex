import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  embeddingThreads,
  llamaArgs,
  llamaEnv,
  parseListeningPort,
  LlamaSupervisor,
  LLAMA_MAX_RESTARTS,
} = await import("../native/llama-supervisor.js");
type LlamaEndpoint = import("../native/llama-supervisor.js").LlamaEndpoint;

describe("llama launch contract", () => {
  it("sizes threads by plan D9", () => {
    expect([1, 2, 3, 4, 8, 16, 64].map((c) => embeddingThreads(c))).toEqual([1, 1, 1, 2, 4, 4, 4]);
  });

  it("launches with the verified production flags", () => {
    expect(llamaArgs("/m/model.gguf", 2)).toEqual([
      "--model", "/m/model.gguf", "--embeddings", "--alias", "ai/embeddinggemma:300M-Q8_0",
      "--host", "127.0.0.1", "--port", "0", "--device", "none", "-ngl", "0", "-np", "1",
      "-t", "2", "-tb", "2", "--no-webui", "--offline",
    ]);
  });

  it("hands the server nothing from the parent environment but the Windows essentials", () => {
    const parent = { HOME: "/h", LLAMA_ARG_PORT: "9999", AIP_HTTP_PORT: "1", SystemRoot: "C:\\Windows" };
    expect(llamaEnv("k", "/c", "darwin", parent)).toEqual({ LLAMA_API_KEY: "k", LLAMA_CACHE: "/c" });
    expect(llamaEnv("k", "C:\\c", "win32", parent)).toEqual({
      LLAMA_API_KEY: "k",
      LLAMA_CACHE: "C:\\c",
      SystemRoot: "C:\\Windows",
    });
  });

  it("reads the bound port only from the exact listening line", () => {
    expect(parseListeningPort("main: server is listening on http://127.0.0.1:49253")).toBe(49253);
    expect(parseListeningPort("main: server is listening on http://127.0.0.1:49253\r")).toBe(49253);
    expect(parseListeningPort("main: server is listening on http://0.0.0.0:8080")).toBeNull();
    expect(parseListeningPort("main: loading model")).toBeNull();
    expect(parseListeningPort("main: server is listening on http://127.0.0.1:0")).toBeNull();
  });
});

// ── Against the real bundled server ─────────────────────────────────────
const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const target = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const binaryPath = path.join(repoRoot, "native-runtime/out", target, "llama", process.platform === "win32" ? "llama-server.exe" : "llama-server");
const modelPath = path.join(repoRoot, "native-runtime/.work/models/embeddinggemma-300M-Q8_0.gguf");
const haveRuntime = existsSync(binaryPath) && existsSync(modelPath);

async function embed(endpoint: LlamaEndpoint, key: string | null): Promise<Response> {
  return fetch(`${endpoint.baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ input: "swap eth to usdc", model: "ai/embeddinggemma:300M-Q8_0" }),
  });
}

function until(predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error("condition not met in time"));
      else setTimeout(tick, 50);
    };
    tick();
  });
}

describe.skipIf(!haveRuntime)("llama supervisor against the bundled server", () => {
  let cacheDir: string;
  let supervisor: InstanceType<typeof LlamaSupervisor> | null = null;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "vex llama cache "));
  });
  afterEach(async () => {
    await supervisor?.stop();
    supervisor = null;
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("starts, serves real embeddings behind its key, and stops cleanly", async () => {
    const endpoints: Array<LlamaEndpoint | null> = [];
    supervisor = new LlamaSupervisor({
      launch: { binaryPath, modelPath, cacheDir },
      onEndpoint: (e) => endpoints.push(e),
      onUnhealthy: () => {},
      threads: 2,
    });
    const result = await supervisor.start();
    if (result.kind !== "ready") throw new Error(result.reason);
    const { endpoint } = result;
    expect(endpoint.baseUrl).toBe(`http://127.0.0.1:${endpoint.port}/v1`);

    const ok = await embed(endpoint, endpoint.apiKey);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { model: string; data: Array<{ embedding: number[] }> };
    expect(body.model).toBe("ai/embeddinggemma:300M-Q8_0");
    expect(body.data[0]?.embedding).toHaveLength(768);
    expect((await embed(endpoint, null)).status).toBe(401);
    expect((await embed(endpoint, "wrong")).status).toBe(401);

    // A second start while it runs reports the same server, never a second one.
    const pid = supervisor.pid;
    await expect(supervisor.start()).resolves.toEqual({ kind: "ready", endpoint });
    expect(supervisor.pid).toBe(pid);

    await supervisor.stop();
    expect(endpoints).toEqual([endpoint, null]);
    expect(() => process.kill(pid ?? -1, 0)).toThrow();
    expect(supervisor.pid).toBeUndefined();
  }, 120_000);

  it("restarts a crashed server on a new port and key", async () => {
    const endpoints: Array<LlamaEndpoint | null> = [];
    supervisor = new LlamaSupervisor({
      launch: { binaryPath, modelPath, cacheDir },
      onEndpoint: (e) => endpoints.push(e),
      onUnhealthy: () => {},
      threads: 2,
      restartDelayMs: () => 0,
    });
    const first = await supervisor.start();
    if (first.kind !== "ready") throw new Error(first.reason);
    process.kill(supervisor.pid ?? -1, "SIGKILL");
    await until(() => endpoints.length === 3);
    const second = endpoints[2];
    expect(endpoints[1]).toBeNull();
    expect(second).not.toBeNull();
    expect(second?.apiKey).not.toBe(first.endpoint.apiKey);
    expect((await embed(second as LlamaEndpoint, (second as LlamaEndpoint).apiKey)).status).toBe(200);
    // The old key is worthless against the new server.
    expect((await embed(second as LlamaEndpoint, first.endpoint.apiKey)).status).toBe(401);
  }, 120_000);

  it("reports unhealthy once the restart budget is spent", async () => {
    let unhealthy: string | null = null;
    let restarts = 0;
    supervisor = new LlamaSupervisor({
      launch: { binaryPath, modelPath, cacheDir },
      onEndpoint: (e) => {
        if (e !== null) restarts += 1;
      },
      onUnhealthy: (reason) => {
        unhealthy = reason;
      },
      threads: 2,
      restartDelayMs: () => 0,
    });
    const first = await supervisor.start();
    if (first.kind !== "ready") throw new Error(first.reason);
    // Kill every server the supervisor brings up until it gives up. Each round
    // waits for a NEW pid: right after a kill the old one is still recorded
    // until its exit is observed.
    while (unhealthy === null) {
      const pid = supervisor.pid;
      if (pid === undefined) throw new Error("no server running");
      process.kill(pid, "SIGKILL");
      await until(() => unhealthy !== null || (supervisor?.pid !== undefined && supervisor.pid !== pid));
    }
    // The initial start plus six restarts, then the budget is gone.
    expect(restarts).toBe(1 + LLAMA_MAX_RESTARTS + 1);
    expect(unhealthy).toMatch(/budget exhausted/);
  }, 300_000);
});
