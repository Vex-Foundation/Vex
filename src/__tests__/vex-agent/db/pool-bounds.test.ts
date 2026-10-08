/**
 * Kairos S-4 - engine DB bounds and the reserved control pool.
 *
 * Pins, without a database:
 *   - the main pool is built with statement / idle-in-transaction / connect
 *     bounds from AGENT_DB_* (defaults when unset);
 *   - the raised cap for known long statements is a SET LOCAL inside the
 *     transaction, right after BEGIN;
 *   - the control pool is a SEPARATE pool (own size, own clients) that a
 *     saturated main pool cannot starve at the client-pool level;
 *   - an invalid bound is logged by key and reason only and never disables
 *     the bound.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";

const warnMock = vi.fn();
vi.mock("@utils/logger.js", () => ({
  default: { warn: warnMock, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

interface FakeClient {
  readonly statements: string[];
  query(sql: string): Promise<{ rows: never[]; rowCount: number }>;
  release(): void;
  released: number;
}

class FakePool {
  static instances: FakePool[] = [];
  readonly config: pg.PoolConfig;
  readonly clients: FakeClient[] = [];
  /** When set, connect() never settles - a saturated pool. */
  saturated = false;
  ended = false;
  constructor(config: pg.PoolConfig) {
    this.config = config;
    FakePool.instances.push(this);
  }
  on(): this {
    return this;
  }
  async end(): Promise<void> {
    this.ended = true;
  }
  connect(): Promise<FakeClient> {
    if (this.saturated) return new Promise<FakeClient>(() => undefined);
    const statements: string[] = [];
    const client: FakeClient = {
      statements,
      released: 0,
      async query(sql: string) {
        statements.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release() {
        client.released += 1;
      },
    };
    this.clients.push(client);
    return Promise.resolve(client);
  }
}

vi.mock("pg", () => ({ default: { Pool: FakePool } }));

