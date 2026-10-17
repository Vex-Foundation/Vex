import { describe, expect, it, vi } from "vitest";
import type { LlamaEndpoint, LlamaStartResult } from "../native/llama-supervisor.js";
import { createNativeProvider } from "../native/native-provider.js";
import type { PgHealth, PgStartResult, PostgresSupervisor } from "../native/postgres-supervisor.js";
import type { RuntimeEndpoints } from "../provider.js";

const connection = { host: "127.0.0.1", pgPort: 45999, pgPasswordPath: "/cfg/local-infra/secrets/pg_password" };
const llamaReady: LlamaStartResult = {
  kind: "ready",
  endpoint: { baseUrl: "http://127.0.0.1:41234/v1", apiKey: "per-launch-key", port: 41234 },
};

const pgHealthListeners = new Set<(health: PgHealth) => void>();
const endpointListeners = new Set<(endpoint: LlamaEndpoint | null) => void>();

function postgres(start: PgStartResult, stopKind: "stopped" | "not_running" | "failed" = "stopped"): PostgresSupervisor {
  return {
    ensureCluster: vi.fn(),
    start: vi.fn(async () => start),
    stop: vi.fn(async () => ({ kind: stopKind, mode: stopKind === "stopped" ? ("fast" as const) : null, message: "" })),
    onHealthChange: vi.fn((listener: (health: PgHealth) => void) => {
      pgHealthListeners.add(listener);
      return () => pgHealthListeners.delete(listener);
    }),
  };
}

function onEndpointChange(listener: (endpoint: LlamaEndpoint | null) => void): () => void {
  endpointListeners.add(listener);
  return () => endpointListeners.delete(listener);
}

function embeddings(result: LlamaStartResult) {
  return { start: vi.fn(async () => result), stop: vi.fn(async () => {}), onEndpointChange };
}

const pgHealth = (health: PgHealth): void => pgHealthListeners.forEach((l) => l(health));
const llamaEndpoint = (endpoint: LlamaEndpoint | null): void => endpointListeners.forEach((l) => l(endpoint));

const running: PgStartResult = { kind: "running", connection, message: "" };
const signal = (): AbortSignal => new AbortController().signal;

describe("native provider", () => {
  it("is the `native` provider and yields both endpoints when both halves are up", async () => {
    const provider = createNativeProvider({ postgres: postgres(running), embeddings: embeddings(llamaReady) });
    expect(provider.id).toBe("native");
    const outcome = await provider.start(undefined, { signal: signal() });
    expect(outcome).toMatchObject({
      kind: "running",
      endpoints: { db: connection, embeddings: { baseUrl: "http://127.0.0.1:41234/v1", apiKey: "per-launch-key" } },
    });
  });

  it("does not start embeddings, and yields no endpoints, when Postgres is not usable", async () => {
    const emb = embeddings(llamaReady);
    const provider = createNativeProvider({
      postgres: postgres({ kind: "disk_full", connection: null, message: "full" }),
      embeddings: emb,
    });
    expect(await provider.start(undefined, { signal: signal() })).toMatchObject({ kind: "disk_full", endpoints: null });
    expect(emb.start).not.toHaveBeenCalled();
  });

  it("publishes nothing when embeddings fail, even though Postgres is up", async () => {
    const provider = createNativeProvider({
      postgres: postgres(running),
      embeddings: embeddings({ kind: "failed", reason: "probe failed" }),
    });
    expect(await provider.start(undefined, { signal: signal() })).toMatchObject({ kind: "failed", endpoints: null });
  });

  it("an abort during the embeddings half rejects with AbortError", async () => {
    const controller = new AbortController();
    const emb = {
      start: vi.fn(async () => {
        controller.abort();
        return llamaReady;
      }),
      stop: vi.fn(async () => {}),
      onEndpointChange,
    };
    const provider = createNativeProvider({ postgres: postgres(running), embeddings: emb });
    await expect(provider.start(undefined, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops embeddings then Postgres, with Postgres' 15 s fast-stop window, and reports Postgres' outcome", async () => {
    const order: string[] = [];
    const pg = postgres(running);
    vi.mocked(pg.stop).mockImplementation(async () => {
      order.push("postgres");
      return { kind: "stopped", mode: "fast", message: "" };
    });
    const emb = {
      start: vi.fn(),
      stop: vi.fn(async () => {
        order.push("embeddings");
      }),
      onEndpointChange,
    };
    const outcome = await createNativeProvider({ postgres: pg, embeddings: emb }).stop();
    expect(outcome.kind).toBe("stopped");
    expect(order).toEqual(["embeddings", "postgres"]);
    expect(pg.stop).toHaveBeenCalledWith({ deadlineMs: 15_000 });

    const failed = createNativeProvider({ postgres: postgres(running, "failed"), embeddings: embeddings(llamaReady) });
    expect((await failed.stop()).kind).toBe("failed");
  });

  it("watch reports supervised restarts and outages after a usable start, and nothing around it", async () => {
    pgHealthListeners.clear();
    endpointListeners.clear();
    const seen: Array<RuntimeEndpoints | null> = [];
    const provider = createNativeProvider({ postgres: postgres(running), embeddings: embeddings(llamaReady) });
    provider.watch?.((e) => seen.push(e));

    // Before any start: supervision noise is not an endpoint change.
    pgHealth({ kind: "restarting", attempt: 1 });
    expect(seen).toEqual([]);

    await provider.start(undefined, { signal: signal() });
    const movedDb = { ...connection, pgPort: 46001 };
    pgHealth({ kind: "restarting", attempt: 1 });
    pgHealth({ kind: "running", connection: movedDb });
    const newKey: LlamaEndpoint = { baseUrl: "http://127.0.0.1:42000/v1", apiKey: "second-key", port: 42000 };
    llamaEndpoint(null);
    llamaEndpoint(newKey);
    expect(seen).toEqual([
      null,
      { db: movedDb, embeddings: { baseUrl: "http://127.0.0.1:41234/v1", apiKey: "per-launch-key" } },
      null,
      { db: movedDb, embeddings: { baseUrl: "http://127.0.0.1:42000/v1", apiKey: "second-key" } },
    ]);

    // A requested stop is not an outage to report.
    await provider.stop();
    llamaEndpoint(null);
    pgHealth({ kind: "unhealthy", message: "gone" });
    expect(seen).toHaveLength(4);
  });
});
