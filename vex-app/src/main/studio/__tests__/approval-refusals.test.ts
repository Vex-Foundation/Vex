import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureEngineDbUrl: vi.fn(),
  refusePendingStudioIntents: vi.fn(),
  announceStudioRefusals: vi.fn(),
  markPending: vi.fn(),
  readPending: vi.fn(),
  clearPending: vi.fn(),
}));

vi.mock("../../ipc/runtime/_ensure-engine-db-url.js", () => ({
  ensureEngineDbUrl: mocks.ensureEngineDbUrl,
}));
vi.mock("../approval-broker.js", () => ({
  studioCorrelationId: () => "studio-test-correlation",
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