const DB_KEYS = [
  "AGENT_DB_STATEMENT_TIMEOUT_MS",
  "AGENT_DB_CONNECTION_TIMEOUT_MS",
  "AGENT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS",
  "AGENT_DB_LONG_STATEMENT_TIMEOUT_MS",
  "AGENT_DB_CONTROL_POOL_MAX",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules();
  FakePool.instances = [];
  warnMock.mockClear();
  saved.VEX_DB_URL = process.env.VEX_DB_URL;
  process.env.VEX_DB_URL = "postgresql://test:test@localhost/test";
  for (const key of DB_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function loadModules() {
  const client = await import("../../../vex-agent/db/client.js");
  const control = await import("../../../vex-agent/db/control-pool.js");
  return { client, control };
}

function onlyPool(kindName: string): FakePool {
  const match = FakePool.instances.filter((p) => p.config.application_name === kindName);
  expect(match).toHaveLength(1);
  const [pool] = match;
  if (pool === undefined) throw new Error(`no ${kindName} pool`);
  return pool;
}

describe("main pool bounds", () => {
  it("applies the default statement, idle-in-transaction and connect bounds", async () => {
    const { client } = await loadModules();
    client.getPool();

    const main = onlyPool("vex-agent");
    expect(main.config).toMatchObject({
      connectionString: "postgresql://test:test@localhost/test",
      max: 10,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 60_000,
      connectionTimeoutMillis: 10_000,
    });
  });

  it("takes the bounds from AGENT_DB_* when set", async () => {
    process.env.AGENT_DB_STATEMENT_TIMEOUT_MS = "15000";
    process.env.AGENT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = "45000";
    process.env.AGENT_DB_CONNECTION_TIMEOUT_MS = "5000";
    const { client } = await loadModules();
    client.getPool();

    expect(onlyPool("vex-agent").config).toMatchObject({
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 45_000,
      connectionTimeoutMillis: 5_000,
    });
  });

  it("an invalid bound keeps the default and logs key + reason only", async () => {
    process.env.AGENT_DB_STATEMENT_TIMEOUT_MS = "0"; // below min: cannot disable
    process.env.AGENT_DB_CONNECTION_TIMEOUT_MS = "soon";
    const { client } = await loadModules();
    client.getPool();

    expect(onlyPool("vex-agent").config).toMatchObject({
      statement_timeout: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    const events = warnMock.mock.calls.filter(
      (call) => call[0] === "vex-db.pool.bound_invalid_using_default",
    );
    expect(events.map((call) => call[1])).toEqual([
      { key: "AGENT_DB_STATEMENT_TIMEOUT_MS", reason: "out_of_range" },
      { key: "AGENT_DB_CONNECTION_TIMEOUT_MS", reason: "not_a_number" },
    ]);
    expect(JSON.stringify(events)).not.toContain("soon");
  });
});

describe("long-statement override", () => {
  it("withLongStatementTransaction issues SET LOCAL right after BEGIN", async () => {
    const { client } = await loadModules();
    const result = await client.withLongStatementTransaction(async (tx) => {
      await tx.query("INSERT INTO messages_archive SELECT 1");
      return "done";
    });

    expect(result).toBe("done");
    const [tx] = onlyPool("vex-agent").clients;
    expect(tx?.statements).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout = 300000",
      "INSERT INTO messages_archive SELECT 1",
      "COMMIT",
    ]);
  });

  it("uses AGENT_DB_LONG_STATEMENT_TIMEOUT_MS and never goes below the ordinary cap", async () => {
    process.env.AGENT_DB_STATEMENT_TIMEOUT_MS = "60000";
    process.env.AGENT_DB_LONG_STATEMENT_TIMEOUT_MS = "20000";
    const { client } = await loadModules();
    const pool = client.getPool();
    const tx = await pool.connect();
    await client.setLocalLongStatementTimeout(tx);

    const [fake] = onlyPool("vex-agent").clients;
    expect(fake?.statements).toEqual(["SET LOCAL statement_timeout = 60000"]);
  });
});

describe("reserved control pool", () => {
  it("is a separate, small pool carrying the same server-side bounds", async () => {
    const { client, control } = await loadModules();
    const main = client.getPool();
    const reserved = control.getControlPool();

    expect(reserved).not.toBe(main);
    expect(onlyPool("vex-agent-control").config).toMatchObject({
      max: 2,
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 60_000,
      connectionTimeoutMillis: 10_000,
    });
  });

  it("AGENT_DB_CONTROL_POOL_MAX sizes it", async () => {
    process.env.AGENT_DB_CONTROL_POOL_MAX = "3";
    const { control } = await loadModules();
    control.getControlPool();
    expect(onlyPool("vex-agent-control").config.max).toBe(3);
  });

  it("still hands out a client while the main pool is saturated", async () => {
    const { client, control } = await loadModules();
    client.getPool();
    onlyPool("vex-agent").saturated = true;

    // A main-pool transaction now waits forever at connect()...
    let mainSettled = false;
    void client.withTransaction(async () => undefined).finally(() => {
      mainSettled = true;
    });

    // ...while a control write goes through on its own pool.
    const outcome = await control.withControlTransaction(async (tx) => {
      await tx.query("UPDATE runner_leases SET heartbeat_at = NOW()");
      return "renewed";
    });

    expect(outcome).toBe("renewed");
    expect(mainSettled).toBe(false);
    const [ctl] = onlyPool("vex-agent-control").clients;
    expect(ctl?.statements).toEqual([
      "BEGIN",
      "UPDATE runner_leases SET heartbeat_at = NOW()",
      "COMMIT",
    ]);
    expect(ctl?.released).toBe(1);
  });

  it("withControlTransaction rolls back, rethrows and releases on failure", async () => {
    const { control } = await loadModules();
    await expect(
      control.withControlTransaction(async () => {
        throw new Error("stop write failed");
      }),
    ).rejects.toThrow("stop write failed");

    const [ctl] = onlyPool("vex-agent-control").clients;
    expect(ctl?.statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(ctl?.released).toBe(1);
  });

  it("withControlClient releases the client and runs no transaction", async () => {
    const { control } = await loadModules();
    await control.withControlClient(async (c) => {
      await c.query("SELECT 1");
    });
    const [ctl] = onlyPool("vex-agent-control").clients;
    expect(ctl?.statements).toEqual(["SELECT 1"]);
    expect(ctl?.released).toBe(1);
  });

  it("closePool drains both pools", async () => {
    const { client, control } = await loadModules();
    client.getPool();
    control.getControlPool();
    await client.closePool();

    expect(onlyPool("vex-agent").ended).toBe(true);
    expect(onlyPool("vex-agent-control").ended).toBe(true);
  });
});
