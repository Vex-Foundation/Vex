/**
 * K-4: the shared main-process IPC pool, against fake `pg` classes.
 *
 * Pins the contract the pool must keep with today's fresh-client-per-call
 * `withClient`: OFF is the exact old path; ON keeps one dedicated client for a
 * caller's whole callback, always gives it back, never lets an open or
 * aborted transaction reach the next caller, falls back to a fresh client for
 * nested calls, and is retired on a connection handoff or a config change and
 * closed on quit. Real-Postgres parity and the latency numbers live in
 * `main-ipc-pg-pool.int.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DbPoolConfig } from "../db-config.js";
import type { MainDbClientCall } from "../main-ipc-pg-pool.js";

interface FakeConfig {
  readonly [key: string]: unknown;
}

const state = vi.hoisted(() => ({
  clients: [] as FakeClientLike[],
  pools: [] as FakePoolLike[],
  connectError: null as Error | null,
  poolConnectError: null as Error | null,
  endError: null as Error | null,
  warn: [] as string[],
}));

interface FakeClientLike {
  readonly config: FakeConfig;
  readonly queries: string[];
  connected: boolean;
  ended: boolean;
  releases: Array<boolean | Error | undefined>;
}

interface FakePoolLike {
  readonly options: FakeConfig;
  ended: boolean;
  readonly checkedOut: FakeClientLike[];
  readonly errorListeners: number;
}

vi.mock("../../logger/index.js", () => ({
  log: {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (message: string): void => {
      state.warn.push(message);
    },
    error: (): void => undefined,
  },
}));

vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeConnection extends EventEmitter {}

  class Client implements FakeClientLike {
    readonly config: FakeConfig;
    readonly queries: string[] = [];
    readonly connection = new FakeConnection();
    connected = false;
    ended = false;
    releases: Array<boolean | Error | undefined> = [];
    private status = "I";

    constructor(config: FakeConfig) {
      this.config = config;
      state.clients.push(this);
    }

    connect(): Promise<void> {
      if (state.connectError !== null) return Promise.reject(state.connectError);
      this.connected = true;
      return Promise.resolve();
    }

    query(text: string): Promise<{ rows: unknown[] }> {
      this.queries.push(text);
      if (text.startsWith("BEGIN")) this.status = "T";
      if (text === "COMMIT" || text === "ROLLBACK") this.status = "I";
      if (text === "FAIL") {
        if (this.status === "T") this.status = "E";
        this.connection.emit("readyForQuery", { name: "readyForQuery", status: this.status });
        return Promise.reject(new Error("statement failed"));
      }
      this.connection.emit("readyForQuery", { name: "readyForQuery", status: this.status });
      return Promise.resolve({ rows: [] });
    }

    end(): Promise<void> {
      this.ended = true;
      if (state.endError !== null) return Promise.reject(state.endError);
      return Promise.resolve();
    }
  }

  class Pool implements FakePoolLike {
    readonly options: FakeConfig;
    ended = false;
    readonly checkedOut: Client[] = [];
    private readonly idle: Client[] = [];
    errorListeners = 0;
    totalCount = 0;
    idleCount = 0;
    waitingCount = 0;

    constructor(options: FakeConfig) {
      this.options = options;
      state.pools.push(this);
    }

    on(event: string): this {
      if (event === "error") this.errorListeners += 1;
      return this;
    }

    connect(): Promise<Client & { release: (arg?: boolean | Error) => void }> {
      if (state.poolConnectError !== null) return Promise.reject(state.poolConnectError);
      const client = this.idle.pop() ?? new Client(this.options);
      client.connected = true;
      this.checkedOut.push(client);
      const release = (arg?: boolean | Error): void => {
        client.releases.push(arg);
        if (arg === true || arg instanceof Error || this.ended) {
          client.ended = true;
        } else {
          this.idle.push(client);
        }
      };
      return Promise.resolve(Object.assign(client, { release }));
    }

    end(): Promise<void> {
      if (this.ended) return Promise.reject(new Error("Called end on pool more than once"));
      this.ended = true;
      for (const client of this.idle) client.ended = true;
      return Promise.resolve();
    }
  }

  return { Client, Pool };
});

const pool = await import("../main-ipc-pg-pool.js");
const { setDbConnection } = await import("../connection-state.js");

const CFG: DbPoolConfig = {
  host: "127.0.0.1",
  port: 27432,
  database: "vex",
  user: "vex",
  password: "pw",
};

const CALL: MainDbClientCall<unknown> = {
  logPrefix: "[test-db]",
  timeouts: { connectTimeoutMs: 2_000, statementTimeoutMs: 5_000 },
  onConnectFailed: (): unknown => "unavailable",
};

function lastPool(): FakePoolLike {
  const value = state.pools.at(-1);
  if (value === undefined) throw new Error("no pool was created");
  return value;
}

beforeEach(async () => {
  await pool.closeMainIpcPgPool();
  state.clients.length = 0;
  state.pools.length = 0;
  state.connectError = null;
  state.poolConnectError = null;
  state.endError = null;
  state.warn.length = 0;
  setDbConnection(null);
});

afterEach(() => {
  pool.setMainIpcPgPoolOverrideForTests(null);
});

describe("MAIN_IPC_PG_POOL switch", () => {
  it("ships OFF until real-Postgres parity is proven on the owner's machine", () => {
    expect(pool.MAIN_IPC_PG_POOL).toBe(false);
    expect(pool.mainIpcPgPoolEnabled()).toBe(false);
  });
});

describe("OFF: today's fresh client per call", () => {
  beforeEach(() => {
    pool.setMainIpcPgPoolOverrideForTests(false);
  });

  it("opens, uses and ends one new client per call with today's exact config", async () => {
    const seen: unknown[] = [];
    const a = await pool.runWithMainDbClient(CFG, CALL, async (client) => {
      seen.push(client);
      await client.query("SELECT 1");
      return "a";
    });
    const b = await pool.runWithMainDbClient(CFG, CALL, async (client) => {
      seen.push(client);
      return "b";
    });
    expect([a, b]).toEqual(["a", "b"]);
    expect(state.pools).toHaveLength(0);
    expect(state.clients).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    for (const client of state.clients) {
      expect(client.config).toEqual({
        host: "127.0.0.1",
        port: 27432,
        database: "vex",
        user: "vex",
        password: "pw",
        connectionTimeoutMillis: 2_000,
        statement_timeout: 5_000,
      });
      expect(client.ended).toBe(true);
    }
  });

  it("returns onConnectFailed and logs the same line on a refused connect", async () => {
    state.connectError = new Error("ECONNREFUSED");
    const fn = vi.fn(async () => "never");
    const result = await pool.runWithMainDbClient(CFG, CALL, fn);
    expect(result).toBe("unavailable");
    expect(fn).not.toHaveBeenCalled();
    expect(state.warn).toEqual(["[test-db] client.connect failed"]);
  });

  it("ends the client when the callback throws and rethrows", async () => {
    await expect(
      pool.runWithMainDbClient(CFG, CALL, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(state.clients[0]?.ended).toBe(true);
  });

  it("treats a failed end as non-fatal, with today's log line", async () => {
    state.endError = new Error("socket gone");
    const result = await pool.runWithMainDbClient(CFG, CALL, async () => "ok");
    expect(result).toBe("ok");
    expect(state.warn).toEqual(["[test-db] client.end failed (non-fatal)"]);
  });
});

describe("ON: one shared bounded pool", () => {
  beforeEach(() => {
    pool.setMainIpcPgPoolOverrideForTests(true);
  });

  it("creates one pool with today's connection config plus max and idle timeout", async () => {
    await pool.runWithMainDbClient(CFG, CALL, async () => "a");
    await pool.runWithMainDbClient(CFG, CALL, async () => "b");
    expect(state.pools).toHaveLength(1);
    expect(lastPool().options).toEqual({
      host: "127.0.0.1",
      port: 27432,
      database: "vex",
      user: "vex",
      password: "pw",
      connectionTimeoutMillis: 2_000,
      statement_timeout: 5_000,
      max: pool.MAIN_IPC_PG_POOL_MAX,
      idleTimeoutMillis: pool.MAIN_IPC_PG_POOL_IDLE_TIMEOUT_MS,
      allowExitOnIdle: true,
    });
    expect(pool.MAIN_IPC_PG_POOL_MAX).toBeLessThanOrEqual(8);
    expect(lastPool().errorListeners).toBe(1);
  });

  it("reuses an idle connection and returns it to the pool after a clean call", async () => {
    await pool.runWithMainDbClient(CFG, CALL, async (client) => client.query("SELECT 1"));
    await pool.runWithMainDbClient(CFG, CALL, async (client) => client.query("SELECT 2"));
    expect(state.clients).toHaveLength(1);
    const client = state.clients[0];
    expect(client?.queries).toEqual(["SELECT 1", "SELECT 2"]);
    expect(client?.releases).toEqual([undefined, undefined]);
    expect(client?.ended).toBe(false);
  });

  it("keeps one dedicated client for a whole transaction and reuses it after COMMIT", async () => {
    const used = new Set<unknown>();
    await pool.runWithMainDbClient(CFG, CALL, async (client) => {
      used.add(client);
      await client.query("BEGIN");
      used.add(client);
      await client.query("UPDATE x");
      await client.query("COMMIT");
      return "ok";
    });
    expect(used.size).toBe(1);
    expect(state.clients[0]?.releases).toEqual([undefined]);
    expect(state.clients[0]?.ended).toBe(false);
  });

  it("destroys the client when the callback throws, and rethrows", async () => {
    await expect(
      pool.runWithMainDbClient(CFG, CALL, async (client) => {
        await client.query("SELECT 1");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(state.clients[0]?.releases).toEqual([true]);
    expect(state.clients[0]?.ended).toBe(true);
  });

  it("destroys a client left inside an open transaction instead of reusing it", async () => {
    const result = await pool.runWithMainDbClient(CFG, CALL, async (client) => {
      await client.query("BEGIN");
      return "returned-without-commit";
    });
    expect(result).toBe("returned-without-commit");
    expect(state.clients[0]?.releases).toEqual([true]);
    await pool.runWithMainDbClient(CFG, CALL, async (client) => client.query("SELECT 1"));
    expect(state.clients).toHaveLength(2);
    expect(state.clients[1]?.queries).toEqual(["SELECT 1"]);
  });

  it("destroys a client whose transaction aborted, even when the caller swallowed the error", async () => {
    await pool.runWithMainDbClient(CFG, CALL, async (client) => {
      await client.query("BEGIN");
      await client.query("FAIL").catch(() => undefined);
      return "swallowed";
    });
    expect(state.clients[0]?.releases).toEqual([true]);
  });

  it("returns onConnectFailed with today's log line when no client can be checked out", async () => {
    state.poolConnectError = new Error("timeout exceeded when trying to connect");
    const fn = vi.fn(async () => "never");
    expect(await pool.runWithMainDbClient(CFG, CALL, fn)).toBe("unavailable");
    expect(fn).not.toHaveBeenCalled();
    expect(state.warn).toEqual(["[test-db] client.connect failed"]);
  });

  it("gives a nested call a fresh per-call client so nested checkouts cannot starve the pool", async () => {
    await pool.runWithMainDbClient(CFG, CALL, async (outer) => {
      await outer.query("BEGIN");
      const inner = await pool.runWithMainDbClient(CFG, CALL, async (client) => {
        expect(client).not.toBe(outer);
        return client;
      });
      expect(inner).not.toBe(outer);
      await outer.query("COMMIT");
      return "ok";
    });
    expect(state.pools).toHaveLength(1);
    expect(state.clients).toHaveLength(2);
    // The inner client went through the OFF path: ended, never released.
    expect(state.clients[1]?.ended).toBe(true);
    expect(state.clients[1]?.releases).toEqual([]);
    expect(state.clients[0]?.releases).toEqual([undefined]);
  });

  it("does not treat sibling concurrent calls as nested", async () => {
    await Promise.all([
      pool.runWithMainDbClient(CFG, CALL, async () => "a"),
      pool.runWithMainDbClient(CFG, CALL, async () => "b"),
    ]);
    for (const client of state.clients) expect(client.releases).toHaveLength(1);
  });

  it("retires the pool and builds a new one when the port or password changes", async () => {
    await pool.runWithMainDbClient(CFG, CALL, async () => "a");
    const first = lastPool();
    await pool.runWithMainDbClient({ ...CFG, port: 27433 }, CALL, async () => "b");
    expect(first.ended).toBe(true);
    expect(state.pools).toHaveLength(2);
    await pool.runWithMainDbClient({ ...CFG, port: 27433, password: "rotated" }, CALL, async () => "c");
    expect(state.pools).toHaveLength(3);
    expect(state.pools[1]?.ended).toBe(true);
  });

  it("retires the pool on every DB connection handoff (compose up after a restart, compose down)", async () => {
    await pool.runWithMainDbClient(CFG, CALL, async () => "a");
    const first = lastPool();
    setDbConnection({ pgPort: 27432, pgPasswordPath: "/secret" });
    expect(first.ended).toBe(true);
    await pool.runWithMainDbClient(CFG, CALL, async () => "b");
    expect(state.pools).toHaveLength(2);
    setDbConnection(null);
    expect(lastPool().ended).toBe(true);
  });

  it("closes the pool on quit and lets a later call build a new one", async () => {
    await pool.runWithMainDbClient(CFG, CALL, async () => "a");
    await pool.closeMainIpcPgPool();
    expect(lastPool().ended).toBe(true);
    expect(pool.mainIpcPgPoolStats().total).toBe(0);
    await pool.closeMainIpcPgPool();
    await pool.runWithMainDbClient(CFG, CALL, async () => "b");
    expect(state.pools).toHaveLength(2);
  });
});
