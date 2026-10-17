/**
 * What the assembled native runtime reports to the "Preparing local runtime"
 * screen: every step of a start, and each way a start fails mapped to the
 * step and kind the screen branches on. The supervisors and the model store
 * are stand-ins; `native-runtime.real.test.ts` runs the real binaries.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeRuntimeStatus } from "@shared/schemas/system.js";
import type { LlamaStartResult } from "../native/llama-supervisor.js";
import type { EnsureModelResult, ModelProgress } from "../native/model-store.js";
import type { PgHealth, PgStartResult } from "../native/postgres-supervisor.js";

const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "vex-native-runtime-"));
const connection = { host: "127.0.0.1", pgPort: 45999, pgPasswordPath: "/cfg/pg_password" };

const mocks = vi.hoisted(() => ({
  pgBinaries: true,
  llamaBinary: true,
  pgStart: null as unknown as () => Promise<PgStartResult>,
  ensureModel: null as unknown as (onProgress: (p: ModelProgress) => void) => Promise<EnsureModelResult>,
  llamaStart: null as unknown as () => Promise<LlamaStartResult>,
  pgHealth: new Set<(health: PgHealth) => void>(),
  llamaUnhealthy: null as ((reason: string) => void) | null,
  builds: 0,
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../runtime-paths.js", async () => {
  const p = await import("node:path");
  return {
    RUNTIME_DIR: runtimeDir,
    llamaCacheDir: (dir: string) => p.join(dir, "llama-cache"),
    modelsDir: (dir: string) => p.join(dir, "models"),
    pgDataDir: (dir: string) => p.join(dir, "pg18"),
    locatePostgresBinaries: async () =>
      mocks.pgBinaries
        ? { kind: "found", binaries: {} }
        : { kind: "unavailable", detail: "The bundled Postgres is missing." },
    locateLlamaBinary: async () =>
      mocks.llamaBinary
        ? { kind: "found", binaryPath: "/llama-server" }
        : { kind: "unavailable", detail: "The bundled llama-server is missing." },
  };
});
vi.mock("../secrets/pg-password.js", () => ({ getPgPassword: vi.fn() }));
vi.mock("../secrets/production-deps.js", () => ({ productionPgPasswordDeps: vi.fn() }));
vi.mock("../native/embedding-env.js", () => ({ publishNativeEmbeddings: vi.fn() }));
vi.mock("../native/postgres-supervisor.js", () => ({
  createPostgresSupervisor: () => {
    mocks.builds += 1;
    return {
      ensureCluster: vi.fn(),
      start: () => mocks.pgStart(),
      stop: async () => ({ kind: "stopped", mode: "fast", message: "" }),
      onHealthChange: (listener: (health: PgHealth) => void) => {
        mocks.pgHealth.add(listener);
        return () => mocks.pgHealth.delete(listener);
      },
    };
  },
}));
vi.mock("../native/llama-supervisor.js", () => ({
  LlamaSupervisor: class {
    constructor(options: { onUnhealthy: (reason: string) => void }) {
      mocks.llamaUnhealthy = options.onUnhealthy;
    }
    start(): Promise<LlamaStartResult> {
      return mocks.llamaStart();
    }
    async stop(): Promise<void> {}
    onEndpointChange(): () => void {
      return () => {};
    }
  },
}));
vi.mock("../native/model-store.js", () => ({
  EMBEDDING_MODEL_SPEC: { fileName: "model.gguf" },
  ensureModel: (options: { onProgress: (p: ModelProgress) => void }) => mocks.ensureModel(options.onProgress),
}));

const pgRunning: PgStartResult = { kind: "running", connection, message: "The local database is running." };
const llamaReady: LlamaStartResult = {
  kind: "ready",
  endpoint: { baseUrl: "http://127.0.0.1:41234/v1", apiKey: "key", port: 41234 },
};
const modelReady: EnsureModelResult = { kind: "ready", path: "/models/model.gguf", downloaded: false };

async function load() {
  vi.resetModules();
  const runtime = await import("../native/native-runtime.js");
  const { nativeRuntimeProgress, nativeRuntimeProgressBus } = await import("../native/native-runtime-progress.js");
  const seen: NativeRuntimeStatus[] = [];
  nativeRuntimeProgressBus.subscribe((status) => seen.push(status));
  return { ...runtime, progress: nativeRuntimeProgress, seen };
}

beforeEach(() => {
  mocks.pgBinaries = true;
  mocks.llamaBinary = true;
  mocks.pgStart = async () => pgRunning;
  mocks.ensureModel = async () => modelReady;
  mocks.llamaStart = async () => llamaReady;
  mocks.pgHealth.clear();
  mocks.llamaUnhealthy = null;
  mocks.builds = 0;
});

afterAll(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

describe("native runtime start, as the runtime screen sees it", () => {
  it("walks a first run's download through to ready", async () => {
    mocks.ensureModel = async (onProgress) => {
      onProgress({ phase: "downloading", receivedBytes: 10, totalBytes: 100, sourceIndex: 0 });
      onProgress({ phase: "downloading", receivedBytes: 100, totalBytes: 100, sourceIndex: 0 });
      return { kind: "ready", path: "/models/model.gguf", downloaded: true };
    };
    const { startNativeRuntime, seen } = await load();
    expect(await startNativeRuntime()).toEqual({ kind: "running", message: "The local database is running." });
    expect(seen.map(({ seq: _seq, ...state }) => state)).toEqual([
      // No cluster in the fresh runtime dir: this start creates it.
      { phase: "postgres", initializing: true },
      { phase: "model", model: { state: "checking" } },
      { phase: "model", model: { state: "downloading", receivedBytes: 10, totalBytes: 100, bytesPerSecond: null } },
      { phase: "model", model: { state: "downloading", receivedBytes: 100, totalBytes: 100, bytesPerSecond: null } },
      { phase: "embeddings" },
      { phase: "ready" },
    ]);
  });

  it.each<[string, () => void, Partial<NativeRuntimeStatus>]>([
    [
      "a full disk before the model download",
      () => {
        mocks.ensureModel = async () => ({ kind: "disk_full", requiredBytes: 400, availableBytes: 12 });
      },
      { step: "model", kind: "disk_full", message: "Not enough disk space for the embeddings model (12 bytes free)." },
    ],
    [
      "no model source reachable",
      () => {
        mocks.ensureModel = async () => ({ kind: "unavailable", message: "source 1: getaddrinfo ENOTFOUND huggingface.co" });
      },
      {
        step: "model",
        kind: "offline",
        message: "The embeddings model could not be downloaded: source 1: getaddrinfo ENOTFOUND huggingface.co",
      },
    ],
    [
      "another database on the port",
      () => {
        mocks.pgStart = async () => ({ kind: "foreign_listener", connection: null, message: "Not this install's database." });
      },
      { step: "postgres", kind: "foreign_listener", message: "Not this install's database." },
    ],
    [
      "no free port",
      () => {
        mocks.pgStart = async () => ({ kind: "port_collision", connection: null, message: "No port." });
      },
      { step: "postgres", kind: "port_collision", message: "No port." },
    ],
    [
      "a full disk under Postgres",
      () => {
        mocks.pgStart = async () => ({ kind: "disk_full", connection: null, message: "The disk is full." });
      },
      { step: "postgres", kind: "disk_full", message: "The disk is full." },
    ],
    [
      "the embeddings server failing its probe",
      () => {
        mocks.llamaStart = async () => ({ kind: "failed", reason: "llama-server exited code=1" });
      },
      { step: "embeddings", kind: "failed", message: "llama-server exited code=1" },
    ],
    [
      "a missing Postgres tree",
      () => {
        mocks.pgBinaries = false;
      },
      { step: "postgres", kind: "unavailable", message: "The bundled Postgres is missing." },
    ],
    [
      "a missing llama-server",
      () => {
        mocks.llamaBinary = false;
      },
      // Nothing ran: the start stops at its first step whichever tree is missing.
      { step: "postgres", kind: "unavailable", message: "The bundled llama-server is missing." },
    ],
    [
      "a start that throws",
      () => {
        mocks.pgStart = async () => {
          throw new Error("EACCES: permission denied");
        };
      },
      { step: "postgres", kind: "failed", message: "EACCES: permission denied" },
    ],
  ])("reports %s as its own failure", async (_name, arrange, failure) => {
    arrange();
    const { startNativeRuntime, progress, seen } = await load();
    const result = await startNativeRuntime();
    expect(result.kind).not.toBe("running");
    expect(progress.current()).toMatchObject({ phase: "failed", ...failure });
    expect(seen.filter((s) => s.phase === "failed")).toHaveLength(1);
  });

  it("joins a start in flight instead of building a second runtime", async () => {
    let release: () => void = () => {};
    mocks.pgStart = () => new Promise((resolve) => (release = () => resolve(pgRunning)));
    const { startNativeRuntime } = await load();
    const boot = startNativeRuntime();
    const migrate = startNativeRuntime();
    expect(migrate).toBe(boot);
    await vi.waitFor(() => expect(mocks.builds).toBe(1));
    release();
    expect(await migrate).toMatchObject({ kind: "running" });
    expect(mocks.builds).toBe(1);
  });

  it("starts again from the database step on a retry after a failure", async () => {
    mocks.ensureModel = async () => ({ kind: "unavailable", message: "offline" });
    const { startNativeRuntime, progress, seen } = await load();
    await startNativeRuntime();
    expect(progress.current()).toMatchObject({ phase: "failed", kind: "offline" });

    mocks.ensureModel = async () => modelReady;
    mocks.pgStart = async () => ({ kind: "reused", connection, message: "The local database is already running." });
    expect(await startNativeRuntime()).toMatchObject({ kind: "reused" });
    expect(seen.map((s) => s.phase)).toEqual([
      "postgres", "model", "failed",
      "postgres", "model", "embeddings", "ready",
    ]);
  });

  it("marks a ready runtime unhealthy once a supervisor gives up on it", async () => {
    const { startNativeRuntime, progress } = await load();
    await startNativeRuntime();
    // Restarts within the budget are not failures.
    mocks.pgHealth.forEach((listener) => listener({ kind: "restarting", attempt: 1 }));
    expect(progress.current().phase).toBe("ready");
    mocks.llamaUnhealthy?.("llama-server restart budget exhausted");
    expect(progress.current()).toMatchObject({
      phase: "failed",
      step: "embeddings",
      kind: "unhealthy",
      message: "llama-server restart budget exhausted",
    });
  });

  it("marks a ready runtime unhealthy when Postgres does not recover", async () => {
    const { startNativeRuntime, progress } = await load();
    await startNativeRuntime();
    mocks.pgHealth.forEach((listener) =>
      listener({ kind: "unhealthy", message: "The local database stopped.", failure: "unhealthy" }),
    );
    expect(progress.current()).toMatchObject({ phase: "failed", step: "postgres", kind: "unhealthy" });
  });

  it("marks a ready runtime disk_full when Postgres stopped because its disk filled", async () => {
    const { startNativeRuntime, progress } = await load();
    await startNativeRuntime();
    mocks.pgHealth.forEach((listener) =>
      listener({
        kind: "unhealthy",
        message: "The local database stopped and did not recover: The disk is full, so the local database could not start.",
        failure: "disk_full",
      }),
    );
    expect(progress.current()).toMatchObject({ phase: "failed", step: "postgres", kind: "disk_full" });
  });
});
