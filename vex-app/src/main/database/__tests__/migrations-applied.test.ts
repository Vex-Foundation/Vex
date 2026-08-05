/**
 * A1 — the ordering fact the engine workers' start gate reads.
 *
 * Only a COMPLETED migration run may open the gate. A run that failed leaves it
 * shut, because the live defect was workers issuing SQL against a schema that
 * was not at this build's version yet (`column "evm_claim_lease_until" does not
 * exist`, twice a second, for 19 seconds).
 *
 * Each case re-imports both modules through `vi.resetModules()`: the latch is
 * deliberately process-wide, so sharing one instance across cases would let an
 * earlier success decide a later assertion.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBuildPoolConfig = vi.fn();
const mockRunMigrationsWithProgress = vi.fn();

class MockPool {
  end = async (): Promise<void> => {};
  on = (): void => {};
}

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("pg", () => ({ default: { Pool: MockPool } }));
vi.mock("../db-config.js", () => ({ buildPoolConfig: () => mockBuildPoolConfig() }));
vi.mock("../progress-bus.js", () => ({
  migrationProgressBus: { reset: vi.fn(), emit: vi.fn() },
}));
vi.mock("@vex-lib/db/migrate-runner.js", async () => {
  const actual = await vi.importActual<typeof import("@vex-lib/db/migrate-runner.js")>(
    "@vex-lib/db/migrate-runner.js",
  );
  return { ...actual, runMigrationsWithProgress: (o: unknown) => mockRunMigrationsWithProgress(o) };
});
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const VALID_CONFIG = {
  host: "127.0.0.1",
  port: 27432,
  database: "vex",
  user: "vex",
  password: "secret",
};

async function freshModules(): Promise<{
  runMigrationsForIpc: typeof import("../migrate-runner.js").runMigrationsForIpc;
  migrationsApplied: typeof import("../migrations-applied.js").migrationsApplied;
}> {
  vi.resetModules();
  const { runMigrationsForIpc } = await import("../migrate-runner.js");
  const { migrationsApplied } = await import("../migrations-applied.js");
  return { runMigrationsForIpc, migrationsApplied };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildPoolConfig.mockResolvedValue(VALID_CONFIG);
});

describe("the migrations-applied gate", () => {
  it("is SHUT before any migration run", async () => {
    const { migrationsApplied } = await freshModules();
    expect(migrationsApplied()).toBe(false);
  });

  it("opens once a run applies migrations", async () => {
    const { runMigrationsForIpc, migrationsApplied } = await freshModules();
    mockRunMigrationsWithProgress.mockResolvedValue({ applied: 3, files: ["a", "b", "c"] });

    await runMigrationsForIpc();

    expect(migrationsApplied()).toBe(true);
  });

  it("opens on a no-op run too — nothing left to apply means the schema is current", async () => {
    const { runMigrationsForIpc, migrationsApplied } = await freshModules();
    mockRunMigrationsWithProgress.mockResolvedValue({ applied: 0, files: [] });

    await runMigrationsForIpc();

    expect(migrationsApplied()).toBe(true);
  });

  it("stays SHUT when the run fails — the workers keep waiting and say so", async () => {
    const { runMigrationsForIpc, migrationsApplied } = await freshModules();
    mockRunMigrationsWithProgress.mockRejectedValue(new Error("relation does not exist"));

    const result = await runMigrationsForIpc();

    expect(result.kind).toBe("failed");
    expect(migrationsApplied()).toBe(false);
  });

  it("stays SHUT when compose never produced a pool config", async () => {
    const { runMigrationsForIpc, migrationsApplied } = await freshModules();
    mockBuildPoolConfig.mockResolvedValue(null);

    await runMigrationsForIpc();

    expect(migrationsApplied()).toBe(false);
  });
});
