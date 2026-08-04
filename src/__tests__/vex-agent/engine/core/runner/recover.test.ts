import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetActiveRunBySession = vi.fn();
const mockGetLatestFailedRunBySession = vi.fn();
const mockCreateRun = vi.fn();
const mockGetRun = vi.fn();
const mockGetMission = vi.fn();
const mockSetMissionStatus = vi.fn();
const mockSetApprovedAt = vi.fn();
const mockAddEngineMessage = vi.fn();
const mockResumePreparedMissionRun = vi.fn();
const mockResolveProvider = vi.fn();
const mockGetSession = vi.fn();

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getActiveRunBySession: (...args: unknown[]) => mockGetActiveRunBySession(...args),
  getLatestFailedRunBySession: (...args: unknown[]) => mockGetLatestFailedRunBySession(...args),
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  getRun: (...args: unknown[]) => mockGetRun(...args),
}));

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  getMission: (...args: unknown[]) => mockGetMission(...args),
  setStatus: (...args: unknown[]) => mockSetMissionStatus(...args),
  setApprovedAt: (...args: unknown[]) => mockSetApprovedAt(...args),
}));

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

vi.mock("@vex-agent/inference/registry.js", () => ({
  resolveProvider: (...args: unknown[]) => mockResolveProvider(...args),
}));

vi.mock("@vex-agent/db/repos/messages.js", () => ({
  // Puzzle 04 phase 5 introduced MESSAGE_DB_COLUMNS as a shared
  // projection constant; recover doesn't touch the archive path
  // directly but the import chain pulls sessions.ts which references
  // it. Provide a stub so the module loads cleanly under vi.mock.
  MESSAGE_DB_COLUMNS: [],
  addMessageReturningId: vi.fn().mockResolvedValue({
    id: 1, role: "system", content: "", timestamp: new Date().toISOString(),
  }),
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: vi.fn(),
  appendEngineMessage: (...args: unknown[]) => mockAddEngineMessage(...args),
  emitTranscriptAppend: vi.fn(),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  getPool: vi.fn().mockReturnValue({
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }),
  }),
  queryWith: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn().mockResolvedValue(null),
  executeWith: vi.fn().mockResolvedValue(1),
  withTransaction: vi.fn().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => {
    const stubClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    return await fn(stubClient);
  }),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimSessionLease: vi.fn().mockResolvedValue({
    outcome: "claimed",
    lease: {
      sessionId: "s",
      missionRunId: null,
      ownerId: "test-owner",
      processKind: "electron_main",
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(),
    },
  }),
  // The run-creation transaction takes the SESSION CONTROL LOCK first, so run
  // creation and the operator's Stop are strictly ordered, then consults the
  // session-scoped stop gate. `clear` here; the refusal is pinned in
  // `integration/engine/mission-start-stop-first.int.test.ts`.
  acquireSessionControlLock: vi.fn().mockResolvedValue(undefined),
  gateOnOperatorStopWithClient: vi.fn().mockResolvedValue({ kind: "clear" }),
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: vi.fn().mockReturnValue({
    lease: {
      sessionId: "s",
      missionRunId: null,
      ownerId: "test-owner",
      processKind: "electron_main",
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(),
    },
    ownerId: "test-owner",
    release: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: vi.fn().mockResolvedValue(undefined),
}));

// Puzzle 04 phase 6: `runPreparedMissionRecover` delegates the actual
// turn-loop entry to `resumePreparedMissionRun` (extracted from the
// old `resumeMissionRun`). Mock the extracted helper to assert that
// recover wires the prepared context correctly without spinning the
// real turn loop.
vi.mock("../../../../../vex-agent/engine/core/runner/mission-run.js", () => ({
  resumePreparedMissionRun: (...args: unknown[]) =>
    mockResumePreparedMissionRun(...args),
}));

const { recoverFailedMissionRun } = await import(
  "../../../../../vex-agent/engine/core/runner/recover.js"
);

const snapshot = {
  version: 1,
  capturedAt: "2026-05-04T08:00:00.000Z",
  missionPromptContext: "# Mission: recovered",
  frozenMission: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveRunBySession.mockResolvedValue(null);
  mockGetLatestFailedRunBySession.mockResolvedValue({
    id: "failed-run",
    missionId: "mission-1",
    sessionId: "session-1",
    status: "failed",
    contractSnapshotJson: snapshot,
  });
  mockGetMission.mockResolvedValue({ id: "mission-1" });
  mockGetSession.mockResolvedValue({
    id: "session-1",
    mode: "mission",
    permission: "restricted",
    tokenCount: 0,
  });
  mockResolveProvider.mockResolvedValue({
    loadConfig: vi.fn().mockResolvedValue({ contextLimit: 200_000 }),
  });
  mockCreateRun.mockResolvedValue(undefined);
  // Phase 6 — `prepareMissionRecover` reads the freshly-created run
  // back inside the same atomic tx to populate the prepared context.
  mockGetRun.mockResolvedValue({
    id: "run-new",
    missionId: "mission-1",
    sessionId: "session-1",
    status: "running",
    iterationCount: 0,
    contractSnapshotJson: snapshot,
  });
  mockSetMissionStatus.mockResolvedValue(undefined);
  mockSetApprovedAt.mockResolvedValue(undefined);
  mockAddEngineMessage.mockResolvedValue(undefined);
  mockResumePreparedMissionRun.mockResolvedValue({
    text: "recovered",
    toolCallsMade: 0,
    pendingApprovals: [],
    stopReason: null,
    missionStatus: "running",
  });
});

describe("recoverFailedMissionRun", () => {
  it("creates a new run from the failed run snapshot and leaves failed audit intact", async () => {
    const result = await recoverFailedMissionRun("session-1");

    expect(result.text).toBe("recovered");
    expect(mockSetMissionStatus).toHaveBeenCalledWith(
      "mission-1",
      "running",
      expect.anything(),
    );
    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.stringMatching(/^run-/),
      "mission-1",
      "session-1",
      {
        contractSnapshotJson: snapshot,
        recoveredFromRunId: "failed-run",
      },
      expect.anything(),
    );
    expect(mockAddEngineMessage).toHaveBeenCalledWith(
      "session-1",
      expect.stringContaining("mission_recovered"),
      expect.objectContaining({
        messageType: "mission_recovered",
        payload: expect.objectContaining({ recoveredFromRunId: "failed-run" }),
      }),
    );
    expect(mockResumePreparedMissionRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: expect.stringMatching(/^run-/) }),
    );
  });

  it("refuses recovery while a run is still active", async () => {
    mockGetActiveRunBySession.mockResolvedValueOnce({ id: "run-active", status: "running" });

    await expect(recoverFailedMissionRun("session-1")).rejects.toThrow(/still active/);
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("refuses old failed runs without a contract snapshot", async () => {
    mockGetLatestFailedRunBySession.mockResolvedValueOnce({
      id: "failed-run",
      missionId: "mission-1",
      sessionId: "session-1",
      status: "failed",
      contractSnapshotJson: null,
    });

    await expect(recoverFailedMissionRun("session-1")).rejects.toThrow(/no recoverable contract snapshot/);
    expect(mockCreateRun).not.toHaveBeenCalled();
  });
});
