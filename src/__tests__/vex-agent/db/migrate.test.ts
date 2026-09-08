import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mockGetVexAgentMigrationsDir = vi.fn();
const mockPoolQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockRelease = vi.fn();

vi.mock("@utils/package-assets.js", () => ({
  getVexAgentMigrationsDir: () => mockGetVexAgentMigrationsDir(),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  getPool: () => ({
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: async () => ({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: mockRelease,
    }),
  }),
}));

vi.mock("@utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

const { runMigrations } = await import("@vex-agent/db/migrate.js");

let testDir = "";

beforeEach(() => {
  vi.clearAllMocks();
  testDir = mkdtempSync(join(tmpdir(), "vex-migrate-"));
  // Default client.query: every call returns `undefined` except the ledger
  // SELECT, which returns an EMPTY row set - a fresh database - so the shared
  // runner treats every file as pending. The runner reads the whole ledger
  // rather than its maximum because a maximum cannot distinguish a version that
  // was never applied from one that does not exist yet (see its
  // `MigrationLedgerGapError`).
  mockClientQuery.mockImplementation(async (sql: unknown) => {
    if (
      typeof sql === "string" &&
      /SELECT version\s+FROM schema_version/i.test(sql)
    ) {
      return { rows: [] };
    }
    // The branch-era discriminator, which runs before the ledger read: no
    // `lighter_%` table and no pre-release lineage ledger table, i.e. a fresh
    // database the runner may migrate.
    if (typeof sql === "string" && /FROM pg_class/i.test(sql)) {
      return { rows: [] };
    }
    return undefined;
  });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("vex-agent/db/migrate", () => {
  it("reads migrations from the resolved asset directory", async () => {
    writeFileSync(
      join(testDir, "001_initial.sql"),
      "CREATE TABLE demo(id integer);"
    );
    mockGetVexAgentMigrationsDir.mockReturnValue(testDir);

    await runMigrations();

    expect(mockGetVexAgentMigrationsDir).toHaveBeenCalledTimes(1);
    // Shared runner now drives the session - verify the migration SQL
    // and the surrounding transaction shape are issued through client.query.
    expect(mockClientQuery).toHaveBeenCalledWith("BEGIN");
    expect(mockClientQuery).toHaveBeenCalledWith(
      "CREATE TABLE demo(id integer);"
    );
    expect(mockClientQuery).toHaveBeenCalledWith(
      "INSERT INTO schema_version (version) VALUES ($1)",
      [1]
    );
    expect(mockClientQuery).toHaveBeenCalledWith("COMMIT");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("acquires + releases the advisory lock for every run", async () => {
    mockGetVexAgentMigrationsDir.mockReturnValue(testDir);
    await runMigrations();
    const lockCall = mockClientQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        /pg_advisory_lock\(\$1::bigint\)/.test(c[0] as string)
    );
    const unlockCall = mockClientQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        /pg_advisory_unlock\(\$1::bigint\)/.test(c[0] as string)
    );
    expect(lockCall).toBeDefined();
    expect(unlockCall).toBeDefined();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
