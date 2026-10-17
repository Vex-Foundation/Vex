import { afterEach, describe, expect, it, vi } from "vitest";

import { getDbConnection, setDbConnection } from "../../database/connection-state.js";
import { AbortError } from "../../ipc/cancel-helpers.js";
import type {
  LocalRuntimeProvider,
  RuntimeEndpoints,
  RuntimeStartKind,
  RuntimeStartOutcome,
  RuntimeStopKind,
} from "../provider.js";
import { createRuntimeHost } from "../runtime-host.js";

const DB = { host: "127.0.0.1", pgPort: 27432, pgPasswordPath: "/secrets/pg_password" };

function outcome(kind: RuntimeStartKind): RuntimeStartOutcome<string> {
  const usable = kind === "running" || kind === "reused";
  return {
    kind,
    endpoints: usable ? { db: DB, embeddings: { baseUrl: "http://127.0.0.1:27134/v1", apiKey: null } } : null,
    detail: kind,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeProvider(stopKind: RuntimeStopKind = "stopped") {
  const starts: Array<{ input: string; signal: AbortSignal; result: Deferred<RuntimeStartOutcome<string>> }> = [];
  const provider: LocalRuntimeProvider<string, string, string> = {
    id: "docker",
    start: vi.fn((input: string, options: { signal: AbortSignal }) => {
      const result = deferred<RuntimeStartOutcome<string>>();
      starts.push({ input, signal: options.signal, result });
      return result.promise;
    }),
    stop: vi.fn(async () => ({ kind: stopKind, detail: stopKind })),
  };
  return { provider, starts };
}

afterEach(() => {
  setDbConnection(null);
});

describe("runtime host publication", () => {
  it.each(["running", "reused"] as const)("publishes the database endpoint on %s", async (kind) => {
    const { provider, starts } = fakeProvider();
    const host = createRuntimeHost(provider);
    const pending = host.start("in", "k", { signal: new AbortController().signal });
    starts[0]?.result.resolve(outcome(kind));
    await expect(pending).resolves.toMatchObject({ joined: false, outcome: { kind } });
    expect(getDbConnection()).toEqual(DB);
  });

  it.each(["port_collision", "foreign_listener", "unhealthy", "failed"] as const)(
    "publishes nothing on %s",
    async (kind) => {
      const { provider, starts } = fakeProvider();
      const host = createRuntimeHost(provider);
      const pending = host.start("in", "k", { signal: new AbortController().signal });
      starts[0]?.result.resolve(outcome(kind));
      await pending;
      expect(getDbConnection()).toBeNull();
    },
  );

  it("republishes a supervising provider's restarts and outages, embeddings included", async () => {
    const { provider, starts } = fakeProvider();
    let report: ((endpoints: RuntimeEndpoints | null) => void) | null = null;
    const watched = { ...provider, watch: (listener: (e: RuntimeEndpoints | null) => void) => ((report = listener), () => {}) };
    const embeddings: Array<RuntimeEndpoints["embeddings"] | null> = [];
    const host = createRuntimeHost(watched, { onEmbeddings: (e) => embeddings.push(e) });

    const pending = host.start("in", "k", { signal: new AbortController().signal });
    starts[0]?.result.resolve(outcome("running"));
    await pending;
    expect(embeddings).toEqual([{ baseUrl: "http://127.0.0.1:27134/v1", apiKey: null }]);

    report!(null);
    expect(getDbConnection()).toBeNull();
    const moved = { db: { ...DB, pgPort: 46001 }, embeddings: { baseUrl: "http://127.0.0.1:41000/v1", apiKey: "k2" } };
    report!(moved);
    expect(getDbConnection()).toEqual(moved.db);
    expect(embeddings.slice(1)).toEqual([null, moved.embeddings]);

    await host.stop();
    expect(getDbConnection()).toBeNull();
    expect(embeddings.at(-1)).toBeNull();
  });

  it("clears the connection only on a confirmed stop", async () => {
    for (const [kind, cleared] of [["stopped", true], ["failed", false], ["not_running", false]] as const) {
      setDbConnection(DB);
      const host = createRuntimeHost(fakeProvider(kind).provider);
      await expect(host.stop()).resolves.toEqual({ kind, detail: kind });
      expect(getDbConnection()).toEqual(cleared ? null : DB);
    }
  });
});

describe("runtime host single flight", () => {
  it("joins an identical start instead of starting a second one", async () => {
    const { provider, starts } = fakeProvider();
    const host = createRuntimeHost(provider);
    const first = host.start("in", "k", { signal: new AbortController().signal });
    const second = host.start("in", "k", { signal: new AbortController().signal });
    starts[0]?.result.resolve(outcome("running"));
    await expect(first).resolves.toMatchObject({ joined: false });
    await expect(second).resolves.toMatchObject({ joined: true, outcome: { kind: "running" } });
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it("does not share work between different keys", async () => {
    const { provider, starts } = fakeProvider();
    const host = createRuntimeHost(provider);
    const a = host.start("a", "key-a", { signal: new AbortController().signal });
    const b = host.start("b", "key-b", { signal: new AbortController().signal });
    starts[0]?.result.resolve(outcome("running"));
    starts[1]?.result.resolve(outcome("failed"));
    await expect(a).resolves.toMatchObject({ joined: false, outcome: { kind: "running" } });
    await expect(b).resolves.toMatchObject({ joined: false, outcome: { kind: "failed" } });
    expect(provider.start).toHaveBeenCalledTimes(2);
  });

  it("detaches only the joiner that aborts; the shared start continues", async () => {
    const { provider, starts } = fakeProvider();
    const host = createRuntimeHost(provider);
    const initiator = host.start("in", "k", { signal: new AbortController().signal });
    const joinerAbort = new AbortController();
    const joiner = host.start("in", "k", { signal: joinerAbort.signal });
    joinerAbort.abort();
    await expect(joiner).rejects.toMatchObject({ name: "AbortError" });
    // The provider only ever saw the initiator's signal.
    expect(starts[0]?.signal.aborted).toBe(false);
    starts[0]?.result.resolve(outcome("running"));
    await expect(initiator).resolves.toMatchObject({ outcome: { kind: "running" } });
    expect(getDbConnection()).toEqual(DB);
  });

  it("propagates the initiator's cancellation to every joiner and publishes nothing", async () => {
    const { provider, starts } = fakeProvider();
    const host = createRuntimeHost(provider);
    const initiator = host.start("in", "k", { signal: new AbortController().signal });
    const joiner = host.start("in", "k", { signal: new AbortController().signal });
    starts[0]?.result.reject(new AbortError());
    await expect(initiator).rejects.toMatchObject({ name: "AbortError" });
    await expect(joiner).rejects.toMatchObject({ name: "AbortError" });
    expect(getDbConnection()).toBeNull();
  });

  it("starts fresh once the previous start has settled", async () => {
    const { provider, starts } = fakeProvider();
    const host = createRuntimeHost(provider);
    const first = host.start("in", "k", { signal: new AbortController().signal });
    starts[0]?.result.resolve(outcome("failed"));
    await first;
    const second = host.start("in", "k", { signal: new AbortController().signal });
    starts[1]?.result.resolve(outcome("running"));
    await expect(second).resolves.toMatchObject({ joined: false, outcome: { kind: "running" } });
    expect(provider.start).toHaveBeenCalledTimes(2);
  });
});
