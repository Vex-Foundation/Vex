import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireValue } from "../../helpers/require-value.js";

// Capture `logger.warn` so we can assert the missing-VEX_DB_URL warning never
// carries credential material. The mock is hoisted by vitest before the client
// module (which imports `@utils/logger.js`) is evaluated.
const warnMock = vi.fn();
const errorMock = vi.fn();
const infoMock = vi.fn();
const debugMock = vi.fn();
vi.mock("@utils/logger.js", () => ({
  default: {
    warn: warnMock,
    error: errorMock,
    info: infoMock,
    debug: debugMock,
  },
}));

// `withTransaction` resolves the pool client through `getPool().connect()`.
// The mock returns a fake client whose `.query()` we observe and whose
// `.release()` we assert always fires.

interface FakeClient {
  readonly query: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
}

let currentClient: FakeClient | null = null;
const connectMock = vi.fn(async () => {
  currentClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  return currentClient;
});

vi.mock("pg", () => {
  class FakePool {
    connect() {
      return connectMock();
    }
    on() {
      return this;
    }
  }
  return { default: { Pool: FakePool } };
});

// Force a clean module + env BEFORE importing client.
process.env.VEX_DB_URL = "postgresql://test:test@localhost/test";

const { withTransaction } = await import(
  "../../../vex-agent/db/client.js"
);

describe("withTransaction", () => {
  it("commits on success and releases the client", async () => {
    connectMock.mockClear();

    const result = await withTransaction(async (client) => {
      await client.query("SELECT 1");
      return 42;
    });

    expect(result).toBe(42);
    const client = currentClient!;
    expect(connectMock).toHaveBeenCalledTimes(1);
    // Calls in order: BEGIN, SELECT 1, COMMIT
    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(client.query.mock.calls[1]?.[0]).toBe("SELECT 1");
    expect(client.query.mock.calls[2]?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and rethrows when the callback throws", async () => {
    connectMock.mockClear();

    await expect(
      withTransaction(async (client) => {
        await client.query("SELECT 1");
        throw new Error("inner failure");
      }),
    ).rejects.toThrow("inner failure");

    const client = currentClient!;
    const queries = client.query.mock.calls.map((c) => c[0]);
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("does not mask the original throw when ROLLBACK itself fails", async () => {
    connectMock.mockClear();

    await expect(
      withTransaction(async (client) => {
        await client.query("BEGIN-ish");
        requireValue(currentClient).query.mockRejectedValueOnce(new Error("rollback failed"));
        throw new Error("original failure");
      }),
    ).rejects.toThrow("original failure");

    const client = currentClient!;
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// ── B-008: DB fallback URL must not leak credentials into logs ─────────
//
// When VEX_DB_URL is unset, `getPool()` falls back to a dev connection string
// that embeds the `vex:vex` credential. The emitted warning must NOT contain
// that credential, the credential-bearing URL, or any password — only a
// redacted host/port/db descriptor is allowed. These tests pin that invariant.
describe("getPool fallback-url warning (secret non-exposure)", () => {
  const savedUrl = process.env.VEX_DB_URL;

  beforeEach(() => {
    warnMock.mockClear();
    // Re-evaluate the client module with no VEX_DB_URL so the lazy `pool`
    // singleton is freshly nulled and the fallback branch executes once.
    vi.resetModules();
    delete process.env.VEX_DB_URL;
  });

  afterEach(() => {
    if (savedUrl === undefined) {
      delete process.env.VEX_DB_URL;
    } else {
      process.env.VEX_DB_URL = savedUrl;
    }
  });

  it("warns once with a redacted descriptor and no credential material", async () => {
    const { getPool } = await import("../../../vex-agent/db/client.js");

    getPool();

    expect(warnMock).toHaveBeenCalledTimes(1);
    const [event, meta] = warnMock.mock.calls[0]!;
    expect(event).toBe("vex-db.pool.using_fallback_url");

    // Serialize the entire warning payload (event + meta) and assert that no
    // credential material survives anywhere in it. This guards the whole
    // structured-log surface, not just one field.
    const serialized = JSON.stringify({ event, meta });

    expect(serialized).not.toContain("vex:vex");
    expect(serialized).not.toContain("password");
    // No `user:pass@` userinfo component (the credential-bearing URL form).
    expect(serialized).not.toMatch(/\/\/[^/@\s"]+:[^/@\s"]+@/);
    // Defensive: the raw fallback connection string must not appear verbatim.
    expect(serialized).not.toContain(
      "postgresql://vex:vex@localhost:5777/vex_test",
    );

    // A redacted host/port/db descriptor MAY appear and helps operators.
    expect(serialized).toContain("localhost:5777/vex_test");
  });

  it("does not warn when VEX_DB_URL is set", async () => {
    process.env.VEX_DB_URL = "postgresql://test:test@localhost/test";
    const { getPool } = await import("../../../vex-agent/db/client.js");

    getPool();

    expect(warnMock).not.toHaveBeenCalled();
  });
});
