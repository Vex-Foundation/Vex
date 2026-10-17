/**
 * Unit tests for the vex-app migration runner wrapper. Mocks pg, the
 * shared `runMigrationsWithProgress`, and `buildPoolConfig` so the
 * test focuses on:
 *   - mapping shared-runner outputs to MigrateRunResult
 *   - MigrationError → failed{failedAt} translation
 *   - dedicated Pool lifecycle (end called on every path)
 *   - progress bus reset + ts-tagged forwarding
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPoolEnd = vi.fn(async () => {});
const mockPoolOn = vi.fn();
const mockBuildPoolConfig = vi.fn();
const mockRunMigrationsWithProgress = vi.fn();
const mockProgressBusReset = vi.fn();
const mockProgressBusEmit = vi.fn();
const PoolCtor = vi.fn();

class MockPool {
  end = mockPoolEnd;
  on = mockPoolOn;
  constructor(config: unknown) {
    PoolCtor(config);
  }
}

vi.mock("electron", () => ({
  app: { isPackaged: false },
}));

vi.mock("pg", () => ({
  default: { Pool: MockPool },
}));

vi.mock("../db-config.js", () => ({
  buildPoolConfig: () => mockBuildPoolConfig(),
}));

vi.mock("../progress-bus.js", () => ({
  migrationProgressBus: {
    reset: () => mockProgressBusReset(),
    emit: (e: unknown) => mockProgressBusEmit(e),
  },
}));

vi.mock("@vex-lib/db/migrate-runner.js", async () => {
  const actual = await vi.importActual<
    typeof import("@vex-lib/db/migrate-runner.js")
  >("@vex-lib/db/migrate-runner.js");
  return {
    ...actual,
    runMigrationsWithProgress: (opts: unknown) =>
      mockRunMigrationsWithProgress(opts),
  };
});

vi.mock("../../logger/index.js", () => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const { runMigrationsForIpc } = await import("../migrate-runner.js");
const { MigrationError } = await import("@vex-lib/db/migrate-runner.js");

const VALID_CONFIG = {
  host: "127.0.0.1",
  port: 27432,
  database: "vex",
  user: "vex",
  password: "secret",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPoolEnd.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runMigrationsForIpc", () => {
  it("returns failed when pool config unavailable (no runtime started)", async () => {
    mockBuildPoolConfig.mockResolvedValue(null);

    const result = await runMigrationsForIpc();

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.failedAt).toBeNull();
      expect(result.message).toMatch(/local runtime/i);
    }
    expect(mockRunMigrationsWithProgress).not.toHaveBeenCalled();
    expect(PoolCtor).not.toHaveBeenCalled();
  });

  it("returns applied with file list when migrations succeed", async () => {
    mockBuildPoolConfig.mockResolvedValue(VALID_CONFIG);
    mockRunMigrationsWithProgress.mockResolvedValue({
      applied: 2,
      files: ["001_a.sql", "002_b.sql"],
    });

    const result = await runMigrationsForIpc();

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.applied).toBe(2);
      expect(result.files).toEqual(["001_a.sql", "002_b.sql"]);
      expect(result.message).toMatch(/Applied 2/);
    }
    expect(mockProgressBusReset).toHaveBeenCalledTimes(1);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it("returns noop when applied count is 0", async () => {
    mockBuildPoolConfig.mockResolvedValue(VALID_CONFIG);
    mockRunMigrationsWithProgress.mockResolvedValue({
      applied: 0,
      files: [],
    });

    const result = await runMigrationsForIpc();

    expect(result.kind).toBe("noop");
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it("maps MigrationError to failed{failedAt}", async () => {
    mockBuildPoolConfig.mockResolvedValue(VALID_CONFIG);
    mockRunMigrationsWithProgress.mockRejectedValue(
      new MigrationError(7, "007_thing.sql", new Error("syntax error"))
    );

    const result = await runMigrationsForIpc();

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.failedAt).toEqual({ version: 7, file: "007_thing.sql" });
      expect(result.message).toContain("007_thing.sql");
    }
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it("maps generic Error to failed with null failedAt", async () => {
    mockBuildPoolConfig.mockResolvedValue(VALID_CONFIG);
    mockRunMigrationsWithProgress.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await runMigrationsForIpc();

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.failedAt).toBeNull();
      expect(result.message).toBe("ECONNREFUSED");
    }
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it("ends the pool even when the runner throws", async () => {
    mockBuildPoolConfig.mockResolvedValue(VALID_CONFIG);
    mockRunMigrationsWithProgress.mockRejectedValue(new Error("boom"));
    await runMigrationsForIpc();
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it("forwards progress events through the bus with ts attached", async () => {
    mockBuildPoolConfig.mockResolvedValue(VALID_CONFIG);
    let captured: ((e: unknown) => void) | null = null;
    mockRunMigrationsWithProgress.mockImplementation(
      (opts: { onProgress?: (e: unknown) => void }) => {
        captured = opts.onProgress ?? null;
        return Promise.resolve({ applied: 0, files: [] });
      }
    );

    await runMigrationsForIpc();
    expect(captured).not.toBeNull();
    captured?.({
      phase: "planned",
      index: 0,
      total: 3,
      version: 0,
      file: "",
    });

    expect(mockProgressBusEmit).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "planned", total: 3 })
    );
    const emitted = mockProgressBusEmit.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(emitted).toHaveProperty("ts");
    expect(typeof emitted["ts"]).toBe("number");
  });

  it("constructs a single-connection pool with passed credentials", async () => {
    mockBuildPoolConfig.mockResolvedValue(VALID_CONFIG);
    mockRunMigrationsWithProgress.mockResolvedValue({
      applied: 0,
      files: [],
    });
    await runMigrationsForIpc();
    expect(PoolCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 27432,
        database: "vex",
        user: "vex",
        password: "secret",
        max: 1,
      })
    );
  });
});
