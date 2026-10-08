import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultEmbeddingEnv, EMBEDDING_DIM, EMBEDDING_MODEL_ALIAS } from "../embedding-defaults.js";
import { canRepairBundledEmbeddingPort } from "../bundled-embedding-port.js";
import { ensureEmbeddingDefaults } from "../ensure-embedding-defaults.js";
import { readDotenvFileValue } from "@vex-lib/dotenv.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TARGET_PORT = 27234;
let directory = "";
let envFile = "";

function successfulPayload(): Response {
  return Response.json({
    model: EMBEDDING_MODEL_ALIAS,
    data: [{ embedding: Array.from({ length: EMBEDDING_DIM }, () => 0.1) }],
  });
}

function transport(targetResponse: () => Response = successfulPayload) {
  return vi.fn<typeof fetch>(async (url) => {
    if (url.toString() === "http://127.0.0.1:27134/health") {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }
    return targetResponse();
  });
}

async function writeConfig(updates: Record<string, string> = {}): Promise<void> {
  const config = { ...defaultEmbeddingEnv(), ...updates };
  await fs.writeFile(envFile, Object.entries(config).map(([key, value]) => `${key}="${value}"`).join("\n") + "\nOTHER_SETTING=keep\n");
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vex-bundled-port-"));
  envFile = path.join(directory, ".env");
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("bundled embedding port repair", () => {
  it("relocates only the URL after real-response validation and refreshes loaded process config", async () => {
    await writeConfig();
    const env = { ...defaultEmbeddingEnv(), VEX_EMBED_PORT: String(TARGET_PORT) };
    const fetchImpl = transport();
    const result = await ensureEmbeddingDefaults({ envFile, env, fetchImpl });
    expect(result).toEqual({ kind: "relocated", writtenKeys: ["EMBEDDING_BASE_URL"] });
    expect(env.EMBEDDING_BASE_URL).toBe(defaultEmbeddingEnv(TARGET_PORT).EMBEDDING_BASE_URL);
    expect(readDotenvFileValue("EMBEDDING_BASE_URL", envFile)).toBe(env.EMBEDDING_BASE_URL);
    for (const key of ["EMBEDDING_MODEL", "EMBEDDING_DIM", "EMBEDDING_PROVIDER"] as const) {
      expect(readDotenvFileValue(key, envFile)).toBe(defaultEmbeddingEnv()[key]);
    }
    expect(readDotenvFileValue("OTHER_SETTING", envFile)).toBe("keep");
    const request = fetchImpl.mock.calls[1];
    expect(request?.[0]).toBe("http://127.0.0.1:27234/v1/embeddings");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ model: EMBEDDING_MODEL_ALIAS, input: "vex runtime availability probe" });
    fetchImpl.mockClear();
    expect((await ensureEmbeddingDefaults({ envFile, env, fetchImpl })).kind).toBe("preserved");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([
    { EMBEDDING_BASE_URL: "https://custom.example/v1" },
    { EMBEDDING_BASE_URL: "http://127.0.0.1:3000/v1" },
    { EMBEDDING_MODEL: "custom-model" },
    { EMBEDDING_DIM: "1024" },
    { EMBEDDING_PROVIDER: "custom" },
  ])("preserves a custom tuple without probing: %j", async (updates) => {
    await writeConfig(updates);
    const before = await fs.readFile(envFile, "utf8");
    const fetchImpl = transport();
    const result = await ensureEmbeddingDefaults({ envFile, env: {}, embedPort: TARGET_PORT, fetchImpl });
    expect(result.kind).toBe("preserved");
    expect(await fs.readFile(envFile, "utf8")).toBe(before);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves partial state, explicit process overrides, and the disabled switch", async () => {
    const fetchImpl = transport();
    await fs.writeFile(envFile, 'EMBEDDING_BASE_URL="http://127.0.0.1:27134/v1"\n');
    expect((await ensureEmbeddingDefaults({ envFile, env: {}, embedPort: TARGET_PORT, fetchImpl })).kind).toBe("preserved");
    await writeConfig();
    expect((await ensureEmbeddingDefaults({ envFile, env: { EMBEDDING_MODEL: "override" }, embedPort: TARGET_PORT, fetchImpl })).kind).toBe("preserved");
    expect((await ensureEmbeddingDefaults({ envFile, env: {}, embedPort: TARGET_PORT, fetchImpl, repairBundledPort: false })).kind).toBe("preserved");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves when the existing endpoint answers even with an error status", async () => {
    await writeConfig();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("busy", { status: 503 }));
    expect((await ensureEmbeddingDefaults({ envFile, env: {}, embedPort: TARGET_PORT, fetchImpl })).kind).toBe("preserved");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    () => new Response("unavailable", { status: 503 }),
    () => Response.json({ model: "different-model", data: [{ embedding: Array.from({ length: EMBEDDING_DIM }, () => 0.1) }] }),
    () => Response.json({ model: EMBEDDING_MODEL_ALIAS, data: [{ embedding: [0.1] }] }),
    () => Response.json({ model: EMBEDDING_MODEL_ALIAS, data: [{ embedding: Array.from({ length: EMBEDDING_DIM }, () => "invalid") }] }),
    () => new Response("invalid-json"),
  ])("preserves when target readiness cannot prove the bundled model and dimension", async (targetResponse) => {
    await writeConfig();
    const before = await fs.readFile(envFile, "utf8");
    const env = { ...defaultEmbeddingEnv() };
    expect((await ensureEmbeddingDefaults({ envFile, env, embedPort: TARGET_PORT, fetchImpl: transport(targetResponse) })).kind).toBe("preserved");
    expect(await fs.readFile(envFile, "utf8")).toBe(before);
    expect(env).toEqual(defaultEmbeddingEnv());
  });

  it("requires connection refusal, not an ambiguous transport error", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new TypeError("fetch failed"); });
    expect(await canRepairBundledEmbeddingPort(TARGET_PORT, fetchImpl)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves a provider change made while the readiness request was in flight", async () => {
    await writeConfig();
    const env = { ...defaultEmbeddingEnv() };
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url.toString().endsWith("/health")) {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      }
      await writeConfig({ EMBEDDING_BASE_URL: "https://custom.example/v1" });
      env.EMBEDDING_MODEL = "explicit-override";
      return successfulPayload();
    });
    expect((await ensureEmbeddingDefaults({ envFile, env, embedPort: TARGET_PORT, fetchImpl })).kind).toBe("preserved");
    expect(readDotenvFileValue("EMBEDDING_BASE_URL", envFile)).toBe("https://custom.example/v1");
    expect(env.EMBEDDING_MODEL).toBe("explicit-override");
    expect(env.EMBEDDING_BASE_URL).toBe(defaultEmbeddingEnv().EMBEDDING_BASE_URL);
  });

  it("bounds a stalled request and preserves the file", async () => {
    await writeConfig();
    const before = await fs.readFile(envFile, "utf8");
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    // AbortSignal.timeout uses the native clock, so replace only its timer in this guardrail.
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const pending = ensureEmbeddingDefaults({ envFile, env: {}, embedPort: TARGET_PORT, fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect((await pending).kind).toBe("preserved");
    expect(timeout).toHaveBeenCalledWith(5_000);
    timeout.mockRestore();
    expect(await fs.readFile(envFile, "utf8")).toBe(before);
  });

  it.each([27134, 0, -1, 65536, 2.5])("does not probe an unchanged or invalid port %s", async (port) => {
    const fetchImpl = transport();
    expect(await canRepairBundledEmbeddingPort(port, fetchImpl)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
