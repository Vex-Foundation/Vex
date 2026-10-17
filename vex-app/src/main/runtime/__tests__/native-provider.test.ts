import { describe, expect, it, vi } from "vitest";
import { createNativeProvider, type NativeEmbeddingsService } from "../native/native-provider.js";
import type { PgStartResult, PostgresSupervisor } from "../native/postgres-supervisor.js";

const connection = { host: "127.0.0.1", pgPort: 45999, pgPasswordPath: "/cfg/local-infra/secrets/pg_password" };
const endpoint = { baseUrl: "http://127.0.0.1:41234/v1", apiKey: "k" };

function postgres(start: PgStartResult, stopKind: "stopped" | "not_running" | "failed" = "stopped"): PostgresSupervisor {
  return {
    ensureCluster: vi.fn(),
    start: vi.fn(async () => start),
    stop: vi.fn(async () => ({ kind: stopKind, mode: stopKind === "stopped" ? ("fast" as const) : null, message: "" })),
    onHealthChange: vi.fn(() => () => {}),
  };
}

function embeddings(result: Awaited<ReturnType<NativeEmbeddingsService["start"]>>): NativeEmbeddingsService {
  return { start: vi.fn(async () => result), stop: vi.fn(async () => ({ kind: "stopped" as const, message: "" })) };
}

const running: PgStartResult = { kind: "running", connection, message: "" };
const signal = (): AbortSignal => new AbortController().signal;

describe("native provider", () => {
  it("is the `native` provider and yields both endpoints when both halves are up", async () => {
    const provider = createNativeProvider({ postgres: postgres(running), embeddings: embeddings({ kind: "ready", endpoint }) });
    expect(provider.id).toBe("native");
    const outcome = await provider.start(undefined, { signal: signal() });
    expect(outcome).toMatchObject({ kind: "running", endpoints: { db: connection, embeddings: endpoint } });
  });

  it("does not start embeddings, and yields no endpoints, when Postgres is not usable", async () => {
    const emb = embeddings({ kind: "ready", endpoint });
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
      embeddings: embeddings({ kind: "unhealthy", message: "probe failed" }),
    });
    expect(await provider.start(undefined, { signal: signal() })).toMatchObject({ kind: "unhealthy", endpoints: null });
  });

  it("an abort during the embeddings half rejects with AbortError", async () => {
    const controller = new AbortController();
    const emb: NativeEmbeddingsService = {
      start: vi.fn(async () => {
        controller.abort();
        return { kind: "ready" as const, endpoint };
      }),
      stop: vi.fn(),
    };
    const provider = createNativeProvider({ postgres: postgres(running), embeddings: emb });
    await expect(provider.start(undefined, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops embeddings then Postgres, with Postgres' 15 s fast-stop window", async () => {
    const order: string[] = [];
    const pg = postgres(running);
    vi.mocked(pg.stop).mockImplementation(async () => {
      order.push("postgres");
      return { kind: "stopped", mode: "fast", message: "" };
    });
    const emb: NativeEmbeddingsService = {
      start: vi.fn(),
      stop: vi.fn(async () => {
        order.push("embeddings");
        return { kind: "stopped" as const, message: "" };
      }),
    };
    const outcome = await createNativeProvider({ postgres: pg, embeddings: emb }).stop();
    expect(outcome.kind).toBe("stopped");
    expect(order).toEqual(["embeddings", "postgres"]);
    expect(pg.stop).toHaveBeenCalledWith({ deadlineMs: 15_000 });
  });

  it("a failed half makes the stop failed; nothing running anywhere is not_running", async () => {
    const failedPg = createNativeProvider({ postgres: postgres(running, "failed"), embeddings: embeddings({ kind: "ready", endpoint }) });
    expect((await failedPg.stop()).kind).toBe("failed");
    const idle = createNativeProvider({
      postgres: postgres(running, "not_running"),
      embeddings: { start: vi.fn(), stop: vi.fn(async () => ({ kind: "not_running" as const, message: "" })) },
    });
    expect((await idle.stop()).kind).toBe("not_running");
  });
});
