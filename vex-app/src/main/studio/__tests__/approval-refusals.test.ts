import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  ensureEngineDbUrl: vi.fn(),
  refusePendingStudioIntents: vi.fn(),
  announceStudioRefusals: vi.fn(),
  markPending: vi.fn(),
  readPending: vi.fn(),
  clearPending: vi.fn(),
}));

vi.mock("../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: mocks.ensureEngineDbUrl,
}));
vi.mock("../approval-broker.js", () => ({
  studioCorrelationId: () => "studio-test-correlation",
}));
vi.mock("../../logger/index.js", () => ({
  log: {
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (
    run: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>,
  ) => run({ query: vi.fn() }),
}));
vi.mock("@vex-agent/engine/core/approval-runtime.js", () => ({
  refusePendingStudioIntents: mocks.refusePendingStudioIntents,
  announceStudioRefusals: mocks.announceStudioRefusals,
}));
vi.mock("@vex-agent/db/repos/studio-runtime-gate.js", () => ({
  markStudioPendingGlobalRefusalWith: mocks.markPending,
  readStudioPendingGlobalRefusalWith: mocks.readPending,
  clearStudioPendingGlobalRefusalWith: mocks.clearPending,
}));

const {
  refuseAllPendingStudioIntents,
  repairPendingStudioRefusal,
} = await import("../approval-refusals.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureEngineDbUrl.mockResolvedValue({ ok: true });
  mocks.refusePendingStudioIntents.mockResolvedValue([
    { approvalId: "approval-1", projectId: "project-1" },
  ]);
  mocks.markPending.mockResolvedValue(undefined);
  mocks.readPending.mockResolvedValue("lock");
  mocks.clearPending.mockResolvedValue(true);
});

/**
 * WHAT THE BOOT LOG SAYS ABOUT A REPAIR THAT COULD NOT RUN YET.
 *
 * On a fresh database this repair runs before migrations exist, throws
 * `undefined_table`, and is repaired by the retry seconds later. It logged
 * "startup repair failed" for that ordinary sequence, which is how a warning
 * that matters becomes one people scroll past. Both directions are asserted:
 * the pre-migration cause is INFO and says it is deferred, and a real fault
 * still warns and still carries its cause.
 */
describe("startup repair classification", () => {
  /** Postgres reports `undefined_table` with this code, in every locale. */
  class UndefinedTableError extends Error {
    readonly code = "42P01";
  }

  it("logs the PRE-MIGRATION state as deferred, not as a failure", async () => {
    mocks.readPending.mockRejectedValue(
      new UndefinedTableError('relation "studio_runtime_gate" does not exist'),
    );

    // Still `false`: nothing was repaired. The classification is about what the
    // line SAYS, never about claiming work that did not happen.
    await expect(repairPendingStudioRefusal()).resolves.toBe(false);
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.announceStudioRefusals).not.toHaveBeenCalled();
    const line = String(mocks.logInfo.mock.calls.at(-1)?.[0]);
    expect(line).toContain("deferred");
    expect(line).not.toContain("failed");
  });

  it("still WARNS, with the cause, for a real failure", async () => {
    const cause = new Error("connection terminated unexpectedly");
    mocks.readPending.mockRejectedValue(cause);

    await expect(repairPendingStudioRefusal()).resolves.toBe(false);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(String(mocks.logWarn.mock.calls[0]?.[0])).toContain(
      "startup repair failed",
    );
    expect(mocks.logWarn.mock.calls[0]?.[1]).toBe(cause);
  });

  it("does not mistake an ordinary error that merely mentions the relation", async () => {
    // Message text is not the discriminator: only Postgres's own code is.
    mocks.readPending.mockRejectedValue(
      new Error('relation "studio_runtime_gate" does not exist'),
    );

    await expect(repairPendingStudioRefusal()).resolves.toBe(false);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });
});

describe("global Studio refusal durability", () => {
  it("marks, refuses and clears one typed obligation in one transaction", async () => {
    await expect(refuseAllPendingStudioIntents("vex_quit")).resolves.toBe(1);

    expect(mocks.markPending).toHaveBeenCalledWith(
      expect.anything(),
      "vex_quit",
    );
    expect(mocks.refusePendingStudioIntents).toHaveBeenCalledWith(
      expect.anything(),
      { all: true },
      "vex_quit",
    );
    expect(mocks.clearPending).toHaveBeenCalledWith(
      expect.anything(),
      "vex_quit",
    );
    expect(mocks.announceStudioRefusals).toHaveBeenCalledTimes(1);
  });

  it("repairs the durable cause before startup can become ready", async () => {
    await expect(repairPendingStudioRefusal()).resolves.toBe(true);

    expect(mocks.readPending).toHaveBeenCalledTimes(1);
    expect(mocks.refusePendingStudioIntents).toHaveBeenCalledWith(
      expect.anything(),
      { all: true },
      "lock",
    );
    expect(mocks.clearPending).toHaveBeenCalledWith(
      expect.anything(),
      "lock",
    );
    expect(mocks.announceStudioRefusals).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the durable obligation cannot be cleared", async () => {
    mocks.clearPending.mockResolvedValue(false);

    await expect(repairPendingStudioRefusal()).resolves.toBe(false);
    expect(mocks.announceStudioRefusals).not.toHaveBeenCalled();
  });

  it("refuses orphaned pending calls as quit even when no marker could persist", async () => {
    mocks.readPending.mockResolvedValue(null);

    await expect(repairPendingStudioRefusal()).resolves.toBe(true);
    expect(mocks.refusePendingStudioIntents).toHaveBeenCalledWith(
      expect.anything(),
      { all: true },
      "vex_quit",
    );
    expect(mocks.clearPending).not.toHaveBeenCalled();
  });
});
